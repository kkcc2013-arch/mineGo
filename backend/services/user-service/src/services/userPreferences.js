// user-service/src/services/userPreferences.js
// 通用用户偏好（user_preferences，按 namespace 存 JSONB）与无障碍偏好（namespace=a11y）的校验。
// REQ-00198 / REQ-00263：节奏倍率只允许白名单取值，服务端拒绝越界值（慢速模式只影响客户端表现，
// 捕捉/战斗判定仍在服务端，慢速不改变服务端概率）；REQ-00281/00316/00382 等：偏好云端同步。
'use strict';

const NAMESPACE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_BYTES = 32 * 1024;

// 客户端允许的节奏倍率（REQ-00263: 0.25–1.0；REQ-00198: 0.5–2.0 的并集）
const PACE_VALUES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

// a11y 允许的顶层分组（与 frontend/game-client/src/accessibility/prefs.js 的 DEFAULT_PREFS 一致）
const A11Y_SECTIONS = [
  'version', 'photosensitive', 'screenReader', 'keyboard', 'pace', 'gamepad', 'direction',
  'color', 'display', 'cognitive', 'haptics', 'motor', 'hearing', 'subtitles', 'voiceControl', 'device',
];

class PreferenceValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'PreferenceValidationError';
    this.field = field;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateNamespace(ns) {
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new PreferenceValidationError('namespace 非法（小写字母开头，2-32 位 a-z0-9_-）', 'namespace');
  }
  return ns;
}

// 递归检查：只允许 JSON 基本类型；字符串 ≤ 256；数组 ≤ 50；深度 ≤ 5
function checkShape(value, path, depth = 0) {
  if (depth > 5) throw new PreferenceValidationError('嵌套过深', path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PreferenceValidationError('数值非法', path);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 256) throw new PreferenceValidationError('字符串过长', path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new PreferenceValidationError('数组过长', path);
    value.forEach((v, i) => checkShape(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 64) throw new PreferenceValidationError('字段过多', path);
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        throw new PreferenceValidationError('非法字段名', `${path}.${k}`);
      }
      checkShape(value[k], `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new PreferenceValidationError('不支持的类型', path);
}

function validateA11y(prefs) {
  const out = {};
  for (const key of Object.keys(prefs)) {
    if (A11Y_SECTIONS.includes(key)) out[key] = prefs[key];
  }
  const flags = { slowMode: false, competitiveSafe: true };
  if (out.pace !== undefined) {
    if (!isPlainObject(out.pace)) throw new PreferenceValidationError('pace 必须是对象', 'pace');
    for (const k of ['catch', 'battle', 'ui']) {
      if (out.pace[k] === undefined) continue;
      const v = Number(out.pace[k]);
      if (!PACE_VALUES.includes(v)) {
        throw new PreferenceValidationError(`pace.${k} 只能取 ${PACE_VALUES.join('/')}`, `pace.${k}`);
      }
      out.pace[k] = v;
      if (v < 1) flags.slowMode = true;
    }
  }
  if (out.haptics && out.haptics.intensity !== undefined) {
    const v = Number(out.haptics.intensity);
    if (!Number.isFinite(v) || v < 0 || v > 200) {
      throw new PreferenceValidationError('haptics.intensity 范围 0-200', 'haptics.intensity');
    }
  }
  if (out.motor && out.motor.holdMs !== undefined) {
    const v = Number(out.motor.holdMs);
    if (!Number.isFinite(v) || (v !== 0 && (v < 100 || v > 3000))) {
      throw new PreferenceValidationError('motor.holdMs 为 0 或 100-3000', 'motor.holdMs');
    }
  }
  if (out.voiceControl && Array.isArray(out.voiceControl.customCommands)
      && out.voiceControl.customCommands.length > 30) {
    throw new PreferenceValidationError('自定义语音命令最多 30 条', 'voiceControl.customCommands');
  }
  return { prefs: out, flags };
}

const VALIDATORS = { a11y: validateA11y };

/**
 * 校验并规范化一个 namespace 的偏好文档
 * @returns {{ prefs: object, flags: object }}
 */
function validatePreferences(namespace, prefs) {
  validateNamespace(namespace);
  if (!isPlainObject(prefs)) throw new PreferenceValidationError('prefs 必须是 JSON 对象', 'prefs');
  const bytes = Buffer.byteLength(JSON.stringify(prefs), 'utf8');
  if (bytes > MAX_BYTES) throw new PreferenceValidationError(`prefs 超过 ${MAX_BYTES} 字节`, 'prefs');
  checkShape(prefs, 'prefs');
  const v = VALIDATORS[namespace];
  return v ? v(prefs) : { prefs, flags: {} };
}

module.exports = {
  validatePreferences,
  validateNamespace,
  PreferenceValidationError,
  PACE_VALUES,
  A11Y_SECTIONS,
  MAX_BYTES,
};
