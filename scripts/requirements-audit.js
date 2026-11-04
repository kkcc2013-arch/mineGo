#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function metadata(text, name) {
  // Ignore embedded examples, which often contain their own metadata.
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const patterns = [
    new RegExp(`^\\|\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*\\|\\s*([^|\\n]+)`, 'm'),
    new RegExp(`^\\s*-?\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[：:]\\s*(.+)$`, 'm')
  ];
  for (const pattern of patterns) {
    const match = prose.match(pattern);
    if (match) return match[1].replace(/\*\*/g, '').trim();
  }
  return null;
}

function parseRequirement(file, text) {
  const id = file.match(/^REQ-\d+/)[0];
  const title = text.match(/^#\s+(.+)$/m)?.[1] || file;
  const declaredStatus = metadata(text, '状态') || 'untracked';
  const priority = metadata(text, '优先级')?.match(/P[0-3]/)?.[0] || 'unspecified';
  const lines = text.split('\n');
  const acceptance = [];
  let sectionLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (/验收标准|验收条件|验收指标|Acceptance Criteria/i.test(heading[2])) sectionLevel = heading[1].length;
      else if (sectionLevel && heading[1].length <= sectionLevel) sectionLevel = 0;
    } else if (sectionLevel && /^\s*-\s*\[[ xX]\]/.test(line)) {
      acceptance.push(line.trim());
    }
  }
  return {
    file, id, title, priority, declaredStatus,
    category: metadata(text, '类别') || 'unspecified',
    modules: metadata(text, '涉及服务/模块') || metadata(text, '涉及服务') || 'unspecified',
    createdAt: metadata(text, '创建时间') || 'unspecified',
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    acceptance,
    // A status declaration or a code comment is not acceptance evidence.
    verificationStatus: 'not-audited', implementationReferences: []
  };
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', 'coverage', 'dist', 'build'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function buildAudit(root) {
  const directory = path.join(root, 'docs/requirements');
  const requirements = fs.readdirSync(directory)
    .filter(file => /^REQ-\d+.*\.md$/.test(file) && !/-IMPLEMENTATION\.md$/i.test(file))
    .sort().map(file => parseRequirement(file, fs.readFileSync(path.join(directory, file), 'utf8')));
  const referenceMap = new Map();
  for (const folder of ['backend', 'frontend', 'infrastructure', 'database', 'scripts', '.github']) {
    for (const file of filesUnder(path.join(root, folder))) {
      if (!/\.(?:js|ts|sql|ya?ml|sh|json)$/.test(file) || /lock\.json$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const id of new Set(text.match(/REQ-\d{5}\b/g) || [])) {
        if (!referenceMap.has(id)) referenceMap.set(id, []);
        referenceMap.get(id).push(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  }
  const migrationFile = path.join(directory, 'NUMBER-MIGRATIONS.json');
  const migrations = fs.existsSync(migrationFile) ? JSON.parse(fs.readFileSync(migrationFile, 'utf8')).migrations : [];
  const migrationByFile = new Map(migrations.map(migration => [migration.newFile, migration]));
  const evidenceFile = path.join(directory, 'VERIFICATION.json');
  const evidence = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).requirements : {};
  const groups = new Map();
  const declaredStatusCounts = {};
  const priorityCounts = {};
  for (const requirement of requirements) {
    const record = evidence[requirement.file];
    if (record) {
      const sourcesMatch = Object.entries(record.sourceSha256).every(([file, hash]) => {
        const target = path.resolve(root, file);
        if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return false;
        if (!fs.realpathSync(target).startsWith(root + path.sep)) return false;
        return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === hash;
      });
      requirement.verificationStatus = record.documentSha256 === requirement.sha256 && sourcesMatch ? record.status : 'stale-evidence';
    }
    const migration = migrationByFile.get(requirement.file);
    requirement.legacyId = migration?.oldId || null;
    requirement.implementationReferences = [...new Set([
      ...(referenceMap.get(requirement.id) || []),
      ...(migration ? referenceMap.get(migration.oldId) || [] : [])
    ])].sort();
    if (!groups.has(requirement.id)) groups.set(requirement.id, []);
    groups.get(requirement.id).push(requirement.file);
    declaredStatusCounts[requirement.declaredStatus] = (declaredStatusCounts[requirement.declaredStatus] || 0) + 1;
    priorityCounts[requirement.priority] = (priorityCounts[requirement.priority] || 0) + 1;
  }
  return {
    schemaVersion: 1,
    summary: {
      requirementDocuments: requirements.length, uniqueIds: groups.size,
      declaredStatusCounts, priorityCounts,
      withoutAcceptanceCheckboxes: requirements.filter(r => !r.acceptance.length).length,
      // Verification must be added per requirement with concrete command output;
      // discovery never upgrades a requirement to verified.
      independentlyVerified: requirements.filter(r => r.verificationStatus === 'verified').length,
      localVerificationAwaitingCI: requirements.filter(r => r.verificationStatus === 'local_verified_ci_pending').length
    },
    duplicateIds: [...groups].filter(([, files]) => files.length > 1).map(([id, files]) => ({ id, files })),
    requirements
  };
}

function markdown(audit) {
  const { summary } = audit;
  const rows = audit.requirements.map(r =>
    `| [${r.file}](${r.file}) | ${r.priority} | ${r.declaredStatus} | ${r.acceptance.length} | ${r.implementationReferences.length} |`
  );
  return `# Full requirement inventory\n\n` +
    `Generated by \`npm run requirements:audit\`. Identify work by filename; legacy duplicate IDs are mapped in NUMBER-MIGRATIONS.md.\n\n` +
    `${summary.requirementDocuments} requirement documents; ${summary.uniqueIds} distinct IDs; ` +
    `${audit.duplicateIds.length} IDs appear in multiple documents. Companion implementation reports are excluded.\n\n` +
    `Declared statuses: ${Object.entries(summary.declaredStatusCounts).map(([status, count]) => `${status}: ${count}`).join(', ')}.\n\n` +
    `Status declarations and implementation references are discovery data, not proof of completion. ` +
    `Full completion requires acceptance verification. ${summary.localVerificationAwaitingCI} requirement has matching local verification evidence awaiting CI. See [audit data](AUDIT.json) for ` +
    `document hashes, acceptance checkboxes, and source references. References to duplicated IDs may ` +
    `belong to another document in the same legacy group; see [number migrations](NUMBER-MIGRATIONS.md).\n\n` +
    `| Requirement document | Priority | Declared status | Acceptance checkboxes | Source references |\n` +
    `|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

function indexMarkdown(audit) {
  const escapeCell = value => value.replace(/\|/g, '\\|');
  const rows = audit.requirements.map(r => {
    const title = r.title.replace(/^REQ-\d+\s*[：:]?\s*/, '');
    return `| [${r.id}](${r.file}) | ${escapeCell(title)} | ${escapeCell(r.category)} | ${r.priority} | ${r.declaredStatus} | ${escapeCell(r.modules)} | ${escapeCell(r.createdAt)} |`;
  });
  return '# mineGo 需求总索引\n\n' +
    '> 从全部需求文档生成：`npm run requirements:audit`。状态为文档中的声明，验收证据见 WORKLOG.md。编号迁移记录见 NUMBER-MIGRATIONS.md。\n\n' +
    `当前 ${audit.summary.requirementDocuments} 条需求；${audit.summary.uniqueIds} 个唯一编号。伴生实现报告不计入需求数量。\n\n` +
    '| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |\n' +
    '|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n';
}

function main() {
  const root = path.resolve(__dirname, '..');
  const audit = buildAudit(root);
  const outputs = { 'AUDIT.json': JSON.stringify(audit, null, 2) + '\n', 'AUDIT.md': markdown(audit), 'INDEX.md': indexMarkdown(audit) };
  let stale = false;
  for (const [file, content] of Object.entries(outputs)) {
    const target = path.join(root, 'docs/requirements', file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
        console.error(`Requirement inventory is stale: ${file}. Run npm run requirements:audit.`);
        stale = true;
      }
    } else fs.writeFileSync(target, content);
  }
  console.log(JSON.stringify(audit.summary, null, 2));
  if (stale) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { metadata, parseRequirement, buildAudit, markdown, indexMarkdown };
