# Friendship identity and storage acceptance

REQ-00067 stores UUID trainer–Pokémon bonds with numeric levels0–10. REQ-00079's
later migration reused the same table name for integer instance IDs and named affinity
levels. Canonical V1 Pokémon/users both use UUIDs. Replacing IDs or converting the
existing level field would discard original identity or reinterpret historic values.

The 20261008_170000 prerequisite keeps the actual bond relation, UUID PK, per-trainer
unique key, FKs, original fields, values, dates, mood and counters. Former and current
trainer bonds for the same Pokémon remain separate. A generated pokemon_instance_id
is an exact UUID projection of pokemon_id. A generated affinity_level maps the shared
0–255 value to stranger/normal/friendly/close/beloved. The pokemon_affinity view exposes
that name and the preserved numeric bond_level separately. Neither generated projection
can drift through a direct write. This migration does not recompute historic numeric
levels or reset existing friendship values to a new capture default.

New walking/daily counters have explicit limits; historic first_obtained_at and
trainer-day count remain NULL because no reliable trainer acquisition history exists.
The original caught_at does not prove when the current trainer acquired that Pokémon.
Existing update-trigger/function identity, behavior and disabled states are retained.

The original value-change trigger wrote system_update into a five-action interaction
table whose enum/check forbids that value and whose delta must be positive. Both gains
and losses consequently failed. The repaired sink writes an actual signed before/after
delta to friendship_history using the existing bond/Pokémon/trainer UUIDs. Positive
interactive actions retain their original table and constraints. No old history is
invented, no specific action/source is inferred for a generic value update, and SQL
rollback removes its history alongside the value change. Concurrent updates serialize
on the actual row and produce a continuous delta chain. The trigger uses its actual
table schema instead of a caller-controlled search path.

The prerequisite refuses integer identities, prior bridge/history collisions, custom
log functions/security configuration or additional consumers of that function. These
need explicit data-preserving upgrade plans. An unused bridge reverses to exact original
rows/function/trigger and retains dependent views/FKs. Actual new history or metadata
blocks lossy down; retaining the bridge or providing a reverse plan is required. This
storage rollback restores the original log behavior; it does not certify full feature
rollback or reverse every later migration. Raw84 published SQL files remain immutable.

The whole SHA-bound REQ79 consumer repair uses the declared bridge instead of creating
a competing table, indexes actual UUIDs/affinity and uses canonical species keys/FKs.
It keeps all eight intended evolution lookups. The sample catalog lacks their required
targets, so zero seeded rows is a visible feature gap, not accepted evolution behavior.
No species or evolution statistics are fabricated to satisfy that count.

## Evidence and remaining work

Set TEST_DATABASE_URL to an isolated PostGIS database and use Node24:

- node --test backend/tests/regression/friendship-storage.test.js:20 actual checks,
  including all256 affinity values, preserved multiple trainer rows/keys/OIDs/views,
  positive/negative history, concurrency, failed writes, guarded rollback and custom
  schema refusal.
- node --test backend/tests/regression/migration-prerequisites.test.js:4 actual cases,
  including privacy CLI ordering and preservation described below.
- npm run test:migrations:unit --prefix backend:8 parser/graph checks.
- node --test backend/tests/regression/database-bootstrap.test.js:V1/V2 passes;
  complete85 pending history fails at20260612_070000 statement6, because the existing
  catch_sessions contract lacks catch_timestamp. The pending batch rolls back.

Combined actual CLI/prerequisite/audit/achievement/notification/friendship/privacy
storage checks:147 pass. The final friendship subset is repeated after preserving the
old update trigger, with matching complete-history failure. Syntax1421 files passes.
The migration workflow includes friendship checks before the full history gate.

These are storage acceptance slices. The shared affinity service still references
nonexistent getDb/logger/metrics adapters and incompatible numeric/text fields. Its
mounted router trusts caller X-User-Id and parses canonical UUIDs as integers. The older
bond service uses a different Pokémon table and nontransactional resources/cooldowns.
Actual JWT/ownership, capture/trade/battle/walking handlers, all five bond interactions,
all affinity actions/resources/daily limits, caching, milestones/events, at least eight
real evolution rules/execution, gym bonuses, both client contracts, metrics/coverage80/
85% and numeric user targets remain open. A compatible table is not complete service
acceptance. Req67's old done declaration is reopened; Req79 is in progress. All658
requirements and all original acceptance thresholds remain in scope.

## Privacy consumer ordering

The complete history previously reached a privacy-policy effective_date mismatch.
The already-tested additive privacy/default migration now runs after the original
GDPR tables and before the privacy consumer. The whole original-source-bound consumer
repair fills legacy required title/content/published_at from its own original text/date
and inserts its multilingual seed only when that version is absent. Existing policies,
texts, active flags, dates, user choices and consent times are preserved. New optional
preferences default false with no invented consent time. Unknown translations stay
unknown for existing policies. Two actual CLI cases check both new and preexisting
versions, durable execution order and unchanged choices. The original privacy production
route/storage11 checks also pass. Full privacy collection/UI/retention/export acceptance
remains open. No production migration, merge or deployment is performed.
