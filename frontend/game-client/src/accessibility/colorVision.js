// frontend/game-client/src/accessibility/colorVision.js
// REQ-00281 / REQ-00474 / REQ-00566：色觉辅助的纯逻辑部分
//   - 色盲模拟矩阵（Machado 2009，严重度 1.0）与 daltonize 校正矩阵（用于 SVG feColorMatrix）
//   - 各色觉类型的安全调色板（智能颜色替换，Okabe-Ito 色系）
//   - WCAG 对比度计算、调色板合规检查与自动修正
//   - 18 种精灵属性的形状/文字标识
// 无 DOM 依赖，可在 Node 单测中直接 import。

export const CVD_TYPES = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'];

// 3x3 线性 RGB 变换（行主序）
export const SIM_MATRICES = {
  protanopia:   [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia:   [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
  achromatopsia:[0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
};

// daltonize：把模拟丢失的误差重新分配到可感知通道
const ERR_SHIFT = {
  protanopia:   [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deuteranopia: [1, 0.7, 0, 0, 0, 0, 0, 0.7, 1],
  tritanopia:   [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a, b) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/** 校正矩阵 M = I + s·C·(I − S)；s 为强度 0-1（REQ-00566 色彩校准滑块） */
export function correctionMatrix(type, strength = 1) {
  if (type === 'achromatopsia') return SIM_MATRICES.achromatopsia.slice(); // 全色盲：以亮度差为主 + 图案标识
  const S = SIM_MATRICES[type];
  const C = ERR_SHIFT[type];
  if (!S || !C) return I3.slice();
  const IminusS = I3.map((v, i) => v - S[i]);
  const CS = mul3(C, IminusS);
  return I3.map((v, i) => v + strength * CS[i]);
}

/** 3x3 → feColorMatrix 的 4x5 values 字符串 */
export function toFeColorMatrix(m) {
  const r = (x) => Number(x.toFixed(6));
  return [
    r(m[0]), r(m[1]), r(m[2]), 0, 0,
    r(m[3]), r(m[4]), r(m[5]), 0, 0,
    r(m[6]), r(m[7]), r(m[8]), 0, 0,
    0, 0, 0, 1, 0,
  ].join(' ');
}

export function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad color ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(l) {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** WCAG 相对亮度 */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1-21） */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 在线性 RGB 空间应用 3x3 矩阵（用于模拟预览与单测） */
export function applyMatrix(hex, m) {
  const lin = hexToRgb(hex).map(srgbToLinear);
  const out = [0, 1, 2].map((i) => m[i * 3] * lin[0] + m[i * 3 + 1] * lin[1] + m[i * 3 + 2] * lin[2]);
  return rgbToHex(out.map(linearToSrgb));
}

export function simulate(hex, type) {
  const m = SIM_MATRICES[type];
  return m ? applyMatrix(hex, m) : hex;
}

/** 两个颜色在某种色觉下的可区分度（模拟后的 RGB 欧氏距离，0-441） */
export function distinguishability(a, b, type = 'none') {
  const pa = hexToRgb(type === 'none' ? a : simulate(a, type));
  const pb = hexToRgb(type === 'none' ? b : simulate(b, type));
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

// 游戏语义色（与 index.html :root 变量对应）
export const BASE_PALETTE = {
  red: '#e63946', blue: '#3d8ef8', yellow: '#f4c430', green: '#2ecc71', purple: '#9b59b6',
  text: '#e8eaf0', muted: '#8b93a1', bg: '#0d0f14', surface: '#13161e', border: '#252938',
};

// 智能颜色替换：各色觉类型下"成功/错误/警告/信息"用可区分的颜色（Okabe-Ito）
export const CVD_PALETTES = {
  protanopia:    { red: '#d55e00', green: '#56b4e9', blue: '#0072b2', yellow: '#f0e442', purple: '#cc79a7' },
  deuteranopia:  { red: '#d55e00', green: '#56b4e9', blue: '#0072b2', yellow: '#f0e442', purple: '#cc79a7' },
  tritanopia:    { red: '#e63946', green: '#00c9a7', blue: '#ff79c6', yellow: '#ffffff', purple: '#d55e00' },
  achromatopsia: { red: '#ffffff', green: '#bdbdbd', blue: '#9e9e9e', yellow: '#e0e0e0', purple: '#757575' },
};

export function paletteFor(mode, custom = {}) {
  const base = { ...BASE_PALETTE, ...(CVD_PALETTES[mode] || {}) };
  if (mode === 'custom') Object.assign(base, custom);
  return base;
}

// 需要与背景满足对比度的前景色
export const FG_KEYS = ['red', 'blue', 'yellow', 'green', 'purple', 'text', 'muted'];

/** 检查调色板：每个前景色对 bg / surface 的对比度，返回不达标项（默认 AA 4.5） */
export function checkPalette(palette, min = 4.5) {
  const issues = [];
  for (const k of FG_KEYS) {
    if (!palette[k]) continue;
    for (const bgKey of ['bg', 'surface']) {
      const ratio = contrastRatio(palette[k], palette[bgKey] || BASE_PALETTE[bgKey]);
      if (ratio < min) issues.push({ key: k, against: bgKey, ratio: Number(ratio.toFixed(2)) });
    }
  }
  return issues;
}

/** 在保持色相的前提下调亮/调暗直到对比度 ≥ min */
export function ensureContrast(fg, bg, min = 4.5) {
  if (contrastRatio(fg, bg) >= min) return fg;
  const bgLum = relativeLuminance(bg);
  const towardWhite = bgLum < 0.5;
  let rgb = hexToRgb(fg);
  for (let i = 0; i < 40; i++) {
    rgb = rgb.map((c) => (towardWhite ? c + (255 - c) * 0.1 : c * 0.9));
    const hex = rgbToHex(rgb);
    if (contrastRatio(hex, bg) >= min) return hex;
  }
  return towardWhite ? '#ffffff' : '#000000';
}

/** 修正整个调色板中不达标的前景色 */
export function fixPalette(palette, min = 4.5) {
  const out = { ...palette };
  for (const k of FG_KEYS) {
    if (!out[k]) continue;
    out[k] = ensureContrast(ensureContrast(out[k], out.bg || BASE_PALETTE.bg, min), out.surface || BASE_PALETTE.surface, min);
  }
  return out;
}

// REQ-00474：18 种属性的形状标识（与 pokemon-service voiceDescriptionService.TYPE_INFO 一致）
export const TYPE_SHAPES = {
  NORMAL: ['●', '一般', 'Normal'], FIRE: ['▲', '火', 'Fire'], WATER: ['💧', '水', 'Water'], GRASS: ['🍃', '草', 'Grass'],
  ELECTRIC: ['⚡', '电', 'Electric'], ICE: ['◆', '冰', 'Ice'], FIGHTING: ['👊', '格斗', 'Fighting'], POISON: ['☠', '毒', 'Poison'],
  GROUND: ['■', '地面', 'Ground'], FLYING: ['🪶', '飞行', 'Flying'], PSYCHIC: ['👁', '超能力', 'Psychic'], BUG: ['⬡', '虫', 'Bug'],
  ROCK: ['⬠', '岩石', 'Rock'], GHOST: ['🌙', '幽灵', 'Ghost'], DRAGON: ['★', '龙', 'Dragon'], DARK: ['🌑', '恶', 'Dark'],
  STEEL: ['⚙', '钢', 'Steel'], FAIRY: ['♥', '妖精', 'Fairy'],
};

export function typeBadge(type, lang = 'zh-CN') {
  const t = TYPE_SHAPES[String(type || '').toUpperCase()];
  if (!t) return null;
  return { type, shape: t[0], label: lang.startsWith('en') ? t[2] : t[1] };
}

/** 投球准确度圈的分区（颜色之外用文字 + 图案表达，REQ-00474 状态条增强） */
export function accuracyZone(pct) {
  if (pct < 30) return { zone: 'excellent', label: '极佳', pattern: 'dots' };
  if (pct < 65) return { zone: 'great', label: '很好', pattern: 'stripes' };
  return { zone: 'nice', label: '不错', pattern: 'solid' };
}
