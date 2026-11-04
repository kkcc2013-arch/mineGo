# Database-driven cache invalidation

The gateway starts the production `CacheInvalidationCenter` before listening.
Apply the canonical root `database/migrate.js` history first. The source-bound
repair for `20260707_100000` uses the existing 18 canonical tables; it does not
create historical aliases such as `pokemon`, `friends` or `payments`.
The separate legacy files in `backend/migrations` are not this migration runner's
input and must not be substituted for its checksummed history.

Each source transaction inserts an event into `cache_invalidation_outbox`.
It records only approved, bounded identity columns, including old/new owners.
The schema-scoped PostgreSQL notification contains an opaque event UUID. A source
rollback removes its event and notification together. The outbox allows replay
when a listener disconnects; notification delivery alone is not durable work.
See PostgreSQL's [NOTIFY transaction and payload rules](https://www.postgresql.org/docs/15/sql-notify.html).

Workers claim at most 50 ready events with `FOR UPDATE SKIP LOCKED`, read the
current settings revision under a shared lock, deduplicate matching rules and
acknowledge only after real Redis deletion succeeds. Failed Redis attempts remain
in PostgreSQL with exponential retry delays capped at 30 seconds. There is no
Redis-dependent retry queue, fixed retry count or expiry that drops pending work.
New workers drain pending events before enabling response cache reads.

The cache uses a private hashed storage prefix per namespace, Redis database and
namespace-scoped broadcasts, and an independent bounded L1 Map in each process.
Default namespaces distinguish the PostgreSQL database and schema. Set
`CACHE_NAMESPACE` consistently across replicas, and uniquely across separate
clusters/environments sharing Redis. Allowed characters are letters, digits,
underscore, colon and hyphen, up to 80 characters. The gateway uses the existing
Redis URL/host configuration; no credentials belong in this document or a cache
rule. The cache requires ordinary Redis commands, EVAL and Pub/Sub. Redis Cluster
and arbitrary distributed cache clients have not been verified by these tests.

Strict invalidation scans only the owned prefix using
[SCAN](https://redis.io/docs/latest/commands/scan/), with Lua batches of at most
100 keys. A source batch groups up to 100 rules into a shared scan, including
joined profile counts, species/candy and friend data dependencies. Each batch
changes outstanding fill tokens, deletes values and
publishes its invalidation in one Redis operation. A reply started before an
invalidation cannot refill a key afterward using its old token. Lost command or
subscription transport clears/bypasses local data. Reconnection flushes the owned
namespace before normal reads resume, including values restored from an old Redis
snapshot. This recovery is necessary because
[Redis Pub/Sub is at-most-once](https://redis.io/docs/latest/develop/pubsub/).

The actual gateway proxy observes up to 1 MiB of identity-encoded JSON while
streaming to the caller. Cached envelopes preserve status and selected response
headers. Errors, Set-Cookie, no-store/no-cache, unknown Vary dimensions, malformed
JSON and oversized bodies are not cached. Keys include canonical full paths,
a hash of sorted structured query values, verified JWT subject and language.
The personal Pokédex requires authentication. Private user statistics are limited
to the verified account; public profiles use the existing whitelisted user route.
The source database update determines cache invalidation, independently of which
application handler performed it.

## Admin configuration

The mounted `/api/admin/cache-invalidation` routes require a signed admin token,
the gateway's JWT blacklist checks and global IP access control.

- `GET /status` and `/metrics`: actual process counters and durable backlog.
- `GET /health`: 200 when recovered; 503 during listener/cache/backlog recovery.
- `GET /rules`: durable document, revision and effective baseline rules.
- `POST /rules`: validated document plus `expectedRevision` from the read.

Example JSON body (use the actual revision returned by GET):

```json
{
  "expectedRevision": "1",
  "document": {
    "version": 1,
    "customRules": {
      "users": [
        {"type": "glob", "pattern": "query:profile:*user:{id}"},
        {"type": "regex", "pattern": "^query:public-profile:.*$"}
      ]
    }
  }
}
```

Baseline YAML rules are always retained; API configuration adds rules for the
actual source tables. Only available identity placeholders are accepted. Glob
rules support at most two `*` wildcards; literal wildcard/bracket/question-mark
characters must be escaped. Regex rules use anchored literals, escaped punctuation
and at most two `.*` tokens. Groups, alternation, classes, backreferences and other
quantifiers are rejected. This explicit subset avoids arbitrary regex execution.
Documents are limited to 64 KiB and 32 custom rules per source. Concurrent revisions
return 409; invalid documents return 400; oversized JSON returns 413. Committed
configuration awaiting cache recovery returns 503 and remains readable for retry.

## Evidence and remaining acceptance

The real SQL, Redis, worker and HTTP suites are
`cdc-invalidation-storage.test.js`, `cache-coherence-storage.test.js`,
`cdc-cache-runtime.test.js` and `cache-http-storage.test.js` under
`backend/tests/regression`. Native gateway startup additionally exercises two
separate gateway OS processes against the actual user-service process, PostgreSQL,
Redis and Kafka. Startup failures and signal shutdown retain their existing tests.

Prometheus reports applied event counts, failed attempts, pending work, readiness
and actual worker processing duration. Success logs contain batch counts and
processing time, without source row data or credentials. Admin success rate is
successful event application attempts divided by all event attempts in that
process; an idle process reports null. It is not a global delivery ratio.
Worker duration is not database commit-to-cache latency. The separate source-hashed
latency report measures actual writer operations through both L1 maps and Redis.

REQ-00479 and REQ-00523 remain in progress. Passing healthy isolated latency and
recovery fixtures does not establish production capacity, long outage bounds,
database-load acceptance, all legacy cache consumers or every acceptance criterion.
The complete original 85-file migration history is still a separate failing gate;
its next concrete error is recorded in the worklog. No numerical target has been
lowered and no failed throughput run has been removed.
