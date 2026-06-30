#!/usr/bin/env node
/**
 * scripts/migrate-shared-imports.js
 * 
 * 迁移脚本：将相对路径导入转换为 @shared 别名导入
 * 
 * 使用方法：
 * node scripts/migrate-shared-imports.js [--dry-run] [--service <name>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// 配置
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVICES_DIR = path.join(PROJECT_ROOT, 'backend/services');
const SHARED_DIR = path.join(PROJECT_ROOT, 'backend/shared');

// 需要转换的模式
const RELATIVE_PATTERNS = [
  // ../../../shared/xxx
  /require\(['"](\.\.\/)+shared\/([^'"]+)['"]\)/g,
  // ../../shared/xxx
  /require\(['"](\.\.\/)+shared\/([^'"]+)['"]\)/g,
  // ../../../../../shared/xxx (更深层级)
  /require\(['"](\.\.\/){4,}shared\/([^'"]+)['"]\)/g
];

// 替换函数
function convertToAlias(importPath, filePath) {
  // 计算从当前文件到 shared 的相对路径层级
  const relativeMatch = importPath.match(/require\(['"]((?:\.\.\/)+)shared\/([^'"]+)['"]\)/);
  
  if (!relativeMatch) {
    return importPath;
  }
  
  const [, prefix, modulePath] = relativeMatch;
  
  // 转换为别名
  if (modulePath.endsWith('.js')) {
    modulePath = modulePath.slice(0, -3);
  }
  
  // 特殊处理：shared/index.js 或 shared 直接导入
  if (modulePath === 'index' || modulePath === '') {
    return `require('@shared')`;
  }
  
  return `require('@shared/${modulePath}')`;
}

// 处理单个文件
function processFile(filePath, dryRun = false) {
  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;
  let changes = 0;
  
  // 替换所有相对路径导入
  RELATIVE_PATTERNS.forEach(pattern => {
    content = content.replace(pattern, (match) => {
      const converted = convertToAlias(match, filePath);
      if (converted !== match) {
        changes++;
        return converted;
      }
      return match;
    });
  });
  
  // 处理 require('../../../shared') 直接引用
  content = content.replace(/require\(['"](\.\.\/)+shared['"]\)/g, (match) => {
    changes++;
    return 'require(\'@shared\')';
  });
  
  if (changes > 0 && !dryRun) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ ${path.relative(PROJECT_ROOT, filePath)} (${changes} changes)`);
  } else if (changes > 0 && dryRun) {
    console.log(`[dry-run] ${path.relative(PROJECT_ROOT, filePath)} (${changes} changes)`);
  }
  
  return { file: filePath, changes, modified: changes > 0 };
}

// 扫描服务目录
function scanServices(serviceName = null) {
  const services = serviceName 
    ? [path.join(SERVICES_DIR, serviceName)]
    : fs.readdirSync(SERVICES_DIR).map(s => path.join(SERVICES_DIR, s));
  
  const files = [];
  
  services.forEach(servicePath => {
    if (!fs.existsSync(servicePath)) return;
    
    // 扫描所有 .js 文件
    const jsFiles = glob.sync('**/*.js', {
      cwd: servicePath,
      ignore: ['node_modules/**']
    });
    
    jsFiles.forEach(file => {
      files.push(path.join(servicePath, file));
    });
  });
  
  // 扫描 gateway
  const gatewayPath = path.join(PROJECT_ROOT, 'backend/gateway');
  if (fs.existsSync(gatewayPath)) {
    const gatewayFiles = glob.sync('**/*.js', {
      cwd: gatewayPath,
      ignore: ['node_modules/**']
    });
    gatewayFiles.forEach(file => {
      files.push(path.join(gatewayPath, file));
    });
  }
  
  return files;
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const serviceArg = args.find(a => a.startsWith('--service='));
  const serviceName = serviceArg ? serviceArg.split('=')[1] : null;
  
  console.log('='.repeat(60));
  console.log('mineGo Shared Imports Migration Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  if (serviceName) {
    console.log(`Service: ${serviceName}`);
  }
  console.log('');
  
  // 扫描文件
  const files = scanServices(serviceName);
  console.log(`Found ${files.length} files to process`);
  console.log('');
  
  // 处理文件
  let totalChanges = 0;
  let modifiedFiles = 0;
  
  files.forEach(file => {
    const result = processFile(file, dryRun);
    totalChanges += result.changes;
    if (result.modified) modifiedFiles++;
  });
  
  console.log('');
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  Files processed: ${files.length}`);
  console.log(`  Files modified:  ${modifiedFiles}`);
  console.log(`  Total changes:   ${totalChanges}`);
  console.log('='.repeat(60));
  
  if (dryRun) {
    console.log('\nTo execute changes, run without --dry-run');
  }
}

// 运行
if (require.main === module) {
  main();
}

module.exports = { convertToAlias, processFile, scanServices };