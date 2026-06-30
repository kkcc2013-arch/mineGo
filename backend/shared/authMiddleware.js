'use strict';

const auth = require('./auth');

module.exports = {
  authenticate: auth.requireAuth,
  optionalAuth: auth.optionalAuth
};
