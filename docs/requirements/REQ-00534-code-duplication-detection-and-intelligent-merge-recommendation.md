# REQ-00534：代码重复检测与智能合并建议系统

- **编号**：REQ-00534
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/codeQuality/DuplicationDetector.js、backend/shared/codeQuality/MergeRecommender.js、所有后端服务、admin-dashboard、GitHub Actions
- **创建时间**：2026-07-11 07:00 UTC
- **依赖需求**：REQ-00516（代码复杂度度量与重构优先级智能推荐系统，已完成）

## 1. 背景与问题

mineGo 项目已积累 530+ 需求实现，后端包含 9 个微服务（gateway/user/location/pokemon/catch/gym/social/reward/payment），代码库规模持续增长。虽然 REQ-00516 已实现代码复杂度度量，但仍缺乏**专门的代码重复检测与消除机制**：

### 1.1 当前问题
1. **重复代码不可见**：多个服务存在相似的权限检查、数据验证、响应格式化逻辑，但缺乏自动化检测
2. **DRY 原则违反**：违反 Don't Repeat Yourself 原则，增加维护成本和 Bug 传播风险
3. **合并决策困难**：发现重复代码后，缺乏智能建议指导如何合并（提取共享模块、创建基类等）
4. **跨服务重复难以发现**：gateway/user-service/social-service/gym-service 等服务间的相似逻辑不易被察觉
5. **实时反馈缺失**：PR 阶段缺乏重复代码检测，新代码可能引入新的重复

### 1.2 当前代码现状分析
```javascript
// 示例：权限检查逻辑在多个服务重复
// user-service/src/middleware/auth.js
async function checkPermission(userId, resourceType, resourceId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  const permission = await Permission.findOne({ userId, resourceType });
  return permission && permission.resourceId === resourceId;
}

// social-service/src/middleware/auth.js（几乎相同）
async function checkPermission(userId, resourceType, resourceId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  const permission = await Permission.findOne({ userId, resourceType });
  return permission && permission.resourceId === resourceId;
}

// gym-service/src/middleware/auth.js（重复）
async function checkPermission(userId, resourceType, resourceId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  const permission = await Permission.findOne({ userId, resourceType });
  return permission && permission.resourceId === resourceId;
}
```

### 1.3 ApiClient.js 现状
`backend/shared/ApiClient.js` 有 488 行，是核心共享模块，但：
- 某些服务可能仍在使用独立的 axios 调用逻辑，未完全迁移到 ApiClient
- 需要检测哪些服务有重复的 HTTP 客户端逻辑

### 1.4 期望改进
构建代码重复检测与智能合并建议系统，支持：
- 自动检测跨文件、跨服务的代码重复片段
- 计算重复率指标和重复代码总量
- 智能推荐合并策略（提取共享模块、创建抽象基类、使用 Mixin 等）
- GitHub Actions PR 检查拦截新增重复代码
- Admin Dashboard 可视化重复代码热力图

## 2. 目标

1. **量化重复代码**：建立代码重复检测指标体系（重复片段数、重复行数、重复率）
2. **智能推荐**：基于重复片段的相似度、影响范围、修改频率推荐最佳合并策略
3. **实时拦截**：在 PR 阶段检测新增重复代码，自动标记并建议合并
4. **可视化**：在 Admin Dashboard 展示重复代码分布热力图和消除进度
5. **减少技术债**：通过持续检测和消除，将项目重复率控制在 5% 以内

## 3. 范围

### 包含
- 代码重复检测器：`DuplicationDetector`
- 合并策略推荐引擎：`MergeRecommender`
- 重复代码追踪器：`DuplicationTracker`
- GitHub Actions PR 检查钩子
- Admin Dashboard 可视化页面
- 数据库表存储重复检测结果

### 不包含
- 自动代码合并工具（如 IDE 插件）
- 代码风格检查（已有 ESLint）
- 代码复杂度分析（已有 REQ-00516 CodeComplexityAnalyzer）
- 第三方代码重复检测平台集成（如 CPD、PMD）

## 4. 详细需求

### 4.1 代码重复检测器

