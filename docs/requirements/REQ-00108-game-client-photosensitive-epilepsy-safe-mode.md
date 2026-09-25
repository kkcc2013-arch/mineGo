# REQ-00108：游戏客户端光敏性癫痫安全模式

- **编号**：REQ-00108
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：implemented
- **涉及服务/模块**：game-client、frontend/effects、frontend/game-client/src/accessibility、catch-service、gym-service
- **创建时间**：2026-06-11 07:05
- **依赖需求**：REQ-00017（无障碍访问支持）、REQ-00081（捕捉动画特效系统）

## 1. 背景与问题

光敏性癫痫（Photosensitive Epilepsy）影响全球约 3% 人口，其中儿童和青少年发病率更高。mineGo 作为一款 AR 精灵捕捉游戏，包含大量视觉动画效果：

1. **捕捉动画**：精灵球旋转、闪光、粒子爆发效果
2. **战斗特效**：技能释放闪光、属性克制高亮、暴击特效
3. **3D 模型展示**：精灵详情页 360° 旋转、闪光精灵粒子效果
4. **地图动画**：精灵刷新点脉动、道馆战斗波纹、天气效果

当前代码现状分析：
- `frontend/game-client/src/accessibility/animation.js` 仅支持简单的动画开关
- 捕捉动画（REQ-00081）和战斗特效（REQ-00054）包含高频闪烁元素
- 缺少符合 WCAG 2.3.1（Three Flashes）和 WCAG 2.3.2（Three Flashes and Threshold）标准的检测机制
- 用户无法预先测试自己对闪烁内容的敏感度

**问题**：高风险用户可能在游戏过程中遭遇视觉刺激诱发不适或癫痫发作，存在安全隐患和合规风险。

## 2. 目标

1. **安全合规**：符合 WCAG 2.1 Level AAA 标准（G19: Flashing content does not exceed 3 flashes per second）
2. **用户保护**：为光敏性癫痫用户提供安全的游戏体验
3. **预防机制**：在用户首次进入高风险场景前提供敏感度测试
4. **自动降级**：检测到高频闪烁时自动降级动画效果

## 3. 范围

- **包含**：
  - 闪烁频率检测与限制系统
  - 癫痫安全模式设置 UI
  - 敏感度预测试功能
  - 高风险动画自动降级（捕捉、战斗、3D展示）
  - 紧急停止按钮（一键关闭所有动画）
  - WCAG 合规验证

- **不包含**：
  - 医疗诊断功能
  - 第三方视频内容的闪烁检测
  - 用户健康数据存储

## 4. 详细需求

### 4.1 核心检测引擎

```javascript
// frontend/game-client/src/accessibility/EpilepsySafetyEngine.js

class EpilepsySafetyEngine {
  // WCAG 2.3.1 标准：每秒不超过 3 次闪烁
  static MAX_FLASHES_PER_SECOND = 3;
  
  // WCAG 2.3.2 标准：闪烁区域不超过 0.006 steradians（约 21px × 21px @ 1024×768）
  static MAX_FLASH_AREA_STERADIANS = 0.006;
  
  // 检测方法
  analyzeFlashPattern(frameSequence, duration) // 分析帧序列闪烁模式
  measureFlashArea(frame) // 测量闪烁区域面积
  calculateLuminanceChange(pixel1, pixel2) // 计算亮度变化（相对亮度）
  isSafeFlashPattern(pattern) // 判断是否符合 WCAG 标准
  
  // 降级方法
  reduceFlashIntensity(effect, factor) // 降低闪烁强度
  smoothTransition(effect, duration) // 将突变转为渐变
  removeFlashingElements(effect) // 移除闪烁元素
}
```

### 4.2 安全模式设置

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| epilepsySafeMode | boolean | false | 是否启用癫痫安全模式 |
| flashIntensity | number | 100 | 闪烁强度百分比（0-100） |
| transitionDuration | number | 0 | 过渡动画时长（ms），0=无过渡 |
| maxBrightnessChange | number | 20 | 最大亮度变化百分比 |
| emergencyStopEnabled | boolean | true | 是否启用紧急停止按钮 |

