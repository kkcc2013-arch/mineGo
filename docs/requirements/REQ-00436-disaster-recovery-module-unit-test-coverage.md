# REQ-00436：灾备模块单元测试覆盖系统

- **编号**：REQ-00436
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/disasterRecovery、backend/tests/disasterRecovery
- **创建时间**：2026-07-06 07:00 UTC
- **依赖需求**：REQ-00375（跨区域灾备自动化切换系统）

## 1. 背景与问题

mineGo 项目已实现完整的跨区域灾备自动化切换系统（REQ-00375），包含：

- PostgreSQLReplicationManager.js（342行）- PostgreSQL 主从复制管理
- RedisGeoReplication.js（359行）- Redis 跨区域同步
- GSLBController.js（377行）- 全局负载均衡控制器
- DisasterRecoveryEngine.js（666行）- 灾备自动决策引擎
- DrillManager.js（277行）- 灾备演练管理器
- FailoverController.js（460行）- 故障转移控制器
- HealthChecker.js（290行）- 健康检查器
- KafkaMirrorMaker.js（235行）- Kafka 跨区域同步
- DatabaseSync.js（220行）- 数据库同步

**总代码量超过 3000 行，但缺乏单元测试覆盖**。

当前测试缺口：
1. **灾备核心逻辑无测试**：故障切换决策、健康检查、RTO/RPO 计算、演练调度等关键逻辑未验证
2. **数据同步模块无测试**：PostgreSQL/Redis/Kafka 跨区域同步逻辑未覆盖
3. **配置与边界条件无测试**：阈值判断、超时处理、错误恢复等边界场景缺失
4. **回调机制无测试**：onFailoverStart/onFailoverComplete/onFailoverFailed 等回调未验证

灾备系统是项目的高可用核心，测试覆盖不足将导致：
- 故障切换逻辑错误风险
- 数据同步异常未发现
- RTO/RPO 目标无法验证
- 生产环境部署信心不足

## 2. 目标

为灾备模块建立完整的单元测试覆盖，实现：

1. **测试覆盖率 > 80%**：灾备核心模块（DisasterRecoveryEngine、PostgreSQLReplicationManager、RedisGeoReplication、DrillManager）测试覆盖率达到 80%+
2. **关键路径全覆盖**：故障切换、健康检查、数据同步、演练管理等核心流程 100% 覆盖
3. **边界条件测试**：阈值判断、超时处理、错误恢复、配置异常等场景全覆盖
4. **自动化 CI 集成**：测试集成到 CI/CD 流程，每次提交自动运行
5. **测试可维护性**：清晰的测试组织、Mock 隔离、测试数据管理

## 3. 范围

### 包含
- PostgreSQLReplicationManager 单元测试（复制状态检查、主从切换、RPO 计算）
- RedisGeoReplication 单元测试（同步状态、故障切换、偏移量计算）
- GSLBController 单元测试（流量策略、DNS 更新、多端点管理）
- DisasterRecoveryEngine 单元测试（健康检查、故障决策、切换执行、RTO/RPO 监控）
- DrillManager 单元测试（演练调度、执行、回切、历史管理）
- FailoverController 单元测试（故障转移逻辑、状态管理）
- HealthChecker 单元测试（服务健康检查、超时处理）
- KafkaMirrorMaker 单元测试（消息同步、消费者切换）
- DatabaseSync 单元测试（数据库同步、冲突处理）

### 不包含
- 灾备 E2E 测试（需单独需求）
- 灾备集成测试（需单独需求）
- 灾备性能测试（需单独需求）

## 4. 详细需求

### 4.1 PostgreSQLReplicationManager 测试

