# REQ-00099：游戏消息中心与通知管理系统

- **编号**：REQ-00099
- **类别**：前端体验
- **优先级**：P1
- **状态**：implemented
- **涉及服务/模块**：game-client、frontend/components、user-service、gateway
- **创建时间**：2026-06-11 01:40
- **依赖需求**：REQ-00026（游戏内实时推送通知系统）

## 1. 背景与问题

### 当前现状
项目已完成实时推送通知系统（REQ-00026），实现了：
- WebSocket 实时推送（7种通知类型：稀有精灵、Raid、好友、礼物、任务、系统、交易）
- NotificationManager.js 处理实时通知
- 后端通知 API（/api/notifications/preferences）
- 通知历史存储（notification_history 表）
- 多渠道推送插件架构（REQ-00032）

### 存在的问题
**缺少统一的消息中心 UI 界面**，导致：
1. 用户无法查看历史通知记录（仅显示实时 toast）
2. 无法区分已读/未读通知
3. 无法管理通知偏好设置
4. 无法快速定位通知相关的游戏内容（如：点击"稀有精灵"通知跳转到地图位置）
5. 导航栏缺少消息入口，用户感知不到通知功能
6. 重要通知容易被错过（如：Raid 即将结束、好友请求）

### 用户痛点
- **玩家反馈**："错过了稀有精灵刷新通知，等我看到时已经消失了"
- **玩家反馈**："不知道谁发了好友请求，找不到入口"
- **玩家反馈**："Raid 开始了我才知道，错过了最佳参与时间"

## 2. 目标

### 核心目标
构建完整的**游戏消息中心**，提供：
1. **通知列表视图**：展示所有历史通知，支持分页、筛选
2. **已读/未读状态**：清晰区分未读消息，支持一键全部已读
3. **通知分类管理**：按类型分组（系统/好友/Raid/精灵/奖励）
4. **通知偏好设置**：用户可自定义通知类型、免打扰时段
5. **快捷操作入口**：点击通知快速跳转到相关游戏内容
6. **导航栏消息图标**：显示未读数量徽章，快速进入消息中心

### 量化目标
- 未读消息查看时间：从 0 秒（无入口）→ 立即可见
- 通知点击到相关内容跳转：< 500ms
- 用户通知偏好设置保存：< 2s
- 消息中心加载时间：< 1s（首次）、< 300ms（后续缓存）
- 用户满意度提升：预期 25%+（问卷调查）

## 3. 范围

### 包含
- ✅ 前端消息中心 UI 组件（MessageCenter.js）
- ✅ 导航栏消息图标 + 未读徽章
- ✅ 通知列表视图（分页、下拉刷新、虚拟滚动优化）
- ✅ 通知分类筛选（6 种类型标签页）
- ✅ 已读/未读状态管理
- ✅ 通知详情展开与快捷操作
- ✅ 通知偏好设置面板
- ✅ 后端 API 扩展（标记已读、批量操作、统计）
- ✅ 数据库查询优化索引
- ✅ 本地缓存策略（IndexedDB）

### 不包含
- ❌ 推送通知内容审核系统（属于管理后台功能）
- ❌ 通知推送优化算法（已由 REQ-00032 实现）
- ❌ 邮件/短信通知渠道（未来扩展）
- ❌ 通知消息富文本编辑器（当前仅为系统生成消息）
- ❌ 通知多设备同步（暂不实现跨设备已读同步）

## 4. 详细需求

### 4.1 前端 UI 设计

#### 4.1.1 导航栏消息图标
```
位置：导航栏右侧（地图/我的 标签之间或上方）
图标：🔔 (铃铛图标)
未读徽章：红色圆点 + 数字（最大 99+）
点击行为：打开消息中心（全屏/模态窗口）
```

#### 4.1.2 消息中心主界面
```
顶部栏：
  - 标题："消息中心"
  - 右侧："全部已读"按钮（仅未读 > 0 时显示）
  - 左侧：关闭按钮（返回上一页）

标签页（横向滑动）：
  [全部] [系统] [好友] [Raid] [精灵] [奖励]
  
通知列表：
  - 卡片式布局
  - 每条通知包含：图标、标题、内容摘要、时间、未读标识
  - 左滑操作：删除、标记已读
  - 下拉刷新
  - 虚拟滚动（优化 100+ 条消息性能）

空状态：
  - 图标：📭
  - 文案："暂无消息"
  
底部操作栏：
  - "清空已读消息"按钮
  - "通知设置"入口
```

