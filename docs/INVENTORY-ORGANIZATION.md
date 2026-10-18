# Inventory organization storage prerequisite

REQ-00348 remains in progress. Its original ten criteria cover seven sorting
choices, grouping/advice, protection and confirmed batch transfers, exact80%/95%
capacity warnings, operations below500ms, persistent preferences and desktop/mobile
UI. This migration prerequisite does not establish those feature behaviors.

The original20260627_060000 migration fails on V1 at statement13 because is_deleted
is absent. Later statements also assume combat_power/types/rarity on instances,
VARCHAR owners, one global candy counter and a SERIAL/TEXT-array team table.
Those assumptions conflict with the actual stored contracts:

| Resource | Authoritative contract |
|---|---|
| Pokémon instance | UUID owner/instance, cp, caught_at, original nickname VARCHAR(30), IV tuple and existing favorite flag |
| Species metadata | pokemon_species type1/type2 and rarity, including actual EPIC; no copied instance taxonomy |
| Candy | candy_inventory keyed by UUID owner plus species_id; a global balance has no known species attribution |
| Gym team | Existing UUID ID/owner and UUID array, owner/name uniqueness and six-member constraint |
| Deletion | Nullable deleted_at is the deletion fact; no second writable is_deleted flag or invented past deletion time |

The checksummed repair retains every original raw SQL byte and canonical table,
row, ID, view, foreign key and existing sequence. It adds protection/tags/priority/
deletion fields when absent, creates owner/CP/favorite/catch-time indexes over live
rows and indexes the actual secondary species type. Preferences use UUID owners.
Existing choices, custom groups, timestamps and sequence values are not reset.
Compatible timestamp function/trigger OIDs and operator-selected enabled states
are preserved; the expected update behavior is checked before adoption. Existing
UUID teams receive nullable used_at without replacing their identity or constraints.
No global candy table/balance or shadow instance metadata is created.

The repair refuses unknown deletion flags, global candy layouts, wrong field types,
missing ownership/size constraints, customized timestamp behavior and same-named
indexes with different definitions. The owned migration transaction rolls back all
its earlier DDL/writes on these failures. Existing global candy requires an explicit
species-resource adoption plan; unknown timestamps/levels cannot be fabricated.
Already-applied differing repair hashes likewise need an explicit upgrade plan.
This original up-only proposal has no verified complete data-preserving reversal.

Run the actual storage/CLI suite against a disposable PostGIS15 database with
permission to create/drop owned schemas and install V1 extensions:

```bash
cd backend
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 tests/regression/inventory-organization-storage.test.js
```

TEST_DATABASE_URL must identify that isolated database. Tests apply actual V1/V2
and the earlier gym team definition, retain real rows/views/FKs, execute real SQL,
verify the actual query index plan, exercise the genuine migration CLI/checksums and
refuse a modified immutable source. They also cover first adoption of saved choices,
exact old timestamps, nullable historical protection and unrelated update triggers.
The small-fixture index-plan check disables sequential scans to prove index
eligibility; it is not a response-time or production-capacity measurement. No SQL
handler or successful database result is fabricated.

The current complete seeded history passes inventory and cosmetics, then fails at
20260630_050000 statement2: data_deletion_tasks.request_id conflicts with the earlier
request identity. The whole pending batch rolls back. The former cosmetic boundary
at20260630_040000 statement13 is retained in exacta769b0d CI evidence; the independent
[cosmetic prerequisite](COSMETICS.md) fixes that reference without replacing data.
Full installation/upgrade/reversal and REQ-00007 remain open.

Inventory HTTP is still incomplete: the existing mounted router/advisor reads
nonexistent instance/species fields and is_deleted, transfers into the wrong global
candy resource, lacks coherent shared transaction/confirmation/protection/cache
semantics and uses a fixed300 capacity. Other instance consumers must respect
soft-deletion before transfers become usable. Real bond/level/evolution metadata,
EPIC taxonomy, saved-query preferences, all seven sorts/grouping/custom tags,
actual measured capacity thresholds, production response targets and working
client/mobile flows still require implementation and independent acceptance.

Final local validation:724 unit checks/24Jest suites425,379 actual storage/CLI checks
in20 sequential suites with no skips,1445 JavaScript syntax checks, actual inventory
module loads and the workflow/new gate parse all pass. Exact new remote source still
requires observation. None of these checks accepts the original complete UI/HTTP/
capacity/sorting/performance feature criteria.


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
