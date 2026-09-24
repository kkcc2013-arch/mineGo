#!/usr/bin/env bash
# REQ-00592: PM2 部署 + 部署后健康检查 + 失败自动回滚
#
# 用法：
#   scripts/deploy-pm2.sh [git-ref]          # 默认 origin/main
# 常用环境变量：
#   DEPLOY_DIR               部署目录（默认脚本所在仓库）
#   WATCH_SECONDS            部署后观察窗口，默认 300（5 分钟）
#   ERROR_RATE_THRESHOLD     5xx 比例阈值，默认 0.01（1%）
#   ROLLBACK_WATCH_SECONDS   回滚后的验证窗口，默认 60
#   RUN_MIGRATIONS=true      部署时执行 database/migrate.js up（回滚时不会执行）
#   SKIP_FETCH=true          不执行 git fetch（离线/本地测试）
#   NPM_INSTALL_FLAGS        默认 "--omit=dev"
#
# 流程：检查 .env 与工作区 → 记录当前版本 → 切到目标提交（detached）→ 依赖有变化才 npm install →
#       pm2 startOrReload → deploy-health-check.js 观察窗口 → 失败则切回上一版本并重新加载、再次验证。
# 每次部署在 .deploy-history/<id>.json 留存结果，当前版本写入 .deploy-history/current。
set -Eeuo pipefail

REF="${1:-origin/main}"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DEPLOY_DIR"

HIST_DIR=".deploy-history"
DEPLOY_ID="deploy-$(date +%Y%m%d-%H%M%S)"
NPM_INSTALL_FLAGS="${NPM_INSTALL_FLAGS:---omit=dev}"
mkdir -p "$HIST_DIR" logs

log() { echo "[deploy $(date '+%F %T')] $*"; }

record() { # status reason
  local status="$1" reason="${2:-}"
  cat > "$HIST_DIR/$DEPLOY_ID.json" <<JSON
{"id":"$DEPLOY_ID","ref":"$REF","from":"$PREV_SHA","to":"$TARGET_SHA","status":"$status","reason":"$reason","finishedAt":"$(date -Iseconds)"}
JSON
  log "result: $status ${reason:+($reason)}"
}

[ -f .env ] || { log "缺少 .env（参考 .env.example），终止"; exit 1; }
command -v pm2 >/dev/null || { log "未安装 pm2，终止"; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "工作区有未提交的修改，终止（请先处理：git status）"; exit 1
fi

PREV_SHA="$(git rev-parse HEAD)"
[ "${SKIP_FETCH:-false}" = "true" ] || git fetch --quiet origin
TARGET_SHA="$(git rev-parse --verify "${REF}^{commit}")"
log "$DEPLOY_ID: $PREV_SHA -> $TARGET_SHA ($REF)"

deps_changed() { # from to
  ! git diff --quiet "$1" "$2" -- 'backend/package.json' 'backend/package-lock.json' 'backend/*/package.json' 'backend/services/*/package.json'
}

switch_to() { # sha from_sha run_migrations
  local sha="$1" from="$2" migrate="$3"
  git -c advice.detachedHead=false checkout --quiet --detach "$sha"
  if deps_changed "$from" "$sha" || [ ! -d backend/node_modules ]; then
    log "依赖有变化，npm install $NPM_INSTALL_FLAGS"
    (cd backend && npm install $NPM_INSTALL_FLAGS --no-audit --no-fund --loglevel=error)
  fi
  if [ "$migrate" = "true" ]; then
    log "执行数据库迁移"
    (cd backend && node ../database/migrate.js up)
  fi
  pm2 startOrReload ecosystem.config.js --update-env
}

health() { # watch_seconds
  WATCH_SECONDS="$1" node scripts/deploy-health-check.js 2>&1 | tee -a "$HIST_DIR/$DEPLOY_ID-health.log"
}

if switch_to "$TARGET_SHA" "$PREV_SHA" "${RUN_MIGRATIONS:-false}" && health "${WATCH_SECONDS:-300}"; then
  echo "$DEPLOY_ID $TARGET_SHA" > "$HIST_DIR/current"
  pm2 save >/dev/null
  record success
  exit 0
fi

log "部署后健康检查失败，自动回滚到 $PREV_SHA"
if switch_to "$PREV_SHA" "$TARGET_SHA" false && health "${ROLLBACK_WATCH_SECONDS:-60}"; then
  echo "$DEPLOY_ID-rollback $PREV_SHA" > "$HIST_DIR/current"
  pm2 save >/dev/null
  record rolled_back "health check failed on $TARGET_SHA"
else
  record rollback_failed "health check failed on $TARGET_SHA and after rollback"
  log "回滚后仍不健康，请人工介入：pm2 logs / pm2 list"
fi
exit 1
