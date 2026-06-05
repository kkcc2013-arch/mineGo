/**
 * REQ-00019: 精灵技能学习与技能机器系统
 * Raid 奖励模块 - 包含 TM 掉落
 */

const { query, transaction } = require('../../../shared/db');
const logger = require('../../../shared/logger');

// REQ-00019: Raid 奖励池添加 TM
const RAID_TM_REWARDS = {
  1: ['TM01', 'TM02', 'TM03', 'TM04', 'TM05', 'TM06', 'TM07', 'TM08', 'TM09', 'TM10'],  // 1星 Raid：普通 TM
  3: ['TM13', 'TM14', 'TM15', 'TM16', 'TM17', 'TM18', 'TM19', 'TM20'],                  // 3星 Raid：稀有 TM
  5: ['TM24', 'TM25', 'TM26', 'TM27', 'TM28', 'TM29', 'TM30', 'TM31'],                  // 5星 Raid：史诗 TM
  MEGA: ['TM50', 'TM51', 'TM52'],                                                        // Mega Raid：传奇 TM
  ELITE: ['ELITE_TM']                                                                    // 精英 Raid：精英 TM
};

// TM 掉落概率
const RAID_TM_CHANCE = {
  1: 0.05,    // 1星: 5%
  3: 0.15,    // 3星: 15%
  5: 0.30,    // 5星: 30%
  MEGA: 0.50, // Mega: 50%
  ELITE: 0.80 // 精英: 80%
};

/**
 * 生成 Raid 奖励
 * @param {number} raidLevel - Raid 等级 (1, 3, 5, 'MEGA', 'ELITE')
 * @param {number} userId - 用户ID
 * @returns {Object} 奖励对象
 */
async function generateRaidRewards(raidLevel, userId) {
  const rewards = {
    xp: 0,
    stardust: 0,
    items: [],
    tm: null
  };
  
  // 基础奖励
  switch (raidLevel) {
    case 1:
      rewards.xp = 3000;
      rewards.stardust = 500;
      rewards.items = [
        { type: 'POKE_BALL', qty: 5 + Math.floor(Math.random() * 3) },
        { type: 'RAZZ_BERRY', qty: Math.random() < 0.3 ? 1 : 0 }
      ];
      break;
    case 3:
      rewards.xp = 5000;
      rewards.stardust = 1000;
      rewards.items = [
        { type: 'GREAT_BALL', qty: 3 + Math.floor(Math.random() * 2) },
        { type: 'RAZZ_BERRY', qty: 2 },
        { type: 'GOLDEN_RAZZ_BERRY', qty: Math.random() < 0.3 ? 1 : 0 }
      ];
      break;
    case 5:
      rewards.xp = 10000;
      rewards.stardust = 3000;
      rewards.items = [
        { type: 'ULTRA_BALL', qty: 3 + Math.floor(Math.random() * 2) },
        { type: 'GOLDEN_RAZZ_BERRY', qty: 3 },
        { type: 'RARE_CANDY', qty: 1 + Math.floor(Math.random() * 2) }
      ];
      break;
    case 'MEGA':
      rewards.xp = 15000;
      rewards.stardust = 5000;
      rewards.items = [
        { type: 'ULTRA_BALL', qty: 5 },
        { type: 'GOLDEN_RAZZ_BERRY', qty: 5 },
        { type: 'RARE_CANDY', qty: 3 },
        { type: 'MEGA_ENERGY', qty: 50 }
      ];
      break;
    case 'ELITE':
      rewards.xp = 25000;
      rewards.stardust = 10000;
      rewards.items = [
        { type: 'ULTRA_BALL', qty: 10 },
        { type: 'GOLDEN_RAZZ_BERRY', qty: 10 },
        { type: 'RARE_CANDY', qty: 5 },
        { type: 'MEGA_ENERGY', qty: 100 }
      ];
      break;
  }
  
  // REQ-00019: TM 掉落
  const tmChance = RAID_TM_CHANCE[raidLevel] || 0.05;
  if (Math.random() < tmChance) {
    const tmPool = RAID_TM_REWARDS[raidLevel] || RAID_TM_REWARDS[1];
    const tmId = tmPool[Math.floor(Math.random() * tmPool.length)];
    rewards.tm = { tmId, qty: 1 };
    rewards.items.push({ type: 'TM', tmId, qty: 1 });
  }
  
  // 应用奖励
  await applyRewards(userId, rewards);
  
  logger.info('Raid rewards granted', {
    userId,
    raidLevel,
    xp: rewards.xp,
    stardust: rewards.stardust,
    tm: rewards.tm
  });
  
  return rewards;
}

/**
 * 应用奖励到用户
 */
async function applyRewards(userId, rewards) {
  await transaction(async (client) => {
    // 更新用户属性
    await client.query(`
      UPDATE users SET
        xp = xp + $2,
        stardust = stardust + $3
      WHERE id = $1
    `, [userId, rewards.xp, rewards.stardust]);
    
    // 应用物品奖励
    for (const item of rewards.items) {
      if (item.type === 'POKE_BALL') {
        await client.query(`
          UPDATE users SET pokeball_count = pokeball_count + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'GREAT_BALL') {
        await client.query(`
          UPDATE users SET greatball_count = greatball_count + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'ULTRA_BALL') {
        await client.query(`
          UPDATE users SET ultraball_count = ultraball_count + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'RAZZ_BERRY') {
        await client.query(`
          UPDATE users SET razz_berry_count = COALESCE(razz_berry_count, 0) + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'GOLDEN_RAZZ_BERRY') {
        await client.query(`
          UPDATE users SET golden_razz_berry_count = COALESCE(golden_razz_berry_count, 0) + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'RARE_CANDY') {
        await client.query(`
          UPDATE users SET rare_candy_count = COALESCE(rare_candy_count, 0) + $2 WHERE id = $1
        `, [userId, item.qty]);
      } else if (item.type === 'TM' && item.tmId) {
        // REQ-00019: 添加 TM 到背包
        await client.query(`
          INSERT INTO tm_inventory (user_id, tm_id, quantity)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, tm_id)
          DO UPDATE SET quantity = tm_inventory.quantity + $3
        `, [userId, item.tmId, item.qty]);
      }
    }
  });
}

/**
 * 补给站 TM 掉落（REQ-00019: 2% 概率）
 * @param {number} userId - 用户ID
 * @returns {Object|null} TM 奖励或 null
 */
async function tryPokestopTMDrop(userId) {
  if (Math.random() < 0.02) {
    // 随机选择一个普通 TM
    const commonTMs = RAID_TM_REWARDS[1];
    const tmId = commonTMs[Math.floor(Math.random() * commonTMs.length)];
    
    await query(`
      INSERT INTO tm_inventory (user_id, tm_id, quantity)
      VALUES ($1, $2, 1)
      ON CONFLICT (user_id, tm_id)
      DO UPDATE SET quantity = tm_inventory.quantity + 1
    `, [userId, tmId]);
    
    logger.info('TM dropped from pokestop', { userId, tmId });
    
    return { tmId, qty: 1 };
  }
  
  return null;
}

module.exports = {
  generateRaidRewards,
  tryPokestopTMDrop,
  RAID_TM_REWARDS,
  RAID_TM_CHANCE
};
