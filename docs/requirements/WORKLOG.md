# Full backlog implementation worklog

## 2026-10-06 — repository connection and first verification batch

The requested scope is all existing requirement documents. This batch does not
complete that scope. The repository was cloned from
`https://github.com/kkcc2013-arch/mineGo`, starting at `5cac6ab`, into the working
branch `codex/requirements-readiness`.

All requirement files were scanned for metadata, acceptance clauses, and source
references. The generated [index](INDEX.md) and [audit](AUDIT.md) contain 658
requirements. Status declarations initially comprise 214 `done` and 444 `new`
entries; these declarations are not independent proof of acceptance. REQ-00619 is
now `in_progress`, leaving 443 `new` entries.

58 colliding documents were assigned unique IDs above the previous maximum,
without deleting requirements or changing their completion claims. Existing index
mappings were preserved; other collisions retain the earliest Git introduction.
Exact filename links were updated. [The migration map](NUMBER-MIGRATIONS.md)
records the old IDs, retained documents, and renamed documents. Bare historical
IDs can still be ambiguous and must be interpreted using that map.

Implemented and verified locally:

- REQ-00619: injectable battle randomness, clock, and status-service boundary;
  extracted production formulas; 57 formula tests and 76 business scenarios;
  independent CI job with 91% line, branch, and function coverage thresholds.
  Measured formula coverage is 100% in all three dimensions. Regression fixes
  cover immunity, zero probabilities, HP bounds, defender status targeting,
  toxic counters, and replay restoration.
- Service health registration: static checks recognize factory and router registration, with real HTTP health/readiness checks for both shared implementations. Disabled health and unhealthy dependency cases fail correctly.
- Repository parsing: syntax defects corrected in ten locations; CommonJS,
  browser ESM, and JSX are checked with their supported grammar. This establishes
  syntax validity, not frontend bundling or successful service startup.
- 71 shared-module import paths repaired to resolve existing implementations.
  Authentication entry points now share canonical JWT verification. Verified
  `sub` claims supply the `id` and `userId` fields used by service handlers;
  unauthenticated and non-admin requests remain rejected.
- Request signatures: restored truncated tests; real metrics API integration;
  constant-time signature comparison; malformed signature handling; unknown-key
  rejection; parameterized route matching.
- Client integrity: asynchronous fingerprint scoring and risk classification
  aligned with the requirement's specified score bands.
- Monitoring reports: valid resource queries and constructor defaults; the
  existing tests run in the selected Jest regression suite.
- Localized text: atomic placeholder truncation, balanced HTML within the total
  character budget, intact emoji surrogate pairs, Japanese language detection,
  and complete English word boundaries. Incorrect test expectations were
  replaced with assertions matching the documented length and token contracts.
- Gateway forwarding: replaced the vulnerable glob-dependent proxy package with
  the static-target `http-proxy` adapter. Local HTTP and WebSocket tests cover
  mount/path rewrites, query parameters, parsed JSON/form bodies, raw streams,
  request/response callbacks, Host headers, error responses, and bidirectional
  WebSocket frames. This also restores consumed JSON body forwarding.
- Compatible dependency updates and removal of the vulnerable proxy dependency:
  the npm audit at the high-severity threshold passes. The final audit still
  reports 25 moderate advisories; no high or critical advisories are reported.

Verification commands:

- `npm test` on Node.js 20.20.2: 95 existing standalone checks, 133 battle checks,
  and 167 selected Jest regression checks, all passing.
- `cd backend && npm run test:battle:coverage` on Node.js 24.19.0: passes with
  100% formula line, branch, and function coverage.
- `node --test scripts/tests/*.test.js`: audit and syntax checker tests pass.
- `npm run check:syntax`: repository JavaScript parsing passes.
- `node scripts/check-req-numbering.js`: 658 documents, 658 unique IDs, zero
  duplicates; next available ID is REQ-00684.
- `npm run requirements:audit:check`: generated metadata, hashes, and index match.
- `cd backend && npm audit --audit-level=high`: passes; moderate findings remain.
- Changed shared modules were loaded directly, and the gateway/authentication
  tests exercise real local HTTP requests rather than only checking imports.

Completion limits and next work:

- Remote CI has not run. Per GUIDELINES.md, REQ-00619 remains `in_progress`.
- The selected suites do not represent all repository tests. The full backlog
  requires additional service, route, database, client, performance, and recovery
  verification; existing source references do not establish those outcomes.
- Some modules still reference missing shared implementations, and some frontend
  components require build/runtime integration beyond syntax parsing.
- Docker is available. No Kubernetes context is configured, so live deployment,
  rollback, and production metric acceptance have not been verified. The user was
  asked which deployment environment to use; no cluster operations were executed.
- Continue with the existing P0/P1 backlog using the generated index and migration
  map. Do not run the requirement-generation prompt or invent maturity scores.

The [verification ledger](VERIFICATION.json) records the exact requirement and
source hashes associated with REQ-00619's local evidence. Editing those sources
invalidates that evidence in the next audit.

## Publication access

Publishing the prepared branch was attempted after local verification. HTTPS Git
push cannot authenticate in this workspace. The connected GitHub integration also
rejected branch creation with HTTP 403, `Resource not accessible by integration`.
Installation discovery returned no manageable installations. No remote branch or
pull request was created. Repository write access must be granted to the GitHub
integration before publishing and running remote CI. The local commits and clean
working branch are preserved.

## Publication and CI follow-up (2026-10-06)

The branch was published after the user confirmed repository/workflow access.
Draft PR: https://github.com/kkcc2013-arch/mineGo/pull/6 . The main CI/CD Pipeline
and battle regression job passed at commit 05e159922af8d818ede4ca0596e53bd6b3ddd173
(run 37471947782). This supersedes the earlier publication blocker above. No merge
or deployment was performed. Other workflows were not all green.

