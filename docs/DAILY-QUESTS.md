# Daily quest verification boundary

REQ-00097 remains in progress. Its previous done declaration did not have working
modern storage, transactions, actual grants or mounted authenticated endpoints.

The complete source-bound repair for 20260614_090500 retains all22 definitions, all7
categories, reward values and original timestamp types. It replaces invalid inline
date uniqueness with an exact expression unique index and makes the two original date
lookup indexes valid. Original pending SQL remains immutable. The assignment date rule
still uses the original timestamp calendar cast; this does not define player timezone
or pool-aware assignment semantics. The canonical V1 daily_quests relation remains
separate with original UUIDs, progress, completion dates and relation identity intact.

The production reward application mounts createDailyQuestRouter at /rewards/quests.
Its reads use real V1 counters, preserve the existing database-session CURRENT_DATE
contract and assign one row under concurrent requests. Claims use the authenticated
JWT identity, lock the real owner before the quest, and check stored progress after
locking. Invalid targets, missing owners, unfinished/previously claimed tasks and
foreign request-body identities cannot award resources. The four balance increments
and completed/claim markers commit together; original completed_at is retained.

The actual application factory allows tests to use isolated PostgreSQL without
starting an unrelated listener on import. Direct execution still starts reward-service.
This is a mounted HTTP verification seam, not native readiness, dependency health or
signal cleanup acceptance for reward-service. Its login reward and season paths still require separate security/data/runtime
verification. The ranking endpoint now has actual9-case SQL/HTTP evidence described
in REWARD-RANKINGS.md; this does not establish full leaderboards or service readiness.

Run Node24 with TEST_DATABASE_URL pointing to isolated PostGIS:
`node --test backend/tests/regression/daily-quest-storage.test.js`.
18 real checks pass: original history/OID/catalog preservation, exact per-date
uniqueness, UUID foreign keys, anonymous/forged identity rejection, concurrent
assignment, fractional distance, invalid targets, a row-locked progress edit, failed
marker rollback, foreign ownership, 24 simultaneous mounted HTTP claims awarding
once, replay, past-day isolation, deleted owners and a real curl request to the
production application mount. XP is compared as PostgreSQL BIGINT and completion
date as the original timestamp text, avoiding Node-local timezone reinterpretation.

The focused suite is included before the full-history CI gate. V1/V2 loads, and all85
pending files now reach 20260618_160000 statement18, where the voice-chat consumer
contains a mutable time function in its voice-chat index predicate. The entire pending batch rolls back. Full migration history stays red.

Outstanding modern acceptance: callback transactions; immutable assigned objectives/
reward snapshots; daily3/weekly5/limited pools with safe concurrent refresh; actual
trusted gameplay events with durable replay identity and parameter matching; atomic
catalog-backed rewards, capacity checks and encounter grants; UTC/player timezone
and exact first/consecutive/missed-day streak policy; expired completed quests;
secured mounted progress/admin routes; real history data; post-commit notifications,
live progress/client UI; registered metrics; greater-than80% coverage and measured
1000 requests/second. Existing Redis deletion imports and stale caches need real
integration. No fabricated grants, successful startup or numerical targets are claimed.


Current follow-up (2026-10-13): the explicit source-bound voice repair now uses a
stable unrevoked user/expiry index, preserving historical credentials and exact
existing operator indexes. Six actual voice-schema/CLI cases and17 migration
CLI/prerequisite cases pass. Earlier voice-index failure above records the preceding
batch. The unchanged85-source complete gate now fails20260619_000000 statement17:
its duplicate partition helper attempts to change the existing return type. The
whole pending batch still rolls back; complete history and original feature
acceptance remain open. See REQ-00116 and voice-schema-storage.test.js for scope.
