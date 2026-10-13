# Reward ranking and title upgrade verification

The mounted reward-service /rewards/leaderboard endpoint previously interpolated
caller-controlled team text into SQL, used an undefined alias for personal rank,
reported XP for catch rankings and returned inconsistent ranks for tied scores.

The route now requires the actual JWT identity and validates scalar type/team enums.
Team and user identity are SQL parameters; only a fixed allowlisted score column enters
the query. One PostgreSQL statement returns the eligible top100 and caller rank from
the same snapshot. Competition ranks are shared for ties, with UUID order stabilizing
display order. Team filtering applies to both outputs; banned, missing and out-of-team
callers have null rank. The caller can retain a full rank below the visible top100.

Catch score reads canonical catch_total achievement progress, which the real catch
service increments. It differs from current owned Pokemon count, returned separately.
XP sorts as the real BIGINT and serializes as text to avoid JSON precision loss above
Number.MAX_SAFE_INTEGER. Invalid attacks, arrays, objects, prototype names and unknown
enums return400 before any SQL query.

Run Node24 against isolated PostGIS:
`node --test --test-concurrency=1 backend/tests/regression/reward-leaderboard-storage.test.js`.
9 actual production-application/storage/HTTP cases pass, including exact large XP,
tied ranks, all3 score types, team scope, real catch/owned counts,100-row page bound,
caller below the page, authentication, invalid inputs and empty/banned populations.
The date-query/claim suite repeats18 checks against this changed reward application.
This does not establish the original7 social leaderboard types, seasons, cache latency,
live event updates, title display, client UI or ranking reward acceptance.

Both earlier title bootstrap and later consumer use source-bound full-copy repairs
that preserve matching update function/trigger OIDs and enabled state. Known body,
language/return type and execution metadata are checked. Custom body, security definer,
search path, volatility, trigger event or condition refuses atomically. Original catalog/
user-title rows, operator values, keys and view/relation identity survive. Missing known
update contracts are created. Populated bootstrap retains20 definitions; standalone
legacy consumer retains its original18.13 real cases pass in title-upgrade-storage.test.js,
with custom-state guards and disabled state tested against both repaired stages.

All85 original pending SQL files remain unchanged. Existing deployments with different
applied executed hashes need an explicit reviewed upgrade plan; checksums are not rewritten
to hide changed repairs. Full V1/V2 passes. The move bridge now preserves actual catalog values and retains proposed defaults;
see MOVE-DAMAGE.md. Complete85 history fails voice-chat20260618_160000 statement18
because its time-dependent index predicate is not immutable.
The entire pending transaction rolls back; no file is skipped. Full-chain data-preserving
upgrade/rollback and all native service/client/game acceptance remain open.

REQ-00255's original all-service SQL/XSS/path/Redis/command/logging/alert/false-positive
and measured p95<5ms criteria remain unaccepted. The previous approved review inferred
runtime results and numerical performance from class/regular-expression existence;
that approval is retracted. This route fix is one verified production slice.