The subsequent batch repairs unavailable/retired actions, adds the frontend npm
lockfile, and records genuine contract/performance failures instead of suppressing
them. Contract reports use job summaries and artifacts. The provider Joi contracts
have their own working HTTP runner; the registry-based runner remains separate.
Mutating requests require explicit fixtures, and missing/empty/failed verification
cannot pass. Configure CONTRACT_BASE_URL and CONTRACT_FIXTURES_PATH for the real
test environment. Existing game contract paths and payloads still require alignment.

Performance measurements now require a real app or API URL, use measured wall time
for concurrent throughput, detect throughput decreases correctly, and propagate
storage errors. The baseline migration no longer fabricates demonstration values.
The baseline manager preserves explicit zero values, parameterizes intervals,
correctly counts deleted rows, and enforces at least 90 days of retention.
A new isolated PostgreSQL/Redis storage test verifies these changes against actual
services; it never modifies an existing application's schema. Unit coverage is
measured by Jest rather than method-presence assertions. Configure PERF_BASE_URL
and measured baselines before treating the live game benchmark as verified.

Validation of this batch:

- Node 20 full unit command: 95 standalone + 133 battle + 268 selected Jest tests
  (496 checks) passed. The selected suites now include real HTTP contract tests,
  performance tests and schema validation, plus existing contract compatibility tests.
- Performance suite: 44 tests, 98.31% lines, 91.71% branches, 100% functions; its
  actual 80% coverage gate passed.
- PostgreSQL 15 / Redis 7: isolated baseline storage, caching, trend, retention,
  migration and interval-parameter checks passed.
- Battle formula coverage on Node 24: 100% lines/branches/functions, 133 checks pass.
- All workflow YAML parses, 1375 JavaScript files parse, tooling tests pass,
  numbering has zero duplicates, and npm audit reports zero high/critical findings
  (25 moderate findings remain).
- Frontend npm ci succeeds and Playwright discovers 320 tests. Browser download
  failed mid-transfer; no browser runtime pass is claimed. Generated local browser
  reports are ignored.
- kubeconform 0.6.4 validates 142 Kubernetes resources in 27 files: 101 valid,
  zero invalid/errors, 41 skipped because their custom resource schemas are not
  available. Native Prometheus/Alertmanager configs and Grafana dashboard data are
  excluded from Kubernetes resource validation. No cluster is contacted.
- The legacy integration suite fails under Node 20 in testcontainers/undici startup;
  it runs under Node 24 but exposes missing imports/dependencies, PostGIS setup,
  and mock test schema drift. It is NOT declared passed. Its workflow now uses
  Node 24, consistent with the installed undici runtime requirement. The test-defined
  routes do not establish production route acceptance.

REQ-00093 and REQ-00490 were reopened from legacy `done` declarations to
`in_progress`; REQ-00547 started. The audit now reports 212 legacy done declarations,
442 new requirements and four in progress. The all-requirements objective remains
unfinished; none of these partial results establishes product-wide completion.
The user was asked for a live test/staging API and Kubernetes context. Pending
those details, no external benchmark, recovery drill or production rollout was run.


## Dependency analyzer follow-up

At ae68592 the main CI pipeline passed again, and the performance unit/coverage
and actual PostgreSQL/Redis storage job passed remotely. Live benchmark and
contract jobs failed because no test API/fixtures were configured; their failure
is now visible. The broader integration job also remains red.

The dependency workflow now reaches its analyzer and exposed an actual runtime
error: the logger declaration was inside a comment. Its discovery also pointed
outside backend/services and omitted backend/gateway. Both are repaired; missing
source trees now fail explicitly. Repeated analysis clears previous state, JSON
contains health scores and event topics, and cycle detection clears its traversal
stack correctly. A real-source scan discovers all nine services and nine static
synchronous dependencies with no detected cycles. This does not establish 99%
accuracy or complete Kafka/dynamic call coverage. REQ-00103 is in progress.
The expanded regression suite passes 295 tests across 13 suites (27 analyzer tests
added); the earlier standalone and battle checks remain applicable. Requirement
inventory now has 441 new, five in progress and 212 legacy done declarations.

## Privacy route and preference repair (2026-10-06)

Resumed the all-requirements task after the user asked whether work was continuing.
The previous final reply did not leave a background worker running. Continued local
work without waiting for staging access.

REQ-00053's legacy done declaration was reopened. Missing optional preferences and
new defaults now start disabled, unknown categories cannot acquire permission,
and default initialization does not manufacture consent timestamps. Explicit
changes update consent timestamps and persist a real audit record in the same
transaction. Audit failures roll back both preference changes and policy acceptance.
Private routes verify JWT locally; admin routes require signed admin roles. Policies
must exist, be active and effective before acceptance. Current-policy selection and
public history exclude future effective dates. Gateway proxy mounts and user-service
initialization are now wired, including the requirement's documented API aliases.

The additive migration preserves existing values, supports both policy table shapes
found in the repository, and adds compatible audit columns to the initial UUID audit
schema. It does not overwrite historical choices, invent translations or change
checksums of existing migrations. Existing consent provenance still requires review.
The full migration history and every legacy audit/user schema variant have not been
accepted by these tests.

Checks passed:

- Node 20 full unit command: 95 standalone + 133 battle + 335 Jest = 563 checks.
- Privacy unit suite: 40 tests; measured 91.78% lines, 89.57% statements, 100%
  functions and 78.72% branches. The actual 80% line/statement/function gate passes.
