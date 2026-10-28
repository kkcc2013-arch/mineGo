# mineGo requirement completion plan

Updated: 2026-10-28. Scope: all 658 existing requirement documents in INDEX.md,
including legacy done declarations that still need independent acceptance.
Do not run the hourly requirement generator or create additional feature scope.
Current declarations: 52 P0, 565 P1 and 41 P2; 429 new, 53 in progress; 176 declared done, including one independently verified framework. These counts
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

1. V1/V2 plus all87 migrations (the original86 unchanged plus additive payment
   integrity) and installation beside unrelated audit schemas are exercised by the
   current bootstrap checks. Continue safe upgrades/reversal and actual P0/service/
   security startup dependencies. Canonical crypto/MFA/protected audit/P0 filtering
   and current payment integrity remain partial evidence, not full security acceptance.
   Job monitoring, scanners, approved exports and other service boundaries remain open.
2. Inventory/cosmetic storage prerequisites have real preservation/CLI evidence;
   actual inventory projections/confirmed protected transfers/soft-deletion consumers,
   preferences/cache/capacity/UI and cosmetic service/routes/purchase/slots/presets/
   expiry/client/metrics/coverage remain incomplete. Keep all original criteria.
3. Carry all original P0 authentication/MFA/payment/idempotency/privacy/minor/anti-cheat
   and service startup/readiness/lifecycle work forward. Continue independent local
   work while genuine external provider/staging/device inputs are unavailable.
4. Repair remaining legacy contract/API/integration/performance/security/operations
   gates, meet each original numerical target and perform all658 acceptance audit.
   Exactc4b5ca1 main475/MFA7/browser3/migration37/privacy47/notification32
   pass, including full87 remote bootstrap. Payment2 core/migration/report gates pass
   but native timeout consumption fails; native44 fails cache test setup before
   actual process steps, which were skipped. Both failures remain recorded.
   Real Kafka pre-start backlog now reproduces skipped new-group work; correction
   also fixes absent histogram defaults and an invalid DLQ logger call that stopped
   consumption. Local corrected paymentnative2/cache41/originalnative2/fullunit
   pass; corrected-source CI pending. Legacy global contract/integration/security/
   performance workflows remain unaccepted. No original gate is waived.


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


### Whole-operation deadline optimization (2026-10-16)

Second exact-source remote throughput5864a4a still fails-5.691201189980399%.
Preserve failure. Use one whole-operation deadline/connection abort race with
continuation guards; actual pending-SQL success/failure cases expand transaction
storage to24. Same fixed benchmark local+0.5400157583078435% passes, environment
recorded with synchronous_commit on. Exact new remote performance remains required;
no threshold/workload/baseline change. Independent slow-query check now precedes
throughput and full history executes after prior failure without waiving any gate.
Full inventory-schema conflict and all original goal stages remain open.


### Inventory audit carried forward (2026-10-16)

Read full845-line REQ-00348; reopen legacy done with original10 conditions and
80%/95%/<500ms unchanged. Actual current schema/failed full-chain and mounted
source show incompatible instance/species fields, UUID team identity/arrays and
per-species candy resource contracts, plus fixed capacity. Module loads but that
is not HTTP/feature acceptance. Continue actual canonical reconciliation without
shadow metadata or inventing historical resource attribution. Inventory189done/
37in_progress/432new,total658,verified1; all original goal stages remain active.


### Exact cancellation and measured follow-up (2026-10-17)

Exact2b5ab77 mainCI457/battle and transaction24/slow-query7 pass; remote throughput
fails-7.838354232137334% and independent full history fails inventory is_deleted.
Retain all three exact remote negative reports. Replace per-operation backend-name
changes with bounded startup PID/key CancelRequest, inheriting verified TLS and
refusing plaintext fallback; retain local server timeout and unknown-COMMIT rules.
Guard mutable query configuration and commented control keywords. Count actual
metric producer events and flush exact deltas at observation, including reset.

