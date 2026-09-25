#!/usr/bin/env node
/**
 * 依赖声明检查：backend 各 workspace（shared / gateway / services/*）里 require 的第三方包
 * 必须在"该 workspace 自己的 package.json"或"backend/package.json"中声明。
 *
 * 原因：部署脚本（.github/workflows/deploy.yml）按目录逐个 `npm install --omit=dev`，
 * 未声明的包在生产机上会 MODULE_NOT_FOUND；本机开发因为 workspace 提升（hoist）而察觉不到。
 *
 * 用法：node scripts/check-deps.js [--json]    有缺失时退出码 1
 * 只检查从各服务入口（gateway/src/index.js、services/<服务>/src/index.js）沿相对 require 可达的运行时代码；
 * 包按"引用它的文件所属 workspace"归属（与按目录安装后 Node 的解析路径一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const BACKEND = path.resolve(__dirname, '..', 'backend');
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function readPkg(dir) {
  const f = path.join(dir, 'package.json');
  if (!fs.existsSync(f)) return null;
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { name: p.name, deps: new Set([...Object.keys(p.dependencies || {}), ...Object.keys(p.peerDependencies || {}), ...Object.keys(p.optionalDependencies || {})]) };
}

// 可选依赖：只在 try/catch 或动态 import 中加载，缺失时功能降级（不声明，避免生产安装不需要的重型包）
const OPTIONAL = {
  '@opentelemetry/sdk-node': 'shared/tracing.js 动态 import，缺失时不导出 OTel 数据',
  '@opentelemetry/exporter-trace-otlp-grpc': '同上',
  '@opentelemetry/exporter-metrics-otlp-grpc': '同上',
  'geoip-lite': 'shared/sessionAnomalyDetector.js try/catch，缺失时不做 IP 地理定位',
  '@clickhouse/client': 'gateway/src/routes/businessEvents.js try/catch，缺失时业务事件不写 ClickHouse',
};

const NPM_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return NPM_NAME.test(name) ? name : null;
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return fs.realpathSync(c); // gateway/shared 等是指向 backend/shared 的符号链接
  }
  return null;
}

// 文件归属的 workspace：最近的带 package.json 的 backend 子目录（shared / gateway / services/xxx）
function ownerOf(file, workspaces) {
  let best = null;
  for (const w of workspaces) if (file.startsWith(w + path.sep) && (!best || w.length > best.length)) best = w;
  return best;
}

/** 从各服务入口出发，沿相对 require 收集可达文件及其引用的第三方包 */
function collect(entries, workspaces) {
  const seen = new Set();
  const uses = new Map(); // workspace -> Map(pkg -> Set(files))
  const re = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\))/g;
  const stack = entries.map((e) => fs.realpathSync(e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || file.includes(`${path.sep}node_modules${path.sep}`) || !file.endsWith('.js')) continue;
    seen.add(file);
    // 去掉注释，避免把注释里的示例 require 当成依赖
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('.')) {
        const r = resolveLocal(file, spec);
        if (r) stack.push(r);
        continue;
      }
      const name = packageName(spec);
      if (!name) continue;
      const w = ownerOf(file, workspaces) || BACKEND;
      if (!uses.has(w)) uses.set(w, new Map());
      if (!uses.get(w).has(name)) uses.get(w).set(name, new Set());
      uses.get(w).get(name).add(path.relative(BACKEND, file));
    }
  }
  return { seen, uses };
}

function main() {
  const root = readPkg(BACKEND);
  const serviceDirs = fs.readdirSync(path.join(BACKEND, 'services'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => path.join(BACKEND, 'services', e.name))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')));
  const workspaces = [path.join(BACKEND, 'shared'), path.join(BACKEND, 'gateway'), ...serviceDirs];
  const entries = [path.join(BACKEND, 'gateway', 'src', 'index.js'),
    ...serviceDirs.map((d) => path.join(d, 'src', 'index.js')).filter((f) => fs.existsSync(f))];
  const { seen, uses } = collect(entries, workspaces);
  let total = 0;
  const report = [];
  for (const w of workspaces) {
    const pkg = readPkg(w);
    const missing = [...(uses.get(w) || new Map())].filter(([name]) => !pkg.deps.has(name) && !root.deps.has(name) && !OPTIONAL[name]);
    report.push({ workspace: path.relative(BACKEND, w), missing: missing.map(([n]) => n) });
    if (!missing.length) continue;
    console.log(`\n${path.relative(BACKEND, w)} (${pkg.name}) 缺少声明：`);
    for (const [name, files] of missing) {
      total++;
      console.log(`  - ${name}  （${files.size} 处，如 ${[...files][0]}）`);
    }
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report));
  console.log(`\n从 ${entries.length} 个服务入口可达 ${seen.size} 个文件；${total ? `共 ${total} 项缺失` : '依赖声明完整'}`);
  process.exit(total ? 1 : 0);
}

if (require.main === module) main();
module.exports = { collect, packageName };
