# REQ-00577：Node.js 堆内存智能管理与 GC 优化系统

- **编号**：REQ-00577
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/memoryManager, gateway, catch-service, gym-service, WebSocket 连接池
- **创建时间**：2026-07-16 17:00
- **依赖需求**：REQ-00329（WebSocket连接池）、REQ-00070（Redis内存分析）

## 1. 背景与问题

### 当前痛点

mineGo 后端采用 Node.js 20 运行时，承载 9 个微服务，主要性能瓶颈：

1. **堆内存碎片化严重**
   - WebSocket 连接池每 worker 维持 1000 个连接（见 `backend/shared/websocket/ConnectionPool.js`）
   - 大量小对象频繁创建/销毁（消息上下文、连接元数据、批处理队列）
   - 缺乏对象池复用机制，GC 压力大

2. **GC 停顿影响实时性**
   - gym-service 和 catch-service 处理高频实时战斗消息
   - Scavenge GC 每 10-30 秒触发，造成 10-50ms 延迟抖动
   - 缺乏 GC 监控和调优策略

3. **缺乏内存可视化**
   - 无法识别内存泄漏源头（对比 Redis 已有 `RedisMemoryAnalyzer`）
   - 生产环境 OOM 时缺乏诊断数据
   - 无法提前预警堆内存耗尽

### 代码证据

```javascript
// backend/shared/websocket/ConnectionPool.js:33-52
// 每个连接创建 ConnectionContext 对象，无对象池复用
const connectionContext = {
  id: connectionId,
  ws,
  userId,
  connectedAt: Date.now(),
  lastActivityAt: Date.now(),
  metadata: { deviceId, platform, version }
};
```

- 307 个共享模块加载到每个服务进程
- 批处理队列（`MessageBatchQueue.js`）频繁创建数组
- 缺少 `--max-old-space-size`、`--optimize-for-size` 等 V8 调优参数

## 2. 目标

1. **降低 GC 频率**：通过对象池和内存复用，减少 Young Generation GC 触发次数 40%
2. **缩短 GC 停顿**：调整 V8 参数，将 GC 停顿从 50ms 降到 < 10ms
3. **内存泄漏防护**：实现堆快照自动化分析，检测可疑内存增长模式
4. **可视化监控**：在 Grafana 中展示 Node.js 堆内存趋势和 GC 统计

## 3. 范围

### 包含

- **对象池系统**：为 WebSocket 连接上下文、消息队列等高频对象实现对象池
- **V8 参数调优**：为不同服务推荐最优启动参数（如 `--max-old-space-size=2048`）
- **堆内存监控**：集成 `v8.getHeapStatistics()` 和 `v8.getHeapSpaceStatistics()`
- **GC 统计导出**：通过 `perf_hooks` 导出 GC 持续时间和频次到 Prometheus
- **内存泄漏检测**：定期堆快照对比，识别持续增长的对象类型
- **健康检查集成**：在 `/health` 端点暴露内存健康状态

### 不包含

- 前端内存优化（属于 game-client）
- 数据库连接池内存管理（已由 REQ-00574 覆盖）
- Redis 内存优化（已由 REQ-00070 覆盖）

## 4. 详细需求

### 4.1 对象池系统（ObjectPool）

```javascript
// backend/shared/memoryManager/ObjectPool.js
class ObjectPool {
  constructor(factory, options = {}) {
    this.factory = factory; // 对象工厂函数
    this.maxSize = options.maxSize || 1000;
    this.pool = [];
  }
  
  acquire() { /* 从池中获取或新建 */ }
  release(obj) { /* 重置并归还池 */ }
  drain() { /* 清空池 */ }
}
```

**应用场景**：
- WebSocket 连接上下文（ConnectionContext）
- 消息批处理队列（MessageBatch）
- 日志格式化对象

### 4.2 堆内存监控器