Current724 units and355 actual checks in19 sequential storage suites pass, including
27transaction/8slow-query/3verified-TLS. Original short-window tmpfs diagnostic fails
-5.0164301546780425% and is retained. Increase actual per-worker sample200 to2000
and warmup50 to500 after observed short-window jitter; retain original immutable
baseline/real transfer/two workers/seven paired rounds/-5% gate and include both
actual registry exposures in timed work with29000 exact event counts each. Longer
owned tmpfs diagnostic passes-2.9650592644973828%; regular-disk measurement and exact
new CI remain to be observed. Neither diagnostic proves durable production capacity.

Continue canonical inventory prerequisite preserving UUID/data/team/candy/bond
contracts; complete original P0 money/provider/idempotency/minor/lifecycle and all
remaining stages. All658 scope remains active,189declared done/37in_progress/432new,
independently verified1. No new requirement, Maven, CPU saturation, merge or deploy.

Final ordinary-disk long-window result+0.22104147149817344% passes with actual
synchronous_commit on/exact balances/events/source hashes. Preserve earlier failed
reports; exact new remote CI and full inventory migration remain open.


### Inventory storage and exact transaction CI (2026-10-17)

Previous turn published26f553f and real tests/evidence: concrete progress. Exact main
458 succeeds; migration20 transaction27/slow-query8/TLS3 and original throughput gate
pass at-1.1060183236359267%. Full job still fails original inventory history. Preserve
source-hashed remote pass and all three previous remote negative reports. Related
privacy/title/notification/dependency jobs pass; legacy contract/API/integration/
performance/security workflows remain failed and E2E was cancelled, not accepted.

Inventory repair now retains actual UUID instances/favorites/nicknames, species
metadata, per-species candy and UUID teams/constraints. Add truthful deletion-time
indexes/UUID preferences/protection/tags without fake copied metadata/resources.
Preserve existing choices/timestamps/sequence/function/trigger identity/state; refuse
unknown deletion/global candy/ownership/index/custom behavior atomically. Current
focused24 genuine storage/CLI checks pass; broad sequential repeat is being completed.
Full85-source chain now passes inventory then fails cosmetic20260630_040000 stmt13
pokemon_instance_id FK type. Full upgrade/reversal and REQ348 feature acceptance stay
open. Continue actual canonical inventory route/transfer/soft-delete consumers,
cosmetic prerequisites and original P0/security/service/client/numerical/operations
stages. All658 scope/189done/37in_progress/432new/independently verified1 unchanged.

Standalone security416 also remains red. Its secret scan reports8934 findings,
including many checksum-file matches from unscoped custom provider regexes and20
workflow database-password matches; values are never displayed. Assess each class
and repair detection precision without broad exclusions or inventing a clean scan.
K8s policy validation and the remaining original security criteria still require work.

Final current-source repeat:724 unit checks/24Jest suites425,379 actual checks in20
sequential storage/CLI suites/no skips,1445 syntax checks and actual inventory module/
workflow/new gate loads pass. Original10 acceptance checkboxes and85 raw SQL bytes
remain exact. Measured transaction core/benchmark8 hashes still match the genuine
26f553f remote pass; no redundant unchanged local performance rerun. Full-chain
cosmetic20260630_040000 stmt13 remains failed; new exact-source CI pending. All20
historical database-password findings were individually verified against their
actual commit/file/line as test:test on localhost/127.0.0.1:5432; no values exposed.
Provider-pattern findings still need complete assessment; no clean scan claimed.


### Cosmetic prerequisite and next deletion conflict (2026-10-17)

Previous turn is concrete progress: publisheda769b0d inventory repair/24 native cases
and actual379-suite-check evidence. Exact migration21 job117376047375 confirms new
inventory24 and all preceding correctness steps pass; original throughput again
passes at-1.6979621741050943%, measured8 source hashes unchanged. Full job fails
cosmetic UUID FK as locally observed, not generally green. Remote report retained.

Read full1307-line cosmetic requirement and actual raw/repair/schema; no corresponding
production service/router/client exists. REQ125 movesnew toin_progress with all15
criteria/≥90% unchanged. Fix missed fourth UUID reference, preserve actual catalog/
prices/history/OIDs/views/FKs/comments/sequences and all13 initial definitions. Old
missing purchase/revenue history stays NULL, only observable owners/equipment are
derived. Original raw85 stays immutable. Native storage/CLI cases exercise genuine
failures/rollback, full seed equivalence and precise BIGINT preservation. All cosmetic
runtime/purchase/concurrency/preset/expiry/client/metrics/coverage remain open.

