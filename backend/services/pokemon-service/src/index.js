// pokemon-service/src/index.js
// REQ-00211: 微服务样板代码统一初始化器 - 重构版本
'use strict';

const { ServiceFactory } = require('../../../shared/ServiceFactory');
const { query, transaction } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createContentLocalizer, DEFAULT_LANGUAGE } = require('../../../shared/contentLocalizer');

// Content Localizer instance
let contentLocalizer = null;

// Helper: Get language from request
function getLanguage(req) {
  const lang = req.headers['x-language'] || req.headers['accept-language'] || DEFAULT_LANGUAGE;
  if (lang.startsWith('zh') || lang.includes('CN')) return 'zh-CN';
  if (lang.startsWith('en') || lang.includes('US')) return 'en-US';
  if (lang.startsWith('ja') || lang.includes('JP')) return 'ja-JP';
  return DEFAULT_LANGUAGE;
}

// Helper: Get localized name and description
function getLocalizedFields(row, language) {
  const langSuffix = {
    'zh-CN': { name: 'name_zh', desc: 'description_zh' },
    'en-US': { name: 'name_en', desc: 'description_en' },
    'ja-JP': { name: 'name_ja', desc: 'description_ja' }
  };
  
  const suffix = langSuffix[language] || langSuffix['zh-CN'];
  const name = row[suffix.name] || row.name_zh || row.name_en || null;
  const description = row[suffix.desc] || row.description_zh || row.description_en || null;
  
  return { name, description, _locale: language };
}

// Initialize localizer with database pool
async function initLocalizer() {
  if (!contentLocalizer) {
    const { getPool } = require('../../../shared/db');
    const pool = getPool();
    if (pool) {
      contentLocalizer = createContentLocalizer(pool, null);
    }
  }
}

function generateStopDrop(bonus) {
  const items = [];
  const ballCount = 2 + Math.floor(Math.random() * 4) + (bonus ? 2 : 0);
  items.push({ type: 'POKE_BALL', qty: ballCount });

  if (Math.random() < 0.3) items.push({ type: 'RAZZ_BERRY', qty: 1 });
  if (Math.random() < 0.1) items.push({ type: 'GREAT_BALL', qty: 1 });
  if (bonus && Math.random() < 0.5) items.push({ type: 'GOLDEN_RAZZ_BERRY', qty: 1 });
  if (bonus && Math.random() < 0.2) items.push({ type: 'ULTRA_BALL', qty: 1 });
  return items;
}

/**
 * 主入口 - 使用 ServiceFactory 创建服务
 */
