# Durable authenticated audit encryption

REQ-00038 remains in progress with its ten original acceptance criteria. This
checkpoint replaces the broken encrypted-audit helper and the sensitive-access
writer. It does not accept the complete access, masking, permission, MFA, scanner
or UI requirement.

`backend/shared/auditLogEncrypted.js` lazily uses `EncryptedAuditStore` and the
shared `DATABASE_URL` pool. Importing the facade creates no client, timer, schema,
key or file. First use checks the existing canonical tables and refuses borrowing
relations from a later search-path schema; it never runs DDL.
Caller-owned pools and providers remain usable after store close. The facade
closes only its own provider; service owners drain requests, close the facade,
and then close their shared pools. There is no background rotation timer or
cleanup scheduler.

Writes use AES-256-GCM with a new 16-byte random IV and a 16-byte authentication
tag. Audit rows bind their logical ID, subject, action and resource metadata into
associated authenticated data. The writer commits cipher, key ID, IV and tag in
one database transaction. Details, IP and user agent columns remain null. Audit
IDs stay BIGSERIAL strings, including IDs above JavaScript's safe integer range,
and work with the existing global identity registry after partition conversion.

Sensitive-access writes put a versioned cipher/IV/tag/key envelope into the
existing `encrypted_ip_address` BYTEA column. Field names, reason, IP and agent
are inside that authenticated payload; plaintext fields are empty and reason is
null. The row's UUID and subject/accessor/resource metadata are authenticated.
The access adapter reads this envelope and reports unavailable historical rows
explicitly. Its middleware recognizes present values including zero, uses the
trusted request identity/IP supplied by upstream middleware, and returns a 503
without the private response if required recording fails. This is exercised over
actual HTTP in a fresh process; that fixture injects identity and does not prove
production authentication or MFA.

