# REQ-00333：游戏内智能 Toast 通知系统与用户反馈优化

- **编号**：REQ-00333
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/components/ToastManager.js、frontend/game-client/src/game/GameStore.js、frontend/game-client/src/utils/ErrorHandler.js、gateway
- **创建时间**：2026-06-26 04:00 UTC
- **依赖需求**：REQ-00066（API 错误码标准化）

## 1. 背景与问题

当前游戏客户端的通知反馈系统存在以下问题：

1. **Toast 实现过于简单**：当前只是基础的 CSS 动画（`window.toast()` 函数），只有成功/错误两种类型，缺少信息、警告等更多状态，无法满足复杂场景需求。

2. **缺少队列管理**：多个 toast 同时触发时会相互覆盖，用户可能错过重要信息。例如：捕捉精灵成功 + 任务完成 + 升级同时触发时，只能看到一个 toast。

3. **无法撤销操作**：删除精灵、使用道具等操作缺少撤销功能，用户误操作后无法恢复，影响用户体验。

4. **缺少持久化与历史**：重要通知（系统公告、活动奖励）没有历史记录，用户刷新页面后无法查看。

5. **缺少可操作性**：Toast 只能被动展示，用户无法进行交互（如"查看详情"、"重试"、"撤销"等）。

6. **无用户行为分析**：无法追踪用户是否看到了通知、是否进行了操作，缺少产品优化数据支撑。

7. **与错误处理集成不深**：虽然有 ErrorHandler.js，但 toast 显示逻辑分散，没有统一的错误提示策略。

## 2. 目标

设计并实现一个智能化的 Toast 通知系统，提供：

- **多优先级队列**：Critical > Error > Warning > Success > Info，确保重要消息优先展示
- **可撤销操作**：支持撤销按钮和自动撤销倒计时
- **消息历史**：持久化最近 100 条通知，支持筛选和查看
- **可操作性**：Toast 支持自定义按钮（查看详情、重试、撤销等）
- **用户行为分析**：追踪 Toast 展示时长、点击率、撤销率等指标
- **错误智能处理**：与 ErrorHandler 深度集成，自动识别错误类型并提供重试建议
- **无障碍支持**：支持屏幕阅读器朗读、高对比度模式、字体放大

预期收益：
- 提升用户体验满意度 30%（通过用户调研）
- 减少误操作投诉 50%（通过撤销功能）
- 提升错误恢复率 40%（通过智能重试）
- 收集 10+ 项用户行为指标用于产品优化

## 3. 范围

### 包含

1. **ToastManager 核心组件**
   - 多优先级队列管理器
   - 位置布局管理（顶部、底部、左上、右上等）
   - 并发展示策略（堆叠、替换、排队）
   - 自动消失与持久化控制

2. **可撤销操作机制**
   - 撤销按钮组件
   - 操作快照与回滚接口
   - 自动撤销倒计时（可配置）

3. **消息历史中心**
   - 本地持久化（localStorage）
   - 历史记录 UI（最近 100 条）
   - 筛选与搜索功能

4. **可操作性 Toast**
   - 自定义按钮系统（最多 2 个按钮）
   - 点击事件追踪
   - 深度链接支持（点击跳转到具体页面）

5. **用户行为分析**
   - 展示时长追踪
   - 点击率统计
   - 撤销率统计
   - 事件上报到后端（可选）

6. **错误智能处理**
   - 与 ErrorHandler.js 深度集成
   - 自动识别可重试错误并显示重试按钮
   - 网络错误自动重试策略
   - 错误分级显示（Critical 持久展示，Error 自动消失）

7. **无障碍支持**
   - ARIA 标签与角色
   - 屏幕阅读器实时播报（aria-live）
   - 高对比度模式适配
   - 字体放大支持（跟随系统设置）

### 不包含

- 服务端推送通知（已有 NotificationManager.js）
- 邮件/短信通知
- 通知权限管理（浏览器权限）
- 多设备通知同步

## 4. 详细需求

### 4.1 ToastManager 核心架构

