# REQ-00258：部署变更日志自动生成与发布说明系统

- **编号**：REQ-00258
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/shared/ChangelogGenerator.js、scripts、docs、admin-dashboard
- **创建时间**：2026-06-18 14:00
- **依赖需求**：REQ-00006（K8s 滚动更新与回滚自动化）

## 1. 背景与问题

当前 mineGo 项目采用 GitHub Actions 进行 CI/CD 自动化部署，但存在以下问题：

1. **版本发布缺乏透明度**：每次部署后，用户和开发者无法快速了解本次发布包含哪些变更
2. **CHANGELOG 维护成本高**：需要手动整理 commit 信息，容易遗漏或格式不一致
3. **发布说明质量参差不齐**：不同开发者编写的发布说明风格各异，缺乏结构化信息
4. **缺乏变更分类**：无法区分功能新增、Bug 修复、性能优化、安全修复等不同类型的变更
5. **版本关联不清晰**：commit 与发布版本、部署记录之间缺乏可追溯的关联

这导致用户难以了解新版本的价值，运维人员难以追踪问题引入的版本，开发者难以维护版本历史。

## 2. 目标

建立自动化的部署变更日志生成与发布说明系统：

1. **自动生成 CHANGELOG**：基于 conventional commits 规范自动生成结构化变更日志
2. **智能分类变更**：自动识别并分类 feat/fix/perf/refactor/docs/security 等变更类型
3. **发布说明模板化**：生成包含变更摘要、影响范围、升级指南的完整发布说明
4. **版本追溯**：建立 commit → version → deployment 的完整追溯链
5. **多渠道发布**：支持 GitHub Release、Slack/钉钉通知、管理后台展示

## 3. 范围

- **包含**：
  - Conventional Commits 规范校验与解析
  - CHANGELOG.md 自动生成与更新
  - GitHub Release 自动创建与发布
  - 发布说明模板引擎
  - 变更影响分析（涉及服务、数据库迁移、API 变更）
  - 版本号自动计算（语义化版本）
  - 发布通知多渠道推送

- **不包含**：
  - 人工发布说明编辑界面（后续需求）
  - 版本回滚操作（已有 REQ-00006 覆盖）
  - 用户端版本更新提示（前端需求）

## 4. 详细需求

### 4.1 Conventional Commits 规范

```javascript
// 变更类型定义
const CHANGE_TYPES = {
  feat: { title: '功能新增', emoji: '✨', bump: 'minor' },
  fix: { title: 'Bug 修复', emoji: '🐛', bump: 'patch' },
  perf: { title: '性能优化', emoji: '⚡', bump: 'patch' },
  refactor: { title: '代码重构', emoji: '♻️', bump: 'patch' },
  docs: { title: '文档更新', emoji: '📝', bump: null },
  test: { title: '测试相关', emoji: '✅', bump: null },
  security: { title: '安全修复', emoji: '🔒', bump: 'patch' },
  breaking: { title: '破坏性变更', emoji: '💥', bump: 'major' }
};

// Commit 格式校验
// 正确格式: feat(catch): add critical catch probability modifier
// 错误格式: add some feature (无类型前缀)
```

### 4.2 CHANGELOG 生成器

```javascript
// backend/shared/ChangelogGenerator.js
class ChangelogGenerator {
  constructor(options) {
    this.repoPath = options.repoPath;
    this.outputPath = options.outputPath || 'CHANGELOG.md';
    this.templatePath = options.templatePath;
  }

  // 获取两个版本之间的 commits
  async getCommitsBetween(fromTag, toTag) {
    // git log --pretty=format:"%H|%s|%b|%an|%ad" fromTag...toTag
  }

  // 解析 conventional commit
  parseCommit(commit) {
    // 匹配: type(scope): description
    // 提取: type, scope, description, breaking, issues
  }

  // 按类型分组
  groupByType(commits) {
    // { feat: [...], fix: [...], perf: [...], ... }
  }

  // 生成 Markdown 片段
  generateSection(type, commits) {
    // ### ✨ 功能新增
    // - add critical catch probability modifier ([#123](link))
  }

  // 生成完整版本段落
  generateVersionSection(version, date, commits) {
    // ## [1.2.0] - 2026-06-18
    // ### ✨ 功能新增
    // ...
  }

  // 更新 CHANGELOG.md
  async updateChangelog(newSection) {
    // 在文件开头插入新版本段落
  }
}
```

### 4.3 发布说明模板

```markdown
# Release v${version}

**发布时间**：${date}
**发布类型**：${releaseType}

## 📋 变更摘要

${summary}

## 🔄 变更详情

${changelogSection}

## 📦 涉及服务

${affectedServices}

## ⚠️ 升级注意事项

${upgradeNotes}

## 🔗 相关链接

- [完整变更日志](CHANGELOG.md)
- [GitHub Release](${releaseUrl})
- [CI/CD 构建记录](${buildUrl})
```

### 4.4 版本号计算

```javascript
// 语义化版本计算
function calculateNextVersion(currentVersion, commits) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  
  let bumpType = null;
  for (const commit of commits) {
    if (commit.breaking) bumpType = 'major';
    else if (commit.type === 'feat' && bumpType !== 'major') bumpType = 'minor';
    else if (['fix', 'perf', 'security'].includes(commit.type) && !bumpType) bumpType = 'patch';
  }
  
  switch (bumpType) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: return currentVersion; // 无需发布
  }
}
```

### 4.5 GitHub Actions 工作流

