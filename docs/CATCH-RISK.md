# Catch risk storage and observation contract

The canonical V1 catch_sessions table stores UUID gameplay sessions and is referenced
by catch_throws. The later REQ82 migration reused that name for integer risk-request
records with different fields. The whole SHA-bound repair keeps gameplay sessions,
throws, UUID keys/FKs/OIDs, rewards/result values and existing rows unchanged. Risk
requests use catch_risk_attempts instead. No wild Pokémon, session or UUID is invented
to make a rejected/invalid request look like gameplay. All85 raw pending SQL files
remain byte-identical; the complete executed repair and its hash are recorded separately.

Original common/rare/epic/legendary base-rate seed values live in catch_base_rate_config.
They are configuration, not system/config user rows in observed catch statistics.
Existing custom risk tables or noncanonical integer gameplay identities require an
explicit data-preserving reconciliation plan; this repair refuses to overwrite them.
An unused repair can reverse while leaving gameplay data/identity unchanged. Real
telemetry/statistics/decisions/counters or changed configuration refuse lossy down.
Replacement relation identities are checked before reversal.

## Production recorder

CatchRiskEngine accepts an actual pool through its optional db constructor argument;
its default is the production shared pool. recordCatchSession stores risk telemetry,
hourly observations and user counters in one transaction. It returns an actual committed
risk UUID. Write failures propagate and roll back every part; no fictional saved ID
or clean history is returned after a database error. This repairs the old swallowed
failure path and uncoordinated counter writes.

The optional auditId identifies a durable risk event. Same owner and exact snapshot
replay returns the existing ID once, including concurrent writers; changed payload or
owner fails. New IDs using the same observed throw cannot duplicate the observation.
Omitting auditId creates a new real request ID; it is not general event deduplication.
Updates to audit rows are refused; corrections need a separate event/reconciliation
process. Replay guarantees require retaining the durable audit row. Deletion/retention/
GDPR reconciliation remains open.

An actualResult success/fail/escape requires a real throwId. PostgreSQL resolves its
canonical session, owner, wild Pokémon, success boolean, ball, rating, curve flag,
probability, species rarity and native thrown_at. Client-declared values cannot override
those observed fields. Foreign/nonexistent/mismatched evidence fails, and escape additionally
requires actual FLED session state. Unobserved or blocked requests keep outcome/catch
time unknown; they increase risk-request counters without fabricating catch attempts
or successes. Unknown item quantities, probabilities and integrity scores remain NULL.
Coordinates support zero and preserve declared request location rather than pretending
it is server-verified. This recorder accepts a provided risk decision; it does not prove
that decision's classification accuracy.

The original TIMESTAMP throw time is retained. Observed hourly buckets derive from that
actual value using the database session TimeZone, not ingestion NOW or a JavaScript
local-to-UTC conversion. Historical timezone reconstruction and cross-region policy
remain open; no absent timezone is recovered by this change. Late telemetry therefore
stays out of current24-hour rates. Latest catch time uses the actual maximum and cannot
move backwards when older events arrive after newer ones.

CatchSuccessRateAnalyzer uses a single atomic upsert per user/Pokémon/rarity/ball/hour.
First observations count once; concurrent writers retain counts and exact numeric
expected-probability sums. Ratios use the updated numerator/denominator; cross-dimension
expectations are weighted by actual attempts. With an auditId the observation must match
owned canonical audit evidence. The engine calls this helper once in its same transaction.
Standalone calls without that identity count trusted server observations at their actual
invocation time; callers still need their own durable source identity/ingestion policy.
Intervals are bounded integer parameters, not interpolated SQL. Empty observations
return zero counts with unknown rate/expectation/anomaly fields; outages propagate.

## Reproduce and acceptance boundary

Use Node24 and an isolated PostGIS database through TEST_DATABASE_URL:

- node --test backend/tests/regression/catch-risk-storage.test.js:34 actual V1/PostGIS/
  production-class cases, including evidence binding, replay/concurrency, counters,
  weighted rates, old-event timing, rollback and preservation/unsupported-schema guards.
- Combined CLI/prerequisite/audit/achievement/notification/friendship/privacy/catch-risk
  storage suites:181 pass. npm test --prefix backend:623 pass on the final rerun.
- node scripts/check-js-syntax.js:1422 files pass. Module loading and workflow YAML/
  inventory/hash/diff checks also pass.
- node --test backend/tests/regression/database-bootstrap.test.js:V1/V2 passes; all85
  pending history fails20260613_160000 statement17 missing created_at in the special-IV
  consumer. The entire pending batch rolls back. No scripts are skipped.

The initial broad unit run hit an unchanged HTTP fixture's5-second timeout. Isolated44
and subsequent complete623 reruns pass with the original limit. Initial evidence is
retained; no timeout/performance threshold is weakened. Initial risk SQL testing also
exposed mixed integer/numeric parameter inference; explicit casts corrected the real
upsert before the final checks. Rarity assertions follow the actual sample catalog.

REQ82 remains in progress. The actual catch-service session/throw flow still does not
mount or invoke CatchRiskEngine. Six required APIs/JWT/admin ownership, signing/nonces/
mandatory validation, replay prevention, real location/inventory/item/device checks,
true sliding windows, failure-closed decisions, scoring/Bayesian/stratification policy,
shared registry/five real metrics, original unit fixtures/coverage80%, review/client/
visual reporting/native process wiring and <50ms/99.9%/90%/0.5% numerical acceptance
remain open. Signature default key/padding, permissive integrity threshold and fake
location/inventory checks are known unfinished code; these checks do not certify that
validator. New storage tests exceed30 cases but do not substitute for full unit/feature
coverage or measured accuracy. See the current review for the retired old acceptance
claims. No production migration, merge or deployment is performed.
