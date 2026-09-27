/**
 * REQ-00383：通用"预写 + 批量刷写"调度器（无第三方依赖，可单测）
 *
 * 数据源 source 负责持久缓冲（Redis Stream / 数据库 outbox），调度器只决定"何时刷、刷多少、失败怎么办"：
 *   - 触发：定时（intervalMs）或积压达到 maxBatch（生产者调用 notify()）时立即刷；并发刷写合并为一次；
 *   - 刷写：read(maxBatch) → sink.write(批) 成功后 ack；批写失败则逐条写（隔离毒消息），成功的 ack；
 *   - 重试：失败条目不 ack，留在源里下次再读；按失败次数指数退避（backoffMs × 2^n，上限 maxBackoffMs）；
 *   - 死信：同一条目失败达到 maxRetries 次 → deadLetter(entry, err) 后 ack（不再阻塞队列、也不丢：死信落库可人工补偿）；
 *   - 关停：stop({ drain: true }) 停止定时器并循环刷写直到源为空或超时。
 *
 * 语义：至少一次（at-least-once）。重复投递由 sink 去重（如 INSERT ... ON CONFLICT (id) DO NOTHING）。
 *
 * source: { read(max) → Promise<Array<{ id, payload }>>, ack(ids) → Promise, size?() → Promise<number> }
 * sink:   { write(payloads, entries) → Promise<void> }  抛错表示整批失败
 */
'use strict';

class BatchFlusher {
  constructor(opts = {}) {
    if (!opts.source || !opts.sink) throw new Error('BatchFlusher requires source and sink');
    this.name = opts.name || 'batch';
    this.source = opts.source;
    this.sink = opts.sink;
    this.maxBatch = Math.max(1, opts.maxBatch || 50);
    this.intervalMs = Math.max(10, opts.intervalMs || 500);
    this.maxRetries = Math.max(1, opts.maxRetries || 3);
    this.backoffMs = Math.max(0, opts.backoffMs ?? 200);
    this.maxBackoffMs = Math.max(this.backoffMs, opts.maxBackoffMs || 10_000);
    this.deadLetter = opts.deadLetter || null;
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.metrics = opts.metrics || null; // { onFlush({ written, failed, dead, ms, batch }) }
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    this.clearTimer = opts.clearTimer || ((t) => clearTimeout(t));

    this.attempts = new Map();     // entryId → 失败次数
    this.pendingHint = 0;          // 生产者通知的未刷条数（只用于触发，不做计数依据）
    this.running = false;
    this.timer = null;
    this.flushing = null;          // 当前刷写 Promise（合并并发触发）
    this.pausedUntil = 0;          // 退避截止时间
    this.stats = { flushes: 0, written: 0, failed: 0, deadLettered: 0, lastFlushAt: null, lastError: null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule(this.intervalMs);
  }

  _schedule(ms) {
    if (!this.running) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush().catch((err) => this.logger.error({ err: err && err.message, flusher: this.name }, 'batch flush crashed'))
        .finally(() => this._schedule(this._nextDelay()));
    }, ms);
  }

  _nextDelay() {
    const wait = this.pausedUntil - this.now();
    return wait > 0 ? Math.max(wait, this.intervalMs) : this.intervalMs;
  }

  /** 生产者入队后调用；积压达到 maxBatch 时立即刷（退避期间除外） */
  notify(n = 1) {
    this.pendingHint += n;
    if (this.running && this.pendingHint >= this.maxBatch && this.now() >= this.pausedUntil && !this.flushing) {
      this.flush().catch((err) => this.logger.error({ err: err && err.message, flusher: this.name }, 'batch flush crashed'));
    }
  }

  /** 刷一批（并发调用合并为同一次） */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flushOnce() {
    const started = this.now();
    const result = { read: 0, written: 0, failed: 0, deadLettered: 0 };
    const entries = await this.source.read(this.maxBatch);
    result.read = entries.length;
    this.pendingHint = Math.max(0, this.pendingHint - entries.length);
    if (!entries.length) return result;

    let okIds = [];
    let failures = [];
    try {
      await this.sink.write(entries.map((e) => e.payload), entries);
      okIds = entries.map((e) => e.id);
    } catch (batchErr) {
      // 整批失败：逐条写，隔离出真正失败的条目
      this.stats.lastError = batchErr && batchErr.message;
      if (entries.length === 1) {
        failures.push({ entry: entries[0], err: batchErr });
      } else {
        for (const e of entries) {
          try {
            await this.sink.write([e.payload], [e]);
            okIds.push(e.id);
          } catch (err) {
            failures.push({ entry: e, err });
          }
        }
      }
    }

    const toAck = [...okIds];
    for (const id of okIds) this.attempts.delete(id);
    for (const { entry, err } of failures) {
      const n = (this.attempts.get(entry.id) || 0) + 1;
      this.attempts.set(entry.id, n);
      if (n >= this.maxRetries) {
        try {
          if (this.deadLetter) await this.deadLetter(entry, err, n);
          toAck.push(entry.id);
          this.attempts.delete(entry.id);
          result.deadLettered++;
          this.logger.error({ flusher: this.name, id: entry.id, attempts: n, err: err && err.message }, 'batch entry dead-lettered');
        } catch (dlErr) {
          // 死信写入也失败：不 ack，保留在源中，下次再试（宁可重复也不丢）
          this.logger.error({ flusher: this.name, id: entry.id, err: dlErr && dlErr.message }, 'dead-letter write failed, keeping entry');
        }
      } else {
        result.failed++;
      }
    }
    if (toAck.length) await this.source.ack(toAck);
    result.written = okIds.length;

    if (failures.length && result.failed > 0) {
      const worst = Math.max(...failures.map((f) => this.attempts.get(f.entry.id) || 1));
      this.pausedUntil = this.now() + Math.min(this.backoffMs * 2 ** (worst - 1), this.maxBackoffMs);
      this.logger.warn({ flusher: this.name, failed: result.failed, backoffMs: this.pausedUntil - this.now() }, 'batch flush partially failed, backing off');
    } else {
      this.pausedUntil = 0;
    }

    this.stats.flushes++;
    this.stats.written += result.written;
    this.stats.failed += result.failed;
    this.stats.deadLettered += result.deadLettered;
    this.stats.lastFlushAt = new Date(this.now()).toISOString();
    if (this.metrics && this.metrics.onFlush) {
      try { this.metrics.onFlush({ ...result, ms: this.now() - started, batch: entries.length }); } catch { /* ignore */ }
    }
    return result;
  }

  /**
   * 停止；drain=true 时在 timeoutMs 内持续刷写直到源为空（关停时调用，尽量不留积压）
   * @returns {Promise<{ drained: boolean, rounds: number }>}
   */
  async stop({ drain = true, timeoutMs = 5000 } = {}) {
    this.running = false;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.flushing) { try { await this.flushing; } catch { /* ignore */ } }
    if (!drain) return { drained: false, rounds: 0 };
    const deadline = this.now() + timeoutMs;
    let rounds = 0;
    while (this.now() < deadline) {
      this.pausedUntil = 0; // 关停时不退避
      const r = await this.flush();
      rounds++;
      if (r.read === 0) return { drained: true, rounds };
      if (r.written === 0 && r.deadLettered === 0) break; // 全部失败：留在源里，重启后继续
    }
    return { drained: false, rounds };
  }

  getStats() {
    return { ...this.stats, running: this.running, pausedUntil: this.pausedUntil || null, retrying: this.attempts.size };
  }
}

module.exports = { BatchFlusher };
