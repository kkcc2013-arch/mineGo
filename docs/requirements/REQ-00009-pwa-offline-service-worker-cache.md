# REQ-00009：PWA 离线支持与 Service Worker 缓存策略

- **编号**：REQ-00009
- **类别**：前端体验
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：game-client、frontend/sw.js、frontend/manifest.json
- **创建时间**：2026-06-05 05:00
- **依赖需求**：无

## 1. 背景与问题

当前 game-client 是纯前端应用，存在以下关键问题：

1. **无离线能力**：用户在地铁、电梯、弱网环境下网络断开时，应用完全不可用，无法查看已缓存的精灵信息、背包数据
2. **无 PWA 支持**：缺少 Web App Manifest，用户无法将游戏"安装"到手机主屏幕，只能通过浏览器访问
3. **无 Service Worker 缓存**：每次打开应用都需要重新下载所有静态资源，浪费流量且加载慢
4. **无后台同步**：用户离线时的操作（如捕捉请求）无法在恢复网络后自动同步
5. **无推送通知**：用户必须打开应用才能收到 Raid 邀请、好友消息等通知

对于一款基于 GPS 的 AR 手游，这些能力直接影响用户留存和活跃度。

## 2. 目标

将 game-client 升级为完整的 PWA 应用，实现：

- 离线可用：网络断开时可查看缓存数据，显示离线状态提示
- 快速加载：Service Worker 缓存静态资源，二次访问秒开
- 可安装：支持"添加到主屏幕"，全屏沉浸式体验
- 后台同步：离线操作在恢复网络后自动同步
- 推送就绪：为后续推送通知功能预留基础设施

## 3. 范围

- **包含**：
  - Web App Manifest 配置（名称、图标、启动画面、主题色）
  - Service Worker 注册与生命周期管理
  - 静态资源预缓存策略（HTML、CSS、JS、字体、关键图片）
  - API 响应缓存策略（附近精灵、背包数据、用户信息）
  - 离线状态检测与 UI 提示
  - 后台同步 API 封装（Background Sync API）
  - 安装提示 UI（BeforeInstallPromptEvent）

- **不包含**：
  - Web Push 推送通知（需要后端 VAPID 密钥配置，后续需求）
  - 离线 GPS 追踪（需要原生 App 能力）
  - 离线精灵捕捉（需要复杂的状态同步与冲突解决）

## 4. 详细需求

### 4.1 Web App Manifest

创建 `frontend/game-client/manifest.json`：

```json
{
  "name": "Pocket Monster Go",
  "short_name": "PMG",
  "description": "GPS精灵捕捉手游",
  "start_url": "/index.html",
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#0d0f14",
  "background_color": "#0d0f14",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "categories": ["games", "entertainment"],
  "screenshots": [{ "src": "/screenshots/game.png", "sizes": "1080x1920" }]
}
```

### 4.2 Service Worker 架构

创建 `frontend/game-client/sw.js`：

```javascript
// 缓存版本与策略
const CACHE_VERSION = 'pmg-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

// 预缓存静态资源列表
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/src/main.js',
  '/src/api/client.js',
  '/src/game/GameStore.js',
  '/src/game/LocationManager.js',
  '/src/game/CatchEngine.js',
  '/src/game/RaidManager.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// API 缓存策略配置
const API_CACHE_RULES = {
  '/v1/map/nearby': { maxAge: 30000, staleWhileRevalidate: true },      // 附近精灵：30秒
  '/v1/users/me': { maxAge: 60000, staleWhileRevalidate: true },        // 用户信息：60秒
  '/v1/users/me/inventory': { maxAge: 30000, staleWhileRevalidate: true }, // 背包：30秒
  '/v1/pokemon/pokedex': { maxAge: 86400000, cacheFirst: true },        // 图鉴：24小时
};
```

### 4.3 缓存策略

| 资源类型 | 策略 | 说明 |
|---------|------|------|
| 静态资源 (HTML/CSS/JS) | CacheFirst | 永久缓存，版本更新时清理 |
| 图鉴数据 | CacheFirst | 24小时过期，极少变化 |
| 附近精灵 | StaleWhileRevalidate | 立即返回缓存，后台更新 |
| 用户信息 | StaleWhileRevalidate | 立即返回缓存，后台更新 |
| 捕捉/支付等写操作 | NetworkOnly | 必须联网，不缓存 |

### 4.4 离线状态 UI

在 `GameStore` 中添加离线状态管理：

```javascript
// 检测离线状态
window.addEventListener('online', () => store.set({ isOffline: false }));
window.addEventListener('offline', () => store.set({ isOffline: true }));

// 离线时显示顶部横幅
// 样式：橙色背景 + "⚠️ 当前离线，部分功能受限"
```

### 4.5 后台同步

为捕捉、旋转补给站等操作添加离线队列：

```javascript
// 注册后台同步
self.registration.sync.register('sync-pending-operations');

// 同步事件处理
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-operations') {
    event.waitUntil(syncPendingOperations());
  }
});
```

### 4.6 安装提示

```javascript
// 捕获 beforeinstallprompt 事件
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  store.set({ canInstallPwa: true });
});

// 用户点击安装按钮时调用
async function installPwa() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  store.set({ canInstallPwa: false, pwaInstalled: outcome === 'accepted' });
}
```

## 5. 验收标准（可测试）

- [ ] 应用可通过 Chrome DevTools > Application > Manifest 验证为有效 PWA
- [ ] Lighthouse PWA 评分 ≥ 80 分
- [ ] 首次访问后，断开网络刷新页面，应用仍可加载（静态资源已缓存）
- [ ] 离线时打开应用，顶部显示"当前离线"提示横幅
- [ ] 离线时查看背包、图鉴，显示缓存数据（非空白）
- [ ] 离线时尝试捕捉精灵，操作被加入待同步队列
- [ ] 恢复网络后，待同步操作自动执行并成功
- [ ] Chrome 地址栏显示"安装"按钮（或自定义安装提示出现）
- [ ] 安装后，应用以独立窗口运行，无浏览器地址栏
- [ ] Service Worker 更新时，用户收到"新版本可用"提示

## 6. 工作量估算

**L**（Large）

- 需要创建 Service Worker、Manifest、图标资源
- 需要修改 API Client 支持缓存策略
- 需要添加离线状态 UI 和安装提示 UI
- 需要实现后台同步队列
- 预计 2-3 天完成

## 7. 优先级理由

**P0** 理由：

1. **直接影响用户留存**：移动端游戏用户常在弱网环境使用，无离线能力会导致用户流失
2. **竞品标配**：Pokemon GO 等 AR 手游都支持离线查看数据，这是基础能力
3. **性能提升显著**：Service Worker 缓存可使二次加载时间从 3-5 秒降至 <1 秒
4. **安装率影响活跃度**：PWA 安装用户活跃度是普通网页用户的 2-3 倍
5. **技术债务风险**：越晚实现，需要适配的代码越多，现在实现成本最低
