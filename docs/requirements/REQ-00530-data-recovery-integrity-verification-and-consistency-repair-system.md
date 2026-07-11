# REQ-00530：数据恢复完整性校验与一致性自动修复系统

- **编号**：REQ-00530
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/disasterRecovery、backend/shared/pokemonBackupService.js、backend/shared/dataRecoveryValidator.js、backend/jobs/dataRecoveryVerificationJob.js、PostgreSQL、Redis、Kafka
- **创建时间**：2026-07-11 05:00
- **依赖需求**：REQ-00025（数据库备份与灾难恢复系统）、REQ-00375（多区域灾备自动化切换系统）、REQ-00514（多区域状态同步与仲裁系统）

## 1. 背景与问题

当前项目已实现数据库备份系统（REQ-00025）、精灵数据备份服务（pokemonBackupService.js）、多区域灾备切换（REQ-00375）和多区域状态仲裁系统（REQ-00514），具备：
- PostgreSQL 全量/增量备份机制
- WAL 归档和时间点恢复（PITR）能力
- 多区域灾备自动化切换
- 状态同步与智能仲裁

**现有痛点：**
1. 恢复后的数据缺乏完整性校验，无法确认恢复是否成功
2. 跨服务数据依赖关系（如精灵-用户关联）恢复后可能不一致
3. Redis 缓存与 PostgreSQL 数据恢复后可能存在状态不一致
4. Kafka 消息流恢复后可能有消息丢失或重复
5. 缺乏恢复后的数据修复机制，需要人工介入
6. 恢复操作缺乏审计追踪，无法溯源问题

## 2. 目标

建立数据恢复完整性校验与一致性自动修复系统，实现：
- 多层次数据完整性校验（文件级、记录级、关系级）
- 跨服务数据一致性验证（PostgreSQL + Redis + Kafka）
- 智能修复机制：自动修复可恢复的不一致数据
- 恢复审计追踪：完整的恢复操作日志
- 恢复成功率量化：提供恢复健康评分

## 3. 背景与问题

当前项目已实现数据库备份系统（REQ-00025）、精灵数据备份服务（pokemonBackupService.js）、多区域灾备切换（REQ-00375）和多区域状态仲裁系统（REQ-00514），具备：
- PostgreSQL 全量/增量备份机制
- WAL 归档和时间点恢复（PITR）能力
- 多区域灾备自动化切换
- 状态同步与智能仲裁

**现有痛点：**
1. 恢复后的数据缺乏完整性校验，无法确认恢复是否成功
2. 跨服务数据依赖关系（如精灵-用户关联）恢复后可能不一致
3. Redis 缓存与 PostgreSQL 数据恢复后可能存在状态不一致
4. Kafka 消息流恢复后可能有消息丢失或重复
5. 缺乏恢复后的数据修复机制，需要人工介入
6. 恢复操作缺乏审计追踪，无法溯源问题

## 2. 目标

建立数据恢复完整性校验与一致性自动修复系统，实现：
- 多层次数据完整性校验（文件级、记录级、关系级）
- 跨服务数据一致性验证（PostgreSQL + Redis + Kafka）
- 智能修复机制：自动修复可恢复的不一致数据
- 恢复审计追踪：完整的恢复操作日志
- 恢复成功率量化：提供恢复健康评分

## 3. 范围

- **包含**：
  - DataRecoveryValidator - 数据恢复完整性校验器
  - CrossServiceConsistencyChecker - 跨服务一致性检查器
  - DataConsistencyRepairEngine - 数据一致性智能修复引擎
  - RecoveryAuditLogger - 恢复审计日志记录器
  - RecoveryHealthScoreCalculator - 恢复健康评分计算器
  - dataRecoveryVerificationJob.js - 定期恢复验证定时任务

- **不包含**：
  - 数据备份执行逻辑（已有 REQ-00025）
  - 灾备切换执行逻辑（已有 FailoverController）
  - 状态仲裁机制（已有 ArbitrationEngine）

## 4. 详细需求

### 4.1 DataRecoveryValidator 数据恢复完整性校验器

```javascript
class DataRecoveryValidator {
  // 校验层次
  validationLevels: {
    FILE: 'file',       // 文件级：备份文件完整性
    RECORD: 'record',   // 记录级：每条记录完整性
    RELATION: 'relation' // 关系级：跨表关系完整性
  }
  
  // 校验规则
  checksumAlgorithms: ['md5', 'sha256']
  recordValidators: {
    users: (record) => record.id && record.email,
    pokemon_instances: (record) => record.id && record.user_id && record.pokemon_id,
    gym_battles: (record) => record.id && record.gym_id && record.user_id
  }
  
  // 核心方法
  async validateBackupFile(filePath) // 验证备份文件完整性
  async validateRecords(tableName, records) // 验证记录完整性
  async validateRelations() // 验证跨表关系完整性
  async generateValidationReport() // 生成校验报告
  
  // 报告结构
  validationReport: {
    timestamp: ISO8601,
    backupId: string,
    levels: {
      file: { valid: bool, checksum: string, size: bytes },
      record: { valid: bool, totalRecords: number, invalidRecords: [] },
      relation: { valid: bool, brokenRelations: [] }
    },
    overallScore: 0-100
  }
}
```

### 4.2 CrossServiceConsistencyChecker 跨服务一致性检查器

