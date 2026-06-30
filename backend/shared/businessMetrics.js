/**
const { createLogger } = require('./logger');
const logger = createLogger('businessMetrics');
 * 业务指标定义与采集模块
 * REQ-00094: 实时业务指标仪表板与运营监控系统
 */

const { Gauge, Counter, Histogram, Registry } = require('prom-client');

// 业务指标注册表
const businessRegistry = new Registry();

// 业务指标定义
const BUSINESS_METRICS = {
  // 玩家指标
  players: {
    online: 'minego_players_online',           // 当前在线玩家数
    newRegistrations: 'minego_players_new',    // 新注册玩家数
    dau: 'minego_players_dau',                 // 日活跃用户数
    mau: 'minego_players_mau',                 // 月活跃用户数
    retention1d: 'minego_players_retention_1d', // 1日留存率
    retention7d: 'minego_players_retention_7d', // 7日留存率
    retention30d: 'minego_players_retention_30d', // 30日留存率
    arpu: 'minego_players_arpu',              // 平均每用户收入
    ltv: 'minego_players_ltv',                // 用户生命周期价值
  },
  
  // 精灵指标
  pokemon: {
    caught: 'minego_pokemon_caught_total',    // 累计捕捉精灵数
    catchRate: 'minego_pokemon_catch_rate',   // 捕捉成功率
    spawned: 'minego_pokemon_spawned_total',  // 生成的精灵数
    evolved: 'minego_pokemon_evolved_total',  // 进化次数
    traded: 'minego_pokemon_traded_total',    // 交易次数
  },
  
  // 道馆指标
  gym: {
    total: 'minego_gym_total',                // 道馆总数
    owned: 'minego_gym_owned',                // 被占领道馆数
    battles: 'minego_gym_battles_total',      // 战斗次数
    raids: 'minego_gym_raids_total',          // Raid 次数
  },
  
  // 社交指标
  social: {
    friends: 'minego_social_friends_total',   // 好友关系数
    gifts: 'minego_social_gifts_total',       // 礼物发送数
    messages: 'minego_social_messages_total', // 消息数
  },
  
  // 支付指标
  payment: {
    revenue: 'minego_payment_revenue',        // 收入（分币）
    orders: 'minego_payment_orders_total',    // 订单数
    conversion: 'minego_payment_conversion',  // 付费转化率
    refund: 'minego_payment_refund_total',    // 退款数
  }
};

// 玩家指标
const playersOnlineGauge = new Gauge({
  name: 'minego_players_online',
  help: '当前在线玩家数',
  registers: [businessRegistry]
});

const playersNewCounter = new Counter({
  name: 'minego_players_new_total',
  help: '新注册玩家总数',
  labelNames: ['date'],
  registers: [businessRegistry]
});

const playersDauGauge = new Gauge({
  name: 'minego_players_dau',
  help: '日活跃用户数',
  labelNames: ['date'],
  registers: [businessRegistry]
});

const playersMauGauge = new Gauge({
  name: 'minego_players_mau',
  help: '月活跃用户数',
  labelNames: ['month'],
  registers: [businessRegistry]
});

const playersRetentionGauge = new Gauge({
  name: 'minego_players_retention',
  help: '留存率',
  labelNames: ['period', 'date'],
  registers: [businessRegistry]
});

const playersArpuGauge = new Gauge({
  name: 'minego_players_arpu',
  help: '平均每用户收入（分币）',
  labelNames: ['period'],
  registers: [businessRegistry]
});

const playersLtvGauge = new Gauge({
  name: 'minego_players_ltv',
  help: '用户生命周期价值（分币）',
  labelNames: ['cohort'],
  registers: [businessRegistry]
});

// 精灵指标
const pokemonCaughtCounter = new Counter({
  name: 'minego_pokemon_caught_total',
  help: '累计捕捉精灵数',
  labelNames: ['pokemon_id', 'region'],
  registers: [businessRegistry]
});

const pokemonCatchRateGauge = new Gauge({
  name: 'minego_pokemon_catch_rate',
  help: '捕捉成功率',
  registers: [businessRegistry]
});

const pokemonSpawnedCounter = new Counter({
  name: 'minego_pokemon_spawned_total',
  help: '生成的精灵数',
  labelNames: ['pokemon_id', 'region'],
  registers: [businessRegistry]
});

