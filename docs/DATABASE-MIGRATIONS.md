# Database migration execution

Install the declared dependencies with `npm ci --prefix backend`. From the repository
root, use `node database/migrate.js status`, `up`, `verify`, `down [retained-version]`
or `create description`. Backend npm scripts provide the same commands. DATABASE_URL
must identify the intended database; do not put it in logs or source control.

`up` and `down` check the source checksum of every applied file before changing data.
Missing applied files and changed checksums are errors, including for rollback. Keep
applied files available and immutable. Add a new migration for an upgrade. A created
template must contain actual SQL before it can be applied; creation alone is not an
applied migration. Duplicate versions and invalid filenames are errors.

A dependencies.json file in the migration directory declares prerequisites by version.
The runner rejects missing/cyclic/invalid dependencies and executes a deterministic
valid order. execution_order records actual applied order; rollback follows that order
rather than assuming timestamps reflect prerequisite order. Existing legacy rows retain
their original source checksums and are ordered by recorded time/version on adoption.
Historical execution/dependency hashes without evidence remain null.

repairs.json explicitly binds a legacy file's exact original SHA256 to a complete
corrected SQL file and a reason. Repair paths must remain inside the migration directory.
Logs identify the correction used. New history stores separate original-source,
dependency and executed-SQL checksums; changing a source, repair or dependency after
application fails verification/up/down. Original pending SQL is not overwritten. The
current identity corrections target the canonical V1 UUID schema, not all undocumented
historical identity layouts.