```javascript
// frontend/game-client/src/components/ToastManager.js

class ToastManager extends EventTarget {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      maxConcurrent: 3,              // 同时展示数量
      defaultDuration: 5000,         // 默认展示时长
      criticalDuration: 0,           // Critical 永不自动消失
      position: 'top-right',         // 默认位置
      animationDuration: 300,        // 动画时长
      persistCount: 100,             // 历史记录数量
      ...options
    };
    
    // 队列管理
    this.queues = {
      critical: [],  // 最高优先级，持久展示
      error: [],     // 错误消息
      warning: [],   // 警告消息
      success: [],   // 成功消息
      info: []       // 信息消息
    };
    
    // 当前展示的 Toast
    this.activeToasts = new Map();  // id -> Toast
    
    // 历史记录
    this.history = [];
    
    // 用户行为统计
    this.analytics = {
      shown: 0,
      clicked: 0,
      dismissed: 0,
      undone: 0
    };
  }
  
  // 显示 Toast
  show(options) {
    const toast = {
      id: Date.now() + Math.random(),
      type: options.type || 'info',        // critical|error|warning|success|info
      title: options.title,
      message: options.message,
      icon: options.icon || this.getDefaultIcon(options.type),
      duration: options.duration ?? this.config.defaultDuration,
      persistent: options.persistent ?? (options.type === 'critical'),
      actions: options.actions || [],      // [{label, onClick, primary}]
      undo: options.undo || null,          // {callback, timeout}
      data: options.data || {},            // 自定义数据
      createdAt: Date.now(),
      shownAt: null,
      clickedAt: null,
      dismissedAt: null
    };
    
    // 添加到队列
    this.addToQueue(toast);
    
    // 尝试展示
    this.processQueue();
    
    // 记录历史
    this.addToHistory(toast);
    
    // 发送事件
    this.dispatchEvent(new CustomEvent('toast:added', { detail: toast }));
    
    return toast.id;
  }
  
  // 快捷方法
  success(message, options = {}) {
    return this.show({ type: 'success', message, ...options });
  }
  
  error(message, options = {}) {
    return this.show({ type: 'error', message, ...options });
  }
  
  warning(message, options = {}) {
    return this.show({ type: 'warning', message, ...options });
  }
  
  info(message, options = {}) {
    return this.show({ type: 'info', message, ...options });
  }
  
  critical(title, message, options = {}) {
    return this.show({ type: 'critical', title, message, persistent: true, ...options });
  }
  
  // 可撤销操作
  showWithUndo(message, undoCallback, options = {}) {
    return this.show({
      type: options.type || 'info',
      message,
      undo: {
        callback: undoCallback,
        timeout: options.undoTimeout || 10000  // 10秒内可撤销
      },
      ...options
    });
  }
  
  // 错误处理集成
  showErrorWithRetry(error, retryCallback, options = {}) {
    const errorInfo = window.errorHandler?.parseError(error) || {};
    
    return this.show({
      type: 'error',
      title: errorInfo.message || '操作失败',
      message: errorInfo.retryable ? '点击重试按钮重新操作' : '',
      actions: errorInfo.retryable ? [
        { label: '重试', onClick: retryCallback, primary: true },
        { label: '忽略', onClick: () => {} }
      ] : [],
      duration: errorInfo.retryable ? 15000 : 5000,
      data: { error: errorInfo },
      ...options
    });
  }
}
```

### 4.2 多优先级队列处理

```javascript
// 队列优先级处理
processQueue() {
  // 检查当前展示数量
  if (this.activeToasts.size >= this.config.maxConcurrent) {
    return;
  }
  
  // 按优先级遍历队列
  const priorityOrder = ['critical', 'error', 'warning', 'success', 'info'];
  
  for (const priority of priorityOrder) {
    const queue = this.queues[priority];
    
    if (queue.length > 0) {
      const toast = queue.shift();
      this.displayToast(toast);
      break;  // 每次只展示一个
    }
  }
}

// 展示 Toast
displayToast(toast) {
  // 创建 DOM 元素
  const element = this.createToastElement(toast);
  
  // 添加到容器
  const container = this.getContainer();
  container.appendChild(element);
  
  // 记录展示
  toast.shownAt = Date.now();
  this.activeToasts.set(toast.id, { toast, element });
  
  // 统计
  this.analytics.shown++;
  this.reportAnalytics('shown', toast);
  
  // 自动消失
  if (!toast.persistent && toast.duration > 0) {
    setTimeout(() => this.dismiss(toast.id), toast.duration);
  }
  
  // 撤销倒计时
  if (toast.undo) {
    this.startUndoCountdown(toast);
  }
}
```

