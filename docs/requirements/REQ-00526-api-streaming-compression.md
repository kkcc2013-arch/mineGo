# REQ-00526: 实现 API 响应数据流式压缩与流处理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00526 |
| 标题 | 实现 API 响应数据流式压缩与流处理系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
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
