#!/bin/bash
# PostgreSQL 全量备份脚本
# 使用 pg_basebackup 进行物理备份
# 用法: pg-full-backup.sh [--env=prod|staging|dev]

set -e

# 配置
ENV="${1#--env=}"
ENV=${ENV:-prod}
BACKUP_DIR="/backup/postgresql"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE_DIR=$(date +%Y%m%d)
BACKUP_NAME="minego-full-${TIMESTAMP}"
RETENTION_DAYS=7

# 数据库连接信息（从环境变量或配置文件读取）
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-minego}"

# 云存储配置
OSS_BUCKET="minego-db-backup-${ENV}"
OSS_PATH="prod/full"

# 日志函数
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 错误处理
error() {
  log "ERROR: $1"
  exit 1
}

# 检查依赖
check_dependencies() {
  command -v pg_basebackup >/dev/null 2>&1 || error "pg_basebackup not found"
  command -v gzip >/dev/null 2>&1 || error "gzip not found"
  command -v ossutil >/dev/null 2>&1 || log "Warning: ossutil not found, cloud upload disabled"
}

# 创建备份目录
create_backup_dir() {
  local dir="${BACKUP_DIR}/full/${DATE_DIR}"
  mkdir -p "${dir}"
  log "Created backup directory: ${dir}"
}

# 执行全量备份
perform_backup() {
  local output_dir="${BACKUP_DIR}/full/${DATE_DIR}/${BACKUP_NAME}"
  
  log "Starting full backup to ${output_dir}"
  
  # 使用 pg_basebackup 进行物理备份
  pg_basebackup \
    -h "${PG_HOST}" \
    -p "${PG_PORT}" \
    -U "${PG_USER}" \
    -D "${output_dir}" \
    -Ft \
    -z \
    -Xs \
    -P \
    -v 2>&1 | tee "${output_dir}.log"
  
  # 检查备份是否成功
  if [ -f "${output_dir}/base.tar.gz" ]; then
    log "Backup completed successfully"
    
    # 计算校验和
    cd "${output_dir}"
    sha256sum base.tar.gz > base.tar.gz.sha256
    log "Checksum: $(cat base.tar.gz.sha256)"
    
    # 记录备份元数据
    cat > backup-metadata.json <<EOF
{
  "type": "full",
  "timestamp": "${TIMESTAMP}",
  "database": "${PG_DATABASE}",
  "environment": "${ENV}",
  "host": "${PG_HOST}",
  "port": "${PG_PORT}",
  "size_bytes": $(stat -f%z base.tar.gz 2>/dev/null || stat -c%s base.tar.gz),
  "checksum": "$(cut -d' ' -f1 base.tar.gz.sha256)"
}
EOF
    
    return 0
  else
    error "Backup failed: base.tar.gz not found"
  fi
}

# 上传到云存储
upload_to_cloud() {
  local backup_path="${BACKUP_DIR}/full/${DATE_DIR}/${BACKUP_NAME}"
  
  if command -v ossutil >/dev/null 2>&1; then
    log "Uploading backup to OSS: oss://${OSS_BUCKET}/${OSS_PATH}/${BACKUP_NAME}"
    
    # 上传备份文件
    ossutil cp "${backup_path}/base.tar.gz" \
      "oss://${OSS_BUCKET}/${OSS_PATH}/${BACKUP_NAME}/base.tar.gz"
    
    # 上传校验和
    ossutil cp "${backup_path}/base.tar.gz.sha256" \
      "oss://${OSS_BUCKET}/${OSS_PATH}/${BACKUP_NAME}/base.tar.gz.sha256"
    
    # 上传元数据
    ossutil cp "${backup_path}/backup-metadata.json" \
      "oss://${OSS_BUCKET}/${OSS_PATH}/${BACKUP_NAME}/backup-metadata.json"
    
    log "Upload completed"
  else
    log "Skipping cloud upload (ossutil not available)"
  fi
}

# 清理过期备份
cleanup_old_backups() {
  log "Cleaning up backups older than ${RETENTION_DAYS} days"
  
  find "${BACKUP_DIR}/full" -type d -name "minego-full-*" -mtime +${RETENTION_DAYS} -exec rm -rf {} \; 2>/dev/null || true
  
  # 清理空目录
  find "${BACKUP_DIR}/full" -type d -empty -delete 2>/dev/null || true
  
  log "Cleanup completed"
}

# 发送通知
send_notification() {
  local status="$1"
  local message="$2"
  
  # Prometheus Pushgateway
  if [ -n "${PUSHGATEWAY_URL}" ]; then
    cat <<EOF | curl --data-binary @- "${PUSHGATEWAY_URL}/metrics/job/pg_backup/instance/${HOSTNAME}"
# TYPE pg_backup_success gauge
pg_backup_success{type="full",env="${ENV}"} ${status}
# TYPE pg_backup_timestamp gauge
pg_backup_timestamp{type="full",env="${ENV}"} $(date +%s)
EOF
  fi
  
  log "Notification sent: ${message}"
}

# 主函数
main() {
  log "=== PostgreSQL Full Backup Started ==="
  log "Environment: ${ENV}"
  log "Database: ${PG_DATABASE}@${PG_HOST}:${PG_PORT}"
  
  check_dependencies
  create_backup_dir
  
  if perform_backup; then
    upload_to_cloud
    cleanup_old_backups
    send_notification 1 "Backup completed successfully"
    log "=== Backup Completed Successfully ==="
    exit 0
  else
    send_notification 0 "Backup failed"
    log "=== Backup Failed ==="
    exit 1
  fi
}

main "$@"
