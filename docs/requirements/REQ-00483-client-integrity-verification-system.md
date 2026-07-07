# REQ-00483: 客户端完整性验证与运行环境检测系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00483 |
| 标题 | 客户端完整性验证与运行环境检测系统 |
| 类别 | 安全加固/反作弊 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gateway-service/game-client/anti-cheat-service |
| 创建时间 | 2026-07-07 12:00 |
| 依赖需求 | REQ-00475 |

## 1. 背景与问题

mineGo 作为一款基于 GPS 的 AR 游戏，面临着严重的客户端作弊威胁：

**当前痛点：**
- 现有 REQ-00010 (GPS伪造检测) 和 REQ-00475 (行为风控) 主要关注服务端检测，缺乏客户端层面的主动防御
- 攻击者可以使用修改过的客户端绕过验证逻辑，修改精灵属性、捕捉概率等核心数据
- Root/越狱设备可运行注入框架，Hook 关键函数进行作弊
- 模拟器用户可以批量创建账号进行刷号、刷资源
- 当前缺乏客户端签名验证机制，无法识别二次打包的非法客户端

**真实代码现状：**
- `backend/gateway/src/middleware/risk-control.js` 实现了基础风控，但依赖客户端提交的数据
- 缺少客户端环境可信度验证
- 游戏客户端为纯 JavaScript 实现，容易被逆向和篡改

**安全缺口：**
1. 无法识别运行在 Root/越狱环境的客户端
2. 无法检测模拟器环境
3. 无法防止内存修改器和注入框架
4. 无法验证客户端签名完整性
5. 缺少运行时完整性校验机制

## 2. 目标

构建一套客户端完整性验证与运行环境检测系统，从源头提升作弊成本，与服务端反作弊形成纵深防御：

- **可信执行环境检测**：识别 Root/越狱、模拟器、注入框架
- **客户端签名验证**：防止二次打包和客户端篡改
- **运行时完整性校验**：检测内存修改、函数 Hook
- **环境风险评分**：综合评估客户端可信度，触发不同级别的验证策略

**可量化目标：**
- 非法客户端检测准确率 > 95%
- 模拟器环境检测率 > 98%
- Root/越狱检测率 > 99%
- 验证延迟 < 200ms（不影响正常用户体验）

## 3. 范围

**包含：**
- 客户端环境检测模块（Root/越狱、模拟器、注入框架）
- 客户端签名验证服务
- 运行时完整性校验机制
- 环境风险评分引擎
- 挑战-响应验证协议
- 与现有风控系统的集成
- 验证结果持久化与审计日志

**不包含：**
- 原生移动应用开发（当前为 Web 客户端）
- 服务器端代码混淆
- 支付风控（已有独立模块）
- GPS 欺骗检测（REQ-00010 已实现）

## 4. 详细需求

### 4.1 客户端环境检测

**Root/越狱检测：**
```javascript
// Web 环境下通过浏览器特性检测
class EnvironmentDetector {
  detectRootOrJailbreak() {
    // 检测开发者工具、调试器
    // 检测异常的全局对象修改
    // 检测特定的调试相关属性
  }
}
```

**模拟器检测：**
```javascript
// 浏览器指纹 + 硬件特征分析
class EmulatorDetector {
  detectEmulator() {
    // WebGL 渲染器特征（SwiftShader 等软件渲染器）
    // Canvas 指纹异常
    // WebRTC 本地 IP 异常
    // Battery API 异常值
    // Navigator 属性异常
    // 触摸屏支持异常
  }
}
```

**注入框架检测：**
```javascript
// 检测常见的 Hook 框架和修改器
class InjectionDetector {
  detectInjection() {
    // 检测全局对象被 Hook 的痕迹
    // 检测原型链被篡改
    // 检测函数 toString() 结果异常
    // 检测 Performance API 异常（时间加速）
  }
}
```

### 4.2 客户端签名验证

**签名生成机制：**
- 客户端代码通过构建流程生成唯一签名
- 签名包含：核心脚本哈希 + 版本号 + 时间戳
- 使用 HMAC-SHA256 算法，密钥由服务端保管

**验证流程：**
```
Client                              Server
  |                                    |
  |---- 1. 请求携带 clientSignature ---->|
  |                                    |---- 2. 验证签名
  |                                    |---- 3. 检查版本
  |<--- 4. 返回验证结果 + challenge -----|
  |---- 5. 执行 challenge 并返回结果 ---->|
  |<--- 6. 授予访问令牌 ------------------|
```

### 4.3 挑战-响应验证协议

**挑战类型：**
1. **计算挑战**：要求客户端执行特定计算，验证执行环境
2. **行为挑战**：要求用户完成特定交互（如拖动滑块）
3. **延迟挑战**：测量请求往返时间，检测加速器

**实现示例：**
```javascript
class ChallengeResponseSystem {
  // 生成随机计算任务
  generateComputationChallenge() {
    return {
      type: 'compute',
      operations: ['hash', 'encrypt', 'transform'],
      payload: crypto.randomBytes(32).toString('base64'),
      difficulty: 'medium', // 调整计算复杂度
      timeout: 5000
    };
  }
  
  // 验证挑战响应
  verifyChallengeResponse(challenge, response) {
    // 检查响应正确性
    // 检查响应时间是否合理
    // 检查是否有加速器痕迹
  }
}
```

### 4.4 运行时完整性校验

