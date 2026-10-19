'use strict';

const crypto = require('node:crypto');
const CONFIG = Object.freeze({
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16,
  keyRotationDays: 90
});
class AuditCryptoError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.name = 'AuditCryptoError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => new AuditCryptoError(code, status);
function hex(value, bytes, code = 'AUDIT_ENVELOPE_INVALID') {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) throw fail(code, 400);
  return Buffer.from(value, 'hex');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const aad = context => Buffer.from(JSON.stringify(stable(context)));
function seal(plaintext, key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('AUDIT_KEY_INVALID');
  const iv = crypto.randomBytes(16),
    cipher = crypto.createCipheriv(CONFIG.algorithm, key, iv, {
      authTagLength: 16
    });
  if (context !== null) cipher.setAAD(aad(context));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: data.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex')
  };
}
function open(envelope, key, context) {
  if (!envelope || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 2097152 || envelope.ciphertext.length % 2 || !/^[0-9a-f]*$/i.test(envelope.ciphertext)) throw fail('AUDIT_ENVELOPE_INVALID', 400);
  const iv = hex(envelope.iv, 16),
    tag = hex(envelope.tag, 16);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('AUDIT_KEY_INVALID');
  let first, last;
  try {
    const decipher = crypto.createDecipheriv(CONFIG.algorithm, key, iv, {
      authTagLength: 16
    });
    if (context !== null) decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    first = decipher.update(Buffer.from(envelope.ciphertext, 'hex'));
    last = decipher.final();
    return Buffer.concat([first, last]);
  } catch {
    throw fail('AUDIT_AUTHENTICATION_FAILED');
  } finally {
    first?.fill(0);
    last?.fill(0);
  }
}
function jsonBytes(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw fail('AUDIT_PAYLOAD_INVALID', 400);
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > 1048576) throw fail('AUDIT_PAYLOAD_INVALID', 400);
  return Buffer.from(encoded);
}
module.exports = {
  CONFIG,
  AuditCryptoError,
  fail,
  hex,
  aad,
  seal,
  open,
  jsonBytes
};
