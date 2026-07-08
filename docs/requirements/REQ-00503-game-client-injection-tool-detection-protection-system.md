# REQ-00503：游戏客户端注入工具检测与防护系统

- **编号**：REQ-00503
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、gateway/src/middleware/security、backend/shared/anti-cheat
- **创建时间**：2026-07-08 11:00
- **依赖需求**：REQ-00163（内存完整性保护）、REQ-00494（行为风控系统）

## 1. 背景与问题

mineGo 游戏客户端在移动端面临常见注入工具的攻击威胁：

### 1.1 当前风险分析

| 注入工具 | 风险等级 | 攻击场景 | 检测现状 |
|---------|---------|---------|---------|
| **Frida** | 高 | 动态 Hook 关键函数修改捕捉概率、精灵数据 | ❌ 未检测 |
| **Xposed/LSPosed** | 高 | 模块化修改游戏逻辑、绕过验证 | ❌ 未检测 |
| **GameGuardian** | 中 | 内存数值搜索修改金币/精灵数量 | ⚠️ 部分（REQ-00163） |
| **VirtualXposed** | 高 | 虚拟环境下运行免Root注入 | ❌ 未检测 |
| **Il2CppDumper** | 中 | 提取 Unity DLL 分析游戏逻辑 | ❌ 未检测 |

### 1.2 已有反作弊覆盖

- REQ-00163/REQ-00181：内存完整性保护（针对内存篡改）
- REQ-00247：位置伪造检测
- REQ-00289：交易欺诈检测
- REQ-00416/REQ-00427：经济异常检测
- REQ-00494：实时行为风控

**缺口**：缺少针对注入工具本身的检测，攻击者可通过 Frida 等工具绕过现有防护。

### 1.3 实际影响

- **游戏公平性**：使用注入工具的用户捕捉概率可达 100%
- **经济安全**：恶意修改精灵数据进行非法交易
- **数据泄露**：通过注入提取敏感加密密钥

## 2. 目标

构建注入工具检测与防护体系：

1. **多维度检测**：进程扫描、端口检测、特征文件识别
2. **动态响应**：实时阻断 + 延迟上报 + 服务器协同验证
3. **误判防护**：避免误报正常开发调试环境
4. **版本演进**：检测逻辑热更新，对抗工具升级

**预期效果**：注入工具使用检出率 ≥ 85%，误报率 < 0.5%

## 3. 范围

### 包含
- Frida 服务端/客户端检测（端口 27042、进程 frida-server）
- Xposed/LSPosed 检测（特征文件、ClassLoader 钩子检测）
- GameGuardian 进程检测
- 虚拟环境检测（VirtualXposed、太极、平行空间）
- 检测结果上报与服务端协同验证
- 检测规则热更新机制

### 不包含
- PC 端模拟器检测（REQ-00045 已覆盖）
- API 级防重放攻击（REQ-00434 已覆盖）
- Root 环境检测（非技术重点，现代注入工具可在免Root环境运行）

## 4. 详细需求

### 4.1 InjectionDetector 核心模块

