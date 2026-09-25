# REQ-00536：游戏客户端语音控制与语音导航系统

- **编号**：REQ-00536
- **类别**：无障碍(a11y)
- **优先级**：P1
- **状态**：implemented
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility/VoiceController.js、frontend/game-client/src/accessibility/VoiceCommandProcessor.js、frontend/game-client/src/accessibility/VoiceFeedback.js
- **创建时间**：2026-07-11 08:00
- **依赖需求**：REQ-00503（游戏客户端屏幕阅读器与 ARIA 无障碍支持）

## 1. 背景与问题

当前游戏客户端已实现完善的 ARIA 无障碍支持（REQ-00503）：
- `ariaUtils.js` - ARIA 角色管理、状态更新、语义化辅助
- `announcer.js` - 屏幕阅读器实时通知系统
- `keyboard.js` - 全局键盘导航（快捷键 C/M/P/G/S/H 等）
- `focusManager.js` - 焦点管理器（焦点陷阱、焦点恢复）
- `animation.js` - 动画安全（减少动画偏好支持）
- 色彩盲友模式、高对比度模式、字体大小管理

**现有痛点：**
1. 缺乏语音控制功能，行动不便用户无法通过语音操作游戏
2. 仅支持键盘/触摸操作，对于肢体障碍用户不够友好
3. 无法通过语音执行游戏命令（如"捕捉精灵"、"打开背包"）
4. 缺乏语音反馈与语音播报的双向交互
5. 无法满足 WCAG 2.1 Level AAA 的"语音控制"要求（准则 2.1.6）

## 2. 目标

建立完整的语音控制与语音导航系统，实现：
- 基于 Web Speech API 的语音识别引擎（SpeechRecognition）
- 游戏命令语音处理（捕捉精灵、导航地图、打开背包等）
- 多语言语音识别支持（中文、英文、日语等）
- 语音反馈系统（语音播报游戏状态）
- 噪音抑制与语音增强
- 语音命令训练与自定义命令

## 3. 范围

- **包含**：
  - VoiceController - 语音识别控制器（Web Speech API 封装）
  - VoiceCommandProcessor - 游戏命令处理器
  - VoiceFeedback - 语音反馈系统（Text-to-Speech）
  - VoiceCommandRegistry - 命令注册表
  - VoiceSettingsPanel - 语音设置面板
  - NoiseSuppressor - 噪音抑制模块
  - CustomVoiceCommandTrainer - 自定义命令训练器

- **不包含**：
  - 离线语音识别（需要云端 API）
  - 专业语音助手集成（Siri/Google Assistant）
  - 语音聊天功能（已有实时聊天）

## 4. 详细需求

### 4.1 VoiceController 语音识别控制器

```javascript
class VoiceController {
  // 配置
  config: {
    language: 'zh-CN',  // 默认中文
    continuous: true,   // 连续识别
    interimResults: true,  // 显示中间结果
    maxAlternatives: 3,  // 最大候选数
    noiseThreshold: 0.3  // 噪音阈值
  }
  
  // 状态
  state: {
    isListening: false,
    lastTranscript: '',
    confidence: 0,
    errorCount: 0
  }
  
  // 核心方法
  async startListening()  // 开始语音识别
  async stopListening()   // 停止语音识别
  async pauseListening()  // 暂停识别（保持状态）
  async resumeListening() // 恢复识别
  
  // 语言切换
  setLanguage(locale)     // 设置识别语言
  
  // 事件回调
  onResult(callback)      // 识别结果回调
  onError(callback)       // 错误回调
  onStart(callback)       // 开始回调
  onEnd(callback)         // 结束回调
}
```

### 4.2 VoiceCommandProcessor 游戏命令处理器

