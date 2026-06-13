# REQ-00169：微服务启动器统一化与服务样板代码消除

- **编号**：REQ-00169
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、location-service、social-service、catch-service、gym-service、reward-service、payment-service、backend/shared/ServiceLauncher.js
- **创建时间**：2026-06-13 21:00
- **依赖需求**：REQ-00012

## 1. 背景与问题

当前项目存在两套服务启动模式：
- **新模式**：user-service 使用 ServiceLauncher 统一管理启动逻辑
- **旧模式**：pokemon-service、location-service、social-service、catch-service、gym-service、reward-service、payment-service 仍然手动配置 helmet、cors、metrics、logger、health、errorHandler 等

这种不一致导致：
1. **代码重复**：每个服务重复编写 50+ 行样板代码（helmet、cors、metrics、health、errorHandler）
2. **维护成本高**：修改启动逻辑需要同时修改 7+ 个服务文件
3. **配置不一致风险**：不同服务可能使用不同的中间件配置，难以保证一致性
4. **新人上手困难**：两套模式并存增加学习成本

## 2. 目标

- 统一所有微服务使用 ServiceLauncher 启动
- 消除每个服务中的重复样板代码
- 确保中间件配置一致性
- 降低维护成本，修改启动逻辑只需改一处
- 提升代码可读性和可维护性

## 3. 范围

- **包含**：
  - 迁移 pokemon-service 到 ServiceLauncher
  - 迁移 location-service 到 ServiceLauncher
  - 迁移 social-service 到 ServiceLauncher
  - 迁移 catch-service 到 ServiceLauncher
  - 迁移 gym-service 到 ServiceLauncher
  - 迁移 reward-service 到 ServiceLauncher
  - 迁移 payment-service 到 ServiceLauncher
  - 增强 ServiceLauncher 支持所有现有功能
  - 编写迁移测试

- **不包含**：
  - 新增业务功能
  - 修改 API 接口
  - 修改数据库结构

## 4. 详细需求

### 4.1 ServiceLauncher 增强

ServiceLauncher 需支持以下功能：

```javascript
// 增强后的 ServiceLauncher 配置
const service = new ServiceLauncher({
  serviceName: 'pokemon-service',
  version: '1.0.0',
  port: 8083,
  
  // 路由配置
  routes: [
    { path: '/pokemon', router: pokemonRouter },
    { path: '/evolution', router: evolutionRouter },
    // ...
  ],
  
  // 自定义初始化（可选）
  onReady: async (app) => {
    // 服务特定的初始化逻辑
    await initLocalizer();
  },
  
  // 自定义中间件（可选）
  middlewares: [
    customMiddleware1,
    customMiddleware2
  ],
  
  // 内容本地化支持（可选）
  contentLocalizer: {
    enabled: true,
    defaultLanguage: 'zh-CN'
  },
  
  // WebSocket 支持（可选）
  websocket: {
    enabled: true,
    path: '/ws'
  }
});
```

### 4.2 服务迁移规范

每个服务迁移后应：
1. 删除手动配置的 helmet、cors、express.json、logger、metrics
2. 删除手动的 health 和 metrics 端点
3. 删除手动的 errorHandler 调用
4. 使用 routes 数组注册路由
5. 使用 onReady 钩子执行初始化逻辑

### 4.3 迁移示例

**迁移前（pokemon-service）：**
```javascript
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'pokemon-service' }));
app.get('/metrics', async (req, res) => { /* ... */ });
// ... 路由注册 ...
app.use(errorHandler);
```

**迁移后：**
```javascript
const service = new ServiceLauncher({
  serviceName: 'pokemon-service',
  version: '1.0.0',
  port: 8083,
  routes: [
    { path: '/pokemon', router: pokemonRouter },
    { path: '/evolution', router: evolutionRouter },
    // ...
  ],
  onReady: async (app) => {
    await initLocalizer();
  }
});
```

## 5. 验收标准（可测试）

- [ ] 所有 7 个服务成功迁移到 ServiceLauncher
- [ ] 每个服务的样板代码行数减少 > 60%
- [ ] 所有服务的 health 端点正常响应
- [ ] 所有服务的 metrics 端点正常响应
- [ ] 所有服务的日志格式一致
- [ ] 所有服务的中间件配置一致
- [ ] 集成测试通过，所有 API 功能正常
- [ ] E2E 测试通过，服务间通信正常

## 6. 工作量估算

**M（中等）** - 需要迁移 7 个服务，但每个服务迁移相对简单，主要是删除重复代码和调整路由注册方式。

## 7. 优先级理由

这是 P1 级别的技术债重构：
1. **影响广泛**：涉及 7/8 个微服务
2. **维护成本**：当前每次修改启动逻辑需要改 7+ 个文件
3. **代码质量**：重复代码违反 DRY 原则
4. **风险可控**：不涉及业务逻辑修改，主要是结构性调整
5. **基础性工作**：完成后便于后续其他基础设施升级
