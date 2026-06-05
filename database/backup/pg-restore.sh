#!/bin/bash
# PostgreSQL 恢复脚本
# 支持全量恢复和时间点恢复 (PITR)
# 用法: pg-restore.sh --type=full|pitr [--target-time="YYYY-MM-DD HH:MM:SS"] [--backup-file=/path/to/backup]

set -e

# 配置
BACKUP_DIR="/backup/postgresql"
PG_DATA="/var/lib/postgresql/data"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"

# 参数解析
RESTORE_TYPE="full"
TARGET_TIME=""
BACKUP_FILE=""

for arg in "$@"; do
  case $arg in
    --type=*)
      RESTORE_TYPE="${arg#*=}"
      ;;
    --target-time=*)
      TARGET_TIME="${arg#*=}"
      ;;
    --backup-file=*)
      BACKUP_FILE="${arg#*=}"
      ;;
    --help)
      echo "Usage: $0 --type=full|pitr [--target-time=\"YYYY-MM-DD HH:MM:SS\"] [--backup-file=/path/to/backup]"
      echo ""
      echo "Options:"
      echo "  --type=full|pitr      Restore type (full or point-in-time recovery)"
      echo "  --target-time=TIME    Target time for PITR (format: YYYY-MM-DD HH:MM:SS)"
      echo "  --backup-file=PATH    Specific backup file to restore from"
      exit 0
      ;;
  esac
done

# 日志函数
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

error() {
  log "ERROR: $1"
  exit 1
}

# 检查 PostgreSQL 是否停止
check_pg_stopped() {
  if pg_isready -h "${PG_HOST}" -p "${PG_PORT}" -q 2>/dev/null; then
    error "PostgreSQL is running. Please stop the service before restore."
  fi
  log "PostgreSQL is stopped, ready for restore"
}

# 查找最新备份
find_latest_backup() {
  local latest=$(find "${BACKUP_DIR}/full" -name "minego-full-*.tar.gz" -type f | sort -r | head -1)
  if [ -z "${latest}" ]; then
    error "No backup found in ${BACKUP_DIR}/full"
  fi
  echo "${latest}"
}

# 验证备份文件
verify_backup() {
  local backup_file="$1"
  local checksum_file="${backup_file}.sha256"
  
  if [ -f "${checksum_file}" ]; then
    log "Verifying backup checksum..."
    if sha256sum -c "${checksum_file}" --quiet; then
      log "Checksum verification passed"
      return 0
    else
      error "Checksum verification failed"
    fi
  else
    log "Warning: No checksum file found, skipping verification"
  fi
}

# 全量恢复
restore_full() {
  local backup_file="$1"
  
  log "=== Starting Full Restore ==="
  log "Backup file: ${backup_file}"
  
  verify_backup "${backup_file}"
  
  # 清空数据目录
  log "Clearing data directory: ${PG_DATA}"
  rm -rf "${PG_DATA}"/*
  
  # 解压备份
  log "Extracting backup..."
  tar -xzf "${backup_file}" -C "${PG_DATA}"
  
  # 配置恢复模式
  cat > "${PG_DATA}/recovery.signal" <<EOF
# Recovery signal file for PostgreSQL
EOF
  
  log "Full restore completed"
  log "Start PostgreSQL to complete recovery"
}

# 时间点恢复 (PITR)
restore_pitr() {
  local backup_file="$1"
  local target_time="$2"
  
  log "=== Starting Point-in-Time Recovery ==="
  log "Backup file: ${backup_file}"
  log "Target time: ${target_time}"
  
  verify_backup "${backup_file}"
  
  # 清空数据目录
  log "Clearing data directory: ${PG_DATA}"
  rm -rf "${PG_DATA}"/*
  
  # 解压备份
  log "Extracting backup..."
  tar -xzf "${backup_file}" -C "${PG_DATA}"
  
  # 配置 PITR
  cat > "${PG_DATA}/postgresql.auto.conf" <<EOF
restore_command = 'cp ${BACKUP_DIR}/wal/%f %p'
recovery_target_time = '${target_time}'
recovery_target_action = 'promote'
EOF
  
  # 创建恢复信号文件
  touch "${PG_DATA}/recovery.signal"
  
  log "PITR configuration completed"
  log "Start PostgreSQL to recover to ${target_time}"
}

# 从云存储下载备份
download_from_cloud() {
  local backup_name="$1"
  
  if command -v ossutil >/dev/null 2>&1; then
    log "Downloading backup from OSS: ${backup_name}"
    
    ossutil cp "oss://minego-db-backup-prod/prod/full/${backup_name}/base.tar.gz" \
      "${BACKUP_DIR}/temp/${backup_name}/base.tar.gz"
    
    ossutil cp "oss://minego-db-backup-prod/prod/full/${backup_name}/base.tar.gz.sha256" \
      "${BACKUP_DIR}/temp/${backup_name}/base.tar.gz.sha256"
    
    echo "${BACKUP_DIR}/temp/${backup_name}/base.tar.gz"
  else
    error "Cloud download not available (ossutil not found)"
  fi
}

# 主函数
main() {
  log "=== PostgreSQL Restore Started ==="
  log "Restore type: ${RESTORE_TYPE}"
  
  check_pg_stopped
  
  # 确定备份文件
  if [ -z "${BACKUP_FILE}" ]; then
    BACKUP_FILE=$(find_latest_backup)
    log "Using latest backup: ${BACKUP_FILE}"
  fi
  
  case "${RESTORE_TYPE}" in
    full)
      restore_full "${BACKUP_FILE}"
      ;;
    pitr)
      if [ -z "${TARGET_TIME}" ]; then
        error "PITR requires --target-time parameter"
      fi
      restore_pitr "${BACKUP_FILE}" "${TARGET_TIME}"
      ;;
    *)
      error "Unknown restore type: ${RESTORE_TYPE}"
      ;;
  esac
  
  log "=== Restore Preparation Completed ==="
  log "Next steps:"
  log "1. Start PostgreSQL service"
  log "2. Verify data integrity"
  log "3. Update application connections if needed"
}

main "$@"
