# REQ-00417: 玩家会话超时智能管理与渐进式断开系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00417 |
| 标题 | 玩家会话超时智能管理与渐进式断开系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、auth-service、game-client、admin-dashboard |
| 创建时间 | 2026-07-01 19:00 |

## 需求描述

### 背景
当前系统使用固定超时时间（如 30 分钟）断开不活跃玩家会话，存在以下问题：
- 短时离开（接电话、上厕所）就被断开，用户体验差
- 长时间挂机占用服务器资源，浪费连接池
- 无法区分"暂时离开"和"真正离线"
- 高峰期会话资源紧张，无法动态调整

### 目标
实现智能会话管理系统：
1. **渐进式断开**：从活跃 → 警告 → 只读 → 挂起 → 断开
2. **智能超时判断**：基于用户行为模式动态调整超时时间
3. **会话资源优化**：释放挂起会话的服务器资源
4. **快速恢复**：支持会话快速恢复，减少重连开销
5. **运营配置**：支持不同用户等级/场景的超时策略

## 技术方案

### 1. 会话状态机

```typescript
// backend/gateway/src/session/session-state-machine.ts

enum SessionState {
  ACTIVE = 'active',           // 活跃状态
  WARNING = 'warning',         // 警告状态（即将断开）
  READ_ONLY = 'read_only',     // 只读状态（仅接收数据）
  SUSPENDED = 'suspended',     // 挂起状态（资源释放）
  DISCONNECTED = 'disconnected' // 已断开
}

interface SessionContext {
  userId: string;
  sessionId: string;
  state: SessionState;
  lastActivity: number;
  totalInactiveTime: number;
  userLevel: UserLevel;
  deviceType: DeviceType;
  connectionQuality: ConnectionQuality;
  behaviorPattern: BehaviorPattern;
}

class SessionStateMachine {
  private transitions: Map<SessionState, SessionState[]> = new Map([
    [SessionState.ACTIVE, [SessionState.WARNING]],
    [SessionState.WARNING, [SessionState.READ_ONLY, SessionState.ACTIVE]],
    [SessionState.READ_ONLY, [SessionState.SUSPENDED, SessionState.ACTIVE]],
    [SessionState.SUSPENDED, [SessionState.DISCONNECTED, SessionState.ACTIVE]],
    [SessionState.DISCONNECTED, [SessionState.ACTIVE]] // 仅恢复时
  ]);

  canTransition(from: SessionState, to: SessionState): boolean {
    return this.transitions.get(from)?.includes(to) ?? false;
  }

  nextStates(current: SessionState): SessionState[] {
    return this.transitions.get(current) ?? [];
  }
}
```

### 2. 智能超时计算器

```typescript
// backend/gateway/src/session/smart-timeout-calculator.ts

interface TimeoutConfig {
  baseTimeout: number;         // 基础超时时间（秒）
  maxTimeout: number;          // 最大超时时间
  minTimeout: number;          // 最小超时时间
  levelMultipliers: Map<UserLevel, number>;
  deviceMultipliers: Map<DeviceType, number>;
}

class SmartTimeoutCalculator {
  private config: TimeoutConfig;
  private behaviorAnalyzer: BehaviorAnalyzer;

  // 默认配置
  private defaultConfig: TimeoutConfig = {
    baseTimeout: 1800,  // 30分钟
    maxTimeout: 7200,   // 2小时
    minTimeout: 300,    // 5分钟
    levelMultipliers: new Map([
      ['free', 1.0],
      ['premium', 1.5],
      ['vip', 2.0]
    ]),
    deviceMultipliers: new Map([
      ['mobile', 1.0],
      ['tablet', 1.2],
      ['desktop', 1.3]
    ])
  };

  calculateTimeout(context: SessionContext): number {
    let timeout = this.config.baseTimeout;

    // 用户等级加成
    const levelMultiplier = this.config.levelMultipliers.get(context.userLevel) ?? 1.0;
    timeout *= levelMultiplier;

    // 设备类型加成
    const deviceMultiplier = this.config.deviceMultipliers.get(context.deviceType) ?? 1.0;
    timeout *= deviceMultiplier;

    // 行为模式调整
    const behaviorAdjustment = this.behaviorAnalyzer.getTimeoutAdjustment(context.userId);
    timeout *= behaviorAdjustment;

    // 连接质量调整
    if (context.connectionQuality === 'poor') {
      timeout *= 0.7; // 弱网环境缩短超时
    }

    // 应用边界限制
    return Math.max(
      Math.min(timeout, this.config.maxTimeout),
      this.config.minTimeout
    );
  }
}
```

