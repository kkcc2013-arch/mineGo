#!/bin/bash
# PostgreSQL WAL 归档脚本
# 用于增量备份和时间点恢复 (PITR)
# 用法: pg-wal-archive.sh <wal_file_path> <wal_file_name>

set -e

# 配置
WAL_DIR="/backup/postgresql/wal"
RETENTION_DAYS=30

# 云存储配置
OSS_BUCKET="${OSS_BUCKET:-minego-db-backup-prod}"
OSS_PATH="prod/wal"

# 参数
WAL_FILE_PATH="$1"
WAL_FILE_NAME="$2"

# 日志函数
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WAL-Archive] $1" >> /var/log/pg-wal-archive.log
}

# 错误处理
error() {
  log "ERROR: $1"
  exit 1
}

# 检查参数
if [ -z "${WAL_FILE_PATH}" ] || [ -z "${WAL_FILE_NAME}" ]; then
  error "Usage: $0 <wal_file_path> <wal_file_name>"
fi

# 创建 WAL 目录
mkdir -p "${WAL_DIR}"

# 复制 WAL 文件到归档目录
log "Archiving WAL file: ${WAL_FILE_NAME}"

if cp "${WAL_FILE_PATH}" "${WAL_DIR}/${WAL_FILE_NAME}"; then
  log "WAL file copied to local archive: ${WAL_DIR}/${WAL_FILE_NAME}"
  
  # 计算校验和
  sha256sum "${WAL_DIR}/${WAL_FILE_NAME}" > "${WAL_DIR}/${WAL_FILE_NAME}.sha256"
  
  # 上传到云存储（异步，不阻塞主流程）
  if command -v ossutil >/dev/null 2>&1; then
    (
      ossutil cp "${WAL_DIR}/${WAL_FILE_NAME}" "oss://${OSS_BUCKET}/${OSS_PATH}/${WAL_FILE_NAME}" && \
      ossutil cp "${WAL_DIR}/${WAL_FILE_NAME}.sha256" "oss://${OSS_BUCKET}/${OSS_PATH}/${WAL_FILE_NAME}.sha256" && \
      log "WAL file uploaded to OSS: ${WAL_FILE_NAME}"
    ) &
  fi
  
  # 清理过期 WAL 文件
  find "${WAL_DIR}" -name "*.wal" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
  find "${WAL_DIR}" -name "*.sha256" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
  
  exit 0
else
  error "Failed to copy WAL file: ${WAL_FILE_NAME}"
fi