```javascript
// backend/shared/codeQuality/DuplicationDetector.js

const fs = require('fs').promises;
const path = require('path');

/**
 * 代码重复检测器
 * 使用 Token 序列化和哈希匹配检测重复片段
 */
class DuplicationDetector {
  constructor(options = {}) {
    this.minDuplicateLines = options.minDuplicateLines || 6;  // 最少 6 行才算重复
    this.minDuplicateTokens = options.minDuplicateTokens || 50; // 最少 50 tokens
    this.similarityThreshold = options.similarityThreshold || 0.85; // 85% 相似度阈值
    this.excludePatterns = options.excludePatterns || [
      'node_modules', '.git', 'test', 'spec', '__tests__'
    ];
  }

  /**
   * 检测指定目录的代码重复
   * @param {string} rootDir - 根目录路径
   * @returns {Object} - 重复检测结果
   */
  async detect(rootDir) {
    const files = await this.collectFiles(rootDir);
    const fileContents = await Promise.all(
      files.map(async (filePath) => ({
        path: filePath,
        content: await fs.readFile(filePath, 'utf-8')
      }))
    );

    // Tokenize 所有文件
    const tokenizedFiles = fileContents.map(({ path, content }) => ({
      path,
      tokens: this.tokenize(content),
      lines: content.split('\n').length
    }));

    // 检测重复片段
    const duplicates = this.findDuplicates(tokenizedFiles);

    // 计算重复率
    const summary = this.calculateSummary(files, duplicates);

    return {
      summary,
      duplicates,
      files: tokenizedFiles.map(f => ({
        path: f.path,
        lines: f.lines,
        duplicateLines: this.countDuplicateLinesInFile(f.path, duplicates)
      }))
    };
  }

  /**
   * Tokenize 代码内容（去除注释和空白）
   */
  tokenize(content) {
    // 移除单行和多行注释
    let cleaned = content
      .replace(/\/\/.*$/gm, '')          // 单行注释
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 多行注释
      .replace(/^\s*$/gm, '');            // 空行
    
    // Tokenize：标识符、关键字、操作符、字符串
    const tokens = [];
    const regex = /([a-zA-Z_$][a-zA-Z0-9_$]*)|(\d+\.?\d*)|("[^"]*"|'[^']*')|([{}()\[\];,.<>=!+\-*/%&|^~])/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      if (match[0]) {
        tokens.push({
          type: this.getTokenType(match),
          value: match[0],
          position: match.index
        });
      }
    }
    return tokens;
  }

  /**
   * 查找重复片段（使用哈希匹配）
   */
  findDuplicates(tokenizedFiles) {
    const duplicates = [];
    const hashMap = new Map();

    // 为每个文件生成 Token 序列哈希
    for (const file of tokenizedFiles) {
      const tokens = file.tokens;
      
      // 使用滑动窗口检测重复片段
      for (let windowSize = this.minDuplicateTokens; windowSize <= Math.min(tokens.length, 200); windowSize += 25) {
        for (let start = 0; start < tokens.length - windowSize; start += 5) {
          const window = tokens.slice(start, start + windowSize);
          const hash = this.hashTokens(window);
          
          if (!hashMap.has(hash)) {
            hashMap.set(hash, []);
          }
          hashMap.get(hash).push({
            file: file.path,
            startToken: start,
            endToken: start + windowSize,
            tokens: window
          });
        }
      }
    }

    // 找出哈希碰撞（重复片段）
    for (const [hash, locations] of hashMap) {
      if (locations.length > 1) {
        // 检查是否来自不同文件
        const uniqueFiles = [...new Set(locations.map(l => l.file))];
        if (uniqueFiles.length > 1) {
          duplicates.push({
            hash,
            similarity: 1.0, // 完全匹配
            locations,
            suggestedMerge: this.suggestMergeStrategy(locations)
          });
        }
      }
    }

    // 检测相似但非完全匹配的片段（使用 LCS 算法）
    const nearDuplicates = this.findNearDuplicates(tokenizedFiles);
    duplicates.push(...nearDuplicates);

    return duplicates.sort((a, b) => b.locations.length - a.locations.length);
  }

  /**
   * 查找相似但非完全匹配的片段
   */
  findNearDuplicates(tokenizedFiles) {
    const nearDuplicates = [];
    
    // 比较不同文件的 Token 序列
    for (let i = 0; i < tokenizedFiles.length; i++) {
      for (let j = i + 1; j < tokenizedFiles.length; j++) {
        const similarity = this.calculateSimilarity(
          tokenizedFiles[i].tokens,
          tokenizedFiles[j].tokens
        );
        
        if (similarity >= this.similarityThreshold) {
          nearDuplicates.push({
            hash: `sim_${i}_${j}`,
            similarity,
            locations: [
              { file: tokenizedFiles[i].path, startToken: 0, endToken: tokenizedFiles[i].tokens.length },
              { file: tokenizedFiles[j].path, startToken: 0, endToken: tokenizedFiles[j].tokens.length }
            ],
            suggestedMerge: this.suggestMergeStrategy([
              { file: tokenizedFiles[i].path },
              { file: tokenizedFiles[j].path }
            ])
          });
        }
      }
    }
    
    return nearDuplicates;
  }

  /**
   * 计算代码相似度（使用 Longest Common Subsequence）
   */
  calculateSimilarity(tokens1, tokens2) {
    const lcs = this.lcsLength(tokens1, tokens2);
    const maxLen = Math.max(tokens1.length, tokens2.length);
    return maxLen > 0 ? lcs / maxLen : 0;
  }

  /**
   * LCS 算法实现
   */
  lcsLength(arr1, arr2) {
    const m = arr1.length;
    const n = arr2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (arr1[i - 1].value === arr2[j - 1].value) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    
    return dp[m][n];
  }

  /**
   * 哈希 Token 序列
   */
  hashTokens(tokens) {
    const normalized = tokens.map(t => `${t.type}:${t.value}`).join('|');
    return require('crypto').createHash('md5').update(normalized).digest('hex');
  }

  /**
   * 计算汇总指标
   */
  calculateSummary(files, duplicates) {
    const totalLines = files.reduce((sum, f) => sum + (f.lines || 0), 0);
    const duplicateLines = duplicates.reduce((sum, dup) => {
      const avgLines = dup.locations[0].tokens ? 
        Math.floor(dup.locations[0].endToken - dup.locations[0].startToken / 5) : 
        this.minDuplicateLines;
      return sum + avgLines * (dup.locations.length - 1); // 只计算冗余部分
    }, 0);

    return {
      totalFiles: files.length,
      totalLines,
      duplicateLines,
      duplicationRate: totalLines > 0 ? (duplicateLines / totalLines * 100).toFixed(2) : 0,
      duplicateFragmentCount: duplicates.length,
      highSimilarityCount: duplicates.filter(d => d.similarity >= 0.9).length
    };
  }

  /**
   * 推荐合并策略
   */
  suggestMergeStrategy(locations) {
    const servicePattern = /services\/(\w+)-service/;
    const services = locations.map(l => {
      const match = l.file.match(servicePattern);
      return match ? match[1] : 'shared';
    });

    // 如果重复代码来自多个微服务，建议提取到 shared 模块
    const uniqueServices = [...new Set(services)];
    if (uniqueServices.length > 1 && !uniqueServices.includes('shared')) {
      return {
        strategy: 'extract_shared_module',
        targetPath: 'backend/shared/',
        description: '提取重复代码到 shared 共享模块',
        effort: 'M'
      };
    }

    // 如果来自同一个服务，建议提取到服务内的 utils
    if (uniqueServices.length === 1) {
      return {
        strategy: 'extract_service_utils',
        targetPath: `backend/services/${uniqueServices[0]}-service/src/utils/`,
        description: `提取到 ${uniqueServices[0]}-service 的 utils 目录`,
        effort: 'S'
      };
    }

    // 如果是中间件重复，建议创建共享中间件基类
    if (locations.every(l => l.file.includes('middleware'))) {
      return {
        strategy: 'create_base_middleware',
        targetPath: 'backend/shared/middleware/',
        description: '创建共享中间件基类',
        effort: 'M'
      };
    }

    return {
      strategy: 'manual_review',
      description: '需要人工审查后决定合并策略',
      effort: 'L'
    };
  }

  /**
   * 统计文件中的重复行数
   */
  countDuplicateLinesInFile(filePath, duplicates) {
    let count = 0;
    for (const dup of duplicates) {
      for (const loc of dup.locations) {
        if (loc.file === filePath) {
          count += Math.floor((loc.endToken - loc.startToken) / 5);
        }
      }
    }
    return count;
  }
}

module.exports = DuplicationDetector;
```

