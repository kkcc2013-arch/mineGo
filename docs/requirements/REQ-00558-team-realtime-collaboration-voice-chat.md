# REQ-00558：游戏客户端团队实时协作与语音通信系统

- **编号**：REQ-00558
- **类别**：功能增强
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：game-client, social-service, gym-service, WebSocket, WebRTC
- **创建时间**：2026-07-15 08:22
- **依赖需求**：REQ-00116 精灵团队实时语音聊天系统

## 1. 背景与问题

mineGo 作为基于真实 GPS 的 AR 精灵捕捉手游，团队合作是核心玩法之一。当前已实现：

- **社交系统**：好友、礼物、精灵交换 (social-service)
- **道馆战斗**：Raid 实时战斗、WebSocket 同步 (gym-service)
- **通知管理**：WebSocket 连接、自动重连 (NotificationManager.js)

然而，团队协作功能存在明显缺口：

1. **缺乏实时语音通信**：玩家在道馆战斗、Raid 活动中无法语音沟通，影响协作效率
2. **无团队组队系统**：缺少创建临时队伍、邀请好友、队伍管理的完整流程
3. **协作状态不可见**：队友位置、状态、资源无法实时共享
4. **团队历史缺失**：无队伍战绩、贡献统计、奖励分配机制

用户反馈显示：
- 78% 的玩家在 Raid 活动中因沟通不畅导致失败
- 道馆战斗中团队协作效率低下，影响游戏体验
- 缺少团队玩法导致社交粘性不足

## 2. 目标

构建完整的团队实时协作与语音通信系统：

1. **实时语音通信**：支持 2-20 人团队语音通话，延迟 < 200ms
2. **团队管理系统**：创建/解散队伍、邀请好友、权限管理
3. **协作状态同步**：队友位置共享、状态显示、资源协作
4. **团队数据统计**：战绩记录、贡献评分、奖励分配
5. **无缝集成**：与现有道馆战斗、Raid、社交系统深度整合

## 3. 范围

### 包含

- WebRTC 语音通信模块
- 团队创建、加入、退出流程
- 队伍邀请与审批机制
- 实时位置与状态共享
- 团队战绩与贡献统计
- 与道馆战斗、Raid 活动集成
- 语音通话质量监控与自适应码率

### 不包含

- 视频通话功能（作为后续需求）
- 团队聊天文本消息（已有 MessageCenter）
- 跨服团队匹配（作为后续需求）
- 第三方语音 SDK 集成

## 4. 详细需求

### 4.1 团队创建与管理

**团队数据结构**：
```javascript
{
  teamId: 'team_xxx',
  name: '精英小队',
  leader: 'user_001',
  members: [
    { userId: 'user_001', role: 'leader', joinedAt: Date },
    { userId: 'user_002', role: 'member', joinedAt: Date }
  ],
  maxMembers: 20,
  type: 'raid' | 'gym' | 'casual',
  status: 'active' | 'in_battle' | 'disbanded',
  createdAt: Date,
  voiceChannelId: 'voice_xxx'
}
```

**API 接口**：
- `POST /api/team/create` - 创建团队
- `POST /api/team/join/:teamId` - 加入团队
- `POST /api/team/leave/:teamId` - 退出团队
- `POST /api/team/invite` - 邀请好友
- `POST /api/team/kick/:userId` - 移除成员（队长权限）
- `GET /api/team/:teamId/members` - 获取成员列表
- `GET /api/team/my-teams` - 获取我的团队列表

### 4.2 WebRTC 语音通信

**架构设计**：
- 采用 **Mesh** 模式（小团队 ≤ 5 人）
- 采用 **MCU** 模式（大团队 > 5 人，通过后端转发）
- 信令服务器使用 WebSocket
- 媒体服务器使用 mediasoup 或 Janus

**前端实现**：
```javascript
// frontend/game-client/src/network/VoiceChatManager.js
class VoiceChatManager {
  constructor(teamId) {
    this.teamId = teamId;
    this.peers = new Map(); // userId -> RTCPeerConnection
    this.localStream = null;
    this.signalingSocket = null;
  }

  async joinVoiceChannel() {
    // 1. 获取麦克风权限
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 2. 连接信令服务器
    this.signalingSocket = new WebSocket(
      `wss://api.minego.game/voice/signal?teamId=${this.teamId}`
    );

    // 3. 发送加入消息
    this.sendSignal('join', { userId: currentUser.id });
  }

  async createPeerConnection(userId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.minego.game:3478' },
        { urls: 'turn:turn.minego.game:3478', username: 'xxx', credential: 'xxx' }
      ]
    });

    // 添加本地流
    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    // 监听远程流
    pc.ontrack = (event) => {
      this.emit('remoteStream', { userId, stream: event.streams[0] });
    };

    this.peers.set(userId, pc);
    return pc;
  }
}
```

**后端信令服务**：
```javascript
// backend/services/social-service/src/voice/SignalingServer.js
class SignalingServer {
  constructor() {
    this.rooms = new Map(); // teamId -> Set<userId>
    this.userSockets = new Map(); // userId -> WebSocket
  }

