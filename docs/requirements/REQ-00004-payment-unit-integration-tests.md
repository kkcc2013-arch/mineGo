# REQ-00004：支付服务单元测试与集成测试覆盖

- **编号**：REQ-00004
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：payment-service、backend/tests/
- **创建时间**：2026-06-05 00:30
- **依赖需求**：REQ-00003

## 1. 背景与问题

当前项目有良好的单元测试基础（54个测试用例全部通过），但存在以下测试缺口：

1. **支付服务缺少单元测试**：REQ-00003 刚实现了支付订单幂等性、签名验证、状态机等关键逻辑，但没有对应的测试用例
2. **缺少集成测试**：所有测试都是纯逻辑单元测试，没有验证服务间交互、数据库操作、Redis 操作
3. **缺少 E2E 测试**：没有验证完整业务流程（如：创建订单→支付→验证→发货）
4. **测试覆盖率未知**：缺少代码覆盖率统计工具

这些问题可能导致：
- 支付逻辑存在隐藏 bug，生产环境可能造成资金损失
- 重构时缺少回归测试保护
- 难以验证服务间集成是否正确

## 2. 目标

1. 为 payment-service 编写完整的单元测试，覆盖率 > 90%
2. 添加集成测试，验证数据库、Redis、服务间交互
3. 引入代码覆盖率工具（nyc/istanbul）
4. 建立 CI 测试覆盖率门槛（最低 80%）

**预期收益**：
- 提升支付服务可靠性，降低生产故障率
- 为未来重构提供安全网
- 提升团队信心，加快迭代速度

## 3. 范围

- **包含**：
  - payment-service 单元测试（幂等性、签名验证、状态机、脱敏）
  - 集成测试框架搭建（数据库、Redis mock）
  - 代码覆盖率工具集成
  - CI 测试覆盖率报告

- **不包含**：
  - E2E 测试（另立需求）
  - 其他服务的测试补充（优先级较低）
  - 性能测试/压力测试

## 4. 详细需求

### 4.1 单元测试用例

```javascript
// tests/unit/payment.test.js

describe('Payment Service - Idempotency', () => {
  test('相同 idempotencyKey 应返回相同订单', async () => {
    // 1. 第一次创建订单
    const res1 = await createOrder({ productId: 'coins_60', idempotencyKey: 'key-123' });
    expect(res1.orderId).toBeDefined();
    
    // 2. 第二次使用相同 key
    const res2 = await createOrder({ productId: 'coins_60', idempotencyKey: 'key-123' });
    expect(res2.orderId).toBe(res1.orderId);
  });
  
  test('幂等性键 24 小时后过期', async () => {
    // 测试 Redis TTL
  });
  
  test('不同用户的幂等性键不冲突', async () => {
    // 测试键格式包含 userId
  });
});

describe('Payment Service - Signature Verification', () => {
  test('正确签名应通过验证', async () => {
    const payload = JSON.stringify({ orderId: '123' });
    const signature = hmacSha256(payload, SECRET);
    expect(verifyWebhookSignature(payload, signature, SECRET)).toBe(true);
  });
  
  test('错误签名应拒绝', async () => {
    const payload = JSON.stringify({ orderId: '123' });
    const wrongSignature = 'invalid_signature';
    expect(verifyWebhookSignature(payload, wrongSignature, SECRET)).toBe(false);
  });
  
  test('无签名应返回 401', async () => {
    const res = await request(app)
      .post('/payment/webhook/WECHAT')
      .send('<xml>...</xml>');
    expect(res.status).toBe(401);
  });
  
  test('应防止时序攻击', async () => {
    // 验证使用 timing-safe comparison
  });
});

describe('Payment Service - State Machine', () => {
  test('PENDING → PAID 是合法转换', () => {
    expect(canTransition('PENDING', 'PAID')).toBe(true);
  });
  
  test('PAID → PENDING 是非法转换', () => {
    expect(canTransition('PAID', 'PENDING')).toBe(false);
  });
  
  test('PAID → FULFILLED 是合法转换', () => {
    expect(canTransition('PAID', 'FULFILLED')).toBe(true);
  });
  
  test('FULFILLED 不能转换到任何状态', () => {
    expect(canTransition('FULFILLED', 'PAID')).toBe(false);
    expect(canTransition('FULFILLED', 'CANCELLED')).toBe(false);
  });
});

describe('Payment Service - Data Sanitization', () => {
  test('订单查询不返回敏感字段', async () => {
    const res = await request(app)
      .get('/payment/orders')
      .set('Authorization', `Bearer ${token}`);
    
    expect(res.body.data[0]).not.toHaveProperty('channelResponse');
    expect(res.body.data[0]).not.toHaveProperty('rawCallback');
    expect(res.body.data[0]).not.toHaveProperty('signature');
  });
});
```

### 4.2 集成测试框架

```javascript
// tests/integration/payment.integration.test.js
const { setupTestDB, teardownTestDB } = require('../helpers/db');
const { setupTestRedis, teardownTestRedis } = require('../helpers/redis');

describe('Payment Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDB();
    await setupTestRedis();
  });
  
  afterAll(async () => {
    await teardownTestDB();
    await teardownTestRedis();
  });
  
  test('完整支付流程', async () => {
    // 1. 创建订单
    const order = await createOrder({ productId: 'coins_300', ... });
    
    // 2. 模拟支付回调
    const webhook = await simulateWebhook({
      channel: 'WECHAT',
      orderId: order.id,
      signature: generateSignature(...)
    });
    
    // 3. 验证订单状态
    const updatedOrder = await getOrder(order.id);
    expect(updatedOrder.status).toBe('PAID');
    
    // 4. 验证用户精币余额
    const user = await getUser(userId);
    expect(user.premium_coins).toBe(initialCoins + 300);
  });
});
```

### 4.3 代码覆盖率配置

```json
// package.json
{
  "scripts": {
    "test": "node backend/tests/unit/*.test.js",
    "test:coverage": "nyc npm test",
    "test:integration": "node backend/tests/integration/*.test.js"
  },
  "nyc": {
    "reporter": ["text", "lcov", "html"],
    "exclude": ["**/tests/**", "**/node_modules/**"],
    "check-coverage": true,
    "branches": 80,
    "lines": 80,
    "functions": 80,
    "statements": 80
  },
  "devDependencies": {
    "nyc": "^15.1.0"
  }
}
```

### 4.4 CI 集成

```yaml
# .github/workflows/ci-cd.yml (添加测试覆盖率步骤)
- name: Run tests with coverage
  run: npm run test:coverage
  
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
    fail_ci_if_error: true
```

## 5. 验收标准（可测试）

- [ ] payment-service 单元测试覆盖率 ≥ 90%
- [ ] 所有单元测试通过（幂等性、签名验证、状态机、脱敏）
- [ ] 集成测试验证数据库操作正确性
- [ ] 集成测试验证 Redis 操作正确性
- [ ] 测试覆盖率报告生成（HTML + LCOV）
- [ ] CI 配置测试覆盖率门槛 80%
- [ ] README 更新测试运行说明

## 6. 工作量估算

**M（中等）**

理由：
- 需要编写约 30-40 个测试用例
- 需要搭建集成测试框架（DB/Redis mock）
- 需要配置覆盖率工具
- 预计 2-3 天完成

## 7. 优先级理由

**P1 级别**

1. **支付是核心商业功能**：缺少测试可能导致资金损失
2. **刚刚完成 REQ-00003**：趁代码新鲜，测试更容易编写
3. **测试是质量保障基础**：为后续重构提供安全网
4. **对项目可用性的贡献**：测试覆盖率从 8/10 提升到更高水平
