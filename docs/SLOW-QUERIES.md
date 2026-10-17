# Slow-query migration prerequisite

REQ-00077 remains in progress. Its original ten acceptance criteria include actual
collection, plans and three suggestion types, unused indexes, metrics, six dashboard
panels, four alerts, mounted APIs, over80% unit coverage and documentation. The SQL
prerequisite below does not complete those criteria.

The original20260627_041000 migration fails on PostgreSQL15 because two-argument
round requires NUMERIC rather than DOUBLE PRECISION. Its two PL/pgSQL helpers also
refer to pre-13 mean_time/total_time columns that fail when invoked on15. The
source-bound repair uses NUMERIC for the existing two-decimal index-usage ratio
and actual mean_exec_time/total_exec_time for the helper queries, preserving their
output signatures and original table/index/retention SQL. Both helpers restrict
statistics to current_database(), so another database cannot enter this report or
snapshot. These contracts are
specified in the official [math documentation](https://www.postgresql.org/docs/15/functions-math.html)
and [statement statistics documentation](https://www.postgresql.org/docs/15/pgstatstatements.html).

The extension needs shared_preload_libraries at server start plus CREATE EXTENSION
in the intended database. Tests use an explicitly owned isolated PostGIS15 instance
with this setting, one CPU and a bounded memory allocation. Each test creates and
drops its own named database, so older schemas cannot compete for its top50 slots. CI configures/restarts
only its disposable service container before tests, then checks readiness. No
production configuration, existing application database or unrelated container is
changed; tests do not reset shared statement statistics.

`backend/tests/regression/slow-query-schema-storage.test.js` passes7 real checks
including its parent. It applies the earlier source-bound prerequisite, retains
actual data/sequence/table OIDs, exact floating-point history, views/FKs and existing
suggested SQL. It proves original SQL failure/rollback, actual rounded index ratios,
a real pg_sleep query observed by the live extension and both existing SQL helper
functions, the original30-day snapshot cutoff and rerun function OIDs/old data.
It does not substitute fabricated pg_stat_statements rows.

```bash
cd backend
node --test --test-concurrency=1 tests/regression/slow-query-schema-storage.test.js
```

TEST_DATABASE_URL must point to an administrative connection on that disposable
server with the extension preloaded and permission to create/drop owned fixture
databases. The test observes a real qualifying slow query in a second database and
proves it is excluded from both report and history; no shared statistics are reset.
The helper's30-day cutoff and earlier cleanup configuration's90 days are an existing
policy conflict; this syntax/version repair preserves both rather than silently
changing retention. All85 root pending SQL files remain byte-identical. The full
seed still passes and complete history now rolls back at20260627_060000 statement13:
missing pokemon_instances.is_deleted. Complete upgrades/reversal and REQ-00007 stay open.

The existing JavaScript collector calls nonexistent metrics methods; its status/
readiness/lifecycle need repair. The existing slowQuery router is unmounted and has
an invalid collector construction. Any query-plan endpoint needs actual admin
access control and constrained SQL execution before mounting. Real collectors,
plan/index analysis, appropriate permissions, actual metrics/dashboard/alert drills,
coverage and complete operations acceptance remain open.


The first schema-only repeat failed because global historical statistics displaced
its live probe from the top50. This exposed the missing database scope. The repair
now filters current database in both helpers, and the fixture owns a fresh database.
Repeated actual7-case runs pass, including positive current-database collection and
negative foreign-database collection; assertions and acceptance thresholds remain.


## Transaction metadata regression (2026-10-17)

A real repeated-transaction probe exposed per-operation application_name utility
entries competing in the shared statement catalog. The transaction manager now
retains its original backend name and uses exact startup PID/key cancellation.
A new actual case checks five distinct managed operation IDs, unchanged backend
application_name, restored statement_timeout and absence of application-name or
SELECT-set_config monitoring entries from those operations. This adds to, rather
than substitutes for, the live slow-query/foreign-database/history checks. See
[transaction evidence](TRANSACTIONS.md); the original ten slow-query feature criteria
and complete migration chain remain open.
