# REQ-00022：集成测试框架与 API 端到端测试覆盖

- **编号**：REQ-00022
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/tests/integration、backend/tests/e2e、所有微服务、GitHub Actions
- **创建时间**：2026-06-05 14:35
- **依赖需求**：REQ-00004

## 1. 背景与问题

当前项目仅有 95 个单元测试，缺少集成测试和 E2E 测试。这导致：

1. **服务间交互未验证**：微服务之间的 HTTP 调用、Kafka 消息传递、Redis 缓存操作未测试
2. **数据库操作未覆盖**：PostgreSQL/PostGIS 查询、事务、迁移未集成测试
3. **业务流程未端到端验证**：完整的"用户注册→捕捉精灵→道馆战斗→支付"链路未测试
4. **CI 无覆盖率门槛**：无法阻止低质量代码合并

## 2. 目标

建立完整的集成测试和 E2E 测试体系，确保：
- 关键业务流程端到端可验证
- 服务间交互正确性有保障
- CI 流程强制测试覆盖率 ≥ 80%

## 3. 范围

- **包含**：
  - 集成测试框架搭建（Jest + Supertest）
  - 数据库集成测试（测试容器）
  - 服务间 HTTP 调用测试
  - 核心业务流程 E2E 测试
  - CI 覆盖率报告与门槛
- **不包含**：
  - 前端 E2E 测试（Playwright/Cypress）
  - 性能测试/压力测试
  - 混沌工程测试

## 4. 详细需求

### 4.1 集成测试框架

```javascript
// backend/tests/integration/setup.js
const { GenericContainer } = require('testcontainers');

module.exports = async function setup() {
  // 启动 PostgreSQL 测试容器
  const postgresContainer = await new GenericContainer('postgres:15')
    .withEnvironment({ POSTGRES_PASSWORD: 'test' })
    .withExposedPorts(5432)
    .start();
  
  // 启动 Redis 测试容器
  const redisContainer = await new GenericContainer('redis:7')
    .withExposedPorts(6379)
    .start();
  
  return { postgresContainer, redisContainer };
};
```

### 4.2 核心集成测试用例

| 测试套件 | 测试内容 | 数量 |
|---------|---------|------|
| auth.integration.test.js | 注册/登录/JWT刷新/登出 | 12 |
| catch.integration.test.js | 捕捉流程/Redis缓存/事件发布 | 15 |
| payment.integration.test.js | 订单创建/支付回调/幂等性 | 10 |
| gym.integration.test.js | 道馆挑战/占领/奖励 | 12 |
| social.integration.test.js | 好友/交易/分享 | 10 |

### 4.3 E2E 业务流程测试

```javascript
// backend/tests/e2e/user-journey.test.js
describe('用户完整旅程 E2E', () => {
  it('新用户注册→捕捉精灵→道馆战斗→购买道具', async () => {
    // 1. 注册
    const user = await register({ email: 'test@example.com' });
    
    // 2. 获取附近精灵
    const pokemons = await getNearbyPokemons(user.token, { lat: 39.9, lng: 116.4 });
    
    // 3. 捕捉精灵
    const catchResult = await catchPokemon(user.token, pokemons[0].id);
    expect(catchResult.success).toBe(true);
    
    // 4. 道馆战斗
    const battleResult = await gymBattle(user.token, { gymId: 'gym-001' });
    
    // 5. 购买道具
    const order = await createOrder(user.token, { item: 'pokeball', quantity: 10 });
    expect(order.status).toBe('pending');
  });
});
```

### 4.4 CI 覆盖率配置

```yaml
# .github/workflows/test.yml
- name: Run tests with coverage
  run: npm run test:coverage
  
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
  
- name: Check coverage threshold
  run: |
    coverage=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
    if (( $(echo "$coverage < 80" | bc -l) )); then
      echo "Coverage $coverage% is below 80% threshold"
      exit 1
    fi
```

### 4.5 测试数据管理

- 测试前自动清理数据库
- 使用 Factory 模式生成测试数据
- 测试后自动回滚事务

## 5. 验收标准（可测试）

- [ ] 集成测试框架可运行，支持 PostgreSQL/Redis 测试容器
- [ ] 至少 50 个集成测试用例通过
- [ ] 至少 3 个 E2E 业务流程测试通过
- [ ] CI 流程生成覆盖率报告并上传到 Codecov
- [ ] CI 流程强制覆盖率 ≥ 80%，否则失败
- [ ] 测试执行时间 < 5 分钟（单元 + 集成）

## 6. 工作量估算

**L（Large）**：需要搭建测试框架、编写大量测试用例、配置 CI 流程，预计 3-5 天。

## 7. 优先级理由

P1 理由：
1. 测试覆盖是项目质量的基础保障
2. 当前 STATUS.md 测试覆盖得分 9/10，缺少集成测试是明确缺口
3. 无集成测试导致重构风险高，影响后续需求开发效率
