# REQ-00509: CI/CD 缓存智能管理与优化系统

- **编号**：REQ-00509
- **类别**：运维/CICD
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/shared/cacheManager、infrastructure/cache
- **创建时间**：2026-07-08 17:00
- **依赖需求**：无

## 1. 背景与问题

当前项目的 CI/CD 流程中存在多个缓存相关痛点：

1. **缓存命中率低**：GitHub Actions 缓存策略分散在各工作流中，node_modules、Docker layer、测试覆盖率报告等缓存缺乏统一管理，导致缓存键值设计不合理，命中率偏低。

2. **缓存过期无自动清理**：缓存文件随着依赖版本更新可能失效，但缺乏自动清理机制，导致存储空间浪费和潜在的构建异常。

3. **缺乏缓存性能分析**：无法量化评估缓存对构建速度的提升效果，难以优化缓存策略。

4. **跨工作流缓存共享不足**：相同依赖在不同工作流中重复下载，浪费带宽和时间。

参考代码：
- `.github/workflows/ci-cd.yml` 中使用 `actions/cache` 但键值分散
- 各工作流独立配置缓存，无复用机制

## 2. 目标

建立统一的 CI/CD 缓存智能管理系统，实现：

- 缓存键值统一设计，提升命中率至 85%+
- 缓存生命周期自动管理，过期缓存自动清理
- 缓存性能可视化分析，支持缓存策略优化决策
- 跨工作流缓存共享，减少重复下载

## 3. 范围

### 包含
- GitHub Actions 缓存策略统一配置模块
- 缓存命中率统计与分析服务
- 缓存键值生成器（基于 package-lock.json、Dockerfile 等依赖指纹）
- 缓存清理策略引擎（LRU + 过期时间 + 手动标记）
- Admin Dashboard 缓存管理界面

### 不包含
- 本地开发环境缓存管理
- 生产环境 Redis 缓存管理（已有独立模块）
- 第三方 CDN 缓存管理

## 4. 详细需求

### 4.1 缓存键值统一设计

```yaml
# 缓存键命名规范
cache-keys:
  node-modules:
    pattern: "nm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}"
    restore-keys: |
      nm-${{ runner.os }}-
      nm-
    path: |
      ~/.npm
      **/node_modules
  
  docker-layers:
    pattern: "dl-${{ runner.os }}-${{ hashFiles('**/Dockerfile', 'backend/package-lock.json') }}"
    restore-keys: |
      dl-${{ runner.os }}-
    path: /tmp/.buildx-cache
  
  test-coverage:
    pattern: "tc-${{ github.sha }}"
    restore-keys: "tc-${{ github.ref }}-"
    path: coverage/
```

### 4.2 缓存管理服务 (backend/shared/cacheManager)

```javascript
// CacheManager.js
class CacheManager {
  // 缓存注册
  async registerCache(key, metadata) { ... }
  
  // 缓存命中记录
  async recordHit(key, size, duration) { ... }
  
  // 缓存未命中记录
  async recordMiss(key, reason) { ... }
  
  // 缓存分析报告
  async generateReport(timeRange) { ... }
  
  // 缓存清理
  async evictCache(strategy) { ... }
}

// CacheKeyGenerator.js
class CacheKeyGenerator {
  // 基于 package-lock.json 生成指纹
  async generateNpmFingerprint(workDir) { ... }
  
  // 基于 Dockerfile + 依赖生成指纹
  async generateDockerFingerprint(dockerfile, lockFile) { ... }
  
  // 基于代码变更生成增量键
  async generateIncrementalKey(baseKey, changedFiles) { ... }
}

// CacheAnalyzer.js
class CacheAnalyzer {
  // 计算命中率
  async calculateHitRate(key, timeRange) { ... }
  
  // 分析缓存大小分布
  async analyzeSizeDistribution() { ... }
  
  // 识别冷缓存
  async identifyColdCaches(thresholdDays) { ... }
}
```

### 4.3 GitHub Actions 集成

```yaml
# .github/workflows/cache-management.yml
name: Cache Management

on:
  schedule:
    - cron: '0 0 * * 0'  # 每周日运行
  workflow_dispatch:

jobs:
  cache-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Analyze cache hit rate
        run: node scripts/analyze-cache.js
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Evict cold caches
        run: node scripts/evict-cache.js --days=30 --dry-run
      
      - name: Generate cache report
        run: node scripts/cache-report.js > cache-report.md
      
      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: cache-report
          path: cache-report.md
```

### 4.4 数据库设计

```sql
-- 缓存记录表
CREATE TABLE cicd_cache_records (
  id SERIAL PRIMARY KEY,
  cache_key VARCHAR(255) NOT NULL UNIQUE,
  cache_type VARCHAR(50) NOT NULL,  -- npm, docker, coverage
  size_bytes BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  last_hit_at TIMESTAMP,
  hit_count INTEGER DEFAULT 0,
  miss_count INTEGER DEFAULT 0,
  workflow_name VARCHAR(100),
  branch VARCHAR(100),
  metadata JSONB
);

-- 缓存统计表
CREATE TABLE cicd_cache_stats (
  id SERIAL PRIMARY KEY,
  stat_date DATE NOT NULL UNIQUE,
  total_caches INTEGER,
  total_size_bytes BIGINT,
  total_hits INTEGER,
  total_misses INTEGER,
  hit_rate DECIMAL(5,2),
  avg_restore_time_ms INTEGER
);

-- 索引
CREATE INDEX idx_cache_key ON cicd_cache_records(cache_key);
CREATE INDEX idx_cache_type ON cicd_cache_records(cache_type);
CREATE INDEX idx_last_hit ON cicd_cache_records(last_hit_at);
```

### 4.5 API 接口

```
GET  /api/admin/cache/stats        - 获取缓存统计
GET  /api/admin/cache/list         - 获取缓存列表
GET  /api/admin/cache/report       - 获取详细分析报告
POST /api/admin/cache/evict        - 手动清理缓存
POST /api/admin/cache/warm         - 预热缓存
```

## 5. 验收标准（可测试）

- [ ] 所有工作流统一使用 CacheKeyGenerator 生成缓存键
- [ ] 缓存命中率 ≥ 85%（基于最近 30 天统计数据）
- [ ] 冷缓存（>30 天未使用）自动清理机制就绪
- [ ] Admin Dashboard 显示缓存管理界面，包含：
  - 缓存命中率趋势图（按周）
  - 缓存大小分布饼图
  - 冷缓存列表及清理操作
- [ ] 缓存分析报告自动生成并归档
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] GitHub Actions 工作流缓存步骤减少 30%+ 下载时间

## 6. 工作量估算

**L (Large)** - 需要修改多个工作流、创建新的共享模块、设计数据库表、实现管理界面。预计 3-5 个工作日。

## 7. 优先级理由

P2 理由：
- 不影响核心业务功能
- 但对开发效率和 CI 资源成本有显著影响
- 当前缓存管理分散，优化后可节省 CI 运行时间和存储成本
- 属于"好上加好"的运维改进，非紧急需求