### 4.2 合并策略推荐引擎

```javascript
// backend/shared/codeQuality/MergeRecommender.js

/**
 * 合并策略推荐引擎
 * 基于重复检测结果和历史修改记录推荐最佳合并方案
 */
class MergeRecommender {
  constructor(pgPool) {
    this.pool = pgPool;
    this.strategies = {
      'extract_shared_module': {
        priority: 1,
        description: '提取到共享模块',
        template: '创建 backend/shared/{moduleName}.js'
      },
      'create_base_middleware': {
        priority: 2,
        description: '创建中间件基类',
        template: '创建 backend/shared/middleware/BaseMiddleware.js'
      },
      'extract_service_utils': {
        priority: 3,
        description: '提取到服务 utils',
        template: '创建 backend/services/{service}/src/utils/{utilName}.js'
      },
      'use_mixin_pattern': {
        priority: 4,
        description: '使用 Mixin 模式',
        template: '创建可复用的 Mixin 模块'
      }
    };
  }

  /**
   * 生成合并建议列表
   * @param {Object} duplicationResult - 重复检测结果
   * @param {Object} gitHistory - Git 修改历史
   * @returns {Array} - 合并建议列表
   */
  async generateMergeRecommendations(duplicationResult, gitHistory) {
    const recommendations = [];

    for (const duplicate of duplicationResult.duplicates) {
      // 获取涉及文件的修改频率
      const changeFrequency = await this.getChangeFrequency(
        duplicate.locations.map(l => l.file),
        gitHistory
      );

      // 计算合并优先级分数
      const priorityScore = this.calculatePriorityScore(
        duplicate,
        changeFrequency
      );

      // 只推荐优先级分数 > 0.5 的合并
      if (priorityScore > 0.5) {
        recommendations.push({
          duplicateId: duplicate.hash,
          similarity: duplicate.similarity,
          locations: duplicate.locations,
          suggestedStrategy: duplicate.suggestedMerge,
          priorityScore,
          changeFrequency,
          estimatedEffort: this.estimateEffort(duplicate),
          riskLevel: this.assessRisk(duplicate, gitHistory),
          implementationSteps: this.generateImplementationSteps(duplicate)
        });
      }
    }

    // 按优先级排序
    return recommendations.sort((a, b) => b.priorityScore - a.priorityScore);
  }

  /**
   * 计算合并优先级分数
   * 
   * 公式：score = similarity * 0.3 + frequency * 0.2 + impact * 0.3 + effortFactor * 0.2
   */
  calculatePriorityScore(duplicate, changeFrequency) {
    const similarity = duplicate.similarity;
    const avgFrequency = changeFrequency.avgChangesPerMonth || 0;
    const impact = duplicate.locations.length; // 影响的文件数量
    const effortFactor = duplicate.suggestedMerge.effort === 'S' ? 1.0 :
                         duplicate.suggestedMerge.effort === 'M' ? 0.8 : 0.5;

    return (similarity * 0.3) + 
           (Math.min(avgFrequency / 10, 1) * 0.2) + 
           (Math.min(impact / 5, 1) * 0.3) + 
           (effortFactor * 0.2);
  }

  /**
   * 获取文件修改频率（从 Git 历史）
   */
  async getChangeFrequency(filePaths, gitHistory) {
    // 查询 Git 历史（或从数据库缓存）
    const totalChanges = filePaths.reduce((sum, path) => {
      return sum + (gitHistory[path]?.changes || 0);
    }, 0);

    return {
      totalChanges,
      avgChangesPerMonth: totalChanges / Math.max(gitHistory.months || 6, 1),
      lastModified: filePaths.map(p => gitHistory[p]?.lastModified)
    };
  }

  /**
   * 估算合并工作量（小时）
   */
  estimateEffort(duplicate) {
    const baseEffort = {
      'S': 2,   // 小工作量：2 小时
      'M': 4,   // 中工作量：4 小时
      'L': 8    // 大工作量：8 小时
    };

    const effortHours = baseEffort[duplicate.suggestedMerge.effort] || 4;
    
    // 根据涉及文件数量调整
    return effortHours * Math.ceil(duplicate.locations.length / 3);
  }

  /**
   * 评估合并风险等级
   */
  assessRisk(duplicate, gitHistory) {
    // 高频修改的文件合并风险更高
    const avgFrequency = duplicate.locations.reduce((sum, loc) => {
      return sum + (gitHistory[loc.file]?.changesPerMonth || 0);
    }, 0) / duplicate.locations.length;

    if (avgFrequency > 5) {
      return 'high'; // 高风险：需要详细测试计划
    } else if (avgFrequency > 2) {
      return 'medium'; // 中风险：需要基础测试
    } else {
      return 'low'; // 低风险：可快速合并
    }
  }

  /**
   * 生成分步实施计划
   */
  generateImplementationSteps(duplicate) {
    const strategy = duplicate.suggestedMerge.strategy;
    const steps = [];

    switch (strategy) {
      case 'extract_shared_module':
        steps.push(
          '1. 创建 backend/shared/{新模块名}.js',
          '2. 复制重复代码到新模块，添加导出函数',
          '3. 修改所有使用处 require 新模块',
          '4. 运行测试验证功能不变',
          '5. 删除原位置的重复代码',
          '6. 提交代码并更新文档'
        );
        break;

      case 'create_base_middleware':
        steps.push(
          '1. 创建 backend/shared/middleware/BaseMiddleware.js',
          '2. 定义共享的中间件逻辑',
          '3. 各服务中间件继承 BaseMiddleware',
          '4. 运行中间件测试验证',
          '5. 清理服务内的重复逻辑',
          '6. 提交并添加单元测试'
        );
        break;

      case 'extract_service_utils':
        steps.push(
          '1. 创建服务内 utils 目录',
          '2. 提取重复逻辑到 utils 文件',
          '3. 服务内模块引用新 utils',
          '4. 运行服务测试',
          '5. 清理重复代码',
          '6. 提交代码'
        );
        break;

      default:
        steps.push(
          '1. 人工审查重复代码',
          '2. 确定合并策略',
          '3. 实施合并',
          '4. 测试验证',
          '5. 提交代码'
        );
    }

    return steps;
  }
}

module.exports = MergeRecommender;
```

