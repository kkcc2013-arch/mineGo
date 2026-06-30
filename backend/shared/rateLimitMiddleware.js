'use strict';

const { rateLimiter } = require('./middleware/rateLimit');

module.exports = {
  rateLimit: rateLimiter
};