Full seeding passes and history advances to20260630_050000 stmt2 deletion-task FK
identity conflict. Continue that existing P1 data-deletion prerequisite/canonical
request history, continue actual inventory runtime and all original P0/security/
service/client/performance/operations stages. Full installation/upgrade/reverse and
latest exact CI remain open. Current declarations189done/38in_progress/431new,total
658; independently verified1. No scope shrink, new requirement, Maven or maxCPU.

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


### Legacy deletion identities and runtime audit (2026-10-18)

Exact5c1ddd5 migration22 cosmetic15 and existing correctness/throughput pass; full
job fails deletion FK. New distinct UUID erasure storage keeps authentic SERIAL/
numeric-owner history and explicit subject/proof bindings; new18 actual storage/CLI
checks pass. Prior394 checks retained by exact unchanged inputs, not claimed rerun.
Full V1/V2 passes; all85 history now fails20260701_110000 stmt1 canary inline partial
UNIQUE WHERE, pending transaction rolls back. Current new-source CI pending.

REQ127 new→in_progress and GDPR16 olddone→in_progress after full original reads and
actual legacy module22P02/42703 failures. Original12+12 criteria,80%/legal review
unchanged;188done/40progress/430new,total658, independently verified1. Continue
canary prerequisite, actual deletion/inventory/cosmetic/service and original P0/
security/client/numerical/operations work. No scope shrink or false legal/feature
acceptance; no Maven/maxCPU.


## Canary checkpoint (2026-10-18)

Source-bound repeated canary SQL retains earlier SERIAL rollout state/history and
adds request logs, real one-active-service uniqueness, truthful new creation times
and guarded updater/index identities.18 actual canary checks plus19 erasure checks
pass sequentially; missing-predicate adoption uses NULL-safe comparison in both.
Actual manager reads work; create event/API/metric failures and false healthy
statistics remain. Original1074-line78 read; legacy done reopened, all11 original
checkbox lines (including truncated final line) retained. Full history now fails
partition20260707_060000 stmt6 view size_bytes→size, entire pending rollback.
Exact40a98d3 main461 and erasure18/other migration23 correctness pass; throughput
-2.76910724385816% passes original-5%; full migration job fails former canary syntax.
Current187done/41progress/430new,658 unique, independently verified1; all stages
continue. No claim that prior394 suites were locally rerun in this narrower batch.


## Partition runtime checkpoint (2026-10-18)

Canonical current+three-future-month creation/statistics/health preserve earlier
view/helper/row identities, existing weekly phase, exact values and operator choices.
Actual gateway signed-admin API, Prometheus and daily timer/initial failure/natural
cleanup work.22 real storage/router/CLI cases pass/no skips with new module
100line/94branch/90.48function coverage at80% line/function gates. Actual native
gateway/user and724 units/1450 syntax pass; no fresh prior394-suite rerun claimed.
All85 raw SQL and older manifest entries unchanged. Full chain now fails CDC
20260707_100000 stmt5 missing pokemon and rolls back. Original60/626 full documents
read;9+12 criteria and all original thresholds retained.626 legacydone reopened;
actual S3 Parquet/durable restore/retention/deletion/full client/benchmark targets
remain open. Prior2e5 main462/correctness pass but throughput-6.352968581797381%
fails original-5% despite8 unchanged measured hashes. Preserve failure and repair
required gates; older passes do not waive it. Current186done/42progress/430new,
658 unique, verified1; all original P0/service/client/security/operations stages
continue after installation prerequisites, with no merge/deploy or new scope.


## Durable cache invalidation checkpoint (2026-10-19)

