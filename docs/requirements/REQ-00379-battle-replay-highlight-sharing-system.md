# REQ-00379：精灵战斗回放与精彩时刻分享系统

- **编号**：REQ-00379
- **类别**：功能增强
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、social-service、user-service、gateway、game-client、database/migrations、backend/jobs、cdn
- **创建时间**：2026-06-30 04:00 UTC
- **依赖需求**：REQ-00269（精灵锦标赛与竞技场赛季系统）、REQ-00262（实时对战 WebSocket 连接系统）

## 1. 背景与问题

当前 mineGo 项目已实现完善的战斗系统：
- 团队战斗系统（REQ-00109）：支持 Raid Boss 挑战、团队 PVP、道馆攻坚
- 实时对战 WebSocket（REQ-00262）：支持实时战斗同步
- 锦标赛系统（REQ-00269）：支持赛季竞技和排名

但缺少**战斗回放与精彩时刻分享**功能：
1. **玩家无法回顾战斗**：战斗结束后无法查看战斗过程，无法分析战斗策略
2. **社交传播不足**：缺少分享精彩战斗瞬间的渠道，难以形成社交裂变
3. **学习资源匮乏**：新手玩家无法通过观看高手战斗学习技巧
4. **成就展示缺失**：玩家无法炫耀自己的精彩操作和战斗成就
5. **内容生态薄弱**：缺少用户生成内容（UGC），影响游戏活跃度和用户留存

根据游戏数据分析，支持回放和分享功能的 AR 游戏，用户留存率提升 25-40%，社交分享量增加 3-5 倍。

## 2. 目标

实现完整的战斗回放与精彩时刻分享系统，包括：
1. **战斗回放录制**：自动录制所有战斗过程，支持精确到帧的回放
2. **精彩时刻捕捉**：AI 自动识别高光时刻（暴击、连击、逆转等）
3. **回放观看系统**：支持回放播放、暂停、快进、慢放、视角切换
4. **社交分享功能**：支持分享到游戏内社区、社交媒体（微信、QQ、Twitter）
5. **回放管理**：个人回放库、热门回放榜单、回放搜索
6. **回放数据分析**：战斗统计、伤害分析、策略建议

**预期收益**：
- 用户次日留存率提升 15-20%
- 社交分享量提升 200%+
- 用户平均游戏时长增加 10-15 分钟/天
- 形成 UGC 内容生态，增强社区活跃度

## 3. 范围

### 包含
- 战斗数据录制模块（记录所有战斗动作、时间戳、状态变化）
- 回放数据存储系统（PostgreSQL + 对象存储 S3/OSS）
- 回放播放器（Web 前端 + 移动端）
- 精彩时刻 AI 识别引擎（规则 + 机器学习）
- 回放分享功能（短链接生成、社交媒体集成）
- 回放管理界面（个人中心、回放列表、搜索）
- 回放数据统计与分析
- 回放 CDN 加速分发

### 不包含
- 视频流媒体服务器（使用第三方 CDN）
- 实时直播功能（属于 REQ-00262 扩展）
- VR/AR 回放模式（未来版本规划）
- 回放编辑器（剪辑、配音、特效等高级编辑功能）

## 4. 详细需求

### 4.1 战斗数据录制

#### 4.1.1 录制数据结构
```javascript
{
  replayId: 'replay_abc123',
  battleId: 'battle_xyz789',
  battleType: 'pvp_duel', // pvp_duel | raid | team_battle | gym_assault
  version: '1.0',
  
  // 元数据
  metadata: {
    duration: 180, // 秒
    playerCount: 2,
    winnerId: 10001,
    createdAt: '2026-06-30T04:00:00Z',
    season: 'season_2026_q2',
    mapId: 'map_park_01'
  },
  
  // 参与者信息
  participants: [
    {
      userId: 10001,
      username: 'TrainerAsh',
      avatar: 'https://cdn.minego.com/avatars/ash.png',
      team: [
        { pokemonId: 25, name: 'Pikachu', cp: 2500, moves: ['thunder_shock', 'quick_attack'] },
        { pokemonId: 6, name: 'Charizard', cp: 3200, moves: ['flamethrower', 'dragon_claw'] }
      ],
      rating: 1850
    },
    {
      userId: 10002,
      username: 'TrainerMisty',
      avatar: 'https://cdn.minego.com/avatars/misty.png',
      team: [
        { pokemonId: 131, name: 'Lapras', cp: 2800, moves: ['ice_beam', 'surf'] }
      ],
      rating: 1820
    }
  ],
  
  // 战斗帧数据（关键帧 + 增量更新）
  frames: [
    {
      frameId: 0,
      timestamp: 0,
      state: { /* 初始状态 */ },
      actions: [
        { actor: 0, type: 'move_select', data: { move: 'thunder_shock', target: 1 } },
        { actor: 1, type: 'move_select', data: { move: 'ice_beam', target: 0 } }
      ]
    },
    {
      frameId: 1,
      timestamp: 500, // 毫秒
      delta: { /* 状态变化 */ },
      events: [
        { type: 'damage', target: 1, value: 150, critical: false },
        { type: 'damage', target: 0, value: 120, critical: true } // 暴击
      ]
    }
    // ... 更多帧
  ],
  
  // 精彩时刻标记
  highlights: [
    {
      timestamp: 45000, // 45秒
      duration: 5000,
      type: 'critical_combo', // critical_combo | comeback | clutch_save | team_wipe
      description: '连续暴击逆转战局',
      confidence: 0.95 // AI 置信度
    }
  ]
}
```

