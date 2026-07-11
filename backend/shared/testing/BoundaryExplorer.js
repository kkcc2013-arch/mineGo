/**
 * Boundary Explorer - 边界值自动探索器
 * 自动发现边界值和极端情况
 * 
 * @module backend/shared/testing/BoundaryExplorer
 * @version 1.0.0
 */

/**
 * BoundaryExplorer - 边界值探索器
 * 自动生成各类型数据的边界值用于测试
 */
class BoundaryExplorer {
  constructor() {
    this.boundaries = {
      numeric: this.defineNumericBoundaries(),
      string: this.defineStringBoundaries(),
      array: this.defineArrayBoundaries(),
      object: this.defineObjectBoundaries(),
      date: this.defineDateBoundaries(),
      pokemon: this.definePokemonBoundaries(),
      location: this.defineLocationBoundaries()
    };
  }

  /**
   * 定义数值边界
   */
  defineNumericBoundaries() {
    return {
      // 通用数值边界
      general: [
        0,                    // 零值
        -1,                   // 负值
        1,                    // 正值
        -0,                   // 负零
        NaN,                  // NaN
        Infinity,             // 正无穷
        -Infinity,            // 负无穷
        Number.MAX_SAFE_INTEGER,   // 最大安全整数
        Number.MIN_SAFE_INTEGER,   // 最小安全整数
        Number.MAX_VALUE,          // 最大数值
        Number.MIN_VALUE,          // 最小正数
        Math.PI,                    // π
        Math.E,                     // e
      ],
      // 整数边界
      integer: [
        0,
        1,
        -1,
        2**31 - 1,           // 32位最大整数
        -2**31,               // 32位最小整数
        2**53 - 1,            // 53位最大整数（JS）
        -2**53 + 1,           // 53位最小整数（JS）
        2**63 - 1,            // 64位最大整数
        -2**63,               // 64位最小整数
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
      ],
      // 浮点数边界
      float: [
        0.0,
        0.1,
        -0.1,
        0.001,
        0.000001,
        0.9999999999,
        1.0,
        -1.0,
        1e10,
        -1e10,
        1e-10,
        -1e-10,
        Number.EPSILON,
      ],
      // Pokemon CP 边界
      cp: [
        10,                   // 最小 CP
        65535,                // 最大 CP
        11,                   // 刚超过最小值
        65534,                // 刚低于最大值
        0,                    // 非法：零
        65536,                // 非法：超出上限
        -1,                   // 非法：负值
      ],
      // Pokemon IV 边界
      iv: [
        0,                    // 最小 IV
        31,                   // 最大 IV（完美）
        15,                   // 中等值
        16,                   // 刚超过中等
        -1,                   // 非法：负值
        32,                   // 非法：超出上限
      ],
      // 等级边界
      level: [
        1,                    // 最小等级
        100,                  // 最大等级
        2,                    // 刚超过最小
        99,                   // 刚低于最大
        0,                    // 非法：零
        101,                  // 非法：超出上限
      ],
      // 数量边界
      quantity: [
        0,                    // 零值（允许或禁止取决于场景）
        1,                    // 最小正数
        100,                  // 中等值
        1000,                 // 较大值
        10000,                // 超大值
        100000,               // 极大值
        -1,                   // 非法：负值
      ],
      // 价格边界（单位：元）
      price: [
        0.01,                 // 最小价格（1分）
        0.1,
        1.0,
        10.0,
        100.0,
        1000.0,
        10000.0,              // 最大价格
        10001.0,              // 超出最大值
        0.0,                  // 非法：零价格
        -1.0,                 // 非法：负价格
      ],
      // 百分比边界
      percentage: [
        0,                    // 0%
        0.01,                 // 1%
        0.5,                  // 50%
        0.99,                 // 99%
        1.0,                  // 100%
        -0.01,                // 非法：负百分比
        1.01,                 // 非法：超过100%
      ]
    };
  }

