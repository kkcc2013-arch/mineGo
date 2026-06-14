# REQ-00193：消除 console.log 与统一结构化日志使用

- **编号**：REQ-00193
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、location-service、user-service、backend/shared/logger.js
- **创建时间**：2026-06-14 11:00
- **依赖需求**：REQ-00002

## 1. 背景与问题

项目在 REQ-00002 中已引入统一的结构化日志系统（backend/shared/logger.js），使用 Pino 实现高性能 JSON 格式日志。但当前仍存在混合日志方式：

**gym-service/src/index.js**：
```javascript
console.log(`[Raid WS] User ${userId} joined raid ${raidId}`);
console.error('[Raid WS] Message error', e);
console.log(`[gym-service] listening on :${PORT}`);
```

**location-service/src/index.js**：
```javascript
console.error('[Spawn] Error for point', pt.id, err.message);
console.log(`[Spawn] Cycle complete: ${spawned} new spawns`);
console.error('[Cache] Redis error, fallback to DB:', err.message);
```

**问题**：
1. **日志格式不一致**：部分日志是 JSON 结构化（logger），部分是文本格式（console）
2. **日志聚合困难**：混合日志难以在 Grafana Loki/Elasticsearch 中统一检索
3. **缺乏上下文**：console.log 不支持 requestId、userId 等上下文追踪
4. **无法控制级别**：console 输出不受 LOG_LEVEL 环境变量控制
5. **生产环境混乱**：调试日志混杂在正式日志中

## 2. 目标

- 完全消除 backend/services 中的 console.log/console.error/console.warn 使用
- 所有日志统一使用 logger.info/logger.error/logger.warn/logger.debug
- 确保 WebSocket 消息、定时任务、启动日志均使用结构化格式
- 保持日志上下文一致性（requestId、userId、service 等）

## 3. 范围

- **包含**：
  - gym-service 中 3 处 console 日志替换
  - location-service 中 4 处 console 日志替换
  - user-service 中 2 处 console 日志替换
  - 添加 WebSocket 连接的结构化日志
  - 添加 spawn cycle 的结构化日志
  - 编写日志一致性检查脚本

- **不包含**：
  - frontend/game-client 的日志（浏览器环境）
  - backend/tests 的测试日志（测试专用）
  - backend/shared 调试日志（开发调试）

## 4. 详细需求

### 4.1 gym-service 日志替换

**WebSocket 连接日志**：
```javascript
// 替换前
console.log(`[Raid WS] User ${userId} joined raid ${raidId}`);

// 替换后
logger.info({
  event: 'RAID_WS_JOIN',
  userId,
  raidId,
  participants: raidRooms.get(raidId).size
}, 'User joined raid WebSocket');
```

**WebSocket 错误日志**：
```javascript
// 替换前
console.error('[Raid WS] Message error', e);

// 替换后
logger.error({
  err: e,
  userId: ws.userId,
  raidId: ws.raidId
}, 'WebSocket message error');
```

**启动日志**：
```javascript
// 替换前
console.log(`[gym-service] listening on :${PORT}`);

// 替换后
logger.info({
  port: PORT,
  pid: process.pid,
  nodeVersion: process.version
}, 'gym-service started');
```

### 4.2 location-service 日志替换

**Spawn 错误日志**：
```javascript
// 替换前
console.error('[Spawn] Error for point', pt.id, err.message);

// 替换后
logger.error({
  err,
  spawnPointId: pt.id,
  spawnPointCoords: { lat: pt.lat, lng: pt.lng }
}, 'Spawn point processing error');
```

**Spawn 完成日志**：
```javascript
// 替换前
console.log(`[Spawn] Cycle complete: ${spawned} new spawns`);

// 替换后
logger.info({
  event: 'SPAWN_CYCLE_COMPLETE',
  spawnedCount: spawned,
  durationMs: cycleDuration
}, 'Spawn cycle completed');
```

**Redis 缓存错误日志**：
```javascript
// 替换前
console.error('[Cache] Redis error, fallback to DB:', err.message);

// 替换后
logger.warn({
  err,
  operation: 'geo_radius',
  fallback: 'database'
}, 'Redis cache fallback to database');
```

### 4.3 日志一致性检查脚本

创建 `backend/scripts/check-logging-consistency.js`：
```javascript
/**
 * 检查 services 目录中是否存在 console.log/console.error/console.warn
 */
const fs = require('fs');
const path = require('path');

const servicesDir = path.join(__dirname, '../services');
const violations = [];

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  lines.forEach((line, idx) => {
    if (line.match(/console\.(log|error|warn|info|debug)\(/) && 
        !line.includes('// console.') &&
        !line.includes('/* console.')) {
      violations.push({
        file: filePath,
        line: idx + 1,
        content: line.trim()
      });
    }
  });
}

// 递归扫描所有服务
function scanDir(dir) {
  fs.readdirSync(dir).forEach(item => {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      scanDir(fullPath);
    } else if (item.endsWith('.js') && !item.includes('.test.')) {
      scanFile(fullPath);
    }
  });
}

scanDir(servicesDir);

if (violations.length > 0) {
  console.error('Logging consistency violations found:');
  violations.forEach(v => {
    console.error(`  ${v.file}:${v.line} - ${v.content}`);
  });
  process.exit(1);
} else {
  console.log('✅ All services use structured logging');
  process.exit(0);
}
```

## 5. 验收标准（可测试）

- [ ] gym-service 中 0 处 console.log/console.error/console.warn
- [ ] location-service 中 0 处 console.log/console.error/console.warn
- [ ] user-service 中 0 处 console.log/console.error/console.warn（仅启动日志）
- [ ] 所有日志包含 service 字段
- [ ] WebSocket 日志包含 userId 和 raidId
- [ ] Spawn 日志包含 spawnPointId
- [ ] 日志级别正确（info/error/warn）
- [ ] 运行 `npm run check-logging` 无违规
- [ ] 集成测试日志格式正确（JSON）
- [ ] Grafana Loki 可正常查询所有日志

## 6. 工作量估算

**S（小）** - 仅需替换约 10 处 console 日志，每处替换简单直接，主要是理解上下文和选择正确的日志级别。

## 7. 优先级理由

这是 P1 级别的技术债修复：
1. **影响可观测性**：混合日志破坏日志聚合系统的有效性
2. **生产环境风险**：无法统一控制日志级别和输出
3. **已有基础设施**：REQ-00002 已实现结构化日志，只需补充使用
4. **快速修复**：工作量小，风险低，收益明显
5. **日志质量提升**：统一后便于故障排查和性能分析