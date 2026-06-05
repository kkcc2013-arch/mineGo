// backend/tests/unit/i18n.test.js
// Unit tests for i18n module
'use strict';

const assert = require('assert');
const {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  translate,
  parseAcceptLanguage,
  isValidLanguage,
  errorMessages
} = require('../../shared/i18n');

console.log('🧪 Running i18n unit tests...\n');

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

// ── Tests ────────────────────────────────────────────────────────

test('SUPPORTED_LANGUAGES should contain expected languages', () => {
  assert.deepStrictEqual(SUPPORTED_LANGUAGES, ['zh-CN', 'en-US', 'ja-JP']);
});

test('DEFAULT_LANGUAGE should be zh-CN', () => {
  assert.strictEqual(DEFAULT_LANGUAGE, 'zh-CN');
});

test('translate should return Chinese message for zh-CN', () => {
  const msg = translate('AUTH_TOKEN_EXPIRED', 'zh-CN');
  assert.strictEqual(msg, '登录已过期，请重新登录');
});

test('translate should return English message for en-US', () => {
  const msg = translate('AUTH_TOKEN_EXPIRED', 'en-US');
  assert.strictEqual(msg, 'Session expired, please login again');
});

test('translate should return Japanese message for ja-JP', () => {
  const msg = translate('AUTH_TOKEN_EXPIRED', 'ja-JP');
  assert.strictEqual(msg, 'ログインの有効期限が切れました');
});

test('translate should fallback to default language for unknown key', () => {
  const msg = translate('UNKNOWN_KEY', 'zh-CN');
  assert.strictEqual(msg, 'UNKNOWN_KEY');
});

test('translate should fallback to default language for unsupported language', () => {
  const msg = translate('AUTH_TOKEN_EXPIRED', 'fr-FR');
  assert.strictEqual(msg, '登录已过期，请重新登录'); // Falls back to zh-CN
});

test('parseAcceptLanguage should parse exact match', () => {
  const lang = parseAcceptLanguage('en-US');
  assert.strictEqual(lang, 'en-US');
});

test('parseAcceptLanguage should parse partial match (en)', () => {
  const lang = parseAcceptLanguage('en');
  assert.strictEqual(lang, 'en-US');
});

test('parseAcceptLanguage should parse partial match (zh)', () => {
  const lang = parseAcceptLanguage('zh');
  assert.strictEqual(lang, 'zh-CN');
});

test('parseAcceptLanguage should parse partial match (ja)', () => {
  const lang = parseAcceptLanguage('ja');
  assert.strictEqual(lang, 'ja-JP');
});

test('parseAcceptLanguage should handle complex header', () => {
  const lang = parseAcceptLanguage('en-US,en;q=0.9,zh-CN;q=0.8');
  assert.strictEqual(lang, 'en-US');
});

test('parseAcceptLanguage should return default for empty header', () => {
  const lang = parseAcceptLanguage('');
  assert.strictEqual(lang, DEFAULT_LANGUAGE);
});

test('parseAcceptLanguage should return default for null header', () => {
  const lang = parseAcceptLanguage(null);
  assert.strictEqual(lang, DEFAULT_LANGUAGE);
});

test('isValidLanguage should return true for supported languages', () => {
  assert.strictEqual(isValidLanguage('zh-CN'), true);
  assert.strictEqual(isValidLanguage('en-US'), true);
  assert.strictEqual(isValidLanguage('ja-JP'), true);
});

test('isValidLanguage should return false for unsupported languages', () => {
  assert.strictEqual(isValidLanguage('fr-FR'), false);
  assert.strictEqual(isValidLanguage('ko-KR'), false);
  assert.strictEqual(isValidLanguage(''), false);
});

test('errorMessages should have all supported languages', () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    assert(errorMessages[lang], `Missing error messages for ${lang}`);
  }
});

test('errorMessages should have consistent keys across languages', () => {
  const baseKeys = Object.keys(errorMessages['zh-CN']).sort();
  for (const lang of ['en-US', 'ja-JP']) {
    const langKeys = Object.keys(errorMessages[lang]).sort();
    assert.deepStrictEqual(langKeys, baseKeys, `Key mismatch for ${lang}`);
  }
});

// ── Summary ──────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
