# 贡献指南

感谢您考虑为 mineGo 做贡献！

## 📋 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发流程](#开发流程)
- [代码规范](#代码规范)
- [提交规范](#提交规范)
- [测试要求](#测试要求)
- [代码审查](#代码审查)
- [问题反馈](#问题反馈)

## 行为准则

本项目采用 [贡献者公约](CODE_OF_CONDUCT.md) 作为行为准则。参与本项目即表示您同意遵守其条款。

## 如何贡献

### 报告 Bug

1. 检查 [Issues](https://github.com/kkcc2013-arch/mineGo/issues) 是否已有相同问题
2. 如果没有，创建新 Issue，包含：
   - 清晰的标题和描述
   - 复现步骤
   - 期望行为和实际行为
   - 环境信息（Node.js 版本、操作系统等）
   - 相关日志或截图

### 提出新功能

1. 创建 Issue 描述功能需求
2. 说明功能的使用场景和价值
3. 等待维护者反馈后再开始实现

### 提交代码

1. Fork 本仓库
2. 创建功能分支
3. 编写代码和测试
4. 提交 Pull Request

## 开发流程

### 1. Fork 和 Clone

```bash
# Fork 后 clone 你的仓库
git clone https://github.com/YOUR_USERNAME/mineGo.git
cd mineGo

# 添加上游仓库
git remote add upstream https://github.com/kkcc2013-arch/mineGo.git
```

### 2. 同步上游

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

### 3. 创建分支

```bash
# 功能分支
git checkout -b feature/your-feature-name

# 修复分支
git checkout -b fix/bug-description

# 文档分支
git checkout -b docs/documentation-update
```

分支命名规范：
- `feature/` - 新功能
- `fix/` - Bug 修复
- `docs/` - 文档更新
- `refactor/` - 代码重构
- `test/` - 测试相关
- `chore/` - 其他杂项

### 4. 开发和测试

```bash
# 安装依赖
cd backend
npm install

# 启动开发环境
npm run dev

# 运行测试
npm test

# 运行 lint
npm run lint

# 自动修复 lint 问题
npm run lint:fix
```

### 5. 提交代码

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<类型>(<范围>): <描述>

[可选的正文]

[可选的脚注]
```

类型：
- `feat` - 新功能
- `fix` - Bug 修复
- `docs` - 文档更新
- `style` - 代码格式（不影响功能）
- `refactor` - 代码重构
- `perf` - 性能优化
- `test` - 测试相关
- `chore` - 构建/工具相关
- `ci` - CI/CD 相关

示例：
```
feat(catch): 添加连续捕捉奖励机制

当玩家连续捕捉成功时，给予额外奖励：
- 连续 5 次：+10% 经验
- 连续 10 次：+20% 经验
- 连续 20 次：+50% 经验

Closes #123
```

```
fix(payment): 修复订单幂等性校验漏洞

修复在高并发场景下，相同幂等键可能创建多个订单的问题。

使用 Redis SETNX 保证原子性检查。

Fixes #456
```

### 6. 推送和创建 PR

```bash
git push origin feature/your-feature-name
```

然后在 GitHub 上创建 Pull Request。

## 代码规范

### JavaScript

- 使用 ES6+ 语法
- 使用 `const` 和 `let`，避免 `var`
- 使用箭头函数
- 使用模板字符串
- 使用解构赋值
- 使用 async/await 处理异步

### 代码风格

使用 Prettier 和 ESLint 保持代码风格一致：

```bash
# 检查代码风格
npm run lint

# 自动修复
npm run lint:fix
```

配置文件：
- `.prettierrc` - Prettier 配置
- `.eslintrc.js` - ESLint 配置

### 注释规范

使用 JSDoc 格式：

```javascript
/**
 * 计算捕捉概率
 * @param {Object} options - 计算选项
 * @param {number} options.cp - 精灵 CP 值
 * @param {number} options.ballType - 精灵球类型 (1=普通, 2=高级, 3=大师)
 * @param {number} options.berryBonus - 浆果加成 (0-1)
 * @returns {number} 捕捉概率 (0-1)
 */
function calculateCatchProbability(options) {
  // ...
}
```

### 文件命名

- 使用小写字母和连字符：`catch-service.js`
- 测试文件：`*.test.js` 或 `*.spec.js`
- 配置文件：`*.config.js`

### 目录结构

```
backend/
├── gateway/           # API 网关
├── services/          # 微服务
│   ├── user-service/
│   ├── catch-service/
│   └── ...
├── shared/            # 共享模块
└── tests/             # 测试文件
    ├── unit/
    └── integration/
```

## 提交规范

### 提交信息格式

```
<类型>(<范围>): <描述>

[正文]

[脚注]
```

### 示例

```
feat(gym): 添加 Raid 实时战斗 WebSocket 支持

- 实现 Raid 房间管理
- 添加实时战斗同步
- 支持断线重连

Closes #789
```

### 要求

- 标题不超过 50 字符
- 使用祈使句（"添加" 而非 "添加了"）
- 不以句号结尾
- 正文每行不超过 72 字符
- 解释做了什么和为什么，而非怎么做

## 测试要求

### 单元测试

- 新功能必须有单元测试
- 修复 Bug 必须有回归测试
- 测试覆盖率 ≥ 80%

```bash
# 运行单元测试
npm run test:unit

# 生成覆盖率报告
npm run test:coverage
```

### 集成测试

- 关键流程需要集成测试
- 使用独立的测试数据库

```bash
# 运行集成测试
npm run test:integration
```

### 测试命名

```javascript
describe('CatchService', () => {
  describe('calculateCatchProbability', () => {
    it('should return 1.0 for master ball', () => {
      // ...
    });

    it('should increase probability with berry bonus', () => {
      // ...
    });
  });
});
```

### 测试原则

- 测试行为，而非实现
- 每个测试只验证一个点
- 使用有意义的测试数据
- 避免 Mock 过度使用

## 代码审查

所有 PR 都需要至少 1 位审查者批准。

### 审查重点

- **功能正确性**：代码是否实现了预期功能？
- **代码质量**：代码是否清晰、可维护？
- **测试覆盖**：是否有足够的测试？
- **性能影响**：是否影响性能？
- **安全风险**：是否有安全漏洞？
- **文档更新**：是否更新了相关文档？

### 审查流程

1. 自动检查（CI）必须通过
2. 至少 1 位审查者批准
3. 解决所有评论
4. Squash and merge

## 问题反馈

### 报告安全问题

**请勿在公开 Issue 中报告安全漏洞！**

请发送邮件至：security@minego.example.com

### 报告 Bug

使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md)：

1. 描述问题
2. 复现步骤
3. 期望行为
4. 实际行为
5. 环境信息
6. 截图/日志

### 功能请求

使用 [功能请求模板](.github/ISSUE_TEMPLATE/feature_request.md)：

1. 描述功能
2. 使用场景
3. 期望行为
4. 替代方案

## 🙏 感谢

感谢所有贡献者的付出！

<!-- 贡献者列表会自动更新 -->
