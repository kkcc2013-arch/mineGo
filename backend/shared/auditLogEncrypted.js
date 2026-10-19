'use strict';

// REQ-00038: canonical durable authenticated audit storage. No transient-key or
// plaintext fallback; HTTP callers must separately enforce verified admin/MFA.
const {
  EncryptedAuditStore
} = require('./audit/EncryptedAuditStore');
const {
  CONFIG
} = require('./audit/cryptoPrimitives');
let store = null;
const instance = () => store || (store = new EncryptedAuditStore());
const api = {
  EncryptedAuditStore,
  ENCRYPTION_CONFIG: CONFIG
};
for (const method of ['encryptAuditLog', 'decryptAuditLog', 'writeEncryptedAuditLog', 'queryDecryptedAuditLogs', 'rotateEncryptionKey', 'getEncryptionKeyStatus', 'readEncryptedAuditLog', 'writeSensitiveDataAccess', 'querySensitiveDataAccessLogs']) api[method] = (...args) => instance()[method](...args);
api.closeAuditEncryption = async () => {
  if (store) {
    const current = store;
    store = null;
    await current.close();
  }
};
module.exports = api;