### 4.3 可撤销操作实现

```javascript
// 撤销倒计时
startUndoCountdown(toast) {
  const timeout = toast.undo.timeout;
  const startTime = Date.now();
  
  // 更新倒计时显示
  const updateCountdown = () => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, timeout - elapsed);
    const seconds = Math.ceil(remaining / 1000);
    
    // 更新 UI
    const countdownEl = document.querySelector(`[data-toast-id="${toast.id}"] .undo-countdown`);
    if (countdownEl) {
      countdownEl.textContent = `${seconds}s`;
    }
    
    if (remaining > 0) {
      requestAnimationFrame(updateCountdown);
    }
  };
  
  updateCountdown();
  
  // 超时后移除撤销按钮
  setTimeout(() => {
    const undoBtn = document.querySelector(`[data-toast-id="${toast.id}"] .undo-btn`);
    if (undoBtn) {
      undoBtn.remove();
    }
  }, timeout);
}

// 执行撤销
handleUndo(toastId) {
  const entry = this.activeToasts.get(toastId);
  if (!entry || !entry.toast.undo) return;
  
  try {
    entry.toast.undo.callback();
    
    // 统计
    this.analytics.undone++;
    this.reportAnalytics('undone', entry.toast);
    
    // 显示撤销成功
    this.success('操作已撤销', { duration: 2000 });
  } catch (error) {
    console.error('[ToastManager] Undo failed:', error);
    this.error('撤销失败', { duration: 3000 });
  }
  
  // 移除 Toast
  this.dismiss(toastId);
}
```

### 4.4 消息历史管理

```javascript
// 添加到历史
addToHistory(toast) {
  this.history.unshift({
    id: toast.id,
    type: toast.type,
    title: toast.title,
    message: toast.message,
    createdAt: toast.createdAt,
    shownAt: toast.shownAt,
    actions: toast.actions.length,
    hadUndo: !!toast.undo
  });
  
  // 限制数量
  if (this.history.length > this.config.persistCount) {
    this.history = this.history.slice(0, this.config.persistCount);
  }
  
  // 持久化到 localStorage
  this.saveHistory();
}

// 获取历史记录
getHistory(filters = {}) {
  let result = [...this.history];
  
  // 按类型筛选
  if (filters.type) {
    result = result.filter(t => t.type === filters.type);
  }
  
  // 按时间筛选
  if (filters.since) {
    result = result.filter(t => t.createdAt >= filters.since);
  }
  
  // 搜索
  if (filters.search) {
    const query = filters.search.toLowerCase();
    result = result.filter(t => 
      t.title?.toLowerCase().includes(query) ||
      t.message?.toLowerCase().includes(query)
    );
  }
  
  return result;
}

// 清空历史
clearHistory() {
  this.history = [];
  localStorage.removeItem('pmg_toast_history');
  this.dispatchEvent(new CustomEvent('history:cleared'));
}
```

### 4.5 用户行为分析

```javascript
// 用户点击操作按钮
handleActionClick(toastId, actionIndex) {
  const entry = this.activeToasts.get(toastId);
  if (!entry) return;
  
  const action = entry.toast.actions[actionIndex];
  if (action && action.onClick) {
    action.onClick();
    
    // 统计
    this.analytics.clicked++;
    entry.toast.clickedAt = Date.now();
    this.reportAnalytics('clicked', entry.toast, { actionIndex });
    
    // 移除 Toast（除非配置为保留）
    if (!action.keepToast) {
      this.dismiss(toastId);
    }
  }
}

// 用户手动关闭
handleDismiss(toastId) {
  this.dismiss(toastId);
  
  // 统计
  this.analytics.dismissed++;
  this.reportAnalytics('dismissed', this.activeToasts.get(toastId)?.toast);
}

// 上报分析数据
reportAnalytics(event, toast, extra = {}) {
  const data = {
    event,
    toastId: toast?.id,
    type: toast?.type,
    duration: toast?.shownAt ? Date.now() - toast.shownAt : 0,
    hadActions: toast?.actions?.length > 0,
    hadUndo: !!toast?.undo,
    ...extra,
    timestamp: Date.now()
  };
  
  // 发送到后端（可选，批量上报）
  if (this.config.enableAnalytics) {
    navigator.sendBeacon('/api/v1/analytics/toast', JSON.stringify(data));
  }
  
  // 本地事件
  this.dispatchEvent(new CustomEvent('analytics', { detail: data }));
}
```

