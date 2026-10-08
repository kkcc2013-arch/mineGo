# Achievement storage and rewards

The canonical V1 `user_achievements` table keeps its UUID owner, composite key,
original definition foreign key, counters, tiers and timestamps. The achievement
bridge adds a modern definition reference and numeric progress fields to that
same stored record. `achievement_definitions.is_modern` identifies compatibility
entries created from the newer `achievements` catalog. Original tiered definitions
and earned progress remain unchanged; ID collisions fail atomically.

Legacy counter writes still work. Modern updates use their numeric progress field,
with PostgreSQL numeric arithmetic, a per-owner transaction lock and immutable
completed progress. The integer counter is a compatibility projection for modern
records. The existing user route reads the exact progress when available and works
against the original V1 schema too. Stored targets stay fixed for existing records.
Unknown historical creation/completion times remain null.

The dependency graph runs the existing title compatibility bootstrap and the new
achievement bridge before the legacy achievement consumer. Previously published
pending SQL sources stay immutable. The complete migration history remains gated;
its current failure is the message-center notification-type conflict after the
achievement stage. Do not infer whole-history success from the focused fixture.

The production achievement service credits rewards inside the same transaction as
the claim marker. Concurrent claims for an owner serialize. Coin rewards update the
actual user balance; balls update the V1 counters consumed by catch gameplay; other
known items use the inventory catalog, capacity check and valid stacks. A ball grant
creates one canonical balance. General inventory/catch synchronization remains a
separate open integration requirement.

Titles require an active canonical definition tied to the completed achievement.
Missing items/titles, unsupported reward types, unavailable title expiry policy,
capacity failures and database failures roll back all grants and the marker. Claims
never report success for undelivered resources. Current seeds include resource/title
contracts that still need reconciliation. Exclusive Pokémon rewards need an actual
grant implementation. An unused bridge can reverse to the original schema; reversal
with modern data is refused until an explicit data-preserving reverse migration is
available.

`/achievements/my`, `/my/progress`, `/:achievementId/claim` and title operations use
shared JWT authentication and the verified owner. Public category/leaderboard paths
precede the ID route. Both `/leaderboard` and `/leaderboard/global` work, with bounded
integer pagination. Completed hidden achievements become visible. Title activation
checks ownership and expiry; `DELETE /achievements/titles/active` clears activation.
The pokemon entry point mounts the router once. Native pokemon-service startup and
its gateway/client flows still need full acceptance.

Completion points and category totals are recomputed from completed modern records
inside the progress transaction. Partial increments award zero points. Committed
completion and claim counters, and actual update latency, register with the shared
registry served by the production launcher's `/metrics` endpoint. Definition CRUD
and its impact on existing snapshots still require a complete policy/implementation.

Run `TEST_DATABASE_URL=<isolated PostGIS> node --test backend/tests/regression/achievement-storage.test.js`
after installing the declared backend dependencies. This runs actual production
service/routes with real V1/seed/bridge/catalog storage. Current evidence is41 cases,
covering legacy preservation, decimal/concurrent progress, snapshots, actual grants,
rollback, ownership/static routes, titles and the real metrics endpoint. The fixture
uses owned random schemas and removes only its own test data.

Replay-safe event processing, durable completion/reward delivery, automatic grants,
all trigger types and catalog resources, management authorization/CRUD, client
rendering/localization, the legacy unit fixture, and the100ms query/50ms update targets
remain open. These checks do not mark REQ-00076 complete. Follow COMPLETION-PLAN.md for
the remaining658-requirement work.
