/**
 * KeyVault Tests - 密钥加密存储模块测试
 */

'use strict';

const assert = require('assert');
const { KeyVault, getKeyVault } = require('../shared/kms/KeyVault');

describe('KeyVault', function() {
  describe('constructor', function() {
    it('should create instance with environment variable', function() {
      const originalEnv = process.env.MASTER_KEY;
      process.env.MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      
      const vault = new KeyVault();
      assert.ok(vault);
      assert.strictEqual(vault.algorithm, 'aes-256-gcm');
      
      process.env.MASTER_KEY = originalEnv;
    });

    it('should throw error if master key is wrong length', function() {
      const originalEnv = process.env.MASTER_KEY;
      process.env.MASTER_KEY = 'short';
      
      assert.throws(() => {
        new KeyVault();
      }, /must be 32 bytes/);
      
      process.env.MASTER_KEY = originalEnv;
    });
  });

  describe('encrypt and decrypt', function() {
    let vault;

    before(function() {
      const testKey = 'a'.repeat(64); // 32 bytes hex
      vault = new KeyVault({ masterKey: testKey });
    });

    it('should encrypt plaintext', function() {
      const plaintext = 'my-secret-key-12345';
      const encrypted = vault.encrypt(plaintext);
      
      assert.ok(encrypted.encrypted_value);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.tag);
      assert.strictEqual(encrypted.algorithm, 'aes-256-gcm');
      assert.notStrictEqual(encrypted.encrypted_value, plaintext);
    });

    it('should decrypt ciphertext correctly', function() {
      const plaintext = 'my-secret-key-12345';
      const encrypted = vault.encrypt(plaintext);
      const decrypted = vault.decrypt(encrypted.encrypted_value, encrypted.iv, encrypted.tag);
      
      assert.strictEqual(decrypted, plaintext);
    });

    it('should throw error for empty plaintext', function() {
      assert.throws(() => {
        vault.encrypt('');
      }, /must be a non-empty string/);
    });

    it('should throw error for missing decryption parameters', function() {
      assert.throws(() => {
        vault.decrypt('', 'iv', 'tag');
      }, /Missing required/);
    });
  });

  describe('generateKey', function() {
    let vault;

    before(function() {
      const testKey = 'a'.repeat(64);
      vault = new KeyVault({ masterKey: testKey });
    });

    it('should generate jwt_secret', function() {
      const key = vault.generateKey('jwt_secret');
      assert.strictEqual(key.length, 128); // 64 bytes hex
    });

    it('should generate api_key', function() {
      const key = vault.generateKey('api_key');
      assert.strictEqual(key.length, 64); // 32 bytes hex
    });

    it('should generate db_password', function() {
      const key = vault.generateKey('db_password', 32);
      assert.ok(key.length >= 32);
      // Should contain different character types
      assert.ok(/[a-z]/.test(key));
      assert.ok(/[A-Z]/.test(key));
      assert.ok(/[0-9]/.test(key));
    });

    it('should generate unknown type with default length', function() {
      const key = vault.generateKey('unknown_type', 16);
      assert.strictEqual(key.length, 32); // 16 bytes hex
    });
  });

  describe('validateMasterKey', function() {
    it('should return true for valid master key', function() {
      const testKey = 'a'.repeat(64);
      const vault = new KeyVault({ masterKey: testKey });
      
      assert.strictEqual(vault.validateMasterKey(), true);
    });
  });

  describe('rotateMasterKey', function() {
    it('should re-encrypt keys with new master key', function() {
      const oldKey = 'a'.repeat(64);
      const newKey = 'b'.repeat(64);
      
      const oldVault = new KeyVault({ masterKey: oldKey });
      
      // Encrypt some keys
      const keys = [
        oldVault.encrypt('key1'),
        oldVault.encrypt('key2'),
        oldVault.encrypt('key3')
      ];
      
      // Rotate master key
      const reEncrypted = oldVault.rotateMasterKey(newKey, keys);
      
      // New vault should be able to decrypt
      const newVault = new KeyVault({ masterKey: newKey });
      
      assert.strictEqual(newVault.decrypt(reEncrypted[0].encrypted_value, reEncrypted[0].iv, reEncrypted[0].tag), 'key1');
      assert.strictEqual(newVault.decrypt(reEncrypted[1].encrypted_value, reEncrypted[1].iv, reEncrypted[1].tag), 'key2');
      assert.strictEqual(newVault.decrypt(reEncrypted[2].encrypted_value, reEncrypted[2].iv, reEncrypted[2].tag), 'key3');
    });
  });
});

describe('getKeyVault singleton', function() {
  it('should return the same instance', function() {
    const instance1 = getKeyVault();
    const instance2 = getKeyVault();
    
    assert.strictEqual(instance1, instance2);
  });
});