```javascript
class VoiceCommandProcessor {
  // 命令映射表
  commandMap: {
    '捕捉精灵': { action: 'catch', shortcut: 'c' },
    '打开地图': { action: 'map', shortcut: 'm' },
    '打开背包': { action: 'inventory', shortcut: 'p' },
    '打开道馆': { action: 'gym', shortcut: 'g' },
    '打开设置': { action: 'settings', shortcut: 's' },
    '放大地图': { action: 'zoomIn', shortcut: '+' },
    '缩小地图': { action: 'zoomOut', shortcut: '-' },
    '重置地图': { action: 'resetMap', shortcut: 'r' },
    '关闭弹窗': { action: 'closeModal', shortcut: 'Escape' },
    '选择精灵': { action: 'selectPokemon', params: ['name'] },
    '攻击': { action: 'attack', context: 'battle' },
    '逃跑': { action: 'escape', context: 'battle' },
    '使用道具': { action: 'useItem', params: ['itemName'] }
  }
  
  // 核心方法
  parseCommand(transcript)           // 解析语音文本为命令
  matchCommand(text)                 // 匹配命令（模糊匹配）
  executeCommand(command)            // 执行命令
  validateContext(command, context)  // 验证命令上下文
  
  // 自定义命令
  registerCustomCommand(text, action)  // 注册自定义命令
  removeCustomCommand(text)             // 移除自定义命令
}
```

### 4.3 VoiceFeedback 语音反馈系统

```javascript
class VoiceFeedback {
  // 配置
  config: {
    enabled: true,
    volume: 0.8,
    rate: 1.0,     // 语速
    pitch: 1.0,    // 音调
    language: 'zh-CN'
  }
  
  // 播报队列
  queue: []
  
  // 核心方法
  speak(text, options = {})         // 语音播报
  speakCommandResult(command, success) // 播报命令执行结果
  speakError(error)                 // 播报错误
  speakGameEvent(event)             // 播报游戏事件
  stop()                            // 停止播报
  pause()                           // 暂停播报
  resume()                          // 恢复播报
  
  // 事件模板
  templates: {
    'catch_success': '捕捉成功！获得了{speciesName}',
    'catch_fail': '{speciesName}逃跑了',
    'command_executed': '已执行：{command}',
    'command_unknown': '未识别的命令：{transcript}',
    'listening_start': '语音控制已启动',
    'listening_stop': '语音控制已停止'
  }
}
```

### 4.4 VoiceCommandRegistry 命令注册表

```javascript
class VoiceCommandRegistry {
  // 多语言命令映射
  commands: {
    'zh-CN': {
      '捕捉精灵': 'catch',
      '打开地图': 'map',
      '打开背包': 'inventory',
      '打开道馆': 'gym',
      '打开设置': 'settings',
      '放大': 'zoomIn',
      '缩小': 'zoomOut',
      '重置': 'resetMap',
      '关闭': 'closeModal',
      '攻击': 'attack',
      '逃跑': 'escape'
    },
    'en-US': {
      'catch pokemon': 'catch',
      'open map': 'map',
      'open inventory': 'inventory',
      'open gym': 'gym',
      'open settings': 'settings',
      'zoom in': 'zoomIn',
      'zoom out': 'zoomOut',
      'reset map': 'resetMap',
      'close': 'closeModal',
      'attack': 'attack',
      'run away': 'escape'
    },
    'ja-JP': {
      'ポケモンを捕まえる': 'catch',
      '地図を開く': 'map',
      'バッグを開く': 'inventory',
      'ジムを開く': 'gym',
      '設定を開く': 'settings',
      '拡大': 'zoomIn',
      '縮小': 'zoomOut',
      'リセット': 'resetMap',
      '閉じる': 'closeModal',
      '攻撃': 'attack',
      '逃げる': 'escape'
    }
  }
  
  // 核心方法
  getCommands(locale)           // 获取指定语言的命令列表
  getAllCommands()              // 获取所有命令
  addCommand(locale, text, action) // 添加命令
  fuzzyMatch(text, commands)    // 模糊匹配命令
}
```

### 4.5 NoiseSuppressor 噪音抑制模块

```javascript
class NoiseSuppressor {
  // 音频分析
  analyzeAudio(audioData)       // 分析音频质量
  getNoiseLevel()               // 获取噪音级别
  isVoiceDetected()             // 检测是否有语音
  
  // 噪音抑制配置
  config: {
    minConfidence: 0.6,         // 最小置信度阈值
    silenceThreshold: -50,      // 静音阈值（dB）
    voiceThreshold: -20         // 语音阈值（dB）
  }
  
  // 核心方法
  filterNoise(transcript, confidence)  // 过滤噪音结果
  shouldAcceptResult(transcript)        // 判断是否接受结果
}
```

### 4.6 VoiceSettingsPanel 语音设置面板

