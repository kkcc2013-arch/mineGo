# Cosmetic storage prerequisite

REQ-00125 remains in progress. Its original15 criteria include five database tables,
actual catalog/inventory/purchase/equip/preset APIs, category slot limits, automatic
expiry cleanup, a working client panel, real metrics, at least90% unit coverage and
an integrated complete purchase flow. The SQL prerequisite below does not implement
or accept those features.

The raw20260630_040000 proposal uses INTEGER user references and a VARCHAR Pokémon
reference against canonical UUID identities. The previous published repair fixed
three user references but missed pokemon_instance_id, leaving the whole migration
batch blocked at statement13. The updated source-bound repair uses all four actual
UUID references and verifies the seven ownership/catalog foreign-key contracts.
Unsupported existing identities or missing reference constraints require explicit
adoption; no numeric/string historical ID is guessed or cast into a different owner.

All85 raw pending SQL files remain immutable. The five cosmetic tables retain their
identities, rows, serial sequences, views, foreign keys and existing comments. All13
original multilingual catalog definitions, categories, assets/positions and intended
initial coin/gem prices are retained. Default gem prices apply only when inserting
new seed items; the former broad UPDATE statements no longer overwrite operator
prices or catalog changes. This does not verify the referenced external asset URLs.

Existing statistics are retained, including their precise BIGINT revenues. Tests
compare database JSON as text so JavaScript cannot round64-bit monetary values.
For old catalog entries missing statistics, the repair derives only observable
active distinct owners and the number of stored equipment rows. It leaves historical
purchase counts and revenues NULL because inventory cannot establish those facts.
Only genuinely new catalog definitions receive initial zero historical counters.
Expired grants remain intact; this migration does not implement or claim automatic
expiry cleanup or reconciliation of old statistic drift.

Run sequentially against an isolated PostGIS15 database with administrative fixture
permissions, using TEST_DATABASE_URL for that disposable server:

```bash
cd backend
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 tests/regression/cosmetic-schema-storage.test.js
```

The suite executes genuine V1/V2 and actual SQL: both earlier errors/rollback,
five-table creation, every seeded field compared against the minimally UUID-corrected
original, real owner/Pokémon FK enforcement, old catalog/grants/presets/prices/
statistics/OIDs/views/FKs/comments/sequence preservation, missing-history derivation,
unsupported-schema rollback and the actual CLI's separate raw/execution checksums.
No SQL result is mocked. CI enrolls this suite before the complete migration gate.

Complete V1/V2 seeding passes. The full history now passes cosmetics and fails next
at20260630_050000 statement2: data_deletion_tasks.request_id cannot reference the
existing data_deletion_requests identity. The entire pending batch rolls back;
complete fresh installation, existing differing-repair upgrades and data-preserving
reversal remain unverified.

A repository search finds no actual cosmetic service, router, metrics module or
client panel corresponding to the examples embedded in the1307-line requirement.
Those artifacts and their mounts must be implemented and exercised. Canonical users
have coins/premium_coins while the proposal uses a nonexistent gems field; paid
balances, entitlement/ownership/slot concurrency, atomic presets, expiry, events,
cache scope/invalidation, observability, client/assets and coverage need actual
production integration. Nothing here establishes the original90% service coverage
or the full purchase/feature criteria.

The independent original/current fixture schemas share real uuid-ossp/PostGIS/
pgcrypto extension APIs installed in public on the owned test database. An initial
nested-schema comparison exposed the namespace dependency; correcting setup keeps
the all13-field comparison intact and is not a weakened assertion.

Final current-source validation:724 unit checks/24Jest suites425,394 actual checks in21
sequential storage/CLI suites/no skips,1446 syntax checks and actual migration module/
workflow/new cosmetic gate parse pass. The final15 cosmetic cases retain full13-row
seed equivalence and exact BIGINT comparison after proper shared-extension setup.
V1/V2 passes; entire85-source history still fails deletion20260630_050000 stmt2 and
rolls back. All15 original cosmetic criteria/≥90% and85 original SQL bytes remain
exact. Exacta769b0d main459/inventory24/throughput-1.6979621741050943% pass; new full
source CI remains to be observed. No new local benchmark rerun for unchanged8
measured transaction sources. Full runtime/client/numerical/upgrade/reverse remains
open. Current declarations189done/38in_progress/431new,total658, verified1.


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


## Latest installation boundary (2026-10-18)

The independent [canary repair](CANARY.md) now preserves original rollout history
and provisions real logs/one-active-service uniqueness. Final18 canary+19 erasure
checks pass sequentially, including missing partial-predicate refusal. Full85-source
history advances to partition20260707_060000 stmt6 size_bytes→size view conflict;
entire pending batch rolls back. Existing business runtime/runner and8 measured
transaction sources remain unchanged. Prior394 checks/21 suites were not rerun.
Exact40a98d3 main461 and migration23 correctness (including erasure18) pass, with
[throughput-2.76910724385816%](benchmarks/transaction-throughput-ci-40a98d3-2026-10-18.json)
meeting the unchanged-5% ceiling. That full remote job fails former canary syntax;
latest full-source CI still requires observation. Current658 documents retain all
criteria:187 declared done,41 in progress,430 new; independently verified1.


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
