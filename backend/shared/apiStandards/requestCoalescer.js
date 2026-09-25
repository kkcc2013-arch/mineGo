/**
 * REQ-00350：请求合并器（DataLoader 风格）
 *
 * 同一作用域（如同一用户）在 windowMs（默认 50ms）窗口内的多个独立 load(id) 调用被合并成一次 batchFn(scope, ids)；
 * 窗口内重复 id 只查一次；达到 maxBatch 立即发出。batchFn 返回 Map(id → value)，缺失的 id 解析为 null。
 */
'use strict';

class RequestCoalescer {
  /**
   * @param {object} opts { batchFn(scope, ids) → Promise<Map>, windowMs=50, maxBatch=100, onFlush({scope,size,requests}) }
   */
  constructor({ batchFn, windowMs = 50, maxBatch = 100, onFlush = null } = {}) {
    if (typeof batchFn !== 'function') throw new Error('batchFn is required');
    this.batchFn = batchFn;
    this.windowMs = windowMs;
    this.maxBatch = maxBatch;
    this.onFlush = onFlush;
    this.pending = new Map(); // scope → { ids: Map(id → [{resolve,reject}]), timer, requests }
    this.stats = { requests: 0, batches: 0, merged: 0 };
  }

  load(scope, id) {
    this.stats.requests++;
    return new Promise((resolve, reject) => {
      let b = this.pending.get(scope);
      if (!b) {
        b = { ids: new Map(), requests: 0, timer: null };
        this.pending.set(scope, b);
        // 不 unref：窗口很短，且有调用方在等待结果
        b.timer = setTimeout(() => this._flush(scope, b), this.windowMs);
      }
      b.requests++;
      const waiters = b.ids.get(id) || [];
      waiters.push({ resolve, reject });
      b.ids.set(id, waiters);
      if (b.ids.size >= this.maxBatch) {
        clearTimeout(b.timer);
        this._flush(scope, b);
      }
    });
  }

  async _flush(scope, b) {
    if (this.pending.get(scope) === b) this.pending.delete(scope);
    const ids = [...b.ids.keys()];
    this.stats.batches++;
    this.stats.merged += b.requests - 1;
    if (typeof this.onFlush === 'function') { try { this.onFlush({ scope, size: ids.length, requests: b.requests }); } catch { /* ignore */ } }
    try {
      const map = await this.batchFn(scope, ids);
      for (const [id, waiters] of b.ids) {
        const v = map && typeof map.get === 'function' ? map.get(id) : undefined;
        for (const w of waiters) w.resolve(v === undefined ? null : v);
      }
    } catch (err) {
      for (const waiters of b.ids.values()) for (const w of waiters) w.reject(err);
    }
  }
}

module.exports = { RequestCoalescer };
