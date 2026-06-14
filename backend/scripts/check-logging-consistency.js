#!/usr/bin/env node
/**
 * REQ-00193: 日志一致性检查脚本
 * 检查 services 目录中是否存在 console.log/console.error/console.warn 使用
 */

const fs = require('fs');
const path = require('path');

const servicesDir = path.join(__dirname, '../services');
const violations = [];
const warnings = [];

// 允许的模式（如测试文件、特定文件）
const ALLOWED_PATTERNS = [
  /\.test\.js$/,
  /\.spec\.js$/,
  /node_modules/
];

function isAllowed(filePath) {
  return ALLOWED_PATTERNS.some(pattern => pattern.test(filePath));
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  lines.forEach((line, idx) => {
    // 检查 console.log/error/warn/info/debug
    const match = line.match(/console\.(log|error|warn|info|debug)\(/);
    if (match && !isAllowed(filePath)) {
      // 忽略注释掉的 console
      if (line.includes('// console.') || line.includes('/* console.')) {
        return;
      }
      
      const method = match[1];
      const severity = method === 'error' ? 'ERROR' : method === 'warn' ? 'WARN' : 'VIOLATION';
      const target = severity === 'ERROR' ? violations : severity === 'WARN' ? warnings : violations;
      
      target.push({
        file: path.relative(path.join(__dirname, '..'), filePath),
        line: idx + 1,
        method,
        content: line.trim().substring(0, 80)
      });
    }
  });
}

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      if (!isAllowed(fullPath)) {
        scanFile(fullPath);
      }
    }
  }
}

// 主函数
function main() {
  console.log('🔍 Checking logging consistency in backend/services...\n');
  
  if (!fs.existsSync(servicesDir)) {
    console.error('❌ Services directory not found:', servicesDir);
    process.exit(1);
  }
  
  scanDir(servicesDir);
  
  // 输出结果
  if (violations.length > 0) {
    console.error('❌ Logging consistency violations found:\n');
    violations.forEach(v => {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    console.${v.method}: ${v.content}`);
      console.error('');
    });
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️  Warnings:\n');
    warnings.forEach(w => {
      console.warn(`  ${w.file}:${w.line}`);
      console.warn(`    console.${w.method}: ${w.content}`);
      console.warn('');
    });
  }
  
  // 总结
  console.log('\n📊 Summary:');
  console.log(`   Violations: ${violations.length}`);
  console.log(`   Warnings: ${warnings.length}`);
  
  if (violations.length > 0) {
    console.log('\n💡 Tip: Replace console.log/error/warn with logger.info/error/warn');
    console.log('   Example:');
    console.log('     // Before:');
    console.log('     console.log(`[Service] Message ${var}`);');
    console.log('     // After:');
    console.log('     logger.info({ var }, "Message");');
    process.exit(1);
  }
  
  console.log('\n✅ All services use structured logging');
  process.exit(0);
}

main();
