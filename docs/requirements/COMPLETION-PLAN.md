# mineGo requirement completion plan

Updated: 2026-10-08. Scope: all 658 existing requirement documents in INDEX.md,
including the 197 legacy done declarations that still need independent acceptance.
Do not run the hourly requirement generator or create additional feature scope.
Current declarations: 52 P0, 565 P1 and 41 P2; 432 new, 29 in progress. These counts
are inventory, not verified delivery. AUDIT.json and VERIFICATION.json are authoritative
for source hashes and evidence; WORKLOG.md records execution and failures.

## Execution order

| Stage | Work | Exit evidence |
|---|---|---|
| 1. Establish working services | Repair imports/dependencies, PostgreSQL schema identity conflicts, startup order, actual mounted routes and gateway paths. Start user/gateway first, then the other services. | Actual process startup, dependency-aware readiness, signed-user/admin HTTP probes, clean shutdown, upgrade and fresh-schema tests. |
| 2. Close security and data gaps | P0 authentication/MFA, rate limits, payments/idempotency, input handling, encryption, privacy opt-in, data export/deletion, anti-cheat and access control. | Real negative authorization/ownership tests, durable transactions, concurrency and rollback checks, collection opt-in and no unintended disclosures. |
| 3. Finish game and social features | Battle integration, catch/spawn, evolution/inventory/pokedex, rewards/events, friends/PVP/leaderboards, titles and the other existing feature requirements. | Production routes and real storage execute each acceptance case; events and downstream effects checked; client workflows tested. |
| 4. Complete client behavior | Game-client and web-client interface requirements, offline behavior, accessibility, localization, privacy settings, minor protection and AR flows. | Working build and browser/device scenarios against real services; exported screenshots/artifacts only when they prove acceptance. Hardware-dependent checks remain open without a device. |
| 5. Meet measured quality targets | Repair legacy integration/E2E and provider contracts, run real-target performance tests, logging adapters/overhead, cache behavior, coverage and regression requirements. | Relevant suites and gates pass without ignoring failures, simulated random successes, fabricated baselines or lowered thresholds. |
| 6. Verify operations | Kubernetes manifests and policies, migrations, monitoring/alerts, backups, restore, canary/rollback and regional recovery requirements. | Static checks plus isolated staging drills, restored data, measured recovery and actual alert/rollback evidence. Live deployment needs an identified authorized environment. |
| 7. Complete remaining documentation/tooling | Existing developer setup, architecture, API documentation, requirement/dependency tooling and remaining P1/P2 requirements. | Every documented command works and agrees with implementation; artifacts match source and production contracts. |
| 8. Final audit and delivery | Recheck all 658 documents, cross-service conflicts and stale evidence. Publish reviewable commits and update draft PR #6. | Every acceptance item has matching source-hashed evidence and relevant CI passes; remaining external inputs are reported explicitly. No automatic merge or production deployment. |

Stages express dependency order, not permission to skip P0 work until a later stage.
Within each stage, choose P0 first, then its prerequisites and in-progress items,
then P1/P2. Related requirements may share evidence only if all their individual
acceptance conditions are actually exercised. Discovery of a blocker does not stop
independent authorized work.

## Current batch

1. Preserve actual V1 audit data/IDs and business contracts while converting the real
   table to a partition parent; prove writes, logical-ID concurrency, views and rollback.
   This storage slice now passes23 real PostGIS checks; full REQ-00060 remains open.
2. V1 achievement/catalog/progress bridge and actual reward transaction now pass41
   storage/production-router checks. Continue event delivery/replay/automatic rewards,
   all seeded resource/title contracts, management/clients and full service acceptance.
3. Notification storage/routes/realtime/components pass35 actual storage and10 Chromium
   checks; current published notification workflow passes. Provider/outbox/all publishers/
   full game/performance/UI acceptance remains open. Friendship UUID identity/history now
   passes20 real storage checks, and privacy consumer ordering passes actual CLI probes.
4. Catch-risk storage/recorder passes34 actual cases. Special-IV/current ownership/
   generator and equipment prerequisite contracts now pass36. Complete85-file history
   reaches daily-quest :: syntax. Continue that consumer and later conflicts, complete
   upgrade/rollback/all-service startup, then all original P0/security/game/client/
   performance/operations stages. Unit623/storage215 pass; final IV36/source checks
   follow the latest fix. Full feature/numerical acceptance remains open.

