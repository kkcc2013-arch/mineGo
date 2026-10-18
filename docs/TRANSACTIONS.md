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
a failed busy backend receives PostgreSQL CancelRequest using the private startup
PID/key of that exact lease. The cancellation connection inherits the original TLS
policy; TLS refusal cannot trigger plaintext fallback. The failed lease is always
quarantined. CancelRequest transport closure is not an acknowledgement of success. A callback that finishes late cannot
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
logical operation including retry/cleanup. The active gauge sums actual owned checked-out transactions with metrics enabled
by service. Starts/attempts/completions/final outcomes accumulate exact producer
deltas and flush through the public Counter API when collected; reset clears both
pending and published counts. Failure/retry counters and duration remain direct. Labels use service/isolation/status/error classifications,
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
This is not an upgrade plan for already applied differing repairs. The independent
slow-query repair advances complete history to 20260627_060000 statement13, missing
`pokemon_instances.is_deleted`;
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


## One operation and one abort signal (2026-10-16)

Exact5864a4a mainCI456/battle succeed and actual transaction correctness passes,
but migration18 job116881319622 again fails the original throughput gate at
-5.691201189980399%; report archived separately. Preload setup passes; slow-query
and full-history steps are skipped there and are not reported as remote passes.

The follow-up races the whole owned transaction against one deadline/connection
abort signal, instead of racing every awaited phase against multiple signals.
Each continuation checks ownership before executing more work; a late checkout is
released without invoking the callback, a late BEGIN cannot start it, and late
callback/query completion cannot commit after rollback/release. Existing transaction
control, local server timeout, unique backend tag, bounded cleanup/audit, retry,
metrics and uncertain-COMMIT behavior remain. New real pending-query cases prove
that unawaited SQL completes before confirmed commit and failed pending SQL rolls
back preceding writes. The actual transaction suite now reports24 passing checks.

The original benchmark baseline, two workers,50 warmup,200 transfers/worker/round,
seven alternating rounds and-5% threshold remain unchanged. Environment metadata
now records actual Node/architecture and server version/synchronous_commit/preload
settings before timing. Current local median+0.5400157583078435% passes with exact
balances/source hashes and synchronous_commit on; see
[measurement](benchmarks/transaction-throughput-operation-2026-10-16.json). Exact
new remote gate is still required; neither earlier negative report is overridden.

CI runs the independent slow-query correctness case before throughput, and always
runs full history after success or failure of preceding checks. Failure still fails
the job; no continue-on-error or threshold waiver is added. This collects actual
evidence for independent gates even while the known complete-history conflict stays
red. Whole-chain, service and feature acceptance remain open.


## Owned cancellation and longer measurement windows (2026-10-17)

Exact2b5ab77 mainCI457/battle passed. Migration19 job116887975018 passed the
actual24 transaction and7 slow-query checks, then failed throughput at
-7.838354232137334%. The independently executed full history also failed at
inventory20260627_060000 statement13. The third
[negative CI report](benchmarks/transaction-throughput-ci-2b5ab77-2026-10-16.json)
is retained; no local result overrides it.