```javascript
// backend/tests/disasterRecovery/PostgreSQLReplicationManager.test.js

const PostgreSQLReplicationManager = require('../../shared/disasterRecovery/PostgreSQLReplicationManager');
const { Pool } = require('pg');

// Mock pg Pool
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn()
  }))
}));

describe('PostgreSQLReplicationManager', () => {
  let manager;
  let mockPool;

  beforeEach(() => {
    manager = new PostgreSQLReplicationManager({
      primary: { host: 'localhost', port: 5432 },
      standby: { host: 'standby', port: 5432 },
      replicationLagThreshold: 1000
    });
    mockPool = manager.primaryPool;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize()', () => {
    it('应成功初始化并测试主库连接', async () => {
      mockPool.connect.mockResolvedValue({});
      await manager.initialize();
      expect(mockPool.connect).toHaveBeenCalled();
      expect(manager._isInitialized).toBe(true);
    });

    it('主库连接失败应抛出错误', async () => {
      mockPool.connect.mockRejectedValue(new Error('Connection failed'));
      await expect(manager.initialize()).rejects.toThrow('Connection failed');
    });
  });

  describe('checkReplicationStatus()', () => {
    it('应返回复制状态并记录延迟', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{
          client_addr: '192.168.1.2',
          state: 'streaming',
          sync_state: 'sync',
          replication_lag_ms: 500
        }]
      });

      const status = await manager.checkReplicationStatus();
      expect(status).toHaveLength(1);
      expect(status[0].state).toBe('streaming');
      expect(status[0].replication_lag_ms).toBe(500);
    });

    it('复制延迟超过阈值应触发告警', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{
          client_addr: '192.168.1.2',
          state: 'streaming',
          replication_lag_ms: 5000 // 超过阈值
        }]
      });

      await manager.checkReplicationStatus();
      // 验证告警被发送（通过 Mock 告警服务）
    });
  });

  describe('promoteStandby()', () => {
    it('应成功将 Standby 提升为主库', async () => {
      const standbyClient = {
        connect: jest.fn().mockResolvedValue(),
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: true }] }) // 检查状态
          .mockResolvedValueOnce({ rows: [] }) // pg_promote
          .mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: false }] }), // 验证
        end: jest.fn()
      };

      // Mock standby 连接
      manager.standbyPool = standbyClient;

      const result = await manager.promoteStandby();
      expect(result.success).toBe(true);
      expect(standbyClient.query).toHaveBeenCalledWith('SELECT pg_promote()');
    });

    it('Standby 已是主库应返回成功', async () => {
      const standbyClient = {
        connect: jest.fn().mockResolvedValue(),
        query: jest.fn().mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: false }] }),
        end: jest.fn()
      };
      manager.standbyPool = standbyClient;

      const result = await manager.promoteStandby();
      expect(result.success).toBe(true);
      expect(result.alreadyPrimary).toBe(true);
    });

    it('切换失败应抛出错误', async () => {
      const standbyClient = {
        connect: jest.fn().mockResolvedValue(),
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ pg_is_in_recovery: true }] })
          .mockRejectedValueOnce(new Error('Promote failed')),
        end: jest.fn()
      };
      manager.standbyPool = standbyClient;

      await expect(manager.promoteStandby()).rejects.toThrow('Promote failed');
    });
  });

  describe('getRPO()', () => {
    it('应正确计算 RPO', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { replication_lag_ms: 100 },
          { replication_lag_ms: 200 }
        ]
      });

      const rpo = await manager.getRPO();
      expect(rpo.rpoMs).toBe(200); // 最大延迟
      expect(rpo.withinTarget).toBe(true);
    });

    it('无复制连接应返回 null', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const rpo = await manager.getRPO();
      expect(rpo.rpoMs).toBeNull();
    });
  });
});
```

### 4.2 RedisGeoReplication 测试

