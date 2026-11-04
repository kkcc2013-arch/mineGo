# Canonical MFA factors and scoped proofs

Partial implementation evidence for REQ-00638, REQ-00126 and the factor prerequisite
of REQ-00588; none of these requirements is accepted in full. Original acceptance
criteria and numerical thresholds stay unchanged. The independent verification
ledger and WORKLOG describe the tested source and outstanding work.

## Storage and keys

Apply the original canonical MFA migration plus
`20261020_120000__mfa_verification_state.sql` through the normal migration CLI.
The new migration adds epochs, replay counters, absolute lock instants and hashed
short-lived proofs. It preserves every existing profile, ciphertext and historical
failure/lock timestamp. Tables must belong to the current schema with UUID subjects.
The old 85 raw migrations, repair manifest and package lock are unchanged. Reversal
works only before state/proofs exist; populated reversal refuses data loss.

Production requires a stable, nonsecret `MFA_KEY_NAMESPACE`, regional
`MFA_KMS_KEY_ID`, optional retained `MFA_KMS_DECRYPT_KEY_IDS`, `AWS_REGION` and
SDK credentials authorized to generate/unwrap data keys. This uses the existing
actual AWS SDK provider with a dedicated purpose/subject/epoch context; namespace
also binds database/schema. Never put personal information in the namespace.
MFA and audit key configuration are separate; enrollment/factor transactions also
require the encrypted audit store. Production startup validates schema and provider
configuration. That check does not prove live KMS authorization or availability.

For an isolated nonproduction environment, explicitly supply
`MFA_MASTER_ENCRYPTION_KEY` (64 hex characters), `MFA_MASTER_KEY_ID`, or the retained
`MFA_MASTER_KEYS_JSON` keyring. There is no default/truncated master or plaintext
fallback. The legacy `MFA_ENCRYPTION_KEY` is not silently adopted. Each secret has
its own AES-256-GCM work key, complete wrapped key/IV/tag and subject/epoch binding.
Unknown legacy profiles require explicit reviewed adoption; neither guessed keys
nor guessed timestamp timezones can authorize them. Runtime requests never create
schema. Owners drain active operations and close owned providers at shutdown;
borrowed pools/providers remain usable.

## HTTP and session behavior

The production user service mounts authenticated management at `/users/me/mfa`
and challenge completion at `/auth/mfa`. The gateway forwards both namespaces
under `/api`, `/api/v1`, `/api/v2` and `/v1`, before generic user proxies. Public
login completion requires an opaque challenge issued after actual primary login;
a body-selected user ID cannot authorize it.

Management requires a signed access token and checks its actual Redis revocation
state. Subject identity and QR label come from the server/user row. Setup returns a
160-bit Base32 secret, PNG QR and exactly eight unique `XXXX-XXXX` recovery codes;
only recovery hashes persist. URI includes issuer, SHA1, six digits and 30 seconds.
Enable accepts a real TOTP in the original plus/minus two windows. A used counter
cannot authorize again; recovery consumption serializes competing real clients.
Five failed factors lock for 15 minutes, and setup cannot reset the lock.

`POST /step-up` verifies a factor and issues a random, five-minute opaque token for
one allowed scope. Only its hash persists, bound to credential epoch and exact
access-token digest. Send it in `x-mfa-token`. `mfaRequired` independently verifies
the JWT, revocation, enrollment and server proof. It defaults to mandatory enrollment;
explicit optional policy still checks actual enrollment. Missing/false `mfaEnabled`
claims and legacy static-key JWT proofs cannot bypass it. Proof lookup failure
returns a fixed 503. Recovery status requires the `mfa-manage` scope; responses
are `Cache-Control: no-store`. Regeneration/disable require a fresh actual factor,
rotate the credential epoch and invalidate old codes/proofs and refresh epochs.

Actual primary SMS login consumes its code atomically and returns only an MFA
challenge for an enabled profile. Challenge completion is single-use and only
then calls the awaited session issuer. Access tokens include real expiry and a
random jti; Redis MULTI command errors prevent a successful issuance response.
Refresh checks the actual revocation key and current credential epoch. Production
sync JWT consumers require explicit signing keys even if an old KMS flag is set.
An async KMS-only JWT architecture remains separate unfinished work.

There is no configured SMS provider. Production and non-opted-in development
SMS requests return 503, without logging a phone/code or claiming delivery.
`SMS_DEV_MODE=true` is an explicit nonproduction-only fixture option. Tests seed
one-time codes only in owned Redis keys and never send recipient messages.

## Evidence and boundaries