#### 4.1.2 录制策略
- **PVP 对战**：全部录制（高价值，永久保存 90 天）
- **Raid Boss**：全部录制（团队协作，永久保存 60 天）
- **道馆战斗**：胜利录制（保存 30 天）
- **练习模式**：不录制

#### 4.1.3 存储优化
- 使用关键帧 + 增量更新减少存储空间（压缩 70-80%）
- 热门回放 CDN 缓存，冷数据归档存储
- 数据库存储元数据，对象存储存储帧数据
- 压缩算法：gzip 或 brotli

### 4.2 精彩时刻 AI 识别

#### 4.2.1 规则引擎（第一版）
```javascript
const HIGHLIGHT_RULES = {
  critical_combo: {
    // 连续暴击
    condition: (events) => events.filter(e => e.critical).length >= 3,
    withinTime: 10000, // 10秒内
    priority: 'high'
  },
  
  comeback_victory: {
    // 逆转胜利
    condition: (battle) => {
      const lowHealthFrames = battle.frames.filter(f => f.state.hp < 0.2);
      return lowHealthFrames.length > 0 && battle.winner === lowHealthFrames[0].playerId;
    },
    priority: 'very_high'
  },
  
  clutch_save: {
    // 极限操作（血量 < 10% 时反杀）
    condition: (events) => events.some(e => e.hp_before < 0.1 && e.type === 'kill'),
    priority: 'high'
  },
  
  perfect_dodge: {
    // 完美闪避（连续躲避 5+ 次攻击）
    condition: (events) => events.filter(e => e.type === 'dodge').length >= 5,
    withinTime: 15000,
    priority: 'medium'
  },
  
  team_wipe: {
    // 团灭对手（短时间内击败敌方团队）
    condition: (events) => {
      const kills = events.filter(e => e.type === 'kill');
      return kills.length >= 3 && (kills.last.timestamp - kills.first.timestamp) < 30000;
    },
    priority: 'high'
  },
  
  combo_master: {
    // 连击大师（连续使用技能连击）
    condition: (events) => events.filter(e => e.type === 'combo').length >= 2,
    priority: 'medium'
  }
};
```

#### 4.2.2 机器学习增强（第二版）
- 使用 LSTM 模型预测精彩时刻
- 训练数据：人工标注的 10000+ 场战斗回放
- 特征：伤害变化率、血量曲线、技能使用频率、位置移动轨迹
- 准确率目标：≥ 85%

### 4.3 回放播放器

#### 4.3.1 播放器功能
- **播放控制**：播放、暂停、停止、重播
- **进度条**：拖动跳转、显示精彩时刻标记点
- **速度控制**：0.5x、1x、1.5x、2x
- **视角切换**：玩家视角、旁观者视角、上帝视角
- **数据叠加**：实时显示血量、能量、伤害数字
- **评论弹幕**：支持观看时发送弹幕评论

#### 4.3.2 播放器 UI
```
┌────────────────────────────────────────────────────┐
│  ⏮  ⏸  ⏮  ⏭   [===================] 45:32/60:00  │
│                                                     │
│         [精彩时刻标记点]                             │
│                                                     │
│   ┌──────────────────────────────────┐             │
│   │                                  │             │
│   │      战斗画面区域                  │             │
│   │                                  │             │
│   └──────────────────────────────────┘             │
│                                                     │
│  TrainerAsh (HP: 45%)    TrainerMisty (HP: 78%)   │
│  Pikachu CP:2500          Lapras CP:2800            │
│                                                     │
│  ⚙️ 设置  📤 分享  💬 评论  ❤️ 123                  │
└────────────────────────────────────────────────────┘
```

### 4.4 社交分享功能

#### 4.4.1 分享渠道
- **游戏内分享**：
  - 发送到聊天频道（公会、好友、世界频道）
  - 发布到个人动态墙
  - 推荐到游戏内社区（热门回放榜单）

