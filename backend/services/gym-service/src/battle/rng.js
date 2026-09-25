// 可序列化的种子随机数（mulberry32）：战斗状态里只存一个 32 位整数，
// 同一种子 + 同一操作序列可复现整场战斗（回放校验、单元测试确定性）。
'use strict';

function createRng(seed) {
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.state = () => s;
  return rng;
}

function randomSeed() {
  return require('crypto').randomBytes(4).readUInt32LE(0);
}

module.exports = { createRng, randomSeed };
