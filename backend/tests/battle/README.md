# Battle regression suite (REQ-00619)

Run `npm run test:battle` from `backend` on Node.js 20 or newer.
Run `npm run test:battle:coverage` on Node.js 24 for the native coverage gate.
The suite has no third-party dependencies and does not require Redis, PostgreSQL,
Kafka, or running services.

`formulas.test.js` checks exact damage, type multipliers, STAB, critical thresholds,
stat modifiers, turn order, missing attributes, and extreme numeric inputs.
`scenarios.test.js` exercises 76 Given/When/Then business scenarios against the
production BattleEngine, including attacks, whole turns, status-service lifecycle,
buff expiration, team replacement, AI selection, replay restoration, and rewards.
`context.js` supplies isolated teams, an injected clock, controlled random rolls,
and an optional status-service simulator. The simulator verifies the integration
boundary; it does not replace database-backed status-service integration tests.

The `battle-regression` CI job runs independently of dependency installation and
enforces at least 91% line, branch, and function coverage for `battleFormulas.js`.
Deployment builds depend on this job through the security-scan dependency.
The normal unit command also includes the battle scenarios.

Validation on 2026-10-06:

- 133 formula and scenario tests passed (57 formula tests, 76 business scenarios).
- Formula line, branch, and function coverage: 100% each.
- Existing gym battle suite: 39 tests passed.

Regression fixes made while adding this suite: zero damage for type immunity and
zero-power moves; explicit zero critical/status probabilities; accuracy boundaries;
correct status targeting when the defender attacks; nonnegative HP; toxic counters
reset on team replacement; replay retention when restoring cached battles.