The previous per-operation application_name changed two PostgreSQL session-status
messages per commit and generated distinct unnormalized utility entries in real
pg_stat_statements. Cancellation now uses the driver's startup PID/private key
through a separate bounded connection, started before the exact failed lease is
destroyed. application_name remains unchanged; SET LOCAL statement_timeout remains
in the same BEGIN round trip and restores after completion. Private backend keys
are never exposed to callbacks, logs or artifacts. TLS cancellation negotiates SSL
and waits for the verified encrypted connection before sending the request, with
the original CA/certificate policy and no plaintext fallback. This follows the
[PostgreSQL cancellation protocol](https://www.postgresql.org/docs/15/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS);
closure confirms only transport completion, not a successful database cancellation.
Actual lock-release/rollback tests verify the business outcome separately.

Query configuration getters are materialized before validating the exact SQL sent.
Callback/custom submit hooks cannot receive an owned driver connection. The control
guard handles comments between keywords, CR line endings, nested comments and
batched statements while retaining prepared queries and savepoints. A bounded cache
holds at most256 validated SQL texts of at most4096 characters each. Metric labels
are immutable and reused; actual event deltas flush at observation, including reset
and disabled-metrics behavior, without changing any reported business outcome.

The former200-transfer samples lasted roughly0.17s on faster storage and showed
large pair-to-pair variation. The benchmark now uses2000 actual transfers per worker
per round and500 warmup, retaining the exact published43c6b148 predecessor, V1
SELECT-FOR-UPDATE/two-UPDATE transfer, two workers, seven alternating pairs and
original-5% limit. Both real registry exposures are inside every timed sample and
exact started/completed counts must equal all29000 operations for each producer.
All resource balances and before/after source hashes are still checked. This sample
length change is explicit; old and new sample counts must not be conflated.

The preceding short fast-storage diagnostic failed at-5.0164301546780425% and is
[retained](benchmarks/transaction-throughput-wire-fast-storage-diagnostic-2026-10-17.json).
The longer diagnostic passes at-2.9650592644973828%; its
[source-hashed report](benchmarks/transaction-throughput-wire-long-fast-storage-diagnostic-2026-10-17.json)
uses an owned one-CPU/512MiB PostgreSQL15.8 instance with256MiB tmpfs PGDATA and
synchronous_commit on. The tmpfs measurement is exploratory comparative evidence,
not durable-storage, production-capacity or remote-CI acceptance. Intermediate
settings/buffering diagnostics refer to their own recorded hashes, not the final
source. All original seven criteria and the remote gate remain open until verified.

The TLS storage suite additionally requires TEST_SSL_DATABASE_URL and the public
TEST_DATABASE_SSL_CA certificate path. CI creates a disposable certificate/key,
installs it only in its owned PostGIS container and enables SSL during the existing
preload restart. Private keys are never committed or uploaded. No unrelated server
configuration or database is changed.

The final regular-disk measurement also passes at+0.22104147149817344% median,
with synchronous_commit on, exact balances/29000 event counts and matching final
source hashes; [report](benchmarks/transaction-throughput-wire-long-2026-10-17.json).
This is a separate owned one-CPU/512MiB local comparison, not production capacity.
Final724 unit checks/24Jest suites425 and355 actual storage checks pass, including
27transaction/8slow-query/3TLS; TLS is repeated after pre-establishing its verified
connection so its deadline targets blocked-query cancellation. All checkout/deadline
cases remain in the original storage suite. Exact new remote CI is still required.


## Exact remote gate observed (2026-10-17)

Commit26f553fe6cdf2dcf2366984074d75c6d5fc1fc32 passes mainCI458, actual transaction27,
slow-query8, verified-TLS3 and the original throughput ceiling in migration20
job117273205599/run38991013485. Downloaded actual report records-1.1060183236359267%
with Node24.21.0; all eight measured-source hashes still match. The
[remote report](benchmarks/transaction-throughput-ci-26f553f-2026-10-17.json) is retained
beside all previous negative reports. Full job remains failed because complete
migration history fails inventory20260627_060000 statement13; no claim of overall
CI success. The new independent inventory prerequisite moves the local full-chain
failure to cosmetic20260630_040000 statement13. Default caller/resource/idempotency,
complete installation/upgrade/reversal and full feature/operations acceptance remain
open. Unchanged measured transaction sources need no new local benchmark rerun.

Exacta769b0d migration21/job117376047375 confirms inventory24 and all existing
transaction/slow-query/TLS checks pass. Throughput again passes at-1.6979621741050943%
with all8 measured hashes unchanged; report archived as transaction-throughput-ci-
a769b0d-2026-10-17.json. Main459 succeeds. Full job fails old cosmetic FK; current
local independent cosmetic repair advances full history to deletion20260630_050000
stmt2. Full fresh/upgrade/reversal and all original full-feature acceptance stay open.


## Installation checkpoint (2026-10-18)

The independent [erasure storage prerequisite](DATA-ERASURE.md) now preserves legacy
numeric-owner requests while provisioning distinct UUID workflow storage. Its18 real
storage/CLI checks pass. Complete85-source history advances past deletion and fails
canary20260701_110000 statement1 near WHERE; the whole pending batch rolls back.
This batch also passes724 unit checks (including24 Jest suites/425 tests),1447 syntax
checks and actual migration/deletion/GDPR module and workflow parsing. Prior394
storage checks across21 suites remain source-specific evidence; they were not rerun
as a new combined412-check suite. Existing production runtime modules and all85 raw
SQL files are unchanged. Full feature/client/coverage/upgrade/reversal remains open.

Exact5c1ddd5 migration22/job117378639218 passes cosmetic15, inventory24 and existing
transaction/slow-query/TLS checks. Its throughput report passes the original-5%
ceiling at-4.0321937222349895%; all8 measured sources still match. The report is
[archived](benchmarks/transaction-throughput-ci-5c1ddd5-2026-10-17.json). That full
remote migration job fails the former deletion FK boundary; current complete-source
CI still requires observation. No full-job success is claimed. Current658 documents:
188 declared done,40 in progress,430 new; independently verified1.
