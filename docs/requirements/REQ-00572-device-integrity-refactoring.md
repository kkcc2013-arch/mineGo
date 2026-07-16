# REQ-00572: deviceIntegrity.js 模块拆分与重构

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00572 |
| 标题 | deviceIntegrity.js 模块拆分与重构 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, backend/security |
| 创建时间 | 2026-07-16 14:00 |

## 需求描述

当前 `deviceIntegrity.js` 服务包含超过 1000 行代码，负责处理设备完整性检测、模拟器识别、以及 root/越狱检测等多种职能。这种高耦合导致难以维护和进行单元测试。需要将其拆分为更小的、单一职责的模块。

## 技术方案

### 1. 拆分策略
- `DeviceFingerprintProvider.js`: 负责提取硬件指纹信息。
- `EmulatorDetector.js`: 负责识别模拟器运行环境。
- `SecurityRuntimeChecker.js`: 负责 root/越狱及注入检测。
- `DeviceIntegrityManager.js`: 协调上述子模块，保留对外主接口。

### 2. 代码重构示例
原有 `checkDeviceIntegrity` 逻辑将迁移到各子模块中。

```javascript
// 示例拆分后调用逻辑
const fingerprint = DeviceFingerprintProvider.getFingerprint(req);
const isEmulator = await EmulatorDetector.detect(fingerprint);
const isCompromised = await SecurityRuntimeChecker.check(req);

if (isEmulator || isCompromised) {
  throw new SecurityError('Device integrity verification failed');
}
```

## 验收标准

- [ ] 完成 `deviceIntegrity.js` 的拆分，原有 1019 行代码减少至 200 行以内。
- [ ] 每个子模块覆盖率不低于 80%。
- [ ] 确保重构后的逻辑与旧版本一致，通过 E2E 验证。

## 影响范围

- `/data/mineGo/backend/gateway/src/middleware/deviceIntegrity.js`

## 参考

- `STATUS.md` - 技术债清理清单
