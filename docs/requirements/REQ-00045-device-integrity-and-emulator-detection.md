# REQ-00045：设备完整性与模拟器检测系统

- **编号**：REQ-00045
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、catch-service、gym-service、game-client、backend/shared
- **创建时间**：2026-06-09 07:00
- **依赖需求**：REQ-00010（GPS伪造检测）、REQ-00028（行为异常检测）

## 1. 背景与问题

### 现状分析
mineGo 项目已实现多层反作弊能力：
- GPS 伪造检测（REQ-00010）：速度异常、精度检测、模拟位置标记
- 行为异常检测（REQ-00028）：捕捉成功率、轨迹模式、战斗异常、资源增长

然而，**缺少最底层的设备级防护**，存在以下安全漏洞：

1. **模拟器滥用**：作弊者使用 PC 模拟器（BlueStacks、Nox、LDPlayer）运行多账号，批量刷资源
2. **Root/越狱设备**：已 root/越狱设备可安装位置伪造、加速、内存修改等作弊工具
3. **虚拟环境检测缺失**：无法识别 VirtualApp、平行空间等虚拟运行环境
4. **Hook 框架风险**：Xposed、Frida、Substrate 等框架可用于动态修改游戏逻辑

### 影响范围
- 模拟器用户可同时控制数十个账号，严重破坏游戏平衡
- Root 设备可绕过 GPS 检测、修改客户端内存
- 缺少设备指纹导致无法追踪作弊设备的关联账号

## 2. 目标

1. **阻止 95%+ 模拟器作弊**：准确识别主流模拟器特征，拒绝登录或限制功能
2. **Root/越狱设备检测**：识别已 root/越狱设备，标记为高风险或限制功能
3. **虚拟环境检测**：识别 VirtualApp、平行空间等克隆应用环境
4. **设备指纹追踪**：建立设备-账号关联，识别群控作弊设备
5. **Hook 框架检测**：识别常见的动态注入框架

## 3. 范围

### 包含
- Android/iOS 设备完整性检测 SDK 集成
- 模拟器特征识别（CPU、传感器、系统属性）
- Root/越狱检测（文件系统、系统调用）
- 虚拟环境检测（进程名、包名、用户 ID）
- 设备指纹生成与追踪
- 设备风险评分系统
- 后端验证 API
- 风险设备告警与处理策略

### 不包含
- 原生防篡改加固（需要专业安全厂商方案）
- 客户端代码混淆与加壳
- 实时内存扫描

## 4. 详细需求

### 4.1 客户端检测模块

#### 4.1.1 模拟器检测（Android）
```javascript
// 检测项清单
const EMULATOR_INDICATORS = {
  // 设备型号检测
  DEVICE_MODELS: [
    'sdk', 'emulator', 'simulator', 'vbox', 'genymotion',
    'nox', 'bluestacks', 'andy', 'memu', 'ldplayer', 'droid4x'
  ],
  
  // 硬件特征
  HARDWARE: {
    CPU_INFO: ['Intel', 'AMD'], // ARM 设备不会有 Intel CPU
    BATTERY_MISSING: true,      // 模拟器通常无电池
    NO_SENSORS: true,           // 模拟器可能缺少传感器
  },
  
  // 系统属性
  SYSTEM_PROPS: {
    'ro.hardware': ['goldfish', 'ranchu'],
    'ro.product.model': EMULATOR_INDICATORS.DEVICE_MODELS,
    'ro.product.device': EMULATOR_INDICATORS.DEVICE_MODELS,
    'ro.product.name': EMULATOR_INDICATORS.DEVICE_MODELS,
    'ro.build.product': EMULATOR_INDICATORS.DEVICE_MODELS,
    'qemu.sf.lcd_density': null, // 存在即为模拟器
    'ro.kernel.qemu': '1',
  },
  
  // 网络特征
  NETWORK: {
    DEFAULT_DNS: ['10.0.2.3', '10.0.2.2'], // 模拟器默认 DNS
  },
  
  // 文件系统特征
  FILES: [
    '/system/bin/qemu-props',
    '/dev/socket/qemud',
    '/dev/qemu_pipe',
    '/sys/class/power_supply/battery/technology', // 不存在表示模拟器
  ],
};
```

