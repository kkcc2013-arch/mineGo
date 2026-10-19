'use strict';
const CacheInvalidationCenter = require('./CacheInvalidationCenter');
let centerInstance = null;
let starting = null;
async function initCacheInvalidation(config = {}) {
  if (starting) return starting;
  if (centerInstance) return centerInstance;
  const candidate = new CacheInvalidationCenter(config);
  starting = (async () => {
    try { await candidate.start(); centerInstance = candidate; return candidate; }
    catch (error) { await candidate.stop(); throw error; }
    finally { starting = null; }
  })();
  return starting;
}
function getCacheInvalidationCenter() {
  if (!centerInstance) throw new Error('Cache invalidation center is not initialized');
  return centerInstance;
}
async function closeCacheInvalidation() {
  if (starting) await starting.catch(() => {});
  if (centerInstance) { const current = centerInstance; centerInstance = null; await current.stop(); }
}
module.exports = {initCacheInvalidation, getCacheInvalidationCenter, closeCacheInvalidation, CacheInvalidationCenter};
