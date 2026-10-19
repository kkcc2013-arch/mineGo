# Sensitive audit storage and remaining runtime work

REQ-00038 remains in progress. Its ten original criteria, including rotating
AES-256-GCM keys, complete access audit, ten masking types, admin MFA and at least
90% crypto/masking/permission coverage, are unchanged. This checkpoint verifies
storage isolation and database function privileges. The subsequent runtime
checkpoint is described in [audit encryption](AUDIT-ENCRYPTION.md).

The original `20260608_200000` migration checked `information_schema.columns` by
table and column name across every schema. Another schema's encryption tag caused
the current audit table to skip that column, then fail its comment statement.
The root runner now selects a source-hashed repair; the original SQL stays intact.
All four checks are scoped, and relation lookup is temporarily isolated to the
actual target schema. The exact caller search path is restored. Independent audit
schemas and existing objects are preserved.

Canonical audit BIGSERIAL identities, rows, stored cipher bytes, IV/tag text,
wrapped keys, view dependents and operator comments remain intact. Existing
compatible field definitions are retained; incompatible crypto columns, cleanup
functions/configuration or statistics definitions require explicit adoption.
Missing historical key versions remain null; a default applies to future keys.
The repair does not generate new keys, reconstruct lost authentication tags or
rewrite encrypted history.

The V1 audit `created_at` is a timestamp without a timezone. Its historical wall
clock does not prove an absolute instant. A newly added event timestamp therefore
stays null for those existing records; a genuine timestamptz source can be copied.
Future events retain their actual timestamp default. PostgreSQL documents that
converting timezone-free timestamps uses the session timezone unless a different
zone is specified; this migration does not guess the missing provenance.
See [PostgreSQL 15 date/time semantics](https://www.postgresql.org/docs/15/datatype-datetime.html).

Both known cleanup entry points retain their function identities but now use
invoker privileges and fully qualified target tables, with a pinned function
search path. PUBLIC execute grants are removed in the same transaction. Existing
explicit grants do not confer the function owner's DELETE privileges. The repair
and application startup do not invoke cleanup or add a scheduler. Attempts in the
storage tests use only a dedicated read-only fixture role and must fail.
[PostgreSQL's function-security documentation](https://www.postgresql.org/docs/15/sql-createfunction.html)
describes invoker/owner privileges, search-path risks and default PUBLIC execution.

The real storage suite reproduces the original cross-schema rollback; checks
columns, caller settings and another schema; retains real fixture GCM cipher/tag/
wrapped-key data through reruns; checks known versus unknown historical timestamps
and key versions; verifies metadata and actual role denial; exercises custom
function/view/column/config refusal; and runs actual root CLI up/up/verify with
raw and execution hashes. Fixture cryptography verifies preserved bytes, not the
production audit encryption module.

The complete bootstrap suite separately applies all original pending sources on
V1/V2, both alone and alongside an unrelated audit table with matching encryption
column names. This installation evidence does not accept every historical upgrade,
reverse migration, service, provider or security criterion.

The runtime helper now persists authenticated canonical writes, durable wrapped
work keys and true rotation. Sensitive-access writes preserve the complete
cipher/IV/tag/key envelope in existing BYTEA storage and withhold responses when
recording fails. Actual PostgreSQL and real SDK HTTP evidence is described in
[audit encryption](AUDIT-ENCRYPTION.md); live AWS authorization is still open.

The common logger now uses durable encrypted writes and explicit caller-owned
transaction savepoints. Mounted policy/preference operations are verified; other
callers and all complete business/transaction access coverage remain open. Other
remaining work includes authenticated role and admin MFA
boundaries, complete response filtering/scanning, and the dashboard. The existing
sensitive-rule helper still trusts a supplied MFA boolean and is not an HTTP
authorization boundary. These APIs have not been mounted in the production
entry points. New crypto module coverage does not establish the original combined
crypto/masking/permission coverage target or accept every criterion.

No production cleanup, key replacement, external delivery or deployment is performed
by these checks. Local fixture keys are generated at runtime and are not project
credentials.