`npm run test:mfa:unit` checks RFC reference vectors, 500 controlled valid windows,
production key refusal and facade lifecycle. `npm run test:mfa:storage` runs actual
PostgreSQL, Redis, signed HTTP and the production factor/session modules plus protected audit route90% line/function gate.
These tests include two-client consumption, real locks/deadlines, audit rollback,
proof scope/session/expiry, login challenge replay, revoked refresh/proof issuance,
credential rotation and legacy/schema/refused-down preservation. The dedicated
MFA workflow runs those commands on Node24. Native user/gateway tests exercise the
mounted paths with PostgreSQL, Redis and Kafka, separately from unit mocks.

The 500/500 controlled-window result establishes the original >=99% check for
those controlled inputs, not device clock/network availability. Report actual
branch coverage separately; no 90% branch claim is made. Original REQ126's literal
`Bearer test_token` remains an invalid signature and returns 401. Its `curl -sf`
command cannot succeed securely as written; authenticated native reachability is
recorded separately without changing or checking its acceptance box.

The game client now has enrollment/login/recovery screens verified against actual
PostgreSQL and Redis in a real browser (details below). Seven-day trusted devices,
real authenticator scan/manual interoperability, full metrics/alerts and original
product impact claims remain open. `rememberDevice` is explicitly rejected. Sensitive password,
payment/transaction operations still need the actual middleware at every business
boundary. The protected admin audit routes now combine signed L2 capability, actual MFA,
transactional decryption/access receipts and bounded service filtering; see
[AUDIT-ENCRYPTION.md](AUDIT-ENCRYPTION.md). Other sensitive business routes and
full admin/client acceptance remain open. The separate legacy risk engine still requires canonical
UUID identities, real gateway wiring, atomic proofs, provider delivery and encrypted
risk-log acceptance; this batch does not accept cross-service risk grading.

Legacy audit metadata now returns `created_at::text`: historical timestamp-without-
time-zone values preserve wall-clock text and microseconds. Genuine timestamp
instants remain separate. Actual UTC/Shanghai process and UTC/New York database
combinations verify this; unknown historical timezone provenance is not guessed.


## Game client and offline boundaries (2026-10-23)

The actual entry page distinguishes a primary-login MFA challenge from a session.
It keeps the opaque challenge only in API-client memory; it loads the private
profile and enters the map only after factor completion returns both tokens.
The verification view offers TOTP or a one-time recovery code, cancellation and a
five-minute local upper bound. Server deadlines, consumption and locks remain
authoritative. Invalid factors never trigger token refresh or automatic retry.
No trusted-device option is offered while its seven-day server contract is open.

The profile's account dialog reads actual enrollment state. It shows the QR and
manual secret during setup, requires a real six-digit factor to enable, displays
eight recovery codes and offers an explicit text download. A save acknowledgement
clears the codes; close/logout aborts requests and clears transient material and
object URLs. Regeneration and disabling each need a fresh factor. Rendered data
uses DOM text nodes, not interpolated HTML. A lost response can require restarting
setup or rereading state; recovery codes are not silently retrievable.

The existing access/refresh pair still uses the client's localStorage protocol.
A valid complete pair is required; literal undefined/null legacy values are
purged, refresh rotates both tokens, and stale identity responses cannot restore
an ended session, including while a response body is decoding. This is not a
claim that client token storage is encrypted or protected against arbitrary XSS.

All API-client requests use no-store. The actual worker bypasses caches and its
background queue for auth/MFA paths, admin audit/sensitive-access paths, MFA/reason
headers, private bearer reads and no-store requests. Offline failures return503,
never a queued-success envelope. Activation purges old authentication/proof queue
entries; replay independently filters them again. Static cache cleanup is limited
to owned versioned cache names. First-time installation does not reload a login
in progress. The gateway forwards legacy /v1/auth correctly, rate limits it and
allows the real client-version/platform preflight headers.

Run the client unit checks with `node --test --test-concurrency=1
backend/tests/unit/mfa-client.test.js`. The dedicated browser workflow installs
locked backend/frontend dependencies and matching Chromium, then runs
`backend/tests/regression/mfa-browser-storage.test.js` with owned PostgreSQL/Redis.
This exercises the actual HTML, modules, worker, auth routes and canonical data;
it seeds one-time SMS codes only in owned Redis and blocks external origins.
Screenshots contain neither factors nor tokens. It checks real setup/download/
acknowledgement, cancellation, invalid/offline factor behavior, recovery login,
regeneration/disable, legacy queue filtering and poisoned-cache refusal.

Physical Google Authenticator scan/manual interoperability, real SMS delivery,
seven-day trusted devices, full metrics and every sensitive password/payment/risk
business boundary remain unfinished. Other offline queued business operations,
account isolation/encrypted storage, full PWA installation assets, new-user
registration/consent and gameplay are not accepted by this auth-only fixture.