### 4.3 敏感度预测试

设计一个 10 秒的敏感度测试流程：

1. **阶段 1**（0-3s）：低频闪烁（1 Hz），亮度变化 10%
2. **阶段 2**（3-6s）：中频闪烁（2 Hz），亮度变化 20%
3. **阶段 3**（6-9s）：高频闪烁（3 Hz），亮度变化 30%
4. **阶段 4**（9-10s）：渐变过渡演示

用户可随时点击"停止"按钮，系统记录其敏感阈值并自动配置安全模式。

### 4.4 高风险场景降级策略

| 场景 | 原始效果 | 安全模式效果 |
|------|----------|--------------|
| 捕捉动画 | 精灵球旋转+闪光+粒子爆发 | 简单旋转+淡入淡出 |
| 战斗技能释放 | 屏幕闪烁+粒子特效 | 静态高亮+进度条 |
| 闪光精灵展示 | 星光粒子+彩虹闪光 | 静态金色边框 |
| 暴击特效 | 全屏闪光+震动 | 文字提示+轻微缩放 |
| 天气效果 | 闪电+雷鸣 | 静态云层图标 |

### 4.5 紧急停止按钮

- 位置：屏幕右上角，始终可见（安全模式下）
- 样式：红色圆形按钮，带 "⏹" 图标
- 快捷键：`Esc` 键双击
- 功能：立即停止所有动画，显示静态内容

### 4.6 API 端点

```
POST /api/user/accessibility/epilepsy-safe
  - 设置癫痫安全模式偏好
  - 存储：user_preferences.epilepsy_safe_mode

GET /api/user/accessibility/epilepsy-safe/test
  - 获取敏感度测试配置
  - 返回：测试阶段参数、安全阈值

POST /api/user/accessibility/epilepsy-safe/test-result
  - 提交敏感度测试结果
  - 自动配置用户安全阈值
```

### 4.7 数据库迁移

```sql
-- 用户癫痫安全偏好表
CREATE TABLE user_epilepsy_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  safe_mode_enabled BOOLEAN DEFAULT false,
  flash_intensity_percent INTEGER DEFAULT 100 CHECK (flash_intensity_percent BETWEEN 0 AND 100),
  transition_duration_ms INTEGER DEFAULT 0,
  max_brightness_change_percent INTEGER DEFAULT 20,
  emergency_stop_enabled BOOLEAN DEFAULT true,
  sensitivity_threshold INTEGER, -- 来自测试结果，NULL 表示未测试
  test_completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 动画效果审计表（记录哪些效果被标记为高风险）
CREATE TABLE animation_effect_audit (
  id SERIAL PRIMARY KEY,
  effect_name VARCHAR(100) NOT NULL,
  effect_location VARCHAR(200) NOT NULL, -- 如 'catch-service/pokeball-spin'
  max_flash_frequency_hz DECIMAL(4,2),
  max_luminance_change_percent DECIMAL(5,2),
  flash_area_pixels INTEGER,
  wcag_compliant BOOLEAN,
  mitigation_strategy TEXT,
  audited_at TIMESTAMP DEFAULT NOW()
);
```

## 5. 验收标准（可测试）

- [ ] 闪烁频率检测器能正确识别超过 3 Hz 的闪烁模式
- [ ] 启用安全模式后，所有动画效果符合 WCAG 2.3.1 标准
- [ ] 敏感度测试流程完整运行，用户可随时停止
- [ ] 测试结果能正确映射到安全模式配置参数
- [ ] 捕捉动画在安全模式下无高频闪烁，仍保持视觉反馈
- [ ] 战斗技能特效在安全模式下降级为静态高亮
- [ ] 紧急停止按钮能立即停止所有动画
- [ ] 双击 Esc 键触发紧急停止
- [ ] 用户偏好持久化存储，刷新页面后保持设置
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 通过 WCAG 2.1 Level AAA 自动化检测工具验证