```javascript
// game-client/src/security/InjectionDetector.js

class InjectionDetector {
  constructor() {
    this.detectionRules = new Map();
    this.lastDetectionTime = 0;
    this.detectionInterval = 60000; // 每分钟检测一次
    this.reportQueue = [];
    this.hotUpdateUrl = '/api/v1/security/detection-rules';
  }

  /**
   * 主检测入口
   * @returns {DetectionResult} 检测结果
   */
  async performDetection() {
    const results = {
      timestamp: Date.now(),
      detections: [],
      riskLevel: 'low',
      deviceId: await this.getDeviceId()
    };

    // 1. Frida 检测
    const fridaResult = await this.detectFrida();
    if (fridaResult.detected) {
      results.detections.push(fridaResult);
      results.riskLevel = 'high';
    }

    // 2. Xposed/LSPosed 检测
    const xposedResult = await this.detectXposed();
    if (xposedResult.detected) {
      results.detections.push(xposedResult);
      results.riskLevel = xposedResult.isVirtual ? 'critical' : 'high';
    }

    // 3. GameGuardian 检测
    const ggResult = await this.detectGameGuardian();
    if (ggResult.detected) {
      results.detections.push(ggResult);
      results.riskLevel = 'medium';
    }

    // 4. 虚拟环境检测
    const virtualResult = await this.detectVirtualEnvironment();
    if (virtualResult.detected) {
      results.detections.push(virtualResult);
      results.riskLevel = 'critical';
    }

    // 5. 记录并上报
    this.recordDetection(results);
    if (results.riskLevel !== 'low') {
      await this.reportToServer(results);
    }

    return results;
  }

  /**
   * Frida 检测策略
   */
  async detectFrida() {
    const indicators = [];

    // 策略 1：检测 frida-server 进程（Android）
    if (this.isAndroid()) {
      const processList = await this.getProcessList();
      const fridaProcesses = processList.filter(p => 
        p.name.includes('frida-server') || p.name.includes('frida')
      );
      if (fridaProcesses.length > 0) {
        indicators.push({ type: 'process', name: fridaProcesses[0].name });
      }

      // 策略 2：检测 Frida 默认端口 27042
      const portCheck = await this.checkPort(27042);
      if (portCheck.open) {
        indicators.push({ type: 'port', port: 27042 });
      }
    }

    // 策略 3：检测 Frida 特征文件
    const fridaFiles = [
      '/data/local/tmp/frida-server',
      '/data/local/tmp/re.frida.server',
      '/tmp/frida-server'
    ];
    for (const file of fridaFiles) {
      if (await this.fileExists(file)) {
        indicators.push({ type: 'file', path: file });
      }
    }

    // 策略 4：检测 Java/Hook 钩子痕迹（Android）
    if (this.isAndroid() && window.Java) {
      try {
        // Frida 注入后会修改 ClassLoader
        const hookedMethods = this.inspectClassLoaderHooks();
        if (hookedMethods.length > 0) {
          indicators.push({ type: 'hook', methods: hookedMethods });
        }
      } catch (e) {
        // 检测失败本身可能是反检测手段
        indicators.push({ type: 'anti-detection', error: e.message });
      }
    }

    return {
      tool: 'Frida',
      detected: indicators.length > 0,
      indicators,
      severity: indicators.length >= 2 ? 'high' : 'medium'
    };
  }

  /**
   * Xposed/LSPosed 检测策略
   */
  async detectXposed() {
    const indicators = [];

    // 策略 1：检测特征文件路径
    const xposedPaths = [
      '/system/framework/XposedBridge.jar',
      '/system/xposed.prop',
      '/data/misc/xposed/xposed.prop',
      '/data/adb/lspd/config',
      '/data/adb/modules/lspd'
    ];
    for (const path of xposedPaths) {
      if (await this.fileExists(path)) {
        indicators.push({ type: 'file', path });
      }
    }

    // 策略 2：检测 Xposed API 痕迹
    if (window.XposedBridge) {
      indicators.push({ type: 'api', found: 'XposedBridge' });
    }

    // 策略 3：检测堆栈中的 Xposed 调用痕迹
    try {
      const stackTrace = this.captureStackTrace();
      const xposedFrames = stackTrace.filter(f => 
        f.includes('de.robv.android.xposed') || 
        f.includes('org.lsposed.lspd')
      );
      if (xposedFrames.length > 0) {
        indicators.push({ type: 'stack', frames: xposedFrames.slice(0, 3) });
      }
    } catch (e) {}

    return {
      tool: 'Xposed/LSPosed',
      detected: indicators.length > 0,
      indicators,
      severity: 'high',
      isVirtual: await this.isVirtualXposed()
    };
  }

  /**
   * GameGuardian 检测
   */
  async detectGameGuardian() {
    const indicators = [];

    // 进程名检测
    const ggProcessNames = [
      'gameguardian',
      'gg_process',
      'speed.gg',
      'gameguardian.android'
    ];
    const processList = await this.getProcessList();
    const ggProcess = processList.find(p => 
      ggProcessNames.some(name => p.name.toLowerCase().includes(name))
    );
    if (ggProcess) {
      indicators.push({ type: 'process', pid: ggProcess.pid, name: ggProcess.name });
    }

    return {
      tool: 'GameGuardian',
      detected: indicators.length > 0,
      indicators,
      severity: 'medium'
    };
  }

  /**
   * 虚拟环境检测（VirtualXposed、太极等）
   */
  async detectVirtualEnvironment() {
    const indicators = [];

    // 检测虚拟应用包名
    const virtualPackages = [
      'io.va.exposed',
      'com.exposed.plugin',
      'com.lzplay.np',
      'me.weishu.exp',
      'com.tsng.hidemyapplist'
    ];
    const installedPackages = await this.getInstalledPackages();
    const foundPackages = virtualPackages.filter(pkg => installedPackages.includes(pkg));
    if (foundPackages.length > 0) {
      indicators.push({ type: 'package', packages: foundPackages });
    }

    // 检测虚拟环境特征
    // VirtualXposed 会修改应用的路径前缀
    if (this.getApplicationPath().includes('virtual') || 
        this.getApplicationPath().includes('clone')) {
      indicators.push({ type: 'path', path: this.getApplicationPath() });
    }

    return {
      tool: 'VirtualEnvironment',
      detected: indicators.length > 0,
      indicators,
      severity: 'critical'
    };
  }

  /**
   * 检测规则热更新
   */
  async loadRulesFromServer() {
    try {
      const response = await fetch(this.hotUpdateUrl, {
        headers: { 'X-Device-ID': await this.getDeviceId() }
      });
      const rules = await response.json();
      
      // 更新检测规则
      for (const rule of rules) {
        this.detectionRules.set(rule.id, rule);
      }
      
      logger.info('Detection rules updated', { count: rules.length });
    } catch (e) {
      logger.error('Failed to load detection rules', { error: e.message });
    }
  }

  /**
   * 上报检测结果
   */
  async reportToServer(results) {
    const report = {
      deviceId: results.deviceId,
      timestamp: results.timestamp,
      riskLevel: results.riskLevel,
      detections: results.detections.map(d => ({
        tool: d.tool,
        indicators: d.indicators.map(i => ({
          type: i.type,
          // 不上报敏感细节，只上报类型
          detected: true
        }))
      }))
    };

    try {
      await fetch('/api/v1/security/injection-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      
      // 记录上报成功
      metrics.increment('injection_report_success');
    } catch (e) {
      // 缓存到本地队列，后续重试
      this.reportQueue.push(report);
      metrics.increment('injection_report_failed');
    }
  }

  /**
   * 响应策略：根据风险等级采取不同措施
   */
  handleDetectionResult(results) {
    switch (results.riskLevel) {
      case 'critical':
        // 虚拟环境/严重注入：立即阻止游戏
        this.blockGameAccess('Virtual environment detected');
        break;
      case 'high':
        // Frida/Xposed：延迟上报 + 功能降级
        this.degradeGameFeatures();
        this.showWarning('Injection tool detected');
        break;
      case 'medium':
        // GameGuardian：记录警告
        this.showWarning('Memory tool detected');
        break;
      case 'low':
        // 正常：无操作
        break;
    }
  }
}

// 导出单例
module.exports = new InjectionDetector();
```