## Definition of finished

For each document: read the full requirement, implement missing behavior, verify
module loading and mounted routes, run every applicable acceptance command against
real implementation, measure numerical targets, run required CI and record exact
sources/results. Reopen inaccurate done declarations. Preserve append-only history.
If criteria conflict with production schema or each other, document the conflict
and resolve it from repository contracts before editing acceptance language.

A commit, passing syntax or a mocked handler alone is insufficient. Optional external
services, email/voice providers, staging URLs, Kubernetes contexts, device-only checks
and production recovery drills must be identified and provisioned before their
associated requirements can be accepted. All locally achievable work continues
while these inputs are unavailable. No fixed completion date is claimed without
validated scope and environment readiness.


## First plan batch result (2026-10-07)

Title backend storage, authorization, concurrent switching, expiration and static
route order repaired; 20 definitions provisioned by an identity-compatible additive
bootstrap. Shared query builder exists, but its unsupported calls are removed from
the title service. Timezone import, ownership checks and client-supplied detection
repaired. Notification subscriptions are awaited; Kafka cleanup is concurrent and
failed subscription/admin connections are released. Real user-service process starts
and shuts down against an isolated PostgreSQL schema, Redis and Kafka. 608 unit checks,
13 title storage checks and 11 privacy storage checks pass. Core title storage regression
coverage is 96.67% lines, 81.48% branches and 92.86% functions; unit-only coverage remains
separate. Local warm title HTTP p95 is under 50ms. Full acceptance remains open.

Next: align gateway public/private aliases and all user-service route contracts,
then repair production-schema integration fixtures and title/achievement cross-service
storage conflicts. Carry the remaining stages forward from this file and WORKLOG.md.


## Persistent goal and IP appeal batch (2026-10-08)

The human explicitly activated the persistent goal for this full plan. Completed
local IP-appeal dependency, JWT/ownership, client-IP trust/forwarding, CIDR/white/expiry
read paths and proxy alias repairs. 613 unit checks, 9 real IP appeal/storage/ban/proxy
checks, 11 privacy checks and actual user-service process startup/appeal/shutdown pass.
Req-00075/00149 are reopened in progress. Full native gateway startup and remaining
IP automatic-ban/admin/GeoIP/sync/UI acceptance stay open. Next: start and validate
the real gateway, then continue the remaining route and production-schema contracts.


## Native gateway batch result (2026-10-08)

Actual gateway CLI now uses the shared lifecycle, waits for database/Redis/IP controls
before binding, cleans up failed initialization and naturally exits on SIGTERM.
Nonblocking warmup is tracked through shutdown; its cache cleanup timer is released.
Shared Redis URL and host/port configurations work; business-event routes reuse the
owned client. Global limiting uses the resolved client IP, and IP enforcement now
precedes even operational/device/security routes. Warmup management verifies admin JWT.
Readiness checks actual local dependencies and preserves names for unavailable peers;
liveness stays up during dependency failure. Native tests include a real user process
and actual UUID user/title/IP schema, Redis/Kafka, forwarded appeals and stored ownership.
Other registry targets alias that actual user fixture, not seven completed services.

613 unit checks, 33 actual storage/route checks and the native gateway/user process
scenario pass locally. Gateway signal shutdown ~937ms; user ~5148ms includes the local
subsequent outage probe, not a production SLO. REQ-00039 reopened in progress: game-table
warmup, full production migration history, quantification and coverage remain open.
Next: production-compatible game schema/warmup contracts and remaining user gateway
routes/admin authorization, then other service startup. Related CI pending this batch.


Gateway batch d276dbb: related remote CI passed main437, dependency243, privacy9 and
title/storage/IP/user/native-gateway6. These are partial verification results; API
contract/performance are red and legacy integration/contract/security/E2E acceptance
remain open. Next full schema probe: production-compose PostGIS15 image accepts all
V1 schema, but V2 seed fails a missing evolves_to=55 foreign key. Standard migration
CLI cannot resolve pg; diagnostic backend NODE_PATH gets as far as the moves migration
whose species25 seed is absent. All79 pending migrations roll back together, including
new history/lock tables. REQ-00007 reopened; next repair real CLI/fresh seeding and
migration contracts before accepting full-schema service/warmup behavior.


## Migration execution batch (2026-10-08)