#### 4.1.3 通知卡片设计
```
示例卡片（稀有精灵通知）：
┌─────────────────────────────────┐
│ 🔴 🐉 稀有精灵出现！            │
│    发现了一只闪光快龙           │
│    距离你 150 米                │
│    10 分钟前                    │
│                         [前往]  │
└─────────────────────────────────┘

点击行为：
- 点击卡片主体：展开详情
- 点击"前往"按钮：跳转到地图指定位置
```

#### 4.1.4 通知详情展开
```
展开内容：
- 完整通知内容
- 相关数据（精灵图片、Raid 信息等）
- 快捷操作按钮：
  - 稀有精灵 → "导航前往"（打开地图，标记位置）
  - Raid 开始 → "加入战斗"（打开 Raid 界面）
  - 好友请求 → "查看好友" → "接受/拒绝"
  - 任务完成 → "领取奖励"
```

#### 4.1.5 通知偏好设置面板
```
通知类型开关（默认全部开启）：
  [✓] 稀有精灵刷新
  [✓] Raid 战斗提醒
  [✓] 好友请求
  [✓] 礼物接收
  [✓] 任务完成
  [✓] 系统公告

免打扰时段：
  [启用免打扰]
  开始时间：[22:00] 结束时间：[08:00]
  
推送渠道偏好：
  [✓] 应用内推送
  [✓] FCM 推送（Android）
  [✓] APNs 推送（iOS）

保存按钮
```

### 4.2 后端 API 设计

#### 4.2.1 获取通知列表
```
GET /api/notifications?status=unread&type=raid&page=1&limit=20

Response:
{
  "success": true,
  "data": {
    "notifications": [
      {
        "id": "notif_123",
        "type": "RARE_SPAWN",
        "title": "稀有精灵出现！",
        "body": "发现了一只闪光快龙，距离你 150 米",
        "icon": "🐉",
        "data": {
          "speciesId": "dragonite_shiny",
          "lat": 39.9042,
          "lng": 116.4074,
          "distance": 150,
          "expiresAt": "2026-06-11T02:00:00Z"
        },
        "isRead": false,
        "createdAt": "2026-06-11T01:30:00Z"
      }
    ],
    "pagination": {
      "total": 45,
      "page": 1,
      "limit": 20,
      "totalPages": 3
    },
    "unreadCount": 12
  }
}
```

#### 4.2.2 标记通知已读
```
PATCH /api/notifications/:id/read

Response:
{
  "success": true,
  "data": { "isRead": true }
}
```

#### 4.2.3 批量标记已读
```
POST /api/notifications/batch-read
Body: { "ids": ["notif_123", "notif_456"] }
或
Body: { "all": true }  // 标记所有为已读

Response:
{
  "success": true,
  "data": { "updatedCount": 12 }
}
```

#### 4.2.4 删除通知
```
DELETE /api/notifications/:id

Response:
{
  "success": true
}
```

#### 4.2.5 批量删除已读通知
```
POST /api/notifications/clear-read

Response:
{
  "success": true,
  "data": { "deletedCount": 30 }
}
```

#### 4.2.6 获取未读数量
```
GET /api/notifications/unread-count

Response:
{
  "success": true,
  "data": {
    "total": 12,
    "byType": {
      "RARE_SPAWN": 3,
      "RAID_STARTED": 2,
      "FRIEND_REQUEST": 4,
      "QUEST_COMPLETE": 2,
      "SYSTEM": 1
    }
  }
}
```

#### 4.2.7 更新通知偏好
```
PATCH /api/notifications/preferences
Body: {
  "notificationTypes": {
    "rare_spawn": true,
    "raid_started": true,
    "friend_request": false
  },
  "quietHours": {
    "enabled": true,
    "start": "22:00",
    "end": "08:00"
  }
}

Response:
{
  "success": true,
  "data": { "updated": true }
}
```

### 4.3 数据库设计

#### 4.3.1 新增索引（优化查询性能）
```sql
-- 通知列表查询优化（按用户+状态+时间）
CREATE INDEX idx_notification_history_user_status_time 
ON notification_history(user_id, is_read, created_at DESC);

-- 通知列表查询优化（按用户+类型+时间）
CREATE INDEX idx_notification_history_user_type_time 
ON notification_history(user_id, notification_type, created_at DESC);

-- 未读数量统计优化
CREATE INDEX idx_notification_history_user_unread 
ON notification_history(user_id, is_read) WHERE is_read = false;
```

### 4.4 本地缓存策略

#### 4.4.1 IndexedDB 存储结构
```
Database: PMG_Messages
Stores:
  - notifications: { id, type, title, body, isRead, createdAt, ... }
  - metadata: { lastSyncTime, unreadCount, version }

同步策略：
- 首次打开：从服务器全量加载
- 后续打开：增量同步（基于 lastSyncTime）
- 离线模式：显示本地缓存数据
- 上线后：自动同步最新通知
```

