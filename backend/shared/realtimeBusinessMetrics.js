/**
 * backend/shared/realtimeBusinessMetrics.js
 * 实时业务指标计算服务
 * 
 * @module realtimeBusinessMetrics
 * @description 计算 20+ 实时业务指标，暴露给 Prometheus
 */

const promClient = require('prom-client');
const { createLogger } = require('./logger');
const { query } = require('./db');
const Redis = require('ioredis');

const logger = createLogger('realtime-business-metrics');

// ============================================================================
// 业务指标定义
// ============================================================================

const realtimeMetrics = {
  // 1. 用户指标
  activeUsers: new promClient.Gauge({
    name: 'minego_business_active_users',
    help: '当前活跃用户数（5分钟窗口）',
    labelNames: ['platform']
  }),
  
  newUsersToday: new promClient.Gauge({
    name: 'minego_business_new_users_today',
    help: '今日新增用户数',
    labelNames: ['platform']
  }),
  
  userRetentionRate: new promClient.Gauge({
    name: 'minego_business_user_retention_rate',
    help: '用户留存率（7日）',
    labelNames: ['cohort']
  }),
  
  // 2. 捕捉指标
  catchSuccessRate: new promClient.Gauge({
    name: 'minego_business_catch_success_rate',
    help: '精灵捕捉成功率',
    labelNames: ['species_type', 'rarity', 'ball_type']
  }),
  
  catchAttemptsTotal: new promClient.Counter({
    name: 'minego_business_catch_attempts_total',
    help: '捕捉尝试总数',
    labelNames: ['ball_type', 'rarity']
  }),
  
  catchSuccessTotal: new promClient.Counter({
    name: 'minego_business_catch_success_total',
    help: '捕捉成功总数',
    labelNames: ['species_id', 'rarity']
  }),
  
  averageCp: new promClient.Gauge({
    name: 'minego_business_average_cp',
    help: '捕捉精灵平均 CP',
    labelNames: ['rarity']
  }),
  
  // 3. 道馆指标
  gymCapturesTotal: new promClient.Gauge({
    name: 'minego_business_gym_captures_total',
    help: '道馆占领总数',
    labelNames: ['team']
  }),
  
  gymBattlesTotal: new promClient.Counter({
    name: 'minego_business_gym_battles_total',
    help: '道馆战斗总数',
    labelNames: ['result']
  }),
  
  raidParticipants: new promClient.Gauge({
    name: 'minego_business_raid_participants',
    help: 'Raid 参与人数',
    labelNames: ['raid_level']
  }),
  
  raidSuccessRate: new promClient.Gauge({
    name: 'minego_business_raid_success_rate',
    help: 'Raid 成功率',
    labelNames: ['raid_level']
  }),
  
  // 4. 交易指标
  tradeVolumeTotal: new promClient.Counter({
    name: 'minego_business_trade_volume_total',
    help: '交易完成总数',
    labelNames: ['trade_type']
  }),
  
  tradeValueTotal: new promClient.Counter({
    name: 'minego_business_trade_value_total',
    help: '交易价值总和（stardust）',
    labelNames: ['trade_type']
  }),
  
  tradeSuccessRate: new promClient.Gauge({
    name: 'minego_business_trade_success_rate',
    help: '交易成功率',
    labelNames: ['trade_type']
  }),
  
  // 5. 支付指标
  paymentAmountTotal: new promClient.Counter({
    name: 'minego_business_payment_amount_total',
    help: '支付总金额（分）',
    labelNames: ['currency', 'product_type']
  }),
  
  paymentOrdersTotal: new promClient.Counter({
    name: 'minego_business_payment_orders_total',
    help: '支付订单总数',
    labelNames: ['status', 'product_type']
  }),
  
  paymentSuccessRate: new promClient.Gauge({
    name: 'minego_business_payment_success_rate',
    help: '支付成功率',
    labelNames: ['product_type']
  }),
  
  averageOrderValue: new promClient.Gauge({
    name: 'minego_business_average_order_value',
    help: '平均订单金额（分）',
    labelNames: ['currency']
  }),
  
  // 6. 社交指标
  friendsAddedTotal: new promClient.Counter({
    name: 'minego_business_friends_added_total',
    help: '好友添加总数'
  }),
  
  giftsSentTotal: new promClient.Counter({
    name: 'minego_business_gifts_sent_total',
    help: '礼物发送总数'
  }),
  
  giftsOpenedTotal: new promClient.Counter({
    name: 'minego_business_gifts_opened_total',
    help: '礼物打开总数'
  }),
  
  guildMembers: new promClient.Gauge({
    name: 'minego_business_guild_members',
    help: '公会成员数',
    labelNames: ['guild_id']
  }),
  
  // 7. PVP 指标
  pvpMatchesTotal: new promClient.Counter({
    name: 'minego_business_pvp_matches_total',
    help: 'PVP 对战总数',
    labelNames: ['league', 'result']
  }),
  
  pvpRankDistribution: new promClient.Gauge({
    name: 'minego_business_pvp_rank_distribution',
    help: 'PVP 排名分布',
    labelNames: ['league', 'rank_tier']
  }),
  
  // 8. 道具指标
  itemsUsedTotal: new promClient.Counter({
    name: 'minego_business_items_used_total',
    help: '道具使用总数',
    labelNames: ['item_type']
  }),
  
  itemsPurchasedTotal: new promClient.Counter({
    name: 'minego_business_items_purchased_total',
    help: '道具购买总数',
    labelNames: ['item_type']
  }),
  
  // 9. 地理分布
  eventsByRegion: new promClient.Gauge({
    name: 'minego_business_events_by_region',
    help: '各地区事件数量',
    labelNames: ['region', 'event_type']
  }),
  
  activeUsersByRegion: new promClient.Gauge({
    name: 'minego_business_active_users_by_region',
    help: '各地区活跃用户数',
    labelNames: ['region']
  }),
  
  // 10. 事件吞吐量
  eventThroughput: new promClient.Histogram({
    name: 'minego_business_event_throughput_seconds',
    help: '事件处理吞吐量',
    labelNames: ['event_category'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  })
};

// ============================================================================
// 指标计算器
// ============================================================================

class RealtimeBusinessMetricsCalculator {
  constructor(options = {}) {
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL);
    this.updateInterval = options.updateInterval || 60000; // 1 分钟
    this.timer = null;
    this.isRunning = false;
  }
  
  /**
   * 启动定时计算
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.timer = setInterval(() => this.calculate(), this.updateInterval);
    
    // 立即执行一次
    this.calculate().catch(err => {
      logger.error({ err }, 'Initial metrics calculation failed');
    });
    
    logger.info({ interval: this.updateInterval }, 'Realtime business metrics calculator started');
  }
  
  /**
   * 停止定时计算
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info('Realtime business metrics calculator stopped');
  }
  
  /**
   * 计算所有指标
   */
  async calculate() {
    const startTime = Date.now();
    
    try {
      await Promise.all([
        this.calculateUserMetrics(),
        this.calculateCatchMetrics(),
        this.calculateGymMetrics(),
        this.calculateTradeMetrics(),
        this.calculatePaymentMetrics(),
        this.calculateSocialMetrics(),
        this.calculatePVPMetrics(),
        this.calculateItemMetrics(),
        this.calculateGeoMetrics()
      ]);
      
      const duration = Date.now() - startTime;
      logger.debug({ duration }, 'Business metrics calculated');
    } catch (err) {
      logger.error({ err }, 'Failed to calculate business metrics');
    }
  }
  
  /**
   * 计算用户指标
   */
  async calculateUserMetrics() {
    // 活跃用户数（5分钟内）
    const activeUsers = await this.redis.pfcount('active_users:5min');
    realtimeMetrics.activeUsers.set({}, activeUsers);
    
    // 今日新增用户
    const today = new Date().toISOString().split('T')[0];
    const newUsers = await this.redis.get(`stats:new_users:${today}`) || 0;
    realtimeMetrics.newUsersToday.set({}, parseInt(newUsers));
  }
  
  /**
   * 计算捕捉指标
   */
  async calculateCatchMetrics() {
    // 捕捉成功率（最近 1 小时）
    const catchAttempts = parseInt(await this.redis.get('events:catch.attempt:1h') || 0);
    const catchSuccesses = parseInt(await this.redis.get('events:catch.success:1h') || 0);
    
    if (catchAttempts > 0) {
      const rate = catchSuccesses / catchAttempts;
      realtimeMetrics.catchSuccessRate.set({}, rate);
    }
    
    // 平均 CP
    try {
      const { rows } = await query(`
        SELECT AVG(cp)::float as avg_cp
        FROM user_pokemon
        WHERE caught_at > NOW() - INTERVAL '1 hour'
      `);
      
      if (rows[0]?.avg_cp) {
        realtimeMetrics.averageCp.set({}, rows[0].avg_cp);
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to calculate average CP');
    }
  }
  
  /**
   * 计算道馆指标
   */
  async calculateGymMetrics() {
    try {
      // 道馆占领数
      const { rows: gymStats } = await query(`
        SELECT 
          team,
          COUNT(*)::int as count
        FROM gyms
        WHERE occupied_at IS NOT NULL
        GROUP BY team
      `);
      
      for (const stat of gymStats) {
        realtimeMetrics.gymCapturesTotal.set({ team: stat.team }, stat.count);
      }
      
      // Raid 成功率
      const raidWins = parseInt(await this.redis.get('events:gym.raid_win:1h') || 0);
      const raidStarts = parseInt(await this.redis.get('events:gym.raid_start:1h') || 0);
      
      if (raidStarts > 0) {
        realtimeMetrics.raidSuccessRate.set({}, raidWins / raidStarts);
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to calculate gym metrics');
    }
  }
  
  /**
   * 计算交易指标
   */
  async calculateTradeMetrics() {
    // 交易成功率
    const tradeComplete = parseInt(await this.redis.get('events:trade.complete:1h') || 0);
    const tradeInitiate = parseInt(await this.redis.get('events:trade.initiate:1h') || 0);
    
    if (tradeInitiate > 0) {
      realtimeMetrics.tradeSuccessRate.set({}, tradeComplete / tradeInitiate);
    }
  }
  
  /**
   * 计算支付指标
   */
  async calculatePaymentMetrics() {
    try {
      // 支付成功率
      const { rows } = await query(`
        SELECT 
          product_type,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / 
          NULLIF(COUNT(*), 0) as success_rate,
          AVG(CASE WHEN status = 'success' THEN amount ELSE NULL END)::float as avg_amount
        FROM payment_orders
        WHERE created_at > NOW() - INTERVAL '1 hour'
        GROUP BY product_type
      `);
      
      for (const row of rows) {
        if (row.success_rate) {
          realtimeMetrics.paymentSuccessRate.set(
            { product_type: row.product_type },
            row.success_rate
          );
        }
        if (row.avg_amount) {
          realtimeMetrics.averageOrderValue.set(
            { currency: 'CNY' },
            row.avg_amount
          );
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to calculate payment metrics');
    }
  }
  
  /**
   * 计算社交指标
   */
  async calculateSocialMetrics() {
    // 社交事件统计
    const friendsAdded = parseInt(await this.redis.get('events:social.friend_add:24h') || 0);
    const giftsSent = parseInt(await this.redis.get('events:social.gift_send:24h') || 0);
    const giftsOpened = parseInt(await this.redis.get('events:social.gift_open:24h') || 0);
    
    realtimeMetrics.friendsAddedTotal.inc(friendsAdded);
    realtimeMetrics.giftsSentTotal.inc(giftsSent);
    realtimeMetrics.giftsOpenedTotal.inc(giftsOpened);
  }
  
  /**
   * 计算 PVP 指标
   */
  async calculatePVPMetrics() {
    try {
      // PVP 排名分布
      const { rows } = await query(`
        SELECT 
          league,
          rank_tier,
          COUNT(*)::int as count
        FROM pvp_rankings
        GROUP BY league, rank_tier
      `);
      
      for (const row of rows) {
        realtimeMetrics.pvpRankDistribution.set(
          { league: row.league, rank_tier: row.rank_tier },
          row.count
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to calculate PVP metrics');
    }
  }
  
  /**
   * 计算道具指标
   */
  async calculateItemMetrics() {
    // 道具使用统计
    const itemsUsed = parseInt(await this.redis.get('events:item.use:24h') || 0);
    const itemsPurchased = parseInt(await this.redis.get('events:item.purchase:24h') || 0);
    
    realtimeMetrics.itemsUsedTotal.inc({ item_type: 'all' }, itemsUsed);
    realtimeMetrics.itemsPurchasedTotal.inc({ item_type: 'all' }, itemsPurchased);
  }
  
  /**
   * 计算地理分布指标
   */
  async calculateGeoMetrics() {
    try {
      // 各地区活跃用户
      const regions = await this.redis.hgetall('active_users:by_region:5min');
      
      for (const [region, count] of Object.entries(regions)) {
        realtimeMetrics.activeUsersByRegion.set({ region }, parseInt(count));
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to calculate geo metrics');
    }
  }
  
  /**
   * 记录事件
   * @param {string} eventType - 事件类型
   * @param {string} category - 事件类别
   */
  recordEvent(eventType, category) {
    const now = Date.now();
    const hour = Math.floor(now / 3600000) * 3600000;
    const day = Math.floor(now / 86400000) * 86400000;
    
    // Redis 计数
    this.redis.multi()
      .incr(`events:${eventType}:1h`)
      .expireat(`events:${eventType}:1h`, hour + 3600)
      .incr(`events:${eventType}:24h`)
      .expireat(`events:${eventType}:24h`, day + 86400)
      .exec()
      .catch(err => logger.debug({ err }, 'Failed to record event count'));
    
    // Prometheus 直方图
    const duration = 0; // 实际应该测量处理时间
    realtimeMetrics.eventThroughput.observe({ event_category: category }, duration);
  }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  realtimeMetrics,
  RealtimeBusinessMetricsCalculator
};
