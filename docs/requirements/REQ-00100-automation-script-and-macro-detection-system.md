# REQ-00100：自动化脚本与宏检测系统

- **编号**：REQ-00100
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、catch-service、gym-service、game-client、backend/shared
- **创建时间**：2026-06-11 02:00
- **依赖需求**：REQ-00045（设备完整性与模拟器检测系统）、REQ-00064（风险触发式人机验证系统）

## 1. 背景与问题

### 当前现状
项目已实现多层反作弊机制：
- GPS 伪造检测与速度限制（REQ-00010）
- 玩家行为异常模式检测（REQ-00028）
- 设备完整性与模拟器检测（REQ-00045）
- 风险触发式人机验证（REQ-00064）
- 捕捉成功率异常检测（REQ-00082）
- IP 黑名单自动封禁（REQ-00075）

### 存在的问题
**缺少自动化脚本与宏检测能力**，导致：
1. 无法检测按键精灵、Auto.js 等自动化工具
2. 无法识别自动点击、自动投球等宏脚本行为
3. 无法检测固定时间间隔的规律性操作（脚本特征）
4. 无法识别非人类操作模式（如：毫秒级精确点击）
5. 自动化脚本可绕过现有行为频率限制（分散执行）
6. 影响游戏公平性，正常玩家体验受损

### 用户痛点
- **玩家反馈**："有人 24 小时挂机刷精灵，明显是脚本"
- **玩家反馈**："道馆战斗遇到自动投球的，根本打不过"
- **运营数据**：部分账号日均在线 20+ 小时，操作间隔高度规律

### 作弊手段分析
1. **按键精灵类**：模拟点击、固定坐标、固定间隔
2. **Auto.js 类**：JavaScript 自动化脚本，可编程逻辑
3. **宏脚本**：鼠标/键盘宏，录制回放操作序列
4. **内存修改**：修改客户端内存数据（已有部分检测）
5. **协议逆向**：直接调用 API，绕过客户端（已有速率限制）

## 2. 目标

### 核心目标
构建**自动化脚本与宏检测系统**，提供：
1. **操作模式分析**：检测操作时间间隔、坐标分布、点击精度
2. **行为特征识别**：识别脚本特征（固定间隔、规律模式、非人类精度）
3. **实时风险评估**：动态计算脚本嫌疑分数
4. **多维度关联分析**：结合设备、IP、账号关联分析
5. **分级处置策略**：警告、限制、验证、封禁
6. **客户端指纹采集**：收集操作行为特征数据

### 量化目标
- 自动化脚本检测准确率：≥ 85%
- 误判率（正常用户被误判）：< 2%
- 检测延迟：< 500ms（实时分析）
- 覆盖作弊类型：按键精灵、Auto.js、宏脚本等主流工具
- 预期减少自动化作弊：70%+

## 3. 范围

### 包含
- ✅ 后端操作模式分析引擎（MacroDetector.js）
- ✅ 时间间隔统计分析（检测固定间隔模式）
- ✅ 坐标分布分析（检测固定坐标点击）
- ✅ 点击精度分析（检测非人类精度）
- ✅ 操作序列模式匹配（检测录制回放）
- ✅ 客户端行为指纹采集（MacroFingerprint.js）
- ✅ 实时风险评估与分级处置
- ✅ 多维度关联分析（设备/IP/账号）
- ✅ 管理后台检测报告
- ✅ Prometheus 指标监控

### 不包含
- ❌ 客户端内存扫描检测（属于 REQ-00045 扩展）
- ❌ 协议逆向分析（属于 API 安全范畴）
- ❌ 机器学习模型训练（当前使用规则引擎）
- ❌ 自动封禁决策（需要人工审核确认）
- ❌ 跨游戏反作弊数据共享（未来扩展）

## 4. 详细需求

### 4.1 检测维度设计