Each operation uses a PostgreSQL transaction-held advisory lock scoped to the database
and schema. MIGRATION_LOCK_TIMEOUT_MS sets the wait limit (positive integer, default
30000ms); it does not expire a working owner's lock. All pending DDL/data/history changes
commit together or roll back together. Legacy outer BEGIN/COMMIT wrappers and trailing
COMMIT terminators are executed under the runner's transaction. Internal transaction
control is rejected so a script cannot commit untracked intermediate data. PostgreSQL
may finish an in-flight command before detecting client loss; an interrupted process's
session ending, rather than a client timeout alone, proves its transaction has ended.
[PostgreSQL advisory-lock documentation](https://www.postgresql.org/docs/15/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

`down` without a target removes only the latest applied migration. A target retains that
applied migration and rolls back migrations executed after it. Every selected migration must have executable
down SQL. Empty rollback still releases the transaction. The CLI naturally closes its
connection pool, reports the original failure and returns a nonzero exit status.

User-service and gateway startup verify saved checksums before initializing business
routes. AUTO_MIGRATE=true also applies pending scripts before HTTP listening. The shared
initialization is memoized for concurrent callers and closes its migration-specific pool.
AUTO_MIGRATE=false is the default; it does not claim missing business tables are present.
Other services still need the same startup integration and acceptance.

MINEGO_MIGRATIONS_DIR explicitly selects a different migration directory, principally for
isolated tests and controlled tooling. The default remains database/pending. A small
fixture directory proves runner behavior, not the repository's entire schema history.

## Current acceptance boundary

Eight production-parser/unit checks and thirteen actual PostgreSQL/CLI checks cover script
creation, complex SQL strings/function bodies, empty templates, durable history,
idempotency, checksum tampering/missing files, duplicate identities, target/last/empty
rollback, whole-batch SQL failure, concurrency, lock wait limits, interrupted ownership
and shared AUTO_MIGRATE startup. Full V1/PostGIS schema plus V2 sample data now loads with
32 sample species and intact evolution references. Missing target species were added;
the sample's other game-balance settings remain unchanged. New target base stats were
checked against the [game-master snapshot](https://github.com/PokeMiners/game_masters/blob/8e227be44f288d34463e23bf04e9b564d3c16f79/latest/latest.json).

The current85-file pending history (original79 plus6 explicit prerequisites) remains
gated. The audit conversion now executes successfully: V1 storage is attached as a
default partition with its original ID/sequence/columns/data retained. Views, indexes,
triggers and grants are preserved; rollback retains rows written after conversion.
Partition creation validates schema/parent/bounds, moves matching default rows atomically
and rechecks a concurrent creator after acquiring the lock. Unsupported incoming foreign
keys, additional uniqueness, forced RLS, materialized views and target-name collisions
fail atomically; these custom upgrade cases still need explicit plans.

23 actual PostGIS storage checks cover audit conversion/rollback, logical ID concurrency,
failed attachments, and historical/current writes to all five actual parents. This is
SQL storage evidence, not acceptance of all service/client paths or retention/performance.
Guarded repairs also replace two invalid inline INDEX declarations and four achievement
owner types with canonical UUIDs. All81 previously published pending sources remain
byte-identical. The achievement bridge now reconciles V1 tiered progress with the newer catalog while
retaining the original composite key, FK, rows and identity. Declared dependencies run
the existing title bootstrap and new bridge before the legacy consumer. All82 previously
published pending sources are immutable.41 actual achievement service/storage/HTTP checks
pass; an unused bridge reverses, while rollback with modern data explicitly refuses
loss. Notification history now has an additive identity-preserving bridge and actual35 storage
checks. All83 published pending sources remain byte-identical. The friendship identity bridge now preserves canonical trainer bonds and exposes named
affinity separately;20 actual storage checks pass. The existing privacy compatibility
migration explicitly precedes its consumer. All84 published pending sources are unchanged.
Full history now passes catch-risk storage, which preserves gameplay UUID sessions and
uses distinct risk telemetry with actual throw evidence.34 production/storage cases pass.
All85 original pending sources remain unchanged. Special-IV ownership/genotype and equipment prerequisite storage now pass.
Full history fails20260614_090500 statement2: daily-quest inline :: syntax is invalid. See CATCH-RISK.md. See FRIENDSHIP.md for storage and remaining service boundaries.
Later duplicate partition migrations and complete data-preserving rollback remain open. See ACHIEVEMENTS.md for actual grant and
remaining event/client/management boundaries.

Run `npm run test:migrations:unit --prefix backend` for the actual parser/unit suite.
Set TEST_DATABASE_URL to an isolated PostGIS database and run
`npm run test:migrations:storage --prefix backend`,
`node --test backend/tests/regression/migration-prerequisites.test.js`,
`node --test backend/tests/regression/audit-partition-storage.test.js`,
`node --test backend/tests/regression/achievement-storage.test.js` and
`node --test backend/tests/regression/notification-storage.test.js` and
`node --test backend/tests/regression/friendship-storage.test.js` and
`node --test backend/tests/regression/database-bootstrap.test.js`. The final history case
remains red at the daily-quest conflict. See NOTIFICATIONS.md for delivery/client limits. GitHub runs all these gates in
.github/workflows/migration-regression.yml. Whole-history upgrades/rollback, all-service
startup, operational backups and REQ-00306 remain open; REQ-00007 is not complete.


## Earlier dependency/catalog probe (2026-10-08, source f79d55f)

Runner unit8 and actual CLI13 cases pass, including repair/dependency tampering,
actual order rollback and legacy journal adoption preserving application data and
original hashes. Catalog/Pokedex prerequisites pass actual data tests: existing catalog
survives rollback, newly owned catalog is removed safely, valid UUID cache owners work,
and invalid owners/zero quantities are rejected. Actual inventory helpers now handle
UUID capacity, default fields and expiry without violating quantity constraints.

At that source, the pending set was81: original79 plus2 declared prerequisites. The full gate remains
red at20260610_100000: the preexisting V1 audit_logs is a regular table and lacks the
partition script's resource columns. Ignoring partition work cannot satisfy REQ-00060.
The next batch must reconcile IDs/all columns/data/constraints/defaults/dependencies,
convert the actual table, and prove writes/queries/rollback before accepting the gate.
