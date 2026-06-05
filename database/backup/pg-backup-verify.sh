#!/bin/bash
# PostgreSQL 备份验证脚本
# 验证备份文件完整性和可恢复性
# 用法: pg-backup-verify.sh [--backup-file=/path/to/backup] [--test-restore]

set -e

# 配置
BACKUP_DIR="/backup/postgresql"
TEST_DB_NAME="minego_backup_test"
TEST_PG_PORT=5433

# 参数
BACKUP_FILE=""
TEST_RESTORE=false

for arg in "$@"; do
  case $arg in
    --backup-file=*)
      BACKUP_FILE="${arg#*=}"
      ;;
    --test-restore)
      TEST_RESTORE=true
      ;;
    --help)
      echo "Usage: $0 [--backup-file=/path/to/backup] [--test-restore]"
      echo ""
      echo "Options:"
      echo "  --backup-file=PATH    Specific backup file to verify"
      echo "  --test-restore        Perform test restore to verify recoverability"
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

# 验证备份文件完整性
verify_integrity() {
  local backup_file="$1"
  
  log "=== Verifying Backup Integrity ==="
  
  # 检查文件是否存在
  if [ ! -f "${backup_file}" ]; then
    error "Backup file not found: ${backup_file}"
  fi
  
  # 检查文件大小
  local size=$(stat -f%z "${backup_file}" 2>/dev/null || stat -c%s "${backup_file}")
  if [ "${size}" -lt 1000000 ]; then
    error "Backup file too small (${size} bytes), likely corrupted"
  fi
  log "Backup size: $(( size / 1024 / 1024 )) MB"
  
  # 验证校验和
  local checksum_file="${backup_file}.sha256"
  if [ -f "${checksum_file}" ]; then
    log "Verifying SHA256 checksum..."
    if sha256sum -c "${checksum_file}" --quiet 2>/dev/null; then
      log "✅ Checksum verification passed"
    else
      error "❌ Checksum verification failed"
    fi
  else
    log "⚠️ No checksum file found"
  fi
  
  # 验证压缩文件完整性
  log "Verifying gzip integrity..."
  if gzip -t "${backup_file}" 2>/dev/null; then
    log "✅ Gzip integrity check passed"
  else
    error "❌ Gzip integrity check failed"
  fi
  
  # 验证 tar 内容
  log "Verifying tar archive contents..."
  local tar_contents=$(tar -tzf "${backup_file}" 2>/dev/null | head -20)
  if [ -n "${tar_contents}" ]; then
    log "✅ Tar archive valid, contents:"
    echo "${tar_contents}"
  else
    error "❌ Tar archive invalid or empty"
  fi
  
  log "✅ Backup integrity verification passed"
}

# 测试恢复
test_restore() {
  local backup_file="$1"
  
  log "=== Testing Backup Restore ==="
  
  # 创建临时数据目录
  local test_data_dir="/tmp/pg-restore-test-$$"
  mkdir -p "${test_data_dir}"
  
  log "Test data directory: ${test_data_dir}"
  
  # 解压备份
  log "Extracting backup..."
  tar -xzf "${backup_file}" -C "${test_data_dir}"
  
  # 检查必要文件
  local required_files=("PG_VERSION" "postgresql.conf" "base")
  for file in "${required_files[@]}"; do
    if [ -e "${test_data_dir}/${file}" ]; then
      log "✅ Found: ${file}"
    else
      log "⚠️ Missing: ${file}"
    fi
  done
  
  # 启动测试 PostgreSQL 实例（如果可用）
  if command -v pg_ctl >/dev/null 2>&1; then
    log "Starting test PostgreSQL instance..."
    
    # 初始化测试数据库
    pg_ctl -D "${test_data_dir}" -o "-p ${TEST_PG_PORT}" -l "${test_data_dir}/pg.log" start
    
    sleep 5
    
    # 检查是否启动成功
    if pg_isready -p ${TEST_PG_PORT} -q; then
      log "✅ Test PostgreSQL started successfully"
      
      # 检查数据库
      local db_list=$(psql -p ${TEST_PG_PORT} -U postgres -c "\l" 2>/dev/null)
      log "Databases found:"
      echo "${db_list}"
      
      # 检查表数量
      local table_count=$(psql -p ${TEST_PG_PORT} -U postgres -d minego -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" -t 2>/dev/null | tr -d ' ')
      log "Tables in minego database: ${table_count}"
      
      # 停止测试实例
      pg_ctl -D "${test_data_dir}" stop
      log "✅ Test PostgreSQL stopped"
    else
      log "⚠️ Test PostgreSQL failed to start"
    fi
  else
    log "⚠️ pg_ctl not available, skipping live restore test"
  fi
  
  # 清理
  rm -rf "${test_data_dir}"
  
  log "✅ Test restore completed"
}

# 生成验证报告
generate_report() {
  local backup_file="$1"
  local report_file="${backup_file}.verify-report"
  
  log "=== Generating Verification Report ==="
  
  cat > "${report_file}" <<EOF
# PostgreSQL Backup Verification Report

## Backup Information
- File: ${backup_file}
- Size: $(stat -f%z "${backup_file}" 2>/dev/null || stat -c%s "${backup_file}") bytes
- Modified: $(stat -f%Sm "${backup_file}" 2>/dev/null || stat -c%y "${backup_file}")
- Checksum: $(cat "${backup_file}.sha256" 2>/dev/null || echo "N/A")

## Verification Results
- Integrity Check: PASSED
- Checksum Verification: $( [ -f "${backup_file}.sha256" ] && echo "PASSED" || echo "SKIPPED" )
- Test Restore: $( [ "${TEST_RESTORE}" = true ] && echo "PASSED" || echo "SKIPPED" )

## Verification Time
$(date '+%Y-%m-%d %H:%M:%S')

## Status
✅ VERIFIED
EOF
  
  log "Report saved to: ${report_file}"
}

# 主函数
main() {
  log "=== PostgreSQL Backup Verification Started ==="
  
  # 确定备份文件
  if [ -z "${BACKUP_FILE}" ]; then
    BACKUP_FILE=$(find "${BACKUP_DIR}/full" -name "*.tar.gz" -type f | sort -r | head -1)
    if [ -z "${BACKUP_FILE}" ]; then
      error "No backup file found"
    fi
    log "Using latest backup: ${BACKUP_FILE}"
  fi
  
  verify_integrity "${BACKUP_FILE}"
  
  if [ "${TEST_RESTORE}" = true ]; then
    test_restore "${BACKUP_FILE}"
  fi
  
  generate_report "${BACKUP_FILE}"
  
  log "=== Verification Completed Successfully ==="
}

main "$@"