- Privacy PostgreSQL/gateway suite: 11 Node test checks, including upgrades of both
  real policy schema definitions, preserving existing consent, JWT and admin access,
  all proxy prefixes, current/future policies, explicit opt-in/withdrawal, invalid
  updates, stored reports, exported metrics and deliberate audit failure rollback.
  Production privacy routers and the gateway proxy module are executed; the UUID
  user identity table is a fixture and this is not a full user-service startup test.
- Formula coverage remains 100% on Node 24. Workflow YAML and JavaScript syntax pass.
- A dedicated privacy-regression workflow runs coverage and real PostgreSQL route
  tests on pull requests. Remote results are pending publication/CI at this point.

Remaining REQ-00053 acceptance includes the complete client interface, applying
preferences at every data collector, original consent evidence for legacy rows,
7-day retention, scheduled reports, third-party sharing records, policy-change
popups and data export. Three existing privacy metric families are connected to
real successful actions; the data-export metric remains unwired with its workflow.
No product-wide completion or legal-compliance claim is made.

The inventory remains 658 unique requirements, with 211 legacy done declarations,
441 new requirements and six in progress. The source-hashed ledger records privacy
results as partial evidence, separately from complete acceptance.

## Logging migration and runtime repair (2026-10-06)

Privacy CI, the main CI pipeline and dependency checks passed at 739c8ee. The local
continuation replaces the unsafe regex console converter with Babel AST/scope
analysis and a default read-only report. Writes require an explicit CommonJS file,
keep comments/directives/argument expressions, avoid nested name collisions and
parse the result before writing. ES module rewrites and unsupported console methods
require review. The runtime scanner finds zero direct global console calls across
shared, gateway and all service source trees; test and CLI/script output is excluded.
The empty baseline and CI gate reject newly detected calls. CLI output is preserved.

The migration helper preserves common formatting, structured errors/objects and
known credential-field redaction without invoking getters or modifying input data.
Date, Buffer, Map and Set values are covered. Shared loggers now use AsyncLocalStorage
for actual request identity/trace context; concurrent HTTP tests prove context
separation. Development loggers share one pretty transport instead of creating a
worker for each converted module. Disabled log levels avoid object normalization.
The helper is never installed globally on import; explicit replacement can be undone.

Repaired logger declarations hidden inside comments and genuinely unbound references
in business/spawn metrics, ImageProcessor, age verification, WebSocket shutdown and
ServiceLauncher startup failure handling. Removed consent-token/approval-URL log
output; the parent-consent message now says request prepared because delivery was
never implemented. This does not validate the email-delivery requirement.

Validation:

- Full unit command on Node20: 95 standalone + 133 battle + 351 Jest = 579 checks.
- Logging helper/migration suite: 13 tests; 100% lines/functions, 98.57% statements,
  94.54% branches; the actual 85% coverage gate passes.
- Actual PostgreSQL/privacy/gateway suite still passes all11 Node checks after the
  logger changes. Battle formula coverage remains100% on Node24.
- 1380 JavaScript files parse, logging scan is zero, tool checks and numbering pass.
  ServiceLauncher loads directly. Full service startup is not claimed.
- The reproducible production-mode logging microbenchmark FAILED its5% target:
  median message overhead211.20%, printf196.21%, object167.65% for20000 calls per
  case. New absolute batch times were21.54ms/26.20ms/59.62ms respectively. The test
  writes to synchronous in-memory discard streams and does not establish production
  disk/network throughput. The failure is recorded in VERIFICATION.json; no threshold
  was weakened and no performance acceptance was checked off.

REQ-00391 is reopened and REQ-00683 is in progress. The inventory now has210 legacy
done declarations,440 new requirements and8 in progress. The documented logging
functionality and scanner progress do not imply all requirements or all logging
performance/adapter conditions are complete. See docs/LOGGING-MIGRATION.md.

## Service initialization and shutdown repair (2026-10-07)

The user asked whether work was still running. No persistent goal or automation was
active; ordinary prior replies ended their runs. Requested explicit authorization
for a persistent goal and continued authorized local repository work while waiting.

GitHub checks at 1ad7793: main CI/CD, dependency and privacy workflows passed.
Contract, API contract, performance, integration and security workflows failed;
E2E was cancelled. The repository as a whole is not accepted or fully green.

ServiceLauncher previously opened its listener before user-service initialization;
its 404/error handlers also preceded routes mounted in onReady, and its basic
/health masked the dependency-aware health router. The new onInitialize hook runs
before listening and terminal fallbacks. user-service now initializes health/GDPR/
compliance/deletion/title dependencies there. Its onShutdown hook stops the health
check interval, including failed startup. onReady remains a post-listen callback
and is documented as unsuitable for registering routes.

Concurrent starts share initialization, startup/bind/post-listen failures close the
owned listener and invoke cleanup, and shutdown removes signal listeners, drains
requests, bounds stalled HTTP connections and permits restart. Explicit port 0
selects an ephemeral listener. Library shutdown does not exit the host process.
HealthChecker clears deadlines after completed checks and honors custom critical
registrations when calculating health. This does not make unknown dependencies
healthy or implement all recovery requirements.

Validation:

- Full Node20 unit command: 95 standalone + 133 battle + 362 Jest = 590 passed.
- Added 11 lifecycle/health regressions use actual HTTP listeners and cover deferred
  initialization, 503/live probes, business/error/404 paths, bind collisions, startup
  cleanup failures, concurrent starts, in-flight draining, stalled socket closure,
  shutdown during startup, restart, custom critical checks and cancelled deadlines.
