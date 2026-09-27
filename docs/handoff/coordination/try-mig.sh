#!/usr/bin/env bash
# 在 CI 库上以"事务 + 回滚"方式试执行迁移文件，输出带行号的错误（不改变库）
# 用法：tools/try-mig.sh [--commit] database/pending/xxx.sql [...]
#   先把 repo 工作区同步到容器（仅 database/ 目录，快速）
set -uo pipefail
REPO=${REPO:-/data/workspace/mineGo/repo}
STACK=${STACK:-}
DEST=/data/mineGo-ci${STACK:+-$STACK}
DB=pmg_ci${STACK:+_$STACK}
. /data/workspace/mineGo/tools/.ci-secrets
END=ROLLBACK
if [ "${1:-}" = "--commit" ]; then END=COMMIT; shift; fi
(cd "$REPO" && tar -cf - database) | docker exec -i mine bash -c "cd $DEST && rm -rf database && tar -xf -"
for f in "$@"; do
  f=${f#./}; case "$f" in database/*) ;; *) f="database/$f" ;; esac
  [ -f "$REPO/$f" ] || { echo "MISSING $f"; continue; }
  # 与 bootstrap-dev.js 一致：有 migrate:up/down 标记时只执行 up 段
  docker exec -i mine bash -c "cd $DEST && rm -f /tmp/try-up.sql && awk 'BEGIN{m=0} /--[ ]*migrate:up/{m=1;next} /--[ ]*migrate:down/{exit} {print}' $f > /tmp/try-up.sql; grep -qE -- '--[ ]*migrate:(up|down)' $f || cp $f /tmp/try-up.sql"
  out=$(docker exec -i mine bash -c "cd $DEST && PGPASSWORD=$PG_PASS psql -h 127.0.0.1 -U pmg_ci -d $DB -q -v ON_ERROR_STOP=1 -X 2>&1" <<SQL
\set VERBOSITY default
BEGIN;
SET LOCAL statement_timeout='20s';
\i /tmp/try-up.sql
$END;
SQL
)
  if echo "$out" | grep -q 'ERROR'; then
    echo "FAIL $f"; echo "$out" | grep -E 'ERROR|^LINE' | head -2 | sed "s#/tmp/try-up.sql#L#" | sed 's/^/    /'
  else
    echo "ok   $f"
  fi
done
