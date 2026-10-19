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
// A scoped store shares only the managed provider; its database identity is
// resolved on the supplied pool/client, never borrowed from the default pool.
api.useAuditStore = async ({
  pool,
  transactionClient
} = {}, operation) => {
  if (!pool && !transactionClient) return operation(instance());
  const parent = instance();
  const scoped = new EncryptedAuditStore({
    pool,
    transactionClient,
    provider: parent.provider,
    namespace: parent.namespaceInput
  });
  try {
    return await operation(scoped);
  } finally {
    await scoped.close();
  }
};
api.closeAuditEncryption = async () => {
  if (store) {
    const current = store;
    store = null;
    await current.close();
  }
};
module.exports = api;