Actual CLI dependency loading, exit/cleanup, transaction-held locking, checksum
validation and atomic apply/rollback repaired. Six production parser checks and ten
real PostgreSQL/CLI checks pass, including concurrency and an interrupted owned process
whose backend session is authoritatively observed to end. Gateway/user startup now
verifies checksums and optionally applies pending SQL before listening; 619 unit and33
business storage checks pass, both native process scenarios pass. Full V1/PostGIS and
V2 sample seed load with valid evolution links. All79 pending history still fails at
missing localized items catalog; a new full-history CI gate preserves that failure.
Next: reconcile/order true migration prerequisites and conflicting table definitions
without rewriting applied pending files, then complete full-history and warmup tests.
Other services still require real startup and migration integration; full658 scope
continues. This is substantive progress, not a blocking condition.


## Migration dependency/catalog batch (2026-10-08)

Source 07248db remote main439/dependency246/privacy11/title-storage-nativeprocess8
pass. Database migration1 tool/storage steps pass, full-history step fails at items;
contract/API/performance/integration/security remain red, E2E101 was still active.
Current batch adds explicit dependency order, execution-history order, original-source
and executed-SQL hashes, plus owned catalog/Pokedex prerequisites. Whole guarded SQL
corrections preserve raw legacy files while repairing invalid constraints/identity/
precision/seed syntax and actual inventory capacity/expiry helpers.

Local unit621, runner unit8, actual CLI13, catalog/inventory prerequisite2, business
storage33 and native process2 pass. Full V1+V2 still passes; all81 current pending files
(original79+2prerequisites) are gated. History now reaches the audit-table partition
conflict in20260610_100000. Req47/56/60 old done declarations reopened; no complete
requirement accepted. Next: preserve V1 audit IDs/columns/history and live write/query
contracts while implementing actual partition conversion and rollback, then continue
remaining migration conflicts and service/schema/warmup acceptance. Full658 scope stays
active. There is concrete progress; no blocked audit applies.


## Audit partition batch (2026-10-08)

Preserved V1 audit ID/sequence, all columns and rows, original storage OID, views,
indexes, grants and trigger state during actual conversion. Global logical-ID checks
handle cross-partition concurrency/date/ID updates. Bound/schema validation and atomic
default-row movement preserve data on failed attachment; concurrent creation is checked
after locking. Rollback retains post-conversion rows and additive fields.23 actual
PostGIS checks pass, including all five actual parent SQL writes/routing and guarded
unsupported upgrade cases. No full service or operational acceptance inferred.

Current82-file gate advances past audit conversion and pg_stat SQL to the achievement
completed-column conflict. Full V1+V2passes, pending batch rolls back. UUID owner repair
is partial; unify old/new catalogs/progress/rewards before accepting achievement APIs.
Req76 now in_progress:201legacydone/21inprogress/436new, all658 scope maintained.
Unit621, runner/prerequisite15, business/native35 and1414-file syntax pass. Prior source
f79 remote main/dependency/privacy/title-process pass; migration/contract/API/integration/
performance/security fail andE2E102 cancelled. No requirement promoted to verified.
Next: achievement/schema reconciliation, remaining partition/history/runtime contracts,
then continue all planned stages. This is progress; no blocked audit condition applies.


## Achievement storage and reward batch (2026-10-08)

Canonical V1 progress identity/key/FK/oldtier data retained. New catalog uses explicit
modern links, preserves31modern/8legacy definitions, numeric progress and unknown old
dates. Collisions and lossy reversal refuse safely. Existing title bootstrap orders
before the legacy achievement consumer; all published82 SQL sources unchanged, total83.
Actual service now serializes updates/completions/snapshots and commits real resources
with claim markers. Decimal arithmetic stays in PostgreSQL, incomplete increments do
not inflate points, and concurrent claims credit once. Real JWT routes/static ordering/
legacy user reads/ownership/titles/shared metrics pass41 actual probes.

Unit621, migration/prerequisite/audit38, businessstorage/native35 and syntax1415 pass.
Full V1+V2pass, complete83history now fails notification_type in message-center index
consumer; gate stays red. Replay/durable delivery/automaticgrant, complete resource/
title catalog, CRUD/authorization/snapshot policy, oldunit fixture, clients, native
pokemon/gateway and numeric performance remain open. All658 goal unchanged; no
requirement promoted complete. This is progress, not a repeated blocking condition.


