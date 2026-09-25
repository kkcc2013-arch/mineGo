#!/usr/bin/env node
/**
 * REQ-00547 / REQ-00520：契约快照与破坏性变更门禁
 *
 *   node scripts/contract-snapshot.js --update          生成 docs/api-spec/contracts/schema-snapshot.json
 *   node scripts/contract-snapshot.js --check [--json]  对比快照与当前契约（backend/shared/apiStandards/schemas），
 *                                                       存在未审批的破坏性变更时退出码 1
 *   node scripts/contract-snapshot.js --report          输出 Markdown 兼容性报告
 *
 * 审批：docs/api-spec/contracts/approved-breaking-changes.json
 *   [{ "contract": "users.me", "type": "OPTIONAL_FIELD_REMOVED", "path": "$.data.avatar", "reason": "...", "approvedBy": "..." }]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, loadRegistry } = require('./lib/contracts');
const compat = require(path.join(ROOT, 'backend', 'shared', 'apiStandards', 'compatibility'));

const DIR = path.join(ROOT, 'docs', 'api-spec', 'contracts');
const SNAP = path.join(DIR, 'schema-snapshot.json');
const APPROVED = path.join(DIR, 'approved-breaking-changes.json');

function resolver(defs) {
  return (ref) => {
    const [name, frag] = ref.split('#');
    if (!defs[name] || !frag) return null;
    return frag.slice(1).split('/').reduce((n, k) => (n ? n[k] : undefined), { definitions: defs[name] }) || null;
  };
}

function main() {
  const args = process.argv.slice(2);
  const current = loadRegistry().snapshot();
  if (args.includes('--update')) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(SNAP, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...current }, null, 2)}\n`);
    if (!fs.existsSync(APPROVED)) fs.writeFileSync(APPROVED, '[]\n');
    console.log(`快照已更新：${path.relative(ROOT, SNAP)}（${Object.keys(current.contracts).length} 个契约）`);
    return 0;
  }
  if (!fs.existsSync(SNAP)) {
    console.error('缺少快照，请先运行 node scripts/contract-snapshot.js --update');
    return 1;
  }
  const old = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const approved = fs.existsSync(APPROVED) ? JSON.parse(fs.readFileSync(APPROVED, 'utf8')) : [];
  const r = compat.detectContractChanges(old.contracts, current.contracts, { resolveOld: resolver(old.definitions), resolveNew: resolver(current.definitions) });
  const isApproved = (c) => approved.some((a) => a.contract === c.contract && a.type === c.type && (!a.path || a.path === c.path));
  const unapprovedBreaking = r.changes.filter((c) => c.breaking && !isApproved(c));
  const drift = r.changes.filter((c) => !c.breaking);
  if (args.includes('--report')) {
    console.log(compat.generateMigrationGuide(r, { title: 'API 契约兼容性报告（快照 → 当前）' }));
    return unapprovedBreaking.length ? 1 : 0;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary: r.summary, unapprovedBreaking, nonBreaking: drift.length }, null, 2));
  } else {
    console.log(`契约对比：${r.summary.total} 处变更，破坏性 ${r.summary.breaking}，未审批 ${unapprovedBreaking.length}`);
    for (const c of unapprovedBreaking) console.log(`  ⛔ [${c.priority}] ${c.type} ${c.contract} ${c.path || ''} ${c.from ? `${c.from}→${c.to}` : ''}`);
    if (drift.length) console.log(`  ℹ️  非破坏性变更 ${drift.length} 处（运行 --update 刷新快照）`);
  }
  return unapprovedBreaking.length ? 1 : 0;
}

process.exitCode = main();
