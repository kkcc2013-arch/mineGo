# PROGRESS — E17 安全加固 (branch work/e17-security)

Rules: /data/workspace/mineGo/tools/AGENT-BRIEF.md — NO services (no ci-stack/PM2/DB/Redis/browser).
Static checks only: `node --check`, `node scripts/check-deps.js`, `node scripts/api-lint.js` (0 err; `--docs` after route changes),
`node scripts/contract-snapshot.js --check` (未审批 0), host-runnable `node --test` (no 3rd-party requires at module top level).
Commit small steps. Never push. Final: `git merge dev/review-20260924`, rerun checks, report in Chinese.

## Status
- [x] Recon (docs acceptance extracted; surveys of pre-existing modules)
- [ ] (see sections below as work proceeds)

## Design decisions (keep consistent!)
(filled in below)

## Pitfalls
- Host has no node_modules: pure modules must lazy-require logger/metrics/redis/db (inject deps).
- Gateway is PM2 cluster (2 instances): nonce/penalty state must be in Redis (memory fallback only for tests/dev).
- users.password_hash / password_changed_at are referenced by user-service PUT /users/me/password but NO migration creates them.
- Top-level /gateway dir is NOT run (REQ-00588 code lives there: gateway/src/middleware/riskAssessment.js, routes/mfa.js).
- E14 worker: limiter will emit 'throttled'/'reset' events on an EventEmitter; config center at shared/configCenter/.
