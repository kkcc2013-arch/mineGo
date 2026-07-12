# REQ-00040: Offline Cache Data Consistency & Synchronization System

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00040 |
| 标题 | Offline Cache Data Consistency & Synchronization System |
| 类别 | Data Governance |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client, gateway, backend |
| 创建时间 | 2026-07-11 16:05 |

## 需求描述

在网络不稳定或离线状态下，客户端缓存的游戏数据（如战利品、资源变更）可能与服务端产生不一致。需要建立一套机制，记录本地操作日志（oplog），并在恢复联网时进行有序、幂等的同步与冲突处理。

## 技术方案

### 1. 客户端 Oplog 实现
- 使用 IndexedDB 存储操作日志队列 (oplog)。
- 每条记录包含 timestamp, actionType, payload, sequenceId, retryCount。

### 2. 服务端同步 API
- 提供 `POST /v1/sync/oplog` 接口，支持批量操作记录提交。
- 实现服务端幂等性检查，使用 sequenceId 过滤重复请求。

### 3. 冲突解决策略
- 基于时间戳优先原则，但支持服务端覆盖逻辑（如背包容量超限时拒绝本地操作）。

## 验收标准

- [ ] 离线操作能够正确存入本地 IndexedDB。
- [ ] 恢复网络后能够自动触发同步请求。
- [ ] 服务端成功处理批量同步请求，返回同步状态。
- [ ] 处理幂等性，防止重复执行操作。

## 影响范围

- /data/mineGo/frontend/game-client/src/storage/OplogManager.js
- /data/mineGo/backend/gateway/routes/syncRoutes.js

## 参考

- [内部文档: 离线状态管理规范](https://docs.minego.internal/offline-sync)