### 3. 行为模式分析器

```typescript
// backend/gateway/src/session/behavior-analyzer.ts

interface BehaviorPattern {
  avgSessionDuration: number;
  typicalInactivePeriods: number[];  // 用户典型不活跃时段
  returnProbability: number;          // 短时离开后返回概率
  peakActivityHours: number[];       // 高活跃时段
  lastCalculated: number;
}

class BehaviorAnalyzer {
  private patterns: Map<string, BehaviorPattern> = new Map();
  private sessionHistory: SessionHistoryRepository;

  async analyzeUserPattern(userId: string): Promise<BehaviorPattern> {
    const history = await this.sessionHistory.getLastSessions(userId, 30); // 最近30次会话
    
    if (history.length < 3) {
      return this.getDefaultPattern();
    }

    const pattern: BehaviorPattern = {
      avgSessionDuration: this.calculateAvgDuration(history),
      typicalInactivePeriods: this.findInactivePatterns(history),
      returnProbability: this.calculateReturnProbability(history),
      peakActivityHours: this.findPeakHours(history),
      lastCalculated: Date.now()
    };

    this.patterns.set(userId, pattern);
    return pattern;
  }

  getTimeoutAdjustment(userId: string): number {
    const pattern = this.patterns.get(userId);
    if (!pattern) return 1.0;

    // 高返回概率用户延长超时
    if (pattern.returnProbability > 0.8) {
      return 1.3;
    }

    // 短会话用户缩短超时
    if (pattern.avgSessionDuration < 600) {
      return 0.8;
    }

    return 1.0;
  }

  private calculateReturnProbability(history: SessionEvent[]): number {
    const shortLeaveReturns = history.filter(e => 
      e.inactiveDuration > 60 && e.inactiveDuration < 300 && e.returned
    );
    const shortLeaves = history.filter(e => 
      e.inactiveDuration > 60 && e.inactiveDuration < 300
    );
    
    return shortLeaves.length > 0 ? shortLeaveReturns.length / shortLeaves.length : 0.5;
  }
}
```

### 4. 渐进式断开管理器

```typescript
// backend/gateway/src/session/progressive-disconnect-manager.ts

class ProgressiveDisconnectManager {
  private stateMachine: SessionStateMachine;
  private timeoutCalculator: SmartTimeoutCalculator;
  private wsManager: WebSocketManager;
  private sessionStore: SessionStore;

  // 各状态持续时间配置
  private stateDurations: Map<SessionState, number> = new Map([
    [SessionState.WARNING, 60],      // 警告状态持续60秒
    [SessionState.READ_ONLY, 120],  // 只读状态持续120秒
    [SessionState.SUSPENDED, 300]   // 挂起状态持续300秒
  ]);

  async handleInactiveSession(sessionId: string): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) return;

    const timeout = this.timeoutCalculator.calculateTimeout(session);
    const inactiveTime = Date.now() - session.lastActivity;

    // 活跃状态检查
    if (session.state === SessionState.ACTIVE && inactiveTime > timeout * 0.8) {
      await this.transitionTo(session, SessionState.WARNING);
    }

    // 其他状态转换由定时器触发
  }

  async transitionTo(session: SessionContext, newState: SessionState): Promise<void> {
    if (!this.stateMachine.canTransition(session.state, newState)) {
      return;
    }

    const oldState = session.state;
    session.state = newState;

    switch (newState) {
      case SessionState.WARNING:
        await this.sendWarning(session);
        this.scheduleTransition(session, SessionState.READ_ONLY, 60000);
        break;

      case SessionState.READ_ONLY:
        await this.enableReadOnlyMode(session);
        this.scheduleTransition(session, SessionState.SUSPENDED, 120000);
        break;

      case SessionState.SUSPENDED:
        await this.suspendSession(session);
        this.scheduleTransition(session, SessionState.DISCONNECTED, 300000);
        break;

      case SessionState.DISCONNECTED:
        await this.disconnectSession(session);
        break;
    }

    await this.sessionStore.save(session);
    this.emitStateChange(session, oldState, newState);
  }

  private async sendWarning(session: SessionContext): Promise<void> {
    this.wsManager.send(session.userId, {
      type: 'session_warning',
      data: {
        message: '您已长时间未活动，即将断开连接',
        gracePeriod: 60,
        action: 'click_or_tap_to_stay'
      }
    });
  }

  private async enableReadOnlyMode(session: SessionContext): Promise<void> {
    // 禁止发送操作，仅允许接收推送
    await this.wsManager.updatePermissions(session.sessionId, {
      canSend: false,
      canReceive: true
    });

    this.wsManager.send(session.userId, {
      type: 'session_readonly',
      data: {
        message: '会话已进入只读模式，点击恢复',
        canRecover: true
      }
    });
  }

  private async suspendSession(session: SessionContext): Promise<void> {
    // 释放游戏资源（精灵状态、地图订阅等）
    await this.resourceManager.releaseSessionResources(session.sessionId);
    
    // 保持最小连接状态
    await this.wsManager.suspend(session.sessionId);

    this.wsManager.send(session.userId, {
      type: 'session_suspended',
      data: {
        message: '会话已挂起，点击恢复',
        recoverDeadline: Date.now() + 300000
      }
    });
  }
}
```