### 4.3 重复代码追踪器

```javascript
// backend/shared/codeQuality/DuplicationTracker.js

/**
 * 重复代码追踪器
 * 保存重复检测结果，追踪消除进度
 */
class DuplicationTracker {
  constructor(pgPool) {
    this.pool = pgPool;
  }

  /**
   * 保存检测结果快照
   */
  async saveSnapshot(detectionResult) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 插入快照记录
      const snapshotResult = await client.query(`
        INSERT INTO code_duplication_snapshots (
          snapshot_date, total_files, total_lines, duplicate_lines,
          duplication_rate, duplicate_fragment_count, high_similarity_count
        ) VALUES (NOW(), $1, $2, $3, $4, $5, $6) RETURNING id
      `, [
        detectionResult.summary.totalFiles,
        detectionResult.summary.totalLines,
        detectionResult.summary.duplicateLines,
        detectionResult.summary.duplicationRate,
        detectionResult.summary.duplicateFragmentCount,
        detectionResult.summary.highSimilarityCount
      ]);

      const snapshotId = snapshotResult.rows[0].id;

      // 保存重复片段详情
      for (const duplicate of detectionResult.duplicates) {
        await client.query(`
          INSERT INTO code_duplication_fragments (
            snapshot_id, hash, similarity, locations, suggested_strategy,
            priority_score, estimated_effort_hours, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        `, [
          snapshotId,
          duplicate.hash,
          duplicate.similarity,
          JSON.stringify(duplicate.locations),
          duplicate.suggestedMerge.strategy,
          duplicate.priorityScore || 0.5,
          duplicate.suggestedMerge.effortHours || 4
        ]);
      }

      await client.query('COMMIT');
      return snapshotId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取趋势数据（最近 N 个快照）
   */
  async getTrend(limit = 10) {
    const result = await this.pool.query(`
      SELECT 
        snapshot_date, total_files, total_lines, duplicate_lines,
        duplication_rate, duplicate_fragment_count, high_similarity_count
      FROM code_duplication_snapshots
      ORDER BY snapshot_date DESC
      LIMIT $1
    `, [limit]);

    return result.rows.reverse(); // 按时间升序返回
  }

  /**
   * 标记重复片段已消除
   */
  async markAsResolved(fragmentId) {
    await this.pool.query(`
      UPDATE code_duplication_fragments
      SET status = 'resolved', resolved_at = NOW()
      WHERE id = $1
    `, [fragmentId]);

    // 更新最新快照的统计
    await this.updateLatestSnapshotStats();
  }

  /**
   * 获取待处理的重复片段列表
   */
  async getPendingFragments(limit = 20) {
    const result = await this.pool.query(`
      SELECT 
        id, hash, similarity, locations, suggested_strategy,
        priority_score, estimated_effort_hours, created_at
      FROM code_duplication_fragments
      WHERE status = 'pending'
      ORDER BY priority_score DESC, similarity DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  }
}

