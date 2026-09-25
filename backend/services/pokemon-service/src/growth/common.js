/**
 * 精灵成长模块公共工具：错误、参数校验、精灵行锁与"忙碌锁"
 *
 * 忙碌锁（pokemon_instances.occupied_by / occupied_until）：训练营、特训、培育期间精灵被占用，
 * 进化 / 合并 / 放生 / 觉醒 / 其他训练都会拒绝被占用的精灵，占用方完成或取消时释放。
 */
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OCCUPY_LABELS = {
  training_camp: '训练营训练',
  special_training: '特训',
  breeding: '培育',
};

/** 业务错误：errorHandler 对 4xx 保留 httpStatus / message，error.name 为 code 字符串 */
class GrowthError extends Error {
  constructor(code, message, httpStatus = 400, details) {
    super(message);
    this.name = 'GrowthError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function assertUuid(id, field = 'pokemonId') {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new GrowthError('INVALID_ID', `无效的 ${field}`, 400);
  }
  return id;
}

function toPositiveInt(v, field, { min = 1, max = 1_000_000 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new GrowthError('INVALID_PARAM', `${field} 必须是 ${min}~${max} 的整数`, 400);
  }
  return n;
}

/** Express 异步路由包装 */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function ok(res, data, message = 'ok', status = 200) {
  return res.status(status).json({ success: true, code: 0, message, data });
}

/**
 * 锁定并读取玩家自己的精灵（含物种数据），不存在抛 404
 * @param {import('pg').PoolClient} client 事务 client
 */
async function lockOwnedPokemon(client, pokemonId, userId, { lock = true } = {}) {
  assertUuid(pokemonId);
  if (lock) {
    // 先单独锁实例行：带 JOIN 的 FOR UPDATE 在行被并发更新（如物种已变）后重检 JOIN 条件会把行过滤掉，误报 404
    await client.query('SELECT 1 FROM pokemon_instances WHERE id = $1 AND user_id = $2 FOR UPDATE', [pokemonId, userId]);
  }
  const { rows: [p] } = await client.query(
    `SELECT pi.*, ps.name_zh AS species_name, ps.name_en AS species_name_en, ps.type1, ps.type2, ps.rarity,
            ps.base_attack, ps.base_defense, ps.base_hp, ps.candy_to_evolve, ps.evolves_to,
            ps.evolves_with_item, ps.evolution_level, COALESCE(ps.growth_rate, 'medium_fast') AS growth_rate
       FROM pokemon_instances pi
       JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1 AND pi.user_id = $2 AND COALESCE(pi.is_released, FALSE) = FALSE`,
    [pokemonId, userId],
  );
  if (!p) throw new GrowthError('POKEMON_NOT_FOUND', '精灵不存在', 404);
  return p;
}

/** 当前占用方（训练结束但未领取时仍占用，由领取/取消释放） */
function occupiedBy(pokemon) {
  return pokemon.occupied_by || null;
}

function assertIdle(pokemon, action = '操作') {
  const by = occupiedBy(pokemon);
  if (by) {
    throw new GrowthError('POKEMON_BUSY', `精灵正在${OCCUPY_LABELS[by] || by}中，无法${action}`, 409, { occupiedBy: by });
  }
  if (pokemon.defending_gym_id) {
    throw new GrowthError('POKEMON_BUSY', `精灵正在驻守道馆，无法${action}`, 409, { occupiedBy: 'gym' });
  }
}

async function occupy(client, pokemonId, by, until = null) {
  const { rowCount } = await client.query(
    `UPDATE pokemon_instances SET occupied_by = $2, occupied_until = $3, updated_at = NOW()
      WHERE id = $1 AND occupied_by IS NULL`,
    [pokemonId, by, until],
  );
  if (!rowCount) throw new GrowthError('POKEMON_BUSY', '精灵正在其他活动中', 409);
}

async function release(client, pokemonId, by) {
  await client.query(
    `UPDATE pokemon_instances SET occupied_by = NULL, occupied_until = NULL, updated_at = NOW()
      WHERE id = $1 AND occupied_by = $2`,
    [pokemonId, by],
  );
}

async function trainerLevel(client, userId) {
  const { rows: [u] } = await client.query('SELECT level FROM users WHERE id = $1', [userId]);
  return u ? Number(u.level) : 1;
}

/** 扣减用户货币列（原子，不足返回 false） */
const CURRENCY_COLUMNS = { stardust: 'stardust', coins: 'coins', premium_coins: 'premium_coins' };
async function spendCurrency(client, userId, currency, amount) {
  const col = CURRENCY_COLUMNS[currency];
  if (!col) throw new GrowthError('INVALID_CURRENCY', `不支持的货币类型 ${currency}`, 400);
  if (!(amount > 0)) return true;
  const { rowCount } = await client.query(
    `UPDATE users SET ${col} = ${col} - $2, updated_at = NOW() WHERE id = $1 AND ${col} >= $2`,
    [userId, amount],
  );
  return rowCount === 1;
}

/** 原子扣减某物种（所在进化家族）的糖果，不足返回 false；糖果按家族根物种记账 */
async function spendCandy(client, userId, speciesId, amount) {
  if (!(amount > 0)) return true;
  const { rowCount } = await client.query(
    `UPDATE candy_inventory SET amount = amount - $3, updated_at = NOW()
      WHERE user_id = $1 AND species_id = pokemon_family_root($2) AND amount >= $3`,
    [userId, speciesId, amount],
  );
  return rowCount === 1;
}

/** 发放糖果（插入触发器会换算到家族根物种） */
async function addCandy(client, userId, speciesId, amount) {
  if (!(amount > 0)) return;
  await client.query(
    `INSERT INTO candy_inventory (user_id, species_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + EXCLUDED.amount, updated_at = NOW()`,
    [userId, speciesId, amount],
  );
}

/** 某物种（所在家族）的糖果数量 */
async function candyOf(db, userId, speciesId, { lock = false } = {}) {
  const { rows: [c] } = await db.query(
    `SELECT amount FROM candy_inventory WHERE user_id = $1 AND species_id = pokemon_family_root($2) ${lock ? 'FOR UPDATE' : ''}`,
    [userId, speciesId]);
  return c ? Number(c.amount) : 0;
}

module.exports = {
  UUID_RE,
  candyOf,
  GrowthError,
  assertUuid,
  toPositiveInt,
  route,
  ok,
  lockOwnedPokemon,
  occupiedBy,
  assertIdle,
  occupy,
  release,
  trainerLevel,
  spendCurrency,
  spendCandy,
  addCandy,
  OCCUPY_LABELS,
};
