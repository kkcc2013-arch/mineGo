# REQ-00429: 游戏客户端断点续传资源更新系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00429 |
| 标题 | 游戏客户端断点续传资源更新系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、cdn-service、storage-service、admin-dashboard |
| 创建时间 | 2026-07-03 08:00 |

## 需求描述

针对游戏客户端在大文件资源（如精灵 3D 模型、高音质音频包）更新时的网络中断问题，建立基于 HTTP Range 的分片下载与断点续传机制，确保资源包完整性与更新效率。

## 技术方案

### 1. 客户端更新引擎
- 实现 `ResumableDownloadManager`，支持 `Range` 请求头。
- 使用 `IndexedDB` 存储下载进度与本地缓存片段。
- 集成文件哈希校验（MD5/SHA-256）以确保更新包完整性。

### 2. CDN 服务适配
- 配置 CDN 支持 `Range` 响应。
- 提供资源版本清单 (Manifest) 的原子替换策略。

## 验收标准

- [ ] 支持网络异常中断后的续传。
- [ ] 下载完成后对所有资源进行 CRC32 完整性校验。
- [ ] 在 `admin-dashboard` 中查看更新版本的发布进度。
- [ ] 确保在 3G/弱网环境下更新成功率 > 98%。

## 影响范围

- `frontend/game-client/src/network/ResumableDownloadManager.js` (新建)
- `infrastructure/k8s/cdn-config.yaml`
- `frontend/game-client/src/game/UpdateManager.js`

## 参考

- HTTP Range Requests RFC 7233
- CDN 资源分发规范
