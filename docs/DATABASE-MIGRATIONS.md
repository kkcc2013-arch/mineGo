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

The complete current81-file pending history (original79 plus2 explicit prerequisites)
is still failing at the audit-table partition conversion. The original V1 audit_logs is
an ordinary table with different columns; IF NOT EXISTS neither reconciles it nor turns
it into a partition parent. The item/Pokedex prerequisites and guarded SQL repairs now
permit earlier stages to execute. Original legacy files retain their exact hashes.
The full-history test remains a failing CI gate until conversion and later dependencies
are actually repaired. Whole-history upgrades/rollback, all-service startup, operational
backups and REQ-00306 remain open; this does not mark REQ-00007 complete.

Run `npm run test:migrations:unit --prefix backend` for the actual parser/unit suite.
For an isolated database, set TEST_DATABASE_URL and run
`npm run test:migrations:storage --prefix backend`. With the PostGIS image specified in
docker-compose.yml, run `node --test backend/tests/regression/database-bootstrap.test.js`
for the full schema/seed/history gate. The final history case is currently red for the
audit partition conflict above. GitHub runs these checks in .github/workflows/migration-regression.yml.


## Dependency/catalog follow-up (2026-10-08)

Runner unit8 and actual CLI13 cases pass, including repair/dependency tampering,
actual order rollback and legacy journal adoption preserving application data and
original hashes. Catalog/Pokedex prerequisites pass actual data tests: existing catalog
survives rollback, newly owned catalog is removed safely, valid UUID cache owners work,
and invalid owners/zero quantities are rejected. Actual inventory helpers now handle
UUID capacity, default fields and expiry without violating quantity constraints.

Current pending set is81: original79 plus2 declared prerequisites. The full gate remains
red at20260610_100000: the preexisting V1 audit_logs is a regular table and lacks the
partition script's resource columns. Ignoring partition work cannot satisfy REQ-00060.
The next batch must reconcile IDs/all columns/data/constraints/defaults/dependencies,
convert the actual table, and prove writes/queries/rollback before accepting the gate.
