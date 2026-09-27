# PROGRESS — E14/E15/E18 (branch work/e14-e15-e18)

Rules: tools/AGENT-BRIEF.md — NO services (no ci-stack/PM2/DB/Redis/browser). Static checks only:
`node --check`, `node scripts/check-deps.js`, `node scripts/api-lint.js` (0 err, `--docs` after route changes),
`node scripts/contract-snapshot.js --check`, host-runnable `node --test` (no 3rd-party requires).
Merged dev/review-20260924 (E25) at start (fast-forward to afc45e1).

## Status
- [x] Recon
- [ ] E15 config center: pure `shared/configCenter/schema.js` (+tests) → migration → ConfigStore/ConfigClient → gateway routes → ServiceLauncher hook → /v1/client-config
- [ ] E15 experiments: `shared/experiments/{bucketing,stats}.js` (+tests) → store → routes
- [ ] E18 rate limit: `shared/rateLimit/*` (+tests) → gateway middleware → routes
- [ ] E14 feedback: user-service feedbackPolicy (+tests) → migration → routes → gateway proxy → client feature → admin page
- [ ] admin-dashboard pages (config-center.html, feedback.html, rate-limit.html)
- [ ] smoke scripts scripts/smoke-ops-platform.js, bench script
- [ ] docs records (9 docs), api-lint --docs, contract check, merge dev branch again, final report

## Design decisions (keep consistent!)
- Gateway index.js edits must stay minimal (E25 owns pipeline): (1) remove old configRoutes require+2 mounts,
  (2) ONE middleware line after `apiStdSetup.apiStd.middleware()`: adaptive limiter,
  (3) ONE mount line: `require('./routes/opsPlatform').mount(app, {...})` before 404.
- Body uploads: JSON base64 only (pipeline 415s non-JSON; user-service express.json limit 1mb) → screenshot ≤ 640KB decoded.
- Config center: Postgres source of truth (config_entries/config_history + existing config_audit_log extended);
  Redis pub/sub channel `cfg:changed:<env>` + poll MAX(config_history.id) every 10s backstop; last-known-good file cache.
  Canary: canary_value + canary_targets {instances,groups}. Secrets via shared/fieldCrypto (reject if keys not configured).
- Experiments: sha256(salt:traffic:uid) & sha256(salt:variant:uid) → uint32 buckets; exposures PK (exp,user); conversions unique (exp,user,metric);
  z-test pooled + CI unpooled; SRM chi-square; guardrails auto-pause.
- Rate limit: Lua sliding-window-counter multi-limit atomic script; local in-memory fallback (fail-open, per-instance);
  plan from user_quotas.quota_level (+premium via constraint change); boosts rate_limit_boosts; anti-cheat trust from Redis `anticheat:trust:<uid>`;
  events 'throttled'/'reset' on limiter EventEmitter for E17 (REQ-00389 bypass detection).
- Feedback: reuse/extend table player_feedbacks (040 migration), feedback_workflow_logs; new feedback_comments/feedback_attachments/feedback_trend_reports.
  Delete unwired broken REQ-00339 files: user-service routes/feedback.js, controllers/FeedbackController.js, shared/routes/feedbackAdminRoutes.js, tests/feedback.test.js.
- Old modules to replace/delete: shared/ConfigCenter.js (→ facade), gateway/src/routes/configRoutes.js (delete),
  gateway/src/routes/quota.js (unwired, delete), shared/AdaptiveRateLimiter.js + AdaptiveRateLimitMiddleware.js + IntelligentRateLimiter.js
  + SmartRateLimitMiddleware.js (unwired, decide), intelligentRateLimit.js userLevelRateLimiter bug (limiter created per request → fix).

## Notes / pitfalls
- Host has no node_modules: pure modules must lazy-require logger/metrics/redis/db.
- `@pmg/shared/*` resolves to backend/shared (lockfile link).