- Existing standalone ServiceLauncher checks: 26 passed separately.
- Actual PostgreSQL privacy/router/gateway tests: all 11 Node checks passed again.
- 1381 JavaScript files parse, runtime logging scan remains zero, 12 tool tests pass,
  health registration checks find all 9 entry points, and numbering has no duplicates.
- An initial unit invocation with LOG_LEVEL=silent disabled intentional test logging;
  a later fake-clock check counted a logger microtask. Corrected invocation and clock
  isolation (real nextTick/setImmediate) passed the full suite without weakening any
  production assertion. Completed health deadlines are still explicitly checked.

REQ-00159's old done declaration is reopened; REQ-00682 is in progress. Existing title
service uses a Knex-style db function although shared/db exports PostgreSQL operations;
full user-service startup remains unverified and this repair does not claim it works.
Self-healing, Kafka/Redis/resource coverage, isolation/recovery/diagnostics, seven-dependency
container, three-service migration, measured startup improvement and coverage target
remain outstanding. Inventory: 658 unique requirements, 209 legacy done declarations,
439 new and 10 in progress. Partial evidence is source-hashed in VERIFICATION.json.

Publication: the lifecycle change is committed locally. A normal push was attempted
with terminal prompts disabled and failed because no GitHub username/sign-in
credentials are available to this checkout. No token was placed in command text,
configuration, files or logs. Draft PR #6 still contains earlier published commits;
this new lifecycle commit has not reached remote CI. The full backlog remains open.

## Completion plan and first implementation batch (2026-10-07)

The user requested a plan and continuation to finish the existing backlog. Created
COMPLETION-PLAN.md covering all 658 documents, prerequisites/P0 ordering, service,
security, game/client, measured quality, operations, tooling and final acceptance.
The plan is open in the app. Requested explicit persistent-goal authorization to
continue across replies; no Goal has been created without that request.

At 890b779, main, dependency and privacy GitHub workflows passed. Contract/API contract,
performance and legacy integration workflows still fail. Integration job logs confirm
production-schema mismatches, missing tables and invalid legacy imports rather than
accepted production behavior. Publication credentials are available from the
user-authorized external file; no credential content is copied into repository files.

Correction to earlier startup notes: shared/db DOES export a .db query builder.
The title service's failing assumptions concern unsupported grouped where callbacks,
db.fn.now and treating a transaction client as a Knex function. Its initialization
query can work when the table exists. Actual startup also exposed a bad timezone
import, title/public path shadowing and asynchronous notification initialization.

Implemented:

- Title service now uses parameterized PostgreSQL operations with injectable database,
  cache, metrics and event bus. Concurrent duplicate grants are idempotent; concurrent
  title switching locks the user and leaves one active title. Failed switching rolls
  back. Expired titles cannot provide bonuses or appear in active/statistics views.
  Redis invalidation failures do not change authoritative ownership or convert a
  committed update into an apparent failed mutation. Snapshot caches are not trusted.
- Title routes restrict manual grants and expiration jobs to signed admin roles,
  enforce numeric/boolean inputs and typed errors, and register leaderboard/shop
  before title-ID parameters. The explicit public title/timezone routers are mounted
  before broad user/session authentication and profile parameters; private title
  paths still authenticate locally.
- New additive title bootstrap preserves the old migration and existing definitions,
  provisions 20 titles, matches users.id's UUID/BIGINT/INTEGER type, enforces one active
  title, and can rerun its trigger setup. A mismatched existing identity type fails
  with a request for an explicit mapping; no user-ID conversion is guessed. UUID
  databases need this bootstrap before the incompatible legacy title migration.
  This is not acceptance of the full migration history or all legacy title shapes.
- Timezone import fixed; preference routes verify identity and ownership before reads/
  writes, validate boolean flags, and use a real Time-Zone header instead of returning
  a fabricated IP-detection result. Global timezone/DST/event behavior remains open.
- user-service now awaits all seven notification subscriptions and initializes its
  configured Kafka producer. Startup health checks exercise PostgreSQL/Redis/Kafka,
  app.locals.db is initialized, and an explicit PORT (including 0) is honored.
  Shutdown closes owned database/Redis pools and Kafka resources. EventBus closes
  consumers concurrently, releases failed subscriptions and admin health connections,
  and reports cleanup errors. Serial Kafka disconnection caused the measured shutdown
  failure; concurrent closure resolves it without extending the 15-second test limit.

Validation:

- Full Node20 unit run: 95 standalone + 133 battle + 380 Jest = 608 passed (21 Jest
  suites). Replaced the old non-executed/broken title mock suite with 8 meaningful
  failure/validation tests; added 4 timezone, 4 EventBus and 2 subscription regressions.
- Actual PostgreSQL/Redis/title HTTP suite: 13 checks passed, including UUID/BIGINT
  migration, input/authentication, concurrent grants and activation, deliberate
  rollback, expired benefits, public views, limits, cache outage and metric export.
- Core title storage regression coverage on Node24: 96.67% lines, 81.48% branches,
  92.86% functions; real 80% line/function gate passes. Unit-only coverage remains
  a separate outstanding acceptance target.
- Real user-service process starts on an ephemeral port against an isolated schema
  using the production users identity DDL, title bootstrap, local Redis and local
  Apache Kafka 3.9.1 with provisioned topics. Dependency health, signed/unsigned
  title endpoints, GDPR/deletion route reachability and natural process termination
  after shutdown are exercised. Final Node20 warm sequential empty-list HTTP sample
  (50 reads): median 1.864ms, p95 3.359ms, max 4.084ms; shutdown 5677.894ms. This is
  local evidence, not a production-capacity or representative-population benchmark.
- Actual privacy/PostgreSQL/router tests still pass all 11 checks. Syntax 1386 files,
  logging scan zero, health registrations 9, tooling tests 12 and numbering pass.