```javascript
class VoiceSettingsPanel {
  // UI 元素
  elements: {
    enableToggle,       // 启用开关
    languageSelect,     // 语言选择
    volumeSlider,       // 音量滑块
    rateSlider,         // 语速滑块
    pitchSlider,        // 音调滑块
    commandList,        // 命令列表
    customCommandInput  // 自定义命令输入
  }
  
  // 核心方法
  render()               // 渲染设置面板
  updateSettings(settings) // 更新设置
  getSettings()          // 获取当前设置
  showCommandHelp()      // 显示命令帮助
}
```

### 4.7 自定义命令训练器

```javascript
class CustomVoiceCommandTrainer {
  // 训练数据
  trainingData: []
  
  // 核心方法
  startTraining(commandAction)    // 开始训练
  recordSample(transcript)         // 记录样本
  finishTraining()                 // 完成训练
  validateCommand(transcript)      // 验证命令
  exportCommands()                 // 导出命令配置
  importCommands(config)           // 导入命令配置
}
```

## 5. 验收标准（可测试）

- [ ] 语音识别准确率 ≥ 85%（标准命令）
- [ ] 响应延迟 < 500ms（从识别到执行）
- [ ] 支持至少 3 种语言（中文、英文、日语）
- [ ] 噪音环境下识别准确率 ≥ 70%（噪音抑制）
- [ ] 支持自定义命令注册（至少 10 条）
- [ ] 语音反馈播报正确执行结果
- [ ] 无障碍设置面板集成语音控制选项
- [ ] 单元测试覆盖：VoiceController、VoiceCommandProcessor、VoiceFeedback 各 10+ 用例
- [ ] 集成测试：语音命令执行完整流程
- [ ] WCAG 2.1 Level AAA 合规验证

## 6. 工作量估算

L（Large）
- 需要封装 Web Speech API 并处理多浏览器兼容性
- 语音命令解析需要复杂的自然语言处理
- 噪音抑制需要音频分析算法
- 多语言支持需要翻译表
- 与现有键盘导航系统集成

## 7. 优先级理由

P1 级别：
- WCAG 2.1 Level AAA 要求"语音控制"（准则 2.1.6）
- 对于肢体障碍用户，语音控制是必不可少的无障碍功能
- 与已实现的键盘导航形成互补，完善无障碍操作体系
- 对项目"生产可用"的无障碍合规性贡献显著

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 语音识别准确率 ≥ 85%（标准命令） | ⚠️ | 依赖浏览器/云端识别引擎，未实测 |
| 响应延迟 < 500ms（从识别到执行） | ✅ | 识别结果 → 解析 → 执行 <1ms（单测记录 latencyMs；调整前 e2e 模拟测得 0.4ms），不含识别引擎本身延迟 |
| 支持至少 3 种语言（中文、英文、日语） | ✅ | 中文 / English / 日本語 同义词表，界面语言之外的语言也可识别 |
| 噪音环境下识别准确率 ≥ 70%（噪音抑制） | ⚠️ | 置信度阈值（可调）+ 多候选择优作为噪音过滤；Web Speech API 不支持音频流降噪，未实测 |
| 支持自定义命令注册（至少 10 条） | ✅ | 自定义命令最多 30 条（设置面板增删），宏名称也可作为命令 |
| 语音反馈播报正确执行结果 | ✅ | "已执行：…"/"没有听懂：…" 语音反馈（可关闭） |
| 无障碍设置面板集成语音控制选项 | ✅ | 设置 → 键盘、手柄与语音控制：开关、识别语言、置信度、反馈、自定义命令 |
| 单元测试覆盖：VoiceController、VoiceCommandProcessor、VoiceFeedback 各 10+ 用例 | ✅ | `tests/a11y/voice.test.mjs`：VoiceCommandProcessor 11、VoiceController 12、VoiceFeedback 12 个用例（宿主机已运行通过） |
| 集成测试：语音命令执行完整流程 | ✅ | `scripts/e2e-a11y.js` 模拟 SpeechRecognition：中/英/日/自定义命令、低置信度过滤、TTS 参数 |
| WCAG 2.1 Level AAA 合规验证 | ⚠️ | AAA 需人工评估 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：真实麦克风 + Chrome 语音识别在安静/嘈杂环境下的命令识别率；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 备注：偏差：VoiceController/CommandProcessor/Feedback 合并在 `accessibility/voiceControl.js` 与 `liveAnnouncer.js`；NoiseSuppressor 以置信度过滤代替；CustomVoiceCommandTrainer 以自定义命令编辑代替。
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
