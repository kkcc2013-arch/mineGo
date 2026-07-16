/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * 加密引擎单元测试
 */

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { EncryptionEngine, createEncryptionEngine } = require('../../backend/shared/crypto/EncryptionEngine');

describe('EncryptionEngine', function () {
  let engine;
  const masterKey = crypto.randomBytes(32).toString('base64');

  before(function () {
    engine = createEncryptionEngine({ masterKey });
  });

  describe('encrypt/decrypt', function () {
    it('should encrypt and decrypt string correctly', async function () {
      const plaintext = 'test-phone-+8613800138000';
      const context = 'users.phone';

      const encrypted = await engine.encrypt(plaintext, context);
      expect(encrypted).to.be.a('string');
      expect(encrypted).to.not.equal(plaintext);

      const decrypted = await engine.decrypt(encrypted, context);
      expect(decrypted).to.equal(plaintext);
    });

    it('should produce different ciphertext each time for non-deterministic encryption', async function () {
      const plaintext = 'test-email@example.com';
      const context = 'users.email';

      const encrypted1 = await engine.encryptRandom(plaintext, context);
      const encrypted2 = await engine.encryptRandom(plaintext, context);

      expect(encrypted1).to.not.equal(encrypted2);
    });

    it('should produce same ciphertext for deterministic encryption', async function () {
      const plaintext = 'test-email@example.com';
      const context = 'users.email';

      const encrypted1 = await engine.encryptDeterministic(plaintext, context);
      const encrypted2 = await engine.encryptDeterministic(plaintext, context);

      expect(encrypted1).to.equal(encrypted2);
    });

    it('should handle null values', async function () {
      const encrypted = await engine.encrypt(null, 'test.context');
      expect(encrypted).to.be.null;

      const decrypted = await engine.decrypt(null, 'test.context');
      expect(decrypted).to.be.null;
    });

    it('should handle empty strings', async function () {
      const encrypted = await engine.encrypt('', 'test.context');
      expect(encrypted).to.equal('');

      const decrypted = await engine.decrypt('', 'test.context');
      expect(decrypted).to.equal('');
    });

    it('should fail decryption with wrong context', async function () {
      const plaintext = 'secret-data';
      const encrypted = await engine.encrypt(plaintext, 'context1');

      try {
        await engine.decrypt(encrypted, 'context2');
        throw new Error('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('Decryption failed');
      }
    });

    it('should fail decryption with tampered ciphertext', async function () {
      const plaintext = 'secret-data';
      const encrypted = await engine.encrypt(plaintext, 'test.context');
      
      // 篡改密文
      const tampered = encrypted.slice(0, -5) + 'XXXXX';

      try {
        await engine.decrypt(tampered, 'test.context');
        throw new Error('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('Decryption failed');
      }
    });
  });

  describe('generateBlindIndex', function () {
    it('should generate consistent blind index', async function () {
      const plaintext = 'test-search-term';
      const context = 'users.phone_index';

      const index1 = await engine.generateBlindIndex(plaintext, context);
      const index2 = await engine.generateBlindIndex(plaintext, context);

      expect(index1).to.equal(index2);
      expect(index1).to.match(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should generate different indexes for different inputs', async function () {
      const index1 = await engine.generateBlindIndex('term1', 'test.context');
      const index2 = await engine.generateBlindIndex('term2', 'test.context');

      expect(index1).to.not.equal(index2);
    });
  });

  describe('encryptBatch/decryptBatch', function () {
    it('should encrypt and decrypt multiple items', async function () {
      const items = [
        { value: 'data1', context: 'test.context1' },
        { value: 'data2', context: 'test.context2' },
        { value: 'data3', context: 'test.context3' }
      ];

      const encrypted = await engine.encryptBatch(items);
      expect(encrypted).to.have.length(3);
      expect(encrypted[0]).to.not.equal('data1');

      const decrypted = await engine.decryptBatch(
        encrypted.map((e, i) => ({ value: e, context: items[i].context }))
      );
      
      expect(decrypted).to.deep.equal(['data1', 'data2', 'data3']);
    });
  });

  describe('healthCheck', function () {
    it('should return healthy status', async function () {
      const health = await engine.healthCheck();
      
      expect(health.status).to.equal('healthy');
      expect(health.algorithm).to.equal('aes-256-gcm');
      expect(health.keyId).to.equal('default');
    });
  });

  describe('key derivation', function () {
    it('should derive different keys for different contexts', async function () {
      const key1 = await engine.getEncryptionKey('users.phone');
      const key2 = await engine.getEncryptionKey('users.email');

      expect(key1).to.not.deep.equal(key2);
    });
  });

  describe('performance', function () {
    it('should encrypt within performance threshold', async function () {
      const iterations = 100;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        await engine.encrypt(`test-data-${i}`, 'test.context');
      }

      const elapsed = Date.now() - start;
      const avgTime = elapsed / iterations;

      console.log(`Average encryption time: ${avgTime.toFixed(2)}ms`);
      expect(avgTime).to.be.lessThan(5); // < 5ms per operation
    });

    it('should decrypt within performance threshold', async function () {
      const encrypted = await engine.encrypt('test-data', 'test.context');
      const iterations = 100;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        await engine.decrypt(encrypted, 'test.context');
      }

      const elapsed = Date.now() - start;
      const avgTime = elapsed / iterations;

      console.log(`Average decryption time: ${avgTime.toFixed(2)}ms`);
      expect(avgTime).to.be.lessThan(5); // < 5ms per operation
    });
  });
});

describe('KeyManagementService', function () {
  const KeyManagementService = require('../../backend/shared/crypto/KeyManagementService').KeyManagementService;
  let kms;

  beforeEach(async function () {
    kms = new KeyManagementService({
      storageType: 'file',
      storagePath: './test-keys',
      environment: 'test'
    });
  });

  describe('initialize', function () {
    it('should initialize and create default key', async function () {
      await kms.initialize();
      const key = await kms.getCurrentKey('master');
      
      expect(key).to.be.instanceOf(Buffer);
      expect(key.length).to.equal(32);
    });

    it('should return healthy status after initialization', async function () {
      await kms.initialize();
      const health = await kms.healthCheck();
      
      expect(health.status).to.equal('healthy');
      expect(health.activeKeys).to.be.greaterThan(0);
    });
  });

  describe('key rotation', function () {
    it('should rotate key successfully', async function () {
      await kms.initialize();
      const oldKey = await kms.getCurrentKey('master');

      const result = await kms.rotateKey('master');
      
      expect(result.oldVersion).to.equal(1);
      expect(result.newVersion).to.equal(2);

      const newKey = await kms.getCurrentKey('master');
      expect(newKey).to.not.deep.equal(oldKey);
    });
  });

  describe('listKeys', function () {
    it('should list all keys', async function () {
      await kms.initialize();
      const keys = await kms.listKeys();
      
      expect(keys).to.be.an('array');
      expect(keys.length).to.be.greaterThan(0);
      expect(keys[0].keyId).to.equal('master');
    });
  });
});