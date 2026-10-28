# Payment integrity and current acceptance boundary

The payment service now runs the production router and store through the shared
service lifecycle. This is partial implementation/evidence for REQ-00003 and
REQ-00004; their historical `done` declarations are reopened. All original
acceptance boxes and numerical targets stay unchanged.

## Orders and once-only settlement

`POST /payment/orders` requires a signed owner and `X-Idempotency-Key` UUID.
The legacy body `idempotencyKey`, when present, must match that header. Accept
`productId`, `quantity`1–100 and `channel` (or the existing `paymentChannel` alias).
Prices and grants come from the immutable server catalog; client price fields
are rejected. Reusing an owner/key within an absolute24-hour deadline returns the
same order; changing its product, quantity or channel returns409. Different owners
can use the same key independently. Replays do not extend the deadline. After
expiry a new order can be created while the original order remains intact.

PostgreSQL owns the user/key/request/order/deadline binding. A transaction-held
advisory lock serializes an absent key, and row locks protect actual owners and
orders. This uses READ COMMITTED deliberately: a statement after waiting sees the
committed predecessor. Redis mirrors `payment:create:{userId}:{key}` with at most
24hours remaining; poisoned, missing or disconnected cache entries cannot select
an order, duplicate it or conceal a committed transaction. Unknown historical
raw-key requests require explicit adoption; legacy timezone/quantity provenance
is not invented and old identities/keys/money/states are never rewritten.

Settlement locks the actual order and checks owner (for client verification),
channel, amount/currency (for callbacks), current state and signed evidence before
crediting. One transaction commits the unique order/provider-transaction receipt,
state, premium-coin grant, monthly spend and encrypted audit. A repeated receipt
returns success with no second grant. A provider transaction cannot fund another
order; a changed transaction on an already settled order returns409. Constraint,
credit or audit failure rolls the transaction back. Signed callback failure states
cannot turn into payment. Bans, disabled payment features, under13 consent and
minor monthly limits are checked on actual locked data; concurrent settlements
cannot both spend the last allowance. Unknown age-profile policy and the complete
minor-protection requirement still require their own acceptance.

## Signed callback bytes

`POST /payment/webhook/:channel` is a public channel-authenticated route, mounted
before the gateway's user-authenticated payment namespace. The payment launcher
captures original bytes before shared JSON/form parsers. Maximum callback size is
64KiB; compressed request bodies are refused. `X-Signature` or `X-Pay-Signature`
contains the exact64-digit hex HMAC-SHA256 over those bytes. Conflicting aliases,
missing/malformed signatures and changed bytes refuse before any credit. All three
configured channel secrets must be32–4096bytes; no development secret fallback.

The repository HMAC contract accepts these payloads:

- JSON: `orderId`, `channelOrderId`, integer `amountFen`, `currency:"CNY"` and
  `status:"PAID"`. Unknown JSON fields refuse.
- Existing WECHAT XML transport: one each of `out_trade_no`, `transaction_id`,
  integer `total_fee`, explicit `fee_type:CNY`, `return_code:SUCCESS` and
  `result_code:SUCCESS`. Simple CDATA/declarations are supported; nested/duplicate
  fields and DTD/entity declarations refuse. No entity resolution or XML network access.
- Existing ALIPAY form transport: `out_trade_no`, `trade_no`, exact decimal
  `total_amount`, explicit `currency:CNY` and `trade_status:TRADE_SUCCESS` or
  `TRADE_FINISHED`. Duplicate fields and malformed percent/decimal encoding refuse.

These preserve the repository's JSON/XML/form transports with validated success,
amount and currency. They are **not** claims that current vendor-native XML/RSA,
certificate validation, Apple receipts or live payment adapters are implemented.
Prepay remains unconfigured: creation explicitly returns `providerReady:false`
and `payParams:null`, with no fake payment URL/nonce. Live channel credentials,
provider adapters and end-to-end actual payments remain outstanding.

`POST /payment/orders/:id/verify` authenticates the owner and requires
`channelOrderId` plus an HMAC of
`orderId|amountFen|productId|channelOrderId` using the locked order's channel key.
The older three-field signature did not bind a provider transaction and is refused.
The game API client sends the same intent key in header/body and accepts an
explicit key for intentional retries; it never automatically refreshes/replays
order or verification writes. Full payment UI/provider interactions remain open.

Order-list responses use a fixed whitelist and owner filter. Neither raw callback,
signature nor channel response is returned or stored as plaintext audit detail.
Audit records include creation/key binding, replay, refusal, settlement/state
change and actual timeout cancellation. Production audit readiness requires the
existing durable KMS configuration; local-master production startup refuses.

