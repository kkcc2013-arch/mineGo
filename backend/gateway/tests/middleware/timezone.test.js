/**
 * 时区中间件测试 - REQ-00612
 */

'use strict';

const assert = require('assert');
const { 
  timezoneMiddleware, 
  utcResponseMiddleware, 
  updateTimezoneConfig,
  getTimezoneConfig,
  TimezoneUtils 
} = require('../../src/middleware/timezone');

// 模拟请求和响应对象
function createMockReqRes(headers = {}) {
  const req = {
    headers: headers,
    query: {},
    path: '/test'
  };
  const res = {
    headers: {},
    setHeader: function(key, value) {
      this.headers[key] = value;
    },
    json: function(data) {
      this._jsonData = data;
      return this;
    }
  };
  return { req, res };
}

// 测试套件
async function runTests() {
  console.log('=== 时区中间件测试 ===\n');

  // 测试 1: 默认时区
  console.log('测试 1: 默认时区');
  {
    const { req, res } = createMockReqRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    timezoneMiddleware(req, res, next);

    assert.strictEqual(req.userTimezone, 'UTC', '默认时区应为 UTC');
    assert.strictEqual(nextCalled, true, 'next 应该被调用');
    console.log('✓ 通过\n');
  }

  // 测试 2: 从请求头获取时区
  console.log('测试 2: 从请求头获取时区');
  {
    const { req, res } = createMockReqRes({ 'time-zone': 'Asia/Shanghai' });
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    timezoneMiddleware(req, res, next);

    assert.strictEqual(req.userTimezone, 'Asia/Shanghai', '应从请求头获取时区');
    assert.ok(req.timezoneOffset !== undefined, '应设置时区偏移');
    console.log('✓ 通过\n');
  }

  // 测试 3: 不支持的时区
  console.log('测试 3: 不支持的时区');
  {
    const { req, res } = createMockReqRes({ 'time-zone': 'Invalid/Timezone' });
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    timezoneMiddleware(req, res, next);

    assert.strictEqual(req.userTimezone, 'UTC', '无效时区应回退到 UTC');
    console.log('✓ 通过\n');
  }

  // 测试 4: 时区配置热更新
  console.log('测试 4: 时区配置热更新');
  {
    const originalConfig = getTimezoneConfig();
    
    updateTimezoneConfig({
      defaultTimezone: 'Asia/Tokyo',
      supportedTimezones: ['UTC', 'Asia/Tokyo']
    });

    const newConfig = getTimezoneConfig();
    assert.strictEqual(newConfig.defaultTimezone, 'Asia/Tokyo', '默认时区应更新');
    assert.ok(newConfig.supportedTimezones.includes('Asia/Tokyo'), '支持时区列表应更新');

    // 恢复原始配置
    updateTimezoneConfig({
      defaultTimezone: originalConfig.defaultTimezone,
      supportedTimezones: originalConfig.supportedTimezones
    });

    console.log('✓ 通过\n');
  }

  // 测试 5: UTC 响应转换
  console.log('测试 5: UTC 响应转换');
  {
    const { req, res } = createMockReqRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    utcResponseMiddleware(req, res, next);

    const testData = {
      createdAt: new Date('2026-07-20T16:00:00Z'),
      updatedAt: 1721488800000,
      startTime: '2026-07-20T08:00:00-08:00'
    };

    res.json(testData);
    const jsonResult = res._jsonData;

    assert.ok(jsonResult.createdAt instanceof Date || typeof jsonResult.createdAt === 'string', 'createdAt 应该是 Date 或 string');
    assert.ok(jsonResult.updatedAt.endsWith('Z'), '时间戳应转换为 UTC');
    assert.ok(jsonResult.startTime.endsWith('Z'), '时间字符串应转换为 UTC');
    console.log('✓ 通过\n');
  }

  // 测试 6: TimezoneUtils 工具函数
  console.log('测试 6: TimezoneUtils 工具函数');
  {
    const utcTime = '2026-07-20T16:00:00Z';
    
    // 测试 UTC 转本地时间
    const localTime = TimezoneUtils.utcToLocal(utcTime, 'Asia/Shanghai');
    assert.ok(localTime.includes('T'), '应返回 ISO 格式时间');
    
    // 测试时区偏移
    const offset = TimezoneUtils.getOffset('Asia/Shanghai');
    assert.strictEqual(offset, 28800, '上海时区偏移应为 28800 秒（+8 小时）');
    
    // 测试时区验证
    assert.strictEqual(TimezoneUtils.isValidTimezone('Asia/Shanghai'), true, '有效时区应返回 true');
    assert.strictEqual(TimezoneUtils.isValidTimezone('Invalid/Timezone'), false, '无效时区应返回 false');
    
    // 测试格式化时间
    const formatted = TimezoneUtils.formatTime(utcTime, 'Asia/Shanghai', 'YYYY-MM-DD HH:mm:ss');
    assert.ok(formatted.includes('2026-07-21'), '应显示正确的本地日期');
    
    console.log('✓ 通过\n');
  }

  // 测试 7: 多种请求头格式
  console.log('测试 7: 多种请求头格式');
  {
    // Time-Zone 头
    let { req, res } = createMockReqRes({ 'time-zone': 'America/New_York' });
    timezoneMiddleware(req, res, () => {});
    assert.strictEqual(req.userTimezone, 'America/New_York');

    // X-Timezone 头
    ({ req, res } = createMockReqRes({ 'x-timezone': 'Europe/London' }));
    timezoneMiddleware(req, res, () => {});
    assert.strictEqual(req.userTimezone, 'Europe/London');

    // 查询参数
    ({ req, res } = createMockReqRes());
    req.query.timezone = 'Asia/Tokyo';
    timezoneMiddleware(req, res, () => {});
    assert.strictEqual(req.userTimezone, 'Asia/Tokyo');

    console.log('✓ 通过\n');
  }

  // 测试 8: 时间字段识别
  console.log('测试 8: 时间字段识别');
  {
    const { req, res } = createMockReqRes();
    utcResponseMiddleware(req, res, () => {});

    const testData = {
      created_at: new Date(),
      updated_at: 1721488800000,
      start_time: '2026-07-20T16:00:00Z',
      end_time: '2026-07-21T00:00:00Z',
      expiresAt: new Date(),
      nonTimeField: 'regular string',
      count: 42
    };

    res.json(testData);
    const jsonResult = res._jsonData;

    assert.ok(jsonResult.created_at instanceof Date || typeof jsonResult.created_at === 'string');
    assert.ok(jsonResult.updated_at.endsWith('Z'));
    assert.ok(jsonResult.start_time.endsWith('Z'));
    assert.ok(jsonResult.end_time.endsWith('Z'));
    assert.strictEqual(jsonResult.nonTimeField, 'regular string');
    assert.strictEqual(jsonResult.count, 42);
    
    console.log('✓ 通过\n');
  }

  console.log('=== 所有测试通过 ===\n');
  console.log('测试总结:');
  console.log('✓ 默认时区设置');
  console.log('✓ 从请求头获取时区');
  console.log('✓ 无效时区处理');
  console.log('✓ 配置热更新');
  console.log('✓ UTC 响应转换');
  console.log('✓ TimezoneUtils 工具函数');
  console.log('✓ 多种请求头格式支持');
  console.log('✓ 时间字段识别与转换');
}

// 运行测试
runTests().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