async function main() {
  const { app, logger } = await ServiceFactory.createService({
    name: 'pokemon-service',
    port: process.env.PORT || 8083,
    options: {
      checkDb: true,
      checkRedis: true,
      trustProxy: true
    },
    postInit: async (app, logger) => {
      // 初始化本地化器
      await initLocalizer();

      // ═══════════════════════════════════════════════════════════
      // 核心路由 - 精灵列表与详情
      // ═══════════════════════════════════════════════════════════

      // GET /pokemon/species — master data list (with localization)
      app.get('/pokemon/species', async (req, res, next) => {
        try {
          const { type1, rarity, limit = 50, offset = 0 } = req.query;
          const language = getLanguage(req);
          
          const conditions = ['1=1'];
          const params = [];
          if (type1)  { params.push(type1);   conditions.push(`type1=$${params.length}`); }
          if (rarity) { params.push(rarity);  conditions.push(`rarity=$${params.length}`); }
          params.push(parseInt(limit)); params.push(parseInt(offset));

          const { rows } = await query(`
            SELECT id, name_zh, name_en, name_ja, 
                   description_zh, description_en, description_ja,
                   type1, type2, rarity,
                   base_attack, base_defense, base_hp,
                   candy_to_evolve, evolves_to, sprite_url, sprite_shiny_url
            FROM pokemon_species
            WHERE ${conditions.join(' AND ')}
            ORDER BY id
            LIMIT $${params.length-1} OFFSET $${params.length}
          `, params);
          
          const localizedRows = rows.map(row => {
            const localized = getLocalizedFields(row, language);
            return {
              id: row.id,
              name: localized.name,
              description: localized.description,
              type1: row.type1,
              type2: row.type2,
              rarity: row.rarity,
              base_attack: row.base_attack,
              base_defense: row.base_defense,
              base_hp: row.base_hp,
              candy_to_evolve: row.candy_to_evolve,
              evolves_to: row.evolves_to,
              sprite_url: row.sprite_url,
              sprite_shiny_url: row.sprite_shiny_url,
              _locale: localized._locale
            };
          });
          
          res.json(successResp(localizedRows));
        } catch (err) { next(err); }
      });

      // GET /pokemon/species/:id (with localization)
      app.get('/pokemon/species/:id', async (req, res, next) => {
        try {
          const language = getLanguage(req);
          const { rows: [species] } = await query(
            `SELECT id, name_zh, name_en, name_ja, 
                    description_zh, description_en, description_ja,
                    type1, type2, rarity,
                    base_attack, base_defense, base_hp,
                    base_catch_rate, base_flee_rate,
                    candy_to_evolve, evolves_to, evolves_with_item,
                    biomes, sprite_url, sprite_shiny_url
             FROM pokemon_species WHERE id=$1`, 
            [req.params.id]
          );
          if (!species) throw new AppError(3001, '精灵不存在', 404);
          
          const localized = getLocalizedFields(species, language);
          const response = {
            id: species.id,
            name: localized.name,
            description: localized.description,
            type1: species.type1,
            type2: species.type2,
            rarity: species.rarity,
            base_attack: species.base_attack,
            base_defense: species.base_defense,
            base_hp: species.base_hp,
            base_catch_rate: species.base_catch_rate,
            base_flee_rate: species.base_flee_rate,
            candy_to_evolve: species.candy_to_evolve,
            evolves_to: species.evolves_to,
            evolves_with_item: species.evolves_with_item,
            biomes: species.biomes,
            sprite_url: species.sprite_url,
            sprite_shiny_url: species.sprite_shiny_url,
            _locale: localized._locale
          };
          
          res.json(successResp(response));
        } catch (err) { next(err); }
      });

      // ═══════════════════════════════════════════════════════════
      // 玩家精灵管理
      // ═══════════════════════════════════════════════════════════

      // GET /pokemon/my — player's pokemon list
      app.get('/pokemon/my', requireAuth, async (req, res, next) => {
        try {
          const { sort = 'cp', order = 'desc', species_id, is_shiny, limit = 30, offset = 0 } = req.query;
          const userId = req.user.sub;

          const validSorts = { cp:'pi.cp', iv:'(pi.iv_attack+pi.iv_defense+pi.iv_hp)', caught:'pi.caught_at' };
          const sortCol    = validSorts[sort] || 'pi.cp';
          const sortDir    = order === 'asc' ? 'ASC' : 'DESC';

          const conditions = ['pi.user_id=$1'];
          const params = [userId];
          if (species_id) { params.push(species_id); conditions.push(`pi.species_id=$${params.length}`); }
          if (is_shiny === 'true') conditions.push('pi.is_shiny=true');

          params.push(parseInt(limit)); params.push(parseInt(offset));

          const { rows } = await query(`
            SELECT pi.id, pi.species_id, pi.nickname, pi.cp,
                   pi.hp_current, pi.hp_max,
                   pi.iv_attack, pi.iv_defense, pi.iv_hp,
                   ROUND((pi.iv_attack+pi.iv_defense+pi.iv_hp)*100.0/45, 1) AS iv_pct,
                   pi.is_shiny, pi.is_lucky, pi.is_favorite, pi.power_up_count,
                   pi.fast_move, pi.charge_move, pi.caught_at,
                   ps.name_zh, ps.name_en, ps.type1, ps.type2, ps.sprite_url,
                   ps.sprite_shiny_url, ps.rarity,
                   pi.defending_gym_id
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON ps.id = pi.species_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY ${sortCol} ${sortDir}
            LIMIT $${params.length-1} OFFSET $${params.length}
          `, params);

          const { rows: [total] } = await query(
            `SELECT COUNT(*)::int FROM pokemon_instances WHERE user_id=$1 ${species_id ? 'AND species_id=$2':''}`,
            species_id ? [userId, species_id] : [userId]
          );

          res.json(successResp({ pokemon: rows, total: total.count, limit: parseInt(limit), offset: parseInt(offset) }));
        } catch (err) { next(err); }
      });

      // GET /pokemon/my/:id
      app.get('/pokemon/my/:id', requireAuth, async (req, res, next) => {
        try {
          const { rows: [pi] } = await query(`
            SELECT pi.*, ps.name_zh, ps.name_en, ps.type1, ps.type2,
                   ps.sprite_url, ps.sprite_shiny_url, ps.description_zh,
                   ps.base_attack, ps.base_defense, ps.base_hp,
                   ps.candy_to_evolve, ps.evolves_to,
                   COALESCE(ci.amount,0) AS candy_count
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON ps.id = pi.species_id
            LEFT JOIN candy_inventory ci ON ci.user_id=pi.user_id AND ci.species_id=pi.species_id
            WHERE pi.id=$1 AND pi.user_id=$2
          `, [req.params.id, req.user.sub]);

          if (!pi) throw new AppError(3001, '精灵不存在', 404);
          res.json(successResp(pi));
        } catch (err) { next(err); }
      });

      // ═══════════════════════════════════════════════════════════
      // 进化与强化
      // ═══════════════════════════════════════════════════════════

      // POST /pokemon/my/:id/evolve
      app.post('/pokemon/my/:id/evolve', requireAuth, async (req, res, next) => {
        try {
          const userId = req.user.sub;
          const { rows: [pi] } = await query(`
            SELECT pi.*, ps.candy_to_evolve, ps.evolves_to, ps.name_zh AS species_name,
                   COALESCE(ci.amount,0) AS candy_count
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON ps.id = pi.species_id
            LEFT JOIN candy_inventory ci ON ci.user_id=pi.user_id AND ci.species_id=pi.species_id
            WHERE pi.id=$1 AND pi.user_id=$2
          `, [req.params.id, userId]);

          if (!pi) throw new AppError(3001, '精灵不存在', 404);
          if (!pi.evolves_to) throw new AppError(3006, '该精灵无法进化', 400);
          if (!pi.candy_to_evolve) throw new AppError(3006, '该精灵无法进化', 400);
          if (pi.candy_count < pi.candy_to_evolve) {
            throw new AppError(3007, `糖果不足（需要 ${pi.candy_to_evolve} 个，当前 ${pi.candy_count} 个）`, 400);
          }

          const { rows: [newSpecies] } = await query(
            'SELECT * FROM pokemon_species WHERE id=$1', [pi.evolves_to]
          );

          const newCp = Math.max(10, Math.floor(
            ((newSpecies.base_attack + pi.iv_attack) *
             Math.sqrt(newSpecies.base_defense + pi.iv_defense) *
             Math.sqrt(newSpecies.base_hp + pi.iv_hp)) / 10
          ));

          const newInstance = await transaction(async (client) => {
            await client.query(`
              UPDATE pokemon_instances SET species_id=$1, cp=$2, hp_max=$3, hp_current=$3
              WHERE id=$4
            `, [pi.evolves_to, newCp, Math.floor(newCp * 0.8), pi.id]);

            await client.query(`
              UPDATE candy_inventory SET amount=amount-$1 WHERE user_id=$2 AND species_id=$3
            `, [pi.candy_to_evolve, userId, pi.species_id]);

            await client.query('UPDATE users SET xp=xp+500 WHERE id=$1', [userId]);

            return { id: pi.id, newSpeciesId: pi.evolves_to, newSpeciesName: newSpecies.name_zh, newCp };
          });

          res.json(successResp({ ...newInstance, xpEarned: 500 }, '进化成功！'));
        } catch (err) { next(err); }
      });

      // POST /pokemon/my/:id/power-up
      app.post('/pokemon/my/:id/power-up', requireAuth, async (req, res, next) => {
        try {
          const userId = req.user.sub;
          const { rows: [pi] } = await query(`
            SELECT pi.*, ps.base_attack, ps.base_defense, ps.base_hp,
                   COALESCE(ci.amount,0) AS candy_count,
                   u.stardust
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON ps.id=pi.species_id
            LEFT JOIN candy_inventory ci ON ci.user_id=pi.user_id AND ci.species_id=pi.species_id
            JOIN users u ON u.id=pi.user_id
            WHERE pi.id=$1 AND pi.user_id=$2
          `, [req.params.id, userId]);

          if (!pi) throw new AppError(3001, '精灵不存在', 404);
          if (pi.power_up_count >= 40) throw new AppError(3008, '已达到最大强化次数', 400);

          const stardustCost = 200 + pi.power_up_count * 50;
          const candyCost    = 1;

          if (pi.stardust < stardustCost) throw new AppError(3009, `星尘不足（需要 ${stardustCost}）`, 400);
          if (pi.candy_count < candyCost) throw new AppError(3007, '糖果不足', 400);

          const newCp = Math.floor(pi.cp * (1 + 0.02 + Math.random() * 0.01));

          await transaction(async (client) => {
            await client.query(`
              UPDATE pokemon_instances SET cp=$1, power_up_count=power_up_count+1 WHERE id=$2
            `, [newCp, pi.id]);
            await client.query('UPDATE users SET stardust=stardust-$1 WHERE id=$2', [stardustCost, userId]);
            await client.query(`
              UPDATE candy_inventory SET amount=amount-$1 WHERE user_id=$2 AND species_id=$3
            `, [candyCost, userId, pi.species_id]);
          });

          res.json(successResp({ newCp, stardustCost, powerUpCount: pi.power_up_count + 1 }, '强化成功！'));
        } catch (err) { next(err); }
      });

      // ═══════════════════════════════════════════════════════════
      // 图鉴与补给站
      // ═══════════════════════════════════════════════════════════

      // GET /pokemon/pokedex
      app.get('/pokemon/pokedex', requireAuth, async (req, res, next) => {
        try {
          const { rows } = await query(`
            SELECT ps.id, ps.name_zh, ps.name_en, ps.type1, ps.type2,
                   ps.rarity, ps.sprite_url,
                   COALESCE(pe.seen_count, 0) AS seen_count,
                   COALESCE(pe.caught_count, 0) AS caught_count,
                   pe.first_caught_at, pe.best_cp, pe.has_shiny,
                   COALESCE(ci.amount, 0) AS candy_count
            FROM pokemon_species ps
            LEFT JOIN pokedex_entries pe ON pe.species_id=ps.id AND pe.user_id=$1
            LEFT JOIN candy_inventory ci ON ci.species_id=ps.id AND ci.user_id=$1
            ORDER BY ps.id
          `, [req.user.sub]);

          const total   = rows.length;
          const caught  = rows.filter(r => r.caught_count > 0).length;
          const pct     = Math.round(caught * 100 / total);

          res.json(successResp({ entries: rows, total, caught, completionPct: pct }));
        } catch (err) { next(err); }
      });

      // POST /pokestops/:id/spin
      app.post('/pokestops/:id/spin', requireAuth, async (req, res, next) => {
        try {
          const userId     = req.user.sub;
          const pokestopId = req.params.id;

          const { rows: [lastSpin] } = await query(`
            SELECT spun_at, streak_day FROM pokestop_spins
            WHERE user_id=$1 AND pokestop_id=$2
            ORDER BY spun_at DESC LIMIT 1
          `, [userId, pokestopId]);

          if (lastSpin) {
            const cooldownSec = (Date.now() - new Date(lastSpin.spun_at).getTime()) / 1000;
            if (cooldownSec < 300) {
              throw new AppError(4010, `补给站冷却中，还需 ${Math.ceil(300 - cooldownSec)} 秒`, 400);
            }
          }

          const sameDay = lastSpin && (Date.now() - new Date(lastSpin.spun_at).getTime()) < 86400000;
          const streak  = sameDay ? (lastSpin.streak_day || 1) : 1;
          const bonusDrop = streak >= 7;

          const items = generateStopDrop(bonusDrop);

          await transaction(async (client) => {
            const balls = items.filter(i => i.type === 'POKE_BALL').reduce((s,i)=>s+i.qty,0);
            const gBalls = items.filter(i => i.type === 'GREAT_BALL').reduce((s,i)=>s+i.qty,0);
            if (balls)  await client.query('UPDATE users SET pokeball_count=pokeball_count+$1 WHERE id=$2', [balls, userId]);
            if (gBalls) await client.query('UPDATE users SET greatball_count=greatball_count+$1 WHERE id=$2', [gBalls, userId]);

            await client.query(`
              INSERT INTO pokestop_spins (user_id, pokestop_id, items_received, streak_day)
              VALUES ($1,$2,$3,$4)
            `, [userId, pokestopId, JSON.stringify(items), streak]);

            await client.query(`
              INSERT INTO user_achievements (user_id, achievement_id, current_value, updated_at)
              VALUES ($1,'pokestop_spins',1,NOW())
              ON CONFLICT (user_id,achievement_id) DO UPDATE
                SET current_value=user_achievements.current_value+1, updated_at=NOW()
            `, [userId]);
          });

          res.json(successResp({ items, streak, bonusDrop }));
        } catch (err) { next(err); }
      });

      // ═══════════════════════════════════════════════════════════
      // 子路由挂载
      // ═══════════════════════════════════════════════════════════

      // REQ-00019: 技能学习系统路由
      app.use('/', require('./routes/moves'));

      // REQ-00046: 精灵培育系统路由
      app.use('/breeding', require('./routes/breeding'));

      // REQ-00067: 精灵羁绊系统路由
      app.use('/pokemon', require('./routes/friendship'));

      // REQ-00145: 批量查询精灵详情
      app.use('/pokemon/batch', require('./routes/batch'));

      // REQ-00119: 精灵进化与成长系统路由
      app.use('/pokemon', require('./routes/evolution'));
  app.use('/pokemon', require('./routes/evolutionVisualization'));

      // REQ-00123: 精灵收藏展示系统路由
      app.use('/pokemon', require('./routes/showcase'));

      // REQ-00076: 精灵成就系统与里程碑奖励路由
      app.use('/achievements', require('./routes/achievements'));

      // REQ-00138: 精灵道具与背包管理系统路由
      app.use('/inventory', require('./routes/inventory'));

      // REQ-00348: 精灵背包智能整理与自动分类系统
      app.use('/pokemon/inventory', require('./routes/inventory'));

      // REQ-00133: 精灵图鉴系统路由
      app.use('/pokedex', require('./routes/pokedex'));

      // REQ-00086: 精灵特性系统路由
      app.use('/abilities', require('./routes/abilities'));

      // REQ-00092: 批量查询接口
      app.use('/batch', require('./routes/batch'));

      // REQ-00151: 精灵羁绊技能解锁机制路由
      app.use('/', require('./routes/bondSkills'));

      // REQ-00210: 精灵亲密度进化计算与提示系统路由
      app.use('/pokemon', require('./routes/friendshipEvolution'));

      // REQ-00129: 精灵数据备份与恢复系统路由
      app.use('/backup', require('./routes/backup'));

      // REQ-00091: 精灵装备系统路由
      app.use('/equipment', require('./routes/equipment'));

      // REQ-00110: 精灵背包容量管理系统路由
      app.use('/bag', require('./routes/bag'));

      // REQ-00240: 精灵放生与资源回收系统
      app.use('/pokemon/release', require('./routes/release'));
      app.use('/training', require('./routes/trainingCamp'));

      // ═══════════════════════════════════════════════════════════
      // REQ-00076: 成就系统
      // ═══════════════════════════════════════════════════════════

      app.use('/achievements', require('./routes/achievements'));

      // ═══════════════════════════════════════════════════════════
      // REQ-00167: 本地化 API 端点
      // ═══════════════════════════════════════════════════════════

      // GET /localizations/pokemon/:id - Get all localizations for a Pokemon
      app.get('/localizations/pokemon/:id', async (req, res, next) => {
        try {
          const speciesId = req.params.id;
          
          const { rows } = await query(`
            SELECT id, name_zh, name_en, name_ja, 
                   description_zh, description_en, description_ja
            FROM pokemon_species WHERE id = $1
          `, [speciesId]);
          
          if (rows.length === 0) {
            throw new AppError(3001, '精灵不存在', 404);
          }
          
          const species = rows[0];
          res.json(successResp({
            id: species.id,
            names: {
              'zh-CN': species.name_zh,
              'en-US': species.name_en,
              'ja-JP': species.name_ja
            },
            descriptions: {
              'zh-CN': species.description_zh,
              'en-US': species.description_en,
              'ja-JP': species.description_ja
            }
          }));
        } catch (err) { next(err); }
      });

      // GET /localizations/items - Get all localized items
      app.get('/localizations/items', async (req, res, next) => {
        try {
          const language = getLanguage(req);
          const langSuffix = {
            'zh-CN': 'zh',
            'en-US': 'en', 
            'ja-JP': 'ja'
          }[language] || 'zh';
          
          const { rows } = await query(`
            SELECT id, category,
                   name_${langSuffix} as name,
                   description_${langSuffix} as description,
                   shop_price, is_premium, sprite_url
            FROM items
            ORDER BY category, shop_price
          `);
          
          res.json(successResp(rows.map(r => ({ ...r, _locale: language }))));
        } catch (err) { next(err); }
      });

      // GET /localizations/moves - Get all localized moves
      app.get('/localizations/moves', async (req, res, next) => {
        try {
          const language = getLanguage(req);
          const langSuffix = {
            'zh-CN': 'zh',
            'en-US': 'en',
            'ja-JP': 'ja'
          }[language] || 'zh';
          
          const { rows } = await query(`
            SELECT id, move_type, category,
                   name_${langSuffix} as name,
                   description_${langSuffix} as description,
                   power, energy_cost, energy_gain, cooldown_ms
            FROM pokemon_moves
            ORDER BY category, move_type
          `);
          
          res.json(successResp(rows.map(r => ({ ...r, _locale: language }))));
        } catch (err) { next(err); }
      });

      // GET /localizations/supported-languages - Get supported languages
      app.get('/localizations/supported-languages', (req, res) => {
        res.json(successResp([
          { code: 'zh-CN', name: '简体中文', flag: '🇨🇳' },
          { code: 'en-US', name: 'English', flag: '🇺🇸' },
          { code: 'ja-JP', name: '日本語', flag: '🇯🇵' }
        ]));
      });

      // ═══════════════════════════════════════════════════════════
      // 体力系统路由 - REQ-00172
      // ═══════════════════════════════════════════════════════════
      const staminaRoutes = require('./routes/stamina');
      app.use('/pokemon', staminaRoutes);

      logger.info('All routes registered successfully');
    },
    onShutdown: async () => {
      // 清理资源
    }
  });

  return { app };
}

// 启动服务
main().catch(err => {
  console.error('Failed to start pokemon-service:', err);
  process.exit(1);
});

module.exports = { main, getLanguage, getLocalizedFields, generateStopDrop };
