# REQ-00222：CI/CD 构建缓存优化与依赖供应链安全验证系统

- **编号**：REQ-00222
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend、frontend、scripts、npm/yarn
- **创建时间**：2026-06-15 15:00
- **依赖需求**：REQ-00042

## 1. 背景与问题

当前 CI/CD 流水线（ci-cd.yml）每次构建都从零开始安装依赖，导致：
- 构建时间过长（每次 npm install 约 3-5 分钟）
- GitHub Actions 分钟消耗高，成本增加
- 依赖供应链缺乏完整性验证（仅 npm audit，无 lockfile 完整性检查）
- 未使用 GitHub Actions 缓存机制，重复下载相同依赖

此外，供应链安全事件频发（如 event-stream 投毒），需要：
- 验证 package-lock.json 完整性
- 检测依赖版本漂移
- 阻止已知恶意包

## 2. 目标

- CI 构建时间减少 40% 以上（通过依赖缓存）
- 建立依赖供应链安全验证机制
- 阻止未授权依赖变更进入生产
- 降低 GitHub Actions 运行成本

## 3. 范围

- **包含**：
  - GitHub Actions 依赖缓存配置
  - package-lock.json 完整性验证脚本
  - 依赖版本漂移检测
  - 已知恶意包黑名单检查
  - 构建时间监控与报告

- **不包含**：
  - 私有 npm 仓库配置
  - 依赖许可证合规检查（已有其他需求）
  - 前端构建产物缓存（后续优化）

## 4. 详细需求

### 4.1 GitHub Actions 缓存配置

```yaml
# 在 ci-cd.yml 中添加依赖缓存
- name: Setup Node.js with cache
  uses: actions/setup-node@v4
  with:
    node-version: ${{ env.NODE_VERSION }}
    cache: 'npm'
    cache-dependency-path: |
      backend/package-lock.json
      backend/services/*/package-lock.json

- name: Cache npm global
  uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-global-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-npm-global-
```

### 4.2 依赖完整性验证脚本

创建 `scripts/verify-dependencies.js`：

```javascript
/**
 * 依赖供应链安全验证
 * 1. package-lock.json 完整性检查
 * 2. 依赖版本漂移检测
 * 3. 恶意包黑名单检查
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 已知恶意包黑名单（来源：npm security advisories, Snyk）
const MALICIOUS_PACKAGES = [
  'event-stream', // 历史投毒事件
  'flatmap-stream',
  'npmlibs',
  'crossenv',
  // 可从 https://github.com/nodejs/security-wg 获取最新列表
];

function verifyPackageLock() {
  const lockPath = path.join(__dirname, '../backend/package-lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error('package-lock.json not found');
  }
  
  const lockfile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  
  // 检查 lockfileVersion
  if (lockfile.lockfileVersion < 2) {
    console.warn('⚠️  lockfileVersion < 2, consider upgrading npm');
  }
  
  // 验证每个依赖的 integrity
  let invalidCount = 0;
  for (const [name, info] of Object.entries(lockfile.packages || {})) {
    if (name === '') continue; // 根目录
    
    // 检查恶意包
    const pkgName = name.replace(/^node_modules\//, '');
    if (MALICIOUS_PACKAGES.includes(pkgName)) {
      throw new Error(`🚫 Malicious package detected: ${pkgName}`);
    }
    
    // 检查 integrity 字段
    if (info.resolved && !info.integrity && !info.link) {
      console.warn(`⚠️  No integrity for: ${name}`);
      invalidCount++;
    }
  }
  
  if (invalidCount > 10) {
    throw new Error(`Too many packages without integrity: ${invalidCount}`);
  }
  
  console.log(`✅ Verified ${Object.keys(lockfile.packages || {}).length} packages`);
}

function detectVersionDrift() {
  try {
    const result = execSync('npm ls --json --depth=0', { 
      cwd: path.join(__dirname, '../backend'),
      encoding: 'utf8' 
    });
    const actual = JSON.parse(result);
    
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../backend/package.json'), 'utf8')
    );
    
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    
    for (const [name, expected] of Object.entries(deps)) {
      const installed = actual.dependencies?.[name]?.version;
      if (!installed) {
        console.warn(`⚠️  Missing dependency: ${name}`);
      }
    }
    
    console.log('✅ No version drift detected');
  } catch (err) {
    console.warn('⚠️  Version drift check failed:', err.message);
  }
}

// 主函数
function main() {
  console.log('🔍 Verifying dependency supply chain...\n');
  
  verifyPackageLock();
  detectVersionDrift();
  
  console.log('\n✅ Dependency verification passed');
}

main();
```

### 4.3 CI 流水线集成

在 `.github/workflows/ci-cd.yml` 的 test job 中添加：

```yaml
- name: Verify dependency supply chain
  run: node scripts/verify-dependencies.js
  
- name: Check for outdated dependencies
  run: |
    cd backend
    npm outdated || true  # 不阻断，仅报告
```

### 4.4 构建时间监控

在 workflow 中添加 timing 报告：

```yaml
- name: Report build timing
  if: always()
  run: |
    echo "## Build Timing Report" >> $GITHUB_STEP_SUMMARY
    echo "| Step | Duration |" >> $GITHUB_STEP_SUMMARY
    echo "|------|----------|" >> $GITHUB_STEP_SUMMARY
    # 由 GitHub Actions 自动填充
```

## 5. 验收标准（可测试）

- [ ] CI 流水线使用 GitHub Actions 缓存，缓存命中率 > 80%
- [ ] `npm install` 时间减少 40% 以上（从 ~3min 降至 ~1.5min）
- [ ] `scripts/verify-dependencies.js` 在 CI 中运行并通过
- [ ] 恶意包黑名单检测生效，能阻断已知恶意包
- [ ] package-lock.json 完整性验证覆盖所有生产依赖
- [ ] 构建时间报告在 GitHub Actions Summary 中展示
- [ ] 依赖版本漂移检测能发现未同步的 package.json 变更

## 6. 工作量估算

**M（中等）**

理由：
- GitHub Actions 缓存配置简单，约 1-2 小时
- 依赖验证脚本约 2-3 小时
- CI 集成测试约 1 小时
- 总计约 4-6 小时

## 7. 优先级理由

**P1 理由**：
1. **成本影响**：每次 CI 运行约消耗 10-15 分钟，按月度 500 次运行计算，缓存可节省显著成本
2. **安全风险**：供应链攻击是当前主要威胁之一，缺乏验证是安全隐患
3. **开发效率**：构建时间长影响开发者体验和迭代速度
4. **生产就绪**：这是生产级 CI/CD 的必备能力