- Dedicated title workflow runs unit, real storage/coverage and actual process startup
  on Node24 with PostgreSQL, Redis and an isolated Kafka container. Remote result
  remains pending publication and CI at this entry.

REQ-00106 and REQ-00612 are in progress; REQ-00026's old done declaration is reopened.
Current inventory: 208 legacy done declarations, 437 new, 13 in progress. All 658 IDs
remain unique. Full UI/profile/game-stat application, automatic achievement cross-
service schema integration, notification history/preferences/client latency, global
UTC/DST scheduling and full legacy integration/contracts/production criteria remain
open. Next batch follows COMPLETION-PLAN.md; no all-requirements completion is claimed.

The workflow's Node24 runtime was checked locally too: title unit8 and actual service
startup/shutdown1 pass. Current Node24 actual process warm HTTP p95 3.363ms and shutdown
5402.016ms. Cleanup attempts Kafka/database/Redis closures independently and reports
aggregate failures. KafkaJS emitted a Node24 negative-timeout warning in one earlier
successful run; this library warning has not been diagnosed or suppressed. The final
Node24 run passed and emitted no such warning. No runtime-support or production-SLO
claim is inferred from these isolated checks.

Published first-plan implementation as c52d5de to draft PR #6. Main CI/CD432,
dependency236 and privacy4 passed. The first title workflow failed before tests:
GitHub runner passed the single-quoted health command as separate Docker flags
(`unknown shorthand flag: U`). Corrected both health commands to runner-compatible
double quotes and made cleanup conditional on the Kafka container actually existing.
This fixes test setup; it does not hide any test failure. Follow-up remote run pending.

Follow-up 4afcce9 published. Related remote checks PASS: main CI/CD433
(run37623349227), dependency237 (37623349416), privacy5 (37623349225), and title
regression2 (37623349256), including actual Node24 service/storage/Kafka startup and
shutdown. Contract, API contract, performance and legacy integration still fail;
security/E2E were still running at the snapshot. Related partial evidence now records
CI verification; this does not mark any complete requirement done or all 658 finished.

## Persistent-goal continuation: IP appeal runtime (2026-10-08)

The human explicitly started the persistent goal; it is active for all 658 existing
requirements. The previous goal turn created authoritative goal state (progress).
Revalidated clean c58888f and current CI: main/dependency/privacy/title workflows pass;
contracts, performance, integration and security fail, E2E cancelled. No no-progress
or blocked condition applies: this turn repaired actual P0 user-route dependencies.

REQ-00149 was mounted but depended on a gateway process-local IpBanManager, so user-
service could not resolve it. Private handlers inspected req.user without verifying
JWT. REQ-00075 also had a Map used as a Set, unsupported metrics calls, permanent/CIDR
ban bugs, shared-cache expiry hazards, and gateway enforcement mounted after business
proxies. Reopened both legacy done declarations and repaired those concrete defects.

User-service now owns/initializes/closes its manager with actual shared database and
Redis clients. The manager exposes an awaited initialization result, owns only its
created resources, handles malformed subscription messages, and performs ban/white-
list/CIDR/expiry authorization reads against PostgreSQL. It no longer wipes shared
Redis ban maps or treats advisory cached state as permission. Risk cache values must
be canonical integers0..100 or are read again from authoritative storage. Geo lookup
uses one connection instead of holding a connection while acquiring another.

Private appeal handlers verify JWT before checking dependency availability, use the
verified user ID, validate string/length inputs, use production nickname fields and
release status-query clients on failure. Public check works without authentication.
Removed an unsupported 24-hour processing promise. Production proxy helpers support
8 documented/client aliases, overwrite caller forwarding headers with the gateway's
resolved address, and remove X-Real-IP. Express trust-proxy ranges are explicit and
disabled by default; docs/IP-APPEALS.md describes network-boundary requirements.

Gateway IP enforcement moved before terminating business proxies. Appeal/health
paths remain reachable for blocked users. Missing/failed access-control dependencies
return503 instead of silently granting access. This does not claim the complete
monolithic gateway process or every admin/ban workflow has been accepted.

Evidence:
- Node20 fullunit:95 standalone+133 battle+385 Jest=613 passed (22 Jest suites), including
  5 new tests for proxy-boundary matching, identity verification and trusted addresses.
- Node24 real PostgreSQL/Redis/ban-middleware/appeal/proxy suite:9 checks passed, including
  all aliases, permanent/CIDR/expired bans, whitelist precedence, forged forwarding
  headers, input validation, stored authenticated ownership, reviewer display, corrupt
  risk cache, failed status-query release and storage outage enforcement.
- Node24 actual user-service process:1 pass. Uses production UUID users identity DDL,
  existing title bootstrap, new IP bootstrap, real PostgreSQL/Redis/Kafka; posts and reads
  an appeal through the production proxy module and checks the persisted verified UUID.
  Public/check200 and invalid-token/status401 are exercised. Natural shutdown succeeds;
  local warm title HTTP p95~3.264ms and shutdown~5485.511ms are not production SLO proof.
- Existing real privacy storage/proxy tests11 and tool tests12 pass; nine health
  registrations, syntax and logging-zero checks pass. Workflow YAML parses. Targeted
  title/storage/process workflow now also executes IP appeal regression and includes
  IP migration/proxy changes in its trigger paths. Publication/remote results pending.

Known remaining scope: full native gateway startup; true caller IPs in an authorized
multi-hop deployment; automatic-ban time windows and transaction consistency; complete
admin approval/rejection and CIDR unban semantics; real GeoIP; full Pub/Sub/retention/
metrics coverage and admin UI. Existing legacy migration checksum is preserved with
an additive UUID-compatible GiST bootstrap; non-UUID legacy identities and the complete
migration history still require explicit validation. Both requirements stay in progress.

