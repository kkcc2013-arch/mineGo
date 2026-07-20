# REQ-00602：游戏内加载骨架屏与智能进度指示系统

- **编号**：REQ-00602
- **类别**：前端体验
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/components、frontend/game-client/src/styles
- **创建时间**：2026-07-20 03:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端在加载精灵列表、背包、好友列表等数据时，用户看到的是空白页面或简单的 loading spinner。这种体验在移动端网络不稳定时尤为明显，用户不知道内容何时加载完成，造成焦虑感和流失。

现有的 LazyImage.js 仅解决了图片懒加载问题，但没有解决整体内容占位和加载进度反馈的问题。

## 2. 目标

引入骨架屏（Skeleton Screen）系统，在数据加载前展示内容结构的灰色占位符，让用户预知即将展示的内容形态。同时实现智能进度指示器，根据网络状况和数据量动态调整加载反馈，提升感知性能和用户体验。

## 3. 范围

- **包含**：
  - 骨架屏组件库（PokemonListSkeleton、BagSkeleton、FriendListSkeleton、LeaderboardSkeleton 等）
  - 智能进度指示器（线性进度、圆形进度、分步进度）
  - 加载状态管理器（统一管理全局加载状态）
  - 过渡动画系统（骨架屏 ↔ 真实内容平滑过渡）
  - 网络状态感知（根据 3G/4G/WiFi 调整策略）

- **不包含**：
  - 后端 API 性能优化（属于其他需求）
  - 图片加载优化（已有 LazyImage.js）

## 4. 详细需求

### 4.1 骨架屏组件库

创建可复用的骨架屏组件：

```javascript
// frontend/game-client/src/components/skeleton/BaseSkeleton.js
// 基础骨架屏组件
// - 支持圆角、渐变动画
// - 支持自适应尺寸
// - 支持主题（深色/浅色模式）

// frontend/game-client/src/components/skeleton/PokemonCardSkeleton.js
// 精灵卡片骨架屏
// - 模拟精灵图片、名字、CP、类型等结构

// frontend/game-client/src/components/skeleton/BagItemSkeleton.js
// 背包物品骨架屏
// - 模拟物品图标、数量、名称结构

// frontend/game-client/src/components/skeleton/FriendItemSkeleton.js
// 好友列表骨架屏
// - 模拟头像、名字、在线状态结构

// frontend/game-client/src/components/skeleton/LeaderboardRowSkeleton.js
// 排行榜行骨架屏
// - 模拟排名、头像、名字、分数结构
```

### 4.2 智能进度指示器

```javascript
// frontend/game-client/src/components/progress/LinearProgress.js
// 线性进度条
// - 支持 determinate/indeterminate 模式
// - 支持颜色自定义
// - 支持动画过渡

// frontend/game-client/src/components/progress/CircularProgress.js
// 圆形进度指示器
// - 适用于按钮内加载状态
// - 支持尺寸配置

// frontend/game-client/src/components/progress/StepProgress.js
// 分步进度指示器
// - 适用于多步操作（如精灵进化、交易确认）
// - 显示当前步骤和总步骤

// frontend/game-client/src/components/progress/SmartProgress.js
// 智能进度指示器
// - 根据网络状态自动选择进度类型
// - WiFi: 线性进度（精确）
// - 3G/4G: 骨架屏 + 微型 spinner
// - 弱网: 全屏骨架屏 + 提示文字
```

### 4.3 加载状态管理器

```javascript
// frontend/game-client/src/loading/LoadingStateManager.js
// 统一管理全局加载状态
// - API 请求拦截，自动显示/隐藏骨架屏
// - 加载超时处理（30s 后提示用户）
// - 并发请求合并展示
// - 支持命名空间（区分不同模块的加载状态）
```

### 4.4 过渡动画系统

```javascript
// frontend/game-client/src/loading/TransitionManager.js
// 骨架屏 → 真实内容过渡
// - fade-in/fade-out 淡入淡出
// - slide-in/slide-out 滑动
// - scale 缩放
// - 支持配置过渡时长（默认 300ms）
```

### 4.5 网络状态感知

```javascript
// frontend/game-client/src/network/NetworkAwareness.js
// 基于 Network Information API
// - 检测 connection type (4g/3g/2g/slow-2g)
// - 检测 effectiveType（有效连接类型）
// - 检测 downlink（下行速度）
// - 根据网络状态调整骨架屏复杂度
```

## 5. 验收标准（可测试）

- [ ] 至少实现 5 种骨架屏组件（PokemonCard、BagItem、FriendItem、LeaderboardRow、QuestItem）
- [ ] 骨架屏支持渐变动画（shimmer effect），动画流畅度 ≥ 30 FPS
- [ ] 过渡动画支持至少 3 种效果（fade、slide、scale）
- [ ] 加载状态管理器支持并发请求合并，避免多个加载指示器同时显示
- [ ] 智能进度指示器能根据网络状态自动切换显示模式
- [ ] 骨架屏组件通过 Playwright E2E 测试验证视觉效果
- [ ] 过渡动画在低端设备上性能良好（低端 Android 设备测试通过）
- [ ] 代码覆盖率 ≥ 80%

## 6. 工作量估算

**M（Medium）**

理由：
- 骨架屏组件相对简单，可复用性高
- 加载状态管理需要与现有 API Client 集成
- 过渡动画需要处理兼容性问题
- 网络状态感知需要考虑浏览器兼容性
- 预估 3-5 天开发时间

## 7. 优先级理由

P2（中等优先级）：
- 前端体验优化，非阻塞性问题
- 现有 loading spinner 可用，但体验不佳
- 对用户留存和满意度有积极影响
- 可与其他前端优化需求合并迭代
