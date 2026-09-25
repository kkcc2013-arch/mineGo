/**
 * REQ-00377：精灵数据可见性控制
 *
 * - 精灵级配置 pokemon_privacy_settings；用户默认配置 user_privacy_defaults（新精灵入库时由触发器复制）
 * - 查看他人精灵：按精灵隐私等级 + 好友等级阈值 + 用户级隐私（收藏/数值/闪光）计算，未授权字段返回 null
 * - 批量设置：校验所有权后一次性 upsert
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const engine = require('../../../../shared/social/visibilityEngine');
const rules = require('../../../../shared/social/privacyRules');
const relationship = require('../../../../shared/social/relationship');
const store = require('../../../../shared/social/pokemonPrivacyStore');

const bad = (msg) => new AppError(1001, msg, 400);
const notFound = () => new AppError(3001, '精灵不存在', 404);
const MAX_BATCH = 500;

const POKEMON_COLUMNS = `pi.id, pi.user_id, pi.species_id, pi.nickname, pi.cp, pi.hp_max, pi.iv_attack, pi.iv_defense, pi.iv_hp,
  pi.is_shiny, pi.power_up_count, pi.fast_move, pi.charge_move, pi.learned_fast_moves, pi.learned_charge_moves,
  pi.caught_at, pi.caught_lat, pi.caught_lng, ps.name_zh, ps.name_en, ps.type1::text AS type1, ps.type2::text AS type2,
  ps.sprite_url, ps.sprite_shiny_url`;

function toRow(privacy) {
  const out = {};
  for (const k of Object.keys(engine.DEFAULT_POKEMON_PRIVACY)) out[k] = privacy[k];
  return out;
}

class PokemonPrivacyService {
  constructor({ db = dbDefault } = {}) {
    this.db = db;
  }

  async loadPokemon(q, ids) {
    const { rows } = await q.query(`
      SELECT ${POKEMON_COLUMNS}
        FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
       WHERE pi.id = ANY($1::uuid[]) AND NOT COALESCE(pi.is_released, false) AND NOT COALESCE(pi.is_deleted, false)`, [ids]);
    return rows;
  }

  async getDefaults(userId) {
    const { rows: [d] } = await this.db.query('SELECT * FROM user_privacy_defaults WHERE user_id = $1', [userId]);
    return { ...toRow(engine.defaultsToPrivacy(d)), source: d ? 'user_default' : 'system_default', updated_at: d ? d.updated_at : null };
  }

  /** 更新默认配置；applyToExisting=true 时同时覆盖已有全部精灵 */
  async updateDefaults(userId, body = {}) {
    const { applyToExisting = false, ...patch } = body;
    const { value, errors } = engine.sanitizePokemonPrivacy(patch);
    if (errors.length) throw bad(errors.join('；'));
    const merged = { ...toRow(engine.defaultsToPrivacy((await this.db.query(
      'SELECT * FROM user_privacy_defaults WHERE user_id = $1', [userId])).rows[0])), ...value };
    await this.db.query(`
      INSERT INTO user_privacy_defaults (user_id, default_pokemon_visibility, default_show_cp, default_show_level,
        default_show_skills, default_show_iv, default_show_nature, default_show_moves, default_friend_level_threshold,
        default_battle_anonymous, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        default_pokemon_visibility = EXCLUDED.default_pokemon_visibility, default_show_cp = EXCLUDED.default_show_cp,
        default_show_level = EXCLUDED.default_show_level, default_show_skills = EXCLUDED.default_show_skills,
        default_show_iv = EXCLUDED.default_show_iv, default_show_nature = EXCLUDED.default_show_nature,
        default_show_moves = EXCLUDED.default_show_moves, default_friend_level_threshold = EXCLUDED.default_friend_level_threshold,
        default_battle_anonymous = EXCLUDED.default_battle_anonymous, updated_at = NOW()`,
    [userId, merged.overall_visibility, merged.show_cp, merged.show_level, merged.show_skills, merged.show_iv,
      merged.show_nature, merged.show_moves, merged.friend_level_threshold, merged.battle_anonymous]);
    let applied = 0;
    if (applyToExisting === true) {
      const { rows } = await this.db.query(`
        SELECT id FROM pokemon_instances WHERE user_id = $1 AND NOT COALESCE(is_released, false) AND NOT COALESCE(is_deleted, false)`,
      [userId]);
      applied = await this.upsertMany(this.db, userId, rows.map((r) => r.id), () => merged);
    }
    return { ...(await this.getDefaults(userId)), appliedToExisting: applied };
  }

  async upsertMany(q, userId, ids, fn) {
    if (!ids.length) return 0;
    const current = await store.loadPrivacy(q, ids.map((id) => ({ id, user_id: userId })));
    const rows = ids.map((id) => ({ id, ...fn(toRow(current.get(id))) }));
    const col = (k) => rows.map((r) => r[k]);
    await q.query(`
      INSERT INTO pokemon_privacy_settings (pokemon_id, user_id, overall_visibility, show_cp, show_level, show_skills,
        show_iv, show_nature, show_moves, friend_level_threshold, battle_anonymous, updated_at)
      SELECT x.id, $1, x.v, x.cp, x.lv, x.sk, x.iv, x.na, x.mv, x.th, x.an, NOW()
        FROM unnest($2::uuid[], $3::text[], $4::bool[], $5::bool[], $6::bool[], $7::bool[], $8::bool[], $9::bool[], $10::int[], $11::bool[])
             AS x(id, v, cp, lv, sk, iv, na, mv, th, an)
      ON CONFLICT (pokemon_id) DO UPDATE SET
        overall_visibility = EXCLUDED.overall_visibility, show_cp = EXCLUDED.show_cp, show_level = EXCLUDED.show_level,
        show_skills = EXCLUDED.show_skills, show_iv = EXCLUDED.show_iv, show_nature = EXCLUDED.show_nature,
        show_moves = EXCLUDED.show_moves, friend_level_threshold = EXCLUDED.friend_level_threshold,
        battle_anonymous = EXCLUDED.battle_anonymous, updated_at = NOW()`,
    [userId, col('id'), col('overall_visibility'), col('show_cp'), col('show_level'), col('show_skills'), col('show_iv'),
      col('show_nature'), col('show_moves'), col('friend_level_threshold'), col('battle_anonymous')]);
    return rows.length;
  }

  async assertOwned(q, userId, ids) {
    const { rows } = await q.query(`
      SELECT id FROM pokemon_instances
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND NOT COALESCE(is_released, false) AND NOT COALESCE(is_deleted, false)`,
    [ids, userId]);
    return rows.length === ids.length;
  }

  async getPokemonPrivacy(userId, pokemonId) {
    if (!relationship.isUuid(pokemonId)) throw notFound();
    if (!(await this.assertOwned(this.db, userId, [pokemonId]))) throw notFound();
    const map = await store.loadPrivacy(this.db, [{ id: pokemonId, user_id: userId }]);
    const p = map.get(pokemonId);
    return { pokemonId, ...toRow(p), source: p.source };
  }

  async updatePokemonPrivacy(userId, pokemonId, patch) {
    if (!relationship.isUuid(pokemonId)) throw notFound();
    const { value, errors } = engine.sanitizePokemonPrivacy(patch);
    if (errors.length) throw bad(errors.join('；'));
    if (!(await this.assertOwned(this.db, userId, [pokemonId]))) throw notFound();
    await this.upsertMany(this.db, userId, [pokemonId], (cur) => ({ ...cur, ...value }));
    return this.getPokemonPrivacy(userId, pokemonId);
  }

  async batchUpdate(userId, pokemonIds, settings) {
    if (!Array.isArray(pokemonIds) || !pokemonIds.length) throw bad('pokemon_ids 必须是非空数组');
    if (pokemonIds.length > MAX_BATCH) throw bad(`一次最多设置 ${MAX_BATCH} 只精灵`);
    const ids = [...new Set(pokemonIds)];
    if (!ids.every(relationship.isUuid)) throw bad('pokemon_ids 中包含无效 ID');
    const { value, errors } = engine.sanitizePokemonPrivacy(settings);
    if (errors.length) throw bad(errors.join('；'));
    return this.db.transaction(async (c) => {
      if (!(await this.assertOwned(c, userId, ids))) throw bad('部分精灵不属于当前用户');
      const n = await this.upsertMany(c, userId, ids, (cur) => ({ ...cur, ...value }));
      return { success: true, updated_count: n, settings: value };
    });
  }

  /** 查看任意精灵（按可见性过滤）；不可见与不存在都返回 404，避免泄露存在性 */
  async getVisibility(viewerId, pokemonId) {
    if (!relationship.isUuid(pokemonId)) throw notFound();
    const [p] = await this.loadPokemon(this.db, [pokemonId]);
    if (!p) throw notFound();
    const [view] = await store.visibleViews(this.db, viewerId, [p]);
    if (!view) throw notFound();
    return view;
  }

  /** 查看某玩家的精灵收藏（需要对方 pokemon_collection 可见），逐只按精灵隐私过滤 */
  async getUserCollection(viewerId, ownerId, { limit = 50, offset = 0 } = {}) {
    if (!relationship.isUuid(ownerId)) throw new AppError(2001, '用户不存在', 404);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    if (viewerId !== ownerId) {
      const [settings, rel] = await Promise.all([
        relationship.getPrivacySettings(this.db, ownerId),
        relationship.getRelationship(this.db, viewerId, ownerId),
      ]);
      if (!rules.canView(settings, 'pokemon_collection', rel)) throw new AppError(2017, '对方的精灵收藏不对你公开', 403);
    }
    const { rows } = await this.db.query(`
      SELECT ${POKEMON_COLUMNS}
        FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
       WHERE pi.user_id = $1 AND NOT COALESCE(pi.is_released, false) AND NOT COALESCE(pi.is_deleted, false)
       ORDER BY pi.cp DESC, pi.id LIMIT $2 OFFSET $3`, [ownerId, lim, off]);
    const views = await store.visibleViews(this.db, viewerId, rows);
    const visible = views.filter(Boolean);
    return { ownerId, pokemon: visible, hiddenCount: views.length - visible.length, limit: lim, offset: off };
  }
}

const instance = new PokemonPrivacyService();
module.exports = instance;
module.exports.PokemonPrivacyService = PokemonPrivacyService;
module.exports.POKEMON_COLUMNS = POKEMON_COLUMNS;
