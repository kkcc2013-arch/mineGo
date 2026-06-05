# Backend Tests

## 测试说明

mineGo 后端测试分为单元测试和集成测试。

## 单元测试

### 运行所有单元测试

```bash
cd backend
npm run test:unit
```

### 运行单个测试文件

```bash
# 捕捉逻辑测试
node tests/unit/catch.test.js

# 认证测试
node tests/unit/auth.test.js

# 精灵刷新测试
node tests/unit/spawn.test.js

# 日志和指标测试
node tests/unit/logger-metrics.test.js

# 支付服务测试（REQ-00004）
node tests/unit/payment.test.js
```

## 测试覆盖

### 当前测试覆盖情况

| 服务 | 单元测试 | 集成测试 | 覆盖率 |
|------|---------|---------|--------|
| catch-service | ✅ 25 tests | ❌ | N/A |
| auth | ✅ 14 tests | ❌ | N/A |
| spawn | ✅ 15 tests | ❌ | N/A |
| logger-metrics | ✅ 9 tests | ❌ | N/A |
| payment-service | ✅ 32 tests | ❌ | N/A |

**总计**: 95 个单元测试

### 代码覆盖率工具

如需使用代码覆盖率工具（nyc/istanbul），请安装：

```bash
npm install --save-dev nyc
```

然后运行：

```bash
npx nyc npm run test:unit
```

## 集成测试（计划中）

集成测试将验证：
- 数据库操作正确性
- Redis 缓存操作
- 服务间交互
- 完整业务流程

## 测试最佳实践

1. **每个测试独立运行** - 不依赖其他测试的状态
2. **使用 Mock** - 隔离外部依赖（DB、Redis、第三方 API）
3. **测试边界条件** - 不仅测试正常路径，还要测试异常路径
4. **清晰的测试名称** - 描述测试的目的和预期结果
5. **快速执行** - 单元测试应在毫秒级完成

## REQ-00004 测试内容

支付服务单元测试覆盖：

1. **订单状态状态机** (9 tests)
   - 合法状态转换
   - 非法状态转换
   - 终态处理

2. **幂等性键** (3 tests)
   - 格式验证
   - 唯一性
   - 时间戳包含

3. **签名验证** (8 tests)
   - 正确签名验证
   - 错误签名拒绝
   - 时序攻击防护
   - 多渠道密钥

4. **数据脱敏** (3 tests)
   - 敏感字段过滤
   - 用户数据隔离

5. **商品目录** (5 tests)
   - 价格正确性
   - 优惠逻辑
   - 渠道验证

6. **错误处理** (4 tests)
   - 参数验证
   - 异常情况

## CI 集成

GitHub Actions CI 流程已集成单元测试：

```yaml
- name: Run unit tests
  working-directory: backend
  run: npm run test:unit
```

## 下一步

- [ ] 添加集成测试框架
- [ ] 添加代码覆盖率报告
- [ ] 添加 E2E 测试
- [ ] 配置 CI 测试覆盖率门槛（80%）
