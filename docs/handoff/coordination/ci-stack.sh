#!/usr/bin/env bash
# 在本机 mine 容器里运行一套与生产隔离的 CI 栈（不影响容器内已在运行的 pmg-* 服务）
#   数据库 pmg_ci / 角色 pmg_ci；Redis 独立实例 :6390；服务端口 18080-18089；PM2 进程名前缀 ci-
#
# 用法：tools/ci-stack.sh [sync|reset-db|start|stop|smoke|test|all] ...
#   sync      把 repo 工作区（含未提交改动）同步到容器 /data/mineGo-ci，必要时 npm install
#   reset-db  删除并重建 pmg_ci，执行 bootstrap-dev 全部迁移 + 刷怪点种子
#   migrate   在现有 pmg_ci 上重跑 bootstrap-dev（幂等收敛）
#   start     pm2 startOrReload ci-*，等待网关健康
#   stop      pm2 delete ci-*
#   smoke     经网关跑 scripts/smoke-core-flow.js
#   test      单元测试 npm run test:unit
#   all       sync + reset-db + start + test + smoke
set -euo pipefail

# 并行栈：STACK=1..9 时使用独立的目录/数据库/Redis/端口/进程名（默认栈 STACK 为空）
#   STACK=N → /data/mineGo-ci-N、数据库 pmg_ci_N、Redis :6390+N、端口 18080+100*N、进程名 ciN-*
REPO=${REPO:-/data/workspace/mineGo/repo}
CT=${CT:-mine}
STACK=${STACK:-}
N=${STACK:-0}
DEST=/data/mineGo-ci${STACK:+-$STACK}
DB=pmg_ci${STACK:+_$STACK}
PORT_BASE=$((18080 + 100 * N))
REDIS_PORT=$((6390 + N))
PREFIX=ci${STACK}-
SECRETS=/data/workspace/mineGo/tools/.ci-secrets   # 本地随机生成，不进仓库