**关键函数校验：**
```javascript
class IntegrityChecker {
  // 定期校验核心函数是否被篡改
  checkFunctionIntegrity() {
    const criticalFunctions = [
      'calculateCaptureProbability',
      'processPokemonData',
      'validateLocation',
      'encryptPayload'
    ];
    
    for (const funcName of criticalFunctions) {
      const func = window.gameCore[funcName];
      const sourceCode = func.toString();
      const hash = crypto.subtle.digest('SHA-256', sourceCode);
      
      if (hash !== EXPECTED_HASHES[funcName]) {
        this.reportTampering(funcName);
      }
    }
  }
}
```

**内存保护：**
```javascript
// 使用 Object.freeze 保护关键对象
Object.freeze(window.gameConfig);
Object.freeze(window.gameConstants);

// 使用 Proxy 监控属性访问
const protectedCore = new Proxy(window.gameCore, {
  set(target, prop, value) {
    logTamperingAttempt(prop, value);
    return false; // 阻止修改
  }
});
```

### 4.5 环境风险评分引擎

**评分维度：**
```javascript
const ENV_RISK_FACTORS = {
  deviceTrust: {
    weight: 0.25,
    factors: {
      isRooted: 40,
      isEmulator: 50,
      isDebuggerAttached: 60,
      hasInjection: 70
    }
  },
  clientIntegrity: {
    weight: 0.30,
    factors: {
      signatureMismatch: 80,
      functionTampered: 70,
      codeModified: 90
    }
  },
  behaviorAnomaly: {
    weight: 0.25,
    factors: {
      timeAcceleration: 50,
      requestFlood: 40,
      impossibleMovement: 60
    }
  },
  historicalRisk: {
    weight: 0.20,
    factors: {
      previousViolations: 30,
      accountAge: 20,
      deviceReputation: 25
    }
  }
};
```

**风险等级与响应：**
| 风险等级 | 分数范围 | 响应措施 |
|---------|---------|---------|
| LOW | 0-25 | 正常访问 |
| MEDIUM | 26-50 | 增加验证频率 |
| HIGH | 51-75 | 强制重新验证，限制敏感操作 |
| CRITICAL | 76-100 | 阻止访问，要求人工验证 |

### 4.6 与现有风控系统集成

**集成点：**
- `backend/gateway/src/middleware/risk-control.js` 添加环境验证中间件
- 风险评分与现有 `RiskScorer` 合并计算
- 验证失败触发现有的账号限制流程

**数据流：**
```
Client Request
    ↓
[Environment Verification Middleware]  ← 新增
    ↓
[Risk-Control Middleware]              ← 现有
    ↓
[Business Logic]
```

## 5. 验收标准（可测试）

- [ ] 客户端能够在加载时完成环境检测，检测结果发送至服务端
- [ ] 服务端能够验证客户端签名，拒绝签名不匹配的请求（返回 403）
- [ ] 系统能够识别运行在 Chrome DevTools 开启状态的客户端
- [ ] 系统能够检测到函数被 Hook（如通过 toString 比对）
- [ ] 模拟器环境（通过 User Agent 和 WebGL 特征）检测准确率 > 95%
- [ ] 挑战-响应机制能够阻止自动化脚本的批量请求
- [ ] 环境风险评分能够在 200ms 内完成并缓存
- [ ] 所有验证结果记录到审计日志，包含设备指纹、风险因素、决策路径
- [ ] 与现有 RiskScorer 集成后，综合风险评分与单一评分差异 < 10%
- [ ] 新增单元测试覆盖率 > 80%

## 6. 工作量估算

**工作量：L（Large）**

**理由：**
- 需要新增反作弊微服务模块（~1500 行代码）
- 客户端检测模块需要深度集成到游戏客户端（~800 行）
- 挑战-响应协议设计与实现（~500 行）
- 与现有风控系统的集成与测试（~400 行）
- 完整的单元测试和集成测试（~600 行）
- 总计约 3800 行代码

**子任务拆分：**
1. 环境检测模块开发（2天）
2. 签名验证服务开发（1天）
3. 挑战-响应系统开发（2天）
4. 风险评分引擎开发（1天）
5. 系统集成与测试（2天）
6. 文档与审计日志（1天）

**总计：9 个工作日**

## 7. 优先级理由

**P1 优先级的必要性：**

1. **安全纵深防御**：当前反作弊体系主要依赖服务端检测（GPS、行为分析），客户端层面几乎无防护。攻击者可以轻松修改客户端绕过验证逻辑。

2. **核心业务影响**：
   - 精灵属性被修改 → 破坏游戏平衡
   - 捕捉概率被修改 → 影响游戏经济
   - 批量模拟器刷号 → 虚假用户数据

3. **攻击成本低**：当前纯 JS 客户端易于逆向和修改，攻击成本极低，需要提升攻击门槛。

4. **与 REQ-00475 协同**：REQ-00475 提供实时行为风控，本需求提供客户端可信基线，两者结合形成完整反作弊闭环。

5. **生产可用性**：项目成熟度已达 107/100，P0/P1 需求基本完成，当前应优先补充安全短板。

**与其他需求对比：**
- 相比 REQ-00478（数据归档）、REQ-00479（缓存失效策略）等优化类需求，安全防护对游戏公平性和商业价值影响更大
- 与 REQ-00476（API 性能预算）同等重要，但安全优先级应略高于性能优化

---

**创建时间：** 2026-07-07 12:00 UTC  
**最后更新：** 2026-07-07 12:00 UTC