module.exports = DuplicationTracker;
```

### 4.4 数据库迁移

```sql
-- migrations/code_duplication_tables.sql

-- 重复检测结果快照表
CREATE TABLE code_duplication_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date TIMESTAMP NOT NULL,
  total_files INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  duplicate_lines INTEGER NOT NULL,
  duplication_rate DECIMAL(5, 2) NOT NULL,
  duplicate_fragment_count INTEGER NOT NULL,
  high_similarity_count INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 重复片段详情表
CREATE TABLE code_duplication_fragments (
  id SERIAL PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES code_duplication_snapshots(id),
  hash VARCHAR(64) NOT NULL,
  similarity DECIMAL(5, 3) NOT NULL,
  locations JSONB NOT NULL,
  suggested_strategy VARCHAR(50) NOT NULL,
  priority_score DECIMAL(5, 3) NOT NULL,
  estimated_effort_hours INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_duplication_snapshots_date ON code_duplication_snapshots(snapshot_date);
CREATE INDEX idx_duplication_fragments_status ON code_duplication_fragments(status);
CREATE INDEX idx_duplication_fragments_priority ON code_duplication_fragments(priority_score DESC);
```

### 4.5 GitHub Actions PR 检查

```yaml
# .github/workflows/duplication-check.yml

name: Code Duplication Check

on:
  pull_request:
    branches: [main, develop]

jobs:
  check-duplication:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: cd backend && npm install
      
      - name: Run duplication detection
        id: duplication
        run: |
          cd backend
          node shared/codeQuality/runDuplicationCheck.js --changed-files-only
      
      - name: Comment on PR
        if: steps.duplication.outputs.has_new_duplicates == 'true'
        uses: actions/github-script@v6
        with:
          script: |
            const duplicates = JSON.parse(process.env.NEW_DUPLICATES);
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## ⚠️ 代码重复检测警告
            
            发现新的代码重复片段：
            
            ${duplicates.map(d => `
            - **文件**: ${d.locations.join(', ')}
            - **相似度**: ${d.similarity}%
            - **建议**: ${d.suggestedMerge.description}
            `).join('\n')}
            
            建议合并重复代码以遵循 DRY 原则。`
            });
        env:
          NEW_DUPLICATES: ${{ steps.duplication.outputs.new_duplicates }}
```

## 5. 验收标准（可测试）

- [ ] `DuplicationDetector.detect()` 成功检测指定目录的代码重复片段
- [ ] Token 序列化和哈希匹配正确识别完全相同的代码片段
- [ ] LCS 算法正确计算相似度，相似度阈值 ≥ 85% 的片段被标记
- [ ] `MergeRecommender.generateMergeRecommendations()` 返回按优先级排序的合并建议
- [ ] 优先级分数计算正确（基于相似度、修改频率、影响范围、工作量）
- [ ] `DuplicationTracker.saveSnapshot()` 成功保存检测结果到数据库
- [ ] `DuplicationTracker.getTrend()` 返回重复率趋势数据
- [ ] GitHub Actions 工作流在 PR 中自动检测新增重复代码并评论
- [ ] Admin Dashboard 展示重复代码热力图和消除进度
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L - 大工作量**
- DuplicationDetector 检测器：4 小时（Token 序列化、哈希匹配、LCS 算法）
- MergeRecommender 推荐引擎：3 小时
- DuplicationTracker 追踪器：2 小时
- 数据库迁移与模型：1 小时
- GitHub Actions 集成：2 小时
- Admin Dashboard 页面：3 小时（热力图、趋势图）
- 单元测试：4 小时

总计约 19 小时，需 2-3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **DRY 原则保障**：代码重复是技术债的重要来源，消除重复可降低维护成本和 Bug 传播风险
2. **补充 REQ-00516**：复杂度度量已实现，重复检测是其重要补充，完善代码质量度量体系
3. **跨服务治理**：9 个微服务间存在大量相似逻辑（权限检查、数据验证等），需要专门工具检测
4. **实时拦截**：PR 阶段检测可防止新代码引入新的重复，从源头控制技术债
5. **成熟度提升**：完成后"文档与开发者体验"维度可进一步提升，技术债管理能力增强

此需求是项目长期健康发展的必要保障，与 REQ-00516 形成完整的代码质量度量体系。