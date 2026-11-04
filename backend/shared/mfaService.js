'use strict';

// REQ-00638: lazy canonical runtime; no default master, caller flags or signing fallback.
const {
  MFAStore
} = require('./mfa/MFAStore');
let instance;
const store = () => instance || (instance = new MFAStore());
const api = {
  MFAStore
};
for (const name of ['setup', 'enable', 'verify', 'verifyProof', 'status', 'disable', 'regenerate', 'beginLogin', 'completeLogin']) api[name] = (...args) => store()[name](...args);
api.ready = async () => {
  const current = store();
  await current.transaction(async () => {});
  current.keyProvider();
  await require('./auditLogEncrypted').useAuditStore({},audit=>audit.initialize());
};
api.closeMFA = async () => {
  if (instance) {
    const current = instance;
    instance = null;
    await current.close();
  }
};
module.exports = api;
