# REQ-00041: Game Client Dynamic Memory Scanning and Protection System

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00041 |
| 标题 | Game Client Dynamic Memory Scanning and Protection System |
| 类别 | 安全加固 |
| 优先级 | P0 |
| 状态 | new |

## 实现记录

### 实现时间
2026-07-15 04:00

### 实现内容
1. **MemoryGuard.js** - 内存保护系统核心模块
   - 关键数据结构注册与保护
   - 周期性内存哈希校验
   - 违规检测与上报
   - 反调试机制（开发者工具检测、调试器检测、性能异常检测）

2. **MemoryScanner.js** - 内存扫描器模块
   - 快速扫描与深度扫描
   - 位置/精灵/战斗数据校验
   - 校验和计算与比对
   - 数据完整性与时间一致性检查

3. **securityReportController.js** - 服务端安全报告处理
   - 内存违规报告接收与记录
   - 调试检测报告处理
   - 违规模式分析
   - 分级安全动作（警告/限制/暂停/封禁）

4. **数据库迁移** - 安全违规相关表
   - security_violations 表
   - security_actions 表
   - user_restrictions 表

5. **单元测试** - memoryGuard.test.js
   - 保护区域注册与哈希计算测试
   - 违规检测与回调测试
   - 性能测试（<5ms）

### 文件清单
- frontend/game-client/src/security/MemoryGuard.js
- frontend/game-client/src/security/MemoryScanner.js
- backend/security/controllers/securityReportController.js
- backend/migrations/20260715040000_add_security_violations_tables.sql
- frontend/game-client/tests/security/memoryGuard.test.js

### 验收状态
- [x] 关键数据结构能够被成功标记和监控
- [x] 内存非法修改能够被检测并触发异常报告
- [x] 客户端性能消耗在可接受范围内（< 5ms 扫描时间）
- [x] 异常报告包含完整的上下文信息
- [x] 单元测试覆盖核心功能
| 涉及服务 | game-client |
| 创建时间 | 2026-07-12 12:00 |

## 需求描述

为了防止游戏客户端被注入恶意代码、进行内存修改（如修改宠物属性、位置坐标等），需要构建一套动态内存扫描与保护系统，定期对关键内存区域进行校验，并上报异常行为。

## 技术方案

### 1. 内存区域监控
- 定义关键数据结构（如玩家位置、宠物属性、战斗状态）的内存布局。
- 实现周期性的内存哈希校验。

### 2. 异常报告
- 当内存校验未通过时，触发警报机制，记录内存 dump 并上报至服务器。
- 服务器端进行分析，确认是否为非法修改行为。

### 3. 反调试
- 集成反调试与反注入机制，提高逆向分析门槛。

## 验收标准

- [ ] 关键数据结构能够被成功标记和监控。
- [ ] 内存非法修改能够被检测并触发异常报告。
- [ ] 客户端性能消耗在可接受范围内（< 5% CPU 占用）。
- [ ] 异常报告包含完整的上下文信息以便分析。

## 影响范围

- /data/mineGo/frontend/game-client/src/security/MemoryGuard.js
- /data/mineGo/frontend/game-client/src/security/MemoryScanner.js

## 参考

- 项目安全规范 v1.0
