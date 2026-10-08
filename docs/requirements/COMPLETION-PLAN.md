# mineGo requirement completion plan

Updated: 2026-10-08. Scope: all 658 existing requirement documents in INDEX.md,
including the 204 legacy done declarations that still need independent acceptance.
Do not run the hourly requirement generator or create additional feature scope.
Current declarations: 52 P0, 565 P1 and 41 P2; 437 new, 17 in progress. These counts
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

1. REQ-00106 title service: replace unsupported Knex-style query/transaction calls with
   parameterized shared PostgreSQL operations; repair its actual routes, identity
   migration, concurrent activation, expiration and cache behavior.
2. REQ-00159/00682: use the repaired title initialization to continue actual
   user-service startup verification; resolve each newly exposed startup defect.
3. REQ-00120/00126/00149 and the other user-route integration documents: verify
   real mounted paths and JWT/admin behavior through user-service and the gateway.
4. Repair integration tests to use real production user identities and routes,
   then supply actual running targets to contract and performance checks.

The previous lifecycle batch passed 590 unit checks, 26 standalone launcher checks
and 11 PostgreSQL/privacy checks. Main/dependency/privacy CI passed at 890b779;
contract/performance/integration acceptance is still failing. New source changes
must receive their own validation and remote checks.

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