log() { printf '[ci-stack %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
dx() { docker exec -i "$CT" bash -lc "$*"; }

ensure_secrets() {
  if [ ! -f "$SECRETS" ]; then
    umask 077
    {
      echo "PG_PASS=$(openssl rand -hex 16)"
      echo "REDIS_PASS=$(openssl rand -hex 16)"
      echo "JWT_A=$(openssl rand -hex 32)"
      echo "JWT_R=$(openssl rand -hex 32)"
      echo "ENC1=$(openssl rand -hex 32)"
      echo "HASHK=$(openssl rand -hex 32)"
    } > "$SECRETS"
  fi
  # shellcheck disable=SC1090
  . "$SECRETS"
}

write_env() {
  ensure_secrets
  dx "cat > $DEST/.env" <<EOF
NODE_ENV=production
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=$DB
POSTGRES_USER=pmg_ci
POSTGRES_PASSWORD=$PG_PASS
REDIS_HOST=127.0.0.1
REDIS_PORT=$REDIS_PORT
REDIS_PASSWORD=$REDIS_PASS
JWT_ACCESS_SECRET=$JWT_A
JWT_REFRESH_SECRET=$JWT_R
JWT_ACCESS_TTL=24h
JWT_REFRESH_TTL=30d
FIELD_ENCRYPTION_KEYS=k1:$ENC1
FIELD_ENCRYPTION_ACTIVE_KID=k1
FIELD_HASH_KEY=$HASHK
SMS_DEV_MODE=false
TRUST_PROXY=loopback
PORT_BASE=$PORT_BASE
PM2_NAME_PREFIX=$PREFIX
GATEWAY_INSTANCES=1
LOCATION_INSTANCES=1
CATCH_INSTANCES=1
LOG_DIR=$DEST/logs
EOF
}

cmd_sync() {
  log "同步工作区 -> $CT:$DEST"
  dx "mkdir -p $DEST"
  # 仅同步受版本控制或未忽略的文件；保留容器侧 node_modules/.env/logs
  (cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) |
    dx "cd $DEST && find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .env ! -name logs ! -name backend -exec rm -rf {} + ;
        find backend -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true;
        tar -xf - && mkdir -p logs"
  local h
  h=$(cd "$REPO/backend" && cat package.json package-lock.json services/*/package.json gateway/package.json shared/package.json 2>/dev/null | sha1sum | cut -c1-12)
  if [ "$(dx "cat $DEST/backend/node_modules/.ci-hash 2>/dev/null" || true)" != "$h" ]; then
    log "依赖有变化，npm install（backend workspaces）"
    dx "cd $DEST/backend && npm install --no-audit --no-fund --loglevel=error >/tmp/ci-npm${STACK:+-$STACK}.log 2>&1 || { tail -30 /tmp/ci-npm${STACK:+-$STACK}.log; exit 1; }; echo $h > node_modules/.ci-hash"
  fi
  write_env
}

ensure_redis() {
  ensure_secrets
  if ! dx "redis-cli -p $REDIS_PORT -a '$REDIS_PASS' --no-auth-warning ping" 2>/dev/null | grep -q PONG; then
    log "启动 CI Redis :$REDIS_PORT"
    dx "redis-server --port $REDIS_PORT --bind 127.0.0.1 --requirepass '$REDIS_PASS' --save '' --appendonly no --daemonize yes --logfile /tmp/redis-ci.log"
  fi
}

psql_su() { dx "su postgres -c \"psql -v ON_ERROR_STOP=1 -q $*\""; }

cmd_reset_db() {
  ensure_secrets
  cmd_stop || true
  log "重建数据库 $DB"
  dx "su postgres -c 'psql -v ON_ERROR_STOP=1 -q'" <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid();
DROP DATABASE IF EXISTS $DB;
DO \$\$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pmg_ci') THEN CREATE ROLE pmg_ci LOGIN PASSWORD '$PG_PASS'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='minego_user') THEN CREATE ROLE minego_user NOLOGIN; END IF;
END\$\$;
ALTER ROLE pmg_ci PASSWORD '$PG_PASS';
CREATE DATABASE $DB OWNER pmg_ci;
SQL
  dx "su postgres -c \"psql -q -d $DB -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS \\\"uuid-ossp\\\"; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; GRANT ALL ON SCHEMA public TO pmg_ci;'\""
  cmd_migrate
  ensure_redis
  dx "redis-cli -p $REDIS_PORT -a '$REDIS_PASS' --no-auth-warning flushall >/dev/null"
}

cmd_migrate() {
  ensure_secrets
  log "执行迁移（bootstrap-dev）"
  dx "cd $DEST && DATABASE_URL=postgres://pmg_ci:$PG_PASS@127.0.0.1:5432/$DB node database/bootstrap-dev.js --report 2>&1 | grep -vE '^\s+FAIL' | tail -5; echo; node -e \"const r=require('./database/bootstrap-report.json');console.log('migrations applied='+r.applied+' failed='+r.failed.length)\""
  dx "cd $DEST/backend && DATABASE_URL=postgres://pmg_ci:$PG_PASS@127.0.0.1:5432/$DB node seed_spawns.js 2>&1 | tail -2"
}

cmd_start() {
  ensure_redis
  log "pm2 startOrReload ${PREFIX}*"
  dx "cd $DEST && ENV_FILE=$DEST/.env DEPLOY_DIR=$DEST pm2 startOrReload ecosystem.config.js --update-env >/dev/null"
  for i in $(seq 1 30); do
    if dx "curl -sf http://127.0.0.1:$PORT_BASE/health" >/dev/null 2>&1; then
      log "网关健康"; dx "curl -s http://127.0.0.1:$PORT_BASE/health" | head -c 600; echo; return 0
    fi
    sleep 2
  done
  log "网关 60s 内未就绪"; dx "pm2 ls | grep $PREFIX"; return 1
}

cmd_stop() { dx "pm2 delete /^${PREFIX}/ >/dev/null 2>&1 || true"; }

cmd_smoke() {
  ensure_secrets
  dx "cd $DEST && BASE_URL=http://127.0.0.1:$PORT_BASE REDIS_URL=redis://:$REDIS_PASS@127.0.0.1:$REDIS_PORT/0 node scripts/smoke-core-flow.js"
}

cmd_test() { dx "cd $DEST/backend && npm run -s test:unit 2>&1 | tail -40"; }

cmd_psql() { ensure_secrets; dx "PGPASSWORD=$PG_PASS psql -h 127.0.0.1 -U pmg_ci -d $DB $*"; }

case "${1:-all}" in
  sync) cmd_sync ;;
  reset-db) cmd_reset_db ;;
  migrate) cmd_migrate ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  smoke) cmd_smoke ;;
  test) cmd_test ;;
  logs) shift; dx "cd $DEST/logs && tail -n ${2:-60} \$(ls -t ${1:-}*-error*.log ${1:-}*-out*.log 2>/dev/null | head -2)" ;;
  sh) shift; dx "cd $DEST && $*" ;;
  psql) shift; cmd_psql "$@" ;;
  env) ensure_secrets; echo "DATABASE_URL=postgres://pmg_ci:$PG_PASS@127.0.0.1:5432/$DB REDIS_URL=redis://:$REDIS_PASS@127.0.0.1:$REDIS_PORT/0 BASE_URL=http://127.0.0.1:$PORT_BASE" ;;
  all) cmd_sync; cmd_reset_db; cmd_start; cmd_test; cmd_smoke ;;
  *) echo "unknown: $1"; exit 2 ;;
esac