  /**
   * 定义字符串边界
   */
  defineStringBoundaries() {
    return {
      // 通用字符串边界
      general: [
        '',                   // 空字符串
        ' ',                  // 空格
        '\t',                 // Tab
        '\n',                 // 换行
        '\r\n',               // Windows 换行
        '\r',                 // 回车
        '\u0000',             // Null 字符
        '\u202E',             // RTL 控制字符
        'a',                  // 单字符
        'ab',                 // 双字符
        'abc',                // 三字符
        'a'.repeat(100),      // 100 字符
        'a'.repeat(1000),     // 1000 字符
        'a'.repeat(10000),    // 10000 字符（超长）
        'a'.repeat(100000),   // 100000 字符（极端超长）
      ],
      // 特殊字符
      special: [
        '\u0000',             // Null 字符
        '\u0001',             // 控制字符
        '\u0009',             // Tab
        '\u000A',             // 换行
        '\u000D',             // 回车
        '\u007F',             // 删除字符
        '\u0080',             // Latin-1 补充
        '\u00A0',             // 不换行空格
        '\u2000',             // 各种空格
        '\u200B',             // 零宽空格
        '\u200C',             // 零宽非连接符
        '\u200D',             // 零宽连接符
        '\u202A',             // LTR 方向控制
        '\u202B',             // RTL 方向控制
        '\u202C',             // 方向格式控制
        '\u202D',             // LTR override
        '\u202E',             // RTL override
        '\uFEFF',             // 零宽非断空格（BOM）
        '\uFFFE',             // 非字符
        '\uFFFF',             // 非字符
      ],
      // Unicode 边界
      unicode: [
        '𠮷',                 // 4字节 Unicode 字符
        '😀',                 // Emoji
        '🇺🇸',                 // Emoji（国旗）
        '👨‍👩‍👧‍👦',               // Emoji（组合）
        '\uD83D',             // Emoji 代理对前半
        '\uDE00',             // Emoji 代理对后半
        '\u4e00',             // 中文最小字符
        '\u9fff',             // 中文最大字符
        '\u3040',             // 日文平假名最小
        '\u309f',             // 日文平假名最大
        '\u30a0',             // 日文片假名最小
        '\u30ff',             // 日文片假名最大
      ],
      // 注入攻击字符串
      injection: [
        '<script>alert(1)</script>',    // XSS
        '<img src=x onerror=alert(1)>', // XSS
        'javascript:alert(1)',          // XSS
        "' OR '1'='1",                  // SQL 注入
        "'; DROP TABLE users; --",      // SQL 注入
        '{"$gt":""}',                   // NoSQL 注入
        '{ "$where": "true" }',         // NoSQL 注入
        '&& ls',                        // Shell 注入
        '| cat /etc/passwd',            // Shell 注入
        '${7*7}',                       // 模板注入
        '{{constructor.constructor("return this")()}}', // JS 注入
      ],
      // JSON 字符串边界
      json: [
        '{}',
        '[]',
        '{"key":"value"}',
        '{"a":{"b":{"c":1}}}',
        '[1,2,3]',
        'null',
        'undefined',
        'true',
        'false',
        '123',
        '"string"',
        'invalid json',
        '{"key": undefined}',  // 非法 JSON
        '{"key": function()}', // 非法 JSON
      ],
      // Pokemon 名称边界
      pokemonName: [
        'Pikachu',            // 正常名称
        '皮卡丘',             // 中文名称
        'ピカチュウ',         // 日文名称
        'A',                  // 单字符
        'A'.repeat(20),       // 20字符（最大）
        'A'.repeat(21),       // 21字符（超限）
        '',                   // 空（非法）
        'Pikachu123',         // 带数字
        'Pikachu!',           // 带特殊字符
        'Pikachu 皮卡丘',     // 混合语言
        '😀 Pikachu',         // Emoji + 文字
      ],
      // 用户名边界
      username: [
        'user',               // 正常用户名
        'User123',            // 带数字
        'user_name',          // 带下划线
        'user-name',          // 带连字符
        'u',                  // 单字符（最小）
        'user'.repeat(5),     // 20字符（最大）
        '',                   // 空（非法）
        'user name',          // 带空格（非法）
        'user@name',          // 带特殊字符（非法）
        '123user',            // 数字开头（可能非法）
        'user'.repeat(5) + 'x', // 21字符（超限）
      ],
      // 邮箱边界
      email: [
        'user@example.com',   // 正常邮箱
        'user.name@example.com', // 带点
        'user+tag@example.com',  // 带标签
        'u@e.c',              // 最短格式
        'user@subdomain.example.com', // 子域名
        '',                   // 空（非法）
        'user',               // 无域名（非法）
        '@example.com',       // 无用户名（非法）
        'user@',              // 无域名（非法）
        'user @example.com',  // 带空格（非法）
        'user@example',       // 无TLD（非法）
        'user@example..com',  // 双点（非法）
        'user@.com',          // 空域名（非法）
        'user@example.c',     // 1字符TLD（非法）
        'user@example.com.'.repeat(10), // 超长（非法）
      ]
    };
  }

