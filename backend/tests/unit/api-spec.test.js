// backend/tests/unit/api-spec.test.js
// OpenAPI 规范与统一错误码测试
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');
const { ERROR_CODES, getErrorInfo, isValidErrorCode, getErrorCodesByRange } = require('../../shared/errors');
const { successResp, errorResp, paginatedResp } = require('../../shared/response');

console.log('📋 测试 OpenAPI 规范与统一错误码\n');

// ── 测试错误码注册表 ─────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
    failed++;
  }
}

// 测试 1: 错误码存在且格式正确
test('错误码总数应大于 50', () => {
  const count = Object.keys(ERROR_CODES).length;
  assert(count >= 50, `错误码数量为 ${count}，应至少 50 个`);
});

// 测试 2: 每个错误码包含必需字段
test('每个错误码包含 message 和 httpStatus', () => {
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    assert(info.message, `错误码 ${code} 缺少 message`);
    assert(typeof info.httpStatus === 'number', `错误码 ${code} 的 httpStatus 应为数字`);
    assert(info.httpStatus >= 400 && info.httpStatus < 600, `错误码 ${code} 的 httpStatus 应为 4xx 或 5xx`);
  }
});

// 测试 3: getErrorInfo 函数
test('getErrorInfo 返回正确的错误信息', () => {
  const info = getErrorInfo(1001);
  assert.strictEqual(info.message, '参数错误');
  assert.strictEqual(info.httpStatus, 400);
  
  const unknown = getErrorInfo(99999);
  assert.strictEqual(unknown.message, '未知错误');
  assert.strictEqual(unknown.httpStatus, 500);
});

// 测试 4: isValidErrorCode 函数
test('isValidErrorCode 正确判断错误码是否存在', () => {
  assert.strictEqual(isValidErrorCode(1001), true);
  assert.strictEqual(isValidErrorCode(2001), true);
  assert.strictEqual(isValidErrorCode(99999), false);
});

// 测试 5: getErrorCodesByRange 函数
test('getErrorCodesByRange 按范围获取错误码', () => {
  const userErrors = getErrorCodesByRange(2000, 2999);
  assert(Object.keys(userErrors).length > 0, '应有用户相关错误码');
  
  for (const code of Object.keys(userErrors)) {
    const codeNum = parseInt(code);
    assert(codeNum >= 2000 && codeNum <= 2999, `错误码 ${code} 不在范围内`);
  }
});

// 测试 6: 错误码范围正确
test('错误码按类别分配正确', () => {
  const ranges = [
    { start: 1000, end: 1999, name: '通用错误' },
    { start: 2000, end: 2999, name: '用户相关' },
    { start: 3000, end: 3999, name: '精灵/捕捉' },
    { start: 4000, end: 4999, name: '道馆/社交' },
    { start: 5000, end: 5999, name: '支付' },
    { start: 9000, end: 9999, name: '系统错误' },
  ];
  
  for (const range of ranges) {
    const codes = getErrorCodesByRange(range.start, range.end);
    assert(Object.keys(codes).length > 0, `${range.name} 应有错误码`);
  }
});

// ── 测试统一响应格式 ─────────────────────────────────────
test('successResp 返回正确格式', () => {
  const resp = successResp({ id: '123' }, '操作成功', 'trace-123');
  assert.deepStrictEqual(resp, {
    code: 0,
    message: '操作成功',
    data: { id: '123' },
    traceId: 'trace-123',
  });
});

test('errorResp 返回正确格式', () => {
  const resp = errorResp(1001, '参数错误', null, 'trace-123');
  assert.deepStrictEqual(resp, {
    code: 1001,
    message: '参数错误',
    data: null,
    traceId: 'trace-123',
  });
});

test('paginatedResp 返回正确的分页格式', () => {
  const items = [{ id: '1' }, { id: '2' }];
  const resp = paginatedResp(items, 1, 20, 100, 'trace-123');
  
  assert.strictEqual(resp.code, 0);
  assert.strictEqual(resp.message, '成功');
  assert.strictEqual(resp.data.items.length, 2);
  assert.strictEqual(resp.data.pagination.page, 1);
  assert.strictEqual(resp.data.pagination.pageSize, 20);
  assert.strictEqual(resp.data.pagination.total, 100);
  assert.strictEqual(resp.data.pagination.totalPages, 5);
  assert.strictEqual(resp.traceId, 'trace-123');
});

// ── 测试 OpenAPI 规范文件 ─────────────────────────────────
test('OpenAPI bundled.yaml 文件存在', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  assert(fs.existsSync(bundledPath), 'bundled.yaml 应存在');
});

test('OpenAPI 规范符合 3.0.3 标准', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert.strictEqual(spec.openapi, '3.0.3', 'OpenAPI 版本应为 3.0.3');
  assert(spec.info, '应有 info 字段');
  assert(spec.info.title, '应有 info.title');
  assert(spec.info.version, '应有 info.version');
});

test('OpenAPI 规范包含必需的组件', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert(spec.components, '应有 components 字段');
  assert(spec.components.securitySchemes, '应有 securitySchemes');
  assert(spec.components.securitySchemes.bearerAuth, '应有 bearerAuth 认证方案');
  assert(spec.components.schemas, '应有 schemas');
  assert(spec.components.schemas.Success, '应有 Success schema');
  assert(spec.components.schemas.Error, '应有 Error schema');
});

test('OpenAPI 规范包含认证接口', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert(spec.paths, '应有 paths 字段');
  assert(spec.paths['/auth/sms-code'], '应有 /auth/sms-code 路径');
  assert(spec.paths['/auth/register'], '应有 /auth/register 路径');
  assert(spec.paths['/auth/login'], '应有 /auth/login 路径');
  assert(spec.paths['/auth/refresh'], '应有 /auth/refresh 路径');
});

test('OpenAPI 规范包含用户接口', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert(spec.paths['/users/{userId}'], '应有 /users/{userId} 路径');
  assert(spec.paths['/users/me'], '应有 /users/me 路径');
});

test('OpenAPI 规范包含捕捉接口', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert(spec.paths['/map/nearby'], '应有 /map/nearby 路径');
  assert(spec.paths['/catch/start'], '应有 /catch/start 路径');
  assert(spec.paths['/catch/throw'], '应有 /catch/throw 路径');
});

test('OpenAPI 规范包含支付接口', () => {
  const bundledPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const spec = YAML.load(bundledPath);
  
  assert(spec.paths['/payment/products'], '应有 /payment/products 路径');
  assert(spec.paths['/payment/orders'], '应有 /payment/orders 路径');
});

// ── 测试 API 设计规范文档 ─────────────────────────────────
test('API 设计规范文档存在', () => {
  const docPath = path.join(__dirname, '../../../docs/api-spec/API-DESIGN-GUIDELINES.md');
  assert(fs.existsSync(docPath), 'API-DESIGN-GUIDELINES.md 应存在');
});

test('错误码参考文档存在', () => {
  const docPath = path.join(__dirname, '../../../docs/api-spec/error-codes.md');
  assert(fs.existsSync(docPath), 'error-codes.md 应存在');
});

// ── 输出测试结果 ─────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`测试完成: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
