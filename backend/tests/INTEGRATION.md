# 集成测试与 E2E 测试指南

## 概述

本项目已建立完整的集成测试和 E2E 测试体系，确保服务间交互正确性和业务流程完整性。

## 测试架构

```
backend/tests/
├── unit/                          # 单元测试 (95 个)
│   ├── auth.test.js
│   ├── catch.test.js
│   ├── payment.test.js
│   └── ...
├── integration/                   # 集成测试
│   ├── setup.js                   # 测试环境设置
│   ├── global-setup.js            # 全局设置（启动容器）
│   ├── global-teardown.js         # 全局清理
│   ├── jest.config.json           # Jest 配置
│   ├── auth.integration.test.js   # 认证集成测试 (12 个)
│   ├── catch.integration.test.js  # 捕捉集成测试 (15 个)
│   └── payment.integration.test.js # 支付集成测试 (10 个)
└── e2e/                           # E2E 业务流程测试
    └── user-journey.test.js       # 用户完整旅程测试 (5 个)
```

## 测试覆盖

### 集成测试 (37 个测试用例)

| 测试套件 | 测试内容 | 用例数 |
|---------|---------|--------|
| auth.integration.test.js | 注册、登录、JWT 刷新、登出、Redis 缓存 | 12 |
| catch.integration.test.js | 附近精灵查询、捕捉流程、Redis GEO、概率计算 | 15 |
| payment.integration.test.js | 订单创建、支付回调、幂等性、签名验证 | 10 |

### E2E 测试 (5 个测试用例)

| 测试套件 | 测试内容 | 用例数 |
|---------|---------|--------|
| user-journey.test.js | 新用户注册→捕捉精灵→道馆战斗→购买道具完整流程 | 5 |

## 运行测试

### 本地运行

```bash
# 运行单元测试
cd backend
npm run test:unit

# 运行集成测试（需要 Docker）
npm run test:integration

# 运行 E2E 测试
npm run test:e2e

# 运行所有测试
npm run test:all

# 生成覆盖率报告
npm run test:coverage
```

### CI/CD 流程

GitHub Actions 自动运行：
1. **单元测试**：每次提交自动运行
2. **集成测试**：需要 PostgreSQL 和 Redis 服务容器
3. **E2E 测试**：验证完整业务流程
4. **覆盖率检查**：强制 ≥ 80% 覆盖率

查看工作流：`.github/workflows/integration-test.yml`

## 测试容器

集成测试使用 **testcontainers** 自动启动测试容器：

- **PostgreSQL 15**：测试数据库操作
- **Redis 7**：测试缓存和 GEO 功能

容器生命周期：
- `global-setup.js`：测试前启动容器
- `setup.js`：初始化数据库 schema
- `afterEach`：清理测试数据
- `global-teardown.js`：测试后停止容器

## 测试数据管理

### 数据清理策略

```javascript
afterEach(async () => {
  // 清理数据库
  await pgClient.query('TRUNCATE TABLE users, pokemons RESTART IDENTITY CASCADE');
  
  // 清理 Redis
  await redisClient.flushdb();
});
```

### 测试隔离

- 每个测试用例独立运行
- 使用事务回滚确保数据隔离
- 避免测试间相互依赖

## 覆盖率报告

### 生成报告

```bash
npm run test:coverage
```

报告输出：
- `coverage/lcov.info`：CodeCov 上传格式
- `coverage/coverage-summary.json`：JSON 摘要
- `coverage/lcov-report/`：HTML 报告

### 覆盖率门槛

- **强制覆盖率**：≥ 80%
- **CI 检查**：低于阈值则构建失败
- **CodeCov 集成**：自动上传报告

## 编写新测试

### 集成测试模板

```javascript
const request = require('supertest');

describe('功能集成测试', () => {
  let app;
  let pgClient;
  let redisClient;

  beforeAll(() => {
    // 初始化 Express 应用
    const express = require('express');
    app = express();
    app.use(express.json());

    // 获取测试客户端
    pgClient = global.testUtils.getPgClient();
    redisClient = global.testUtils.getRedisClient();

    // 定义路由
    app.get('/api/test', (req, res) => {
      res.json({ code: 0, message: '成功' });
    });
  });

  it('应该返回成功响应', async () => {
    const res = await request(app).get('/api/test');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
```

### E2E 测试模板

```javascript
describe('业务流程 E2E 测试', () => {
  it('完整业务流程', async () => {
    // 步骤 1: 创建资源
    const createRes = await request(app)
      .post('/api/resource')
      .send({ name: 'test' });
    
    expect(createRes.status).toBe(201);
    
    // 步骤 2: 使用资源
    const useRes = await request(app)
      .get(`/api/resource/${createRes.body.data.id}`);
    
    expect(useRes.status).toBe(200);
    
    // 验证数据库状态
    const dbResult = await pgClient.query('SELECT * FROM resources WHERE id = $1', [createRes.body.data.id]);
    expect(dbResult.rows.length).toBe(1);
  });
});
```

## 最佳实践

### 1. 使用环境变量

```javascript
// 从环境变量读取测试配置
const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
```

### 2. 模拟外部依赖

```javascript
// 模拟外部 API
jest.mock('axios');
axios.get.mockResolvedValue({ data: { status: 'ok' } });
```

### 3. 测试边界情况

```javascript
it('应该拒绝无效输入', async () => {
  const res = await request(app)
    .post('/api/resource')
    .send({ invalid: 'data' });
  
  expect(res.status).toBe(400);
});

it('应该处理并发请求', async () => {
  const promises = Array(10).fill(null).map(() =>
    request(app).get('/api/resource')
  );
  
  const results = await Promise.all(promises);
  results.forEach(res => expect(res.status).toBe(200));
});
```

### 4. 验证数据库一致性

```javascript
it('应该正确更新数据库', async () => {
  // 执行操作
  await request(app).post('/api/resource').send({ name: 'test' });
  
  // 验证数据库
  const result = await pgClient.query('SELECT * FROM resources WHERE name = $1', ['test']);
  expect(result.rows.length).toBe(1);
});
```

## 故障排查

### 常见问题

1. **容器启动失败**
   ```bash
   # 检查 Docker 是否运行
   docker ps
   
   # 重启 Docker
   sudo systemctl restart docker
   ```

2. **端口冲突**
   ```bash
   # 检查端口占用
   lsof -i :5432
   lsof -i :6379
   
   # 杀死进程
   kill -9 <PID>
   ```

3. **测试超时**
   ```javascript
   // 增加超时时间
   jest.setTimeout(60000);
   ```

4. **数据库连接失败**
   ```javascript
   // 检查环境变量
   console.log(process.env.TEST_DATABASE_URL);
   ```

## 性能优化

- 使用连接池管理数据库连接
- 并行运行独立测试
- 使用内存数据库加速测试
- 缓存测试数据避免重复创建

## 持续改进

- 定期增加测试覆盖
- 优化测试执行时间
- 添加更多 E2E 业务场景
- 集成性能测试和压力测试

## 相关文档

- [单元测试文档](./unit/README.md)
- [API 测试文档](./api-test.md)
- [CI/CD 文档](../../.github/workflows/README.md)