  /**
   * 定义数组边界
   */
  defineArrayBoundaries() {
    return {
      // 通用数组边界
      general: [
        [],                   // 空数组
        [null],               // 包含 null
        [undefined],          // 包含 undefined
        [NaN],                // 包含 NaN
        [0],                  // 单元素
        [1, 2, 3],            // 多元素
        [1, 'a', null, {}],   // 混合类型
        Array(100).fill(0),   // 100元素
        Array(1000).fill(0),  // 1000元素
        Array(10000).fill(0), // 10000元素
        new Array(2**31 - 1), // 数组长度边界
      ],
      // 嵌套数组边界
      nested: [
        [[]],                 // 嵌套空数组
        [[[]]],               // 双层嵌套
        [[[[]]]],             // 三层嵌套
        [[[[[[]]]]]],         // 五层嵌套
        [[[[[[[[]]]]]]]],     // 七层嵌套（深度）
        [[1], [2], [3]],      // 嵌套多元素
        [Array(10).fill([Array(10).fill(0)])], // 复杂嵌套
      ],
      // 稀疏数组
      sparse: [
        new Array(10),        // 稀疏数组（无值）
        [,1,],                // 中间有洞
        [1,,,4],              // 多个洞
        Array(1000),          // 大稀疏数组
      ],
      // Pokemon 数组边界
      pokemon: [
        [],                   // 空（无精灵）
        [{id: 1}],            // 单精灵
        [{id: 1}, {id: 2}],   // 双精灵
        Array(100).fill({id: 1}), // 100精灵
        Array(1000).fill({id: 1}), // 1000精灵（上限）
        Array(1001).fill({id: 1}), // 超限
      ]
    };
  }

  /**
   * 定义对象边界
   */
  defineObjectBoundaries() {
    return {
      // 通用对象边界
      general: [
        {},                   // 空对象
        { key: null },        // 包含 null
        { key: undefined },   // 包含 undefined
        { key: NaN },         // 包含 NaN
        { key: '' },          // 空字符串值
        { '': 'value' },      // 空键名
        { 'key\0': 'value' }, // 键名包含 Null
        { prototype: 'value' }, // 特殊属性名
        { __proto__: {} },    // 原型污染尝试
        { constructor: 'value' }, // 特殊属性
        { [Symbol.iterator]: 'value' }, // Symbol 属性
        JSON.parse('{ "a": '.repeat(50) + '"value"' + '}'.repeat(50)), // 深嵌套
      ],
      // 键名边界
      keys: [
        '',                   // 空键
        ' ',                  // 空格键
        'key',                // 正常键
        'KEY',                // 大写键
        'key123',             // 带数字
        'key_name',           // 带下划线
        'key-name',           // 带连字符
        'key.name',           // 带点
        'key[0]',             // 带括号
        '$key',               // 带美元符号
        '_key',               // 带下划线开头
        '__proto__',          // 特殊键
        'prototype',          // 特殊键
        'constructor',        // 特殊键
        'hasOwnProperty',     // 内置方法名
        'toString',           // 内置方法名
        '\u0000',             // Null 键
        '\u202Ekey',          // RTL 键
      ],
      // 嵌套对象边界
      nested: [
        { a: { b: 1 } },      // 双层
        { a: { b: { c: 1 } } }, // 三层
        { a: { b: { c: { d: 1 } } } }, // 四层
        { a: { b: { c: { d: { e: 1 } } } } }, // 五层
        { a: { b: { c: { d: { e: { f: 1 } } } } } }, // 六层
        { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }, // 七层（深）
      ],
      // Pokemon 对象边界
      pokemon: [
        { id: 1, name: 'Pikachu', cp: 500 }, // 正常
        { id: 0 },            // ID 为零（非法）
        { id: -1 },           // ID 为负（非法）
        { id: 100000000 },    // ID 超大
        { id: null },         // ID 为 null
        { id: undefined },    // ID 为 undefined
        { id: '1' },          // ID 为字符串（非法）
        { id: 1, cp: -1 },    // CP 为负（非法）
        { id: 1, cp: 100000 }, // CP 超限
        { id: 1, level: 0 },  // Level 为零（非法）
        { id: 1, level: 101 }, // Level 超限
      ]
    };
  }

