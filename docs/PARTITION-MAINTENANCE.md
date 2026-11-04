# Canonical partition maintenance

REQ-00060 and REQ-00626 remain in progress. The five actual created_at RANGE parents
are catch_records, location_updates, audit_logs, event_logs and payment_transactions.
The earlier migration already installed them and the guarded transactional DEFAULT
movement helper. The later proposal assumes different shadow names and tries to
replace partition_stats's size_bytes column with size, which PostgreSQL rejects.

The source-bound repair preserves all original SQL bytes, canonical parent/view/
helper identities, column contracts, dependent views, comments, sequences, history,
existing partition bounds and operator choices. It leaves partition_stats unchanged,
including an operator's custom definition. New operational functions use real,
current-schema catalog relationships rather than table-name patterns or that view.
Their exact signatures, returns, default expressions, body and configuration are
validated on rerun. Default expressions are deparsed before comparison because raw
PostgreSQL parse trees include source locations. Existing function ACLs/identities
are retained. A customized function or shadow schema requires explicit adoption.

New functions:

- minego_partition_children: actual direct children, parsed UTC bounds and DEFAULT.
- minego_partition_plan: current plus three future calendar months by default;
  monthly catch/audit/payment, daily location and the existing Tuesday weekly phase
  for events. The managed horizon is validated from1 through12 future months.
- minego_ensure_partition_horizon: parent lock, exact existing-bound reuse and actual
  guarded creation/data movement. A false success from the underlying helper is
  rejected by checking the resulting physical bounds. Overlaps fail atomically.
- minego_partition_live_stats: actual COUNT(*) and total relation bytes for each
  actual child; row counts do not count catalog entries or invent zero on errors.
- minego_partition_live_health: missing actual ranges and real DEFAULT row count;
  incomplete coverage/DEFAULT data are visible rather than unconditionally healthy.

The migration creates the current/three-future-month horizon on all five real
parents. Existing creation rules and matching ranges are reused; no empty shadow
parent is treated as a completed conversion. Historical/current rows of all five
parents, including actual geometry/JSON/payment amounts/audit identities, remain
exact. Backend helpers are security invokers; the maintenance database role needs
its actual catalog/DDL/count privileges. No role grant or production rollout is
assumed from fixture evidence.

The production gateway mounts /api/partitions with blacklist-aware authentication,
then signed-user and admin-role checks. Working operations are:

| Method | Path | Behavior |
|---|---|---|
| GET | /api/partitions/config/list | Actual managed tables/key and horizon |
| GET | /api/partitions/overview | All five real counts/bytes/children/health |
| GET | /api/partitions/stats/summary | Exact decimal totals and per-table summary |
| GET | /api/partitions/:tableName | Actual children and coverage/default health |
| POST | /api/partitions/:tableName/create | Create missing ranges; JSON months defaults3, legacy count also accepted |

API count/byte totals use decimal strings to preserve BIGINT accuracy. Prometheus
uses its native floating-point representation. Gauges report actual observed rows/
bytes, counters count physical new children/failures, and histograms time actual
operations. Removed children lose old metric labels. No cache or expired Redis JSON
is used as archive evidence. The old unmounted router called nonexistent manager
methods and lacked these access checks; real implemented operations now replace it.
Full archive/delete/restore/dashboard workflows remain required.

At startup, the gateway awaits actual precreation for all five parents. The owned
scheduler then refreshes daily, sequentially, and records/logs database failures.
First-run failures reject startup. Shutdown cancels its timer and awaits in-flight
work before releasing database pools, including failed-start cleanup. The actual
native gateway/user test verifies signed-admin HTTP/metrics, dependency readiness,
expected missing-IP-schema startup failure and natural signal shutdown with owned
PostgreSQL/Redis/Kafka. Other service targets alias the actual user fixture; that
does not prove acceptance of all eight services.

Run against an explicitly owned disposable PostGIS15 database:

```bash
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 --experimental-test-coverage \
  --test-coverage-include='**/partitionMaintenance.js' \
  --test-coverage-lines=80 --test-coverage-functions=80 \
  backend/tests/regression/partition-maintenance-storage.test.js
```

Set TEST_DATABASE_URL for that database.22 genuine PostgreSQL/storage/production-
router/CLI checks pass with no skips: preserved five-parent values/object contracts,
actual DEFAULT movement, UTC/leap-month/weekly phase, cross-schema exclusion, real
creation contention, truthful statistics and exact API totals, unauthorized/tampered
negative HTTP, live scheduling/fault/cleanup, original view failure/rollback and
unknown-function/shadow/overlap/false-success refusal. The actual new maintenance
module measures100% lines/94% branches/90.48% functions with the80% line/function
gate unchanged. This scoped coverage does not accept the whole older partition
manager/query optimizer/temperature/archive/UI implementation.

Current validation also passes724 unit checks (24 Jest suites/425 tests), actual
native gateway/user processes and1450 JavaScript syntax checks. Both workflows parse
with the new gate; native CI uses the actual PostGIS image needed by these contracts.
Owned local Redis/Kafka fixtures are stopped after sequential checks. Existing23
checks for audit conversion and4 for earlier partition history remain source-specific
prior evidence; they were not presented as a fresh combined suite in this batch.

Full85-source history passes this repair and weather storage, then fails
20260707_100000 statement5: CDC cache invalidation references nonexistent pokemon.
The whole pending transaction rolls back. Complete installation, differing-execution-
checksum upgrades and full reversal remain unaccepted.

REQ-00060's original9 criteria/50% performance gain/80% coverage and REQ-00626's
original12 criteria/60% gain,50ms/100ms P95,>70% S3 Parquet compression/backup reduction
and<30s recovery remain unchanged. Extra battle/trade/session/activity models,
actual caller query adaptation, retained-history upgrades, capacity/performance,
durable archive manifests/Parquet/S3 round-trip and recovery, retention/deletion,
backup benchmarks, monitoring alerts and admin UI still need implementation and
proof. Redis data with a one-hour TTL cannot establish durable archives. The new
migration does not install unverified pg_cron archive/drop jobs, assume hardcoded
archive tables or declare those features implemented. Payment retention proposals
also conflict; no deletion policy or legal/compliance sign-off is synthesized.

Exact preceding2e5fc2b main462 and canary18/erasure19/other migration correctness
checks pass, but throughput-6.352968581797381% fails the original-5% gate and its full
migration job fails the old partition view. The actual failed report is retained in
[the archive](benchmarks/transaction-throughput-ci-2e5fc2b-2026-10-18.json); all8
measured transaction sources still match. Earlier passes remain historical evidence,
not grounds to waive this failure. Latest full-source CI still requires observation.

The [PostgreSQL15 partitioning documentation](https://www.postgresql.org/docs/15/ddl-partitioning.html)
describes the native range, lock, DEFAULT and attach mechanics used here. Local
checks establish their exercised behavior, not the original production performance
or recovery targets.
