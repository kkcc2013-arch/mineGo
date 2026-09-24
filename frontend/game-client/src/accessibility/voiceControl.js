// frontend/game-client/src/accessibility/voiceControl.js
// REQ-00536：语音控制与语音导航
//   VoiceCommandRegistry / parseCommand（纯逻辑，中/英/日同义词 + 用户自定义命令）
//   VoiceController：Web Speech API SpeechRecognition 封装（特性检测，连续识别，置信度过滤作为噪音抑制）
//   VoiceFeedback：执行结果经 TTS 播报（LiveAnnouncer.speak）
// ⚠️ 识别准确率/噪音环境指标依赖浏览器与云端识别服务，CI 中以模拟 SpeechRecognition 事件测试。

// 动作 → 各语言同义词（小写匹配，中文按包含匹配）
export const COMMANDS = {
  goMap:        { zh: ['地图', '回到地图', '打开地图', '返回地图'], en: ['map', 'open map', 'go to map', 'show map'], ja: ['マップ', '地図'] },
  goProfile:    { zh: ['我的', '个人', '背包', '打开背包', '个人资料'], en: ['profile', 'bag', 'inventory', 'open bag', 'me'], ja: ['マイページ', 'バッグ', 'プロフィール'] },
  refresh:      { zh: ['刷新', '刷新地图'], en: ['refresh', 'reload'], ja: ['更新', 'リフレッシュ'] },
  catchNearest: { zh: ['捕捉', '抓精灵', '捕捉最近的', '开始捕捉'], en: ['catch', 'catch nearest', 'start catch'], ja: ['捕まえる', 'ゲット'] },
  throw:        { zh: ['投球', '扔球', '投掷', '丢球'], en: ['throw', 'throw ball', 'throw the ball'], ja: ['投げる', 'ボールを投げる'] },
  flee:         { zh: ['逃跑', '离开', '返回'], en: ['run', 'run away', 'flee', 'back', 'go back'], ja: ['逃げる', '戻る'] },
  ballPoke:     { zh: ['普通球', '精灵球'], en: ['poke ball', 'pokeball', 'normal ball'], ja: ['モンスターボール'] },
  ballGreat:    { zh: ['超级球'], en: ['great ball'], ja: ['スーパーボール'] },
  ballUltra:    { zh: ['高级球'], en: ['ultra ball'], ja: ['ハイパーボール'] },
  describe:     { zh: ['描述', '介绍', '这是什么', '精灵信息'], en: ['describe', 'what is this', 'details', 'info'], ja: ['説明', 'くわしく'] },
  readMap:      { zh: ['附近', '周围有什么', '附近有什么', '播报附近'], en: ['nearby', 'what is nearby', 'around me'], ja: ['周り', '近く'] },
  settings:     { zh: ['设置', '无障碍设置', '打开设置'], en: ['settings', 'accessibility settings', 'open settings'], ja: ['設定'] },
  help:         { zh: ['帮助', '快捷键', '有哪些命令'], en: ['help', 'shortcuts', 'commands'], ja: ['ヘルプ'] },
  stopAnimations: { zh: ['停止动画', '紧急停止'], en: ['stop animations', 'emergency stop'], ja: ['アニメーション停止'] },
  slower:       { zh: ['慢一点', '减速'], en: ['slower', 'slow down'], ja: ['ゆっくり'] },
  faster:       { zh: ['快一点', '加速'], en: ['faster', 'speed up'], ja: ['速く'] },
  repeat:       { zh: ['重复', '再说一遍'], en: ['repeat', 'say again'], ja: ['もう一度'] },
  stopListening:{ zh: ['停止聆听', '关闭语音'], en: ['stop listening', 'voice off'], ja: ['音声オフ'] },
};

function langKey(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ja')) return 'ja';
  return 'zh';
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[。，,.!！?？、\s]+/g, ' ').trim();
}

/**
 * 解析识别文本 → { action, phrase, source } | null
 * 自定义命令优先；其次当前语言；再其次其他语言（中英混说）。最长匹配优先。
 */
