# REQ-00421: 玩家登录性能优化与快速恢复系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00421 |
| 标题 | 玩家登录性能优化与快速恢复系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、auth-service、player-service、game-client、shared/cache |
| 创建时间 | 2026-07-02 02:00 |

## 需求描述

玩家登录是进入游戏的第一步，登录性能直接影响用户留存。当前登录流程需要串行加载多个服务数据，导致登录耗时较长（约3-5秒），尤其在网络不稳定或高峰期更为明显。

### 目标
1. **登录时间优化**：将平均登录时间从3-5秒降至1秒以内
2. **断线重连加速**：实现5秒内快速恢复游戏状态
3. **数据预热**：在登录验证时预加载高频访问数据
4. **流程并行化**：将串行数据加载改为并行加载

### 问题场景
- 新玩家首次登录需加载大量初始化数据
- 老玩家登录需验证身份、加载背包、精灵、任务进度等
- 网络波动导致断线重连，重新加载耗时长
- 高峰期并发登录请求导致服务响应变慢

## 技术方案

### 1. 登录流程并行化

```typescript
// shared/login/LoginOrchestrator.ts
export class LoginOrchestrator {
  private parallelLoader: ParallelDataLoader;
  private sessionCache: SessionCacheManager;
  
  async executeLogin(request: LoginRequest): Promise<LoginResult> {
    const startTime = Date.now();
    
    // 阶段1: 并行验证与数据加载（500ms内完成）
    const [authResult, playerData, gameConfig] = await Promise.all([
      this.authenticatePlayer(request),
      this.loadPlayerData(request.playerId),
      this.loadGameConfig()
    ]);
    
    if (!authResult.success) {
      return { success: false, error: authResult.error };
    }
    
    // 阶段2: 构建登录响应（并行预热）
    const loginToken = await this.generateSessionToken(authResult, playerData);
    
    // 异步预加载次要数据（不阻塞响应）
    this.warmupSecondaryData(request.playerId).catch(e => 
      this.logger.warn('Secondary data warmup failed', e)
    );
    
    metrics.timing('login.total_duration', Date.now() - startTime);
    
    return {
      success: true,
      token: loginToken,
      player: playerData.summary,
      config: gameConfig,
      loadTime: Date.now() - startTime
    };
  }
  
  private async loadPlayerData(playerId: string): Promise<PlayerData> {
    // 使用多级缓存加速
    const cached = await this.sessionCache.get(`player:${playerId}`);
    if (cached && this.isCacheValid(cached)) {
      metrics.increment('login.cache_hit');
      return cached;
    }
    
    // 并行加载所有玩家相关数据
    const [profile, inventory, spirits, quests, friends] = await Promise.all([
      this.playerService.getProfile(playerId),
      this.inventoryService.getInventory(playerId),
      this.spiritService.getPlayerSpirits(playerId),
      this.questService.getActiveQuests(playerId),
      this.socialService.getFriendsList(playerId)
    ]);
    
    return { profile, inventory, spirits, quests, friends };
  }
}
```

### 2. 会话状态缓存管理器

```typescript
// shared/cache/SessionCacheManager.ts
export class SessionCacheManager {
  private redis: RedisClient;
  private localCache: LRUCache<string, CachedSession>;
  private readonly TTL = 3600; // 1小时
  private readonly GRACE_PERIOD = 300; // 5分钟宽限期
  
  async cacheSession(playerId: string, session: PlayerSession): Promise<void> {
    const cacheKey = `session:${playerId}`;
    const payload = {
      ...session,
      cachedAt: Date.now(),
      version: session.version
    };
    
    // 双写：本地缓存 + Redis
    await Promise.all([
      this.redis.setex(cacheKey, this.TTL, JSON.stringify(payload)),
      this.localCache.set(cacheKey, payload)
    ]);
  }
  
  async restoreSession(playerId: string): Promise<SessionRestoreResult> {
    const cacheKey = `session:${playerId}`;
    
    // 先查本地缓存
    const localHit = this.localCache.get(cacheKey);
    if (localHit && this.isSessionValid(localHit)) {
      return { source: 'local', session: localHit, restoreTime: 0 };
    }
    
    // 查询 Redis
    const redisData = await this.redis.get(cacheKey);
    if (redisData) {
      const session = JSON.parse(redisData);
      this.localCache.set(cacheKey, session);
      return { source: 'redis', session, restoreTime: 5 };
    }
    
    // 缓存未命中，从数据库重建
    return { source: 'database', session: null, restoreTime: -1 };
  }
  
  async invalidateSession(playerId: string): Promise<void> {
    const cacheKey = `session:${playerId}`;
    await Promise.all([
      this.redis.del(cacheKey),
      this.localCache.delete(cacheKey)
    ]);
  }
}
```

