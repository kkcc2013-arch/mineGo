# REQ-00512：测试 Mock 数据集中管理与智能生成系统

- **编号**：REQ-00512
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/testUtils、所有后端服务、database/fixtures、GitHub Actions
- **创建时间**：2026-07-08 20:01
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目当前测试基础设施存在 Mock 数据管理的严重缺失：

### 1.1 现状分析
通过代码审查发现：
- **无 Mock 数据管理**：测试中直接硬编码测试数据，散落在各测试文件
- **测试数据不一致**：不同测试用例使用不同数据格式，维护困难
- **外依赖无法隔离**：第三方 API（推送、支付、地图）在测试环境中不可用
- **数据库状态污染**：集成测试共享数据库，测试顺序影响结果
- **测试数据生成繁琐**：精灵、用户、位置等复杂实体需要大量样板代码

### 1.2 相关已有需求
- REQ-00507（测试覆盖率自动化）：侧重覆盖率度量，不涉及 Mock
- REQ-00366（微服务单元测试覆盖）：侧重编写测试用例
- REQ-00292（混沌测试框架）：侧重可靠性测试
- REQ-00436（灾难恢复模块单元测试）：已部分完成

**缺少**：Mock 数据管理、测试数据工厂、外依赖隔离。

### 1.3 影响范围
- **测试稳定性差**：外依赖不稳定导致测试随机失败
- **测试编写效率低**：每次需要手写 Mock 数据
- **测试隔离性差**：数据库测试相互干扰
- **CI/CD 可靠性低**：外部服务不可用导致构建失败

## 2. 目标

构建完整的测试 Mock 数据管理系统，实现：

1. **集中式 Mock 数据仓库**：统一管理所有测试数据
2. **智能 Mock 数据生成器**：基于 schema 自动生成符合业务规则的测试数据
3. **外依赖 Mock 服务**：模拟第三方 API（FCM/APNs、支付宝、微信、Google Maps）
4. **数据库快照与恢复**：测试前快照、测试后恢复，保证隔离性
5. **Mock 数据版本管理**：测试数据可追溯、可回滚
6. **与现有测试框架集成**：无缝对接 Jest/Mocha

## 3. 范围

### 包含
- Mock 数据仓库：`backend/shared/testUtils/mockRepository`
- Mock 数据生成器：`MockDataFactory`
- 外依赖 Mock 服务：推送/支付/地图
- 数据库快照管理：`DatabaseSnapshotManager`
- Mock 数据版本管理：Git-based versioning
- Jest 集成工具：setup/teardown hooks

### 不包含
- 具体测试用例编写（REQ-00366 负责）
- API 契约测试（REQ-00272 已完成）
- E2E 测试框架（可后续独立需求）
- 性能测试数据生成（可后续独立需求）

## 4. 详细需求

### 4.1 Mock 数据仓库

