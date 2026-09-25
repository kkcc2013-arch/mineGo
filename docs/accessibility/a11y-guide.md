# 游戏客户端无障碍指南（Epic E21）

本文档面向三类读者：**玩家**（使用手册）、**开发者**（接入指南）、**验证人员**（验证步骤）。末尾附无障碍声明。
覆盖需求：REQ-00108、00162、00180、00198、00233、00244、00263、00281、00286、00316、00337、00352、00360、00382、00413、00414、00426、00435、00474、00503、00536、00566、00611。

## 一、玩家使用手册

### 打开设置
- 「我的 → 无障碍设置」，或在任意页面按 `,`（逗号）。按 `?` 查看全部快捷键，`Esc` 关闭弹窗。
- 修改立即生效并自动保存在本机；登录后同步到云端，换设备登录自动恢复。**动作辅助设置默认只保存在本机**（可手动开启"同步到云端"）。
- 不确定选什么：「认知与阅读 → 运行设置向导」，回答 6 个问题后一键应用推荐设置。

### 各分组说明
| 分组 | 主要功能 |
|---|---|
| 视觉 | 高对比度（纯黑底白/黄字）、对比度 4 级、色觉模式（红/绿/蓝黄色盲、全色盲、自定义调色板）、色彩校准滤镜（强度可调）、形状/图案标识、界面缩放、开发者色盲模拟 |
| 光敏安全与动画 | 光敏安全模式（闪烁 ≤ 3 次/秒，提示改静态高亮）、最大闪烁频率、减少动画、敏感度测试（可随时停止）、**紧急停止动画（双击 Esc 或状态栏"⏹ 停止动画"）** |
| 屏幕阅读器与语音导航 | 语音播报（语速/音调/音量）、播报级别（全部/重要/关键）、播报类别、空间音频（方位声像 + 距离音调）、自动播报附近摘要、朗读焦点 |
| 听觉 | 音效可视化（图标 + 文字 + 边框提示，位置/时长/强度/类别可配）、实时字幕（语音播报与音效描述，字号/颜色/位置可配） |
| 触觉 | 震动开关、强度 0–200%、按场景开关（捕捉/战斗/界面/导航/特殊）、无障碍增强、即时预览 |
| 游戏节奏 | 预设（无障碍 0.5x / 轻松 0.75x / 标准 / 老玩家 1.25x）、捕捉/战斗/界面独立倍率（0.25x–2x）；非 1.0x 时右下角显示倍率徽章；PVP/竞技场景自动恢复 1.0x |
| 动作辅助 | 预设（轻/中/重度、单手、震颤、反应较慢、活动范围受限）、自动瞄准（0.3/0.6/0.85）、捕捉窗口 ×1.5/×2/×3、一键投掷、轨迹预览、最佳时机提示音、震颤过滤、100px 目标吸附、双击确认/长按激活（100–3000ms）、单手布局、放大点击区、连续投球提醒、宏（Alt+1…9）、实时测试区 |
| 认知与阅读 | 设置向导、简化模式、步骤提示条、专注模式、自动切换预告、OpenDyslexic 字体与行距/字距、朗读、休息提醒、位置记忆 |
| 键盘/手柄/语音 | 快捷键重映射、手柄（显示型号、按键映射、振动）、语音控制（识别语言、置信度过滤、执行反馈、自定义命令）、文字方向（跟随语言/强制 LTR/RTL） |

### 常用快捷键（可在设置中修改）
`?` 帮助 · `,` 设置 · `M` 地图 · `P` 我的 · `R` 刷新 · `J/K` 下/上一个精灵 · `W A S D` 平移地图 · `L` 播报附近 · `V` 语音描述精灵 ·
`1 2 3` 选择精灵球 · `T` 投球 · `Esc` 逃跑/关闭弹窗 · `Esc Esc` 紧急停止动画 · `I` 播报状态 · `Alt+S` 语音播报开关 · `Alt+H` 高对比度 ·
`-`/`=` 降低/提高游戏速度 · `Ctrl+Shift+M` 动作辅助开关 · `Alt+V` 语音控制开关 · `Alt+R` 朗读当前页 · `Alt+1…9` 执行宏

### 手柄（标准布局）
D-Pad 按 Tab 顺序移动焦点 · A（PS ✕ / Switch 位置下键）确认 · B 返回/关闭 · X 投球 · Y 语音描述 · LB/RB 切换精灵球 · 左摇杆滚动地图 · Start 设置 · Select 帮助。

### 语音控制示例
中文："打开地图"、"打开背包"、"捕捉最近的"、"投球"、"超级球"、"描述"、"附近有什么"、"慢一点"、"停止动画"；
English: "open map", "throw the ball", "great ball", "what is nearby"；日本語: "マップ", "投げる", "スーパーボール"。

## 二、开发者接入指南

### 装配
`index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility({ api, store, toast, catchEng, locMgr })`。
模块位于 `src/accessibility/`：`prefs`（偏好/同步）、`liveAnnouncer`（aria-live + TTS + 提示音）、`semantics`（运行期语义化）、`shortcuts`、`gamepad`、
`voiceControl`、`pace`、`photosensitive`、`colorVision`、`textDirection`、`motorAssist`、`cognitive`、`soundCues`、`subtitles`、`settingsPanel`、`dialog`、`strings`、`mapSpeech`；样式 `a11y.css`。