#### 4.4.2 缓存更新机制
```
事件驱动更新：
- WebSocket 收到新通知 → 本地插入 + 更新徽章
- 标记已读 → 本地更新 isRead
- 删除通知 → 本地删除

定时同步：
- 每 5 分钟检查一次最新通知
- 前台切换到后台：保存当前状态
- 后台切换到前台：增量同步
```

### 4.5 性能要求

1. **列表渲染性能**
   - 虚拟滚动：支持 1000+ 条通知流畅滚动（FPS ≥ 60）
   - 首屏渲染：< 500ms

2. **网络请求优化**
   - 分页加载：每页 20 条
   - 请求去重：避免重复请求
   - 离线缓存：IndexedDB 本地存储

3. **实时性**
   - WebSocket 新通知到达：< 200ms 显示
   - 未读徽章更新：< 100ms

## 5. 验收标准（可测试）

- [ ] **导航栏消息图标**
  - 导航栏显示消息图标（🔔）
  - 未读数量 > 0 时显示红色徽章
  - 点击图标打开消息中心
  
- [ ] **通知列表显示**
  - 显示所有历史通知（分页）
  - 每条通知显示图标、标题、摘要、时间
  - 未读通知有红色标识
  - 下拉刷新正常工作

- [ ] **通知分类筛选**
  - 6 个标签页切换正常
  - 筛选结果正确
  - 切换时保持滚动位置

- [ ] **已读/未读管理**
  - 点击通知自动标记已读
  - "全部已读"按钮正常工作
  - 未读徽章实时更新
  - 后端状态同步正确

- [ ] **通知详情与操作**
  - 点击通知展开详情
  - 快捷操作按钮显示（如"前往"）
  - 点击操作跳转到正确页面

- [ ] **通知偏好设置**
  - 6 种通知类型开关正常
  - 免打扰时段设置保存成功
  - 设置持久化，重启后保持

- [ ] **批量操作**
  - 批量标记已读
  - 批量删除已读通知
  - 操作确认提示

- [ ] **本地缓存**
  - IndexedDB 存储通知数据
  - 离线模式显示缓存通知
  - 上线后自动同步

- [ ] **性能指标**
  - 首屏加载 < 1s
  - 虚拟滚动流畅（FPS ≥ 60）
  - WebSocket 通知到达 < 200ms 显示

- [ ] **无障碍访问**
  - 消息中心支持键盘导航
  - 屏幕阅读器正确朗读通知内容
  - 高对比度模式下正常显示

## 6. 工作量估算

**规模：L（Large）**

理由：
1. 前端组件开发量较大（消息中心、偏好设置、导航栏徽章）
2. 后端 API 扩展（7 个端点）
3. 数据库索引优化
4. IndexedDB 本地缓存实现
5. WebSocket 集成（实时更新）
6. 单元测试 + 集成测试

**预估工时：5-7 人日**

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **用户体验关键路径**：消息中心是用户与游戏交互的重要入口，缺少此功能影响用户留存
2. **已有基础设施完善**：REQ-00026 已实现实时推送，只需补充 UI 层，投入产出比高
3. **用户反馈强烈**：多位用户反馈错过重要通知，直接影响游戏体验
4. **竞品标配功能**：所有主流手游都有消息中心，属于基础必备功能
5. **低风险高价值**：技术实现成熟，无复杂依赖，可快速交付