### 3. 断线重连快速恢复

```typescript
// gateway/handlers/ReconnectHandler.ts
export class ReconnectHandler {
  private sessionCache: SessionCacheManager;
  private stateManager: GameStateManager;
  
  async handleReconnect(connection: WebSocket, token: string): Promise<void> {
    const startTime = Date.now();
    
    // 验证 token 获取 playerId
    const decoded = await this.verifyToken(token);
    if (!decoded) {
      connection.send({ type: 'error', code: 'INVALID_TOKEN' });
      return;
    }
    
    // 尝试从缓存恢复会话
    const restoreResult = await this.sessionCache.restoreSession(decoded.playerId);
    
    if (restoreResult.source !== 'database') {
      // 缓存命中，快速恢复
      await this.fastReconnect(connection, decoded.playerId, restoreResult.session);
      metrics.timing('reconnect.fast_duration', Date.now() - startTime);
    } else {
      // 缓存未命中，完整恢复
      await this.fullReconnect(connection, decoded.playerId);
      metrics.timing('reconnect.full_duration', Date.now() - startTime);
    }
  }
  
  private async fastReconnect(
    connection: WebSocket, 
    playerId: string, 
    session: PlayerSession
  ): Promise<void> {
    // 恢复游戏状态
    await this.stateManager.restoreFromSession(playerId, session);
    
    // 发送恢复确认
    connection.send({
      type: 'reconnect_success',
      playerId,
      gameState: session.gameState,
      lastActivity: session.lastActivity,
      pendingActions: session.pendingActions
    });
    
    // 异步同步最新数据（不阻塞）
    this.syncLatestData(playerId, session.version);
  }
}
```

### 4. 数据预热策略

```typescript
// shared/preload/DataWarmupService.ts
export class DataWarmupService {
  private warmupQueue: Queue;
  
  async scheduleWarmup(playerId: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    const job = await this.warmupQueue.add('warmup', { playerId, priority }, {
      priority: priority === 'high' ? 10 : 5,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 }
    });
  }
  
  @Processor('warmup')
  async processWarmup(job: Job): Promise<void> {
    const { playerId } = job.data;
    
    // 预热精灵详情
    const spirits = await this.spiritService.getPlayerSpiritIds(playerId);
    await Promise.all(spirits.slice(0, 20).map(id => 
      this.spiritService.warmupSpiritDetails(id)
    ));
    
    // 预热地图数据
    const location = await this.locationService.getLastLocation(playerId);
    await this.mapService.warmupMapData(location.mapId);
    
    // 预热活动数据
    await this.eventService.warmupActiveEvents();
    
    metrics.increment('warmup.completed');
  }
}
```

### 5. 登录性能监控

```typescript
// shared/monitoring/LoginPerformanceTracker.ts
export class LoginPerformanceTracker {
  private histogram: Histogram;
  
  recordLoginPerformance(metrics: LoginMetrics): void {
    this.histogram.observe({
      total_duration: metrics.totalDuration,
      auth_duration: metrics.authDuration,
      data_load_duration: metrics.dataLoadDuration,
      cache_hit: metrics.cacheHit ? 1 : 0,
      parallel_efficiency: metrics.parallelEfficiency
    });
    
    // SLA 检查：登录时间 > 2秒 记录告警
    if (metrics.totalDuration > 2000) {
      this.alertManager.warn('login_slow', {
        playerId: metrics.playerId,
        duration: metrics.totalDuration,
        breakdown: metrics.breakdown
      });
    }
  }
}
```

## 验收标准

- [ ] 平均登录时间 < 1秒（P95 < 2秒）
- [ ] 断线重连恢复时间 < 5秒（缓存命中时 < 500ms）
- [ ] 登录流程并行化，至少5个数据源并行加载
- [ ] 会话缓存命中率 > 85%
- [ ] 实现本地缓存 + Redis 双级缓存
- [ ] 完整的性能监控与告警
- [ ] 数据预热任务队列正常工作
- [ ] 新老玩家登录流程分别优化
- [ ] 高峰期登录成功率 > 99.5%

## 影响范围

- `gateway/` - 登录入口、断线重连处理
- `auth-service/` - 认证逻辑优化
- `player-service/` - 玩家数据加载接口
- `shared/cache/` - 新增会话缓存管理器
- `shared/login/` - 新增登录编排器
- `shared/preload/` - 新增数据预热服务
- `game-client/` - 登录流程客户端适配

## 参考

- REQ-00417 玩家会话超时智能管理与渐进式断开系统
- REQ-00329 WebSocket 连接池优化
- 行业标准：移动游戏登录时间 SLA < 2秒