#### 4.1.2 Root 检测（Android）
```javascript
const ROOT_INDICATORS = {
  // 常见 root 管理应用
  ROOT_APPS: [
    'com.koushikdutta.superuser',
    'com.thirdparty.superuser',
    'eu.chainfire.supersu',
    'com.noshufou.android.su',
    'com.topjohnwu.magisk',
    'me.phh.superuser',
    'com.kingouser.com',
  ],
  
  // su 二进制文件路径
  SU_PATHS: [
    '/system/bin/su', '/system/xbin/su', '/sbin/su',
    '/system/su', '/system/bin/.ext/.su',
    '/system/usr/we-need-root/su',
    '/system/app/Superuser.apk',
    '/data/local/xbin/su', '/data/local/bin/su',
    '/data/local/su', '/su/bin/su',
    '/su/bin', '/magisk/.core/bin/su',
  ],
  
  // 危险文件
  DANGEROUS_FILES: [
    '/system/app/Superuser.apk',
    '/sbin/su', '/system/su',
    '/system/bin/su', '/system/xbin/su',
  ],
  
  // 可写系统分区（检测通过 Magisk 等 root 方案）
  WRITABLE_SYSTEM: '/proc/mounts',
};
```

#### 4.1.3 越狱检测（iOS）
```javascript
const JAILBREAK_INDICATORS = {
  // Cydia 及相关应用
  APPS: [
    '/Applications/Cydia.app',
    '/Applications/Sileo.app',
    '/Applications/Zebra.app',
    '/Applications/Installer.app',
  ],
  
  // Cydia Substrate
  FILES: [
    '/Library/MobileSubstrate/MobileSubstrate.dylib',
    '/bin/bash', '/bin/sh',
    '/usr/sbin/sshd', '/usr/bin/sshd',
    '/etc/apt', '/etc/ssh',
    '/var/lib/cydia', '/var/log/syslog',
    '/private/var/lib/apt',
    '/private/var/Users',
    '/private/var/stash',
    '/private/var/mobile/Library/SBSettings/Themes',
  ],
  
  // 系统目录可写检测
  WRITABLE_DIRS: [
    '/', '/root', '/private',
  ],
  
  // Fork 检测（越狱设备可以 fork 进程）
  CAN_FORK: true,
};
```

#### 4.1.4 虚拟环境检测
```javascript
const VIRTUAL_ENV_INDICATORS = {
  // 进程名检测（克隆应用的进程名会包含原包名）
  PROCESS_NAME_CHECK: true,
  
  // 用户 ID 检测（VirtualApp 等会使用不同 UID）
  UID_CHECK: true,
  
  // 外部存储路径检测
  EXTERNAL_PATH_CHECK: [
    '/data/data/<package>',  // 虚拟环境会重定向
    '/storage/emulated/0/Android/data/<package>',
  ],
  
  // 常见虚拟环境包名
  VIRTUAL_PACKAGES: [
    'com.lbe.parallel',
    'com.lody.virtual',
    'io.virtualapp',
    'com.excelliance.dualaid',
    'com.ludashi.dualboot',
  ],
};
```

#### 4.1.5 Hook 框架检测
```javascript
const HOOK_INDICATORS = {
  // Xposed 检测
  XPOSED: {
    PACKAGE: 'de.robv.android.xposed.installer',
    FILES: [
      '/system/framework/XposedBridge.jar',
      '/system/framework/xposed/',
    ],
    STACK_TRACE: 'de.robv.android.xposed', // 堆栈中的特征
  },
  
  // Frida 检测
  FRIDA: {
    PORTS: [27042, 27043], // Frida 默认端口
    FILES: [
      '/data/local/tmp/frida-server',
      '/data/local/tmp/frida',
      '/data/local/tmp/re.frida.server',
    ],
    LIBRARIES: ['frida-agent', 'frida-gadget'],
    PROCESSES: ['frida-server', 'frida'],
  },
  
  // Substrate 检测
  SUBSTRATE: {
    FILES: [
      '/data/data/com.saurik.substrate',
      '/system/lib/libsubstrate.so',
      '/system/lib/libsubstrate-dex.so',
    ],
  },
};
```

