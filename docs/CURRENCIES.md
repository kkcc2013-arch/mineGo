# Currency and payment evidence boundary

The canonical payment table is V1 `orders`, with UUID identity, positive integer
`amount_fen`, currency, status and unique idempotency key. The source-bound currency
repair adds quote fields there, preserving every existing value, relation identity,
view and reference. Historical USD conversion information stays NULL. A parallel
legacy payment table or incompatible lock-owner schema requires explicit adoption.
All20 original currency definitions and20 price proposals remain unchanged.

The actual rate service publishes snapshots and UTC daily history in one transaction,
serializing writers for a currency pair. Failure preserves the previous current
quote and cache. Cache entries stop at both their five-minute cache lifetime and
the actual quote expiry. Missing providers fail explicitly, including in development.
There are no fabricated rates or unknown-pair1:1 fallbacks.

Conversions use PostgreSQL NUMERIC with target-currency rounding and expose exact
amount strings alongside display numbers. Conversion logs retain actual applied
rates and the exact submitted decimal input in a new nullable audit field, including
sub-cent input before display rounding; old logs remain unknown there. Owned UUID rate locks default to15 minutes, cannot be used by another user
or consumed twice, and can share the caller's real order transaction. Cleanup keeps
used locks for audit. This does not yet integrate locks into the actual checkout.

The three adapters calculate rates from the provider's declared base. Open Exchange
Rates' default base is USD; changing it requires a paid plan, so the adapter uses
the default table and computes cross rates. See the [official base documentation](https://docs.openexchangerates.org/reference/set-base-currency).
The third adapter decodes `base_code` and `conversion_rates` from the
[official ExchangeRate-API contract](https://www.exchangerate-api.com/docs/standard-requests).
Fixer's adapter checks success and the declared base, requesting both currency
symbols; [the vendor's published documentation](https://www.postman.com/apilayer/apilayer/documentation/xvuply8/fixer)
describes the EUR base and response fields. Provider tests use an owned local HTTP
server; no live provider availability, credentials or freshness acceptance is claimed.

Typed production routes cover currency/rate/price reads, conversion, both GET and
POST detection, signed owner preferences/locks and signed admin refresh/cleanup/
price updates. Lock creation through conversion also requires authentication. Both
existing `/currency` and `/api/v1/currencies` mounts precede the error middleware.
Real Prometheus counters replace the nonexistent generic metrics helper.

Validation on2026-10-14:

- `currency-storage.test.js`:18 reported actual PostGIS/router/HTTP-contract tests,
  including its parent case. Order preservation, all seed rows, concurrent publication,
  rollback, expiry, decimal amounts/audit, ownership/one-time locks, outer rollback,
  typed signed/public/admin routes, locale parsing and registry counters pass.
- Actual migration CLI/prerequisites:17 pass. Main unit suite:686 pass; the old
  `currency.test.js` is still excluded and its interfaces/mocks remain to reconcile.
  This count does not prove the original currency unit coverage requirement.
- Syntax:1,437 JavaScript files pass. Changed rate/router modules actually load.
- Real payment entry point in production mode with isolated storage and fixture-only
  channel/JWT keys returns200 for currency catalog(20), CNY localized price6.00,
  authenticated preference and rounded USD conversion1.01 from1.005.
- That process does not terminate during its bounded3s SIGTERM observation; owned
  SIGKILL is observed before cleanup and the diagnostic exits1. Graceful shutdown
  and dependency-aware readiness remain unverified;3s is not an acceptance threshold.
- Full V1/V2 passes. All85 original SQL files are unchanged; complete migration
  history fails20260626_040000 statement1 at its malformed `//` header and rolls back.

Original REQ-00051 acceptance remains open. Actual checkout still uses fixed CNY
products and generates mock prepayment parameters; the named multi-currency payment
module is absent. The proposed CNY108 price for `coins_1200` differs from checkout98.
Billing must use the same authoritative quote as the client, with actual supported
provider currency/channel contracts and trusted callbacks, durable idempotency,
money/state/resource effects, owner locks and minor-spend checks. Existing code also
catches age-check failures and continues, which requires P0 review and repair.

Also required: the original30-minute automatic refresh and owned lifecycle, live
three-provider/freshness/fault evidence, complete audit policy, representative90%
cache-hit and cached-API<100ms measurements, unit coverage>=80%, gateway and real
client flows, whole-history upgrades/rollback and all original localization behavior.
No merge, production migration or deployment was performed.
