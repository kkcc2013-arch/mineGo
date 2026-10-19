# Job history and monitoring integration

The canonical root migration runner owns the four job-monitoring tables and the
`job_daily_statistics` view. Its source-bound repair for `20260711_120000` corrects
the impossible `created_time` index to the actual `created_at` column used by the
production execution logger. The original raw SQL stays unchanged.

The repair retains compatible SERIAL identities/sequences, execution/alert/health/
suppression rows, UUID acknowledger references, dependent views, operator comments
and existing index identities. Exact type/default/constraint/index/view contracts
are checked before adoption. Incompatible definitions fail the surrounding
transaction; operator data is not dropped, guessed or silently converted. The
actual SQL/storage suite includes real root CLI up/up/verify and raw/executed
checksum checks.

`backend/shared/jobMonitor/jobExecutionLogger.js` lazily uses the existing configured
shared database pool, including `DATABASE_URL`. A caller-supplied pool stays owned
by its caller. Only an explicitly supplied dedicated pool with `ownsPool: true`
is closed by the logger. Initialization verifies migrated canonical storage and
rejects a missing schema; it does not create parallel runtime tables.

Real execution operations include:

- `logStart` persists a running execution with its metadata.
- `logEnd` atomically finalizes the matching job ID and execution ID. Two competing
  outcomes have one winner; a conflicting completion returns 409. A duplicate
  matching outcome returns the existing result without rewriting its duration.
- History, statistics and failure queries use parameterized filters, validated
  limits, stable time/ID ordering and actual stored records. Empty history reports
  an unknown success rate (`null`), rather than dividing by zero or inventing 100%.
- New start/end/creation times use UTC consistently despite Node/PostgreSQL session
  timezone differences. Original timestamp column types and historical values are
  preserved; historical timezone provenance has not been reconstructed.
- Retention is at least 90 days. Explicit cleanup removes only completed old
  success/failure/timeout records whose creation and end time are both old.
  Running, recent and unknown legacy states are retained. No new cleanup scheduler
  or production deletion is started by importing or initializing this module.

The original INTEGER duration representation remains. Durations exceeding its
range are not accepted as verified long-running-job support. Existing legacy state
and date semantics require explicit operational adoption where they differ.

## Fresh installation fixture

The full V1/V2 plus all 85 original pending files now pass the isolated bootstrap
check, including every raw checksum and schema cleanup. This is a fresh-install
result, not acceptance of every upgrade, rollback, service, provider or tenant.

A diagnostic reached all 85 entries but its final schema cleanup exhausted the
fixture's shared object lock table at `max_locks_per_transaction=64`. The owned
PostGIS fixture and migration CI use 256, set before the existing database restart.
The full atomic migration/checksum gate is retained. PostgreSQL documents that
this setting allocates shared object-lock capacity and may need increasing for
transactions touching many tables or partition children; it takes effect at server
start. See [PostgreSQL 15 lock management](https://www.postgresql.org/docs/15/runtime-config-locks.html).
This setting is separate from the measured transaction-throughput baseline.

The retained diagnostic schema also exposed an older audit migration's unscoped
`information_schema.columns` lookup: another schema's audit column can prevent
creation in the current schema. After cleaning only the confirmed owned diagnostic
fixture, the isolated full-bootstrap gate passes. Cross-schema audit installation
still needs a source-bound repair and dedicated verification. This is not hidden
by a claim that the entire migration requirement is complete.

## Remaining REQ-00669 acceptance

The requirement remains in progress. Its ten original criteria are preserved.
Persistent logging and actual local storage tests do not register every job,
mount the admin dashboard API, provide the dashboard, send configured alerts,
prove the 60-second delivery/10-minute suppression targets, or validate zombie
accuracy and health-score errors. Core aggregator/alert/health-checker coverage
still needs its original greater-than-80% verification; logger coverage is a
separate measured module result.

The existing job-monitor route file is still unmounted and has lazy resource
initialization, missing authorization, an incorrect recent-failure projection and
placeholder restart/skip success responses. It must be integrated with real job
execution ownership and authenticated controls before being exposed. Existing
aggregation and alert modules are not accepted by implication. No external alert
recipient has been contacted by these local checks.
