# mineGo requirement completion plan

Updated: 2026-10-16. Scope: all 658 existing requirement documents in INDEX.md,
including legacy done declarations that still need independent acceptance.
Do not run the hourly requirement generator or create additional feature scope.
Current declarations: 52 P0, 565 P1 and 41 P2; 432 new, 36 in progress;190 declared done, including one independently verified framework. These counts
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
   now reaches20260627_041000 statement14 round(double precision,integer) after the explicit deadlock/currency/canonical partition/voice/move/title/quest repairs.
   Continue modern quest transactions/grants/events/date contracts and move identity/
   catalog/reward/gameplay/lifecycle integration, complete
   upgrade/rollback/all-service startup, then all original P0/security/game/client/
   performance/operations stages. Prior unit623/storage279 pass; latest title/reward/quest40 checks repeat sequentially
   with the guarded earlier title bootstrap. Full feature/numerical acceptance remains open.

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


## Daily quest storage and atomic legacy claim batch (2026-10-08)

Original22seeds/7categories/date semantics preserved; invalid inline::date uniqueness
and two indexes repaired through whole source-bound copy. Canonical V1daily_quests
remains separate/unchanged. Actual reward-service mounted route now owner/quest-locks,
checks real progress afterlock and commits four real balances/claim/completion markers
together. Replays/foreignJWT/bodyID/invalidtargets/deletedowners cannot grant; failure
rollsback and original completion timestamp preserved. Actualappfactory permits safe
HTTP tests; directlisten retained, no native lifecycle acceptance.18actualcases pass
including24simultaneousclaims andcurl. ModerntransactionAPI/delKey/grants/events/auth/
streak/date/cache/history failures documented; req97false done reopened. Inventory
196done30progress432new/658original, independentverified0.

Broaderstorage235passed; title/IP preconditionfailed without TEST_REDIS_URL, corrected
fixtureenvironment then22pass (257successful actualchecks across scopes). Unit623pass,
syntax1426pass, raw85sources unchanged. Initial quest assertions incorrectly treated
BIGINT XP asnumber and local TIMESTAMP asUTCdate; corrected exactBigInt/SQLtext assertion,
18finalpass. FullV1/V2pass; all85history reaches20260615_170500stmt16 existingtitletrigger
collision and pendingbatch rollsback. Original modern criteria/thresholds remainopen.
Previousbe551CI main447/dependency261/privacy19/title-native16/browser4pass; migration9
actualIV36pass (job113354989868 logs) thenquest::failure. Contract372/API76/perf115/
integration422/security405fail; E2E109in_progress atread, no inventedterminalstate.
Next modern quest atomicstorage/grants/events/security/datecontracts and titleupgrade
collision, rewardleaderboardSQL injection/rank alias and otherP0/service prerequisites,
then all original game/client/numerical/ops requirements. No new requirement, production
migration, merge or deployment. Goal remains active; progress and no external impasse.


## Title upgrade and reward ranking batch (2026-10-13)

Earlier title bootstrap and later consumer now guarded via complete source-bound copies;
matching update function/trigger OIDs/enabled state, catalog/operator values and owned
rows/keys/views survive. Unknown body/security/searchpath/volatility/event/condition
metadata refuses atomically in both stages. Original85raw SQL unchanged.13upgrade cases
pass. Changing applied executed hashes remains an error; no hidden history rewrite or
production upgrade. Full85V1/V2history advances to20260615_221000stmt3 missing moves.name
in damage consumer; rawmoves has canonicaluppercaseID/requirednames/type/category/
energy/duration fields. Complete pending transaction rollsback, no omittedfiles.

