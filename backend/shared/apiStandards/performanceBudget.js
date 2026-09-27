/**
 * REQ-00476: API 性能预算与基准
 *
 * - 预算定义：config/performance-budget.yaml（P50/P95/P99/MAX，budgetType strict|moderate|relaxed，priority P0-P3）
 * - 中间件：每个请求结束时记录耗时 → 按路由的滑动样本（环形缓冲）+ Prometheus 直方图；
 *   单次请求超过 MAX 立即计为违规；周期评估窗口内 P50/P95/P99 是否超预算
 * - 违规：Prometheus 计数 + Redis 按小时哈希（跨实例汇总/趋势）；strict 违规立即告警（日志 error + 回调）
 * - 热点分析：按 P95/预算 比值排序；回归检测：与基线相比 P99 增长 > 20%（阈值可配）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'config', 'performance-budget.yaml');

function parseDuration(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!m) return null;
  return m[2] && m[2].toLowerCase() === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

function parsePercent(v) {
  if (typeof v === 'number') return v > 1 ? v / 100 : v;
  const m = String(v || '').match(/^(\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) / 100 : null;
}

function loadYaml(text) {
  let YAML;
  try { YAML = require('yamljs'); } catch { YAML = null; }
  if (YAML) return YAML.parse(text);
  return JSON.parse(text);
}

/** 解析预算配置（YAML/JSON 文本或对象） */
function normalizeConfig(raw) {
  const cfg = typeof raw === 'string' ? loadYaml(raw) : raw;
  const d = cfg.defaults || {};
  const defaults = {
    p50: parseDuration(d.p50) ?? 200, p95: parseDuration(d.p95) ?? 500, p99: parseDuration(d.p99) ?? 1000, max: parseDuration(d.max) ?? 3000,
    budgetType: d.budgetType || 'relaxed', priority: d.priority || 'P2',
  };
  const budgets = [];
  for (const [group, routes] of Object.entries(cfg.budgets || {})) {
    for (const [key, b] of Object.entries(routes || {})) {
      const [method, route] = String(key).trim().split(/\s+/);
      budgets.push({
        key: `${method.toUpperCase()} ${route}`, group, method: method.toUpperCase(), route,
        p50: parseDuration(b.p50) ?? defaults.p50, p95: parseDuration(b.p95) ?? defaults.p95, p99: parseDuration(b.p99) ?? defaults.p99, max: parseDuration(b.max) ?? defaults.max,
        budgetType: b.budgetType || defaults.budgetType, priority: b.priority || defaults.priority,
        re: new RegExp(`^${route.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/:[A-Za-z0-9_]+/g, '/[^/]+').replace(/\*/g, '.*')}/?$`),
      });
    }
  }
  // 更具体（字面量更长）的路由优先
  budgets.sort((a, b) => b.route.replace(/:[a-z_]+/gi, '').length - a.route.replace(/:[a-z_]+/gi, '').length);
  const rt = cfg.regressionThresholds || {};
  return {
    version: cfg.version || 1,
    defaults,
    budgets,
    regressionThresholds: { p99: parsePercent(rt.p99) ?? 0.2, p95: parsePercent(rt.p95) ?? 0.15, p50: parsePercent(rt.p50) ?? 0.1 },
    alertConfig: cfg.alertConfig || {},
    evaluation: { windowSize: (cfg.evaluation && cfg.evaluation.windowSize) || 1000, minSamples: (cfg.evaluation && cfg.evaluation.minSamples) || 20 },
  };
}

function loadConfigFile(file = process.env.PERF_BUDGET_FILE || DEFAULT_CONFIG_FILE) {
  return normalizeConfig(fs.readFileSync(file, 'utf8'));
}

/** 未配置预算的路由：把 id 段归一化，控制指标基数 */
function normalizeRoute(p) {
  return String(p || '/')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:id')
    .slice(0, 120);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return { count: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.length ? s[s.length - 1] : null, avg: s.length ? sum / s.length : null };
}

class Ring {
  constructor(size) { this.size = size; this.buf = []; this.i = 0; }
  push(v) { if (this.buf.length < this.size) this.buf.push(v); else { this.buf[this.i] = v; this.i = (this.i + 1) % this.size; } }
  values() { return this.buf.slice(); }
}