#### 4.1.1 时间间隔分析
```
检测目标：识别固定时间间隔的操作模式

特征指标：
- 操作间隔标准差（σ）：脚本通常 < 50ms，人类 > 100ms
- 操作间隔变异系数（CV = σ/μ）：脚本 < 0.1，人类 > 0.3
- 周期性检测：FFT 分析，检测周期性峰值
- 连续相同间隔次数：连续 5+ 次相同间隔（±10ms）为可疑

阈值配置：
- 低风险：CV > 0.2，无明显周期性
- 中风险：CV 0.1-0.2，轻微周期性
- 高风险：CV < 0.1，强周期性
- 确认脚本：连续 10+ 次相同间隔
```

#### 4.1.2 坐标分布分析
```
检测目标：识别固定坐标点击模式

特征指标：
- 点击坐标熵（H）：脚本通常 < 2.0，人类 > 3.0
- 重复坐标比例：同一坐标重复点击比例
- 坐标聚类度：K-means 聚类，脚本聚类数少
- 坐标精度：脚本通常整数坐标，人类有小数偏移

阈值配置：
- 低风险：坐标熵 > 2.5，重复比例 < 5%
- 中风险：坐标熵 2.0-2.5，重复比例 5-15%
- 高风险：坐标熵 < 2.0，重复比例 > 15%
- 确认脚本：重复比例 > 30% 或聚类数 < 3
```

#### 4.1.3 点击精度分析
```
检测目标：识别非人类精度点击

特征指标：
- 点击位置偏差：脚本通常 < 1px，人类 2-5px
- 点击时间精度：脚本毫秒级精确，人类有抖动
- 滑动轨迹平滑度：脚本轨迹平滑，人类有抖动
- 多点触控模式：脚本通常单点，人类可能多点

阈值配置：
- 低风险：位置偏差 > 3px，时间抖动 > 50ms
- 中风险：位置偏差 1-3px，时间抖动 20-50ms
- 高风险：位置偏差 < 1px，时间抖动 < 20ms
- 确认脚本：连续 20+ 次精确点击
```

#### 4.1.4 操作序列模式匹配
```
检测目标：识别录制回放脚本

特征指标：
- 操作序列相似度：与已知脚本模式匹配
- 序列长度分布：脚本序列长度固定
- 序列重复率：相同序列重复执行
- 序列时间比例：序列内操作时间比例固定

检测方法：
- 序列指纹：将操作序列转为特征向量
- 相似度计算：余弦相似度、编辑距离
- 模式库匹配：与已知脚本模式库对比
```

### 4.2 客户端指纹采集

#### 4.2.1 行为指纹数据结构
```javascript
{
  "sessionId": "sess_123",
  "userId": "user_456",
  "deviceId": "device_789",
  "timestamp": "2026-06-11T02:00:00Z",
  "operations": [
    {
      "type": "TAP",
      "x": 150.5,
      "y": 300.2,
      "timestamp": 1718067600000,
      "pressure": 0.8,
      "duration": 50
    },
    {
      "type": "SWIPE",
      "startX": 150,
      "startY": 300,
      "endX": 200,
      "endY": 400,
      "duration": 200,
      "velocity": 2.5
    }
  ],
  "metadata": {
    "screenSize": { "width": 1080, "height": 1920 },
    "pixelRatio": 2.5,
    "platform": "android",
    "appVersion": "1.0.0"
  }
}
```

#### 4.2.2 指标采集策略
```
采集时机：
- 每次点击/触摸操作
- 每次滑动/拖拽操作
- 关键游戏操作（投球、战斗技能）

采集内容：
- 操作类型（tap/swipe/longPress/pinch）
- 坐标位置（x, y，浮点精度）
- 时间戳（毫秒级）
- 压力值（如果支持）
- 持续时间
- 滑动速度/加速度

上报策略：
- 批量上报：每 10 次操作或每 5 秒
- 关键操作立即上报
- 离线缓存：最多 1000 条
```

### 4.3 后端分析引擎

