// tests/unit/errorHandler.test.js
'use strict';

const assert = require('assert');
const { 
  AppError, 
  Errors, 
  getUserLanguage, 
  asyncHandler,
  fromError 
} = require('../../shared/errorHandler');
const { 
  getLocalizedErrorMessage, 
  interpolate,
  getSupportedLanguages,
  isLanguageSupported,
  getDefaultLanguage 
} = require('../../shared/errorMessages');
const { 
  getErrorDefinition, 
  getErrorCodeName,
  getAllErrorCodes 
} = require('../../shared/errorCodes');

// ── errorCodes.js 测试 ─────────────────────────────────────────────────────

console.log('Testing errorCodes.js...');

// 测试获取错误定义
const userNotFoundDef = getErrorDefinition('USER_NOT_FOUND');
assert.strictEqual(userNotFoundDef.code, 2001, 'USER_NOT_FOUND code should be 2001');
assert.strictEqual(userNotFoundDef.httpStatus, 404, 'USER_NOT_FOUND httpStatus should be 404');
assert.strictEqual(userNotFoundDef.category, 'user', 'USER_NOT_FOUND category should be user');

// 测试未知错误码回退
const unknownDef = getErrorDefinition('NON_EXISTENT_CODE');
assert.strictEqual(unknownDef.code, 1000, 'Unknown code should fallback to UNKNOWN_ERROR');

// 测试通过数字代码获取名称
const codeName = getErrorCodeName(2001);
assert.strictEqual(codeName, 'USER_NOT_FOUND', 'Code 2001 should map to USER_NOT_FOUND');

// 测试获取所有错误码
const allCodes = getAllErrorCodes();
assert.ok(allCodes.USER_NOT_FOUND, 'Should have USER_NOT_FOUND');
assert.ok(allCodes.PAYMENT_FAILED, 'Should have PAYMENT_FAILED');

console.log('✅ errorCodes.js tests passed');

// ── errorMessages.js 测试 ─────────────────────────────────────────────────────

console.log('Testing errorMessages.js...');

// 测试获取本地化消息
const zhMessage = getLocalizedErrorMessage('USER_NOT_FOUND', 'zh-CN');
assert.strictEqual(zhMessage, '用户不存在', 'Should return Chinese message');

const enMessage = getLocalizedErrorMessage('USER_NOT_FOUND', 'en-US');
assert.strictEqual(enMessage, 'User not found', 'Should return English message');

const jaMessage = getLocalizedErrorMessage('USER_NOT_FOUND', 'ja-JP');
assert.strictEqual(jaMessage, 'ユーザーが見つかりません', 'Should return Japanese message');

// 测试参数插值
const messageWithParams = getLocalizedErrorMessage('INSUFFICIENT_RESOURCES', 'zh-CN', {
  resource: '精币',
  required: 100,
  current: 50
});
assert.ok(messageWithParams.includes('精币'), 'Should include resource name');
assert.ok(messageWithParams.includes('100'), 'Should include required value');
assert.ok(messageWithParams.includes('50'), 'Should include current value');

// 测试插值函数
const interpolated = interpolate('Hello {name}, you have {count} messages', { 
  name: 'Alice', 
  count: 5 
});
assert.strictEqual(interpolated, 'Hello Alice, you have 5 messages', 'Should interpolate correctly');

// 测试语言支持检查
assert.ok(isLanguageSupported('zh-CN'), 'zh-CN should be supported');
assert.ok(isLanguageSupported('en-US'), 'en-US should be supported');
assert.ok(isLanguageSupported('ja-JP'), 'ja-JP should be supported');
assert.ok(!isLanguageSupported('fr-FR'), 'fr-FR should not be supported');

// 测试获取支持的语言列表
const languages = getSupportedLanguages();
assert.strictEqual(languages.length, 3, 'Should have 3 supported languages');
assert.ok(languages.includes('zh-CN'), 'Should include zh-CN');

// 测试默认语言
assert.strictEqual(getDefaultLanguage(), 'en-US', 'Default language should be en-US');

// 测试未知错误码回退
const fallbackMessage = getLocalizedErrorMessage('NON_EXISTENT', 'zh-CN');
assert.strictEqual(fallbackMessage, '发生未知错误', 'Should fallback to unknown error message');

// 测试不支持语言回退
const fallbackLangMessage = getLocalizedErrorMessage('USER_NOT_FOUND', 'fr-FR');
assert.strictEqual(fallbackLangMessage, 'User not found', 'Should fallback to default language');

console.log('✅ errorMessages.js tests passed');

// ── errorHandler.js 测试 ─────────────────────────────────────────────────────

console.log('Testing errorHandler.js...');

