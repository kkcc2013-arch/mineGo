// frontend/game-client/src/security/locationSignals.js
// REQ-00586：客户端定位完整性信号（Web 端可观测部分），随位置上报给服务端风控综合判断
//
// 浏览器无法直接读取系统"模拟位置"开关（需原生客户端的 isFromMockProvider 等），但可以观察到：
//   - 连续大量定位坐标完全相同且精度恒定（真实 GPS 有米级抖动）→ 模拟定位/开发者工具传感器覆盖的典型特征
//   - 定位时间戳倒退、精度为 0
//   - navigator.webdriver（自动化脚本驱动的浏览器）
// 只上报统计摘要，不上报原始轨迹。

const WINDOW = 20;

export class LocationSignalCollector {
  constructor() {
    this._fixes = [];
  }

  /** 记录一次原始定位（GeolocationPosition 或 {coords, timestamp}） */
  record(pos) {
    if (!pos || !pos.coords) return;
    const { latitude, longitude, accuracy } = pos.coords;
    this._fixes.push({ lat: latitude, lng: longitude, accuracy, ts: Number(pos.timestamp) || Date.now() });
    if (this._fixes.length > WINDOW) this._fixes.shift();
  }

  summary() {
    const f = this._fixes;
    let identical = 0;
    let nonMonotonic = 0;
    for (let i = 1; i < f.length; i++) {
      if (f[i].lat === f[i - 1].lat && f[i].lng === f[i - 1].lng) identical++;
      if (f[i].ts < f[i - 1].ts) nonMonotonic++;
    }
    const accs = f.map((x) => x.accuracy).filter((a) => typeof a === 'number');
    return {
      samples: f.length,
      identicalFixes: identical,
      accuracyConstant: accs.length >= 2 && accs.every((a) => a === accs[0]),
      accuracyZero: accs.some((a) => a === 0),
      nonMonotonicTimestamps: nonMonotonic,
      webdriver: typeof navigator !== 'undefined' && navigator.webdriver === true,
    };
  }
}
