# REQ-00131: payment-service 多货币支持路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00131 |
| 标题 | payment-service 多货币支持路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | payment-service |
| 创建时间 | 2026-06-11 23:00 |

## 背景与价值

**问题**：`backend/services/payment-service/src/routes/currency.js` 已实现完整的多货币支持 API（10+ 个端点），但从未在 `index.js` 中挂载，导致所有多货币功能无法使用。

**影响**：
- REQ-00051（多货币支持与汇率转换系统）标记为"已完成"，但实际功能不可达
- 玩家无法查看支持的货币列表、汇率转换、设置偏好货币等核心操作
- 支付系统无法支持多货币结算，限制国际化能力

**价值**：挂载后立即解锁 REQ-00051 的全部功能，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/payment-service/src/index.js` 通过
- [ ] `node --check backend/services/payment-service/src/routes/currency.js` 通过
- [ ] `grep -q "currencyRouter" backend/services/payment-service/src/index.js` 路由已挂载
- [ ] `curl -sf http://localhost:8085/health` 返回 200（服务可启动）
- [ ] 启动服务后，`curl -sf http://localhost:8085/currency` 返回非 404

## 技术方案

### 1. 路由挂载
在 `payment-service/src/index.js` 中：

```javascript
// 在文件顶部添加
const currencyRouter = require('./routes/currency');

// 在路由区域添加
app.use('/currency', currencyRouter);
```

### 2. 端点清单（共 10+ 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/currency` | 获取支持的货币列表 |
| GET | `/currency/rates` | 获取当前汇率 |
| GET | `/currency/rates/:from/:to` | 获取指定货币对汇率 |
| POST | `/currency/convert` | 货币转换计算 |
| GET | `/currency/user/preference` | 获取用户偏好货币 |
| PUT | `/currency/user/preference` | 设置用户偏好货币 |
| GET | `/currency/history/:from/:to` | 汇率历史查询 |
| POST | `/currency/admin/rates` | 管理员更新汇率 |
| GET | `/currency/admin/sources` | 获取汇率数据源 |
| GET | `/currency/admin/stats` | 汇率使用统计 |

### 3. 依赖检查
- `shared/db` 已存在
- `shared/auth` 已存在
- `shared/logger` 已存在
- `shared/exchangeRateService` 已存在
- `shared/currencyFormatter` 已存在
- 无新增依赖

## 影响范围

- `backend/services/payment-service/src/index.js`（修改）
- 解锁 REQ-00051 的全部功能

## 参考

- 关联需求：REQ-00051（多货币支持与汇率转换系统）
- 欠账来源：GUIDELINES.md §6 集成欠账清单