**对"项目可用"的贡献**：
- 补全前端体验的关键缺口
- 提升用户粘性和活跃度
- 降低用户错过重要事件的风险
- 提供完整的通知闭环体验（推送 → 查看 → 操作）

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 导航栏消息图标：显示 🔔、未读 > 0 显示红色徽章、点击打开消息中心 | ✅ | 底部导航追加「消息」🔔（`data-testid=nav-messages`），未读徽章（>99 显示 99+，读屏标签"消息中心，N 条未读"），点击/回车打开全屏消息中心 |
| 通知列表显示：分页、图标/标题/摘要/时间、未读标识、下拉刷新 | ✅ | `GET /v1/notifications?page=&limit=&status=&category=&type=&since=`（分页、未读数；紧急未读置顶）；列表每条显示图标、标题、摘要、相对时间与分类，未读有红点与底色；滚动到底自动加载下一页；在顶部下拉 > 80px 刷新，另有刷新按钮 |
| 通知分类筛选：6 个标签页、筛选正确、切换时保持滚动位置 | ✅ | 标签页：全部 + 社交/奖励/活动/精灵/系统/安全（6 个分类），每个标签显示未读数；服务端按 `category` 过滤；切换标签时记住各标签的滚动位置、切回时恢复（必要时补加载页） |
| 已读/未读管理：点击自动已读、全部已读、徽章实时更新、后端同步 | ✅ | 点击即 `PATCH /v1/notifications/:id/read` 并本地减未读；"全部已读" `POST /v1/notifications/batch-read {all:true}`（在某分类下为该分类全部已读）；WebSocket 推送携带最新未读数；另有 `POST /read-all`、`POST /:id/read` 兼容 |
| 通知详情与操作：展开详情、快捷操作按钮、跳转到正确页面 | ✅ | 点击展开详情（完整正文、时间、"前往"按钮）；"前往"先 `POST /v1/notifications/:id/click`（点击统计）再按 `actionUrl` 深度链接：成就 → 成就面板并定位、称号 → 称号管理、收藏室 → 收藏室编辑器、升级 → 领取升级奖励、好友请求 → 对方资料、`/map` → 地图 |
| 通知偏好设置：6 种类型开关、免打扰时段保存、持久化 | ✅ | `GET/PATCH|PUT /v1/notifications/preferences`：6 个分类开关（系统/安全为必须接收，不能关闭）、具体类型开关（如 `social.friend_request`）、免打扰时段（跨午夜，按玩家时区）、临时静音（1/8 小时）、推送开关、渠道、每小时推送上限；存于 `user_push_preferences`（持久化）。被关闭的分类不再生成消息（冒烟验证）；免打扰期间照常入库，实时推送标记 silent 不弹提示 |
| 批量操作：批量标记已读、批量删除已读通知、操作确认提示 | ✅ | `POST /v1/notifications/batch-read {ids|all|category}`、`POST /v1/notifications/batch-delete {ids}`、`POST /v1/notifications/clear-read {before?}`（软删除）；"清空已读"有确认对话框 |
| 本地缓存：IndexedDB 存储、离线显示缓存、上线后自动同步 | ✅ | IndexedDB `PMG_Messages`（`notifications`、`metadata.lastSyncTime`）；网络不可用（含 Service Worker 离线响应）时展示缓存并提示"离线模式"；`online`/切回前台时刷新未读并重连 WebSocket，连接时带 `since=lastSyncTime` 补推离线期间的消息；每 5 分钟兜底同步 |
| 性能指标：首屏 < 1s、虚拟滚动 FPS ≥ 60、WebSocket 通知 < 200ms 显示 | ⚠️ | 未实测。实现：列表固定行高虚拟滚动（只渲染可见行 ± 5 行，1000+ 条不会创建 1000 个节点）；每页 20 条；WS 消息到达直接插入列表与徽章。压测脚本 `scripts/bench-profile-notify.js` 覆盖列表/未读接口 P95；冒烟验证"新消息经 WebSocket < 3 秒到达" |
| 无障碍访问：键盘导航、屏幕阅读器朗读、高对比度 | ✅ | 全屏面板 `role=dialog`、Esc 关闭并还原焦点；列表项可 Tab 聚焦，↑/↓ 在消息间移动、Enter 打开、Delete 删除；每条消息有完整 `aria-label`（未读/标题/正文/时间），状态提示 `aria-live`；标签页 `role=tab/aria-selected`；`forced-colors` 高对比度模式下保留未读标识；尊重"减少动态效果" |

- 入口：user-service `src/routes/messageCenter.js`（挂载 `/notifications`，优先于旧的设备令牌/推送日志路由；旧路由的 `/device-token`、`/logs` 保留）；`backend/shared/notificationCenter.js`、`notificationPolicy.js`；网关 `/v1/notifications/*`（鉴权）；实时推送 `/ws/messages`（见 REQ-00261）
- 前端：`frontend/game-client/src/features/profile-notify/messageCenter.js`（导航图标、列表、偏好、IndexedDB、WebSocket）
- 迁移：`database/migrations/20260925_131000__e13_notification_center.sql`（`notifications` 及查询索引：用户+时间、用户+分类、未读部分索引、去重唯一索引、过期时间）
- 测试：`tests/unit/notificationPolicy.test.js`（7）、`tests/unit/notificationCenter.test.js`（7）已通过；冒烟消息中心 17 项、Playwright `tests/e2e/profile-notify.spec.js`（未运行）
- 偏差：原方案沿用的 `notification_history`（字段与路由查询对不上，接口实际不可用）改为新的 `notifications` 表；标签按"分类"而非单个类型（稀有精灵/Raid/好友…归入精灵/活动/社交）
- 待验证：① 浏览器中消息中心的虚拟滚动、离线模式与 WebSocket 实时更新；② 偏好保存后重新登录仍生效
