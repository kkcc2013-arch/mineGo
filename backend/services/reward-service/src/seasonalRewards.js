/**
 * 季节奖励管理模块
 * 负责季节任务、商店、成就和奖励系统
 */

const { SeasonalEngine, SEASONS } = require('../../../shared/seasonalEngine');

class SeasonalRewardManager {
  constructor(db, redis, eventBus) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    this.engine = new SeasonalEngine();
  }

  /**
   * 获取季节商店
   */
  getSeasonalShop() {
    const shops = {
      SPRING: {
        items: [
          { id: 'spring_bundle', name: '春日礼包', price: 1480, contents: ['lucky_egg', 'incense', 'sun_stone'] },
          { id: 'flower_crown', name: '花冠头饰', price: 200, type: 'avatar_item' },
          { id: 'spring_bg', name: '樱花背景', price: 100, type: 'background' }
        ],
        discount: { sunday: 20 }
      },
      SUMMER: {
        items: [
          { id: 'summer_bundle', name: '夏日礼包', price: 1680, contents: ['super_incubator', 'heat_rock', 'star_piece'] },
          { id: 'sunglasses', name: '太阳镜', price: 150, type: 'avatar_item' },
          { id: 'beach_bg', name: '海滩背景', price: 100, type: 'background' }
        ],
        discount: { weekend: 15 }
      },
      AUTUMN: {
        items: [
          { id: 'autumn_bundle', name: '秋收礼包', price: 1280, contents: ['dusk_stone', 'pumpkin_berry', 'mystery_box'] },
          { id: 'witch_hat', name: '巫师帽', price: 250, type: 'avatar_item' },
          { id: 'forest_bg', name: '秋林背景', price: 100, type: 'background' }
        ],
        discount: { halloween: 30 }
      },
      WINTER: {
        items: [
          { id: 'winter_bundle', name: '冬日礼包', price: 1880, contents: ['glacial_lure', 'poffin', 'rare_candy_xl'] },
          { id: 'santa_hat', name: '圣诞帽', price: 200, type: 'avatar_item' },
          { id: 'snow_bg', name: '雪景背景', price: 100, type: 'background' }
        ],
        discount: { holiday: 40 }
      }
    };

    return shops[this.engine.currentSeason] || shops.SPRING;
  }

  /**
   * 获取季节成就
   */
  getSeasonalAchievements() {
    const achievements = {
      SPRING: [
        { id: 'spring_master', name: '春之大师', condition: '完成所有春季任务', reward: { badge: 'spring_badge', stardust: 5000 } },
        { id: 'grass_collector', name: '草系收藏家', condition: '捕捉 100 只草系精灵', reward: { medal: 'grass_gold', xp: 10000 } }
      ],
      SUMMER: [
        { id: 'summer_master', name: '夏日英雄', condition: '完成所有夏季任务', reward: { badge: 'summer_badge', stardust: 5000 } },
        { id: 'fire_catcher', name: '火焰捕捉者', condition: '捕捉 100 只火系精灵', reward: { medal: 'fire_gold', xp: 10000 } }
      ],
      AUTUMN: [
        { id: 'autumn_master', name: '秋日神秘家', condition: '完成所有秋季任务', reward: { badge: 'autumn_badge', stardust: 5000 } },
        { id: 'ghost_hunter', name: '幽灵猎人', condition: '捕捉 100 只幽灵系精灵', reward: { medal: 'ghost_gold', xp: 10000 } }
      ],
      WINTER: [
        { id: 'winter_master', name: '冰雪王者', condition: '完成所有冬季任务', reward: { badge: 'winter_badge', stardust: 5000 } },
        { id: 'ice_catcher', name: '冰霜收集者', condition: '捕捉 100 只冰系精灵', reward: { medal: 'ice_gold', xp: 10000 } }
      ]
    };

    return achievements[this.engine.currentSeason] || [];
  }

  /**
   * 获取用户季节任务进度
   */
  async getUserQuestProgress(userId) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    try {
      const result = await this.db.query(`
        SELECT usq.*, sq.name, sq.description, sq.target_value, sq.rewards
        FROM user_seasonal_quests usq
        JOIN seasonal_quests sq ON usq.quest_id = sq.quest_id
        WHERE usq.user_id = $1 AND usq.season = $2 AND usq.year = $3
      `, [userId, season, year]);

      return result.rows;
    } catch (error) {
      console.error('[SeasonalRewardManager] Error getting quest progress:', error);
      return [];
    }
  }

  /**
   * 更新任务进度
   */
  async updateQuestProgress(userId, questId, increment = 1) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    try {
      // 确保任务记录存在
      await this.db.query(`
        INSERT INTO user_seasonal_quests (user_id, quest_id, season, year, progress)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, quest_id, season, year)
        DO UPDATE SET progress = user_seasonal_quests.progress + $5
      `, [userId, questId, season, year, increment]);

      // 检查是否完成
      const result = await this.db.query(`
        SELECT usq.progress, sq.target_value
        FROM user_seasonal_quests usq
        JOIN seasonal_quests sq ON usq.quest_id = sq.quest_id
        WHERE usq.user_id = $1 AND usq.quest_id = $2 AND usq.season = $3 AND usq.year = $4
      `, [userId, questId, season, year]);

      if (result.rows[0] && result.rows[0].progress >= result.rows[0].target_value) {
        await this.markQuestComplete(userId, questId);
      }
    } catch (error) {
      console.error('[SeasonalRewardManager] Error updating quest progress:', error);
    }
  }

  /**
   * 标记任务完成
   */
  async markQuestComplete(userId, questId) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    await this.db.query(`
      UPDATE user_seasonal_quests
      SET completed = true, completed_at = NOW()
      WHERE user_id = $1 AND quest_id = $2 AND season = $3 AND year = $4
    `, [userId, questId, season, year]);

    // 发布任务完成事件
    if (this.eventBus) {
      await this.eventBus.publish('seasonal.quest.completed', {
        userId,
        questId,
        season,
        year
      });
    }
  }

  /**
   * 领取任务奖励
   */
  async claimQuestReward(userId, questId) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    try {
      // 获取任务信息
      const questResult = await this.db.query(`
        SELECT usq.*, sq.rewards
        FROM user_seasonal_quests usq
        JOIN seasonal_quests sq ON usq.quest_id = sq.quest_id
        WHERE usq.user_id = $1 AND usq.quest_id = $2 AND usq.season = $3 AND usq.year = $4
      `, [userId, questId, season, year]);

      const quest = questResult.rows[0];

      if (!quest) {
        return { success: false, error: 'Quest not found' };
      }

      if (!quest.completed) {
        return { success: false, error: 'Quest not completed' };
      }

      if (quest.claimed) {
        return { success: false, error: 'Reward already claimed' };
      }

      // 发放奖励
      const rewards = quest.rewards;
      await this.grantRewards(userId, rewards);

      // 标记已领取
      await this.db.query(`
        UPDATE user_seasonal_quests
        SET claimed = true
        WHERE user_id = $1 AND quest_id = $2 AND season = $3 AND year = $4
      `, [userId, questId, season, year]);

      return { success: true, rewards };
    } catch (error) {
      console.error('[SeasonalRewardManager] Error claiming reward:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发放奖励
   */
  async grantRewards(userId, rewards) {
    // 发放星尘
    if (rewards.stardust) {
      await this.db.query(`
        UPDATE users SET stardust = stardust + $1 WHERE id = $2
      `, [rewards.stardust, userId]);
    }

    // 发放经验
    if (rewards.xp) {
      await this.db.query(`
        UPDATE users SET xp = xp + $1 WHERE id = $2
      `, [rewards.xp, userId]);
    }

    // 发放道具
    if (rewards.item) {
      await this.db.query(`
        INSERT INTO user_items (user_id, item_id, quantity)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, item_id)
        DO UPDATE SET quantity = user_items.quantity + $3
      `, [userId, rewards.item, rewards.qty || 1]);
    }

    // 发放徽章
    if (rewards.badge) {
      await this.db.query(`
        INSERT INTO user_badges (user_id, badge_id, earned_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [userId, rewards.badge]);
    }
  }

  /**
   * 购买季节商品
   */
  async purchaseItem(userId, itemId) {
    const shop = this.getSeasonalShop();
    const item = shop.items.find(i => i.id === itemId);

    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    // 计算折扣价格
    let finalPrice = item.price;
    const now = new Date();
    const dayOfWeek = now.getDay();

    if (shop.discount.sunday && dayOfWeek === 0) {
      finalPrice = Math.floor(item.price * (1 - shop.discount.sunday / 100));
    } else if (shop.discount.weekend && (dayOfWeek === 0 || dayOfWeek === 6)) {
      finalPrice = Math.floor(item.price * (1 - shop.discount.weekend / 100));
    }

    try {
      // 检查余额
      const userResult = await this.db.query(`
        SELECT coins FROM users WHERE id = $1
      `, [userId]);

      if (userResult.rows[0].coins < finalPrice) {
        return { success: false, error: 'Insufficient coins' };
      }

      // 扣款
      await this.db.query(`
        UPDATE users SET coins = coins - $1 WHERE id = $2
      `, [finalPrice, userId]);

      // 发放商品内容
      if (item.contents) {
        for (const contentItem of item.contents) {
          await this.grantRewards(userId, { item: contentItem, qty: 1 });
        }
      } else {
        await this.grantRewards(userId, { item: itemId, qty: 1 });
      }

      // 记录购买
      const season = this.engine.currentSeason;
      const year = new Date().getFullYear();
      await this.db.query(`
        INSERT INTO user_seasonal_purchases (user_id, season, year, item_id, price_paid)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, season, year, itemId, finalPrice]);

      return { success: true, item, finalPrice };
    } catch (error) {
      console.error('[SeasonalRewardManager] Error purchasing item:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取用户季节进度
   */
  async getSeasonalProgress(userId) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    try {
      const result = await this.db.query(`
        SELECT * FROM user_seasonal_progress
        WHERE user_id = $1 AND season = $2 AND year = $3
      `, [userId, season, year]);

      return result.rows[0] || {
        user_id: userId,
        season,
        year,
        catches: 0,
        quests_completed: 0,
        achievements: [],
        distance_walked: 0,
        gym_battles: 0
      };
    } catch (error) {
      console.error('[SeasonalRewardManager] Error getting progress:', error);
      return null;
    }
  }

  /**
   * 追踪季节进度
   */
  async trackSeasonalProgress(userId, action, value = 1) {
    const season = this.engine.currentSeason;
    const year = new Date().getFullYear();

    try {
      const fieldMap = {
        catch: 'catches',
        quest_complete: 'quests_completed',
        walk: 'distance_walked',
        gym_battle: 'gym_battles'
      };

      const field = fieldMap[action];
      if (!field) return;

      await this.db.query(`
        INSERT INTO user_seasonal_progress (user_id, season, year, ${field})
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, season, year)
        DO UPDATE SET ${field} = user_seasonal_progress.${field} + $4
      `, [userId, season, year, value]);
    } catch (error) {
      console.error('[SeasonalRewardManager] Error tracking progress:', error);
    }
  }

  /**
   * 生成季节总结报告
   */
  async generateSeasonReport(userId, season, year) {
    try {
      const result = await this.db.query(`
        SELECT * FROM user_seasonal_progress
        WHERE user_id = $1 AND season = $2 AND year = $3
      `, [userId, season, year]);

      const data = result.rows[0] || {};

      return {
        season,
        year,
        period: this.getSeasonPeriod(season, year),
        stats: {
          totalCatches: data.catches || 0,
          questsCompleted: data.quests_completed || 0,
          achievementsUnlocked: (data.achievements || []).length,
          distanceWalked: data.distance_walked || 0,
          gymBattles: data.gym_battles || 0
        },
        highlights: this.getSeasonHighlights(data),
        seasonInfo: SEASONS[season]
      };
    } catch (error) {
      console.error('[SeasonalRewardManager] Error generating report:', error);
      return null;
    }
  }

  /**
   * 获取季节时间段
   */
  getSeasonPeriod(season, year) {
    const months = SEASONS[season]?.months || [3, 4, 5];
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月',
                        '七月', '八月', '九月', '十月', '十一月', '十二月'];
    return {
      start: `${year}年${monthNames[months[0] - 1]}`,
      end: `${year}年${monthNames[months[2] - 1]}`
    };
  }

  /**
   * 获取季节亮点
   */
  getSeasonHighlights(data) {
    const highlights = [];

    if (data.catches >= 100) {
      highlights.push({ type: 'catches', message: `捕捉了 ${data.catches} 只精灵！` });
    }
    if (data.quests_completed >= 3) {
      highlights.push({ type: 'quests', message: `完成了 ${data.quests_completed} 个季节任务` });
    }
    if (data.distance_walked >= 10000) {
      highlights.push({ type: 'distance', message: `行走了 ${(data.distance_walked / 1000).toFixed(1)} 公里` });
    }

    return highlights;
  }
}

module.exports = { SeasonalRewardManager };
