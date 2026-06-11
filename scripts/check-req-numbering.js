#!/usr/bin/env node
/**
 * 需求编号唯一性检查
 *
 * 检查 docs/requirements/ 下的 REQ-XXXXX 编号是否重复。
 * 历史遗留的重复编号列入 KNOWN_DUPLICATES 豁免（待专项需求清理后移除），
 * 任何新增的重复编号都会导致非零退出码，阻断 CI。
 *
 * 用法: node scripts/check-req-numbering.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 历史遗留重复（2026-06-12 盘点），清理后请从此名单移除
// REQ-00057: game-event-system 与 multi-factor-authentication 共用编号
// REQ-00110: frontend-lazy-load 与 pokemon-bag-capacity 共用编号
const KNOWN_DUPLICATES = new Set(['REQ-00057', 'REQ-00110']);

const reqDir = path.join(__dirname, '..', 'docs', 'requirements');
// REQ-XXXXX-IMPLEMENTATION.md 是需求的伴生实现文档，不算独立需求
const files = fs
  .readdirSync(reqDir)
  .filter((f) => /^REQ-\d+/.test(f) && !/-IMPLEMENTATION\.md$/i.test(f));

const byNumber = new Map();
for (const f of files) {
  const num = f.match(/^REQ-\d+/)[0];
  if (!byNumber.has(num)) byNumber.set(num, []);
  byNumber.get(num).push(f);
}

let newDuplicates = 0;
let knownDuplicates = 0;

for (const [num, list] of byNumber) {
  if (list.length <= 1) continue;
  if (KNOWN_DUPLICATES.has(num)) {
    knownDuplicates++;
    console.warn(`[known-dup] ${num}: ${list.join(', ')}`);
  } else {
    newDuplicates++;
    console.error(`[NEW DUPLICATE] ${num}: ${list.join(', ')}`);
  }
}

console.log(
  `\nChecked ${files.length} requirement files, ${byNumber.size} unique numbers, ` +
    `${knownDuplicates} known duplicates (grandfathered), ${newDuplicates} new duplicates.`
);

if (newDuplicates > 0) {
  console.error(
    '\n编号重复！新需求编号必须取当前最大编号 +1。' +
      '请先运行本脚本确认下一个可用编号，再创建需求文档。'
  );
  process.exit(1);
}

// 输出下一个可用编号，方便需求生成流程直接使用
const maxNum = Math.max(...[...byNumber.keys()].map((n) => parseInt(n.slice(4), 10)));
console.log(`Next available number: REQ-${String(maxNum + 1).padStart(5, '0')}`);
