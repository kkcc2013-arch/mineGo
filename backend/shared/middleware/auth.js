'use strict';

// Compatibility entry point for routes using either a callable middleware or
// named imports. Authorization always uses the canonical shared auth module.
const auth = require('../auth');

module.exports = auth.requireAuth;
module.exports.authenticate = auth.requireAuth;
module.exports.requireAuth = auth.requireAuth;
module.exports.requireAdmin = auth.requireAdmin;
module.exports.requirePermissions = auth.requirePermissions;
module.exports.requireRoles = auth.requireRoles;
module.exports.optionalAuth = auth.optionalAuth;