## Notification batch (2026-10-08)

Actual production notification service now preserves canonical UUID/SERIAL history,
owner-scoped50 retention, real read timestamps, persisted legacy/modern preferences,
quiet-hour time zones and stable event receipts surviving deletion. Native user/gateway
exercise all eight HTTP operations and all seven Kafka→authenticated socket types.
Client component tests prove safe rendering, numeric IDs, real badges and private offline
caches/categories. Storage114, business/native35, Chromium10, unit623 and syntax1420 pass.
All84 history fails later at friendship pokemon_instance_id; V1/V2 still passes.
Req32/120 old done reopened, req99 started:199done/24progress/435new, independentlyverified0.
Remaining provider/retries/outbox/fullapp/UI/coverage/numerical acceptance is explicit in
NOTIFICATIONS.md. Next: preserve/reconcile friendship schema and later migration conflicts,
then all original stages. Full658 persistent goal remains active; no external blocker.


## Friendship and privacy ordering batch (2026-10-08)

Preserved actual UUID trainer bond relation/keys/FKs/data/levels/mood/timestamps and
multiple trainer rows. Named affinity is a generated projection. Actual signed delta
history replaces an invalid system_update/positive-only trigger sink; original update
trigger/function and disabled states remain intact. Unknown old trainer metadata stays
NULL; integer/custom logging/history conflicts refuse and actual metadata/history blocks
lossy down.20 real cases pass, including all256 values/concurrency/exact unused reverse.
Existing privacy compatibility precedes consumer; original text/date populate required
seed fields, optional defaults remain false and old choices/policyversions stay unchanged.
Actual CLI prereq4, parser8, combined storage147 and syntax1421 pass. Full V1/V2pass,
complete85history fails next catch_sessions catch_timestamp. Req67 reopened/79started:
198done/26progress/434new, independentlyverified0. Existing service auth/UUID/adapters/
resources/events/client/battle/evolution/coverage/numerical boundaries remain open.
Next: catch-session schema/history and later conflicts, full rollback/native services,
then P0 authorization and all original plan stages. Persistent goal is active; progress,
not a blocking condition. No production migration, merge or deployment.


## Catch risk storage batch (2026-10-08)

Gameplay UUID sessions/throws unchanged; distinctrisk telemetry uses actual owned throw
outcomes and commits counters/observations atomically. Missingdata staysunknown; failures
propagate; durable replay/unique evidence/concurrency and safe reversals pass34 realcases.
Hourly upsert/weightednumericmean/eventtimebucket/nondecreasinglatesttime fixed. Old
review's unevidencedsecurity/qualityapproval corrected; exactrequiredreview nowprovided.
Finalunit623/storage181/syntax1422pass. InitialunchangedHTTP5stimeout recorded; isolated44
and full623rerunpass withoutchanginglimits. Full85history nowfails special-IVcreated_at;
V1/V2stillpasses. Req82started:198done27progress433new, independentlyverified0. Realcatch
flow/APIs/security/classification/metrics/coverage/client/retention/numeric targets remain
open in CATCH-RISK.md. Next special-IV/latermigration contracts thenfullhistory/rollback/
allservice/P0security andeveryoriginalstage. Full658goalactive; genuineprogress.


## Special IV/equipment prerequisite batch (2026-10-08)

Truegenotypeflags and currentownercounts nowderivedfrompreservedV1UUID/IV/lucky/date data;
backfilldoesn'treplayoldtriggers. Safeusedreverse keepsprimarydata, customconfig/cache/
functionsrefuse. Realproducerhelper exclusivecategories and INSERT/return/cache flags
fixed;100000 realhelpersamples7/101/99892 observed, notnativeprobabilitycertification.
Equipment partialindex/UUIDhelper runs;actualcatalog33<required50.34initial/36finalreal
slicechecks pass, combined215storage/unit623/syntax1424pass. Load-onlyrequire passes,
nativeruntime/lifecycle remainsopen. Full85history nowfailsdailyquest::syntax. Req160
reopened/91started:197done29progress432new, verified0. Completeflow/UI/numeric/equipment
criteria remainin SPECIAL-IV.md. Next dailyquests/laterfullhistory/rollback/services,
thenalloriginalP0security/game/client/quality/ops. All658 goal remainsactive.