```yaml
# .github/workflows/release.yml
name: Generate Release

on:
  push:
    branches: [main]
    # 仅在 main 分支触发发布

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 获取完整历史
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Generate Changelog
        run: |
          node scripts/generate-changelog.js \
            --from $(git describe --tags --abbrev=0 HEAD^) \
            --to HEAD \
            --output CHANGELOG.md
      
      - name: Calculate Version
        id: version
        run: |
          VERSION=$(node scripts/calculate-version.js)
          echo "version=$VERSION" >> $GITHUB_OUTPUT
      
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: v${{ steps.version.outputs.version }}
          body_path: ./RELEASE_NOTES.md
          draft: false
          prerelease: false
      
      - name: Notify Release
        run: |
          node scripts/notify-release.js \
            --version ${{ steps.version.outputs.version }} \
            --webhook ${{ secrets.SLACK_WEBHOOK }}
```

### 4.6 变更影响分析

```javascript
// 分析变更涉及的服务和影响范围
async function analyzeImpact(commits) {
  const impact = {
    services: new Set(),
    migrations: [],
    apiChanges: [],
    breakingChanges: []
  };
  
  for (const commit of commits) {
    // 解析变更文件
    const files = await getCommitFiles(commit.hash);
    
    for (const file of files) {
      // 识别服务
      if (file.startsWith('backend/services/')) {
        impact.services.add(file.split('/')[2]);
      }
      
      // 识别数据库迁移
      if (file.startsWith('database/migrations/')) {
        impact.migrations.push(file);
      }
      
      // 识别 API 变更
      if (file.includes('routes/') || file.includes('controllers/')) {
        impact.apiChanges.push({ file, commit: commit.hash });
      }
    }
    
    // 收集破坏性变更
    if (commit.breaking) {
      impact.breakingChanges.push({
        description: commit.description,
        commit: commit.hash
      });
    }
  }
  
  return impact;
}
```

### 4.7 多渠道发布通知

```javascript
// 发布通知推送
class ReleaseNotifier {
  async notifyGitHubRelease(version, releaseNotes) {
    // 创建 GitHub Release（已在 workflow 中处理）
  }
  
  async notifySlack(version, summary, webhook) {
    const message = {
      text: `🚀 新版本发布: v${version}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🚀 mineGo v${version} 发布` }
        },
        {
          type: 'section',
          text: { type: 'markdown', text: summary }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '查看详情' },
              url: `https://github.com/kkcc2013-arch/mineGo/releases/tag/v${version}`
            }
          ]
        }
      ]
    };
    
    await fetch(webhook, {
      method: 'POST',
      body: JSON.stringify(message)
    });
  }
  
  async notifyAdminDashboard(version, releaseData) {
    // 写入 admin-dashboard 的发布历史表
    await db.query(`
      INSERT INTO release_history (version, released_at, notes, impact)
      VALUES ($1, NOW(), $2, $3)
    `, [version, releaseData.notes, releaseData.impact]);
  }
}
```

### 4.8 数据库表设计

```sql
-- 发布历史表
CREATE TABLE release_history (
  id SERIAL PRIMARY KEY,
  version VARCHAR(20) NOT NULL UNIQUE,
  released_at TIMESTAMP NOT NULL DEFAULT NOW(),
  release_type VARCHAR(20) NOT NULL, -- major/minor/patch
  notes TEXT NOT NULL,
  impact JSONB NOT NULL, -- { services: [], migrations: [], apiChanges: [] }
  github_release_url VARCHAR(255),
  created_by VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- commit 与版本关联表
CREATE TABLE commit_version_mapping (
  id SERIAL PRIMARY KEY,
  commit_hash VARCHAR(40) NOT NULL,
  commit_message TEXT NOT NULL,
  commit_type VARCHAR(20),
  commit_scope VARCHAR(50),
  version VARCHAR(20) NOT NULL REFERENCES release_history(version),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commit_version ON commit_version_mapping(version);
CREATE INDEX idx_commit_hash ON commit_version_mapping(commit_hash);
```

## 5. 验收标准（可测试）

- [ ] 提交符合 conventional commits 规范时，CHANGELOG.md 自动更新正确
- [ ] 不符合规范的提交会触发 CI 失败并给出明确的格式提示
- [ ] feat 类型提交触发 minor 版本号递增
- [ ] fix/perf/security 类型提交触发 patch 版本号递增
- [ ] 破坏性变更（feat! 或 BREAKING CHANGE）触发 major 版本号递增
- [ ] GitHub Release 自动创建，包含完整的发布说明
- [ ] 发布说明包含变更摘要、涉及服务、升级注意事项
- [ ] Slack/钉钉通知成功发送，包含版本号和关键变更
- [ ] 管理后台可查看历史发布记录和详情
- [ ] commit 与版本的关联关系可追溯查询
- [ ] 数据库迁移变更在发布说明中高亮提示

## 6. 工作量估算

**M（中等）**

理由：
- conventional commits 工具生态成熟（standard-version、conventional-changelog）
- 主要工作是集成和定制化模板
- 需要编写影响分析逻辑和多渠道通知
- 预计 2-3 天完成

## 7. 优先级理由

**P1 理由**：

1. **开发者体验**：自动化发布流程减少手动维护负担，提升开发效率
2. **用户透明度**：用户和运维人员可快速了解版本变更，建立信任
3. **问题追溯**：建立 commit → version → deployment 追溯链，便于问题定位
4. **项目成熟度**：成熟的生产项目应有规范的版本管理和发布说明
5. **依赖前置**：已有 REQ-00006（K8s 滚动更新）作为基础，本需求完善发布流程
