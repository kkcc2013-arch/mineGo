# REQ-00026：游戏内实时推送通知系统

- **编号**：REQ-00026
- **类别**：前端体验
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、gateway、reward-service、gym-service、social-service
- **创建时间**：2026-06-05 18:00
- **依赖需求**：无

## 1. 背景与问题

当前游戏客户端缺少实时推送通知能力，玩家在以下场景无法获得即时反馈：

1. **Raid 开启通知**：附近道馆开启 Raid 时，玩家无法第一时间知晓，错过参与机会
2. **好友请求/礼物**：收到好友请求或礼物时，需要手动刷新才能看到
3. **任务完成提醒**：每日任务、成就达成时缺少即时庆祝动画
4. **精灵刷新提醒**：稀有精灵出现在附近时，玩家无感知
5. **道馆状态变更**：所属队伍道馆被攻击或失守时无告警

当前仅依赖 30 秒定时轮询刷新地图数据，延迟高、体验差、浪费带宽。

## 2. 目标

实现游戏内实时推送通知系统，提升玩家参与度和体验：

- 通知延迟降低至 1 秒内
- 支持 5 种以上通知类型
- 可配置通知偏好（可开关各类通知）
- 低功耗设计，WebSocket 连接复用

## 3. 范围

- **包含**：
  - 前端 NotificationManager 模块
  - 游戏内 Toast/Banner 通知 UI
  - 服务端推送事件定义与发布
  - 用户通知偏好设置 API
  - 通知历史记录（最近 50 条）

- **不包含**：
  - FCM/APNs 系统级推送（另作需求）
  - 邮件/SMS 通知
  - 第三方平台推送

## 4. 详细需求

### 4.1 前端 NotificationManager

```javascript
// frontend/game-client/src/game/NotificationManager.js
export class NotificationManager extends EventTarget {
  constructor(apiClient, wsClient) {
    super();
    this._api = apiClient;
    this._ws = wsClient;
    this._preferences = {};
    this._history = [];
    this._enabled = true;
  }

  // 初始化，连接 WebSocket 并订阅通知频道
  async init(userId, token);

  // 更新通知偏好
  async updatePreferences(prefs);

  // 显示游戏内通知
  showNotification(type, data);

  // 获取通知历史
  getHistory(limit = 50);

  // 清除历史
  clearHistory();
}
```

### 4.2 通知类型定义

| 类型 | 事件名 | 触发条件 | 数据结构 |
|------|--------|----------|----------|
| 稀有精灵 | `RARE_SPAWN` | 稀有度 >= 4 的精灵出现在 500m 内 | `{ speciesId, speciesName, distance, expireAt, lat, lng }` |
| Raid 开启 | `RAID_STARTED` | 附近道馆 Raid 开始 | `{ gymId, gymName, bossName, tier, expiresAt, lat, lng }` |
| 好友请求 | `FRIEND_REQUEST` | 收到好友请求 | `{ fromUserId, fromUserName }` |
| 礼物收到 | `GIFT_RECEIVED` | 好友发送礼物 | `{ fromUserId, fromUserName, giftId }` |
| 任务完成 | `QUEST_COMPLETE` | 每日任务或成就达成 | `{ questId, questName, rewards }` |
| 道馆攻击 | `GYM_UNDER_ATTACK` | 所属队伍道馆被攻击 | `{ gymId, gymName, attackerTeam }` |
| 道馆失守 | `GYM_LOST` | 道馆被敌对队伍占领 | `{ gymId, gymName, newTeam }` |

### 4.3 通知 UI 组件

```html
<!-- 游戏内通知 Banner -->
<div class="notification-banner" data-type="RARE_SPAWN">
  <div class="notif-icon">🐉</div>
  <div class="notif-content">
    <div class="notif-title">稀有精灵出现！</div>
    <div class="notif-body">小火龙 距离 120m，剩余 5 分钟</div>
  </div>
  <button class="notif-action">前往</button>
</div>
```

### 4.4 用户通知偏好 API

```
GET /v1/users/me/notification-preferences
PUT /v1/users/me/notification-preferences

Request Body:
{
  "rareSpawn": true,
  "raidStarted": true,
  "friendRequest": true,
  "giftReceived": true,
  "questComplete": true,
  "gymUnderAttack": true,
  "gymLost": false,
  "soundEnabled": true,
  "vibrationEnabled": true
}
```

### 4.5 数据库表

```sql
-- 用户通知偏好
CREATE TABLE user_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  rare_spawn BOOLEAN DEFAULT TRUE,
  raid_started BOOLEAN DEFAULT TRUE,
  friend_request BOOLEAN DEFAULT TRUE,
  gift_received BOOLEAN DEFAULT TRUE,
  quest_complete BOOLEAN DEFAULT TRUE,
  gym_under_attack BOOLEAN DEFAULT TRUE,
  gym_lost BOOLEAN DEFAULT FALSE,
  sound_enabled BOOLEAN DEFAULT TRUE,
  vibration_enabled BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 通知历史（可选，用于离线同步）
CREATE TABLE notification_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(50) NOT NULL,
  data JSONB NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notification_history_user ON notification_history(user_id, created_at DESC);
```

### 4.6 WebSocket 消息协议

```json
{
  "type": "NOTIFICATION",
  "payload": {
    "eventType": "RARE_SPAWN",
    "data": {
      "speciesId": 4,
      "speciesName": "小火龙",
      "distance": 120,
      "expireAt": "2026-06-05T18:30:00Z",
      "lat": 31.2305,
      "lng": 121.4740
    },
    "timestamp": "2026-06-05T18:00:00Z"
  }
}
```

## 5. 验收标准（可测试）

- [ ] 前端 NotificationManager 模块实现，支持所有 7 种通知类型
- [ ] 游戏内通知 Banner/Toast UI 组件，点击可跳转到对应功能
- [ ] WebSocket 连接复用 gym-service 的 `/ws/raid` 或新增独立通知频道
- [ ] 用户通知偏好设置 API 实现，支持开关各类通知
- [ ] 通知延迟 < 1 秒（从服务端事件触发到前端显示）
- [ ] 通知历史记录保存最近 50 条，支持标记已读
- [ ] 单元测试覆盖 NotificationManager 核心逻辑
- [ ] 前端测试验证通知显示和交互

## 6. 工作量估算

**M (中等)**

- 前端 NotificationManager + UI：2 天
- 后端偏好 API + WebSocket 推送：1 天
- 数据库表 + 迁移：0.5 天
- 测试 + 文档：0.5 天

## 7. 优先级理由

**P1** - 实时通知是提升玩家参与度的关键功能，直接影响日活和留存。稀有精灵通知可带动玩家即时互动，Raid 通知促进社交协作。相比 P2 功能，这是"可用"产品的核心体验要素。