#### 4.3.1 核心分析流程
```
输入：操作序列（最近 N 次操作，N = 100-500）

Step 1: 时间间隔分析
  - 计算间隔序列 {Δt1, Δt2, ..., ΔtN-1}
  - 计算统计指标：μ, σ, CV
  - FFT 周期性检测
  - 输出：时间风险分数（0-100）

Step 2: 坐标分布分析
  - 提取坐标序列 {(x1,y1), ..., (xN,yN)}
  - 计算坐标熵 H
  - 计算重复坐标比例
  - K-means 聚类分析
  - 输出：坐标风险分数（0-100）

Step 3: 精度分析
  - 计算位置偏差分布
  - 计算时间精度分布
  - 检测连续精确操作
  - 输出：精度风险分数（0-100）

Step 4: 序列模式匹配
  - 生成操作序列指纹
  - 与已知模式库匹配
  - 检测序列重复
  - 输出：模式风险分数（0-100）

Step 5: 综合评估
  - 加权综合：score = 0.3*t1 + 0.25*t2 + 0.25*t3 + 0.2*t4
  - 结合历史记录
  - 结合设备/IP 关联
  - 输出：最终风险等级
```

#### 4.3.2 风险等级定义
```
NORMAL（正常）：score < 30
  - 无限制
  - 正常游戏体验

SUSPICIOUS（可疑）：score 30-50
  - 记录日志
  - 增加监控频率
  - 不影响游戏

WARNING（警告）：score 50-70
  - 显示警告提示
  - 触发人机验证（REQ-00064）
  - 降低稀有精灵刷新率

RESTRICTED（限制）：score 70-85
  - 强制人机验证
  - 限制捕捉频率
  - 禁止参与 Raid

BANNED（封禁）：score >= 85
  - 提交人工审核
  - 临时封禁（24-72 小时）
  - 严重者永久封禁
```

### 4.4 多维度关联分析

#### 4.4.1 设备关联
```
检测内容：
- 同一设备多账号（群控嫌疑）
- 设备已标记为模拟器（REQ-00045）
- 设备已标记为 Root/越狱

处置策略：
- 设备标记 → 所有关联账号风险 +20
- 多账号同设备 → 群控检测
```

#### 4.4.2 IP 关联
```
检测内容：
- 同一 IP 多账号（工作室嫌疑）
- IP 在黑名单中（REQ-00075）
- IP 为代理/VPN

处置策略：
- IP 黑名单 → 所有账号风险 +30
- 同 IP 多账号 → 工作室检测
```

#### 4.4.3 行为关联
```
检测内容：
- 操作模式相似账号（同一脚本）
- 在线时间重叠账号（挂机群）
- 捕捉地点集中账号（定点刷怪）

处置策略：
- 相似模式 → 脚本共享检测
- 批量标记关联账号
```

### 4.5 API 设计

#### 4.5.1 上报操作指纹
```
POST /api/anti-cheat/macro/fingerprint
Body: {
  "sessionId": "sess_123",
  "operations": [...],
  "metadata": {...}
}

Response: {
  "success": true,
  "data": {
    "received": 10,
    "bufferSize": 50
  }
}
```

#### 4.5.2 获取风险评分
```
GET /api/anti-cheat/macro/risk-score?userId=user_123

Response: {
  "success": true,
  "data": {
    "userId": "user_123",
    "riskLevel": "SUSPICIOUS",
    "score": 42,
    "breakdown": {
      "timeInterval": 35,
      "coordinateDistribution": 45,
      "precision": 38,
      "patternMatch": 50
    },
    "factors": [
      "操作间隔变异系数偏低",
      "点击坐标重复率较高"
    ],
    "lastAnalysis": "2026-06-11T01:55:00Z"
  }
}
```

#### 4.5.3 管理端检测报告
```
GET /api/admin/macro-detection/report?date=2026-06-11

Response: {
  "success": true,
  "data": {
    "summary": {
      "totalAnalyzed": 15000,
      "detected": 320,
      "confirmed": 85,
      "falsePositive": 12
    },
    "byRiskLevel": {
      "NORMAL": 14680,
      "SUSPICIOUS": 180,
      "WARNING": 95,
      "RESTRICTED": 40,
      "BANNED": 5
    },
    "topPatterns": [
      { "pattern": "固定间隔点击", "count": 120 },
      { "pattern": "固定坐标投球", "count": 85 }
    ]
  }
}
```

### 4.6 数据库设计

