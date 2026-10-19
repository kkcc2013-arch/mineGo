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

## Reproduction and evidence limits

Run against an owned isolated PostGIS database after installing declared backend
dependencies, using Node 24:

```sh
UV_THREADPOOL_SIZE=2 LOG_LEVEL=error nice -n 10 node --test --test-concurrency=1 \
  --test-timeout=20000 --experimental-test-coverage \
  --test-coverage-include='**/shared/audit/*.js' \
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
new gate measures only the three production audit crypto modules; source-hashed
results and exact percentages are retained in the benchmark evidence. Branch
coverage is reported separately without claiming a 90% branch pass. No broader
performance, business, MFA, client or compliance acceptance follows from these tests.
