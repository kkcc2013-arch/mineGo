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
