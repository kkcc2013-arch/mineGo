# Sensitive operation risk boundary (partial)

The canonical implementation is `backend/shared/riskVerifier.js`. The actual
private gateway payment prefix checks the server session before proxying. Payment
independently checks it again and evaluates risk before creating or verifying an
owned order. Public provider callbacks retain their raw-byte channel HMAC boundary;
a user JWT or MFA header cannot replace that signature.

## Authoritative inputs

A valid signature alone is insufficient at these payment boundaries. The access
JWT must contain a UUID subject and session ID, match its server registration and
current canonical MFA epoch, remain unrevoked, and refer to an unbanned existing
user. Missing, malformed, revoked or obsolete registrations refuse access. Legacy
MFA profiles without canonical state require explicit review. Missing state/storage
or an unavailable encrypted audit service refuses the operation.

The user MFA login route records `mfaAuthenticated: true` only after completing a
real factor challenge. An account epoch alone does not establish that the session
completed MFA. Token refresh reads that server registration, checks the current
epoch and inherits its assurance; it cannot upgrade a primary-only session. A
separate registered refresh expiry preserves the signed refresh token's lifetime
when the access token expires. Old registrations without these server fields need
a new login. Enabling/changing factors can require a new payment session.

`SERVICE_TRUST_PROXY` accepts explicitly configured ingress peers/CIDRs for service
processes and defaults to no trust. `GATEWAY_TRUST_PROXY` independently controls
trusted peers at the gateway. The gateway's HTTP proxy replaces forwarding claims
with its own Express-resolved client address, including `X-Forwarded-For` and
`X-Real-IP`, and removes the caller's `Forwarded` header. Service ingress must be
configured for the actual trusted gateway peers to retain that source address.
The actual native regression uses trusted loopback service ingress and confirms
that an untrusted caller cannot spoof its address through the gateway.

## Current policy

The five bounded contributions are device/session context30, address/location
context25, request behavior20, recent refusal history15 and signed session age10.
Their total remains0–100. A trusted marker means this current MFA-authenticated
server session has the same user agent; it is not a physical trusted-device token.
Address comparison uses the observed peer and recorded login address; it is a
conservative change signal, not GeoIP distance or impossible-travel detection.
Client body locations and `x-verified-types`/risk-score/device flags cannot reduce
these scores. Rate/history windows use real Redis time and atomic sorted-set
updates, with keys scoped to the actual database/schema and hashed identities.

Normal purchases require a purpose proof when risk is at least50. Large purchases
always require a `large-transaction` proof; the normal elevated-risk purpose is
`payment-purchase`. The implementation's explicit configurable large-purchase
policy defaults to10000 fen (CNY100), from the server product catalog times validated
quantity, and can be set with positive integer `PAYMENT_LARGE_TRANSACTION_FEN`.
No client-declared amount selects the tier. Risk at least80 refuses even a valid
proof. This policy does not implement REQ200's full operation/method configuration.

Accepted opaque MFA proofs are bound to the exact access bearer, owner, purpose,
canonical credential epoch and an absolute maximum age of five minutes. An HTTP
403 includes the reason and required scope so the client can explicitly verify.
The client API accepts a transient proof for a single order/verification request;
it does not persist it, automatically refresh/replay payment actions, follow a
server-supplied redirect or retain arbitrary challenge data. The complete purchase
verification UI remains unfinished.

Each risk authorization decision has a server-generated trace UUID and encrypted
canonical audit receipt, including its policy, bounded factors and decision. Only
hashes of the address, user agent and session enter that encrypted payload; raw
bearers, MFA proofs, codes and keys do not. Audit persistence must succeed before
the business handler runs. A separate SQL order transaction still controls locked
owner/key/replay and once-only settlement/credit behavior.

## Evidence and remaining scope

From `backend`, with owned `TEST_DATABASE_URL` and `TEST_REDIS_URL`, run
`npm run test:risk:storage`. It exercises the actual payment and user MFA/auth HTTP
routers, PostgreSQL, Redis, canonical factors and encrypted audit storage. The
command retains91% line/90% function/80% branch gates on the new module. This is
integration coverage; it does not accept REQ200's original unit-only90% condition.
The payment workflow runs this alongside the existing payment coverage and actual
OS entry-point checks. Main units also test trusted forwarding and transient
client proofs; browser and original MFA/native scenarios remain separate checks.

REQ588 is still partial: gateway session authorization and payment risk/business
integration are real, but other sensitive APIs, dedicated gateway risk decisions,
full admin policy governance and every intended sensitive path remain open.
REQ200 additionally needs its full registered operation catalog, configured
password/PIN/SMS/email and method combinations, per-operation TTL/revocation API,
server geolocation/device/history sources, user flows, unit-only coverage and
complete multi-step acceptance. REQ638's password changes, payment binding,
physical authenticator/trusted-device and other original criteria remain open.
The old `RiskEvaluator`/`SensitiveOperationGuard` and security verification stubs
remain unmounted and must not be treated as canonical authenticated decisions.
All658 original requirements and their acceptance boxes/targets remain unchanged.