class PerformanceBudgetManager {
  /**
   * @param {object} opts { config, redis, logger, metrics: { histogram, violations, alerts }, onAlert(alert), now }
   */
  constructor({ config, redis = null, logger = null, metrics = null, onAlert = null, now = () => new Date() } = {}) {
    this.config = config || normalizeConfig({ defaults: {}, budgets: {} });
    this.redis = redis;
    this.logger = logger;
    this.metrics = metrics;
    this.onAlert = onAlert;
    this.now = now;
    this.samples = new Map();   // key -> Ring
    this.counts = new Map();    // key -> { total, violations: {max,p50,p95,p99}, withinP95 }
    this.lastAlert = new Map();
    this.alerts = [];
  }

  match(method, reqPath) {
    const m = String(method).toUpperCase();
    for (const b of this.config.budgets) {
      if ((b.method === m || b.method === '*') && b.re.test(reqPath)) return b;
    }
    return null;
  }

  budgetFor(method, reqPath) {
    const b = this.match(method, reqPath);
    if (b) return b;
    const key = `${String(method).toUpperCase()} ${normalizeRoute(reqPath)}`;
    return { key, route: normalizeRoute(reqPath), method: String(method).toUpperCase(), ...this.config.defaults, configured: false };
  }

  /** 记录一次请求耗时 */
  record(method, reqPath, durationMs, status = 200) {
    const b = this.budgetFor(method, reqPath);
    let ring = this.samples.get(b.key);
    if (!ring) { ring = new Ring(this.config.evaluation.windowSize); this.samples.set(b.key, ring); }
    ring.push(durationMs);
    const c = this.counts.get(b.key) || { total: 0, withinP95: 0, violations: { max: 0, p50: 0, p95: 0, p99: 0 }, budget: b };
    c.total++;
    if (durationMs <= b.p95) c.withinP95++;
    this.counts.set(b.key, c);

    const labels = { route: b.key, budget_type: b.budgetType };
    if (this.metrics && this.metrics.histogram) { try { this.metrics.histogram.observe(labels, durationMs / 1000); } catch { /* ignore */ } }
    const violations = [];
    if (durationMs > b.max) {
      violations.push('max');
      c.violations.max++;
      this._violation(b, 'max', durationMs, status);
    }
    this._redisIncr(b.key, 'total');
    return { budget: b, violations };
  }

  _redisIncr(key, field) {
    if (!this.redis) return;
    const hour = this.now().toISOString().slice(0, 13).replace(/[-T]/g, '');
    const h = `perf:budget:${hour}`;
    try {
      const p = this.redis.hincrby(h, `${key}|${field}`, 1);
      if (p && p.then) p.then(() => this.redis.expire(h, 8 * 86400)).catch(() => {});
    } catch { /* ignore */ }
  }

  _violation(b, level, value, status) {
    if (this.metrics && this.metrics.violations) { try { this.metrics.violations.inc({ route: b.key, budget_type: b.budgetType, level }); } catch { /* ignore */ } }
    this._redisIncr(b.key, `violation:${level}`);
    if (b.budgetType === 'strict') {
      // 严格预算：立即告警（同一路由同一级别 60 秒内只告警一次）
      const k = `${b.key}|${level}`;
      const last = this.lastAlert.get(k) || 0;
      if (Date.now() - last > 60000) {
        this.lastAlert.set(k, Date.now());
        const alert = { severity: 'critical', route: b.key, level, value: Math.round(value), budget: b[level], budgetType: b.budgetType, priority: b.priority, status, at: this.now().toISOString() };
        this.alerts.unshift(alert);
        this.alerts.length = Math.min(this.alerts.length, 200);
        if (this.metrics && this.metrics.alerts) { try { this.metrics.alerts.inc({ route: b.key, level, severity: 'critical' }); } catch { /* ignore */ } }
        if (this.logger) this.logger.error({ alert: 'performance_budget', ...alert }, `性能预算违规（strict）：${b.key} ${level}=${Math.round(value)}ms > ${b[level]}ms`);
        if (typeof this.onAlert === 'function') { try { this.onAlert(alert); } catch { /* ignore */ } }
      }
    }
  }

  /** 周期评估：窗口内百分位与预算比较 */
  evaluate() {
    const results = [];
    for (const [key, ring] of this.samples) {
      const c = this.counts.get(key);
      const b = c.budget;
      const s = stats(ring.values());
      if (s.count < this.config.evaluation.minSamples) { results.push({ key, stats: s, budget: b, status: 'insufficient-samples', violations: [] }); continue; }
      const v = [];
      for (const p of ['p50', 'p95', 'p99']) {
        if (s[p] > b[p]) { v.push(p); c.violations[p]++; this._violation(b, p, s[p], null); }
      }
      results.push({ key, stats: s, budget: b, status: v.length ? 'violated' : 'ok', violations: v });
    }
    return results;
  }