### 4.2 设备指纹系统

```javascript
/**
 * 设备指纹生成算法
 * 综合多个维度生成唯一设备标识
 */
async function generateDeviceFingerprint() {
  const components = {
    // 硬件特征
    hardware: {
      brand: getSystemProp('ro.product.brand'),
      model: getSystemProp('ro.product.model'),
      device: getSystemProp('ro.product.device'),
      board: getSystemProp('ro.product.board'),
      manufacturer: getSystemProp('ro.product.manufacturer'),
      cpu_abi: getSystemProp('ro.product.cpu.abi'),
      // 传感器指纹
      sensors: await getSensorFingerprint(),
      // 屏幕特征
      screen: {
        width: screen.width,
        height: screen.height,
        density: window.devicePixelRatio,
      },
    },
    
    // 系统特征
    system: {
      android_id: getAndroidId(),
      os_version: getSystemProp('ro.build.version.release'),
      sdk_version: getSystemProp('ro.build.version.sdk'),
      fingerprint: getSystemProp('ro.build.fingerprint'),
      security_patch: getSystemProp('ro.build.version.security_patch'),
    },
    
    // 网络特征
    network: {
      wifi_mac: await getWifiMac(), // 需要权限
      bluetooth_mac: await getBluetoothMac(), // 需要权限
    },
    
    // 应用特征
    app: {
      install_time: getAppInstallTime(),
      last_update_time: getAppLastUpdateTime(),
      version_code: getAppVersionCode(),
      signature_hash: getAppSignatureHash(),
    },
    
    // 时间戳
    timestamp: Date.now(),
  };
  
  // 生成 SHA-256 哈希
  const fingerprint = await sha256(JSON.stringify(components));
  
  return {
    fingerprint,
    components: {
      ...components,
      // 敏感信息脱敏后再上报
      network: { /* 已脱敏 */ },
    },
  };
}

/**
 * 传感器指纹
 * 通过传感器特征组合识别设备
 */
async function getSensorFingerprint() {
  const sensors = await navigator.sensors?.getSensors() || [];
  return sensors.map(s => ({
    type: s.type,
    name: s.name,
    vendor: s.vendor,
    version: s.version,
    maxRange: s.maxRange,
    resolution: s.resolution,
  })).sort((a, b) => a.type.localeCompare(b.type));
}
```

### 4.3 后端验证 API

#### 4.3.1 设备注册 API
```
POST /api/device/register
```

请求体：
```json
{
  "fingerprint": "sha256_hash",
  "components": { /* 设备组件信息 */ },
  "integrity": {
    "is_emulator": false,
    "is_rooted": false,
    "is_virtual_env": false,
    "has_hook_framework": false,
    "risk_score": 0
  },
  "app_version": "1.0.0",
  "os_version": "14"
}
```

响应：
```json
{
  "device_id": "dev_abc123",
  "trust_level": "HIGH",
  "restrictions": [],
  "message": null
}
```

#### 4.3.2 设备风险评分