```javascript
class CrossServiceConsistencyChecker {
  // 数据源配置
  dataSources: {
    postgresql: { tables: ['users', 'pokemon_instances', 'gym_battles', 'transactions'] },
    redis: { keys: ['user:*', 'pokemon:*', 'session:*', 'cache:*'] },
    kafka: { topics: ['pokemon-events', 'battle-events', 'transaction-events'] }
  }
  
  // 一致性检查规则
  consistencyRules: {
    user_pokemon_count: {
      postgres: 'SELECT COUNT(*) FROM pokemon_instances WHERE user_id = $1',
      redis: 'GET user:{userId}:pokemon_count',
      tolerance: 0 // 严格一致
    },
    session_state: {
      postgres: 'SELECT session_token FROM users WHERE id = $1',
      redis: 'GET session:{userId}:token',
      tolerance: 0
    },
    battle_outcome_sync: {
      postgres: 'SELECT outcome FROM gym_battles WHERE id = $1',
      kafka: 'battle-events topic last message',
      tolerance: 1 // 允许 1 条消息延迟
    }
  }
  
  // 核心方法
  async checkUserPokemonConsistency(userId) // 检查精灵数量一致性
  async checkSessionConsistency(userId) // 检查会话一致性
  async checkEventStreamConsistency(topic) // 检查事件流一致性
  async runFullConsistencyCheck() // 全量一致性检查
}
```

### 4.3 DataConsistencyRepairEngine 数据一致性智能修复引擎

```javascript
class DataConsistencyRepairEngine {
  // 修复策略
  repairStrategies: {
    MISSING_RECORD: {
      strategy: 'restore_from_backup',
      priority: 1 // 优先从备份恢复
    },
    ORPHAN_RECORD: {
      strategy: 'cascade_delete_or_reassign',
      priority: 2
    },
    COUNT_MISMATCH: {
      strategy: 'recalculate_and_sync',
      priority: 1
    },
    STALE_CACHE: {
      strategy: 'invalidate_and_rebuild',
      priority: 1
    },
    MESSAGE_GAP: {
      strategy: 'replay_from_wal',
      priority: 2
    }
  }
  
  // 自动修复阈值
  autoRepairThreshold: {
    records: 100,  // < 100 条记录不一致自动修复
    users: 50,     // < 50 个用户受影响自动修复
    severity: 70   // 严重度 < 70 自动修复
  }
  
  // 核心方法
  async analyzeInconsistency(issue) // 分析不一致原因
  async selectRepairStrategy(issue) // 选择修复策略
  async executeRepair(strategy, issue) // 执行修复
  async verifyRepair(issue) // 验证修复结果
  async generateRepairReport() // 生成修复报告
}
```

### 4.4 RecoveryAuditLogger 恢复审计日志记录器

```javascript
class RecoveryAuditLogger {
  // 审计事件类型
  auditEvents: {
    RECOVERY_STARTED: 'recovery_started',
    RECOVERY_COMPLETED: 'recovery_completed',
    VALIDATION_PASSED: 'validation_passed',
    VALIDATION_FAILED: 'validation_failed',
    REPAIR_EXECUTED: 'repair_executed',
    REPAIR_FAILED: 'repair_failed',
    MANUAL_INTERVENTION_REQUIRED: 'manual_intervention_required'
  }
  
  // 日志结构
  auditLog: {
    eventId: uuid,
    timestamp: ISO8601,
    eventType: string,
    recoveryId: string,
    operator: string, // 'system' | 'admin_id'
    details: {
      action: string,
      affectedRecords: number,
      affectedUsers: number,
      duration: ms,
      result: 'success' | 'failure' | 'partial'
    },
    previousState: object,
    newState: object
  }
  
  // 核心方法
  async logRecoveryEvent(event) // 记录恢复事件
  async getRecoveryAuditTrail(recoveryId) // 获取恢复审计链
  async exportAuditLogs(startTime, endTime) // 导出审计日志
}
```

### 4.5 RecoveryHealthScoreCalculator 恢复健康评分计算器

```javascript
class RecoveryHealthScoreCalculator {
  // 评分维度（满分 100）
  scoreDimensions: {
    dataCompleteness: { weight: 30, description: '数据完整性' },
    crossServiceConsistency: { weight: 25, description: '跨服务一致性' },
    relationIntegrity: { weight: 20, description: '关系完整性' },
    cacheSyncRate: { weight: 15, description: '缓存同步率' },
    eventStreamComplete: { weight: 10, description: '事件流完整性' }
  }
  
  // 健康等级
  healthLevels: {
    EXCELLENT: { min: 90, color: 'green' },
    GOOD: { min: 75, color: 'yellow' },
    FAIR: { min: 50, color: 'orange' },
    POOR: { min: 0, color: 'red' }
  }
  
  // 核心方法
  async calculateCompletenessScore() // 计算完整性得分
  async calculateConsistencyScore() // 计算一致性得分
  async calculateOverallScore() // 计算总体健康得分
  async generateHealthReport() // 生成健康报告
}
```

## 5. 验收标准（可测试）

- [ ] 备份文件恢复后自动执行完整性校验（checksum 验证）
- [ ] 记录级校验：每条记录关键字段完整性检查覆盖率 100%
- [ ] 跨服务一致性检查：PostgreSQL + Redis 数据一致性检测正常
- [ ] 不一致数据自动修复：< 100 条记录自动修复成功率 > 95%
- [ ] 恢复审计日志：所有恢复操作记录完整，可追溯
- [ ] 恢复健康评分：恢复完成后自动生成健康评分报告
- [ ] 单元测试覆盖：校验器、修复引擎各 15+ 用例
- [ ] 集成测试：模拟恢复场景，验证完整流程

## 6. 工作量估算

L（Large）
- 需要设计多层次校验机制
- 跨服务一致性检查需要协调 PostgreSQL/Redis/Kafka
- 智能修复引擎需要多种修复策略
- 审计日志需要持久化存储

## 7. 优先级理由

P1 级别：
- 数据恢复后缺乏校验是生产环境的重大风险
- 恢复后数据不一致可能导致业务逻辑错误
- 自动修复机制可减少人工介入时间
- 对项目"生产可用"的容灾能力贡献显著