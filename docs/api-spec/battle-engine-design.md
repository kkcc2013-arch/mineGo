# Battle engine test contract

REQ-00619 verifies the production turn engine in
`backend/services/gym-service/src/battleEngine.js` and its pure
`battleFormulas.js` functions. The historical `/data/mineGo` impact paths map to
these files and `backend/tests/battle/` in the current repository.

`BattleEngine` accepts its existing battle/gym/user/opponent identifiers plus an
optional dependency object with `random`, `now` and `statusEngine`. Production
defaults remain available; each scenario injects independent state and controlled
clock/random/status boundaries. Tests call the production engine's attack, turn,
status, effect, serialization and result methods, including turn-induced switches
and replay behavior.

The pure formula module exports `TYPE_CHART`, `calculateTypeEffectiveness`,
`calculateDamage` and `determineTurnOrder`. It contains18 types with multiplicative
dual-type effectiveness. Immunity and zero-power moves produce zero damage.
Numeric level/stat/power inputs are bounded before arithmetic to prevent nonfinite
damage. Physical burn halves attack; modified stats take precedence when present.
Same-type and critical multipliers are1.5, followed by the existing0.85–1 random
factor and the module's explicit flooring order. Priority, effective speed and
injected randomness resolve turn order; paralysis halves effective speed.

`backend/tests/battle/context.js` provides independent Pokémon/move fixtures and
the controlled status boundary. `formulas.test.js` exercises57 formula cases;
`scenarios.test.js` exercises76 Given/When/Then business scenarios against the real
engine. Cases include type immunity, priorities, paralysis, residual effects,
chance boundaries, HP clamping, stat changes, lifecycle and replay behavior.

Run `npm run test:battle --prefix backend` and
`npm run test:battle:coverage --prefix backend`. The latter measures actual formula
coverage and enforces91% lines/functions/branches, preserving the original>90%
criterion. The independent `battle-regression` CI job runs this gate before builds.

This contract concerns the test framework and its controlled boundaries. It does
not prove persistent status services, mounted battle/raid HTTP or sockets, gateway,
game clients, production capacity or full gameplay acceptance. The separate damage
simulation module and its GO-style specification require their own verification;
their multipliers must not be inferred from this turn-engine formula contract.