```javascript
// backend/shared/memoryManager/HeapMonitor.js
class HeapMonitor {
  startSampling(intervalMs = 10000) {
    // 每 10 秒采集 v8.getHeapStatistics()
    // 导出 Prometheus 指标：
    // - nodejs_heap_size_total_bytes
    // - nodejs_heap_size_used_bytes
    // - nodejs_external_memory_bytes
  }
  
  takeSnapshot() {
    // 生成 .heapsnapshot 文件
    // 支持 Web UI 或 CLI 分析
  }
}
```

### 4.3 GC 统计收集

```javascript
// backend/shared/memoryManager/GCMetricsCollector.js
const { performance, setResourceTimingBufferSize } = require('perf_hooks');
const gcObserver = new performance.PerformanceObserver((list) => {
  const entries = list.getEntries();
  entries.forEach(entry => {
    metrics.gcDuration.observe({
      kind: entry.kind, // 'scavenge' | 'marksweep' | 'incremental'
      service: serviceName
    }, entry.duration);
  });
});
gcObserver.observe({ entryTypes: ['gc'] });
```

### 4.4 内存泄漏检测器

```javascript
// backend/shared/memoryManager/LeakDetector.js
class LeakDetector {
  async analyzeTrend(hoursBack = 24) {
    // 从 Prometheus 查询 nodejs_heap_size_used_bytes
    // 使用线性回归判断是否存在持续增长趋势
    // 返回：{ isLeaking: boolean, growthRate: number, suspectTypes: string[] }
  }
  
  async compareSnapshots(snapshot1, snapshot2) {
    // 对比两个堆快照，找出数量增长的对象类型
  }
}
```

### 4.5 V8 参数建议生成器

```javascript
// backend/shared/memoryManager/V8ConfigAdvisor.js
class V8ConfigAdvisor {
  generateRecommendations(serviceName, metrics) {
    // 根据 GC 频率和内存使用情况，推荐 V8 参数
    // 返回：
    // {
    //   maxOldSpaceSize: 2048,
    //   optimizeForSize: true,
    //   exposeGc: false,
    //   initialOldSpaceSize: 512,
    //   maxSemiSpaceSize: 64
    // }
  }
}
```

### 4.6 Gateway API 端点

```
GET /internal/memory/stats
  → { heapTotal, heapUsed, external, arrayBuffers, gcStats }

GET /internal/memory/snapshot
  → 触发堆快照，返回下载链接

GET /internal/memory/leak-check
  → { isLeaking, growthRate, suspectTypes, recommendations }
```

## 5. 验收标准（可测试）

- [ ] 实现对象池后，WebSocket 连接建立/销毁性能提升 30%（压测验证）
- [ ] GC 平均停顿时间 < 10ms（通过 Prometheus `nodejs_gc_duration_ms` 验证）
- [ ] 堆内存使用趋势可在 Grafana 面板可视化（包含 total/used/external 三条曲线）
- [ ] 内存泄漏检测能在 24 小时内识别出模拟的泄漏对象（测试用例验证）
- [ ] 所有服务启动时自动应用推荐 V8 参数（通过启动日志验证）
- [ ] `/internal/memory/stats` 端点返回完整堆统计和 GC 指标
- [ ] 单元测试覆盖率 ≥ 85%（对象池、监控器、泄漏检测器）
- [ ] 文档：V8 调优最佳实践指南

## 6. 工作量估算

**规模**：M（中等）

**理由**：
- 对象池系统：2 天
- 堆监控 + GC 指标：2 天
- 泄漏检测 + 快照分析：2 天
- API 端点 + 测试：1 天
- Grafana 面板 + 文档：1 天

**总计**：8 人天

## 7. 优先级理由

**P1（高优先级）**

1. **直接影响用户体验**：GC 停顿导致 WebSocket 消息延迟，影响实时战斗体验
2. **生产稳定性**：内存泄漏和 OOM 是生产环境最严重的问题之一
3. **横向依赖**：多个 P1 需求（REQ-00552 WebSocket 连接池、REQ-00574 数据库连接池）依赖内存稳定性
4. **技术债积累**：307 个共享模块长期缺乏内存管理，债务越积越重

与项目目标"生产可用"直接相关，属于关键基础设施。