### 5. 会话恢复系统

```typescript
// backend/gateway/src/session/session-recovery.ts

class SessionRecovery {
  private sessionSnapshotStore: SessionSnapshotStore;
  private gameStateManager: GameStateManager;

  async saveSnapshot(sessionId: string): Promise<void> {
    const snapshot = await this.captureSessionState(sessionId);
    await this.sessionSnapshotStore.save(sessionId, snapshot, {
      ttl: 3600 // 快照保留1小时
    });
  }

  async recoverSession(sessionId: string, userId: string): Promise<RecoveryResult> {
    const snapshot = await this.sessionSnapshotStore.get(sessionId);
    if (!snapshot) {
      return { success: false, reason: 'snapshot_expired' };
    }

    // 验证用户身份
    if (snapshot.userId !== userId) {
      return { success: false, reason: 'user_mismatch' };
    }

    // 快速恢复会话状态
    const newSessionId = await this.createSession(userId);
    await this.restoreSessionState(newSessionId, snapshot);

    // 重新订阅必要频道
    await this.resubscribeChannels(newSessionId, snapshot.subscriptions);

    // 发送恢复完成通知
    this.wsManager.send(userId, {
      type: 'session_recovered',
      data: {
        sessionId: newSessionId,
        recoveredAt: Date.now(),
        state: 'active'
      }
    });

    return { success: true, sessionId: newSessionId };
  }

  private async captureSessionState(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.sessionStore.get(sessionId);
    
    return {
      userId: session.userId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      subscriptions: await this.wsManager.getSubscriptions(sessionId),
      gameState: await this.gameStateManager.capture(sessionId),
      metadata: session.metadata
    };
  }
}
```

### 6. 客户端响应处理

```typescript
// frontend/src/services/session-keeper.ts

class SessionKeeper {
  private ws: WebSocket;
  private lastInteraction: number = Date.now();
  private warningModal: HTMLDivElement | null = null;

  init(): void {
    this.setupActivityListeners();
    this.setupKeepAlive();
  }

  private setupActivityListeners(): void {
    // 监听用户活动
    ['click', 'touchstart', 'keydown', 'mousemove'].forEach(event => {
      document.addEventListener(event, () => this.onUserActivity(), { passive: true });
    });

    // 页面可见性变化
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.sendKeepAlive();
      }
    });
  }

  private onUserActivity(): void {
    const now = Date.now();
    if (now - this.lastInteraction > 30000) {
      this.sendKeepAlive();
    }
    this.lastInteraction = now;

    // 关闭警告弹窗（如果存在）
    if (this.warningModal) {
      this.warningModal.remove();
      this.warningModal = null;
    }
  }

  private handleSessionWarning(data: SessionWarningData): void {
    this.warningModal = this.createWarningModal(data);
    document.body.appendChild(this.warningModal);

    // 自动续期按钮
    const extendBtn = this.warningModal.querySelector('#extend-session');
    extendBtn?.addEventListener('click', () => {
      this.sendKeepAlive();
      this.warningModal?.remove();
      this.warningModal = null;
    });
  }

  private createWarningModal(data: SessionWarningData): HTMLDivElement {
    const modal = document.createElement('div');
    modal.className = 'session-warning-modal';
    modal.innerHTML = `
      <div class="warning-content">
        <div class="warning-icon">⚠️</div>
        <h3>会话即将断开</h3>
        <p>您已长时间未活动</p>
        <div class="countdown">${data.gracePeriod}秒后断开</div>
        <button id="extend-session" class="extend-btn">继续游戏</button>
      </div>
    `;
    return modal;
  }
}
```

