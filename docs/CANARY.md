# Canary storage and runtime boundaries

REQ-00078 remains in progress. Its original1074-line document ends with an incomplete
11th acceptance line; all11 original checkbox lines remain unchanged. API creation,
real percentage routing,5→25→50→100 promotion, measured health, automatic/manual
rollback, all strategies, consistent routing, complete history and live monitoring
still require independent runtime/operations acceptance.

The earlier20260611_102500 source-bound repair already creates SERIAL deployments,
history and metric snapshots with a service/status partial unique index. The repeated
20260701_110000 proposal contains invalid inline UNIQUE...WHERE syntax even when the
tables already exist. Its checksummed repair preserves original raw source and all
existing IDs/rows/statuses/rules/choices/baselines/times/integer actor metadata,
sequences/views/FKs/operator comments and the earlier index. It adds request logs
with an actual parent/cascade contract. No rollout or metric history is synthesized.

The manager expects one active rollout per service, while the earlier service/status
index permits both an active and promoting row. A separate partial unique index
now enforces that expectation across both states. Existing ambiguous pairs require
explicit adoption; no row is discarded or silently completed. Actual concurrent
active/promoting inserts produce exactly one success and one uniqueness rejection.
Completed history can coexist with a new active rollout.

Both original proposals omit created_at even though actual runtime readers order by
it. Existing unknown creation times remain NULL. Only new rows get an actual default
timestamp. Reruns retain an operator's existing default. The owned update function
and trigger are validated/preserved, rather than unconditionally replaced. Wrong
parent identity, missing FK, disabled/customized updater, altered active index and
missing partial predicate are refused atomically. NULL-safe predicate comparison
also closes the same missing-predicate adoption gap in the independent erasure repair.

Validation uses actual V1/V2, the actual earlier SQL repair, real PostgreSQL, retained
rows/views/constraints/OIDs/sequences/comments, genuine migration CLI up/up/verify
and separate raw/executed checksums. The final sequential command runs18 canary and
19 erasure checks (37 total, no skips) against an explicitly owned disposable database:

```bash
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 \
  backend/tests/regression/erasure-schema-storage.test.js \
  backend/tests/regression/canary-schema-storage.test.js
```

Set TEST_DATABASE_URL to that database. Two pool workers are used only for the real
creation race; other heavy checks run sequentially. Full85-source history now passes
canary, then fails20260707_060000 statement6: the partition proposal tries to replace
a view column size_bytes with size. Entire pending batch rolls back. Full fresh
installation, differing-execution-checksum upgrades and reversal remain open.

The runtime probes execute the actual manager with its real shared database pool,
then close that pool naturally. The database compatibility alias does exist. An
initial incorrect expectation of a missing alias was removed after inspection; it
was not a production bug. Actual manager reads work after the SQL repair, but:

- No request samples become errorRate0/latency0/successRate1. An all503 sample also
  reports successRate1 because the current numeric fallback replaces a real zero.
- Creation persists deployment/history before failing at EventBus.publish, which
  is an instance method used as a static method. This is partial state after failure.
- Loading the real API fails because requireAdmin is not exported by gateway auth.
- The real metric recording helper throws on unsupported Counter.increment.

These are observed integration failures, not accepted behavior. The gateway does
not mount the canary API/router or consume its version selection in the actual
proxy. Authentication/authorization, transactional state/event handling, truthful
health with sample minimums, promotion state transitions, cache reconciliation,
actual upstream selection, metrics, lifecycle, CLI/workflow/admin tokens and staging
rollback/routing timings need implementation and acceptance. No live canary or
production deployment has been performed.


## Current installation checkpoint (2026-10-18)

The independent [partition maintenance implementation](PARTITION-MAINTENANCE.md)
now preserves canonical view/history contracts and runs actual protected creation/
statistics/metrics/lifecycle.22 new real checks, native gateway/user,724 units and
1450 syntax pass; prior broad business suites were not rerun. Full85-source history
passes partition/weather and fails CDC20260707_100000 stmt5 missing pokemon, with
entire pending rollback. Latest preceding2e5 main462/canary18/erasure19/correctness
pass, but original throughput gate fails at-6.352968581797381% against unchanged-5%;
[actual failed report](benchmarks/transaction-throughput-ci-2e5fc2b-2026-10-18.json)
is retained with all8 measured hashes still matching. Earlier passes do not waive
this failure. New full-source CI and all original full-feature criteria remain open.
Current186done/42in_progress/430new,658 documents, independently verified1.