- **社交媒体分享**：
  - 微信：生成小程序卡片分享
  - QQ：分享到 QQ 空间、QQ 群
  - Twitter：生成视频片段 + 链接
  - Facebook：自动生成视频帖子
  - TikTok：导出精彩时刻短视频

#### 4.4.2 分享格式
- **短链接**：`https://replay.minego.com/r/abc123`
- **二维码**：生成回放专属二维码
- **视频导出**：将精彩时刻导出为 MP4 视频（15-60 秒）
- **图片卡片**：生成战斗数据卡片图片

#### 4.4.3 分享追踪
- 分享次数统计
- 观看次数统计
- 点赞、评论数统计
- 分享转化率分析

### 4.5 回放管理

#### 4.5.1 个人回放库
- **我的回放**：按时间、类型、结果筛选
- **收藏回放**：收藏他人的精彩回放
- **回放标签**：自定义标签管理（如"最佳操作"、"失败教训"）

#### 4.5.2 热门回放榜单
- **本周热门**：观看数、点赞数排行
- **精选推荐**：官方推荐、编辑精选
- **分类榜单**：PVP、Raid、道馆、教学
- **搜索功能**：按玩家、精灵、战斗类型搜索

#### 4.5.3 回放过期与清理
- 普通回放：30 天后自动删除
- 精彩回放：永久保存
- 用户收藏回放：永久保存
- 锦标赛回放：保存至赛季结束 + 90 天

### 4.6 回放数据分析

#### 4.6.1 战斗统计
```javascript
{
  totalDamageDealt: 12500,
  totalDamageReceived: 9800,
  damagePerSecond: 69.4,
  criticalRate: 0.15,
  dodgeSuccessRate: 0.72,
  moveAccuracy: 0.95,
  averageTurnTime: 3.2, // 秒
  comboCount: 5,
  healingDone: 1200
}
```

#### 4.6.2 策略建议
- 根据战斗数据分析，生成 AI 建议
- 例如："建议将 Pikachu 的 quick_attack 替换为 thunder，可提升伤害 15%"
- 集成到回放播放器的侧边栏

### 4.7 数据库表设计

#### 4.7.1 battle_replays 表
```sql
CREATE TABLE battle_replays (
  id SERIAL PRIMARY KEY,
  replay_id VARCHAR(64) UNIQUE NOT NULL,
  battle_id VARCHAR(64) NOT NULL,
  battle_type VARCHAR(32) NOT NULL,
  
  -- 参与者
  player1_id INTEGER REFERENCES users(id),
  player2_id INTEGER REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  
  -- 元数据
  duration INTEGER NOT NULL, -- 秒
  frame_count INTEGER NOT NULL,
  file_size BIGINT, -- 字节
  storage_url VARCHAR(512), -- S3/OSS URL
  
  -- 精彩时刻
  highlight_count INTEGER DEFAULT 0,
  best_highlight_type VARCHAR(32),
  
  -- 统计
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  
  -- 状态
  status VARCHAR(32) DEFAULT 'active', -- active | archived | deleted
  is_featured BOOLEAN DEFAULT false,
  is_public BOOLEAN DEFAULT true,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  
  -- 索引
  INDEX idx_player1 (player1_id),
  INDEX idx_player2 (player2_id),
  INDEX idx_battle_type (battle_type),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_view_count (view_count DESC)
);
```

#### 4.7.2 replay_highlights 表
```sql
CREATE TABLE replay_highlights (
  id SERIAL PRIMARY KEY,
  replay_id VARCHAR(64) REFERENCES battle_replays(replay_id),
  
  highlight_type VARCHAR(32) NOT NULL,
  start_frame INTEGER NOT NULL,
  end_frame INTEGER NOT NULL,
  start_time INTEGER NOT NULL, -- 毫秒
  end_time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  
  description TEXT,
  confidence FLOAT, -- AI 置信度
  
  -- 统计
  view_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_replay (replay_id),
  INDEX idx_type (highlight_type)
);
```

#### 4.7.3 replay_shares 表
```sql
CREATE TABLE replay_shares (
  id SERIAL PRIMARY KEY,
  replay_id VARCHAR(64) REFERENCES battle_replays(replay_id),
  user_id INTEGER REFERENCES users(id),
  
  platform VARCHAR(32) NOT NULL, -- wechat | qq | twitter | internal
  share_type VARCHAR(32), -- link | video | image
  
  short_code VARCHAR(16) UNIQUE, -- 短链接码
  share_url VARCHAR(256),
  
  view_count INTEGER DEFAULT 0,
  
  shared_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  
  INDEX idx_replay (replay_id),
  INDEX idx_user (user_id),
  INDEX idx_short_code (short_code)
);
```

