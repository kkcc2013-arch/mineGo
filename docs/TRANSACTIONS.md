# Shared PostgreSQL transactions

`backend/shared/db.js::transaction` and all three convenience functions in
`backend/shared/transactionManager.js` now use one pool-owned `TransactionManager`.
The ordinary no-options call uses the same bounded implementation. No new route
or service mount is introduced.

```javascript
const {transaction} = require('../shared/db');
await transaction(async client => {
  await client.query('UPDATE users SET stardust=stardust+$1 WHERE id=$2', [10, userId]);
}, {isolationLevel: 'SERIALIZABLE', timeout: 30000, maxRetries: 3});
```

Only READ COMMITTED, REPEATABLE READ and SERIALIZABLE are accepted, before checkout.
The defaults are READ COMMITTED, 30 seconds and three retries after the initial
attempt. An explicit maxRetries between zero and ten is supported, including the
existing payment example's five. Callbacks may execute again after a genuine
PostgreSQL 40P01 or 40001 abort; any external side effects require a separate
idempotent/outbox contract. Broad legacy diagnostic helpers still classify lock
messages/55P03, but those do not activate the automatic retry policy.

The monotonic operation deadline includes checkout, callback, queries, commit,
backoff and bounded contention logging. PostgreSQL statement_timeout is local to
the owned transaction. Cleanup has a separate bounded allowance (default one
second); the deadline is not a promise that remote cancellation completes instantly.
A late checkout is returned without running the callback. The callback receives
promise-based query and processID, with no raw release/end. Explicit transaction
control is rejected, including commented/batched COMMIT; savepoint rollback is
allowed. SQL literals and dollar quoting are handled by the SQL splitter. Pending
queries finish before commit, and a PostgreSQL implicit ROLLBACK cannot count as
successful COMMIT.

On error the manager rolls back a usable lease. Busy/failed leases are destroyed;
a timed-out busy backend is cancelled only when PID, unique application_name,
current database and current role all match. A callback that finishes late cannot
write through a returned lease. Checked-out connection errors are handled through
lease destruction, including a disconnect during COMMIT. A lost/expired COMMIT
response has `commitOutcomeUnknown=true` and is never automatically retried; callers
must resolve the durable business state before deciding how to proceed.

Real contention is logged in a separately owned, bounded transaction after the
failed business lease is released. Failure to persist that audit is reported and
does not replace the original business error. Context records isolation level,
transaction name, actual retry count and the decision to retry. The parser records
both participants from actual PostgreSQL deadlock detail. `pgDeadlock.js` contains
these pure PostgreSQL helpers; the existing distributed wait-graph detector keeps
its original API and additionally exports the helpers.

## Metrics

Collectors use the actual shared registry exposed by service metrics endpoints.
`db_transaction_started_total` counts logical starts;
`db_transaction_attempts_total` counts checked-out business attempts;
`db_transaction_completed_total` counts confirmed commits;
`db_transaction_failed_total` counts failed attempts with error_type;
`db_transaction_retries_total` and `db_deadlock_retries_total` count retries actually
checked out. `db_transactions_total` records final success, rollback, timeout,
max_retries_exceeded or unknown_commit. The duration histogram measures the whole
logical operation including retry/cleanup. The active gauge sums owned checked-out
transactions by service. Labels use service/isolation/status/error classifications,
not user IDs or transaction names. Instrumentation failures do not reverse a
confirmed commit or convert it into a reported business failure.

## Migration and retained history

The source-bound repair for 20260626_040000 corrects its invalid // header and
bridges both the original table and the requirement's earlier context-only layout.
Existing table/sequence identities, data, views, foreign keys and indexes remain.
Missing transaction_name/retry_count/context are additive; historical unknown names
and retry counts stay NULL, and default zero applies only to future missing-column
inserts. Incompatible column types are refused. All85 root pending SQL sources stay
byte-identical; the manifest records the original checksum and separate repair.
This is not an upgrade plan for already applied differing repairs. The complete
history still fails at 20260627_041000 statement14, `round(double precision,integer)`;
its pending batch rolls back. Complete history, reversal and all-service acceptance
remain open.

## Evidence and bounds (2026-10-15)

The main unit gate runs the original38 transaction unit cases, now enrolled with
correct production imports and genuine failure injection. The real PostGIS suite
`backend/tests/regression/transaction-storage.test.js` reports22 passing checks
(including its parent). It exercises three isolation levels, rollback, late work,
query/checkout/JavaScript deadlines, actual serializable aborts (four attempts,
three retries), genuine two-owner deadlock and durable audit rows, blocked audit,
55P03 exclusion, metrics, uncertain COMMIT disconnect, historical schema identity
and an actual ExchangeRateService call through the default shared database API.
Fixture corrections preserve assertions and require actual business queries to
fail; control/audit queries are accounted for separately.

`backend/tests/performance/transaction-throughput.js` compares the working published
legacy helper at immutable43c6b148ccdba62f76af415927f2a86676feaa18 with the current
manager, using the same actual V1 resource transfers and owned pool. Both default
metrics are enabled. It uses two connections/workers,50 warmup transfers per worker,
seven alternating paired rounds and200 transfers per worker per round. Every final
resource balance is checked. Source hashes are captured before/after and must match.
The original gate is median paired throughput change >=-5%, with no override.

The archived [measurement](benchmarks/transaction-throughput-2026-10-15.json) passes
at +0.054927% median change. This is a local comparative regression result with low
concurrency; it does not establish production capacity or any other feature's SLO.
CI now executes the real storage suite and the same fixed performance gate before
the still-failing complete-history gate. Exact current-commit remote CI must be
observed before claiming requirement completion. The original seven acceptance
conditions remain unchanged; REQ-00096 is reopened in progress while full migration
and relevant current CI remain incomplete.

Run sequentially against an isolated PostGIS database:

```bash
cd backend
UV_THREADPOOL_SIZE=2 npm test
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 tests/regression/transaction-storage.test.js
UV_THREADPOOL_SIZE=2 node tests/performance/transaction-throughput.js
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 tests/regression/database-bootstrap.test.js
```

The three storage commands require TEST_DATABASE_URL for that disposable database;
the benchmark also needs the immutable baseline commit available in Git history.


## Remote performance finding and follow-up (2026-10-15)

Exact transaction commit bae401eb passes remote correctness/storage, mainCI454 and
its battle coverage job. Migration16 job116334922847 reaches the fixed original
throughput gate and fails at-5.624629685951888% median versus the unchanged-5%
ceiling. Full-history step is consequently skipped there, not passed. The earlier
local+0.054927% report above describes that source and does not override remote
failure; the [failed CI measurement](benchmarks/transaction-throughput-ci-bae401e-2026-10-15.json)
is preserved with its actual source hashes.

The follow-up removes success-path Error stack construction (build the same timeout
error only on failure) and an empty pending-query Promise.all/race. Deadline,
rollback, cancellation, query ownership, retry, audit and metric semantics remain.
Current-source real transaction22 repeats successfully. The unchanged local paired
benchmark passes at-3.2443239972000937%; see its separate
[measurement](benchmarks/transaction-throughput-optimized-2026-10-15.json).
That is a local pass, not evidence that remote regression is resolved. Exact new
remote throughput must pass the original gate before accepting REQ-00096.

An independent slow-query SQL repair advances complete history to20260627_060000
statement13 is_deleted missing. Complete upgrades/reversal and service/feature
acceptance still remain open. No threshold/baseline/benchmark workload was changed.