### 4.2 服务端协同验证

```javascript
// gateway/src/routes/security.js 新增接口

/**
 * POST /api/v1/security/injection-report
 * 接收客户端注入检测结果
 */
router.post('/injection-report', async (req, res) => {
  try {
    const { deviceId, timestamp, riskLevel, detections } = req.body;
    
    // 验证请求签名
    if (!verifyRequestSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 存储检测结果
    await query(
      `INSERT INTO injection_detection_reports 
       (device_id, timestamp, risk_level, detections, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [deviceId, timestamp, riskLevel, JSON.stringify(detections)]
    );

    // 高风险设备自动标记
    if (riskLevel === 'critical' || riskLevel === 'high') {
      await redis.set(`flagged_device:${deviceId}`, riskLevel, 'EX', 86400 * 30);
      
      // 触发账号风控联动
      await triggerAccountSecurityReview(deviceId);
    }

    // Prometheus 指标
    metrics.increment('injection_reports_total', { risk_level: riskLevel });

    res.json({ success: true, action: getActionForRiskLevel(riskLevel) });
  } catch (error) {
    logger.error({ error }, 'Failed to process injection report');
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/v1/security/detection-rules
 * 提供检测规则热更新
 */
router.get('/detection-rules', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    
    // 根据设备特征返回定制规则（如地区、版本）
    const rules = await query(
      `SELECT * FROM detection_rules 
       WHERE enabled = true 
       AND (target_region IS NULL OR target_region = $1)
       ORDER BY priority DESC`,
      [getDeviceRegion(deviceId)]
    );

    res.json({ 
      version: await getRulesVersion(),
      rules: rules.rows,
      nextUpdateIn: 3600 // 1小时后更新
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get detection rules');
    res.status(500).json({ error: 'Internal error' });
  }
});

function getActionForRiskLevel(riskLevel) {
  switch (riskLevel) {
    case 'critical': return 'block';
    case 'high': return 'degrade';
    case 'medium': return 'warn';
    case 'low': return 'none';
    default: return 'none';
  }
}
```

### 4.3 数据库迁移

```sql
-- database/migrations/20260708_create_injection_detection.sql

CREATE TABLE injection_detection_reports (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  timestamp BIGINT NOT NULL,
  risk_level VARCHAR(16) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  detections JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_injection_device ON injection_detection_reports(device_id);
CREATE INDEX idx_injection_risk ON injection_detection_reports(risk_level, created_at);

CREATE TABLE detection_rules (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  tool_type VARCHAR(32) NOT NULL, -- 'frida', 'xposed', 'gameguardian', 'virtual'
  detection_strategy JSONB NOT NULL,
  severity VARCHAR(16) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  target_region VARCHAR(16),
  priority INTEGER DEFAULT 50,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 初始检测规则
INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('frida-port', 'Frida 默认端口检测', 'frida', '{"type": "port", "port": 27042}', 'medium', 80),
('frida-process', 'Frida 服务端进程检测', 'frida', '{"type": "process", "pattern": "frida-server"}', 'high', 90),
('xposed-file', 'Xposed 特征文件检测', 'xposed', '{"type": "file", "paths": ["/system/framework/XposedBridge.jar"]}', 'high', 90),
('gg-process', 'GameGuardian 进程检测', 'gameguardian', '{"type": "process", "patterns": ["gameguardian", "gg_process"]}', 'medium', 70),
('virtual-pkg', '虚拟环境包名检测', 'virtual', '{"type": "package", "packages": ["io.va.exposed"]}', 'critical', 100);
```

### 4.4 Prometheus 指标

```yaml
# prometheus/alerts.yml 新增

- alert: HighInjectionDetectionRate
  expr: rate(injection_reports_total{risk_level="high"}[5m]) > 10
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "注入工具检测率异常升高"
    description: "过去 5 分钟高风险注入检测率 {{ $value }}/s，请检查是否有新型作弊工具流行"

- alert: CriticalInjectionBlocked
  expr: increase(injection_reports_total{risk_level="critical"}[1h]) > 50
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "虚拟环境检测量超过阈值"
    description: "1 小时内检测到 {{ $value }} 个虚拟环境使用，建议加强账号审核"
```

## 5. 验收标准（可测试）

- [ ] Frida 端口检测在测试设备上检出率 ≥ 90%
- [ ] Xposed 特征文件检测准确率 ≥ 95%
- [ ] VirtualXposed 虚拟环境检出率 ≥ 85%
- [ ] GameGuardian 进程检测检出率 ≥ 80%
- [ ] 检测逻辑 `node --check game-client/src/security/InjectionDetector.js` 通过
- [ ] `/api/v1/security/injection-report` 接口返回 200 并记录数据库
- [ ] `/api/v1/security/detection-rules` 返回有效 JSON 规则列表
- [ ] 高风险检测结果自动标记设备（Redis 缓存验证）
- [ ] Prometheus 指标 `injection_reports_total` 正常上报
- [ ] 检测规则热更新机制可用（修改规则后客户端生效）
- [ ] 误报率 < 0.5%（正常开发设备不误报）
- [ ] 单元测试覆盖核心检测逻辑 ≥ 75%

## 6. 工作量估算

**L（大型）**

理由：
1. 需实现多维度检测策略（进程、端口、文件、API 痕迹）
2. 涉及客户端 Native 代码调用（需要 WebView Bridge）
3. 服务端协同验证 + 规则热更新系统
4. 需对抗注入工具的反检测手段（持续迭代）
5. 预计开发时间：5-7 天

**分解**：
- InjectionDetector 客户端核心：2 天
- 服务端接口 + 数据库迁移：1 天
- 检测规则热更新系统：1 天
- 测试与调优（对抗反检测）：1-2 天
- 文档与验收：0.5 天

## 7. 优先级理由

定为 **P1**（高优先级）的原因：

1. **安全严重性**：注入工具可直接修改核心游戏逻辑，破坏公平性
2. **已有漏洞**：当前反作弊体系缺少对注入工具本身的检测，攻击者可绕过现有防护
3. **用户影响**：使用 Frida 的作弊者捕捉概率可达 100%，严重损害游戏生态
4. **连锁效应**：注入检测是其他反作弊措施的基础防线
5. **依赖关系**：REQ-00494（行为风控系统）已就绪，可协同联动处理检测结果

建议优先实现，补全反作弊体系的关键缺口。