Read complete original REQ479/523 and retain all4+4 criteria and100ms/50ms gates.
479 legacy done is reopened;523 moves new→in_progress. Current185done/44progress/
429new,658 unique original documents,40 source-matching evidence records and sole
verified619 remain. Real gateway caches now use commit-driven invalidation across
18 canonical sources, approved bounded identity-only PG outbox/UUID hints, durable
retry/reconnect/worker restart, per-namespace Redis+independent L1 broadcasts, CAS
fill fences, signed-admin durable revision config, original baseline YAML plus
validated glob/bounded-regex additions, and actual processing/backlog/error metrics.
Actual proxy streams now fill bounded JSON envelopes; keys separate full target,
verified subject/language/structured queries. Existing own-statistics/public-profile
routes are mapped to real upstream paths, and personal Pokédex authenticates.
Joined Pokemon profile counts/species/candy/friend dependencies invalidate too.

Final40 actual SQL/Redis/worker/streaming HTTP cases pass/no skips. Diagnostic
selected-module coverage90.48line/71.68branch/79.02function; no whole-feature coverage
claim or reduced gate. Actual two-OS-gateway+user native suite passes existing
Kafka/notification/WS/IP/readiness/admin/signal/RedisURL cases and new streamed-cache
MISS/HIT/committed-update/joined-count/config/400/413/ownership cases. Final native
observed45.31109ms functional recovery is not capacity acceptance.724 existing unit
checks/24Jest425 and1455 syntax pass; heavy checks sequential UV2/nice10. Owned
Redis/Kafka1CPU fixtures stopped afterward; unrelated containers unchanged.

Repeated native coverage latency exposed53.273283ms > original50ms. Preserve that
negative source-hashed artifact. Reduce real Redis round trips by matching up to
100 source rules during shared owned data/fence scans, rather than rescanning for
each entity rule. Final12 writer→bothL1+Redis measurements max13.414005ms, original
50/100 gates unchanged; real source hashes match report. First late-commit fixture
incorrectly rewrote L2 then expected another L1 to change without invalidation;
isolate a fresh key, retain the actual late-commit/rollback requirements and rerun.
Prior latency-positive/overall-fixture-failure report is retained with that scope.
No production load/no-significant-database-load or long-outage acceptance claimed.

All85 original raw SQL and every previous manifest entry remain unchanged. Guarded
new repair retains compatible trigger/function/outbox/settings contracts and refuses
customized/privacy/primary/singleton/revision changes. Genuine CLI up/up/verify
retains raw/executed hashes. Full V1/V2 passes;85-chain now passes CDC and fails
job-monitoring20260711_120000 statement6: created_time absent. Entire pending batch
rolls back. Full upgrade/reversal, all cache consumers and all original P0/service/
client/security/operations stages remain open. Current-source CI must be observed.

Exact prior2df7d22 main463/battle and native32 pass; migration25/job117672875464
passes partition22/original80% gate/all other correctness and actual throughput
-2.7440245081718717% meets original-5%, with all8 measured hashes matching. Migration
job still fails oldCDC trigger. Archive its actual report alongside prior2e5
-6.352968581797381% failed gate; no waiver/cherrypicking, no new local throughput
rerun for unchanged8 sources. Never mark all658 achieved from partial checkpoints.


## Job history and fresh installation checkpoint (2026-10-19)

Previous goal turn made concrete progress: published766ad98 actual CDC/gateway
runtime and40 genuine storage tests. Exact-source main464 passed. Title/native33
run39179749635/job117829780788 then failed cache37pass/3fail (two children+parent),
so its native step was skipped. Remote12 latency samples max15.145301ms pass original
50ms; that does not waive functional failure. Real invalidation advanced the local
generation while a setup Redis read was in flight, correctly returning disabled.
New deterministic held-real-Redis-read case verifies bypass/miss/no stale L1 fill;
seed only after a genuinely successful fenced fill. Production cache/gateway code
unchanged. Final41 real cache/CDC/HTTP cases pass/no skips; final12 latency samples
max12.950595ms with matching hashes. Preserve original50/100ms gates and archived
source-specific CI failure, earlier53.273ms failure and prior diagnostic scopes.

