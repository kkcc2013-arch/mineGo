'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRequirement, metadata, buildAudit } = require('../requirements-audit');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('reads status and priority from requirement tables', () => {
  const parsed = parseRequirement('REQ-00001-feature.md', '# Feature\n| 状态 | new |\n| 优先级 | P1 |\n');
  assert.equal(parsed.declaredStatus, 'new');
  assert.equal(parsed.priority, 'P1');
  assert.equal(parsed.verificationStatus, 'not-audited');
});

test('reads plain and bold metadata without importing embedded examples', () => {
  assert.equal(metadata('- **状态**：done', '状态'), 'done');
  assert.equal(metadata('- 状态: new', '状态'), 'new');
  assert.equal(metadata('```md\n- 状态: done\n```\n- 状态: new', '状态'), 'new');
});

test('extracts acceptance checkboxes from nested sections without collecting unrelated checklists', () => {
  const parsed = parseRequirement('REQ-00002-feature.md', '# Test\n## 范围\n- [ ] unrelated\n## 5. 验收标准\n- [ ] first\n### 接口\n- [x] second\n## 工作量\n- [ ] unrelated');
  assert.deepEqual(parsed.acceptance, ['- [ ] first', '- [x] second']);
});

test('does not infer done from completion claims outside status metadata', () => {
  const parsed = parseRequirement('REQ-00003-feature.md', '# Test\nThis feature is done\n');
  assert.equal(parsed.declaredStatus, 'untracked');
  assert.equal(parsed.priority, 'unspecified');
});

test('hashes complete document contents so changes invalidate the audit', () => {
  const first = parseRequirement('REQ-00004-feature.md', '# Test');
  const second = parseRequirement('REQ-00004-feature.md', '# Test\nNew acceptance clause');
  assert.notEqual(first.sha256, second.sha256);
});

test('changed source invalidates local verification without promoting a completion claim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minego-audit-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/requirements'), { recursive: true });
    fs.mkdirSync(path.join(root, 'backend'));
    const file = 'REQ-00001-feature.md';
    const document = '# REQ-00001: Feature\n- 状态: new\n';
    const source = 'module.exports = 1;';
    const hash = text => crypto.createHash('sha256').update(text).digest('hex');
    fs.writeFileSync(path.join(root, 'docs/requirements', file), document);
    fs.writeFileSync(path.join(root, 'backend/module.js'), source);
    fs.writeFileSync(path.join(root, 'docs/requirements/VERIFICATION.json'), JSON.stringify({ requirements: {
      [file]: { status: 'local_verified_ci_pending', documentSha256: hash(document), sourceSha256: { 'backend/module.js': hash(source) } }
    } }));
    const current = buildAudit(root);
    assert.equal(current.summary.localVerificationAwaitingCI, 1);
    assert.equal(current.summary.independentlyVerified, 0);
    fs.writeFileSync(path.join(root, 'backend/module.js'), 'module.exports = 2;');
    const changed = buildAudit(root);
    assert.equal(changed.requirements[0].verificationStatus, 'stale-evidence');
    assert.equal(changed.summary.localVerificationAwaitingCI, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
