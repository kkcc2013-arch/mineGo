// frontend/game-client/src/bootstrap/features.js
// 客户端功能模块的统一装配点：index.html 只引入本文件，各主题在自己的装配文件里注册。
// 任一模块初始化失败不影响主流程（登录/地图/捕捉）。
import { initAccessibility } from './a11y.js';
import { initExperience } from './experience.js';
import { initProfileNotify } from '../features/profileNotify.js';

const initializers = [
  ['a11y', initAccessibility],
  ['experience', initExperience],
  ['profileNotify', initProfileNotify], // E05 成就/称号/资料卡/收藏室 + E13 消息中心
];

export async function initFeatures(ctx = {}) {
  const results = {};
  for (const [name, init] of initializers) {
    try {
      results[name] = await init(ctx);
    } catch (err) {
      console.warn(`[features] ${name} init failed:`, err);
      results[name] = { error: String(err && err.message || err) };
    }
  }
  window.PMG_FEATURES = results;
  window.dispatchEvent(new CustomEvent('pmg:features-ready', { detail: results }));
  return results;
}