```javascript
// backend/tests/disasterRecovery/RedisGeoReplication.test.js

const RedisGeoReplication = require('../../shared/disasterRecovery/RedisGeoReplication');
const Redis = require('ioredis');

// Mock ioredis
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  info: jest.fn(),
  ping: jest.fn(),
  slaveof: jest.fn(),
  replicaof: jest.fn()
})));

describe('RedisGeoReplication', () => {
  let geoRep;
  let mockPrimary;
  let mockStandby;

  beforeEach(() => {
    geoRep = new RedisGeoReplication({
      primaryHost: 'localhost',
      standbyHost: 'standby',
      syncPort: 6379
    });
  });

  describe('initialize()', () => {
    it('应成功初始化连接', async () => {
      mockPrimary = { info: jest.fn().mockResolvedValue('role:master') };
      mockStandby = { info: jest.fn().mockResolvedValue('role:slave') };
      
      geoRep.primary = mockPrimary;
      geoRep.standby = mockStandby;

      await geoRep.initialize();
      expect(mockPrimary.info).toHaveBeenCalled();
    });
  });

  describe('checkSyncStatus()', () => {
    it('应正确解析复制偏移量', async () => {
      mockPrimary = {
        info: jest.fn().mockResolvedValue('role:master\nmaster_repl_offset:1000')
      };
      mockStandby = {
        info: jest.fn().mockResolvedValue('role:slave\nmaster_repl_offset:800')
      };

      geoRep.primary = mockPrimary;
      geoRep.standby = mockStandby;

      const status = await geoRep.checkSyncStatus();
      expect(status.primaryOffset).toBe(1000);
      expect(status.standbyOffset).toBe(800);
      expect(status.lag).toBe(200);
    });

    it('偏移量差小于阈值应返回 withinTarget=true', async () => {
      mockPrimary = {
        info: jest.fn().mockResolvedValue('master_repl_offset:100')
      };
      mockStandby = {
        info: jest.fn().mockResolvedValue('master_repl_offset:99')
      };

      geoRep.primary = mockPrimary;
      geoRep.standby = mockStandby;

      const status = await geoRep.checkSyncStatus();
      expect(status.withinTarget).toBe(true);
    });
  });

  describe('failover()', () => {
    it('应成功执行故障切换', async () => {
      mockPrimary = { ping: jest.fn().mockRejectedValue(new Error('Timeout')) };
      mockStandby = {
        slaveof: jest.fn().mockResolvedValue(),
        info: jest.fn().mockResolvedValue('role:master')
      };

      geoRep.primary = mockPrimary;
      geoRep.standby = mockStandby;

      const result = await geoRep.failover();
      expect(result.success).toBe(true);
      expect(mockStandby.slaveof).toHaveBeenCalledWith('NO', 'ONE');
    });

    it('主节点仍可用应记录警告', async () => {
      mockPrimary = { ping: jest.fn().mockResolvedValue('PONG') };
      mockStandby = {
        slaveof: jest.fn().mockResolvedValue(),
        info: jest.fn().mockResolvedValue('role:master')
      };

      geoRep.primary = mockPrimary;
      geoRep.standby = mockStandby;

      const result = await geoRep.failover();
      expect(result.success).toBe(true);
      // 验证日志警告
    });
  });

  describe('_parseOffset()', () => {
    it('应正确解析偏移量', () => {
      const offset = geoRep._parseOffset('role:master\nmaster_repl_offset:12345');
      expect(offset).toBe(12345);
    });

    it('无匹配应返回 0', () => {
      const offset = geoRep._parseOffset('role:master');
      expect(offset).toBe(0);
    });
  });
});
```

### 4.3 DisasterRecoveryEngine 测试

