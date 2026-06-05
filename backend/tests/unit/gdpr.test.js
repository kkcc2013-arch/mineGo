/**
 * REQ-00016: 单元测试 - GDPR 功能
 */

const assert = require('assert');
const DataMasking = require('../shared/dataMasking');
const { DataEncryption } = require('../shared/dataEncryption');

console.log('=== GDPR Unit Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
    failed++;
  }
}

// ===== 数据脱敏测试 =====
console.log('\n--- Data Masking Tests ---\n');

test('maskEmail: should mask email correctly', () => {
  assert.strictEqual(DataMasking.email('user@example.com'), 'u***@example.com');
  assert.strictEqual(DataMasking.email('john.doe@test.org'), 'j***@test.org');
  assert.strictEqual(DataMasking.email('a@b.com'), 'a***@b.com');
});

test('maskPhone: should mask phone correctly', () => {
  assert.strictEqual(DataMasking.phone('13812345678'), '138****5678');
  assert.strictEqual(DataMasking.phone('18611112222'), '186****2222');
});

test('maskPaymentMethod: should mask payment method', () => {
  assert.strictEqual(DataMasking.paymentMethod('1234567890123456'), '****3456');
  assert.strictEqual(DataMasking.paymentMethod('4111111111111111'), '****1111');
});

test('maskLocation: should reduce precision', () => {
  const result = DataMasking.location(31.230416, 121.473701, 3);
  assert.strictEqual(result.lat, 31.23);
  assert.strictEqual(result.lng, 121.474);
});

test('maskUsername: should mask username', () => {
  assert.strictEqual(DataMasking.username('john_doe'), 'joh***');
  assert.strictEqual(DataMasking.username('ab'), 'ab***');
});

test('maskIP: should mask IP address', () => {
  assert.strictEqual(DataMasking.ip('192.168.1.100'), '192.168.*.*');
  assert.strictEqual(DataMasking.ip('10.0.0.1'), '10.0.*.*');
});

test('maskObject: should mask object fields', () => {
  const obj = {
    email: 'user@example.com',
    phone: '13812345678',
    username: 'john'
  };
  const masked = DataMasking.object(obj, {
    email: 'email',
    phone: 'phone',
    username: 'username'
  });
  
  assert.strictEqual(masked.email, 'u***@example.com');
  assert.strictEqual(masked.phone, '138****5678');
  assert.strictEqual(masked.username, 'joh***');
});

// ===== 数据加密测试 =====
console.log('\n--- Data Encryption Tests ---\n');

test('encrypt/decrypt: should encrypt and decrypt text correctly', () => {
  // 使用测试密钥
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const encryption = new DataEncryption();
  
  const original = 'Hello, World!';
  const encrypted = encryption.encrypt(original);
  
  assert.ok(encrypted.encrypted);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.authTag);
  assert.notStrictEqual(encrypted.encrypted, original);
  
  const decrypted = encryption.decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  assert.strictEqual(decrypted, original);
});

test('encryptObject/decryptObject: should encrypt and decrypt object', () => {
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const encryption = new DataEncryption();
  
  const original = { lat: 31.230416, lng: 121.473701 };
  const encrypted = encryption.encryptObject(original);
  
  const decrypted = encryption.decryptObject(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  assert.deepStrictEqual(decrypted, original);
});

test('encryptLocation/decryptLocation: should encrypt and decrypt location', () => {
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const encryption = new DataEncryption();
  
  const encrypted = encryption.encryptLocation(31.230416, 121.473701);
  
  assert.ok(encrypted.encrypted);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.authTag);
  
  const decrypted = encryption.decryptLocation(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  assert.ok(typeof decrypted.lat === 'number');
  assert.ok(typeof decrypted.lng === 'number');
  assert.ok(typeof decrypted.timestamp === 'number');
});

test('decrypt: should throw on invalid data', () => {
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const encryption = new DataEncryption();
  
  assert.throws(() => {
    encryption.decrypt('invalid', 'invalid', 'invalid');
  }, /decryption failed/i);
});

// ===== 边界条件测试 =====
console.log('\n--- Edge Case Tests ---\n');

test('maskEmail: should handle null/undefined', () => {
  assert.strictEqual(DataMasking.email(null), null);
  assert.strictEqual(DataMasking.email(undefined), undefined);
  assert.strictEqual(DataMasking.email(''), '');
});

test('maskPhone: should handle null/undefined', () => {
  assert.strictEqual(DataMasking.phone(null), null);
  assert.strictEqual(DataMasking.phone(undefined), undefined);
});

test('maskLocation: should handle null/undefined', () => {
  const result = DataMasking.location(null, null);
  assert.strictEqual(result.lat, null);
  assert.strictEqual(result.lng, null);
});

// ===== 结果统计 =====
console.log('\n=== Test Summary ===\n');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`\n${failed === 0 ? '✅ All tests passed!' : '❌ Some tests failed!'}`);

process.exit(failed === 0 ? 0 : 1);