### 4.6 错误处理集成

```javascript
// 与 ErrorHandler.js 集成
setupErrorHandler() {
  if (!window.errorHandler) return;
  
  // 初始化 ErrorHandler
  window.errorHandler.init({
    toastManager: this,
    i18n: window.i18n,
    router: window.router
  });
  
  // 全局错误捕获
  window.addEventListener('error', (event) => {
    const error = event.error || event.message;
    
    this.showErrorWithRetry(error, () => {
      // 重试逻辑
      window.location.reload();
    }, {
      title: '系统错误',
      persistent: true
    });
  });
  
  // Promise 未捕获错误
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    
    this.showErrorWithRetry(error, () => {
      // 重试逻辑
      event.promise.catch(() => {});
    }, {
      title: '异步操作失败'
    });
  });
}
```

### 4.7 UI 组件设计

```html
<!-- Toast 容器 -->
<div id="toast-container" class="toast-container toast-top-right" role="region" aria-label="通知消息">
  <!-- Toast 元素 -->
  <div class="toast toast-success" data-toast-id="123" role="alert" aria-live="polite">
    <div class="toast-icon">✓</div>
    <div class="toast-content">
      <div class="toast-title">操作成功</div>
      <div class="toast-message">精灵已添加到图鉴</div>
    </div>
    <div class="toast-actions">
      <button class="toast-btn toast-btn-primary">查看</button>
      <button class="toast-btn">关闭</button>
    </div>
    <button class="toast-close" aria-label="关闭">×</button>
  </div>
  
  <!-- 带撤销的 Toast -->
  <div class="toast toast-info" data-toast-id="124" role="alert" aria-live="polite">
    <div class="toast-icon">ℹ</div>
    <div class="toast-content">
      <div class="toast-message">精灵已删除</div>
    </div>
    <div class="toast-actions">
      <button class="toast-btn undo-btn">
        撤销 <span class="undo-countdown">10s</span>
      </button>
    </div>
    <button class="toast-close" aria-label="关闭">×</button>
  </div>
  
  <!-- Critical 错误 Toast -->
  <div class="toast toast-critical" data-toast-id="125" role="alert" aria-live="assertive">
    <div class="toast-icon">⚠</div>
    <div class="toast-content">
      <div class="toast-title">账号异常</div>
      <div class="toast-message">检测到异常登录行为，请验证身份</div>
    </div>
    <div class="toast-actions">
      <button class="toast-btn toast-btn-primary">验证身份</button>
      <button class="toast-btn">帮助</button>
    </div>
  </div>
</div>

<!-- 历史记录面板 -->
<div id="toast-history-panel" class="toast-history-panel" hidden>
  <div class="history-header">
    <h3>通知历史</h3>
    <button class="history-clear-btn">清空</button>
  </div>
  <div class="history-filters">
    <select class="history-filter-type">
      <option value="">全部类型</option>
      <option value="critical">严重</option>
      <option value="error">错误</option>
      <option value="warning">警告</option>
      <option value="success">成功</option>
      <option value="info">信息</option>
    </select>
    <input type="search" class="history-search" placeholder="搜索通知...">
  </div>
  <div class="history-list">
    <!-- 动态生成 -->
  </div>
</div>
```

### 4.8 CSS 样式规范