```javascript
// backend/shared/testUtils/mockRepository/index.js
'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logger');

const logger = createLogger('mock-repository');

/**
 * Mock 数据仓库
 * 集中管理所有测试数据
 */
class MockRepository {
  constructor() {
    this.dataDir = path.join(__dirname, '../../../fixtures');
    this.cache = new Map();
    this.loadAllFixtures();
  }

  /**
   * 加载所有 fixtures 文件
   */
  loadAllFixtures() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      return;
    }

    const categories = fs.readdirSync(this.dataDir);
    
    for (const category of categories) {
      const categoryPath = path.join(this.dataDir, category);
      if (fs.statSync(categoryPath).isDirectory()) {
        this.loadCategory(category, categoryPath);
      }
    }
    
    logger.info({ categories: categories.length }, 'Fixtures loaded');
  }

  /**
   * 加载单个类别的 fixtures
   */
  loadCategory(category, categoryPath) {
    const files = fs.readdirSync(categoryPath);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(categoryPath, file);
        const key = `${category}:${path.basename(file, '.json')}`;
        
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          this.cache.set(key, data);
        } catch (err) {
          logger.error({ file: filePath, err }, 'Failed to load fixture');
        }
      }
    }
  }

  /**
   * 获取 Mock 数据
   * @param {string} key - 格式: category:name
   * @param {object} overrides - 覆盖字段
   * @returns {object} Mock 数据副本
   */
  get(key, overrides = {}) {
    const data = this.cache.get(key);
    
    if (!data) {
      throw new Error(`Mock data not found: ${key}`);
    }
    
    // 深拷贝 + 覆盖
    return this.deepMerge(JSON.parse(JSON.stringify(data)), overrides);
  }

  /**
   * 获取 Mock 数据数组
   * @param {string} key
   * @param {number} count
   * @param {array} overrides - 每个元素的覆盖
   */
  getMany(key, count, overrides = []) {
    const baseData = this.cache.get(key);
    if (!baseData) {
      throw new Error(`Mock data not found: ${key}`);
    }

    const results = [];
    for (let i = 0; i < count; i++) {
      const copy = JSON.parse(JSON.stringify(baseData));
      const override = overrides[i] || {};
      results.push(this.deepMerge(copy, override));
    }
    
    return results;
  }

  /**
   * 设置 Mock 数据
   */
  set(key, data) {
    const [category, name] = key.split(':');
    
    if (!category || !name) {
      throw new Error('Key must be format: category:name');
    }

    // 确保目录存在
    const categoryPath = path.join(this.dataDir, category);
    if (!fs.existsSync(categoryPath)) {
      fs.mkdirSync(categoryPath, { recursive: true });
    }

    // 写入文件
    const filePath = path.join(categoryPath, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    
    // 更新缓存
    this.cache.set(key, data);
    
    logger.info({ key }, 'Mock data saved');
  }

  /**
   * 深度合并对象
   */
  deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  /**
   * 列出所有可用的 Mock 数据
   */
  list(category = null) {
    const keys = Array.from(this.cache.keys());
    
    if (category) {
      return keys.filter(k => k.startsWith(`${category}:`));
    }
    
    return keys;
  }
}

// 单例
const mockRepo = new MockRepository();

module.exports = mockRepo;
```

### 4.2 Mock 数据生成器