Published1992fb4 to draft PR6. Remote checks PASS: main435 (37715515569), dependency240
(37715515562), privacy7 (37715515583), title/IP/storage/process4 (37715515610). Contract,
API contract, performance and integration remain red; security/E2E were still active
at the snapshot. Related source-hashed evidence is partial_ci_verified, not complete.

Independent next-step probe: the actual gateway entry point loads/listens but reports
missing core warmup/IP tables on the unprepared test schema and ioredis connections to
an unconfigured/default Redis endpoint. Its existing shutdown hooks prevent termination
on the startup probe's SIGTERM; verified the exact owned node process and timeout parent,
then killed only that probe. Own PG/Redis/Kafka test containers stopped after verification.
No production deployment or user-data operation occurred. Next goal continuation should
fix gateway dependency configuration and lifecycle and run against a fully prepared
production-compatible schema, then verify actual gateway/user route contracts. Progress
was made; there is no blocked audit condition and the full goal remains active.


## Persistent-goal continuation: native gateway lifecycle (2026-10-08)

Confirmed 343ec57 pushed and working tree clean before implementation. Goal active;
this turn makes substantive progress. Replaced detached gateway initialization and
unowned HTTP listen with the existing ServiceLauncher lifecycle, preserving streaming
proxy middleware order. Before listening: actual PG connectivity, configured Redis,
then awaited IP manager initialization. Failure cleanup releases subscriptions, cache
and PG/Redis resources; signal handlers drain HTTP before dependency cleanup. Removed
a caller-supplied duplicate subscriber so the manager owns and closes its subscription.
Cache cleanup interval now has a stored handle and is cleared on close. Warmup remains
nonblocking and shutdown awaits its outcome before removing refresh timers.

Business-events routes use the shared service-owned Redis client instead of a new
default connection. REDIS_URL is honored before host/port defaults in the singleton
and independent cache client. Global IP limiting uses the trusted resolved address;
IP enforcement is now before every business/operational route, including routes that
previously preceded the business proxy block. Warmup admin operations verify JWT/admin
roles and parse their own body without consuming all proxy request streams.

Gateway /health/live and /health/ready added; readiness rechecks actual PG, Redis, IP
table accessibility and all named registry targets; preserves /health services shape.
Unavailable services remain named, not '?'. No nonexistent Kafka check is claimed for
a gateway that currently does not initialize/use Kafka itself. Other service/gateway
admin authentication gaps and JWT revocation fail-open paths remain to be repaired.

Evidence: Node20 npm test613 passes (95 standalone,133 battle,385 Jest/22 suites).
Node24 actual storage/proxy/title/privacy tests33 pass (IP9,title13,privacy11).
Native gateway CLI plus real user CLI scenario passes: absent IP schema prevents listen
and naturally exits1; populated actual UUID users/title/IP DDL permits dependency-first
listen; public check, invalid status token401, signed POST/status and stored canonical
IP/user ownership work through production gateway. CIDR blocks business and operational
routes, but appeals/health remain reachable; forged XFF/X-Real-IP cannot override identity.
Warmup admin401/403/200 verifies actual role authentication. Renaming the IP table makes
readiness/business503 while liveness200; stopping the actual user process makes named
upstream checks unavailable. Gateway SIGTERM ~937ms, user SIGINT~5148ms including an
outage probe, both natural code0 exit. Conflicting host/port with correct REDIS_URL
works, including independent cache. Changing forged XFF each request still reaches
global429. There are no unhandled ioredis/default-endpoint errors.

Fixture contains only actual user/title/IP production DDL and explicit bootstrap;
missing game warmup data remains reported as failedCount. Seven other registry targets
point to the actual user fixture to test registry mechanics; their services are not
accepted. REQ-00039 legacy done reopened: missing description_en in V1 species, full
game data contracts, refresh correctness, coverage, <2s startup impact and cold-five-
minute latency remain unverified. Req149/159/682 progress appended; full scopes remain
open. Syntax1391 files zero errors, workflow YAML parses, diff whitespace clean.
Targeted title/storage/process workflow now includes native gateway regression.
No acceptance thresholds lowered, no full requirement promoted, no merge/deployment.
Publication and new remote CI results pending. Goal stays active.


Published d276dbb to draft PR6. Related remote workflows PASS: main437/37716906878,
dependency243/37716906899, privacy9/37716906894, title/storage/IP/user/native-gateway6/
37716906946. Native gateway step12 success confirmed via workflow jobs. API contract66
and performance105 failed; integration412, contract362, security395 and E2E99 remained
active at the snapshot. Ledger partial records updated with code-commit CI evidence;
no complete requirement promoted.

Independent next-batch full-schema probe used a new owned PostGIS container matching
production docker-compose image postgis/postgis:15-3.4-alpine, localhost55433,512MB.
Full V1 schema succeeds. Transactional full V2 seed fails evolves_to=55 FK, preserving
zero seed mutations. Standard migration CLI fails pg module resolution. Diagnostic
NODE_PATH pointing to backend dependencies lets actual runner discover79 files, then
fails 20260605_180000 moves FK because species25 is absent after seed failure. Transaction
rolls back all pending changes including new schema_migrations/migration_lock tables;
lock-release cleanup logs a secondary missing-table error. CLI also has an unconditional
undefined err on success rather than catch; legacy migrate.test copies logic instead of
exercising production CLI. REQ00007 reopened (204done/17inprogress/437new), source-hashed
failure evidence recorded. Next: fix actual CLI lifecycle and complete fresh seed/
migration contracts, with real PG and checksum/concurrency/rollback checks. No production
operations, no baseline-deleting resets, no new requirement scope. Goal stays active.