## 6. 工作量估算

**M（Medium）**

理由：
- 核心检测引擎逻辑清晰，约 200 行代码
- 降级策略主要是修改现有动画效果，不涉及新架构
- UI 组件相对简单（设置面板 + 测试界面 + 紧急停止按钮）
- 数据库迁移简单，仅 2 个表
- 主要工作量在测试和 WCAG 合规验证

## 7. 优先级理由

**P2** 理由：
1. **安全重要性**：涉及用户健康安全，但发病率较低（3%），非核心用户群体
2. **合规要求**：WCAG Level AAA 属于最高级别，但非法律强制要求（多数法规要求 Level AA）
3. **已有基础**：REQ-00017 已实现基础无障碍框架，可在其上扩展
4. **依赖关系**：依赖 REQ-00081（捕捉动画）完成后才能完整降级
5. **不影响核心功能**：用户可正常游戏，此为增强性安全功能

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 闪烁频率检测器能正确识别超过 3 Hz 的闪烁模式 | ✅ | `accessibility/photosensitive.js` detectFlashes/maxFlashesPerSecond：1 秒滑动窗口内一对相反方向、幅度 ≥10% 的亮度变化计 1 次（WCAG 2.3.1）；单测 2Hz 安全 / 5Hz 危险 |
| 启用安全模式后，所有动画效果符合 WCAG 2.3.1 标准 | ✅ | FlashGuard 监视全部 CSS/WAAPI 动画（animationstart + 400ms 扫描），闪烁类（opacity/filter/颜色/阴影）且 >上限的循环动画自动降速到 ≤3Hz（减少动画时直接取消）；安全模式下视觉提示边框改静态 |
| 敏感度测试流程完整运行，用户可随时停止 | ✅ | runSensitivityTest：低对比度色块按 1/2/3Hz 渐进（不超过上限），"停止测试"按钮与 Esc 随时停止 |
| 测试结果能正确映射到安全模式配置参数 | ✅ | mapSensitivity → photosensitive.enabled/reduceMotion/maxFlashHz/sensitivity，并关闭视觉提示闪烁 |
| 捕捉动画在安全模式下无高频闪烁，仍保持视觉反馈 | ✅ | 捕捉界面本身无闪烁动画；结果反馈为图标/文字/静态边框/震动；首次进入捕捉场景提示做敏感度测试（可"不再提示"） |
| 战斗技能特效在安全模式下降级为静态高亮 | ⚠️ | 客户端当前没有战斗界面（`components/BattleScene.js` 为未加载的 React 组件）；FlashGuard 对任意动画全局生效，战斗界面按 `pmg:battle` 契约接入后提示为静态高亮 |
| 紧急停止按钮能立即停止所有动画 | ✅ | 状态栏"⏹ 停止动画"按钮：暂停 `document.getAnimations()` 全部动画并加 `a11y-anim-stopped` 样式，再次点击恢复 |
| 双击 Esc 键触发紧急停止 | ✅ | `accessibility/shortcuts.js`：500ms 内连按两次 Esc 触发（任何页面、含弹窗） |
| 用户偏好持久化存储，刷新页面后保持设置 | ✅ | localStorage `pmg_a11y_prefs_v1` + 云端 user_preferences |
| 单元测试覆盖率 ≥ 80% | ⚠️ | 纯逻辑函数均有单测，前端未配置覆盖率工具，未统计 |
| 通过 WCAG 2.1 Level AAA 自动化检测工具验证 | ⚠️ | e2e 中 axe-core 扫描登录/地图/捕捉/设置/高对比度/RTL 页面（调整前运行：无 critical/serious）；AAA 级别没有可完整覆盖的自动化工具，需人工评估 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：在真机上走一遍敏感度测试与紧急停止；确认安全模式下所有动画主观无闪烁感；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