```javascript
// backend/shared/testUtils/MockDataFactory.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const mockRepo = require('./mockRepository');

/**
 * Mock 数据工厂
 * 智能生成符合业务规则的测试数据
 */
class MockDataFactory {
  constructor() {
    this.pokemonSpecies = this.loadPokemonSpecies();
    this.moveTypes = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
  }

  /**
   * 加载精灵物种数据
   */
  loadPokemonSpecies() {
    try {
      return mockRepo.get('pokemon:species');
    } catch {
      // 返回默认值
      return [
        { id: 1, name: 'Bulbasaur', type: 'grass', baseStats: { hp: 45, attack: 49, defense: 49, spAtk: 65, spDef: 65, speed: 45 } },
        { id: 4, name: 'Charmander', type: 'fire', baseStats: { hp: 39, attack: 52, defense: 43, spAtk: 60, spDef: 50, speed: 65 } },
        { id: 7, name: 'Squirtle', type: 'water', baseStats: { hp: 44, attack: 48, defense: 65, spAtk: 50, spDef: 64, speed: 43 } }
      ];
    }
  }

  /**
   * 生成用户 Mock 数据
   */
  createUser(overrides = {}) {
    const userId = overrides.id || uuidv4();
    
    return {
      id: userId,
      email: `test-${userId.slice(0, 8)}@example.com`,
      username: `trainer_${this.randomString(6)}`,
      passwordHash: '$2b$10$mockHashForTestingPurposesOnly',
      level: this.randomInt(1, 50),
      exp: this.randomInt(0, 100000),
      coins: this.randomInt(0, 10000),
      gems: this.randomInt(0, 100),
      teamId: this.randomChoice(['valor', 'mystic', 'instinct']),
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成精灵 Mock 数据
   */
  createPokemon(overrides = {}) {
    const species = overrides.speciesId 
      ? this.pokemonSpecies.find(s => s.id === overrides.speciesId)
      : this.randomChoice(this.pokemonSpecies);
    
    const level = overrides.level || this.randomInt(1, 50);
    const iv = {
      hp: this.randomInt(0, 15),
      attack: this.randomInt(0, 15),
      defense: this.randomInt(0, 15),
      spAtk: this.randomInt(0, 15),
      spDef: this.randomInt(0, 15),
      speed: this.randomInt(0, 15)
    };
    
    return {
      id: overrides.id || uuidv4(),
      speciesId: species.id,
      name: species.name,
      type: species.type,
      level,
      exp: this.calculateExpForLevel(level),
      iv,
      currentHp: Math.floor((species.baseStats.hp + iv.hp) * level / 50 + 10),
      maxHp: Math.floor((species.baseStats.hp + iv.hp) * level / 50 + 10),
      attack: Math.floor((species.baseStats.attack + iv.attack) * level / 50 + 5),
      defense: Math.floor((species.baseStats.defense + iv.defense) * level / 50 + 5),
      moves: this.generateRandomMoves(species.type),
      isShiny: Math.random() < 0.01,
      ownerId: overrides.ownerId || uuidv4(),
      caughtAt: new Date().toISOString(),
      location: overrides.location || { lat: 0, lng: 0 },
      ...overrides
    };
  }

  /**
   * 生成位置 Mock 数据
   */
  createLocation(overrides = {}) {
    return {
      lat: overrides.lat || this.randomFloat(-90, 90, 6),
      lng: overrides.lng || this.randomFloat(-180, 180, 6),
      accuracy: overrides.accuracy || this.randomInt(5, 50),
      altitude: overrides.altitude || this.randomFloat(0, 1000, 2),
      timestamp: overrides.timestamp || Date.now(),
      ...overrides
    };
  }

  /**
   * 生成道馆 Mock 数据
   */
  createGym(overrides = {}) {
    return {
      id: overrides.id || uuidv4(),
      name: overrides.name || `Gym ${this.randomString(4)}`,
      location: this.createLocation(overrides.location),
      teamId: this.randomChoice(['valor', 'mystic', 'instinct', 'neutral']),
      level: this.randomInt(1, 6),
      prestige: this.randomInt(0, 50000),
      defenderCount: this.randomInt(0, 6),
      createdAt: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成捕捉事件 Mock 数据
   */
  createCatchEvent(overrides = {}) {
    return {
      id: overrides.id || uuidv4(),
      userId: overrides.userId || uuidv4(),
      pokemonId: overrides.pokemonId || uuidv4(),
      location: this.createLocation(overrides.location),
      pokeballType: this.randomChoice(['pokeball', 'greatball', 'ultraball', 'masterball']),
      success: overrides.success !== undefined ? overrides.success : true,
      captureTime: this.randomInt(500, 5000),
      throwQuality: this.randomChoice(['nice', 'great', 'excellent', 'normal']),
      timestamp: Date.now(),
      ...overrides
    };
  }

  /**
   * 生成交易 Mock 数据
   */
  createTrade(overrides = {}) {
    return {
      id: overrides.id || uuidv4(),
      initiatorId: overrides.initiatorId || uuidv4(),
      recipientId: overrides.recipientId || uuidv4(),
      pokemonOffered: overrides.pokemonOffered || [uuidv4()],
      pokemonRequested: overrides.pokemonRequested || [uuidv4()],
      status: this.randomChoice(['pending', 'accepted', 'rejected', 'completed', 'cancelled']),
      createdAt: new Date().toISOString(),
      completedAt: null,
      ...overrides
    };
  }

  /**
   * 生成支付订单 Mock 数据
   */
  createPaymentOrder(overrides = {}) {
    return {
      id: overrides.id || uuidv4(),
      userId: overrides.userId || uuidv4(),
      amount: this.randomChoice([0.99, 4.99, 9.99, 19.99, 49.99]),
      currency: this.randomChoice(['USD', 'CNY', 'EUR', 'JPY']),
      productId: this.randomChoice(['coins_100', 'coins_550', 'coins_1200', 'gems_10', 'gems_50']),
      paymentMethod: this.randomChoice(['alipay', 'wechat', 'apple', 'google', 'credit_card']),
      status: this.randomChoice(['pending', 'paid', 'failed', 'refunded']),
      createdAt: new Date().toISOString(),
      paidAt: null,
      ...overrides
    };
  }

  /**
   * 辅助方法：随机整数
   */
  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * 辅助方法：随机浮点数
   */
  randomFloat(min, max, decimals = 6) {
    const num = Math.random() * (max - min) + min;
    return parseFloat(num.toFixed(decimals));
  }

  /**
   * 辅助方法：随机字符串
   */
  randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 辅助方法：随机选择
   */
  randomChoice(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * 计算等级经验值
   */
  calculateExpForLevel(level) {
    // 简化的经验值曲线
    return Math.floor(Math.pow(level, 3) * 0.5);
  }

  /**
   * 生成随机技能列表
   */
  generateRandomMoves(type) {
    const typeMoves = {
      fire: ['Ember', 'Flamethrower', 'Fire Blast', 'Fire Spin'],
      water: ['Water Gun', 'Hydro Pump', 'Bubble', 'Surf'],
      grass: ['Vine Whip', 'Razor Leaf', 'Solar Beam', 'Leaf Tornado'],
      electric: ['Thunder Shock', 'Thunderbolt', 'Thunder', 'Spark'],
      normal: ['Tackle', 'Scratch', 'Quick Attack', 'Hyper Beam']
    };
    
    const moves = typeMoves[type] || typeMoves.normal;
    return this.shuffleArray(moves).slice(0, 2);
  }

  /**
   * 洗牌数组
   */
  shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

module.exports = MockDataFactory;
```