REQ669 original document fully read,10 criteria retained; its conflicting topdone/
footernew metadata both becomein_progress.185→184done,44→45progress,429new;658 unique,
41 source-matching records and verified619 only. Its canonical source-bound existing
job repair corrects created_time to realcreated_at, preserves four operational
histories/SERIAL IDs/sequences/operator comments/indexes/views/dependents and UUID
acknowledger FK, and atomically rejects incompatible contracts. TEMP probes cannot
reference permanent users via FK (actual42P16); check actual UUID target/action/
validation/column contract separately, with no disabled FK or fabricated link.
Genuine CLI up/up/verify preserves raw/execution hashes. All85 raw sources remain
unchanged; only the existing20260711_120000 repair entry/executed content changes,
never a recorded journal. Differing-repair upgrade still needs explicit handling.

Production JobExecutionLogger now lazily shares configured DATABASE_URL pool and
verifies canonical migrated storage rather than auto-DDL/default credentials.
Supplied shared pools remain usable; explicitly owned dedicated pools close.
Scoped atomic completion gives one actual winner/conflicting status409, matching
replay preserves result; negative time/invalid input cannot rewrite execution.
Real parameterized history/filters/metadata/rates include null success for no runs.
New UTC start/end/created_at clocks survive real UTC/Shanghai process and NewYork
session timezone differences. Historical types/values remain; unknown timezone
provenance is not reconstructed. Retention >=90days deletes only old completed
records, preserving running/recent/unknown states; no production cleanup/timer starts.
Final24 actual job SQL/CLI/logger/storage/native-TZ/pool/race cases pass/no skips,
module100line/94.50branch/95.65function at80% line/function gate. Original669 core
aggregator/alert/health>80% remains separate and unmet. First timezone child used
root require(pg), corrected actual backend dependency path; no fake dependency.

Full85 chain initially reached all85 raw-matching journal entries but final owned
2574-object schema DROP failed53200 under default max_locks_per_transaction64.
Raise only owned PostGIS fixture/isolated migrationCI to256 before restart, preserving
whole atomic migration and checksum gates. Confirm original85 raw hashes in the
retained fixture before removing that owned schema. It exposed an older audit
migration's unscoped information_schema lookup: another schema's encryption_auth_tag
caused new schema skip/failure. That cross-schema case is explicitly unresolved.
After confirmed owned diagnostic cleanup, real full V1/V2+all85/checksums/cleanup
passes2/2/no skips. PostgreSQL15 official lock docs linked in JOB-MONITORING.md;
no production config/data change, no benchmark threshold or immutable baseline change.
Fresh install is a prerequisite pass, not all upgrade/reverse/service acceptance.

Final current checks: job24/cache41, full bootstrap2,724 unit/24Jest425,1456 syntax,
workflow parsing and audit. First unit invocation wrongly forcedLOG_LEVEL=error
and correctly failed a logger-context assertion; rerun with normal environment
passes unchanged tests. Heavy checks sequential nice10/UV2; no Maven/CPU saturation.
Owned Redis stopped after tests; Kafka remains stopped; unrelated containers intact.
Exact prior766 migration26/run39179749602/job117829780475 correctness/CDC17/TLS/
partition80% and actual throughput-2.715739325993871% pass original-5%, all8 source
hashes match. Full prior migration fails old jobcreated_time. Archive actual report
alongside earlier negatives; no new local throughput rerun for unchanged8 sources.
New full-source CI still must be observed; do not claim all green.

All original P0/service/client/security/operations stages and669 registration/
<5s realtime/90dayhistory/60sactualalert/10minsuppression/>95%zombie/<10%scoreerror/
adminUI/corecoverage/E2E remain required. Job routes remain unmounted/unauthenticated
with lazy resources and placeholder restart/skip, and no jobs register into current
aggregator. Next prioritize actual P0 services/security dependencies and the scoped
audit installation defect; finish full monitor runtime safely, with actual auth,
job ownership and real delivery before accepting669. No external recipients,
production deletion, merge/deploy, new requirements or reduced targets.


## Scoped sensitive audit storage checkpoint (2026-10-19)