  /**
   * 定义日期边界
   */
  defineDateBoundaries() {
    return {
      // 时间戳边界
      timestamp: [
        0,                    // Unix 时间戳起点
        86400,                // 1天
        2147483647,           // 32位最大时间戳（2038年）
        253402300799,         // JavaScript Date 最大时间戳（9999年）
        -1,                   // 负时间戳（非法）
        -86400,               // 负时间戳（非法）
        Number.MAX_SAFE_INTEGER, // 超大时间戳
        null,                 // null
        undefined,            // undefined
        NaN,                  // NaN
      ],
      // 日期字符串边界
      dateString: [
        '2016-07-06',         // 游戏发布日
        '2026-01-01',         // 未来日期
        '2030-12-31',         // 远未来日期
        '1970-01-01',         // Unix 起点
        '1969-12-31',         // Unix 前一天（非法）
        '1900-01-01',         // 远历史日期
        '9999-12-31',         // 最大有效日期
        '10000-01-01',        // 无效日期
        'invalid',            // 非法格式
        '',                   // 空
        'null',               // 字符串 null
        '2026-13-01',         // 无效月份
        '2026-00-01',         // 无效月份
        '2026-01-00',         // 无效日期
        '2026-01-32',         // 无效日期
        '2026-02-30',         // 无效日期（二月最多29）
      ],
      // 时区边界
      timezone: [
        'UTC',                // UTC
        'Asia/Shanghai',      // 上海（+8）
        'America/New_York',   // 纽约（-5）
        'Europe/London',      // 伦敦（+0/+1）
        'Asia/Tokyo',         // 东京（+9）
        'Pacific/Auckland',   // 奥克兰（+12/+13）
        'Pacific/Kiritimati', // +14（最大）
        'Etc/GMT-14',         // -14（最小）
        'invalid',            // 非法时区
        '',                   // 空
        null,                 // null
      ]
    };
  }

  /**
   * 定义 Pokemon 边界
   */
  definePokemonBoundaries() {
    return {
      // ID 边界
      id: [
        1,                    // 最小有效 ID
        25,                   // Pikachu
        500,                  // 中等 ID
        1000,                 // 较大 ID
        10000,                // 最大 ID
        10001,                // 超限 ID
        0,                    // 零（非法）
        -1,                   // 负值（非法）
        null,                 // null
        undefined,            // undefined
        '1',                  // 字符串（非法）
      ],
      // CP 边界
      cp: [
        10,                   // 最小 CP
        500,                  // 中等 CP
        5000,                 // 较大 CP
        65535,                // 最大 CP
        65536,                // 超限 CP
        0,                    // 零（非法）
        -1,                   // 负值（非法）
        NaN,                  // NaN
        Infinity,             // 无穷（非法）
      ],
      // IV 边界
      iv: [
        { attack: 0, defense: 0, stamina: 0 },      // 最小 IV
        { attack: 15, defense: 15, stamina: 15 },  // 中等 IV
        { attack: 31, defense: 31, stamina: 31 },  // 完美 IV
        { attack: 32, defense: 31, stamina: 31 },  // 超限 IV
        { attack: -1, defense: 15, stamina: 15 },  // 负值 IV
        { attack: 31, defense: 31 },               // 缺少 stamina
        { attack: null, defense: 15, stamina: 15 }, // null IV
      ],
      // 等级边界
      level: [
        1,                    // 最小等级
        20,                   // 中等等级
        40,                   // 常见上限
        100,                  // 最大等级
        101,                  // 超限等级
        0,                    // 零（非法）
        -1,                   // 负值（非法）
        null,                 // null
        '50',                 // 字符串（非法）
      ]
    };
  }