### 4.3 外依赖 Mock 服务

```javascript
// backend/shared/testUtils/mockServices/PushMockService.js
'use strict';

const { EventEmitter } = require('events');

/**
 * 推送服务 Mock
 * 模拟 FCM/APNs 推送
 */
class PushMockService extends EventEmitter {
  constructor() {
    super();
    this.sentMessages = [];
    this.failures = new Map();
    this.delays = new Map();
  }

  /**
   * 模拟发送推送
   */
  async send(message) {
    // 记录发送的消息
    this.sentMessages.push({
      ...message,
      timestamp: Date.now()
    });

    // 模拟失败场景
    if (this.failures.has(message.token)) {
      throw new Error(this.failures.get(message.token));
    }

    // 模拟延迟
    if (this.delays.has(message.token)) {
      await new Promise(resolve => setTimeout(resolve, this.delays.get(message.token)));
    }

    // 触发成功事件
    this.emit('sent', message);

    return {
      success: true,
      messageId: `mock-${Date.now()}`,
      token: message.token
    };
  }

  /**
   * 批量发送
   */
  async sendMultiple(messages) {
    const results = [];
    for (const msg of messages) {
      try {
        const result = await this.send(msg);
        results.push(result);
      } catch (err) {
        results.push({ success: false, error: err.message, token: msg.token });
      }
    }
    return results;
  }

  /**
   * 设置失败场景
   */
  simulateFailure(token, error) {
    this.failures.set(token, error);
  }

  /**
   * 设置延迟
   */
  simulateDelay(token, ms) {
    this.delays.set(token, ms);
  }

  /**
   * 清除所有模拟
   */
  reset() {
    this.sentMessages = [];
    this.failures.clear();
    this.delays.clear();
  }

  /**
   * 获取发送记录
   */
  getSentMessages() {
    return [...this.sentMessages];
  }

  /**
   * 验证是否发送
   */
  wasSent(predicate) {
    return this.sentMessages.some(predicate);
  }
}

module.exports = PushMockService;
```

