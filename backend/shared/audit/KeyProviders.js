'use strict';

const crypto = require('node:crypto');
const {
  fail,
  hex,
  seal,
  open
} = require('./cryptoPrimitives');
const label = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
class EnvironmentKeyProvider {
  #keys;
  constructor({
    keys,
    activeKeyId,
    legacyMasterKeyId = null,
    nodeEnv = process.env.NODE_ENV
  } = {}) {
    if (nodeEnv === 'production' || !keys || !label(activeKeyId) || legacyMasterKeyId !== null && !label(legacyMasterKeyId)) throw fail('AUDIT_KEY_CONFIGURATION');
    this.kind = 'environment';
    this.activeKeyId = activeKeyId;
    this.legacyMasterKeyId = legacyMasterKeyId;
    this.#keys = new Map();
    try {
      if (Array.isArray(keys) || typeof keys !== 'object' || Object.keys(keys).length > 16) throw fail('AUDIT_KEY_CONFIGURATION');
      for (const [id, value] of Object.entries(keys)) {
        if (!label(id)) throw fail('AUDIT_KEY_CONFIGURATION');
        const key = Buffer.isBuffer(value) ? Buffer.from(value) : hex(value, 32, 'AUDIT_KEY_CONFIGURATION');
        if (key.length !== 32) {
          key.fill(0);
          throw fail('AUDIT_KEY_CONFIGURATION');
        }
        this.#keys.set(id, key);
      }
      if (!this.#keys.has(activeKeyId) || legacyMasterKeyId !== null && !this.#keys.has(legacyMasterKeyId)) throw fail('AUDIT_KEY_CONFIGURATION');
    } catch {
      this.close();
      throw fail('AUDIT_KEY_CONFIGURATION');
    }
  }
  async generate(context) {
    const key = crypto.randomBytes(32);
    try {
      return {
        key,
        wrapped: {
          v: 1,
          provider: this.kind,
          masterKeyId: this.activeKeyId,
          ...seal(key, this.#keys.get(this.activeKeyId), context)
        }
      };
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }
  async unwrap(wrapped, context) {
    if (wrapped?.v !== 1 || wrapped.provider !== this.kind || !label(wrapped.masterKeyId)) throw fail('AUDIT_KEY_ENVELOPE_INVALID');
    const master = this.#keys.get(wrapped.masterKeyId);
    if (!master) throw fail('AUDIT_MASTER_KEY_UNAVAILABLE');
    const key = open(wrapped, master, context);
    if (key.length !== 32) {
      key.fill(0);
      throw fail('AUDIT_KEY_INVALID');
    }
    return key;
  }
  async unwrapLegacy(blob) {
    if (!this.legacyMasterKeyId) throw fail('AUDIT_LEGACY_MASTER_KEY_REQUIRED');
    const text = Buffer.isBuffer(blob) ? blob.toString('utf8') : blob;
    if (typeof text !== 'string' || text.length !== 130) throw fail('AUDIT_LEGACY_KEY_FORMAT');
    const [iv, ciphertext, tag] = text.split(':');
    const key = open({
      iv,
      ciphertext,
      tag
    }, this.#keys.get(this.legacyMasterKeyId), null);
    if (key.length !== 32) {
      key.fill(0);
      throw fail('AUDIT_KEY_INVALID');
    }
    return key;
  }
  close() {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }
}
function keyArn(value) {
  return typeof value === 'string' && /^arn:(aws|aws-cn|aws-us-gov):kms:([a-z0-9-]+):[0-9]{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.test(value);
}
class AwsKmsKeyProvider {
  constructor({
    keyId,
    decryptKeyIds = [],
    region,
    endpoint,
    credentials,
    nodeEnv = process.env.NODE_ENV,
    requestTimeout = 3000
  } = {}) {
    if (!keyArn(keyId) || !Array.isArray(decryptKeyIds) || decryptKeyIds.length > 16 || !Number.isInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 30000) throw fail('AUDIT_KMS_CONFIGURATION');
    this.kind = 'aws-kms';
    this.activeKeyId = keyId;
    this.allowed = new Set([keyId, ...decryptKeyIds]);
    region = region || keyId.split(':')[3];
    if ([...this.allowed].some(id => !keyArn(id) || id.split(':')[3] !== region)) throw fail('AUDIT_KMS_CONFIGURATION');
    if (endpoint) {
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        throw fail('AUDIT_KMS_CONFIGURATION');
      }
      if (nodeEnv !== 'test' || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw fail('AUDIT_KMS_CONFIGURATION');
    }
    const {
      KMSClient,
      GenerateDataKeyCommand,
      DecryptCommand
    } = require('@aws-sdk/client-kms');
    this.GenerateDataKeyCommand = GenerateDataKeyCommand;
    this.DecryptCommand = DecryptCommand;
    this.client = new KMSClient({
      region,
      endpoint,
      credentials,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: Math.min(requestTimeout, 1500),
        requestTimeout,
        throwOnRequestTimeout: true
      }
    });
  }
  async generate(context) {
    let result;
    try {
      result = await this.client.send(new this.GenerateDataKeyCommand({
        KeyId: this.activeKeyId,
        KeySpec: 'AES_256',
        EncryptionContext: context
      }));
    } catch {
      throw fail('AUDIT_KMS_UNAVAILABLE');
    }
    const key = Buffer.from(result.Plaintext || []);
    result.Plaintext?.fill(0);
    const blob = Buffer.from(result.CiphertextBlob || []);
    if (key.length !== 32 || blob.length < 1 || blob.length > 6144 || result.KeyId !== this.activeKeyId) {
      key.fill(0);
      throw fail('AUDIT_KMS_RESPONSE_INVALID');
    }
    return {
      key,
      wrapped: {
        v: 1,
        provider: this.kind,
        masterKeyId: result.KeyId,
        ciphertext: blob.toString('base64')
      }
    };
  }
  async unwrap(wrapped, context) {
    if (wrapped?.v !== 1 || wrapped.provider !== this.kind || !this.allowed.has(wrapped.masterKeyId) || typeof wrapped.ciphertext !== 'string') throw fail('AUDIT_KEY_ENVELOPE_INVALID');
    const blob = Buffer.from(wrapped.ciphertext, 'base64');
    if (!blob.length || blob.length > 6144 || blob.toString('base64') !== wrapped.ciphertext) throw fail('AUDIT_KEY_ENVELOPE_INVALID');
    let result;
    try {
      result = await this.client.send(new this.DecryptCommand({
        KeyId: wrapped.masterKeyId,
        CiphertextBlob: blob,
        EncryptionContext: context,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT'
      }));
    } catch {
      throw fail('AUDIT_KMS_UNAVAILABLE');
    }
    const key = Buffer.from(result.Plaintext || []);
    result.Plaintext?.fill(0);
    if (key.length !== 32 || result.KeyId !== wrapped.masterKeyId) {
      key.fill(0);
      throw fail('AUDIT_KMS_RESPONSE_INVALID');
    }
    return key;
  }
  close() {
    this.client.destroy();
  }
}
function providerFromEnvironment(env = process.env) {
  if (env.AUDIT_KMS_KEY_ID) {
    let allowed = [];
    try {
      allowed = env.AUDIT_KMS_DECRYPT_KEY_IDS ? JSON.parse(env.AUDIT_KMS_DECRYPT_KEY_IDS) : [];
    } catch {
      throw fail('AUDIT_KMS_CONFIGURATION');
    }
    return new AwsKmsKeyProvider({
      keyId: env.AUDIT_KMS_KEY_ID,
      decryptKeyIds: allowed,
      region: env.AWS_REGION,
      nodeEnv: env.NODE_ENV
    });
  }
  if (env.NODE_ENV === 'production') throw fail('AUDIT_KMS_CONFIGURATION');
  let keys;
  try {
    keys = env.AUDIT_MASTER_KEYS_JSON ? JSON.parse(env.AUDIT_MASTER_KEYS_JSON) : {};
  } catch {
    throw fail('AUDIT_KEY_CONFIGURATION');
  }
  if (!keys || Array.isArray(keys) || typeof keys !== 'object') throw fail('AUDIT_KEY_CONFIGURATION');
  const active = env.AUDIT_MASTER_KEY_ID || 'env-primary';
  if (env.MASTER_ENCRYPTION_KEY) {
    if (Object.hasOwn(keys, active) && keys[active] !== env.MASTER_ENCRYPTION_KEY) throw fail('AUDIT_KEY_CONFIGURATION');
    keys[active] = env.MASTER_ENCRYPTION_KEY;
  }
  return new EnvironmentKeyProvider({
    keys,
    activeKeyId: active,
    legacyMasterKeyId: env.AUDIT_LEGACY_MASTER_KEY_ID || null,
    nodeEnv: env.NODE_ENV
  });
}
module.exports = {
  EnvironmentKeyProvider,
  AwsKmsKeyProvider,
  providerFromEnvironment
};