### 7. 监控与告警

```yaml
# monitoring/prometheus/rules/session_rules.yml

groups:
  - name: session_management
    interval: 30s
    rules:
      - alert: HighSuspendedSessionRate
        expr: |
          rate(sessions_suspended_total[5m]) / rate(sessions_created_total[5m]) > 0.3
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "会话挂起率过高"
          description: "过去10分钟内超过30%的会话被挂起，可能存在超时策略问题"

      - alert: LowRecoverySuccessRate
        expr: |
          rate(session_recovery_success_total[5m]) / rate(session_recovery_attempts_total[5m]) < 0.8
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "会话恢复成功率低"
          description: "会话恢复成功率低于80%，需检查快照系统"

      - alert: SessionResourceLeak
        expr: |
          sessions_suspended_current - sessions_released_total > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "会话资源泄漏"
          description: "挂起会话未正确释放，可能导致资源泄漏"
```

### 8. 管理端配置接口

```typescript
// backend/admin-dashboard/src/api/session-policy.ts

router.get('/api/session-policies', async (req, res) => {
  const policies = await sessionPolicyStore.getAll();
  res.json(policies);
});

router.put('/api/session-policies/:level', async (req, res) => {
  const { level } = req.params;
  const { baseTimeout, warningDuration, readOnlyDuration, suspendedDuration } = req.body;

  await sessionPolicyStore.update(level, {
    baseTimeout,
    warningDuration,
    readOnlyDuration,
    suspendedDuration
  });

  // 推送配置到所有 gateway 节点
  await configPusher.broadcast('session-policy-update', { level, ...req.body });

  res.json({ success: true });
});

// 手动调整用户超时时间
router.post('/api/users/:userId/session-timeout', async (req, res) => {
  const { userId } = req.params;
  const { timeout, reason } = req.body;

  await sessionManager.setUserTimeout(userId, timeout, {
    reason,
    operator: req.user.id,
    timestamp: Date.now()
  });

  res.json({ success: true, newTimeout: timeout });
});
```

## 验收标准

- [ ] 实现完整会话状态机（ACTIVE → WARNING → READ_ONLY → SUSPENDED → DISCONNECTED）
- [ ] 智能超时计算器根据用户等级、设备类型、行为模式动态调整超时时间
- [ ] 渐进式断开流程完整：警告通知 → 只读模式 → 挂起 → 断开
- [ ] 会话快照与恢复功能正常，恢复时间 < 2秒
- [ ] 客户端活动检测与保活机制正常工作
- [ ] 管理端可配置不同用户等级的超时策略
- [ ] Prometheus 指标正常采集：会话各状态转换次数、恢复成功率、平均超时时间
- [ ] 告警规则配置完成并触发测试通过
- [ ] 性能测试：10000 并发会话状态管理无性能问题
- [ ] 单元测试覆盖率 > 80%

## 影响范围

- `backend/gateway/src/session/` - 新增会话管理模块
- `backend/gateway/src/handlers/websocket.ts` - 修改 WebSocket 处理逻辑
- `backend/auth-service/src/session/` - 会话认证与授权
- `frontend/src/services/session-keeper.ts` - 客户端会话保活
- `frontend/src/styles/session-warning.css` - 警告弹窗样式
- `backend/admin-dashboard/src/api/session-policy.ts` - 策略配置 API
- `monitoring/prometheus/rules/session_rules.yml` - 新增监控规则

## 参考

- WebSocket 连接管理最佳实践
- 游戏会话超时策略研究
- 用户行为分析与预测模型
