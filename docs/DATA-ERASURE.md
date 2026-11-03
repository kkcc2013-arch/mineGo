# Data-erasure storage and legacy identity boundary

REQ-00127 and REQ-00016 remain in progress. Each has12 original criteria. This
storage prerequisite does not complete delivery/verification, approval, execution,
retry scheduling, notification, metrics, export, end-to-end deletion or legal review.
The GDPR requirement's original80% coverage target is unchanged.

The older GDPR proposal created data_deletion_requests with SERIAL request IDs and
INTEGER owners. The later proposal tries to create a UUID workflow under the same
name. CREATE TABLE IF NOT EXISTS silently retains the old table, then the UUID task
FK fails. These are different models, with no supplied integer-to-UUID owner mapping.
An additive UUID alias alone would let old processors see incompatible new states.
The source-bound repair therefore preserves every legacy ID/owner/status/time/token,
sequence, view, FK and shared update function, and introduces a distinct namespace:

| Model | Identity and behavior |
|---|---|
| data_deletion_requests | Retained legacy serial/numeric-owner tracking; no automatic promotion or guessed mapping |
| data_erasure_requests | UUID request and immutable UUID subject; separate nullable live-account FK |
| data_erasure_tasks | Actual resource/plan codes and nullable-until-executed BIGINT accounting; no raw SQL templates |
| data_erasure_certificates | Exact signed payload, digest, subject/request binding, key ID/algorithm and explicit retention |
| data_erasure_categories | Eight preserved proposal definitions; declared table names and proposed retention are configuration, not executable plans |
| data_erasure_approval_history | UUID workflow history; actor links become NULL when accounts are removed |

Five new workflow tables are added. No requests, verifications, approvals, completed
tasks or certificates are synthesized from old rows. Existing UUID workflows under
the legacy name and unknown/customized new contracts require explicit adoption.
All85 original pending SQL files remain byte-identical.

New requests must bind a real live UUID subject. Subject/request identities are
immutable, and an account link cannot be detached while that account still exists.
Account removal clears only the live FK; request/task/history/receipt records retain
their binding. A partial unique index prevents duplicate active subject requests.
Owned functions/triggers and their enabled state/index contracts are validated;
shared update_updated_at_column and legacy objects are never replaced.

The modern challenge field stores a32-byte digest rather than a plaintext code.
Unverified requests cannot claim approved/completed states. Receipt payload/hash,
subject/request IDs and exact total must agree. A deferred guard checks actual
completed task totals/category totals, rejects unfinished work or no completed task,
and requires matching request completion. Proof retention has no automatic7-year
legal default; the caller must supply the applicable policy and actual signing key.
The schema's digest/format/accounting checks do not verify signature mathematics or
prove the complete business erasure. The production signer/key lifecycle and worker
still require implementation and independent tests.

Run against an explicitly owned disposable PostGIS15 database, with TEST_DATABASE_URL
and permission for fixture schemas/extensions:

```bash
cd backend
UV_THREADPOOL_SIZE=2 node --test --test-concurrency=1 tests/regression/erasure-schema-storage.test.js
```

The18 actual storage/CLI checks retain authentic legacy data, demonstrate both the
original FK failure and real legacy GDPR module failures on canonical UUID users,
verify all5 new tables/8 definitions, reject bad subjects/configuration/accounting,
and preserve rerun choices/OIDs/functions/triggers/history. The receipt case actually
deletes three owned canonical Pokémon rows, leaves another owner's row intact, and
records the real returned count. A genuine Ed25519 signature is checked before and
after fixture account removal. This exercises the SQL storage contract and real
cryptography; it is not a production-worker deletion-flow or legal-compliance test.
The actual CLI records/verifies separate immutable-raw and executed SQL checksums.

Current full V1/V2 seeding passes. Complete history now passes erasure storage and
fails20260701_110000 statement1: the canary deployment proposal has invalid inline
partial-unique syntax near WHERE. The entire pending batch rolls back. Complete
installation, existing differing-repair upgrades and full reversal remain open.

The mounted /data-deletion and /gdpr consumers still query incompatible legacy
models; they have not been redirected to the new workflow. Current code also uses
noncanonical resource fields/tables, incomplete task/retention planning, unsafe raw
identifier execution, exposed verification data, unsupported signing defaults and
unfinished scheduling/notification behavior. Runtime adapters, actual owner/admin
HTTP probes, out-of-band delivery, deadlines, canonical per-resource plans, atomic
execution/outbox/retry, token revocation, certificate authorization, actual metrics,
export/encryption/retention and formal privacy-policy review remain required.

