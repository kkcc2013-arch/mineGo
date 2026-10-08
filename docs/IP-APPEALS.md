# IP appeal runtime and deployment

The user-service owns its IpBanManager instance. It verifies JWTs for appeal creation
and status, scopes stored appeals to the verified user and resolved client address,
and exposes a public check endpoint. It does not rely on process-local gateway state.
The gateway forwards the supported appeal aliases to /ip-appeal, before broad user
routers. IP enforcement runs before business proxies; health and appeal routes remain
reachable from a blocked address. Storage lookup failures return an unavailable
response rather than granting access.

The gateway overwrites X-Forwarded-For with the address Express resolved for that
request and removes X-Real-IP. It does not forward a caller-selected address unchanged.
By default, both services trust no proxy. For deployments behind proxies:

- Set GATEWAY_TRUST_PROXY to the explicit trusted reverse-proxy IPs/CIDRs.
- Set USER_SERVICE_TRUST_PROXY to the explicit gateway IPs/CIDRs.
- Restrict direct access to user-service to that gateway network. A caller connected
  from a configured trusted peer is treated as that peer; this requires network isolation.
- Both variables accept comma-separated Express trust-proxy ranges. Never use an
  unrestricted range merely to make an IP-address test pass.

Apply the compatibility bootstrap
`database/pending/20261008_100000__ip_ban_index_compatibility.sql` on UUID-user databases
before the legacy IP migration when needed. It uses explicit GiST inet operator
classes and preserves the original migration file. This does not reconcile non-UUID
legacy identity schemas or validate the complete migration history.

`backend/tests/regression/ip-appeal-storage.test.js` executes actual PostgreSQL,
Redis, ban middleware, appeal routes and production proxy helpers. It covers aliases,
CIDR/permanent/expired bans, whitelist precedence, spoofed forwarding headers, signed
ownership, validation, cache corruption, failed status queries and access-control
failure. The actual user-service process test also creates and reads an appeal through
the production proxy module and checks the persisted verified user ID.

Full gateway process startup, automatic-ban time windows/transactions, complete admin
review consistency, GeoIP-provider integration, all distributed-sync/retention cases,
metrics coverage and admin UI remain subject to the existing requirement acceptance.