```javascript
// backend/shared/testUtils/mockServices/PaymentMockService.js
'use strict';

const { EventEmitter } = require('events');

/**
 * 支付服务 Mock
 * 模拟支付宝/微信/Apple/Google 支付
 */
class PaymentMockService extends EventEmitter {
  constructor() {
    super();
    this.transactions = [];
    this.pendingRefunds = [];
    this.shouldFail = false;
    this.failureReason = null;
  }

  /**
   * 模拟创建支付订单
   */
  async createOrder(orderData) {
    if (this.shouldFail) {
      throw new Error(this.failureReason || 'Payment service unavailable');
    }

    const transaction = {
      id: `mock-txn-${Date.now()}`,
      orderId: orderData.orderId,
      amount: orderData.amount,
      currency: orderData.currency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      provider: orderData.provider
    };

    this.transactions.push(transaction);
    this.emit('orderCreated', transaction);

    return {
      success: true,
      transactionId: transaction.id,
      paymentUrl: `https://mock-payment.example.com/pay/${transaction.id}`,
      expiresIn: 3600
    };
  }

  /**
   * 模拟支付回调
   */
  async handleCallback(callbackData) {
    const transaction = this.transactions.find(t => t.id === callbackData.transactionId);
    
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.status = callbackData.success ? 'paid' : 'failed';
    transaction.paidAt = callbackData.success ? new Date().toISOString() : null;

    this.emit('paymentCompleted', transaction);

    return { success: true, transaction };
  }

  /**
   * 模拟退款
   */
  async refund(transactionId, reason) {
    const transaction = this.transactions.find(t => t.id === transactionId);
    
    if (!transaction) {
      throw new Error('Transaction not found');
    }

    if (transaction.status !== 'paid') {
      throw new Error('Transaction cannot be refunded');
    }

    const refund = {
      id: `mock-refund-${Date.now()}`,
      transactionId,
      amount: transaction.amount,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    this.pendingRefunds.push(refund);
    transaction.status = 'refunded';

    this.emit('refundInitiated', refund);

    return { success: true, refund };
  }

  /**
   * 模拟查询订单状态
   */
  async queryOrder(transactionId) {
    const transaction = this.transactions.find(t => t.id === transactionId);
    
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    return {
      success: true,
      transaction: {
        id: transaction.id,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency
      }
    };
  }

  /**
   * 设置失败场景
   */
  simulateFailure(reason) {
    this.shouldFail = true;
    this.failureReason = reason;
  }

  /**
   * 清除模拟
   */
  reset() {
    this.transactions = [];
    this.pendingRefunds = [];
    this.shouldFail = false;
    this.failureReason = null;
  }

  /**
   * 获取所有交易
   */
  getTransactions() {
    return [...this.transactions];
  }
}

module.exports = PaymentMockService;
```

```javascript
// backend/shared/testUtils/mockServices/GeocodingMockService.js
'use strict';

/**
 * 地理编码服务 Mock
 * 模拟 Google Maps / 高德地图 API
 */
class GeocodingMockService {
  constructor() {
    this.mockLocations = new Map();
    this.shouldFail = false;
    
    // 预设一些常用位置
    this.addMockLocation(39.9042, 116.4074, {
      formattedAddress: '北京市东城区天安门广场',
      country: 'CN',
      province: '北京市',
      city: '北京市',
      district: '东城区'
    });
    
    this.addMockLocation(31.2304, 121.4737, {
      formattedAddress: '上海市黄浦区人民广场',
      country: 'CN',
      province: '上海市',
      city: '上海市',
      district: '黄浦区'
    });
    
    this.addMockLocation(35.6762, 139.6503, {
      formattedAddress: '東京都渋谷区',
      country: 'JP',
      city: 'Tokyo'
    });
  }

  /**
   * 添加 Mock 位置
   */
  addMockLocation(lat, lng, addressInfo) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    this.mockLocations.set(key, addressInfo);
  }

  /**
   * 反向地理编码
   */
  async reverseGeocode(lat, lng) {
    if (this.shouldFail) {
      throw new Error('Geocoding service unavailable');
    }

    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    
    if (this.mockLocations.has(key)) {
      return {
        success: true,
        address: this.mockLocations.get(key)
      };
    }

    // 返回默认值
    return {
      success: true,
      address: {
        formattedAddress: `Mock Address at ${lat}, ${lng}`,
        country: 'XX',
        city: 'Mock City',
        lat,
        lng
      }
    };
  }

  /**
   * 地理编码
   */
  async geocode(address) {
    if (this.shouldFail) {
      throw new Error('Geocoding service unavailable');
    }

    // 返回模拟坐标
    return {
      success: true,
      results: [{
        lat: this.randomFloat(-90, 90),
        lng: this.randomFloat(-180, 180),
        formattedAddress: address
      }]
    };
  }

  /**
   * 计算距离
   */
  async calculateDistance(origin, destination) {
    const R = 6371; // 地球半径（公里）
    
    const dLat = this.toRad(destination.lat - origin.lat);
    const dLng = this.toRad(destination.lng - origin.lng);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(origin.lat)) * Math.cos(this.toRad(destination.lat)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return {
      success: true,
      distance: R * c,
      unit: 'km'
    };
  }

  toRad(deg) {
    return deg * Math.PI / 180;
  }

  randomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  /**
   * 设置失败场景
   */
  simulateFailure() {
    this.shouldFail = true;
  }

  /**
   * 重置
   */
  reset() {
    this.shouldFail = false;
  }
}