Mounted rewardranking SQL no longerinterpolates team input; signedowner/team parameters,
fixedscore allowlist/scalarenumchecks andone actualsnapshot forlist+rank. Realcanonical
catch_total replacesfakeXP score; ownedPokemoncountseparate. BIGINT XP JSONtext preserves
precision; competitionties/UUIDdisplayorder/scope/top100/fullrank consistent.9realcases
pass, includingattack/object/array/prototype rejection beforeSQL.18legacyclaim checks
repeat afterapplicationchange. Full7socialtypes/seasons/events/rewards/cache/client/
metrics/numerical scope remainsopen. Req255false done reopened; priorreview's fabricated
measurements/regextoacceptance withdrawn. Inventory195done31progress432new/658; full
independentverified0. Full658 goal unchanged and active; genuine progress.

Prior279storage/unit623passed in authoritative terminalhandles; after earlierbootstrap
repair, sequential40(title13/rank9/quest18)pass. Syntax1428pass; actual rewardrequire
exitsnaturally withoutlistener, load-only notnative readiness proof. Prior55fCIterminal:
main448/dependency263/privacy20/title-native17/browser5pass; migration10quest18pass
(job113364721383logs) thenexistingtitletriggerfail. Contract373/API77/perf116/integration
423/security406fail;E2E110cancelled. CurrentbatchCIpendingpublication.

Next reconcile actual move identities/requiredfields/operatorvalues, fullhistory/rollback/
native services; modern quest realtransactions/snapshots/grants/events/security/date
contracts andalloriginalP0/game/client/quality/ops stages. No new requirement, merge or
deployment. Test concurrencylimited; no Maven builds. Personal preference memory files
remain local. Owned test fixtures cleaned; stopownedPostGIS/Redis afterterminalchecks,
unrelatedgatewayuntouched.


## Canonical move and damage batch (2026-10-13)

Actual uppercase IDs/localization/types/power/energy/duration/rows/FKs/TM/learnset and
relation identity preserved. Fullsource-bound damage repair provides read-only lowercase
identity and BIGINT consumed-energy projections, uniqueness, explicit base dependency
and all24 original proposed defaults as configuration, not active-catalog replacement.
Unknown writable aliases/identity ambiguity and modified defaults/comment/index/OID/
dependent-view reversal refuse. Exact preexisting projections stay operator-owned.
Exclusive reversal locks protect comparison/removal. Original85 rawSQL unchanged.

Real MoveService adapter and owner/instance/inventory locks fix concurrent TM spend,
stale selection/ownership; actual learning/switch/forget and rollback cases pass. Existing
move router's parseInt(UUID) bug corrected, typed query/body/UUIDs and signed ownership
validated, every named production-router read/action endpoint tested; unexpected DB
errors remain server errors. Damage canonical queries replace nonexistent name fields
and fakefallback. Both mounted aliases and root damage_multiplier support original
command. Actual damageEngine used; deterministic midpoint/ranges includecrit, immune/
zero-power returns0 estimates, strictfinite/own-key/random validation.58 oldassertions
and5newcontracts integrated into main gate; local battle/damage checks sequential.

Final32 real storage/HTTP and17CLI/prereq checks pass; main686 andsyntax1432pass. Native
gym actualentrypoint HTTP200/multiplier0.5/EMBER observed; ownedKafka unavailable. Child
didn't stop within diagnostic3s SIGTERM observation, force-killed and terminalSIGKILL
observed/schema cleaned; durable diagnostic exits1.3s is observation limit, not new
acceptance threshold; no natural/graceful shutdown/readiness claim. Full V1/V2pass,
all85 reaches voice20260618_160000stmt18 mutableindexpredicate and pendingbatchrollsback.
Originalgame/client/livebattle/native/GO-wording/coverage/metrics/numerical/ops stayopen.
Req19/146old done reopened:193done33progress432new/658; independentlyverified0.