### 运行期 API：`window.PMG_A11Y`
| 成员 | 说明 |
|---|---|
| `store.get(path)` / `store.set(path, value)` | 读写偏好（自动持久化与云端同步），`change` 事件 |
| `announcer.announce(msg, { level, category })` | `level`: info/important/critical；`category`: map/spawn/catch/battle/system/navigation |
| `emit(type, { text, speakText })` | 统一事件出口（视觉提示 + 字幕 + 提示音 + 震动 + 播报），`type` 见 `soundCues.CUE_DEFS` |
| `pace.catchScale()/battleScale()/uiScale()`、`holdScale()`、`battleTiming(ms)` | 节奏倍率；新动画/倒计时请用 `battleTiming(ms)` 或乘 `holdScale()` |
| `setCompetitive('pvp'|'raid'|'leaderboard'|null)` | 进入竞技场景时禁用节奏与动作辅助 |
| `runAction(id)` / `runMacro(n)` | 触发快捷键/手柄/语音共用的动作 |
| `describe()` | 语音描述当前精灵 |

### 战斗界面接入契约（当前客户端未加载战斗界面）
```js
document.dispatchEvent(new CustomEvent('pmg:battle', { detail: { type: 'start', mode: 'pvp', opponent: '…' } }));
// type: start | attack | hit | crit | dodge | status | faint | win | lose
// hit: { target, damage, hp }；status: { target, status }
const dodgeWindowMs = window.PMG_A11Y?.battleTiming(600) ?? 600;   // 慢速模式下自动延长
```
无障碍模块负责：播报（category=battle）、视觉提示与字幕（REQ-00382 战斗覆盖层文字）、触觉（battle_* 模式）、光敏限速（FlashGuard 全局生效），`mode` 为 pvp/raid/leaderboard 时自动禁用辅助。

### 编写新界面时
- 用原生 `<button>`/`<input>`；自绘控件加 `role` + `tabindex="0"`（`semantics.js` 会给带 `onclick` 的 div 自动补齐并支持 Enter/Space）。
- 颜色用 `:root` 变量（`--bg --surface --text --muted --red --green --blue --yellow --purple --primary-bg`），色觉/高对比模式会覆盖它们；状态不要只用颜色表达。
- 弹窗用 `dialog.js` 的 `openDialog()`（焦点陷阱、Esc、焦点恢复、背景 inert）。
- 动画避免 > 3Hz 的明暗闪烁（FlashGuard 会自动降速）；装饰性动画在 `html.a11y-reduce-motion` 下会被停用。
- 方向性图标加 `a11y-dir-icon` 类（RTL 下镜像）；用户名等动态文本加 `dir="auto"`。
- 新增快捷键：在 `bootstrap/a11y.js` 的 `actions` 注册，并在 `shortcuts.DEFAULT_BINDINGS` 绑定；语音同义词加到 `voiceControl.COMMANDS`。

### 后端接口
- `GET/PUT/DELETE /v1/users/me/preferences/:namespace`（user-service，表 `user_preferences`，迁移 `20260925_010000__user_preferences.sql`）。`a11y` 命名空间校验节奏倍率白名单（0.25–2）、触觉强度 0–200、按键时长 0 或 100–3000，慢速模式写审计日志。
- `GET /v1/pokemon/species/:id/voice-description?lang=&cp=`、`GET /v1/pokemon/voice-descriptions?ids=1,4,7`、`GET /v1/pokemon/my/:id/voice-description`（pokemon-service）。

## 三、验证步骤（需启动服务，由验证人员执行）
```bash
# 纯逻辑单测（宿主机即可）
node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs
cd backend && node --test tests/unit/a11y-backend.test.js
# 服务级（CI 栈 + 迁移后）
BASE_URL=<网关> node scripts/smoke-a11y.js
# 浏览器（需客户端开发服务器 scripts/serve-client.js 与 playwright-core + axe-core + Chrome）
BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<含 playwright-core/axe-core 的 node_modules> node scripts/e2e-a11y.js
APP_URL=<客户端> NODE_PATH=… node scripts/bench-a11y-client.js
```
真机项（振动、手柄、Web Speech 识别与合成、VoiceOver/TalkBack/NVDA/JAWS）需在真实设备上人工验证。

## 四、无障碍声明
Pocket Monster Go 游戏客户端以 WCAG 2.1 AA 为目标，并在光敏安全（2.3.1，闪烁 ≤ 3 次/秒）、动作辅助与认知辅助方面参考 AAA 与 Game Accessibility Guidelines。
已知限制：界面文字尚未翻译为阿拉伯语/希伯来语（RTL 布局已支持）；战斗、社交界面尚未在网页客户端提供；语音消息转文字未提供；
屏幕阅读器与硬件能力的真机兼容性待人工验证。问题反馈请通过游戏内客服或项目 issue 提交，我们会在 10 个工作日内回复。