module.exports = GeocodingMockService;
```

### 4.4 数据库快照管理

```javascript
// backend/shared/testUtils/DatabaseSnapshotManager.js
'use strict';

const { query } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('db-snapshot');

/**
 * 数据库快照管理器
 * 用于测试隔离和快速恢复
 */
class DatabaseSnapshotManager {
  constructor() {
    this.snapshotTables = [
      'users', 'pokemon', 'gyms', 'catches',
      'trades', 'payments', 'friends', 'items'
    ];
    this.snapshots = new Map();
  }

  /**
   * 创建快照
   * @param {string} name - 快照名称
   */
  async create(name) {
    const snapshot = {
      name,
      timestamp: Date.now(),
      tables: {}
    };

    for (const table of this.snapshotTables) {
      try {
        const { rows } = await query(`SELECT * FROM ${table}`);
        snapshot.tables[table] = rows;
        logger.debug({ table, rows: rows.length }, 'Table snapshotted');
      } catch (err) {
        // 表可能不存在
        logger.warn({ table, err: err.message }, 'Table not found, skipping');
        snapshot.tables[table] = [];
      }
    }

    this.snapshots.set(name, snapshot);
    logger.info({ name, tables: Object.keys(snapshot.tables).length }, 'Snapshot created');
    
    return snapshot;
  }

