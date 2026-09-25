# REQ-00526: 实现 API 响应数据流式压缩与流处理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00526 |
| 标题 | 实现 API 响应数据流式压缩与流处理系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | gateway, backend/shared, game-client |
| 创建时间 | 2026-07-09 15:00 |

## 需求描述

为了降低大规模 API 响应对网络带宽的压力，并提升端到端的传输效率，需要引入 API 响应的流式压缩与流处理机制。目前的响应多为一次性序列化后发送，对于大批量数据（如 Pokemon 列表、活动配置、战斗历史记录）会导致较高的内存占用和延迟。通过流式处理，可以将响应数据分块进行压缩和发送，显著减少 TTFB（Time To First Byte）和内存抖动。

## 技术方案

### 1. 核心架构
- 在 API 网关层引入流式处理器（Stream Processor）。
- 使用 Node.js 的 `Transform` streams 进行数据的实时压缩（Gzip/Brotli）。
- 定义 `stream-api-handler` 基础类，支持 `ReadableStream` 作为响应体。

### 2. 实现细节
- **数据流式序列化**：使用 JSONStream 等库将数据库查询结果逐步转换为 JSON 流。
- **压缩中间件**：在 gateway 引入压缩流中间件，支持根据 Header 自适应选择压缩算法（Brotli优先）。
- **客户端处理**：在游戏客户端引入数据流解码器，支持边接收边处理数据，提高首个对象渲染速度。

### 3. 代码示例（Node.js 网关层）
```javascript
const { createBrotliCompress } = require('zlib');
const { pipeline } = require('stream');

function streamResponse(req, res, dataStream) {
  res.setHeader('Content-Encoding', 'br');
  res.setHeader('Content-Type', 'application/json');
  
  pipeline(
    dataStream,
    createBrotliCompress(),
    res,
    (err) => {
      if (err) console.error('Pipeline failed', err);
    }
  );
}
```

## 验收标准

- [ ] API 响应成功启用 Brotli 流式压缩。
- [ ] 大批量数据请求内存占用降低至少 40%。
- [ ] 传输首字节延迟缩短 20%。
- [ ] 客户端能正确解析分块的压缩 JSON 数据流。
- [ ] 异常情况下的流中止与资源释放测试通过。

## 影响范围

- gateway (网关服务)
- backend/shared (中间件共享库)
- game-client (游戏客户端网络模块)

## 参考

- [Node.js Streams API](https://nodejs.org/api/stream.html)
- [Brotli Compression RFC](https://datatracker.ietf.org/doc/html/rfc7932)

## 实现记录（2026-09-25）

状态：**implemented**（代码已完成、未在服务上运行验证；按 09-25 验证规则，服务级验证由用户安排）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| API 响应成功启用 Brotli 流式压缩。 | ✅ | `streamingCompression.js` 替换整包缓冲的 REQ-00072 实现：br > gzip > deflate，≥1KB 才压缩，边压边发，背压透传 |
| 大批量数据请求内存占用降低至少 40%。 | ⚠️ | 设计上不再缓冲整个响应体（压缩层与 large-response 流式管道都不缓冲），未实测内存。建议：对 `/v1/pokemon/pokedex` 与 `/v1/pokemon/species/stream` 并发 50 请求，比较改动前后网关 RSS 峰值 |
| 传输首字节延迟缩短 20%。 | ⚠️ | 冒烟输出 NDJSON 流与缓冲 JSON 的 TTFB 对比（待验证）；单测验证 ndjson 首块在整体完成前到达 |
| 客户端能正确解析分块的压缩 JSON 数据流。 | ✅ | 前端 `readNdjson`（跨块半行、UTF-8 多字节跨块）+ `api.streamSpecies()`；前端单测 |
| 异常情况下的流中止与资源释放测试通过。 | ✅ | 服务端：客户端断开即销毁压缩流、停止写入（ops 单测）；图鉴流在断开后停止查询；前端：AbortSignal 取消底层读取（前端单测） |

- 入口：网关全局压缩中间件；`GET /v1/pokemon/species/stream`（NDJSON）；`config/pipelines/api-pipelines.yaml` 的 large-response / species-stream 流式管道
- 代码：`backend/shared/apiStandards/streamingCompression.js`、`gateway/src/apiStandards/setup.js`、pokemon-service `src/index.js`
- 单测：`cd backend && npm run test:api-standards`（api-standards-core / contract / lint 为纯逻辑，宿主机已运行通过：core 25/25、contract 11/11、lint 4/4；pipeline / ops / services 依赖 express / pino / prom-client，在 09-25 18:30 验证规则调整前于 CI 栈跑通过（pipeline 17/17、ops 20/20、services 5/5），之后追加的用例**未运行，待验证**）
- 前端单测：`node --test frontend/game-client/tests/unit/api-standards-client.test.mjs`（宿主机 10/10 通过，Node ≥ 22.12）
- 冒烟：`BASE_URL=http://<网关> node scripts/smoke-api-standards.js`（约 90 项断言，**未运行，待验证**）；核心冒烟 `scripts/smoke-core-flow.js` 在网关接入管道后于 CI 栈跑过 37/37（18:30 前）
- 待验证：nginx 等前置代理对 `Content-Encoding: br` 与分块传输的透传（`proxy_buffering` 需对流式接口关闭）
- 相关提交：分支 `work/e25-api`（Epic E25 API 设计规范，合并后见集成分支 squash 提交）