```javascript
// backend/tests/disasterRecovery/DisasterRecoveryEngine.test.js

const DisasterRecoveryEngine = require('../../shared/disasterRecovery/DisasterRecoveryEngine');

// Mock 子组件
jest.mock('../../shared/disasterRecovery/PostgreSQLReplicationManager');
jest.mock('../../shared/disasterRecovery/RedisGeoReplication');
jest.mock('../../shared/disasterRecovery/GSLBController');

describe('DisasterRecoveryEngine', () => {
  let engine;
  let mockPgManager;
  let mockRedisGeo;
  let mockGslb;

  beforeEach(() => {
    engine = new DisasterRecoveryEngine({
      primaryRegion: 'beijing',
      standbyRegion: 'shanghai',
      rtoTarget: 300000,
      rpoTarget: 60000,
      healthCheckInterval: 10000,
      failureThreshold: 3,
      recoveryThreshold: 5,
      onFailoverStart: jest.fn(),
      onFailoverComplete: jest.fn(),
      onFailoverFailed: jest.fn()
    });

    mockPgManager = engine.pgManager;
    mockRedisGeo = engine.redisGeo;
    mockGslb = engine.gslb;
  });

  afterEach(() => {
    engine.monitors?.forEach(timer => clearInterval(timer));
    jest.clearAllMocks();
  });

  describe('start()', () => {
    it('应成功启动所有监控', async () => {
      mockPgManager.initialize.mockResolvedValue();
      mockPgManager.startMonitoring.mockResolvedValue();
      mockRedisGeo.initialize.mockResolvedValue();

      await engine.start();

      expect(mockPgManager.initialize).toHaveBeenCalled();
      expect(mockPgManager.startMonitoring).toHaveBeenCalled();
      expect(mockRedisGeo.initialize).toHaveBeenCalled();
      expect(engine.monitors.size).toBeGreaterThan(0);
    });

    it('初始化失败应抛出错误', async () => {
      mockPgManager.initialize.mockRejectedValue(new Error('Init failed'));
      
      await expect(engine.start()).rejects.toThrow('Init failed');
    });
  });

  describe('performHealthCheck()', () => {
    it('所有服务健康应返回 true', async () => {
      // Mock 健康检查
      mockPgManager.checkReplicationStatus.mockResolvedValue([{ healthy: true }]);
      mockRedisGeo.checkSyncStatus.mockResolvedValue({ withinTarget: true });

      const checks = await engine.performHealthCheck();
      expect(checks.allHealthy).toBe(true);
    });

    it('关键服务失败应触发故障计数', async () => {
      mockPgManager.checkReplicationStatus.mockRejectedValue(new Error('PG down'));

      await engine.performHealthCheck();
      expect(engine.failureCounts.size).toBeGreaterThan(0);
    });

    it('达到阈值应触发故障切换', async () => {
      mockPgManager.checkReplicationStatus.mockRejectedValue(new Error('PG down'));
      
      // 模拟连续失败
      for (let i = 0; i < engine.failureThreshold; i++) {
        await engine.performHealthCheck();
      }

      expect(engine.failoverInProgress).toBe(true);
    });
  });

  describe('triggerFailover()', () => {
    it('应成功执行故障切换流程', async () => {
      mockGslb.setTrafficPolicy.mockResolvedValue();
      mockPgManager.promoteStandby.mockResolvedValue({ success: true });
      mockRedisGeo.failover.mockResolvedValue({ success: true });

      const result = await engine.triggerFailover(['postgres']);

      expect(result.success).toBe(true);
      expect(mockGslb.setTrafficPolicy).toHaveBeenCalledWith('standby-only');
      expect(mockPgManager.promoteStandby).toHaveBeenCalled();
      expect(mockRedisGeo.failover).toHaveBeenCalled();
    });

    it('切换失败应调用 onFailoverFailed 回调', async () => {
      mockGslb.setTrafficPolicy.mockRejectedValue(new Error('GSLB failed'));

      await expect(engine.triggerFailover(['test']))
        .rejects.toThrow('GSLB failed');
      
      expect(engine.options.onFailoverFailed).toHaveBeenCalled();
    });

    it('切换成功应调用 onFailoverComplete 回调', async () => {
      mockGslb.setTrafficPolicy.mockResolvedValue();
      mockPgManager.promoteStandby.mockResolvedValue({ success: true });
      mockRedisGeo.failover.mockResolvedValue({ success: true });

      await engine.triggerFailover(['test']);
      
      expect(engine.options.onFailoverComplete).toHaveBeenCalled();
    });

    it('已在切换中应忽略重复请求', async () => {
      engine.failoverInProgress = true;
      
      await engine.triggerFailover(['test']);
      
      // 不应执行任何操作
      expect(mockGslb.setTrafficPolicy).not.toHaveBeenCalled();
    });
  });

  describe('checkRPO()', () => {
    it('应返回 RPO 状态', async () => {
      mockPgManager.getRPO.mockResolvedValue({ rpoMs: 500, withinTarget: true });

      const rpo = await engine.checkRPO();
      expect(rpo.rpoMs).toBe(500);
      expect(rpo.withinTarget).toBe(true);
    });

    it('RPO 超标应记录警告', async () => {
      mockPgManager.getRPO.mockResolvedValue({ rpoMs: 120000, withinTarget: false });

      await engine.checkRPO();
      // 验证日志警告
    });
  });

  describe('getStatus()', () => {
    it('应返回当前状态', () => {
      const status = engine.getStatus();
      expect(status.primaryRegion).toBe('beijing');
      expect(status.standbyRegion).toBe('shanghai');
      expect(status.activeRegion).toBe('beijing');
      expect(status.rtoTarget).toBe(300000);
      expect(status.rpoTarget).toBe(60000);
    });

    it('已切换应返回备区域为活跃区域', () => {
      engine.isFailedOver = true;
      const status = engine.getStatus();
      expect(status.activeRegion).toBe('shanghai');
    });
  });

  describe('stop()', () => {
    it('应停止所有监控并关闭连接', async () => {
      mockPgManager.close.mockResolvedValue();
      mockRedisGeo.close.mockResolvedValue();

      await engine.start();
      await engine.stop();

      expect(engine.monitors.size).toBe(0);
      expect(mockPgManager.close).toHaveBeenCalled();
      expect(mockRedisGeo.close).toHaveBeenCalled();
    });
  });
});
```