  /** 预算达标报告 + 热点榜单 */
  report() {
    const routes = [];
    for (const [key, ring] of this.samples) {
      const c = this.counts.get(key);
      const b = c.budget;
      const s = stats(ring.values());
      routes.push({
        route: key, configured: b.configured !== false, budgetType: b.budgetType, priority: b.priority,
        budget: { p50: b.p50, p95: b.p95, p99: b.p99, max: b.max },
        observed: { count: s.count, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max, avg: s.avg !== null ? +s.avg.toFixed(2) : null },
        compliance: c.total ? +(c.withinP95 / c.total).toFixed(4) : null,
        violations: c.violations,
        heat: s.p95 !== null ? +(s.p95 / b.p95).toFixed(3) : 0,
      });
    }
    const configured = routes.filter((r) => r.configured);
    const passing = configured.filter((r) => r.observed.count >= this.config.evaluation.minSamples && r.observed.p95 <= r.budget.p95);
    return {
      summary: {
        routes: routes.length,
        configuredRoutes: configured.length,
        evaluatedRoutes: configured.filter((r) => r.observed.count >= this.config.evaluation.minSamples).length,
        complianceRate: configured.length ? +(passing.length / Math.max(1, configured.filter((r) => r.observed.count >= this.config.evaluation.minSamples).length)).toFixed(4) : null,
      },
      hotspots: [...routes].sort((a, b) => b.heat - a.heat).slice(0, 10),
      routes,
      recentAlerts: this.alerts.slice(0, 20),
    };
  }

  /** 最近 N 小时趋势（Redis 汇总，跨实例） */
  async trend(hours = 24) {
    if (!this.redis) return [];
    const out = [];
    const now = this.now().getTime();
    for (let i = hours - 1; i >= 0; i--) {
      const hour = new Date(now - i * 3600000).toISOString().slice(0, 13).replace(/[-T]/g, '');
      const h = await this.redis.hgetall(`perf:budget:${hour}`).catch(() => ({}));
      let total = 0, violations = 0;
      for (const [k, v] of Object.entries(h || {})) {
        if (k.endsWith('|total')) total += Number(v);
        else if (k.includes('|violation:')) violations += Number(v);
      }
      out.push({ hour, total, violations });
    }
    return out;
  }
}

/**
 * 回归检测：current / baseline 为 { 'GET /v1/x': { p50, p95, p99 } }
 * @returns {{ regressions: [], passed: boolean }}
 */
function detectRegression(baseline, current, thresholds = { p99: 0.2, p95: 0.15, p50: 0.1 }) {
  const regressions = [];
  for (const [route, cur] of Object.entries(current || {})) {
    const base = baseline && baseline[route];
    if (!base) continue;
    for (const p of ['p50', 'p95', 'p99']) {
      if (base[p] === undefined || cur[p] === undefined || !thresholds[p]) continue;
      // 基线很小（<5ms）时绝对抖动占比大：要求绝对增长 > 5ms 才算
      const growth = base[p] > 0 ? (cur[p] - base[p]) / base[p] : 0;
      if (growth > thresholds[p] && cur[p] - base[p] > 5) regressions.push({ route, percentile: p, baseline: base[p], current: cur[p], growth: +growth.toFixed(3), threshold: thresholds[p] });
    }
  }
  return { regressions, passed: regressions.length === 0 };
}

/** 基准结果与预算比较 */
function checkAgainstBudget(config, results) {
  const failures = [];
  for (const [route, r] of Object.entries(results)) {
    const [method, p] = route.split(' ');
    const b = config.budgets.find((x) => x.method === method && x.re.test(p));
    if (!b) continue;
    for (const k of ['p50', 'p95', 'p99']) {
      if (r[k] !== undefined && r[k] > b[k]) failures.push({ route, percentile: k, observed: r[k], budget: b[k], budgetType: b.budgetType, priority: b.priority });
    }
  }
  return { failures, passed: failures.filter((f) => f.budgetType === 'strict' || f.percentile === 'p95').length === 0 };
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  parseDuration,
  normalizeConfig,
  loadConfigFile,
  normalizeRoute,
  percentile,
  stats,
  PerformanceBudgetManager,
  detectRegression,
  checkAgainstBudget,
};