The implementation follows [Node's GCM API](https://nodejs.org/docs/latest-v24.x/api/crypto.html):
AAD precedes cipher processing, tags are captured after finalization, and decrypt
returns data only after authentication succeeds. Managed work-key and plaintext
buffers are cleared after use, including failed writes. This is best-effort
buffer handling; JavaScript strings and library copies cannot be guaranteed erased.

## Keys and configuration

Production requires all of:

- `NODE_ENV=production` and a stable, non-secret `AUDIT_KEY_NAMESPACE` identifying
  the deployment. The runtime additionally hashes the database/schema identity.
- `AUDIT_KMS_KEY_ID`, a full AWS KMS key ARN in its actual region. `AWS_REGION`
  must match when supplied. The SDK uses its standard credential chain; credentials
  are not stored in this repository or in audit rows.
- Optional `AUDIT_KMS_DECRYPT_KEY_IDS`, a JSON array of explicitly retained key
  ARNs in that region. Keep old keys and decrypt permission for retained history.
  Choose a new active ARN only after provisioning its policy and retaining the old.

The declared AWS SDK sends actual `GenerateDataKey(AES_256)` and `Decrypt`
requests. Only the opaque wrapped key is stored. Context contains a fixed purpose,
namespace hash and opaque key ID; it excludes audit payload and PII. AWS requires
identical encryption context on decrypt and records that context in CloudTrail,
so it must contain no confidential data. See
[AWS GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html)
and [AWS Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html).
Response key ARN, plaintext-key length, envelope format and decrypt allowlist are
validated. Requests have one attempt and bounded connection/request timeouts;
timeouts abort rather than merely warn. Provider errors expose fixed codes, with
no plaintext or alternate-provider fallback. Custom endpoints are refused outside
a loopback-only test configuration.

Development/test instead requires an explicit durable 32-byte master in
`MASTER_ENCRYPTION_KEY` (64 hex characters), or `AUDIT_MASTER_KEYS_JSON` mapping
labels to 64-hex keys, with `AUDIT_MASTER_KEY_ID` selecting the active label.
These values are secrets supplied outside tracked files. Old labels must remain
configured while their history is needed. There is no generated master, temporary
file, hardcoded key or fallback to unrelated encryption variables. Production
refuses this provider. Changing provider families requires a separately verified
migration strategy; this checkpoint does not silently rewrap old records.

Work keys use the `audit1:` prefix in canonical `encryption_keys`; other purposes
are neither adopted nor deactivated. Real row/advisory locks serialize creation
and rotation across clients. Reads of an active work key hold a shared lock only;
they never upgrade that lock while waiting for the creation lock. Work keys expire
after the original 90 days. Expiry or a changed active master causes a new key on
next write; explicit rotation always creates a distinct key. Versions increase,
`rotated_from` retains lineage, and old wrapped rows remain readable. A provider
or storage failure rolls back both key changes and the audit write.

The old ASCII `iv:cipher:tag` wrapped-key BYTEA format can be read only when the
development provider has an explicitly configured `AUDIT_LEGACY_MASTER_KEY_ID`.
It must retain every original authentication component. Legacy plaintext audit
rows and lost tags/IVs are reported unavailable; the code never reconstructs or
returns their plaintext as a successful decrypt. No history is rewritten or deleted.

The returned decrypted object nests private audit data under `data`. Internal
callers must enforce actual authenticated ownership/roles and fresh server-verified
MFA before using decrypt, query, status or rotation methods. The facade is not an
HTTP authorization API. No admin decrypt route is mounted by this change. The
older rule helper's supplied `hasMFA` boolean remains insufficient and open work.

## Business transactions and query boundaries

The common `auditLog` wrapper now writes through the encrypted store. Its explicit
application log receipt contains only a fixed code and opaque audit ID; failures
use a fixed code, without private details, identities or upstream SQL/KMS errors.
Existing framework request-context logging is separate. No success is returned
for a log-only operation or an invalid legacy positional call.

Use `db` for a real Pool or the shared `getPool`/`getClient` adapter when the audit
owns its transaction. Use **`transactionClient`** when a business transaction
already holds a client. The latter creates a random-name savepoint, verifies the
canonical schema on that same connection, writes the audit and releases only the
savepoint. It never starts or commits the business transaction, releases its
client, or closes the shared provider. An audit error rolls back to the savepoint
and returns false through the common wrapper; callers must then roll back their
business action. Passing a bare client as `db` is rejected, and passing a client
outside a transaction fails before any write. These boundaries are verified with
real sessions, including outside-session invisibility, caller rollback/commit,
a usable outer transaction after audit failure and preserved client ownership.

```js
await client.query('BEGIN');
try {
  // Apply the business change with this same client.
  const recorded = await auditLog({
    userId, action: 'privacy_preference_change', details,
    transactionClient: client, service: 'user-service'
  });
  if (!recorded) throw new Error('Audit persistence required');
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

This follows PostgreSQL's documented [savepoint](https://www.postgresql.org/docs/15/sql-savepoint.html)
and [rollback-to-savepoint](https://www.postgresql.org/docs/15/sql-rollback-to.html)
semantics: savepoints require an existing transaction and isolate changes made
after their creation. No production data or history is deleted by these checks.

Policy acceptance and preference changes use this interface in their existing
mounted routes. Both pass the trusted request context into encrypted audit data,
including the resolved IP, agent and request ID when available. The real gateway/privacy fixture and native user-service process
verify ciphertext-only columns, authenticated round trips and failure rollback.
The user-service owner closes its provider after draining HTTP requests. Other
legacy callers, positional interfaces, jobs, exports/deletion and every business
transaction are still under review; a caller that ignores false does not meet the
complete atomic-audit requirement.

Common query helpers and the mounted owner `/gdpr/audit-logs` endpoint return
bounded metadata with `detailsUnavailable: true`. They do not select historical
plaintext details, ciphertext or wrapping material. Invalid limits are rejected,
including partially numeric strings at the route. Owner helpers remain metadata
APIs; their legacy `service` argument is rejected rather than decrypting under
ordinary user authorization. Protected service filtering uses the admin API below.

Metadata selects legacy `created_at::text` so timestamp-without-time-zone values
keep exact historical wall clocks and microseconds. Genuine instants stay separate.
SQL orders by qualified native timestamp/int64 columns, not their output text
aliases; actual IDs99/100 with equal wall clocks verify the numeric tie order.

## Protected admin queries

User-service mounts `/admin/audit-logs/:id/decrypt`, `/admin/audit-logs` and
`/admin/sensitive-access-logs`. Gateway forwards them below `/api`, `/api/v1`,
`/api/v2` and `/v1`, with admin rate limits and signed-admin authentication, outside
generic user response caches. CORS permits `X-MFA-Token` and `X-Audit-Reason`.

Every route independently verifies the access signature, an actual roles array
containing `admin`, and a permissions array containing `audit:decrypt`. This is
explicit L2 read capability; a generic/L1 admin claim alone cannot decrypt. The
capability must come from an authorized identity issuer, never from request body,
role headers, a setup endpoint or a client-selected admin level. Administrative
provisioning/role governance and approved L3 exports still need full acceptance.

Enroll the administrator through the [canonical MFA flow](MFA-STATE.md), then obtain
a five-minute `audit-read` proof bound to that exact access token. Supply it as
`X-MFA-Token`, with a nonblank3..1024-character `X-Audit-Reason`. Server state checks
enrollment, banning, expiry, epoch, session/scope and Redis revocation. No caller
MFA boolean/static-key proof bypass. Merely presenting proof for another signed
session or scope fails. Responses use `Cache-Control: no-store`.

The handler runs the actual read and encrypted `admin_audit_decrypt` receipt in
one bounded transaction. The receipt identifies the verified accessor and source
record IDs, reason, query, IP/agent/request context. It commits before JSON is
released. Database/audit/key/decrypt/commit failure returns only a fixed code and
withholds plaintext, historical plaintext columns, wrapping keys and ciphertext.
Legacy incomplete envelopes get an explicit refusal; they are not a fallback.
Structured P0 and credential fields are removed recursively from privileged HTTP
results by the same base classification used by response filtering. Camel-case
credential aliases and prototype-like keys are removed too; encrypted originals
are retained. The response reports `p0FieldsRemoved:true`. Cyclic/excessively deep
payloads refuse a response; genuine timestamps retain their representation. This
does not establish complete unstructured-log masking/scanner/custom-rule coverage.
Successful read accountability is implemented; comprehensive denied-attempt audit,
all sensitive business chains and operational monitoring remain separate work.

Audit list accepts only `user_id`, `action`, `service`, `start_date`, `end_date`,
`limit` and `before_id`. Dates require an explicit ISO8601 offset and query the
genuine `timestamp` column, preserving PostgreSQL microseconds rather than
rounding bounds through JavaScript milliseconds. Reversed microsecond ranges and
precision beyond six fractional digits are rejected. Legacy internal Date/date-only
helpers retain genuine Date instants and their documented UTC-midnight date-only
contract; new HTTP boundaries require explicit offsets. Read DTOs separate raw
legacy wall-clock text from genuine UTC instants with six fractional digits.
Limit is1..50. Service is matched after authenticated
decryption, with a bounded200-candidate scan and a7MiB plaintext page budget.
Candidate queries load IDs only, then one encrypted row at a time. A nonmatching
candidate page returns `complete:false` and `nextCursor`; continue with `before_id`
and the same filters. It never calls an unscanned tail empty. A byte-boundary record
is available on the next page, with no skipped IDs. Real201-record and large-payload
cases verify both boundaries. Pagination orders native int64 IDs, not text aliases.
This is append-only keyset traversal, not a stable snapshot across separate requests.

Sensitive-access list requires `user_id`; optional `accessed_by`, explicit
`start_date`/`end_date`, and limit1..50 are validated. It decrypts actual canonical
records and reports `hasMore` from a lookahead row. Narrow dates when more rows
exist; no total/count or complete export is claimed. An unreadable record refuses
the response. Raw reasons/fields/IP/agent remain encrypted at rest. Generic replies
are capped at8MiB. Both APIs require a fresh accountable access reason for each
request. Frontend permissions/masking controls, all-service response filtering,
scanner and original combined unit/security coverage requirements remain open.

The general audit middleware persists before sending a buffered response and
withholds the body and private headers on audit failure. Anonymous actions are
recorded as such, rather than silently skipped. Streaming handlers must record
before their first write; middleware cannot retract bytes already sent. Both the
real crypto HTTP path and isolated wrapper tests exercise response refusal.

The common-wrapper unit gate measures only `auditLog.js`, with its original 85%
line/statement/function target. The three crypto modules and encrypted facade retain their separate
90% line/function gate. Neither gate proves all eleven modules of REQ-00202, the
full GDPR coverage target, or complete masking/permission/MFA coverage.

## Reproduction and evidence limits

Run against an owned isolated PostGIS database after installing declared backend
dependencies, using Node 24:

```sh
UV_THREADPOOL_SIZE=2 LOG_LEVEL=error nice -n 10 node --test --test-concurrency=1 \
  --test-timeout=20000 --experimental-test-coverage \
  --test-coverage-include='**/shared/audit/*.js' \
  --test-coverage-include='**/shared/auditLogEncrypted.js' \
  --test-coverage-lines=90 --test-coverage-functions=90 \
  backend/tests/regression/audit-crypto-storage.test.js \
  backend/tests/regression/audit-kms-wire.test.js
```

`TEST_DATABASE_URL` must already identify the isolated database. Tests create and
clean only unique owned fixture schemas, use the real V1/V2 and audit/partition
migrations, and generate local fixture secrets at runtime. They exercise durable
first-use contention, canonical authenticated writes and tampering, random IVs,
forced/expiry/master rotation, retained old history, actual overlapping rotation,
failed key/write rollback and buffer clearing, explicit legacy handling, sensitive
storage, the actual facade/adapter/HTTP path in a new process, and partitioned
64-bit identities. The SDK suite sends real signed HTTP requests to a local KMS
protocol fixture and verifies context, denial, malformed responses and deadlines.
It is not evidence of live AWS IAM/key policy, CloudTrail, availability or latency.

The original 90% complete crypto/masking/permission criterion remains open. The
new gate measures only the three production audit crypto modules and facade; source-hashed
results and exact percentages are retained in the benchmark evidence. Branch
coverage is reported separately without claiming a 90% branch pass. No broader
performance, business, MFA, client or compliance acceptance follows from these tests.
