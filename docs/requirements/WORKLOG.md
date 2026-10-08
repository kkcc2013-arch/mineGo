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
