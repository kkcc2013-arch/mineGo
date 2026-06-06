# REQ-00025：数据库自动化备份与灾难恢复系统

- **编号**：REQ-00025
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：PostgreSQL、database/backup、infrastructure/k8s、.github/workflows
- **创建时间**：2026-06-05 17:00
- **依赖需求**：REQ-00007（数据库迁移管理系统）

## 1. 背景与问题

当前项目缺少数据库备份策略和灾难恢复方案。虽然 STATUS.md 提到"缺少备份策略"，但尚未有具体实现：

**风险分析：**
1. 数据丢失风险：生产环境 PostgreSQL 存储用户账号、精灵实例、交易记录等核心数据，无备份意味着任何故障都可能导致不可逆的数据丢失
2. 合规要求：根据 REQ-00016 GDPR 合规要求，需要有能力恢复用户数据
3. 运维安全：没有备份恢复演练，无法保证在真实灾难场景下能快速恢复服务

**当前缺失：**
- 无自动化备份任务
- 无备份存储策略（保留周期、异地备份）
- 无恢复流程和脚本
- 无备份验证机制

## 2. 目标

建立完整的数据库备份与灾难恢复体系，确保：

1. **数据安全**：每日全量备份 + 每小时增量备份，确保数据丢失不超过 1 小时
2. **快速恢复**：提供一键恢复脚本，RTO < 4 小时
3. **异地容灾**：备份文件存储到云存储（阿里云 OSS / AWS S3）
4. **备份验证**：定期自动验证备份文件可用性

## 3. 范围

**包含：**
- PostgreSQL 全量备份脚本（pg_dump + pg_basebackup）
- PostgreSQL 增量备份方案（WAL 归档）
- K8s CronJob 定时备份任务
- 备份上传到云存储（阿里云 OSS）
- 恢复脚本（全量恢复 + PITR 时间点恢复）
- 备份保留策略（7 天全量 + 30 天增量）
- 备份完整性验证脚本

**不包含：**
- 主从复制和高可用（属于单独需求）
- 跨区域灾备（后续扩展）
- 数据库分片

## 4. 详细需求

### 4.1 全量备份方案

```bash
# database/backup/pg-full-backup.sh
# 使用 pg_basebackup 进行物理备份
# 压缩格式：gzip
# 输出：/backup/full/{date}/base.tar.gz
```

- 每日凌晨 3:00 执行全量备份
- 保留最近 7 天的全量备份
- 备份文件命名：`minego-full-{YYYYMMDD-HHmmss}.tar.gz`

### 4.2 增量备份方案（WAL 归档）

```sql
-- postgresql.conf 配置
archive_mode = on
archive_command = 'cp %p /backup/wal/%f'
wal_level = replica
```

- 每 15 分钟归档一次 WAL 日志
- WAL 文件保留 30 天
- 支持时间点恢复（PITR）

### 4.3 K8s CronJob 配置

```yaml
# infrastructure/k8s/backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pg-backup-full
spec:
  schedule: "0 3 * * *"  # 每天凌晨 3 点
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:15
            command: ["/scripts/pg-full-backup.sh"]
```

### 4.4 云存储上传

- 使用 aliyun-oss-cli 上传到 OSS
- Bucket: minego-db-backup-{env}
- 路径: `prod/full/` 和 `prod/wal/`
- 生命周期规则：自动清理过期备份

### 4.5 恢复脚本

```bash
# database/backup/pg-restore.sh
# 支持参数：
#   --type=full|pitr
#   --target-time="2026-06-05 12:00:00" (PITR)
#   --backup-file=/backup/full/xxx.tar.gz
```

### 4.6 备份验证

- 每周自动执行备份恢复测试
- 验证备份文件完整性（MD5 校验）
- 恢复到测试实例并执行数据一致性检查

## 5. 验收标准（可测试）

- [ ] 全量备份脚本可正常执行，输出压缩备份文件
- [ ] K8s CronJob 成功创建并按计划执行备份任务
- [ ] 备份文件成功上传到云存储（OSS/S3）
- [ ] 恢复脚本可以将备份恢复到新数据库实例
- [ ] PITR 时间点恢复功能正常工作
- [ ] 备份保留策略正确清理过期文件
- [ ] 监控告警：备份失败时触发 Alertmanager 告警
- [ ] 文档：完整的备份恢复操作手册

## 6. 工作量估算

**L（Large）** - 预计 3-4 人天

理由：
- 涉及数据库底层操作（WAL 归档、pg_basebackup）
- 需要配置 K8s CronJob 和存储挂载
- 云存储集成需要测试验证
- 恢复流程需要完整演练

## 7. 优先级理由

**P1 理由：**
1. 数据是游戏的核心资产，没有备份意味着随时面临数据丢失风险
2. GDPR 合规（REQ-00016）要求具备数据恢复能力
3. 生产环境上线前必须具备灾难恢复方案
4. 虽然不是 P0（不影响核心功能），但对生产可用性至关重要