Earlytests exposed PLpgSQL CASE predicate syntax, incorrect expected generated-column
error text and a single-item query array that serialized as scalar. Fixed CASE grouping,
assert actual SQLSTATE428C9, test repeated differing query values.32finalpass, no relaxed
thresholds. Previous main test handle later missing; authoritative completed summaries
and no matching active job observed, not restarted from observation timeout.
Prior6e13CI main449/dependency265/privacy21/title-native18/browser6pass; migration11
combinedtitle/rank22pass (job115067740964logs) thenoldmoves.namefailure. Contract374/
API78/perf117/integration424fail; E2E111cancelled; security407 stillin_progress atread.
No inventedterminalstate. CurrentbatchCIpendingpublication; no fullrequirement accepted.

Next voice-chat mutableindex/fullhistory and native gym provider/socket/timer shutdown,
then all original P0/security/game/client/quality/ops and remaining modernquests. No new
requirement, production upgrade, journal rewrite, merge or deployment. Personal memory
preference files remain local; no Maven or all-core jobs. Goalactive with genuineprogress.


## Voice index prerequisite and next partition conflict (2026-10-13)

Published move/damage batch d87da14f948c05615eca777737eb35444ed898d4 to draft PR6;
verified remote head/draft state. Main CI450, dependency267, privacy22, title19 and
notification7 succeed. Actual move storage32 succeeds in migration job115247597349;
whole migration12 fails the source-specific voice NOW() predicate. Contract375,
API79, performance118 and integration425 fail; E2E112/security408 were still running.
No complete requirement is accepted from these scoped successes.

Reopened legacy done REQ-00116 after reading original16 criteria, retaining every
threshold. Source-bound voice repair uses (user_id,expires_at) with revoked_at IS NULL;
queries evaluate current-time expiry. It never mislabels NOW() IMMUTABLE or deletes
history. Exact operator index is reused preserving OID/comment; unknown definition
refuses atomically. Six actual PostGIS/CLI cases pass, including original42P17 failure,
membership histories, real EXPLAIN/filtering, expired/revoked audit retention, preexisting
views/FKs/OIDs and actual original/executed checksums/idempotent rerun. First CLI test
wrongly expected a raw-file execution digest; corrected to the actual documented
runner digest of parsed up/down JSON, then all6 passed. CLI/prerequisites17 pass;
syntax1433 and actual TURN-manager load pass. No Maven or CPU saturation.

Complete85 original source files remain unchanged. V1/V2 passes; full history now
fails20260619_000000 statement17: duplicate partition helper changes BOOLEAN to VOID.
Earlier canonical partition conversion/helper must retain data, identity and behavior;
later duplicate shadow layouts also have conflicting child names/time bounds. Next
work reconciles these with actual canonical parents and real storage, rather than
replacing functions, losing data or skipping migrations. Full-chain rollback still open.

Voice HTTP routes remain unmounted; signaling identity is random placeholder. TURN
validator ignores revocation and uses absent usage columns; routes fail to await
credentials/call absent ICE method; room service references absent fields. These are
recorded as unfinished, alongside original real audio/provider/game/permission/numerical/
client/operation criteria. Audit declarations now192done/34in_progress/432new, total658;
independently verified0. Persistent all658 goal stays active.


## Canonical duplicate partition history repair (2026-10-13)

Voice commitceaf5b0dd4306a389bc36a9b764addd214008727 pushed; origin ref and exact
GitHub CI prove publication. PR description update hit transient TLS EOF; no secret
printed. Host restart stopped owned PostGIS: first fullgate ended ECONNREFUSED.
Restarted only owned PostGIS, checked actual readiness, then repeated fullgate.
Unrelated containers untouched. No process restarted merely on observation timeout.

Source-bound duplicate partition repair declares dependency to actual earlier
conversion. Original raw42P13 helper BOOLEAN-to-VOID failure is reproduced. Preserve
five real parent OIDs/data and helper definition/ACL/config/comments, actual views,
canonical June9 weekly phase and actual DEFAULT-to-range movement; no empty shadows.
LaterJune8 proposal overlaps existing ranges: preserve old boundaries and addJune2-9
range. Actual status follows current-schema inheritance; exact view reuses OID,
custom shadow/regular-parent/status definition refuses atomically. Original raw SQL
unchanged, later shadow management still unreconciled.

