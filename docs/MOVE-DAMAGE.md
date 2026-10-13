# Canonical moves and damage verification

REQ-00019 and REQ-00146 remain in progress. Their earlier done declarations did not
establish the complete required game/client/lifecycle behavior.

The actual learning catalog uses uppercase string IDs, localized name_zh/name_en,
uppercase type/category, signed energy_delta and required duration/cooldown fields.
The later damage migration expected lowercase name identities, incompatible inserts
and different power/energy defaults. Its source-bound replacement keeps all original
rows, IDs, power/type/energy/duration/localization, PKs/FKs, TM and learnset links and
relation identity. All24 original proposed defaults are retained in damage_move_defaults
configuration; they do not overwrite the active catalog or become fabricated fallback
moves. Unresolved proposals without a canonical definition remain inactive.

Name is a read-only lowercase identity projection, with uniqueness preventing ambiguous
aliases. Consumed energy is a read-only BIGINT projection max(0,-energy_delta), supporting
the original signed integer minimum without overflow. Unknown writable aliases/schemas
require explicit mapping/adoption. An explicit dependency orders the canonical move
migration first. Original85 pending SQL is unchanged.

Owned projections/configuration can reverse while preserving current original fields;
matching preexisting projections remain operator-owned. Changed defaults, comments,
index/relation identities and actual dependent views refuse lossy reversal. Exclusive
locks prevent configuration writes between reversal comparison and removal. This is
not a complete cross-service history/operations rollback certificate.

Production MoveService uses one actual database adapter. Learning/switching/forgetting
lock the real owner/instance; learning also locks TM inventory. Validation and learned
moves/TM deduction commit together. Concurrent requests cannot spend one TM twice;
a failed deduction rolls back learned moves and quantity. Equipped moves cannot be
forgotten, and foreign ownership fails. UUID HTTP paths and the TM-use body are validated without parseInt truncation;
list/detail/learnset/private move/inventory/learn/switch/forget/TM-use endpoints have
actual production-router HTTP checks and controlled errors. Full elite/legacy/slot/
resource/event/native/client
acceptance is still required beyond these actual cases.

The actual damage router reads canonical species and move fields and normalizes casing
at the engine boundary. Strict scalar numbers/types/weather/slots are required. Missing
rows are404, rather than invented Tackle data. Both /api/v1/gym/damage/simulate and the
original documented /api/v1/gym/battle/simulate path are mounted; root damage_multiplier
supports that command, with the existing wrapped response retained.

The shared calculator validates finite bounded inputs and own matrix keys. Midpoint
estimates are deterministic and include critical/weather/STAB effects; immunity and
zero power return zero estimates without an extra random draw or missing breakdown.
The contract retains the requirement's explicit classic2x/resistance/0-immunity matrix
and its0.5-power/stat-ratio/1.2-STAB/random85%-100% formula. This is not a claim that
these conflicting descriptions establish an authoritative external Pokemon GO standard.
The live battleEngine uses another formula and legacy raid paths still trust client
information; full battle/raid integration and anti-cheat remain open.

Run with Node24 and TEST_DATABASE_URL identifying isolated PostGIS:
`node --test --test-concurrency=1 backend/tests/regression/move-damage-storage.test.js`.
32 actual checks pass, including catalog/operator/history/reference preservation,
at-least50 original definitions read by real MoveService, owned move details, energy
projection extremes, exact reuse/reversal/guards/dependencies, TM concurrency/rollback,
real switching/forgetting, signed simulation, invalid inputs, canonical power, immunity,
all static endpoints and a real curl request. The HTTP fixtures use the production
router and the source mount is checked; native behavior is assessed separately.

`npm run test:damage --prefix backend` runs58 original assertions plus5 new formula/
input/random/estimate contracts and is now part of the main unit gate. The full unit
suite passes686 checks; syntax1432 passes. Changed engine/router/service modules load.

The reproducible diagnostic `node backend/tests/probes/gym-damage-process.js` runs the
actual gym entry point with an isolated schema and test Redis port56379. Native HTTP
returns200, multiplier0.5 and actual EMBER. Owned Kafka was unavailable during the probe.
The process did not terminate within its3s SIGTERM observation, so the diagnostic killed
it, observed SIGKILL termination and cleaned its schema; its exit status is1. This does
not prove dependency-aware readiness or graceful lifecycle, and3s is an observation
limit rather than a new acceptance threshold. No native successful shutdown is claimed.

Full V1/V2 passes; complete85 history now fails voice-chat20260618_160000 statement18:
its time-dependent index predicate is not immutable. The entire pending transaction
rolls back. Complete migration history, current CI, native readiness/shutdown, full
learning/reward/drop/client/energy and battle/raid criteria remain required. No new
requirement, production upgrade, journal rewrite, merge or deployment was performed.
