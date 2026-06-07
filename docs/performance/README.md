# mineGo API 压力测试文档

## 概述

mineGo API 压力测试系统基于 k6 构建，用于验证 API 性能、发现性能瓶颈、防止性能回归。

## 快速开始

### 安装 k6

```bash
# macOS
brew install k6

# Ubuntu/Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C4914C66B1E1
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Windows
choco install k6
```

### 运行测试

```bash
# 运行综合测试
cd backend/tests/performance
./run-performance-tests.sh --scenario comprehensive --report

# 运行特定场景
./run-performance-tests.sh --scenario auth
./run-performance-tests.sh --scenario catch
./run-performance-tests.sh --scenario gym
./run-performance-tests.sh --scenario payment

# 运行所有测试
./run-performance-tests.sh --scenario all --report
```

## 测试场景

### 1. 认证场景 (auth-stress.js)

测试用户注册、登录、令牌刷新流程。

**测试类型**：
- 负载测试：100 并发用户，持续 4 分钟
- 峰值测试：50 → 300 → 50 并发用户

**关键指标**：
- P50 延迟 < 80ms
- P99 延迟 < 250ms
- 错误率 < 1%

### 2. 精灵捕捉场景 (catch-stress.js)

测试完整捕捉流程：位置上报 → 发现精灵 → 投球捕捉。

**测试类型**：
- 负载测试：50 → 100 → 150 并发用户
- 压力测试：100 → 300 → 500 并发用户

**关键指标**：
- P50 延迟 < 120ms
- P99 延迟 < 400ms
- 捕捉成功率 > 85%

### 3. 道馆战斗场景 (gym-stress.js)

测试道馆查询和战斗流程。

**测试类型**：
- 道馆查询负载：100 并发用户，持续 3 分钟
- 道馆战斗负载：30 → 80 → 50 并发用户

**关键指标**：
- P50 延迟 < 150ms
- P99 延迟 < 500ms
- 战斗成功率 > 80%

### 4. 支付场景 (payment-stress.js)

测试支付创建、回调、验证流程，包括幂等性验证。

**测试类型**：
- 支付创建负载：20 → 50 → 20 并发用户
- 幂等性测试：10 用户 × 5 次迭代

**关键指标**：
- P50 延迟 < 200ms
- P99 延迟 < 500ms
- 错误率 < 0.5%
- 幂等性验证通过率 = 100%

### 5. 综合场景 (comprehensive-stress.js)

模拟真实用户行为，覆盖认证、捕捉、道馆、社交、支付全流程。

**测试类型**：
- 用户旅程测试：50 → 100 → 150 → 100 并发用户

**关键指标**：
- P50 延迟 < 150ms
- P99 延迟 < 500ms
- 用户旅程成功率 > 85%

## 性能 SLA

| API 端点 | 吞吐量 | P50 延迟 | P99 延迟 | 错误率 |
|---------|--------|---------|---------|--------|
| POST /api/auth/login | 200 req/s | < 50ms | < 150ms | < 0.1% |
| POST /api/auth/register | 100 req/s | < 80ms | < 250ms | < 0.1% |
| GET /api/pokemon/nearby | 300 req/s | < 80ms | < 200ms | < 0.1% |
| POST /api/catch/attempt | 150 req/s | < 100ms | < 300ms | < 0.5% |
| GET /api/gym/nearby | 200 req/s | < 80ms | < 200ms | < 0.1% |
| POST /api/gym/battle | 100 req/s | < 150ms | < 400ms | < 0.5% |
| POST /api/payment/create | 50 req/s | < 200ms | < 500ms | < 0.1% |
| GET /api/social/friends | 200 req/s | < 50ms | < 150ms | < 0.1% |

## CI/CD 集成

### GitHub Actions

性能测试工作流位于 `.github/workflows/performance-tests.yml`：

- **定时执行**：每天凌晨 2 点 UTC
- **手动触发**：支持选择场景和环境
- **PR 触发**：后端代码变更时自动运行

### 性能回归检测

- P99 延迟增长 > 20% → CI 失败
- 吞吐量下降 > 15% → CI 失败
- 错误率增长 > 1% → CI 失败

## 报告查看

### 本地报告

```bash
# 运行测试并生成报告
./run-performance-tests.sh --scenario comprehensive --report

# 打开报告
open performance-results/report-*.html
```

### CI 报告

1. 进入 GitHub Actions 页面
2. 选择 "Performance Tests" 工作流
3. 下载 "performance-results" artifact
4. 打开 HTML 报告

## 最佳实践

### 1. 测试前准备

- 确保服务已启动且健康
- 使用独立的测试数据库
- 清理旧的测试数据

### 2. 测试环境

- **本地开发**：localhost
- **Staging**：staging.minego.example.com
- **生产**：仅限低负载测试

### 3. 结果解读

- **P50 延迟**：50% 请求的延迟，代表典型性能
- **P90 延迟**：90% 请求的延迟，关注大部分用户体验
- **P99 延迟**：99% 请求的延迟，关注尾部延迟
- **吞吐量**：系统每秒处理的请求数

### 4. 性能优化

当发现性能问题时：

1. 查看慢查询日志
2. 检查数据库索引
3. 分析缓存命中率
4. 使用链路追踪定位瓶颈

## 故障排查

### 服务健康检查失败

```bash
# 检查服务状态
docker compose ps
curl http://localhost:8080/health

# 查看服务日志
docker compose logs gateway
```

### 测试超时

```bash
# 增加 k6 超时时间
k6 run --timeout 120s script.js
```

### 内存不足

```bash
# 限制并发用户数
k6 run --vus 50 script.js
```

## 相关文档

- [k6 官方文档](https://k6.io/docs/)
- [性能测试最佳实践](https://k6.io/docs/testing-guides/test-types/)
- [mineGo 架构文档](../../../ARCHITECTURE.md)
