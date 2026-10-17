# REQ-00082 independent acceptance review

Status: partial implementation, not accepted as complete (2026-10-08).

The prior system-review report approved file existence and claimed security/accuracy
without authoritative execution or measurement. Its historic text remains available
with an explicit correction. The original requirement and every threshold remain in
scope; this review follows the actual production module, V1 schema and tests.

Verified slice:34 real PostGIS/production-class checks preserve gameplay sessions and
throws, bind outcomes to owned actual throw evidence, reject nonexistent/foreign/
contradictory outcomes, distinguish risk requests from observed catches and commit
telemetry/counters atomically. Durable audit replay and unique throw evidence prevent
duplicate effects. Atomic hourly counts/weighted expectations, late-event buckets and
nondecreasing latest catch time are exercised. Unused reverse preserves original data;
actual risk/configuration and unknown preexisting schemas refuse loss.

Broader local evidence:181 storage cases, final623 unit checks and1422 syntax files
pass. The first unit run timed out in an unchanged HTTP test; isolated44 and full623
reruns pass with unchanged limits. Full V1/V2 bootstrap passes. All85 pending migrations
fail later in20260613_160000 at missing created_at; whole pending batch rolls back.
Current source CI awaits publication. Results do not certify complete migration history.

Missing acceptance: real catch-service/native gateway integration and six mounted,
authenticated/owned/admin APIs; secure signing/nonces/mandatory integrity checks; actual
location/inventory/device/item validation; true sliding windows and durable delivery;
classification/Bayesian/stratification policy and failure-closed admission; five shared
metrics; full original unit fixtures and80% coverage; client/reporting integration; real
measured <50ms decision latency,99.9% signature success,90% blocking and0.5% false positives.
No labeled dataset or numerical result is fabricated. Recorder fixtures supply decisions
and verify their storage, not classifier accuracy.

The current validator still has hardcoded successful location/inventory checks, a
fallback signing key/padded signatures and permissive60-point admission. Two score
components remain zero and rolling counters use renewed expiry. These are unfinished
security paths. The source is not represented as deployment-ready.

See [implementation/storage contract](../CATCH-RISK.md),
[requirement](../requirements/REQ-00082-catch-success-anomaly-detection-system.md) and
VERIFICATION.json for source hashes and exact remaining criteria. No production
migration, merge or deployment is included.
