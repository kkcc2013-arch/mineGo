# Structured logging migration

Backend runtime modules use `backend/shared/logger.js`. Frontend code, test
fixtures and command-line tools retain their own output rules.

Use `createLogger('service-or-module')` and record useful fields explicitly:

```js
const logger = require('../../../shared/logger').createLogger('user-service');
logger.info({userId, action: 'profile_updated'}, 'Profile updated');
logger.error({err}, 'Profile update failed');
```

`requestLogger(logger)` supplies request context through AsyncLocalStorage.
Loggers created by the shared factory pick up the current request ID, verified
user ID and active trace context. Concurrent requests keep separate contexts.
Development loggers share one pretty-print transport; an explicit destination
can be supplied for tests. Production uses JSON output.

`ConsoleMigrationHelper` preserves common console message formatting during
migration. It supplies module metadata, structured error/object fields and
redacts known credential keys in objects. Direct structured calls are preferred
for new code. Free-text messages and application-specific sensitive fields still
require review; a field redactor cannot infer every secret inside a string.
Importing the helper never replaces global console. `replaceConsole` is an
explicit transitional option and returns a restoration function.

To inspect direct global console calls:

```sh
node scripts/replace-console-with-logger.js --output /tmp/console-report.json
npm run check:logging
```

The parser excludes comments, strings and locally bound objects named console.
It scans backend shared, services and gateway code; test and CLI/script directories
are excluded. The current baseline is empty: any detected runtime console call
fails CI. Updating a baseline is an explicit command, not the default behavior.

To review a migration of one CommonJS file:

```sh
node scripts/replace-console-with-logger.js --write --file backend/shared/example.js
git diff -- backend/shared/example.js
```

The tool edits only the callee token, preserving argument expressions, directives
and comments. It chooses a name that cannot collide with identifiers in nested
scopes and parses the result before writing. Optional calls, timers and unknown
methods require manual review; ES module changes require reviewed imports.
Do not restore the earlier regular-expression converter: it put imports inside
comments and corrupted nested calls and template interpolation.

Run `cd backend && npm run test:logging:unit` for the measured helper coverage gate.
Run `NODE_ENV=production npm run benchmark:logging` for the reproducible formatting
microbenchmark. The benchmark returns failure when the documented 5% target is
exceeded. It measures writes to synchronous discard streams, not production disk
or network throughput. The latest run exceeds the relative target despite low
absolute per-call times; performance acceptance remains open.