```css
/* Toast 容器 */
.toast-container {
  position: fixed;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 400px;
  pointer-events: none;
}

.toast-container > * {
  pointer-events: auto;
}

/* 位置变体 */
.toast-top-right { top: 20px; right: 20px; }
.toast-top-left { top: 20px; left: 20px; }
.toast-bottom-right { bottom: 20px; right: 20px; }
.toast-bottom-left { bottom: 20px; left: 20px; }
.toast-top-center { top: 20px; left: 50%; transform: translateX(-50%); }
.toast-bottom-center { bottom: 20px; left: 50%; transform: translateX(-50%); }

/* Toast 元素 */
.toast {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  animation: toast-slide-in 0.3s ease-out;
  min-width: 280px;
  max-width: 400px;
}

.toast.toast-exit {
  animation: toast-slide-out 0.3s ease-in forwards;
}

/* 类型样式 */
.toast-critical {
  border-color: var(--red);
  background: linear-gradient(135deg, rgba(230, 57, 70, 0.15), rgba(230, 57, 70, 0.05));
}

.toast-error {
  border-color: var(--red);
}

.toast-warning {
  border-color: var(--yellow);
  background: linear-gradient(135deg, rgba(244, 196, 48, 0.15), rgba(244, 196, 48, 0.05));
}

.toast-success {
  border-color: var(--green);
  background: linear-gradient(135deg, rgba(46, 204, 113, 0.15), rgba(46, 204, 113, 0.05));
}

.toast-info {
  border-color: var(--blue);
}

/* 图标 */
.toast-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.toast-critical .toast-icon { color: var(--red); }
.toast-error .toast-icon { color: var(--red); }
.toast-warning .toast-icon { color: var(--yellow); }
.toast-success .toast-icon { color: var(--green); }
.toast-info .toast-icon { color: var(--blue); }

/* 内容 */
.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 4px;
}

.toast-message {
  font-size: 13px;
  color: var(--muted);
  word-wrap: break-word;
}

/* 操作按钮 */
.toast-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.toast-btn {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.toast-btn:hover {
  background: var(--border);
}

.toast-btn-primary {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
}

.toast-btn-primary:hover {
  background: #2e7ae6;
}

.undo-btn {
  background: rgba(61, 142, 248, 0.15);
  border-color: var(--blue);
  color: var(--blue);
}

.undo-countdown {
  font-size: 11px;
  opacity: 0.8;
}

/* 关闭按钮 */
.toast-close {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
  opacity: 0.6;
}

.toast-close:hover {
  opacity: 1;
}

/* 动画 */
@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes toast-slide-out {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(100%);
  }
}

/* 高对比度模式 */
@media (prefers-contrast: high) {
  .toast {
    border-width: 2px;
  }
  
  .toast-btn {
    border-width: 2px;
  }
}

/* 字体放大 */
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}

/* 无障碍：屏幕阅读器优化 */
.toast[aria-live="assertive"] {
  /* Critical 错误立即播报 */
}

.toast[aria-live="polite"] {
  /* 普通消息排队播报 */
}

/* 历史记录面板 */
.toast-history-panel {
  position: fixed;
  top: 80px;
  right: 20px;
  width: 360px;
  max-height: 500px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  z-index: 10002;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.history-header h3 {
  font-size: 16px;
  font-weight: 700;
}

.history-filters {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 8px;
}

.history-filter-type,
.history-search {
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.history-list {
  overflow-y: auto;
  padding: 12px 16px;
}

.history-item {
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 8px;
  background: var(--surface2);
  cursor: pointer;
  transition: background 0.15s;
}

.history-item:hover {
  background: var(--border);
}

.history-item-time {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}

.history-item-message {
  font-size: 13px;
}
```

### 4.9 API 接口