Previous goal turn made concrete progress:20project files published519f880, actual
job logger24/cache41/fullfresh85 gate2 and source-hashed evidence. Independently
observed exact519 main465/run39205897731, title/native34/run39205897769/job117908550436
and migration27/run39205897816/job117908550452 all completedSUCCESS. Downloaded logs
confirm actual native gateway/user and cache41, job24/original80% module gates and
complete fresh85. Actual transaction throughput-2.517669437114245% meets unchanged
-5%; all8 measured source hashes match. Archive report and sanitized three-gate
metadata/log hashes. Other legacy workflows/full658 acceptance remain separate.

Read complete originalREQ38(331lines/10criteria) and both sensitive-audit rawSQL
194800/200000. Legacydone is reopened, retaining every original criterion including
AES256GCM rotation/KMS, complete access chain, ≥10masktypes, allendpointscanner/MFA,
≥90%crypto/mask/permissionscoverage/integration/CI/docs. Current183done46progress
429new/658unique,42 source-matching records, independently verified619 only.

New source-bound200000repair fixes four global information_schema existence checks
and temporarily isolates relation lookup to actual target schema; restores exact
caller search_path. Preserve actual BIGSERIAL audit/data, encrypted cipher/tag/IV/
wrapped-key bytes, operator comments, statistics/dependents and previous key choices.
New historical timestamps stayNULL for canonical V1 TIMESTAMP WITHOUT TIME ZONE;
only genuine timestamptz creation instants can populate them. Initial fixture exposed
an8-hour implicit timezone assumption; corrected to preserve unknown provenance.
Old missing key versions stayNULL; defaults apply to future keys. No guessed tags,
key rewrap or fake historical clock/version. Crypto/storage incompatibilities and
custom functions/config/views require explicit adoption; guards NULL-safe.

Both known cleanup functions retainOID but move fromSECURITYDEFINER/publicexecute
toSECURITYINVOKER, schema-qualified targets and pinnedpg_catalogpath. Migration
never invokes cleanup. A real ephemeral read-only fixture role is denied without
PUBLICexecute and still denied ownerDELETE escalation after explicitEXECUTE grant;
role/grants and fixture schemas are cleaned up. No privileged cleanup/job, global
shared function replacement, production deletion, recipient or rekey operation.

Final16 actual target+outsider PostgreSQL/V1/V2/SQL/CLI/real-role cases pass/no skips.
Reproduce original42703 and atomic rollback, retain four columns/settings/outsider,
unknown+known history, real fixtureGCM bytes/wrappedkeys/serial IDs/comments/views,
actual rootCLIup/up/verify/raw+executionhash, and custom tag/timestamp/body/config/
view refusals. Fixture crypto validates preserved bytes, not production encryption.
Full bootstrap now3/3/no skips:V1/V2 plus original isolated85 and complete85 beside
an unrelated schema with matching4 audit columns and unchanged OID/marker. Every
raw checksum and schema cleanup retained; max_locks256 from previous checkpoint.
Final724 unit/24Jest425 and1457 syntax/workflow/audit pass. All85 rawfiles and every
older repair entry unchanged; one new audit entry. No fresh rerun of prior broad
business/native suites claimed; new current-source CI still must be observed.

The actual runtime encryption helpers remain incomplete and unmounted in current
native gateway/user entry points. AuditLogEncrypted fullsource reviewed: temporary/
development/plaintext fallback, BYTEA encryptedKey.split type mismatch, writer drops
GCM authTag and names resource_type/id instead of canonical entity_type/id, query
passes wrong decryption arguments, rotationgetOrCreate mayreuseactivekey. Sensitive
DataAudit complete415lines reviewed: dropsIV/tag, no accessor-role enforcement,
suppliedhasMFAboolean, unknownruleallow, truthyfieldaccessdetection/identitymismatch,
res.jsonaudit failure returns data. Common auditLog firstfunction stillplainSQL/logs.
No claim of real crypto decryptability, MFA, complete role filtering/scanner or
compliance. Finish actual canonical crypto/provider/keypurpose/rotation/history
and durable access semantics before mounting authorized MFA/decrypt routes.
Remaining original P0/services/client/security/operations and all658 goal persist.
No Maven/CPU saturation/new requirements/merge/deploy/production cleanup. Heavy
checks sequentialnice10/UV2; Redis/Kafka remain stopped and unrelated containers intact.