  /**
   * 恢复快照
   * @param {string} name - 快照名称
   */
  async restore(name) {
    const snapshot = this.snapshots.get(name);
    
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${name}`);
    }

    for (const table of this.snapshotTables) {
      try {
        // 清空表
        await query(`TRUNCATE TABLE ${table} CASCADE`);
        
        // 恢复数据
        const rows = snapshot.tables[table] || [];
        if (rows.length > 0) {
          const columns = Object.keys(rows[0]);
          const values = rows.map(row => columns.map(col => row[col]));
          
          const placeholders = values.map((_, idx) => 
            `(${columns.map((_, colIdx) => `$${idx * columns.length + colIdx + 1}`).join(', ')})`
          ).join(', ');
          
          await query(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
            values.flat()
          );
        }
        
        logger.debug({ table, rows: rows.length }, 'Table restored');
      } catch (err) {
        logger.warn({ table, err: err.message }, 'Failed to restore table');
      }
    }

    logger.info({ name }, 'Snapshot restored');
  }

  /**
   * 删除快照
   */
  delete(name) {
    if (this.snapshots.has(name)) {
      this.snapshots.delete(name);
      logger.info({ name }, 'Snapshot deleted');
      return true;
    }
    return false;
  }

  /**
   * 列出所有快照
   */
  list() {
    return Array.from(this.snapshots.entries()).map(([name, snapshot]) => ({
      name,
      timestamp: snapshot.timestamp,
      tables: Object.keys(snapshot.tables)
    }));
  }

  /**
   * 检查快照是否存在
   */
  exists(name) {
    return this.snapshots.has(name);
  }

  /**
   * 清空数据库（用于测试清理）
   */
  async clear() {
    for (const table of this.snapshotTables) {
      try {
        await query(`TRUNCATE TABLE ${table} CASCADE`);
        logger.debug({ table }, 'Table cleared');
      } catch (err) {
        // 忽略错误
      }
    }
    logger.info('Database cleared');
  }
}

module.exports = DatabaseSnapshotManager;
```

### 4.5 Jest 集成 Setup

```javascript
// backend/shared/testUtils/jestSetup.js
'use strict';

const mockRepo = require('./mockRepository');
const MockDataFactory = require('./MockDataFactory');
const DatabaseSnapshotManager = require('./DatabaseSnapshotManager');
const PushMockService = require('./mockServices/PushMockService');
const PaymentMockService = require('./mockServices/PaymentMockService');
const GeocodingMockService = require('./mockServices/GeocodingMockService');

// 全局实例
let mockFactory;
let dbSnapshot;
let pushMock;
let paymentMock;
let geoMock;

/**
 * Jest 全局 Setup
 */
beforeAll(async () => {
  // 初始化 Mock 工厂
  mockFactory = new MockDataFactory();
  
  // 初始化数据库快照管理器
  dbSnapshot = new DatabaseSnapshotManager();
  await dbSnapshot.create('baseline');
  
  // 初始化 Mock 服务
  pushMock = new PushMockService();
  paymentMock = new PaymentMockService();
  geoMock = new GeocodingMockService();
  
  // 挂载到全局
  global.mockFactory = mockFactory;
  global.mockRepo = mockRepo;
  global.dbSnapshot = dbSnapshot;
  global.pushMock = pushMock;
  global.paymentMock = paymentMock;
  global.geoMock = geoMock;
  
  console.log('[Jest Setup] Mock services initialized');
});

/**
 * 每个测试前
 */
beforeEach(async () => {
  // 恢复数据库快照
  await dbSnapshot.restore('baseline');
  
  // 重置 Mock 服务
  pushMock.reset();
  paymentMock.reset();
  geoMock.reset();
});

/**
 * Jest 全局 Teardown
 */
afterAll(async () => {
  // 清理数据库
  await dbSnapshot.clear();
  
  // 清理快照
  dbSnapshot.delete('baseline');
  
  console.log('[Jest Teardown] Mock services cleaned up');
});

// 导出
module.exports = {
  getMockFactory: () => mockFactory,
  getMockRepo: () => mockRepo,
  getDbSnapshot: () => dbSnapshot,
  getPushMock: () => pushMock,
  getPaymentMock: () => paymentMock,
  getGeoMock: () => geoMock
};
```

### 4.6 Fixtures 目录结构

```
backend/fixtures/
├── pokemon/
│   ├── species.json          # 精灵物种基础数据
│   ├── moves.json            # 技能数据
│   └── types.json            # 属性克制表
├── users/
│   ├── standard.json         # 标准用户模板
│   ├── admin.json            # 管理员模板
│   └── banned.json           # 封禁用户模板
├── locations/
│   ├── gyms.json             # 道馆位置
│   ├── pokestops.json        # 补给站位置
│   └── spawn_points.json     # 刷新点
├── items/
│   ├── pokeballs.json        # 精灵球
│   ├── potions.json          # 药水
│   └── berries.json          # 树果
└── payments/
    ├── products.json         # 商品定义
    └── orders.json           # 订单模板
```

## 5. 验收标准（可测试）

- [ ] Mock 数据仓库可加载和管理 fixtures 数据
- [ ] Mock 数据工厂能生成用户、精灵、位置等实体
- [ ] 推送 Mock 服务能模拟发送和接收
- [ ] 支付 Mock 服务能模拟支付和退款流程
- [ ] 地理编码 Mock 服务能返回地址信息
- [ ] 数据库快照能创建和恢复
- [ ] Jest setup/teardown 正确集成
- [ ] 测试之间相互隔离，不污染数据库
- [ ] Mock 服务支持失败场景模拟
- [ ] 所有 Mock 服务有完整单元测试
- [ ] 文档说明 fixtures 数据格式和使用方法

## 6. 工作量估算

**L - 大型工作量**
- Mock 数据仓库：2 小时
- Mock 数据工厂：3 小时
- 推送 Mock 服务：2 小时
- 支付 Mock 服务：2 小时
- 地理编码 Mock 服务：1.5 小时
- 数据库快照管理：2 小时
- Jest 集成：1 小时
- Fixtures 数据编写：2 小时
- 单元测试：3 小时
- 文档编写：1 小时

总计约 19.5 小时，需 2-3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **测试基础设施缺失**：当前无 Mock 系统，测试难以编写
2. **外依赖隔离需求**：推送/支付等第三方 API 在测试环境不可用
3. **测试稳定性保障**：数据库隔离防止测试相互污染
4. **测试效率提升**：自动生成测试数据，减少样板代码
5. **与 REQ-00507 互补**：覆盖率系统需要 Mock 支持才能有效运行

此需求是提升测试质量和效率的关键基础设施。