export function parseCommand(transcript, lang = 'zh-CN', customCommands = []) {
  const text = norm(transcript);
  if (!text) return null;
  for (const c of customCommands || []) {
    const p = norm(c.phrase);
    if (p && (text === p || text.includes(p)) && COMMANDS[c.action]) return { action: c.action, phrase: c.phrase, source: 'custom' };
  }
  const primary = langKey(lang);
  const order = [primary, ...['zh', 'en', 'ja'].filter((k) => k !== primary)];
  for (const k of order) {
    let best = null;
    for (const [action, syn] of Object.entries(COMMANDS)) {
      for (const phrase of syn[k] || []) {
        const p = norm(phrase);
        const hit = k === 'en' ? new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text) : text.includes(p);
        if (hit && (!best || p.length > best.phrase.length)) best = { action, phrase: p, source: k };
      }
    }
    if (best) return best;
  }
  return null;
}

export const ACTION_LABELS = {
  goMap: '打开地图', goProfile: '打开我的', refresh: '刷新地图', catchNearest: '捕捉最近的精灵', throw: '投球', flee: '逃跑/返回',
  ballPoke: '选择普通球', ballGreat: '选择超级球', ballUltra: '选择高级球', describe: '描述精灵', readMap: '播报附近',
  settings: '打开无障碍设置', help: '快捷键帮助', stopAnimations: '紧急停止动画', slower: '降低游戏速度', faster: '提高游戏速度',
  repeat: '重复上一条播报', stopListening: '关闭语音控制',
};

export class VoiceController {
  /**
   * @param {{ getPrefs, run: (action)=>boolean, announcer, lang: ()=>string }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
    const w = typeof window !== 'undefined' ? window : {};
    this.Recognition = w.SpeechRecognition || w.webkitSpeechRecognition || null;
    this.supported = !!this.Recognition;
    this.listening = false;
    this.rec = null;
    this.log = [];
  }

  start() {
    if (!this.supported) return false;
    if (this.listening) return true;
    const vc = this.getPrefs().voiceControl;
    const rec = new this.Recognition();
    rec.lang = vc.lang === 'auto' ? (this.lang() || 'zh-CN') : vc.lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.onresult = (e) => this._onResult(e);
    rec.onerror = (e) => { this.log.push({ ev: 'error', error: e && e.error, t: Date.now() }); };
    rec.onend = () => {
      // 连续模式下浏览器会周期性结束，自动重启
      if (this.listening) { try { rec.start(); } catch { /* ignore */ } }
    };
    this.rec = rec;
    this.listening = true;
    try { rec.start(); } catch { /* 已在运行 */ }
    document.documentElement.classList.add('a11y-voice-listening');
    if (this.announcer) this.announcer.announce('语音控制已开启，请说出指令', { level: 'important' });
    return true;
  }

  stop() {
    this.listening = false;
    document.documentElement.classList.remove('a11y-voice-listening');
    if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } }
    this.rec = null;
  }

  _onResult(e) {
    const t0 = performance.now();
    const vc = this.getPrefs().voiceControl;
    const results = e.results || [];
    for (let i = e.resultIndex || 0; i < results.length; i++) {
      const res = results[i];
      if (res.isFinal === false) continue;
      // 在候选中取第一个能解析为命令且置信度达标的（噪音/误识别过滤）
      let chosen = null;
      for (let j = 0; j < (res.length || 1); j++) {
        const alt = res[j] || res.item?.(j);
        if (!alt) continue;
        const conf = alt.confidence === undefined || alt.confidence === 0 ? 1 : alt.confidence;
        if (conf < vc.minConfidence) continue;
        const cmd = parseCommand(alt.transcript, this.rec ? this.rec.lang : this.lang(), vc.customCommands);
        if (cmd) { chosen = { ...cmd, transcript: alt.transcript, confidence: conf }; break; }
      }
      const transcript = (res[0] && res[0].transcript) || '';
      if (!chosen) {
        this.log.push({ ev: 'unknown', transcript, t: Date.now() });
        if (vc.feedback && this.announcer) this.announcer.announce(`没有听懂：${transcript}`, { level: 'important' });
        continue;
      }
      const ok = this.run(chosen.action);
      const latency = Number((performance.now() - t0).toFixed(2));
      this.log.push({ ev: 'command', ...chosen, ok, latencyMs: latency, t: Date.now() });
      if (this.log.length > 100) this.log.splice(0, 20);
      if (vc.feedback && this.announcer && chosen.action !== 'repeat') {
        this.announcer.announce(`已执行：${ACTION_LABELS[chosen.action] || chosen.action}`, { level: 'important' });
      }
    }
  }
}