const pokemonEvolvedCounter = new Counter({
  name: 'minego_pokemon_evolved_total',
  help: '进化次数',
  labelNames: ['pokemon_id'],
  registers: [businessRegistry]
});

const pokemonTradedCounter = new Counter({
  name: 'minego_pokemon_traded_total',
  help: '交易次数',
  labelNames: ['region'],
  registers: [businessRegistry]
});

const pokemonCatchDurationHistogram = new Histogram({
  name: 'minego_pokemon_catch_duration_seconds',
  help: '捕捉操作耗时分布',
  labelNames: ['success'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [businessRegistry]
});

// 道馆指标
const gymTotalGauge = new Gauge({
  name: 'minego_gym_total',
  help: '道馆总数',
  registers: [businessRegistry]
});

const gymOwnedGauge = new Gauge({
  name: 'minego_gym_owned',
  help: '被占领道馆数',
  labelNames: ['team'],
  registers: [businessRegistry]
});

const gymBattlesCounter = new Counter({
  name: 'minego_gym_battles_total',
  help: '战斗次数',
  labelNames: ['result', 'gym_id'],
  registers: [businessRegistry]
});

const gymRaidsCounter = new Counter({
  name: 'minego_gym_raids_total',
  help: 'Raid 次数',
  labelNames: ['result', 'gym_id'],
  registers: [businessRegistry]
});

// 社交指标
const socialFriendsCounter = new Counter({
  name: 'minego_social_friends_total',
  help: '好友关系数',
  registers: [businessRegistry]
});

const socialGiftsCounter = new Counter({
  name: 'minego_social_gifts_total',
  help: '礼物发送数',
  labelNames: ['gift_type'],
  registers: [businessRegistry]
});

const socialMessagesCounter = new Counter({
  name: 'minego_social_messages_total',
  help: '消息数',
  labelNames: ['type'],
  registers: [businessRegistry]
});

// 支付指标
const paymentRevenueCounter = new Counter({
  name: 'minego_payment_revenue_total',
  help: '总收入（分币）',
  labelNames: ['currency', 'product'],
  registers: [businessRegistry]
});

const paymentOrdersCounter = new Counter({
  name: 'minego_payment_orders_total',
  help: '订单数',
  labelNames: ['status', 'product'],
  registers: [businessRegistry]
});

const paymentConversionGauge = new Gauge({
  name: 'minego_payment_conversion',
  help: '付费转化率',
  labelNames: ['period'],
  registers: [businessRegistry]
});

const paymentRefundCounter = new Counter({
  name: 'minego_payment_refund_total',
  help: '退款数',
  labelNames: ['reason'],
  registers: [businessRegistry]
});

// 地区分布指标
const playersByRegionGauge = new Gauge({
  name: 'minego_players_online_by_region',
  help: '各地区在线玩家数',
  labelNames: ['region', 'country'],
  registers: [businessRegistry]
});

/**
 * 业务指标采集器类
 */
class BusinessMetricsCollector {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    this.today = new Date().toISOString().split('T')[0];
    
    // 统计缓存
    this.statsCache = {
      catchAttempts: 0,
      catchSuccess: 0
    };
  }

  /**
   * 记录玩家上线
   */
  async recordPlayerOnline(userId, region = 'unknown') {
    playersOnlineGauge.inc();
    playersNewCounter.inc({ date: this.today });
    
    // 地区分布
    playersByRegionGauge.inc({ region, country: region.split('-')[0] });
    
    // Redis 记录在线用户集合（用于计算 DAU）
    const today = new Date().toISOString().split('T')[0];
    await this.redis.sadd(`dau:${today}`, userId);
    await this.redis.expire(`dau:${today}`, 86400 * 2); // 2天过期
  }

  /**
   * 记录玩家下线
   */
  async recordPlayerOffline(userId, region = 'unknown') {
    playersOnlineGauge.dec();
    playersByRegionGauge.dec({ region, country: region.split('-')[0] });
  }

  /**
   * 记录精灵捕捉
   */
  async recordPokemonCatch(userId, pokemonId, success, duration, region = 'unknown') {
    this.statsCache.catchAttempts++;
    if (success) {
      this.statsCache.catchSuccess++;
      pokemonCaughtCounter.inc({ pokemon_id: pokemonId, region });
    }
    
    pokemonCatchDurationHistogram.observe({ success: success.toString() }, duration / 1000);
    
    // 更新捕捉成功率（实时）
    const rate = this.statsCache.catchSuccess / this.statsCache.catchAttempts;
    pokemonCatchRateGauge.set(rate);
  }

  /**
   * 记录精灵生成
   */
  recordPokemonSpawn(pokemonId, region = 'unknown') {
    pokemonSpawnedCounter.inc({ pokemon_id: pokemonId, region });
  }

  /**
   * 记录精灵进化
   */
  recordPokemonEvolve(pokemonId) {
    pokemonEvolvedCounter.inc({ pokemon_id: pokemonId });
  }

  /**
   * 记录精灵交易
   */
  recordPokemonTrade(region = 'unknown') {
    pokemonTradedCounter.inc({ region });
  }

  /**
   * 记录道馆战斗
   */
  recordGymBattle(gymId, result) {
    gymBattlesCounter.inc({ result, gym_id: gymId });
  }

  /**
   * 记录 Raid
   */
  recordRaid(gymId, result) {
    gymRaidsCounter.inc({ result, gym_id: gymId });
  }

  /**
   * 记录好友关系建立
   */
  recordFriendship() {
    socialFriendsCounter.inc();
  }

  /**
   * 记录礼物发送
   */
  recordGift(giftType) {
    socialGiftsCounter.inc({ gift_type: giftType });
  }

  /**
   * 记录消息发送
   */
  recordMessage(messageType) {
    socialMessagesCounter.inc({ type: messageType });
  }

  /**
   * 记录支付订单
   */
  async recordPayment(userId, amount, currency, product) {
    paymentRevenueCounter.inc(amount, { currency, product });
    paymentOrdersCounter.inc({ status: 'success', product });
    
    // 更新转化率
    await this.updateConversionRate();
    
    // 更新 ARPU
    await this.updateArpu();
  }

  /**
   * 记录退款
   */
  recordRefund(reason) {
    paymentRefundCounter.inc({ reason });
  }

  /**
   * 更新付费转化率
   */
  async updateConversionRate() {
    const today = new Date().toISOString().split('T')[0];
    const dauKey = `dau:${today}`;
    const payersKey = `payers:${today}`;
    
    const dau = await this.redis.scard(dauKey);
    const payers = await this.redis.scard(payersKey);
    
    if (dau > 0) {
      const rate = payers / dau;
      paymentConversionGauge.set(rate, { period: 'daily' });
    }
  }

  /**
   * 更新 ARPU
   */
  async updateArpu() {
    const today = new Date().toISOString().split('T')[0];
    const dauKey = `dau:${today}`;
    const revenueKey = `revenue:${today}`;
    
    const dau = await this.redis.scard(dauKey);
    const revenue = parseInt(await this.redis.get(revenueKey) || '0', 10);
    
    if (dau > 0) {
      const arpu = revenue / dau;
      playersArpuGauge.set(arpu, { period: 'daily' });
    }
  }

  /**
   * 获取实时业务指标
   */
  async getRealtimeMetrics() {
    const today = new Date().toISOString().split('T')[0];
    
    // 从 Redis 获取实时数据
    const dau = await this.redis.scard(`dau:${today}`);
    const payers = await this.redis.scard(`payers:${today}`);
    
    // 计算在线玩家数
    const online = await this.redis.get('players:online') || 0;
    
    // 获取今日收入
    const revenue = parseInt(await this.redis.get(`revenue:${today}`) || '0', 10);
    
    // 从数据库获取统计数据
    const stats = await this.getStatsFromDB();
    
    return {
      timestamp: new Date(),
      players: {
        online: parseInt(online, 10),
        dau: dau,
        payers: payers,
        newToday: stats.newUsers || 0
      },
      pokemon: {
        caught: stats.pokemonCaught || 0,
        catchRate: this.statsCache.catchAttempts > 0 
          ? (this.statsCache.catchSuccess / this.statsCache.catchAttempts) 
          : 0
      },
      gym: {
        battles: stats.gymBattles || 0,
        raids: stats.gymRaids || 0
      },
      payment: {
        revenue: revenue,
        orders: stats.orders || 0,
        conversion: dau > 0 ? payers / dau : 0
      }
    };
  }

  /**
   * 从数据库获取统计数据
   */
  async getStatsFromDB() {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const queries = await Promise.all([
        // 今日新用户
        this.db.query(
          'SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = $1',
          [today]
        ),
        // 今日捕捉数
        this.db.query(
          'SELECT COUNT(*) as count FROM pokemon_catches WHERE DATE(created_at) = $1',
          [today]
        ),
        // 今日战斗数
        this.db.query(
          'SELECT COUNT(*) as count FROM gym_battles WHERE DATE(created_at) = $1',
          [today]
        ),
        // 今日 Raid 数
        this.db.query(
          'SELECT COUNT(*) as count FROM gym_raids WHERE DATE(created_at) = $1',
          [today]
        ),
        // 今日订单数
        this.db.query(
          'SELECT COUNT(*) as count FROM payment_orders WHERE DATE(created_at) = $1 AND status = $2',
          [today, 'success']
        )
      ]);
      
      return {
        newUsers: parseInt(queries[0].rows[0].count, 10),
        pokemonCaught: parseInt(queries[1].rows[0].count, 10),
        gymBattles: parseInt(queries[2].rows[0].count, 10),
        gymRaids: parseInt(queries[3].rows[0].count, 10),
        orders: parseInt(queries[4].rows[0].count, 10)
      };
    } catch (error) {
      logger.error({ module: 'businessMetrics', error: error.message }, 'Failed to get stats from DB');
      return {};
    }
  }

  /**
   * 获取小时级指标数据
   */
  async getHourlyMetrics(start, end) {
    try {
      const result = await this.db.query(`
        SELECT 
          DATE_TRUNC('hour', created_at) as hour,
          COUNT(DISTINCT user_id) as active_users,
          COUNT(*) FILTER (WHERE action = 'catch') as catches,
          COUNT(*) FILTER (WHERE action = 'battle') as battles,
          COUNT(*) FILTER (WHERE action = 'payment') as payments
        FROM user_activities
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY hour
        ORDER BY hour
      `, [start, end]);
      
      return result.rows;
    } catch (error) {
      logger.error({ module: 'businessMetrics', error: error.message }, 'Failed to get hourly metrics');
      return [];
    }
  }

  /**
   * 获取日级指标数据
   */
  async getDailyMetrics(start, end) {
    try {
      const result = await this.db.query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(DISTINCT user_id) as dau,
          COUNT(*) FILTER (WHERE action = 'catch') as catches,
          COUNT(*) FILTER (WHERE action = 'battle') as battles,
          SUM(amount) FILTER (WHERE action = 'payment') as revenue
        FROM user_activities
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY date
        ORDER BY date
      `, [start, end]);
      
      return result.rows;
    } catch (error) {
      logger.error({ module: 'Failed to get daily metrics', error: error.message }, 'Failed to get daily metrics error');;
      return [];
    }
  }

  /**
   * 获取地理分布数据
   */
  async getGeoDistribution() {
    try {
      const result = await this.db.query(`
        SELECT 
          country,
          region,
          COUNT(*) as player_count
        FROM user_locations
        WHERE updated_at >= NOW() - INTERVAL '1 hour'
        GROUP BY country, region
        ORDER BY player_count DESC
        LIMIT 100
      `);
      
      return result.rows;
    } catch (error) {
      logger.error({ module: 'Failed to get geo distribution', error: error.message }, 'Failed to get geo distribution error');;
      return [];
    }
  }

  /**
   * 获取 Prometheus 指标
   */
  async getMetrics() {
    return await businessRegistry.metrics();
  }
}

module.exports = {
  BusinessMetricsCollector,
  businessRegistry,
  BUSINESS_METRICS,
  // 导出各指标供直接使用
  playersOnlineGauge,
  playersNewCounter,
  playersDauGauge,
  pokemonCaughtCounter,
  pokemonCatchRateGauge,
  gymBattlesCounter,
  paymentRevenueCounter,
  paymentOrdersCounter
};