  /**
   * 定义位置边界
   */
  defineLocationBoundaries() {
    return {
      // 纬度边界
      latitude: [
        0,                    //赤道
        39.9042,              // 北京
        35.6762,              // 东京
        40.7128,              // 纽约
        51.5074,              // 伦敦
        90,                   // 北极（最大）
        -90,                  // 南极（最小）
        90.0001,              // 超限（北）
        -90.0001,             // 超限（南）
        NaN,                  // NaN
        Infinity,             // 无穷（非法）
      ],
      // 经度边界
      longitude: [
        0,                    // 本初子午线
        116.4074,             // 北京
        139.6503,             // 东京
        -74.0060,             // 纽约
        -0.1278,              // 伦敦
        180,                  // 最大经度
        -180,                 // 最小经度
        180.0001,             // 超限（东）
        -180.0001,            // 超限（西）
        NaN,                  // NaN
        Infinity,             // 无穷（非法）
      ],
      // 距离边界
      distance: [
        0,                    // 相同点
        0.001,                // 1米
        100,                  // 100米
        1000,                 // 1公里
        10000,                // 10公里
        20015,                // 地球半周长
        40030,                // 地球周长
        -1,                   // 负值（非法）
        NaN,                  // NaN
        Infinity,             // 无穷（非法）
      ]
    };
  }

  /**
   * 自动探索函数的边界
   * @param {Function} fn - 要测试的函数
   * @param {string} inputType - 输入类型
   * @returns {Object} - 探索结果
   */
  autoExplore(fn, inputType) {
    const boundaries = this.getBoundaries(inputType);
    const results = [];

    for (const input of boundaries) {
      try {
        const result = fn(input);
        results.push({
          input: this.formatInput(input),
          result: this.formatResult(result),
          success: true,
          error: null
        });
      } catch (error) {
        results.push({
          input: this.formatInput(input),
          result: null,
          success: false,
          error: error.message,
          errorType: error.constructor.name
        });
      }
    }

    return {
      fn: fn.name || 'anonymous',
      inputType,
      totalTests: boundaries.length,
      passed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      passRate: (results.filter(r => r.success).length / boundaries.length * 100).toFixed(2),
      failures: results.filter(r => !r.success),
      results
    };
  }

  /**
   * 获取指定类型的边界值
   */
  getBoundaries(type) {
    const [category, subCategory] = type.split('.');
    if (!this.boundaries[category]) {
      return this.boundaries.numeric.general;
    }
    if (subCategory && this.boundaries[category][subCategory]) {
      return this.boundaries[category][subCategory];
    }
    if (this.boundaries[category].general) {
      return this.boundaries[category].general;
    }
    return Object.values(this.boundaries[category]).flat();
  }

  /**
   * 格式化输入值用于显示
   */
  formatInput(input) {
    if (typeof input === 'function') return '[Function]';
    if (typeof input === 'symbol') return input.toString();
    if (input === null) return 'null';
    if (input === undefined) return 'undefined';
    if (typeof input === 'object') {
      try {
        const json = JSON.stringify(input);
        return json.length > 100 ? json.substring(0, 100) + '...' : json;
      } catch {
        return '[Object]';
      }
    }
    return String(input);
  }

  /**
   * 格式化结果值用于显示
   */
  formatResult(result) {
    if (result === null) return 'null';
    if (result === undefined) return 'undefined';
    if (typeof result === 'object') {
      try {
        const json = JSON.stringify(result);
        return json.length > 100 ? json.substring(0, 100) + '...' : json;
      } catch {
        return '[Object]';
      }
    }
    return String(result);
  }

  /**
   * 探索所有边界类型
   */
  exploreAllBoundaries(fn) {
    const results = {};
    for (const category of Object.keys(this.boundaries)) {
      results[category] = this.autoExplore(fn, category);
    }
    return results;
  }
}

module.exports = { BoundaryExplorer };