## Persistent-goal continuation: actual migration execution (2026-10-08)

Previous goal turn made substantive progress: d276dbb gateway repairs and related CI
passed,2e2dd2d documentation published. Revalidated clean worktree and active full658
Goal; no blocker audit condition. This batch repairs the next real database setup path.

Runner now resolves pg from installed backend declarations, uses a proper CLI catch
and natural pool cleanup/exitCode, and exposes owned pool closure for shared startup.
Transaction-held PostgreSQL advisory locking is scoped to database/schema, honors
MIGRATION_LOCK_TIMEOUT_MS as wait limit, and is released by transaction/session end.
All apply/rollback SQL and source-hashed history stays in one transaction; no stale
fixed-expiry row lock or secondary missing-lock-table failure. Checksum validation
precedes up/down; missing applied files, duplicates and invalid names cannot silently
pass. Actual PostgreSQL lexer handles strings/dollar function bodies/nested comments;
only top-level section markers split scripts. Legacy whole-body/trailing COMMITs stay
under runner ownership; internal transaction controls and empty templates are rejected.
No existing pending migration contents or checksums were changed.

Shared DB startup is memoized, verifies history, optionally runs actual pending SQL
when AUTO_MIGRATE=true and closes the migration pool. Gateway/user call this before
business initialization and HTTP listen. Other services still need integration.
SQL V2 sample seed gained missing evolution targets55/75/76/80, preserving chains.
New target base stats checked against the fixed PokeMiners game-master snapshot
8e227be44f288d34463e23bf04e9b564d3c16f79; rarity/catch/biomes are sample balance choices.
Full original V1 DDL plus revised V2 seed succeeds in owned PostGIS15:32 species,8
achievements,5 stops,3 gyms and no missing evolution target. This is a sample, not151
complete species or all game feature acceptance.

Evidence: Node20 npm test619 (95standalone+6actual migration parser+133battle+385Jest)
passes. Node24 actual migration CLI/storage10 pass: native create/status/up/verify/down
without NODE_PATH; rejection of blank SQL; durable checksums/data/functions; idempotency;
tampered/missing/duplicate/invalid scripts; target/last/empty rollback; SQL failure rolls
back whole batch including legacy wrappers; two processes apply once;100ms configured
lock wait times out; killed owned CLI's exact PostgreSQL backend eventually ends and
its lock is released; actual AUTO_MIGRATE shared startup runs once and exits naturally.
In-flight pg_sleep may finish before client loss is detected: initial3s observation
failed, then test was corrected to wait for authoritative exact-session termination
(~10s fixture), not to expire/steal its lock or claim immediate recovery.

Native gateway/user process scenarios both pass after migration initialization changes.
An initial concurrent fixture run exposed uuid-ossp installed in disposable schemas;
serial/shared-public extension ownership repaired (storageSetup.js), rerun passes.
Business PostgreSQL/Redis/privacy/title/IP suites33 pass. Full-history gate runs actual
V1 and seed, then all79 default pending scripts; seed passes, pending run fails missing
items in20260609_124500. Earlier dependency/seed failures are repaired; no missing table
faked or bad migration skipped. New migration workflow executes both tool/storage and
full-history gate, with the final real failure retained. README and migration guide
explain commands, lock/rollback semantics and acceptance limits. Remote results pending.

Next goal turn: reconcile legacy prerequisite/table contracts through an audited
ordering/catalog/bootstrap path, preserve applied pending file checksums, then rerun
whole history and warmup. Complete requirements7/39/306 and remaining service scopes
remain open. No new requirements, no merge/deploy, no production data operations.


## Persistent-goal continuation: migration dependency and catalog contracts (2026-10-08)

Previous turn made authoritative progress in07248db, published to draftPR6. Revalidated
clean worktree and remote CI: main439/37719050021,dependency246/37719050047,privacy11/
37719050042,title/storage/nativeprocess8/37719049932 pass. Migration1/37719050130 passed
parser/storage then failed actual full history at items (expected open defect). Contracts,
API contracts, performance, integration and security fail; E2E101 was active at snapshot.
No Goal blocked condition: this turn repairs the next concrete schema execution paths.

Added dependency manifest/topological plan and tracked actual execution_order. Applied
source/dependency/executed-SQL checksums are distinct; up/down/verify reject drift and
invalid/missing/cyclic references. Legacy history adoption preserves source hashes/data,
backfills old time/version order before adding uniqueness, and leaves unknown execution
hashes NULL. Storage test deliberately reverses physical legacy row insertion to expose
and prevent unique-order backfill collisions. Rollback uses real execution order.

Added owned item catalog prerequisite based on the repository localization table
contract, plus UUID Pokedex statistics cache prerequisite. Ownership/OID state prevents
rollback from deleting a preexisting table or a replacement relation; existing incompatible
identity is rejected rather than cast. Both execute before their legacy consumers.

Actual full run exposed invalid legacy SQL beyond missing prerequisites: partial UNIQUE
constraints embedded in CREATE TABLE, missing inet_ops, six trailing spawn VALUES commas,
DECIMAL5,4 unable to hold seeded weight15, and V1 UUID foreign-key mismatches. Originals
remain byte-identical. Explicit repairs.json binds each exact originalSHA to a complete
reviewable SQL correction and reason, with guarded paths and separately persisted
execution hash. Logs say which correction runs; no migration or intended data silently
skipped. Guild seed uses actual guild IDs instead of nonexistent guild0. Repair fields
align the canonical V1 UUID identities; undocumented historic schemas remain unaccepted.