4 new actual history checks +23 audit checks pass27; CLI/prereqs17 and syntax1434
pass. V1/V2 passes. Full85-source gate now fails20260624_133000 statement16 missing
payment_orders; real payments use V1 orders/amount_fen/currency/UUID/idempotency enum.
Next implement original REQ-00051 against real money/order contracts, preserving
identity and values, then full P0/security/runtime/game/client/numerical/operations.
No weakened criteria/threshold/checksum, skipped file, Maven/highCPU job, production
mutation, merge or deployment. First ledger edit encountered an existing string
remaining field and exited before writing; corrected by preserving it as a list item.

Voice exactCI451/dependency269/privacy23/title20/notification8 pass. Migration13
job115289087384 confirms voice6 pass, then source-specific partition failure; latest
local boundary is currency. Contract376/API80/performance119/integration426 fail;
E2E113/security409 observed running. No full requirement accepted. Source-hashed
partial ledger/progress updated; all658 persistent goal remains active/unbudgeted.


## Canonical currency foundation and observed native lifecycle (2026-10-14)

Read full REQ-00051; reopened old done declaration without changing10 criteria or
30min/15min/90%/80%/100ms thresholds. Real orders/UUID/minor-unit money/status/
idempotency/old views/FKs remain. Add nullable quote metadata, never infer historical
USD conversions; keep20 currency+20 price seed values. Source-bound repair refuses
parallel payment_orders and owner FKs targeting another user alias instead of ID.

Actual rate service now uses real transactions/advisory pair locks for one current
quote and full snapshot/UTC daily histories; failures preserve old quote/cache.
Cache stops at real expiry, and provider failure never invents mock/default1 rates.
NUMERIC conversions retain exact amount/audit; owned15min locks freeze real quotes,
reject foreign/expired/double consumption and share outer order rollback. Used-lock
cleanup preserves history. Actual public/typed/signed owner/admin routers use both
existing mounts before error handling; GET/POST detection and locale parsing fixed.
Actual counters replace missing metrics.increment, found by first real-storage run.

Final actual currency18 (including parent), CLI/prereq17, unit686 (22Jest suites),
syntax1437 and changed module loads pass. Owned HTTP server verifies all3 actual
provider adapters against documented response bases, not live providers. Consulted
official OER/ExchangeRate-API/vendor Fixer contracts; full credentials/freshness/live
provider acceptance remains open. Last host restart stopped owned PostGIS; test
ECONNREFUSED was terminal, restarted only owned DB/Redis and revalidated readiness.
No processes restarted merely on timeout; unrelated containers untouched.

Actual native payment process in production mode with fixture JWT/channel keys,
isolated PostGIS/Redis and provider keys explicitly disabled returns4 expected200
responses:20 currencies, CNYprice6.00, signed preference, exact USD1.01 from1.005.
It remains alive during3s SIGTERM observation; ownedSIGKILL termination observed,
schema/pools cleaned, diagnostic exit1. Not graceful/readiness acceptance; bounded
observation is not a new threshold. Kafka unavailable and provider acceptance absent.

V1/V2 passes; all85 raw sources unchanged. Full chain now fails20260626_040000 stmt1
JavaScript-style //header and rolls back. Native checkout still fixed CNY/mockprepay;
coins_1200 seed108 and checkout98 disagree. Missing multiCurrencyPayment module,
trusted provider/currency/bill binding, idempotency, minor-spend error handling,
30min owned scheduler, complete audit, representative performance/coverage, actual
gateway/client/all-feature/operations acceptance remain. Prioritize P0 billing/
identity/minor/lifecycle and remaining database prerequisite, then full original scope.