## Canonical MFA batch (2026-10-20)

Reopened unsupported done declarations for REQ638/126/588 without changing their
10/4/4 original acceptance boxes. Actual signed server state now guards MFA;
encrypted secrets, single-use factor/recovery/login challenges, fifteen-minute
lockout and epoch/session/scope-bound five-minute proofs have real PostgreSQL/
Redis/HTTP evidence. Mounted native user/gateway aliases are exercised. Dedicated
MFA CI preserves the original90% line/function gate; controlled valid-window
500/500 samples do not establish real-device clock/network availability.

Complete actual protected admin audit query/decrypt/service filtering next using
the verified role/MFA boundary. Finish seven-day trusted-device semantics, client
setup/login, actual sensitive password/payment/asset mounts, full metrics and
canonical risk-engine/cross-service contracts before accepting full MFA/risk
requirements. REQ126's literal forged Bearer test_token still returns401; record
that acceptance-command conflict without accepting the token or changing its box.
All658 requirements, external staging/provider/device gates and previous failures
remain in scope; sole independently verified framework remains REQ619.


## Protected audit read batch (2026-10-23)

Actual L2 signed capability plus server MFA now protects admin decrypt/audit-list/
sensitive-access-list routes and all four gateway namespaces. Access reasons and
verified accessor/read IDs/context persist encrypted in a transaction before data
release. Known structured P0/credential fields stay excluded from admin HTTP views;
original encrypted records remain intact. Bounded authenticated service filtering
provides numeric keyset progress through nonmatching and byte-limited candidate
pages; legacy metadata helpers remain metadata and cannot silently decrypt for an
ordinary caller. Original owner/privacy semantics and all658 criteria remain.

Finish client/admin provisioning, approved L3 exports, all business sensitive
access/response filtering, unstructured masking/custom rules/scanner and the original
combined unit/security coverage targets. Continue actual original performance
profiling/optimization without weakening-5. Preserve prior negative results and
complete original P0/payment/auth/privacy/minor/anti-cheat/service/client/operations
requirements; this batch does not accept full REQ38/638/588 or the full goal.


## Game client MFA batch (2026-10-23)

Real enrollment/QR/manual secret, explicit recovery-code download/save clearance,
primary challenge/factor login/cancel, regeneration and disabling now use actual
service APIs. Challenges/secrets/codes stay transient, factor submissions never
automatically refresh/retry, and stale responses cannot restore ended identities.
The service worker refuses offline factor queuing/cached status and filters legacy
queued auth/proof/audit operations. Correct legacy gateway auth rewriting/rate
limits and client preflight headers are exercised by actual native processes.
The dedicated browser fixture uses production modules and canonical PostgreSQL/
Redis, with owned seeded SMS codes only. Source-hashed results are recorded in
VERIFICATION/WORKLOG; all original boxes and targets stay unchanged. Next close
sensitive business boundaries and risk/scanner gaps, continue other real service
startup and original client/security/performance/operations acceptance. Physical
Google Authenticator/SMS delivery and seven-day trusted devices remain open.


## Payment integrity and legacy declaration audit (2026-10-25)

REQ-00003/00004 are reopened from done to in_progress: copied helper tests and a
separate mock-route integration app did not prove the production payment boundary.
The real router/store now bind header/user/request/24h deadline in PostgreSQL,
mirror Redis, preserve old orders, authenticate exact JSON/XML/form callback bytes,
lock and settle once with unique provider receipt, coin/spend updates and encrypted
audit, and run through the actual service lifecycle/gateway/Kafka timeout handler.
Explicitly unconfigured prepay never emits fake parameters. Actual migration/history,
SQL/Redis/HTTP, coverage-report and OS-process checks are recorded in VERIFICATION.
Whole-service unit-only coverage, all legal fulfillment/refund business flows,
provider-native/prepay/receipt integration, legacy request adoption, every sensitive
MFA/risk boundary and production drills stay open. Continue all original658 targets;
only619 is independently verified. No new requirement or acceptance-target edits.