## Canonical schema and lifecycle

The additive `20261025_120000` migration validates actual schema-owned UUID orders,
owner FK and status type, keeps the original86 raw migrations unchanged, and adds
nullable historical quantity, a composite owner identity and request/settlement
relations. It appends CANCELLED/FULFILLED to the existing enum while retaining
historical FAILED. Views, external references, exact old wall timestamps, money,
keys and table identity remain. Populated reversal refuses. Empty reversal removes
only new empty structures; PostgreSQL enum labels remain, avoiding a type rebuild.

Actual PostgreSQL/Redis/audit and registered Kafka worker initialization finishes
before the payment listener binds. Public currency routes and authenticated
preferences remain mounted. Dependency checks drive readiness. Shutdown drains the
HTTP listener and queue/admin transport before closing audit/SQL/Redis resources.
Missing/short channel secrets and missing production KMS refuse startup.

The existing Kafka timeout consumer now cancels an actual expired owned order,
with an encrypted state-change receipt; fresh, historical-unknown, processed and
missing orders do not falsely cancel. Queue metrics now use the actual registry,
and retriable initial topic metadata is bounded/retried with owned failure cleanup.
Full durable scheduling, extension/cancellation, retries/DLQ, capacity and the rest
of REQ-00043 remain unfinished; this batch does not accept the whole queue system.

## Reproduce the scoped checks

From `backend`, with owned `TEST_DATABASE_URL`, `TEST_REDIS_URL` and (for native
processes) `TEST_KAFKA_BROKERS`:

```sh
npm run test:unit
node --test --test-concurrency=1 tests/regression/payment-migration.test.js
npm run test:payment:storage
npm run test:payment:coverage
node --test --test-concurrency=1 tests/regression/payment-native.test.js
```

The storage command enforces91% lines/functions and80% branches on the three
production payment protocol/store/router modules, preserving the original
>90% and minimum80% gates. The report command adds91% statements and produces
`coverage/payment/index.html`, HTML source views and `coverage/payment/lcov.info`.
The dedicated payment workflow preserves those reports as artifacts.

Coverage from actual SQL/Redis/HTTP integration is reported separately from pure
protocol unit coverage. It does not establish the original whole-service unit-only
coverage criterion. The main unit command now runs the existing delay-queue suite
with the real metrics registry, instead of hiding nonexistent metric functions.
The payment fixtures install UUID/PostGIS/pgcrypto in the isolated database's
public schema under the existing advisory lock before creating disposable schemas.
This prevents a first schema from owning UUID functions that subsequent scenarios
cannot resolve. A separate blank template0 database, initially without all three
extensions, passed migration/core/report/native/bootstrap/original-native/unit
checks; the extensions remained in public after fixture cleanup and that owned
database was then dropped. This does not alter V1 or relax any acceptance gate.

Native tests launch actual payment/gateway entry points, apply all87 migrations,
exercise raw signed JSON/form callbacks and a real Kafka timeout consumer, and
measure natural shutdown. Other gateway peers alias the payment fixture; no
all-service/capacity/provider/liveAWS/financial-audit acceptance is claimed.

Remaining scope includes all original legal fulfillment/refund business commands,
full payment-service unit coverage, all sensitive MFA/risk business boundaries,
provider/prepay/receipt integration, legacy request adoption and production drills.
All658 original requirements remain the persistent goal.

## 2026-10-28 queue consumption correction (partial)

A real Kafka regression now publishes owned expired orders before starting the
actual payment process. New groups read existing ready-topic work; committed
consumer offsets retain their normal Kafka behavior. Consumers are keyed by topic
and task type, and each handler ignores other types. Fixture ready/DLQ topics have
an owned namespace; default production topic names remain unchanged.

The new test exposed a second production failure: the histogram convenience
wrapper passed `buckets: undefined`, overriding the metrics library default.
Successful handlers then entered failure handling; a nonexistent `logger.alert`
call could crash the consumer. The wrapper now omits absent buckets and dead-letter
alerts use structured error logging. Actual registry tests exercise default/custom
buckets, separate handlers on a shared topic, and an exhausted failure followed by
a successful task. This does not establish notification delivery or full REQ43.

Actual payment/gateway/Kafka regression2, cache/CDC/HTTP regression41, original
user/gateway regression2, and the complete unit command pass locally. The cache
fixture waits within its existing bounded deadline for a successful real fenced
fill before testing the read/invalidation race; its race assertions and original
50/100ms CDC gates are unchanged. Exact-source remote CI is still required.
