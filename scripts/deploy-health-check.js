#!/usr/bin/env node
/**
 * REQ-00592: 部署后健康检查窗口（PM2 环境）
 *
 * 在 WATCH_SECONDS 内每 INTERVAL_SECONDS 检查一次，任一条件不满足即判定失败（退出码 1）：
 *   1. 网关 /health 返回 200（网关会探测全部下游服务）
 *   2. PM2 中 pmg-* 进程全部 online，且观察期内重启次数没有增加（崩溃循环检测）
 *   3. 观察期内网关访问日志的 5xx 比例 ≤ ERROR_RATE_THRESHOLD（默认 1%，样本数 ≥ MIN_SAMPLES 才判定）
 *
 * 环境变量：HEALTH_URL、WATCH_SECONDS(300)、INTERVAL_SECONDS(10)、ERROR_RATE_THRESHOLD(0.01)、
 *           MIN_SAMPLES(20)、LOG_DIR(<repo>/logs)、STARTUP_GRACE_SECONDS(20)、PROBE_PATHS（逗号分隔，额外探测的公开 GET 路径）
 * 输出：最后一行为 JSON 结果，供 deploy-pm2.sh 记录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HEALTH_URL = process.env.HEALTH_URL || 'http://127.0.0.1:8080/health';
const BASE = new URL(HEALTH_URL).origin;
const WATCH = Number(process.env.WATCH_SECONDS || 300);
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 10);
const THRESHOLD = Number(process.env.ERROR_RATE_THRESHOLD || 0.01);
const MIN_SAMPLES = Number(process.env.MIN_SAMPLES || 20);
const GRACE = Number(process.env.STARTUP_GRACE_SECONDS || 20);
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, 'logs');
const PROBES = (process.env.PROBE_PATHS || '/health').split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[health ${new Date().toISOString()}]`, ...a);

function pm2Processes() {
  const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const list = JSON.parse(out.slice(out.indexOf('[')));
  return list.filter((p) => p.name.startsWith('pmg-')).map((p) => ({
    name: p.name, id: p.pm_id, status: p.pm2_env.status, restarts: p.pm2_env.restart_time,
  }));
}

/** 网关访问日志中 since 之后完成的请求：{ total, errors } */
function gatewayErrorRate(since) {
  let total = 0, errors = 0;
  if (!fs.existsSync(LOG_DIR)) return { total, errors };
  for (const f of fs.readdirSync(LOG_DIR).filter((n) => /^gateway-out/.test(n))) {
    const file = path.join(LOG_DIR, f);
    const stat = fs.statSync(file);
    if (stat.mtimeMs < since) continue;
    // 只读最后 5MB，避免大日志拖慢检查
    const size = Math.min(stat.size, 5 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('Request completed')) continue;
      const i = line.indexOf('{');
      if (i < 0) continue;
      let d;
      try { d = JSON.parse(line.slice(i)); } catch { continue; }
      const t = Date.parse(d.time || d.timestamp);
      if (!(t >= since)) continue;
      if (d.path === '/health' || d.path === '/metrics') continue;
      total++;
      if (Number(d.statusCode) >= 500) errors++;
    }
  }
  return { total, errors };
}

async function probe(p) {
  try {
    const res = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  const since = Date.now();
  log(`watching ${WATCH}s (interval ${INTERVAL}s, grace ${GRACE}s, 5xx threshold ${(THRESHOLD * 100).toFixed(2)}%)`);

  // 启动宽限期：等进程完成启动
  const graceEnd = Date.now() + GRACE * 1000;
  let baseline = null;
  while (Date.now() < graceEnd) {
    if ((await probe('/health')) === 200) break;
    await sleep(2000);
  }
  baseline = pm2Processes();
  const expected = baseline.length;
  const restartBase = Object.fromEntries(baseline.map((p) => [p.id, p.restarts]));

  const end = since + WATCH * 1000;
  let checks = 0;
  for (;;) {
    checks++;
    const procs = pm2Processes();
    const notOnline = procs.filter((p) => p.status !== 'online').map((p) => `${p.name}#${p.id}:${p.status}`);
    const crashed = procs.filter((p) => restartBase[p.id] !== undefined && p.restarts > restartBase[p.id]).map((p) => `${p.name}#${p.id}`);
    const probes = await Promise.all(PROBES.map(async (p) => [p, await probe(p)]));
    const badProbes = probes.filter(([, s]) => s !== 200).map(([p, s]) => `${p}=${s}`);
    const { total, errors } = gatewayErrorRate(since);
    const rate = total ? errors / total : 0;

    const reasons = [];
    if (procs.length < expected || notOnline.length) reasons.push(`processes not online: ${notOnline.join(',') || `${procs.length}/${expected}`}`);
    if (crashed.length) reasons.push(`restarted during watch (crash loop?): ${crashed.join(',')}`);
    if (badProbes.length) reasons.push(`health probe failed: ${badProbes.join(',')}`);
    if (total >= MIN_SAMPLES && rate > THRESHOLD) reasons.push(`5xx rate ${(rate * 100).toFixed(2)}% (${errors}/${total}) > ${(THRESHOLD * 100).toFixed(2)}%`);

    log(`check #${checks}: processes=${procs.length} probes=${probes.map(([p, s]) => `${p}:${s}`).join(' ')} requests=${total} 5xx=${errors}${reasons.length ? ' => FAIL' : ''}`);
    if (reasons.length) {
      console.log(JSON.stringify({ healthy: false, checks, reasons, requests: total, errors }));
      process.exit(1);
    }
    if (Date.now() >= end) {
      console.log(JSON.stringify({ healthy: true, checks, requests: total, errors, errorRate: rate }));
      process.exit(0);
    }
    await sleep(INTERVAL * 1000);
  }
}

main().catch((err) => {
  console.log(JSON.stringify({ healthy: false, reasons: [`checker error: ${err.message}`] }));
  process.exit(1);
});