Real inventory SQL then exposed integer capacity arguments, unnamed default records,
OUT/column ambiguity, a BIGINT remaining value returned as INTEGER, and expiry writing
zero against a positive constraint. Corrected capacity takes UUID, validates positive
addition, uses named defaults/qualified aggregates and typed nonnegative remaining.
Expiry deletes expired rows and updates capacity while preserving valid inventory and
the positive-quantity check. Actual storage tests verify >=20 catalog items, ownerUUID,
default/over-capacity, expiry cleanup, FK/quantity rejection and safe catalog rollback;
these do not accept every HTTP/service/client/event/cache requirement.

Evidence: full unit621 (95standalone+8runner+133battle+385Jest), actual CLI13, actual
prerequisite/inventory2, business PostgreSQL/Redis33 and native gateway/user process2
pass. JS syntax now covers database too:1413 files zero errors. Workflow YAML and diff
checks pass. Full original V1+V2 sample seed passes; all81 pending (79original+2new)
remain gated and source-hash checked. Execution advances to20260610_100000 audit partition
conflict: resource_type absent, audit_logs still an ordinary V1 table, IF NOT EXISTS
did not perform conversion. The whole migration transaction rolls back on this failure.

Reopened req47/56/60 (201legacydone/20inprogress/437new), preserving historical claims
and appending evidence. New tests added to migration CI and metadata paths to native
process CI. No complete requirement promoted, no numeric gate reduced, no prod operation.
Next: proper audit partition conversion preserving ID/all existing fields/data/constraints/
sequence/index/trigger and reference behavior, then actual writes/queries/rollback and
remaining full migration conflicts. Goal remains active with all658 scope.


Published f79d55f to draftPR6. Remote main440/37721852020,dependency248/37721852033,
privacy12/37721852024 pass. Migration2/37721852054 parser8/CLI13/catalog-inventory2
steps pass; full-history step9 fails20260610_100000 statement21 resource_type absent,
confirmed via job113131064031 logs. Native title/process9 was still active at the
snapshot. Partial evidence recorded, no full requirement promoted. Own PG/Redis/Kafka/
PostGIS containers stopped after tests; no live owned local process remains. Goal
continues next with actual audit partition conversion, all658 scope unchanged.


## 2026-10-08 — Audit partition conversion and full-history advancement

Previous goal turn: progress (actual dependency/catalog SQL, runner history tests,
published reviewable source and authoritative CI failures). This turn: progress.
No missing input or repeated blocker prevents continued implementation. Full658
requirements remain the goal; no new numbered scope or requirement is accepted done.

Added transactional audit prerequisite ahead of the legacy partition consumer. V1
BIGSERIAL/UUID owner/types/rows/ciphertext/sequence survive; original storage becomes
DEFAULT. Copies outbound FKs, expression/include/predicate indexes, ordinary views,
triggers+enabled states and original grants. Registry/AFTER triggers enforce logical
ID uniqueness across partitions while allowing date/ID movement and deletion.
Rollback restores original relation OID/idPK and retains old+new rows/additivefields.
Prototype exposed inherited composite PK on DETACH; actual rollback fixed and verified.

Schema-scoped time helper validates parent/bounds/owned names, moves matching default
rows transactionally before attachment and restores trigger states without duplicate
side effects. Concurrent creators recheck target after parent locking. Invalid bounds/
overlaps/name collisions preserve rows/triggers, and unsupported forcedRLS/incomingFK/
extrauniqueness/materializedview/customidentity cases fail explicitly. Existing range
audit parent is preserved through up/down. Full original81 pending sources byte-identical;
third prerequisite yields82 total. Guarded whole-source repairs also fix partition
function, two invalid inline MySQL INDEX declarations and four UUID achievement owners.

Evidence: actual PostGIS partition23pass (including five real parent SQL writes/row
routing, not five complete service workflows); fullunit621pass; migration CLI13 and
prerequisite2pass; actual businessstorage33/nativeprocess2pass; syntax1414files zero
errors. Full V1+V2 passes, but complete82history fails20260611_000000 statement7 completed
missing after successfully traversing audit/analysis SQL. V1 user_achievements has
current_value/current_tier and FK to achievement_definitions; newer service expects
progress/target/completed and achievements. UUID repair is partial. Do not drop old
progress/FKs or add columns and infer unified rewards. Full-history gate remains red.

Migration CI now runs audit storage checks before full history. Req76 moves new->
in_progress, all201legacydone/21inprogress/436new kept distinct from0 independently
verified requirements. Req7/60 records append partial source-hashed evidence. Future
three-month runtime partitioning, subsequent duplicate parents, all service contracts,
archive/restore/retention/metrics/API/coverage/performance remain open. Prior f79 CI
main440/dependency248/privacy12/titleprocess9pass, migration/contract/API/integration/
performance/securityfail, E2E102cancelled; new source CI pending. Next: achievement
catalog/progress/reward reconciliation and remaining full-history/schema service work,
then all original stages. No production migration, merge or deployment performed.

Shared migration metadata hashes in other partial records refreshed only after
matching runner/storage/native tests above; old evidence retained and current full
history failure explicit. Req47/56 current status partial_verified_full_history_failed,
not complete. Owned local test services stopped after terminal probes; no background
fixture process left running or production data touched.

Final staged review found whitespace inherited in the three new whole SQL repair
copies. Cleaned those copies before publication, keeping original files unchanged.
Matching actual SQL tests repeated: audit23/fullV1V2pass, full82history still red at
achievementcompleted (combined24pass/1fail). Only changed repair execution hashes
refreshed. Full change diff check now passes.