```javascript
/**
 * 设备风险评分算法
 * 综合多个因素计算 0-100 的风险分数
 */
function calculateDeviceRiskScore(deviceInfo) {
  let score = 0;
  
  // 模拟器检测（最高风险）
  if (deviceInfo.is_emulator) {
    score += 80;
    metrics.deviceRisk.inc({ type: 'emulator' });
  }
  
  // Root/越狱检测
  if (deviceInfo.is_rooted || deviceInfo.is_jailbroken) {
    score += 40;
    metrics.deviceRisk.inc({ type: 'rooted' });
  }
  
  // 虚拟环境检测
  if (deviceInfo.is_virtual_env) {
    score += 50;
    metrics.deviceRisk.inc({ type: 'virtual_env' });
  }
  
  // Hook 框架检测
  if (deviceInfo.has_hook_framework) {
    score += 30;
    metrics.deviceRisk.inc({ type: 'hook_framework' });
  }
  
  // 设备关联账号数量
  if (deviceInfo.account_count > 3) {
    score += Math.min(30, deviceInfo.account_count * 10);
    metrics.deviceRisk.inc({ type: 'multi_account' });
  }
  
  // 设备活跃时间异常
  if (deviceInfo.activity_hours > 20) {
    score += 20;
    metrics.deviceRisk.inc({ type: 'abnormal_activity' });
  }
  
  return Math.min(100, score);
}

/**
 * 根据风险分数决定处理策略
 */
function getDevicePolicy(riskScore) {
  if (riskScore >= 80) {
    return {
      action: 'BLOCK',
      message: '您的设备存在安全风险，无法登录游戏',
    };
  } else if (riskScore >= 50) {
    return {
      action: 'RESTRICT',
      restrictions: ['NO_TRADING', 'NO_TRANSFER', 'LIMITED_CATCH_RATE'],
      message: '您的设备存在安全风险，部分功能受限',
    };
  } else if (riskScore >= 30) {
    return {
      action: 'MONITOR',
      restrictions: [],
      message: null,
    };
  }
  
  return {
    action: 'ALLOW',
    restrictions: [],
    message: null,
  };
}
```

### 4.4 数据库设计

```sql
-- 设备注册表
CREATE TABLE device_registrations (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64) UNIQUE NOT NULL,
  fingerprint VARCHAR(128) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id),
  
  -- 设备信息
  brand VARCHAR(50),
  model VARCHAR(100),
  os_type VARCHAR(20), -- 'android' or 'ios'
  os_version VARCHAR(20),
  app_version VARCHAR(20),
  
  -- 完整性检测结果
  is_emulator BOOLEAN DEFAULT FALSE,
  is_rooted BOOLEAN DEFAULT FALSE,
  is_jailbroken BOOLEAN DEFAULT FALSE,
  is_virtual_env BOOLEAN DEFAULT FALSE,
  has_hook_framework BOOLEAN DEFAULT FALSE,
  
  -- 风险评分
  risk_score INTEGER DEFAULT 0,
  trust_level VARCHAR(20) DEFAULT 'HIGH', -- HIGH, MEDIUM, LOW, BANNED
  
  -- 状态
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, BANNED, RESTRICTED
  restrictions TEXT[], -- 功能限制列表
  
  -- 时间戳
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW(),
  last_check_at TIMESTAMP,
  
  -- 元数据
  metadata JSONB DEFAULT '{}',
  
  INDEX idx_device_user (user_id),
  INDEX idx_device_fingerprint (fingerprint),
  INDEX idx_device_risk (risk_score DESC)
);

-- 设备-账号关联表
CREATE TABLE device_account_associations (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64) REFERENCES device_registrations(device_id),
  user_id INTEGER REFERENCES users(id),
  
  first_login_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP DEFAULT NOW(),
  login_count INTEGER DEFAULT 1,
  
  UNIQUE (device_id, user_id),
  INDEX idx_association_device (device_id),
  INDEX idx_association_user (user_id)
);

-- 设备检测日志表
CREATE TABLE device_integrity_logs (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64),
  user_id INTEGER,
  
  -- 检测结果快照
  detection_result JSONB NOT NULL,
  risk_score INTEGER,
  action_taken VARCHAR(20),
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_integrity_log_device (device_id),
  INDEX idx_integrity_log_created (created_at)
);
```

### 4.5 集成点

#### 4.5.1 登录流程集成
```javascript
// gateway/src/middleware/deviceCheck.js
async function deviceIntegrityCheck(req, res, next) {
  const deviceInfo = req.headers['x-device-info'];
  
  if (!deviceInfo) {
    // 旧版本客户端，允许通过但标记为低信任
    req.deviceTrustLevel = 'UNKNOWN';
    return next();
  }
  
  try {
    const parsed = JSON.parse(Base64.decode(deviceInfo));
    const result = await registerDevice(parsed, req.user?.sub);
    
    if (result.action === 'BLOCK') {
      return res.status(403).json({
        code: 7001,
        message: result.message,
        data: { risk_score: result.risk_score }
      });
    }
    
    req.deviceId = result.device_id;
    req.deviceTrustLevel = result.trust_level;
    req.deviceRestrictions = result.restrictions;
    
    next();
  } catch (err) {
    logger.error({ err }, 'Device integrity check failed');
    next(); // 失败时允许通过，避免影响正常用户
  }
}
```

