# REQ-00554: API响应协议内容协商与媒体类型智能转换

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00554 |
| 标题 | API响应协议内容协商与媒体类型智能转换 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | api-gateway, backend/shared, game-client |
| 创建时间 | 2026-07-15 08:00 |

## 需求描述

为了优化API请求的带宽消耗和处理性能，实现根据客户端 Accept 头部自动协商最优响应格式（如 JSON, MessagePack, Protobuf）。系统应根据请求环境和带宽质量，自动选择序列化格式以减少响应体大小。

## 技术方案

### 1. 协议协商中间件
- 在 API 网关层实现 Accept 头部解析器
- 支持配置格式优先级映射
- 自动设置 Content-Type 响应头

### 2. 序列化工厂
- 引入多序列化库支持（JSON, MsgPack, Proto）
- 抽象序列化接口 `Serializer`
- 针对高频接口默认优先使用二进制协议

## 验收标准

- [ ] 客户端发送 Accept: application/x-msgpack，服务器应返回 MessagePack 格式数据
- [ ] 若不支持请求格式，自动 fallback 至 JSON
- [ ] 性能测试显示二进制序列化在响应体大小上较 JSON 节省 >30%
- [ ] 所有核心接口覆盖兼容性测试

## 影响范围

- API 网关服务
- 后端共享库 (API 定义层)
- 游戏前端网络库

## 参考

- [RESTful Content Negotiation Best Practices](https://example.com/api/negotiation)

## 实现记录（2026-09-25）

状态：**implemented**（代码已完成、未在服务上运行验证；按 09-25 验证规则，服务级验证由用户安排）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 客户端发送 Accept: application/x-msgpack，服务器应返回 MessagePack 格式数据 | ✅ | 零依赖 msgpack 编解码（`msgpack.js`），所有 JSON 接口均可协商 |
| 若不支持请求格式，自动 fallback 至 JSON | ✅ | 已知但未实现的二进制格式（protobuf）回退 JSON + `X-Content-Fallback`；完全不支持的类型按 REQ-00368 返回 406 |
| 性能测试显示二进制序列化在响应体大小上较 JSON 节省 >30% | ⚠️ | 纯 MessagePack 对字符串为主的数据约省 10%～25%，叠加 `?_aliases=1` 在单测样本中 >30%；冒烟输出图鉴 100 条的实测值（待验证） |
| 所有核心接口覆盖兼容性测试 | ✅ | 序列化阶段对所有经过管道的 JSON 接口生效；冒烟覆盖 users/me 与图鉴，契约测试覆盖 22 个核心接口的 JSON 形态 |

- 入口：网关管道 contentNegotiator / serializer
- 单测：`cd backend && npm run test:api-standards`（api-standards-core / contract / lint 为纯逻辑，宿主机已运行通过：core 25/25、contract 11/11、lint 4/4；pipeline / ops / services 依赖 express / pino / prom-client，在 09-25 18:30 验证规则调整前于 CI 栈跑通过（pipeline 17/17、ops 20/20、services 5/5），之后追加的用例**未运行，待验证**）
- 冒烟：`BASE_URL=http://<网关> node scripts/smoke-api-standards.js`（约 90 项断言，**未运行，待验证**）；核心冒烟 `scripts/smoke-core-flow.js` 在网关接入管道后于 CI 栈跑过 37/37（18:30 前）
- 相关提交：分支 `work/e25-api`（Epic E25 API 设计规范，合并后见集成分支 squash 提交）