### 4.4 DrillManager 测试

```javascript
// backend/tests/disasterRecovery/DrillManager.test.js

const DrillManager = require('../../shared/disasterRecovery/DrillManager');

describe('DrillManager', () => {
  let drillManager;
  let mockFailoverController;

  beforeEach(() => {
    mockFailoverController = {
      failover: jest.fn().mockResolvedValue({ duration: 5000 })
    };

    drillManager = new DrillManager(mockFailoverController, {
      scheduleInterval: 7 * 24 * 60 * 60 * 1000,
      maxDrillDuration: 1800000,
      autoRollback: true
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (drillManager.activeDrill) {
      drillManager.activeDrill = null;
    }
  });

  describe('scheduleDrill()', () => {
    it('应成功调度演练', async () => {
      const drill = await drillManager.scheduleDrill({
        type: 'planned',
        duration: 1800000,
        createdBy: 'admin'
      });

      expect(drill.id).toBeDefined();
      expect(drill.type).toBe('planned');
      expect(drill.status).toBe('scheduled');
    });
  });

  describe('startDrill()', () => {
    it('应成功执行演练', async () => {
      const drill = await drillManager.scheduleDrill({ type: 'full' });
      const result = await drillManager.startDrill(drill.id);

      expect(result.success).toBe(true);
      expect(result.rto).toBeDefined();
      expect(mockFailoverController.failover).toHaveBeenCalled();
    });

    it('已有演练进行中应拒绝', async () => {
      drillManager.activeDrill = { id: 'existing' };
      
      await expect(drillManager.startDrill('new-id'))
        .rejects.toThrow('already in progress');
    });

    it('演练失败应记录状态', async () => {
      mockFailoverController.failover.mockRejectedValue(new Error('Failover failed'));

      const drill = await drillManager.scheduleDrill({ type: 'full' });
      
      await expect(drillManager.startDrill(drill.id))
        .rejects.toThrow('Failover failed');
      
      expect(drillManager.activeDrill.status).toBe('failed');
    });
  });

  describe('rollbackDrill()', () => {
    it('应成功回切演练', async () => {
      const drill = await drillManager.scheduleDrill({ type: 'full' });
      await drillManager.startDrill(drill.id);

      const result = await drillManager.rollbackDrill(drill.id);

      expect(result.status).toBe('completed');
      expect(result.totalDuration).toBeDefined();
      expect(mockFailoverController.failover).toHaveBeenCalledTimes(2); // 切换 + 回切
    });

    it('无活跃演练应拒绝', async () => {
      await expect(drillManager.rollbackDrill('invalid-id'))
        .rejects.toThrow('No active drill');
    });
  });

  describe('cancelDrill()', () => {
    it('应成功取消演练', async () => {
      const drill = await drillManager.scheduleDrill({ type: 'full' });
      await drillManager.startDrill(drill.id);

      const result = await drillManager.cancelDrill(drill.id);

      expect(result.status).toBe('cancelled');
      expect(drillManager.activeDrill).toBeNull();
    });
  });

  describe('getDrillHistory()', () => {
    it('应返回演练历史', async () => {
      // 执行并完成演练
      const drill = await drillManager.scheduleDrill({ type: 'full' });
      await drillManager.startDrill(drill.id);
      await drillManager.rollbackDrill(drill.id);

      const history = drillManager.getDrillHistory(10);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].status).toBe('completed');
    });
  });

  describe('getActiveDrill()', () => {
    it('应返回当前活跃演练', async () => {
      const drill = await drillManager.scheduleDrill({ type: 'full' });
      await drillManager.startDrill(drill.id);

      const active = drillManager.getActiveDrill();
      expect(active.id).toBe(drill.id);
      expect(active.status).toBe('running');
    });

    it('无活跃演练应返回 null', () => {
      const active = drillManager.getActiveDrill();
      expect(active).toBeNull();
    });
  });
});
```

### 4.5 GSLBController 测试