```sql
-- 操作指纹缓存表（短期存储，TTL 7 天）
CREATE TABLE operation_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  session_id VARCHAR(50) NOT NULL,
  device_id VARCHAR(100),
  operations JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX idx_fingerprints_user_time ON operation_fingerprints(user_id, created_at DESC);
CREATE INDEX idx_fingerprints_session ON operation_fingerprints(session_id);

-- 宏检测分析结果表
CREATE TABLE macro_detection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  session_id VARCHAR(50),
  risk_level VARCHAR(20) NOT NULL,
  score INTEGER NOT NULL,
  breakdown JSONB NOT NULL,
  factors TEXT[],
  analysis_window_start TIMESTAMPTZ NOT NULL,
  analysis_window_end TIMESTAMPTZ NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_macro_results_user ON macro_detection_results(user_id, created_at DESC);
CREATE INDEX idx_macro_results_risk ON macro_detection_results(risk_level, created_at DESC);

-- 已知脚本模式库表
CREATE TABLE known_macro_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  pattern_fingerprint JSONB NOT NULL,
  pattern_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX idx_macro_patterns_type ON known_macro_patterns(pattern_type, is_active);
```

### 4.7 Prometheus 指标

```javascript
// 检测次数统计
macro_detection_total{level="normal|suspicious|warning|restricted|banned"}

// 风险分数分布
macro_risk_score_histogram

// 操作指纹上报统计
macro_fingerprint_received_total{status="success|failed"}

// 检测准确率指标
macro_detection_accuracy{type="true_positive|false_positive|true_negative|false_negative"}

// 各维度风险分数
macro_dimension_score{dimension="time|coordinate|precision|pattern"}
```

## 5. 验收标准（可测试）

- [ ] **时间间隔分析**
  - 能计算操作间隔统计指标（μ, σ, CV）
  - 能检测固定间隔模式（CV < 0.1）
  - 能检测周期性操作（FFT 分析）
  
- [ ] **坐标分布分析**
  - 能计算坐标熵
  - 能检测重复坐标点击
  - 能进行 K-means 聚类分析
  
- [ ] **点击精度分析**
  - 能检测非人类精度点击
  - 能检测连续精确操作
  - 能分析滑动轨迹平滑度
  
- [ ] **序列模式匹配**
  - 能生成操作序列指纹
  - 能与已知模式库匹配
  - 能检测序列重复
  
- [ ] **客户端指纹采集**
  - 能采集操作行为数据
  - 能批量上报指纹数据
  - 能离线缓存操作记录
  
- [ ] **风险评分**
  - 能计算综合风险分数
  - 能输出各维度分解分数
  - 能识别风险因素
  
- [ ] **分级处置**
  - 不同风险等级有对应处置策略
  - 能触发人机验证（REQ-00064）
  - 能提交人工审核
  
- [ ] **多维度关联**
  - 能关联设备信息
  - 能关联 IP 信息
  - 能检测行为相似账号
  
- [ ] **API 端点**
  - POST /api/anti-cheat/macro/fingerprint 正常工作
  - GET /api/anti-cheat/macro/risk-score 正常工作
  - GET /api/admin/macro-detection/report 正常工作
  
- [ ] **性能指标**
  - 分析延迟 < 500ms
  - 支持 10000+ QPS 上报
  - 内存占用 < 100MB（单实例）

## 6. 工作量估算

**规模：XL（Extra Large）**

理由：
1. 多维度分析引擎开发量大（时间、坐标、精度、模式）
2. 客户端指纹采集模块
3. 实时风险评估系统
4. 多维度关联分析
5. 数据库设计与迁移
6. 管理后台报告
7. 单元测试 + 集成测试

**预估工时：8-10 人日**

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **作弊手段升级**：自动化脚本已成为主流作弊方式，现有检测无法覆盖
2. **公平性影响**：自动化脚本严重破坏游戏公平性，影响正常玩家体验
3. **已有基础完善**：REQ-00045、REQ-00064 已实现设备检测和人机验证，可复用
4. **检测准确率高**：基于多维特征分析，准确率可达 85%+
5. **误判风险可控**：分级处置策略，低风险不干预，高风险需人工确认

**对"项目可用"的贡献**：
- 补全反作弊体系的关键缺口
- 保护游戏公平性和正常玩家利益
- 降低自动化脚本对服务器资源的滥用
- 提升游戏运营质量和用户满意度