Retention must reflect purpose and applicable obligations; erasure also has verified
identity and exception rules. The repository's blanket delay/retention examples are
not independent compliance evidence. See the [European Commission's principles](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr_en)
and [California DOJ's erasure guidance](https://oag.ca.gov/privacy/ccpa#sectiond).
No legal-review acceptance is claimed.


## Follow-up checkpoint (2026-10-18)

A missing partial predicate previously produced NULL in the adoption comparison.
Use IS DISTINCT FROM and reject an all-status unique index explicitly; the final
erasure suite is19 checks. Together with18 actual canary checks,37 pass sequentially
with no skips. Older18-check publication remains exact-source prior evidence.
The independent [canary prerequisite](CANARY.md) advances complete85-source history
to partition20260707_060000 statement6 (size_bytes→size view-column conflict); entire
pending batch rolls back. Runtime/API/worker/legal/upgrade/reversal remains open.


## Current installation checkpoint (2026-10-18)

The independent [partition maintenance implementation](PARTITION-MAINTENANCE.md)
now preserves canonical view/history contracts and runs actual protected creation/
statistics/metrics/lifecycle.22 new real checks, native gateway/user,724 units and
1450 syntax pass; prior broad business suites were not rerun. Full85-source history
passes partition/weather and fails CDC20260707_100000 stmt5 missing pokemon, with
entire pending rollback. Latest preceding2e5 main462/canary18/erasure19/correctness
pass, but original throughput gate fails at-6.352968581797381% against unchanged-5%;
[actual failed report](benchmarks/transaction-throughput-ci-2e5fc2b-2026-10-18.json)
is retained with all8 measured hashes still matching. Earlier passes do not waive
this failure. New full-source CI and all original full-feature criteria remain open.
Current186done/42in_progress/430new,658 documents, independently verified1.

## Actual request/runtime checkpoint (2026-10-31)

The dated installation failures above are retained history. Exact prior9f13a62
migration39 now passes all87 pending migrations and V1/V2, including installation
beside unrelated audit schemas. No original SQL, repair/dependency manifest or
lockfile is modified by this runtime update.

The mounted `/data-deletion` request API and GDPR deletion/status/withdrawal aliases
now use `shared/erasure/ErasureRequestStore.js`. The legacy service entry point is a
compatibility facade; it cannot execute raw table-name tasks or fabricate an empty
completion. Legacy SERIAL requests, numeric-owner tracking, tokens, sequence, views
and references remain untouched. Actual `user_consents` owners are UUIDs; withdrawal
updates only the authenticated owner's current consent rows, in the same transaction
as creation/reuse of a full erasure request. A live partial request cannot silently
stand in for full withdrawal: the transaction refuses and leaves consent unchanged
until the caller cancels that partial request and explicitly resubmits.

Owner writes require a registered current server session and fresh `delete-account`
MFA proof. Administrative review requires the canonical signed admin role and its
own `erasure-admin` proof; an `isAdmin` flag or caller verification headers do not
substitute. Public confirmation-by-token and public certificate lookup are removed.
All request IDs and owners are explicit UUIDs, independently checked in the SQL
query/lock. A foreign owner's request is not found, rather than returned and then
filtered. User-facing projections omit nonce digests, encryption envelopes, address,
agent and raw task instructions. Admin projections add the subject UUID only after
authorization. Reasons/rejection notes use authenticated envelope encryption bound
to database/schema, subject, request and field; production requires the managed KMS
provider already used by canonical encryption. No plaintext fallback is permitted.

Creation returns an actual durable `pending` request with `verificationDelivery:
pending`; it does not return a code or claim email/SMS delivery. Internal delivery
preparation generates a real random128-bit nonce, stores only its subject/request/
type/category-bound digest and an absolute24-hour expiry, and returns the transient
nonce only to the internal delivery caller. It has no public preparation endpoint.
Reissue invalidates the prior nonce; verification checks owner, intent, expiry and
one-use state under the real request/user locks. Canonical order history requires
manual review; automatic approvals retain the original30-day grace. Every transition
and approval-history row commits with an encrypted audit receipt. Cancellation is
idempotent. Creation/verification/approval/rejection/cancellation/preparation metrics
advance after commit, so an audit failure does not leave a successful count.

Certificate reads require owner or separately authorized admin access, a configured
`ERASURE_SIGNING_PUBLIC_KEYS_JSON` map of trusted public keys and actual signature
verification. The reader preserves historical hex signatures and also supports
base64; there is no generated fallback key. It returns `signatureVerified: true`
only after checking the exact signed payload with the recorded algorithm/key.
The regression's signed fixture deletes two actual owned canonical Pokémon rows,
retains a different owner's row and records the real returned count. This validates
storage/crypto/read authorization; it is not the production erasure executor.

The actual native user/gateway entry points now create, list and cancel a request
using real login/MFA and the canonical gateway aliases. Readiness checks the modern
request storage. Explicit service ingress retains its existing user-specific trust
setting or the configured common setting. The client API transmits transient per-call
proofs/confirmation bodies without automatic refresh/replay; service-worker replay
purges/refuses legacy GDPR/erasure operations, including entries without MFA headers.

### Required next work

A real configured notification transport/recipient binding and delivery worker are
still needed: no message has been sent and the verification-delivery criterion is
not accepted. The canonical resource/retention plans, actual executor and scheduler,
retry/outbox/notification lifecycle, production signing-key lifecycle, post-account-
removal receipt access, full UI/export and remaining privacy/security criteria are
also unfinished. The execution endpoint returns `ERASURE_RESOURCE_PLAN_REQUIRED`
without modifying status/data; it never reports completion for an empty plan.
The old unmounted processor still needs canonical scheduling and retention work.
`/gdpr/export` now has a purpose MFA gate, but its old export implementation is not
accepted as canonical JSON/CSV export. Withdrawal of additional optional-preference
or policy models and complete legal/privacy review remain open. This request batch
preserves all original criteria, including GDPR's original80% whole-scope coverage;
its stronger scoped integration gate does not accept the unfinished whole feature.

Run from `backend` with owned PostgreSQL/Redis:

```sh
npm run test:erasure:storage
node --test --test-concurrency=1 tests/regression/erasure-schema-storage.test.js
```

The dedicated erasure workflow runs these actual HTTP/storage/crypto checks. Original
user/gateway native checks and browser/offline boundaries remain separate evidence.