// 测试 AppError 创建
const appError = new AppError('USER_NOT_FOUND', { userId: '123' }, { extra: 'info' });
assert.strictEqual(appError.code, 'USER_NOT_FOUND', 'Error code should be set');
assert.strictEqual(appError.httpStatus, 404, 'HTTP status should be set');
assert.strictEqual(appError.numericCode, 2001, 'Numeric code should be set');
assert.strictEqual(appError.category, 'user', 'Category should be set');
assert.strictEqual(appError.params.userId, '123', 'Params should be set');
assert.strictEqual(appError.details.extra, 'info', 'Details should be set');

// 测试 AppError.toJSON
const json = appError.toJSON('zh-CN');
assert.strictEqual(json.success, false, 'success should be false');
assert.strictEqual(json.error.code, 2001, 'error.code should be numeric code');
assert.strictEqual(json.error.message, '用户不存在', 'error.message should be localized');

// 测试预定义错误工厂
const notFoundError = Errors.notFound({ resource: 'Pokemon' });
assert.strictEqual(notFoundError.code, 'NOT_FOUND', 'Should create NOT_FOUND error');

const unauthorizedError = Errors.unauthorized();
assert.strictEqual(unauthorizedError.code, 'UNAUTHORIZED', 'Should create UNAUTHORIZED error');

const paymentError = Errors.paymentFailed({ reason: 'Card declined' });
assert.strictEqual(paymentError.code, 'PAYMENT_FAILED', 'Should create PAYMENT_FAILED error');

// 测试 withParams
const errorWithParams = appError.withParams({ extraParam: 'value' });
assert.strictEqual(errorWithParams.params.userId, '123', 'Should preserve original params');
assert.strictEqual(errorWithParams.params.extraParam, 'value', 'Should add new params');

// 测试 withDetails
const errorWithDetails = appError.withDetails({ more: 'details' });
assert.strictEqual(errorWithDetails.details.more, 'details', 'Should update details');

// 测试 fromError
const nativeError = new Error('Native error');
const appErrorFromNative = fromError(nativeError, 'INTERNAL_ERROR');
assert.strictEqual(appErrorFromNative.code, 'INTERNAL_ERROR', 'Should create AppError from native error');
assert.ok(appErrorFromNative.details.originalError, 'Should include original error message');

// 测试 fromError with AppError
const existingAppError = new AppError('USER_NOT_FOUND');
const sameError = fromError(existingAppError);
assert.strictEqual(sameError, existingAppError, 'Should return same AppError instance');

// 测试 getUserLanguage
const mockReq = {
  headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  user: null,
  query: {}
};
const lang = getUserLanguage(mockReq);
assert.strictEqual(lang, 'zh-CN', 'Should parse Accept-Language header');

// 测试用户偏好优先
const mockReqWithUser = {
  headers: { 'accept-language': 'en-US' },
  user: { language: 'ja-JP' },
  query: {}
};
const userLang = getUserLanguage(mockReqWithUser);
assert.strictEqual(userLang, 'ja-JP', 'User language preference should take priority');

// 测试查询参数优先（用于测试）
const mockReqWithQuery = {
  headers: { 'accept-language': 'en-US' },
  user: { language: 'ja-JP' },
  query: { lang: 'zh-CN' }
};
const queryLang = getUserLanguage(mockReqWithQuery);
assert.strictEqual(queryLang, 'zh-CN', 'Query lang should take highest priority');

// 测试默认语言回退
const mockReqNoLang = {
  headers: {},
  user: null,
  query: {}
};
const defaultLang = getUserLanguage(mockReqNoLang);
assert.strictEqual(defaultLang, 'en-US', 'Should fallback to default language');

console.log('✅ errorHandler.js tests passed');

// ── 错误码覆盖测试 ─────────────────────────────────────────────────────

console.log('Testing error code coverage...');

// 测试所有错误码都有对应的翻译
const allErrorCodes = Object.keys(getAllErrorCodes());
let missingTranslations = [];

for (const code of allErrorCodes) {
  const zh = getLocalizedErrorMessage(code, 'zh-CN');
  const en = getLocalizedErrorMessage(code, 'en-US');
  const ja = getLocalizedErrorMessage(code, 'ja-JP');
  
  // 检查是否有回退到 UNKNOWN_ERROR 的情况
  if (zh === '发生未知错误' && code !== 'UNKNOWN_ERROR') {
    missingTranslations.push(code);
  }
}

if (missingTranslations.length > 0) {
  console.log(`⚠️  Missing translations for: ${missingTranslations.join(', ')}`);
} else {
  console.log('✅ All error codes have translations');
}

// ── 总结 ─────────────────────────────────────────────────────────────

console.log('\n========================================');
console.log('All errorHandler tests passed! ✅');
console.log('========================================\n');

// 统计
console.log('Test Summary:');
console.log(`- Error codes defined: ${allErrorCodes.length}`);
console.log(`- Supported languages: ${getSupportedLanguages().join(', ')}`);
console.log(`- Default language: ${getDefaultLanguage()}`);