Published partition ef1bc74 exact CI452/dependency271/privacy24/title21/notification9
pass; migration14 canonical step9 succeeds (job115292180276), full gate fails prior
payment_orders at that source. API81/contract377/performance120/integration427/
security410 fail, E2E114 cancelled. Security dependency scan passes, K8s archive
extract fails before policy checks; secret scan fails but log fetch unavailable.
Also static K8s schema gate skips41 resources, and policy step only warns via grep;
these cannot prove operation/security acceptance and need real gates, not green claims.

No new requirement, lower threshold, fabricated pass, Maven/maxCPU work, merge,
production migration or deployment. Source-hashed partial ledger/current notes updated;
inventory191done/35in_progress/432new,total658,independently verified0. Persistent
all658 goal stays active/unbudgeted. Personal MEMORY.md and Oct09 notes remain local.


## Shared transaction follow-up (2026-10-15)

REQ-00096 is reopened from legacy done with all seven original criteria unchanged.
Default shared transactions and all isolation convenience APIs now use the same
owned implementation: actual PostgreSQL contention retries, bounded deadlines,
rollback/late-lease protection, uncertain COMMIT handling, actual registry metrics
and durable bounded deadlock audit. Preserve existing distributed detector API.
Original38 unit cases are enrolled; real transaction storage22 and source-hashed
paired throughput measurement pass, median+0.054927% at the original-5% gate.
Historical table identity/unknown metadata are preserved. See TRANSACTIONS.md.

Whole85 history remains red at20260627_041000 statement14; next reconcile that
actual dependency without changing raw history or numerical semantics. Continue
P0 money/provider/idempotency/minor protection and all original security/runtime/
game/client/performance/operations work. REQ-00619 now links current production
paths and its actual design/test boundary; previous exact43c6b148 main453 battle
coverage100% is recorded separately from pending current-source CI. No complete
requirement acceptance is inferred from partial tests. Persistent all658 goal stays
active; no new requirement, Maven build, CPU saturation, merge or deployment.


### First independently accepted requirement (2026-10-15)

REQ-00619 original three framework criteria now have exact-source bae401eb CI454
success and downloaded battle-job116334921896 proof:133 pass/76 actual engine
scenarios/formula100% with unchanged91% gates. Mark this framework done/verified;
other battle/game/storage/client/numerical requirements remain separate. Inventory
191done/35in_progress/432new,total658,independently verified1. REQ-00096 and the
full migration chain remain open; next work and all original stages continue.


### Remote throughput and next SQL prerequisite (2026-10-15)

Exact bae401eb migration16 confirms all transaction/storage correctness but fails
the original throughput gate at-5.624629685951888%. Preserve the negative report;
no threshold/baseline/workload change. Success-path Error construction and empty
pending-query promises are removed; same local benchmark-3.2443239972000937%
passes, while exact new remote performance remains unverified. REQ-00096 stays open.

REQ-00077 old done is reopened. Its slow-query SQL prerequisite now passes7 real
preloaded PostgreSQL15 cases, retaining identities/history and numeric precision.
Raw85 SQL remains unchanged; full chain advances to20260627_060000 statement13
missing is_deleted. Actual JS collector/API/security/monitoring/policy conflict and
all original10 criteria remain open. Next align canonical inventory fields and UUID
ownership while preserving actual Pokémon/candy/team contracts, alongside original
P0 billing/provider/idempotency/minor/lifecycle priorities. Inventory190done/36in_progress/
432new,total658,independently accepted1. All original stages continue.


### Database scope repeat (2026-10-16)

A real repeated slow-query probe exposed global historical/top50 interference.
Both SQL helpers now filter current database, with an owned fresh-database fixture
and qualifying foreign-database negative case. Actual7 repeats pass; no reset or
weakened assertion. Prior original throughput CI failure remains recorded, optimized
exact-source remote verification still required. Continue publication, inventory
canonical contracts and all original stages; persistent all658 goal active.
