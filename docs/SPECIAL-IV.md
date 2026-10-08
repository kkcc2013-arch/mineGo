# Special IV storage, generation and equipment migration boundary

The original special-IV migration grouped wild spawns by nonexistent created_at,
added false flags without classifying existing genotypes, maintained only insert
counts and inserted into missing game_configs. The whole source-SHA-bound repair
uses real spawned_at and preserves V1 UUIDs/keys/FKs/IV values/lucky flags/timestamps.
It does not invent spawn dates or clamp invalid historical IVs.

Zero/perfect flags derive from actual0/0/0 and15/15/15 tuples. Historical backfill
changes only new derived flags while user triggers are disabled under an exclusive
lock; original trigger identities/enablement are restored. It does not replay old
achievements or fabricate update dates. Insert/update/delete and trainer transfers
maintain current-owner counts, with stable owner lock order and atomic rollback.
Deleting a user does not resurrect its cache. Historical lucky IV values are preserved;
new lucky-floor behavior is a trade-flow condition, not invented historical repair.

The spawn-date materialization uses actual stored spawned_at. It is a snapshot and
still requires runtime refresh/metrics wiring. New configuration defaults are inserted
only when absent. Existing operator values/metadata survive, including a table without
an updated_at default. A same-name table elsewhere in the search path is never adopted
or changed. An unused or used repair can remove owned derived flags/caches while
retaining current original data: classification is reconstructible from actual IVs.
Changed configuration/relation identities/custom cache fields/functions refuse reversal.
Unknown prior IV schemas or contradicting flags require explicit reconciliation.

The production generateWildIVs helper has exclusive zero[0,0.0001), perfect[0.0001,
0.001), ordinary[0.001,1) categories, matching the explicit0.01%/0.09% acceptance
intervals. Ordinary raw/bonus-adjusted extreme tuples are redrawn; they no longer add
unclassified zero/perfect cases above those categories. Invalid configuration/draws
and a pathological random source fail instead of hanging. Actual location-service
uses this helper, writes flags, returns the persisted tuple/flags and includes them
in its detail cache. Older active-cache reconciliation and full native spawning still
need acceptance. No cached source is used as a substitute for database truth tests.

36 actual PostGIS/production-generator/source-SQL checks pass: original data/key/OID/
trigger/view/FK preservation, exact classification/current ownership, mutation/trades/
deletes/concurrency/cascade/rollback, custom schema and safe reversal, actual spawn
INSERT/return and helper boundaries. The actual existing trade lucky-floor SQL fragment
is tested on real records; this is not complete authenticated trade-process acceptance.
A100000-invocation real generator probe observed7zero,101perfect,99892ordinary in the
latest run (0.007%,0.101%). An earlier probe observed12/88/99900. These are measured
local helper observations, not a fabricated native-spawn sample or full probability
acceptance. Every original numerical target remains in scope; statistical protocol,
full native spawn/trade distribution and cross-client workflows remain open.

## Equipment consumer

The next legacy equipment consumer had invalid inline partial UNIQUE syntax and a
BIGINT lookup helper for UUID Pokémon. Its whole SHA-bound repair expresses the exact
original active(Pokémon,template) rule as a PostgreSQL unique index and uses actual
UUID identity in the helper. Four real tables load; inactive copies coexist, duplicate
active templates fail, UUID helper returns actual equipment/calculated stats and FKs
reject made-up identities. All original seed values remain unchanged. Actual catalog
count is33, below the original minimum50. Full one-per-type slot policy, ownership/
API/inventory/upgrades/resources/sets/drop/shop/rewards/battle/client/metrics/coverage
and40 original test-case criteria remain open. This syntax/helper slice does not close
REQ91 or silently lower its thresholds.

## Reproduce

Use Node24 and an isolated PostGIS database through TEST_DATABASE_URL:

- node --test backend/tests/regression/special-iv-storage.test.js (36 current checks).
- Earlier combined storage215 passed; final36 repeated after config namespace protection
  and actual spawn-return verification. Unchanged unit623 passes; syntax1424 passes.
- Actual modified location module require-only smoke passes with an explicitly stopped
  test process. It does not prove dependency readiness or natural signal shutdown. A
  prior live import probe exceeded its termination wait; later process inspection found
  no matching process. Native location lifecycle remains open, not claimed successful.
- node --test backend/tests/regression/database-bootstrap.test.js:V1/V2passes; complete85
  pending history reaches20260614_090500 statement2, invalid daily-quest :: syntax. The
  whole pending batch rolls back, no migration is omitted. All85 raw sources unchanged.

Req160's old done claim is reopened. Required badges/detail/Pokedex client routes,
full native location/catch/social/gateway flow, measured lucky5%/floor and spawn
probabilities, config consumption/cache refresh and regression acceptance remain open.
No production migration, merge or deployment is performed. The full658 goal continues.