```javascript
// 全局实例
window.toastManager = new ToastManager({
  maxConcurrent: 3,
  defaultDuration: 5000,
  position: 'top-right',
  enableAnalytics: true,
  persistCount: 100
});

// 初始化
toastManager.init();

// 使用示例
// 1. 基础用法
toastManager.success('捕捉成功！');
toastManager.error('网络连接失败');
toastManager.warning('背包空间不足');
toastManager.info('新版本可用');

// 2. 自定义标题和持续时间
toastManager.show({
  type: 'success',
  title: '升级成功',
  message: '你的等级已提升到 Lv.25',
  duration: 10000
});

// 3. 可撤销操作
toastManager.showWithUndo(
  '精灵已删除',
  () => { /* 恢复精灵 */ },
  { undoTimeout: 10000 }
);

// 4. 错误重试
try {
  await someAsyncOperation();
} catch (error) {
  toastManager.showErrorWithRetry(error, () => someAsyncOperation());
}

// 5. 自定义操作按钮
toastManager.show({
  type: 'info',
  title: '新活动',
  message: '限时捕捉活动已开启',
  actions: [
    { label: '查看详情', onClick: () => goToEvent(), primary: true },
    { label: '稍后提醒', onClick: () => remindLater() }
  ]
});

// 6. Critical 错误（持久展示）
toastManager.critical(
  '账号安全风险',
  '检测到异常登录，请立即验证身份',
  {
    actions: [
      { label: '验证身份', onClick: () => verifyIdentity(), primary: true },
      { label: '帮助', onClick: () => showHelp() }
    ]
  }
);

// 7. 查看历史
const history = toastManager.getHistory({ type: 'error', since: Date.now() - 86400000 });
console.log('过去24小时的错误通知:', history);

// 8. 获取统计
const stats = toastManager.getAnalytics();
console.log('Toast 统计:', stats);
```

## 5. 验收标准（可测试）

- [ ] **队列管理**：同时触发 5 个 Toast 时，按优先级顺序展示，不超过配置的最大并发数（默认 3 个）
- [ ] **优先级排序**：Critical > Error > Warning > Success > Info，Critical Toast 永不自动消失
- [ ] **撤销功能**：显示"精灵已删除" Toast，点击"撤销"按钮后精灵恢复，10 秒后撤销按钮消失
- [ ] **历史记录**：刷新页面后，历史记录中仍能看到最近 100 条通知，支持按类型和时间筛选
- [ ] **自定义按钮**：Toast 包含"查看详情"和"稍后提醒"两个按钮，点击后执行对应操作并记录点击事件
- [ ] **错误重试**：API 请求失败时，显示带"重试"按钮的错误 Toast，点击后自动重试
- [ ] **用户行为分析**：`toastManager.getAnalytics()` 返回 shown、clicked、dismissed、undone 四项统计数据
- [ ] **无障碍支持**：使用 VoiceOver/NVDA 屏幕阅读器时，Toast 内容被正确朗读，Critical 错误立即播报
- [ ] **高对比度模式**：开启系统高对比度模式后，Toast 边框加粗，对比度符合 WCAG AA 标准（至少 4.5:1）
- [ ] **动画禁用**：开启"减少动画"系统设置后，Toast 无滑入滑出动画，立即显示/消失
- [ ] **性能测试**：连续触发 100 个 Toast，页面无明显卡顿，CPU 占用 < 50%
- [ ] **集成测试**：与 ErrorHandler.js 集成后，所有未捕获错误都通过 Toast 友好展示，不再出现原生 alert

## 6. 工作量估算

**L（Large）**

理由：
- 核心组件开发：2 天（ToastManager、队列管理、撤销机制）
- UI 与样式：1 天（Toast 组件、历史面板、动画）
- 集成工作：1 天（ErrorHandler、GameStore、API 客户端）
- 测试与优化：1 天（单元测试、无障碍测试、性能优化）
- 文档编写：0.5 天

总计：5.5 人天

## 7. 优先级理由

**P1（高优先级）**

1. **用户体验关键路径**：Toast 是用户与应用交互的即时反馈机制，直接影响用户对操作结果的感知。当前实现过于简陋，无法满足复杂场景需求。

2. **减少用户投诉**：缺少撤销功能导致误操作无法恢复，是用户投诉的高频原因（预计占比 20%+）。实现撤销功能可显著降低客服成本。

3. **提升错误恢复率**：通过智能错误重试，可以将错误恢复率提升 40%，减少用户流失。

4. **产品优化数据支撑**：用户行为分析功能可提供 10+ 项关键指标，帮助产品团队优化通知策略和用户流程。

5. **技术债务清理**：当前 toast 实现分散在多处，与 ErrorHandler 集成不深，代码可维护性差。统一实现后可降低后续开发成本。

6. **快速见效**：Toast 是高频使用的 UI 组件，改进后用户可立即感知，ROI 高。

**不设为 P0 的原因**：
- 不影响核心游戏流程（捕捉、战斗、支付）
- 现有实现虽简陋但可用，不会导致功能缺失
- 可在后续版本迭代中优化