### 4.8 API 接口设计

#### 4.8.1 创建回放
```
POST /api/v1/replays
Body: { battleId, battleType, frames, participants, highlights }
Response: { replayId, status }
```

#### 4.8.2 获取回放数据
```
GET /api/v1/replays/:replayId
Response: { metadata, frames: URL, highlights }
```

#### 4.8.3 获取精彩时刻
```
GET /api/v1/replays/:replayId/highlights
Response: { highlights: [...] }
```

#### 4.8.4 分享回放
```
POST /api/v1/replays/:replayId/share
Body: { platform: 'wechat', highlightId: 'abc' }
Response: { shareUrl, shortCode, qrCode }
```

#### 4.8.5 热门回放榜单
```
GET /api/v1/replays/trending?period=week&type=pvp&limit=20
Response: { replays: [...] }
```

#### 4.8.6 用户回放列表
```
GET /api/v1/users/:userId/replays?type=pvp&result=win&limit=50
Response: { replays: [...] }
```

### 4.9 性能要求

- 回放加载时间：< 2 秒（首帧）
- 回放播放流畅度：≥ 30 FPS
- 精彩时刻识别延迟：< 1 秒
- 分享链接生成时间：< 500ms
- 视频导出时间：< 10 秒（30 秒精彩时刻）
- 存储成本：每场回放 < 500KB（压缩后）

### 4.10 监控指标

- `minego_replay_total{type, status}`：回放总数
- `minego_replay_view_total{replay_type}`：回放观看次数
- `minego_replay_share_total{platform}`：回放分享次数
- `minego_replay_size_bytes{type}`：回放文件大小
- `minego_highlight_detected_total{type}`：精彩时刻识别数
- `minego_replay_load_duration_seconds`：回放加载延迟
- `minego_video_export_duration_seconds`：视频导出延迟

## 5. 验收标准（可测试）

- [ ] **回放录制**：所有 PVP 对战自动录制，数据完整性验证通过
- [ ] **回放播放**：播放器支持播放、暂停、快进、速度控制
- [ ] **精彩时刻识别**：AI 自动识别至少 6 种精彩时刻类型，准确率 ≥ 80%
- [ ] **社交分享**：支持分享到微信、QQ、Twitter，生成短链接和二维码
- [ ] **热门榜单**：热门回放榜单按观看数、点赞数排序正确
- [ ] **回放搜索**：按玩家、精灵、战斗类型搜索功能正常
- [ ] **性能要求**：回放加载时间 < 2 秒，播放流畅度 ≥ 30 FPS
- [ ] **存储优化**：压缩后回放大小 < 500KB
- [ ] **数据持久化**：回放数据在 PostgreSQL 和对象存储正确存储
- [ ] **单元测试**：核心模块单元测试覆盖率 ≥ 85%
- [ ] **集成测试**：回放录制-存储-播放-分享全链路测试通过

## 6. 工作量估算

**L (Large)**

理由：
- 涉及多个服务：gym-service（录制）、social-service（分享）、user-service（权限）
- 前端播放器开发工作量较大（Web + 移动端）
- 精彩时刻 AI 识别算法需要调优
- 视频导出功能需要 FFmpeg 集成
- 存储和 CDN 配置复杂
- 预估开发时间：10-15 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **用户粘性**：回放功能是增强用户留存的关键功能，留存率提升 15-20%
2. **社交裂变**：分享功能可以带来自然流量，是低成本获客渠道
3. **竞争优势**：同类 AR 游戏中，支持回放和分享的产品更具竞争力
4. **生态建设**：UGC 内容可以形成社区生态，提升长期价值
5. **数据价值**：回放数据可用于分析玩家行为，优化游戏平衡性

相比 P0 需求（安全、稳定、合规），此需求属于功能增强，但对项目"可用"后的"好用"阶段至关重要。

## 8. 风险与依赖

### 风险
- 存储成本：大量回放数据可能增加存储成本（需压缩优化）
- 视频导出性能：FFmpeg 处理可能占用较多 CPU（需异步队列）
- AI 准确率：精彩时刻识别可能误报（需持续训练优化）

### 依赖
- REQ-00269（锦标赛系统）：需要赛季回放功能
- REQ-00262（实时对战 WebSocket）：需要实时数据流
- CDN 服务：需要配置对象存储和 CDN 加速
- FFmpeg：视频导出功能依赖 FFmpeg

## 9. 后续扩展

- **回放编辑器**：支持剪辑、配音、特效等高级编辑
- **实时直播**：支持战斗实时直播功能
- **VR 回放**：支持 VR 设备观看回放
- **AI 解说**：自动生成战斗解说语音
- **回放挑战**：允许玩家挑战他人回放中的操作
