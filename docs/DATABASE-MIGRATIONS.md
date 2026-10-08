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
version and rolls back newer versions. Every selected migration must have executable
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

Six production-parser/unit checks and ten actual PostgreSQL/CLI checks cover script
creation, complex SQL strings/function bodies, empty templates, durable history,
idempotency, checksum tampering/missing files, duplicate identities, target/last/empty
rollback, whole-batch SQL failure, concurrency, lock wait limits, interrupted ownership
and shared AUTO_MIGRATE startup. Full V1/PostGIS schema plus V2 sample data now loads with
32 sample species and intact evolution references. Missing target species were added;
the sample's other game-balance settings remain unchanged. New target base stats were
checked against the [game-master snapshot](https://github.com/PokeMiners/game_masters/blob/8e227be44f288d34463e23bf04e9b564d3c16f79/latest/latest.json).

The complete 79-file pending history is still failing: the 20260609_124500 inventory
script requires a localized items catalog which the initial schema does not create.
Other files outside database/pending have conflicting table contracts and require a
validated ordering/catalog solution. No pending file was altered or silently skipped.
The full-history test remains a failing CI gate until those dependencies are repaired.
Whole-history upgrades/rollback, all service startup, operational backups and REQ-00306
remain open; this batch does not mark REQ-00007 complete.

Run `npm run test:migrations:unit --prefix backend` for the actual parser/unit suite.
For an isolated database, set TEST_DATABASE_URL and run
`npm run test:migrations:storage --prefix backend`. With the PostGIS image specified in
docker-compose.yml, run `node --test backend/tests/regression/database-bootstrap.test.js`
for the full schema/seed/history gate. The final history case is currently red for the
reason above. GitHub runs these checks in .github/workflows/migration-regression.yml.