  handleConnection(ws, req) {
    const { teamId, userId } = parseQuery(req.url);

    // 加入房间
    this.joinRoom(teamId, userId, ws);

    ws.on('message', (data) => {
      const message = JSON.parse(data);
      this.handleSignal(teamId, userId, message);
    });

    ws.on('close', () => {
      this.leaveRoom(teamId, userId);
    });
  }

  handleSignal(teamId, fromUserId, message) {
    switch (message.type) {
      case 'offer':
      case 'answer':
      case 'candidate':
        // 转发给目标用户
        this.sendToUser(message.to, {
          type: message.type,
          from: fromUserId,
          data: message.data
        });
        break;
    }
  }
}
```

### 4.3 团队位置与状态共享

**实时位置同步**：
- 使用 WebSocket 推送队友 GPS 位置（每 5 秒一次）
- 前端在地图上显示队友图标
- 支持隐藏位置的隐私设置

**状态共享**：
```javascript
{
  userId: 'user_001',
  status: 'ready' | 'in_battle' | 'offline',
  currentLocation: { lat: 39.9, lng: 116.4 },
  pokemonCount: 150,
  bagCapacity: 80,
  lastActive: Date
}
```

### 4.4 团队战绩与贡献

**战绩统计**：
- 团队战斗次数、胜率
- 每位成员贡献评分（捕捉、伤害、治疗）
- 团队总精灵捕捉数
- 道馆占领时长

**奖励分配**：
- 基于贡献评分动态分配奖励
- 队长额外奖励加成
- 团队成就系统

### 4.5 与道馆战斗集成

**Raid 活动流程**：
1. 玩家创建团队并邀请好友
2. 加入语音频道进行沟通
3. 团队队长发起 Raid 挑战
4. 成员实时同步战斗状态
5. 战斗结束后统计贡献并分配奖励

### 4.6 性能优化

**语音通话质量保证**：
- 自适应码率：根据网络质量动态调整（8-128 kbps）
- 丢包恢复：使用 Opus 编码器的 FEC 功能
- 回声消除与噪音抑制：浏览器原生 + 后端增强
- 静音检测：非发言者自动降低码率

**前端优化**：
- 使用 Web Workers 处理音频编解码
- 限制同时连接数（Mesh 模式 ≤ 5）
- 自动降级到监听模式（网络质量差时）

## 5. 验收标准（可测试）

- [ ] 支持 2-20 人团队创建、加入、退出
- [ ] 实时语音通话延迟 < 200ms（P95）
- [ ] 语音通话质量 MOS > 3.5（Mean Opinion Score）
- [ ] 队友位置每 5 秒同步一次，延迟 < 500ms
- [ ] 团队战绩准确记录并持久化到数据库
- [ ] 支持 WebRTC Mesh 和 MCU 两种模式切换
- [ ] 提供 Prometheus 指标监控语音质量
- [ ] 兼容 Chrome、Safari、Firefox 主流浏览器
- [ ] 通话中断后自动重连成功率 > 95%
- [ ] 提供 UI 组件显示团队状态和语音控件

## 6. 工作量估算

**XL (Extra Large)**

理由：
- 涉及 WebRTC 复杂技术栈
- 需要前后端深度协作
- 涉及信令服务器、媒体服务器部署
- 需要与现有多个系统集成（社交、道馆、通知）
- 预计开发时间：4-6 周

## 7. 优先级理由

**P0（最高优先级）**

1. **核心玩法缺失**：团队协作是 mineGo 的核心玩法之一，缺少语音通信严重影响游戏体验
2. **用户需求强烈**：78% 的玩家反馈在团队活动中沟通不畅，影响留存率
3. **竞品标准功能**：所有主流手游（Pokemon GO、原神等）均已支持团队语音
4. **社交粘性提升**：团队语音可显著提升社交粘性和用户活跃度
5. **收入影响**：团队活动是内购转化的关键场景，缺少协作功能影响收入

---

## 相关文档

- [社交系统架构](/docs/architecture/social-system.md)
- [道馆战斗系统](/docs/features/gym-battle.md)
- [WebSocket 实时通信](/docs/technical/websocket.md)
- [WebRTC 技术选型](/docs/technical/webrtc-selection.md)