```javascript
// backend/tests/disasterRecovery/GSLBController.test.js

const GSLBController = require('../../shared/disasterRecovery/GSLBController');

describe('GSLBController', () => {
  let gslb;

  beforeEach(() => {
    gslb = new GSLBController({
      provider: 'cloudflare',
      primaryDomain: 'api.minego.game',
      endpoints: {
        beijing: 'beijing.lb.minego.game',
        shanghai: 'shanghai.lb.minego.game'
      }
    });
  });

  describe('setTrafficPolicy()', () => {
    it('primary-active 应指向主区域', async () => {
      const result = await gslb.setTrafficPolicy('primary-active');
      expect(result.success).toBe(true);
      expect(gslb.currentActive).toBe('beijing');
    });

    it('standby-active 应指向备区域', async () => {
      const result = await gslb.setTrafficPolicy('standby-active');
      expect(result.success).toBe(true);
      expect(gslb.currentActive).toBe('shanghai');
    });

    it('standby-only 应停止主区域流量', async () => {
      const result = await gslb.setTrafficPolicy('standby-only');
      expect(result.success).toBe(true);
      expect(gslb.currentActive).toBe('shanghai');
    });

    it('未知策略应抛出错误', async () => {
      await expect(gslb.setTrafficPolicy('invalid'))
        .rejects.toThrow('未知的流量策略');
    });
  });

  describe('getTrafficStatus()', () => {
    it('应返回当前流量状态', () => {
      const status = gslb.getTrafficStatus();
      expect(status.domain).toBe('api.minego.game');
      expect(status.activeEndpoint).toBeDefined();
      expect(status.allEndpoints).toBeDefined();
    });
  });
});
```

### 4.6 测试组织结构

```
backend/tests/disasterRecovery/
├── PostgreSQLReplicationManager.test.js  (~150行)
├── RedisGeoReplication.test.js           (~120行)
├── GSLBController.test.js                (~80行)
├── DisasterRecoveryEngine.test.js        (~250行)
├── DrillManager.test.js                  (~120行)
├── FailoverController.test.js            (~100行)
├── HealthChecker.test.js                 (~80行)
├── KafkaMirrorMaker.test.js              (~80行)
├── DatabaseSync.test.js                  (~60行)
├── mocks/
│   ├── pg.mock.js                        (Mock PostgreSQL)
│   ├── redis.mock.js                     (Mock ioredis)
│   ├── fetch.mock.js                     (Mock fetch API)
│   └── k8s.mock.js                       (Mock Kubernetes API)
└── utils/
    ├── testHelpers.js                    (测试辅助函数)
    └── setup.js                          (测试环境设置)
```

### 4.7 CI 集成

```yaml
# .github/workflows/disaster-recovery-tests.yml
name: Disaster Recovery Tests

on:
  push:
    paths:
      - 'backend/shared/disasterRecovery/**'
      - 'backend/tests/disasterRecovery/**'
  pull_request:
    paths:
      - 'backend/shared/disasterRecovery/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:disaster-recovery -- --coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: coverage/disaster-recovery/lcov.info
          flags: disaster-recovery
```

## 5. 验收标准（可测试）

- [ ] PostgreSQLReplicationManager 测试覆盖率 > 80%
- [ ] RedisGeoReplication 测试覆盖率 > 80%
- [ ] GSLBController 测试覆盖率 > 80%
- [ ] DisasterRecoveryEngine 测试覆盖率 > 80%
- [ ] DrillManager 测试覆盖率 > 80%
- [ ] 所有测试通过（npm run test:disaster-recovery）
- [ ] CI 流程自动运行测试
- [ ] 测试覆盖报告上传到 codecov
- [ ] 关键路径（故障切换、健康检查、演练）100% 覆盖
- [ ] 边界条件（阈值、超时、错误）全覆盖
- [ ] Mock 隔离外部依赖（pg、redis、fetch、k8s）

## 6. 工作量估算

**L**（大型），理由：
- 9 个核心模块需要测试
- 每个模块平均 100+ 行测试代码
- 需要创建完整的 Mock 体系
- 需要集成 CI 流程
- 预估工时：4-6 人天

## 7. 优先级理由

**P1**，理由：
1. 灾备系统是项目高可用核心（P0 需求 REQ-00375 已完成）
2. 测试覆盖不足将导致生产环境部署风险
3. 故障切换逻辑错误可能导致服务完全不可用
4. 测试覆盖是"项目可用"判定的重要维度（权重10%）
5. 对项目可用性的贡献：验证灾备逻辑正确性，提升生产部署信心