#### 4.5.2 敏感操作检查
```javascript
// 检查设备是否有特定限制
function checkDeviceRestriction(restriction) {
  return async (req, res, next) => {
    if (req.deviceRestrictions?.includes(restriction)) {
      return res.status(403).json({
        code: 7002,
        message: '您的设备存在安全风险，该功能不可用',
        data: { restriction }
      });
    }
    next();
  };
}

// 应用到交易路由
app.post('/trade', 
  requireAuth, 
  checkDeviceRestriction('NO_TRADING'),
  tradeHandler
);
```

### 4.6 Prometheus 指标

```javascript
const deviceMetrics = {
  // 设备风险分布
  deviceRiskScore: new Histogram({
    name: 'minego_device_risk_score',
    help: 'Device risk score distribution',
    buckets: [0, 10, 20, 30, 50, 80, 100],
    labelNames: ['action'],
  }),
  
  // 检测结果统计
  deviceDetectionTotal: new Counter({
    name: 'minego_device_detection_total',
    help: 'Total device detections by type',
    labelNames: ['type', 'result'],
  }),
  
  // 设备阻止次数
  deviceBlockedTotal: new Counter({
    name: 'minego_device_blocked_total',
    help: 'Total blocked devices by reason',
    labelNames: ['reason'],
  }),
  
  // 多账号设备检测
  multiAccountDeviceTotal: new Counter({
    name: 'minego_multi_account_device_total',
    help: 'Devices with multiple accounts',
    labelNames: ['account_count_range'],
  }),
};
```

## 5. 验收标准（可测试）

- [ ] 能识别 10+ 主流 Android 模拟器（BlueStacks、Nox、LDPlayer、MEmu、Genymotion 等），识别率 > 95%
- [ ] 能检测 Root 设备（Magisk、SuperSU、KingRoot 等），检测率 > 90%
- [ ] 能检测越狱 iOS 设备（Cydia、Sileo、Unc0ver 等），检测率 > 90%
- [ ] 能检测虚拟运行环境（VirtualApp、平行空间、Dual Space 等）
- [ ] 能检测 Hook 框架（Xposed、Frida、Substrate）
- [ ] 设备指纹冲突率 < 0.01%（100 万设备中冲突 < 100 个）
- [ ] 后端 API 支持 1000 QPS，响应时间 < 50ms（P95）
- [ ] 设备风险评分算法准确率 > 95%（基于历史作弊数据验证）
- [ ] 单元测试覆盖率 > 90%
- [ ] 集成测试覆盖登录、捕捉、交易等核心场景

## 6. 工作量估算

**L（大型）**

- 客户端检测 SDK：3-5 天
- 后端 API 与数据库：2-3 天
- 设备指纹系统：2 天
- 风险评分算法：1-2 天
- 集成与测试：2-3 天
- 文档与部署：1 天

**总计：11-16 人天**

## 7. 优先级理由

**P1 理由：**

1. **安全基础**：设备完整性是反作弊的底层防线，缺少这一层，上层检测效果大打折扣
2. **影响范围广**：模拟器和 Root 设备是最常见的作弊手段，影响大量正常玩家体验
3. **防止批量作弊**：群控脚本依赖模拟器运行多账号，设备检测可从源头阻止
4. **低误判风险**：相比行为检测，设备检测误判率更低，对正常用户影响小
5. **与其他反作弊协同**：设备信任分数可与 GPS 检测、行为检测联动，提高整体准确率

**对"项目可用"的贡献：**
- 阻止 95%+ 模拟器作弊，保护游戏公平性
- 建立设备-账号关联，识别群控作弊
- 为后续更高级的反作弊打下基础
