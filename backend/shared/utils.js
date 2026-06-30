/**
 * REQ-00399: 工具函数
 */
const crypto = require('crypto');

function generateId(prefix = '') {
  const random = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now().toString(36);
  return `${prefix}${timestamp}_${random}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const delay = options.delay || 100;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(delay * (i + 1));
    }
  }
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function throttle(fn, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

module.exports = {
  generateId,
  sleep,
  retry,
  debounce,
  throttle
};