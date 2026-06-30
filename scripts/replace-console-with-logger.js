#!/usr/bin/env node
/**
 * REQ-00391: console.log 替换脚本
 * 自动将 console 调用替换为结构化日志
 */

const fs = require('fs');
const path = require('path');

const sharedDir = path.join(__dirname, '../backend/shared');
const files = fs.readdirSync(sharedDir).filter(f => f.endsWith('.js'));

const replacements = [];
const errors = [];

// 处理每个文件
for (const file of files) {
  const filePath = path.join(sharedDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;
  
  // 检查是否需要添加 logger 引入
  const hasConsole = content.includes('console.') && !file.includes('logger.js');
  const hasLoggerImport = content.includes("require('./logger')") || 
                          content.includes('require("@shared/logger') ||
                          content.includes('createLogger');
  
  if (hasConsole) {
    // 模块名
    const moduleName = file.replace('.js', '');
    
    // 添加 logger 引入（如果不存在）
    if (!hasLoggerImport) {
      // 在 'use strict' 后添加 logger 引入
      const lines = content.split('\n');
      let insertIndex = 0;
      
      // 找到合适的插入位置
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("'use strict'") || lines[i].includes('"use strict"')) {
          insertIndex = i + 1;
          break;
        }
        // 找到第一个非空行
        if (lines[i].trim() && !lines[i].trim().startsWith('//') && insertIndex === 0) {
          insertIndex = i;
        }
      }
      
      if (insertIndex > 0) {
        lines.splice(insertIndex, 0, `const { createLogger } = require('./logger');`);
        lines.splice(insertIndex + 1, 0, `const logger = createLogger('${moduleName}');`);
        content = lines.join('\n');
        modified = true;
      } else {
        // 文件开头添加
        content = `const { createLogger } = require('./logger');\nconst logger = createLogger('${moduleName}');\n\n` + content;
        modified = true;
      }
    }
    
    // 替换 console.error
    content = content.replace(
      /console\.error\(['"`]([^'"`]+)['"`]\s*,\s*([^)]+)\)/g,
      (match, prefix, obj) => {
        modified = true;
        const cleanPrefix = prefix.replace(/^\[|\]$/g, '').replace(/:\s*$/, '');
        return `logger.error({ module: '${cleanPrefix}', error: ${obj}.message }, '${cleanPrefix} error');`;
      }
    );
    
    // 替换 console.error 单参数
    content = content.replace(
      /console\.error\(([^)]+)\)/g,
      (match, arg) => {
        if (arg.includes('logger.') || arg.includes('createLogger')) return match;
        modified = true;
        return `logger.error({ module: '${moduleName}' }, ${arg});`;
      }
    );
    
    // 替换 console.warn
    content = content.replace(
      /console\.warn\(['"`]([^'"`]+)['"`]\s*(?:,\s*([^)]+))?\)/g,
      (match, prefix, obj) => {
        modified = true;
        const cleanPrefix = prefix.replace(/^\[|\]$/g, '').replace(/:\s*$/, '');
        if (obj) {
          return `logger.warn({ module: '${cleanPrefix}', data: ${obj} }, '${cleanPrefix} warning');`;
        }
        return `logger.warn({ module: '${cleanPrefix}' }, '${cleanPrefix} warning');`;
      }
    );
    
    // 替换 console.log
    content = content.replace(
      /console\.log\(['"`]([^'"`]+)['"`]\s*(?:,\s*([^)]+))?\)/g,
      (match, prefix, obj) => {
        modified = true;
        const cleanPrefix = prefix.replace(/^\[|\]$/g, '').replace(/:\s*$/, '');
        if (obj) {
          return `logger.info({ module: '${cleanPrefix}', data: ${obj} }, '${cleanPrefix} message');`;
        }
        return `logger.info({ module: '${cleanPrefix}' }, '${cleanPrefix} message');`;
      }
    );
    
    // 替换模板字符串形式的 console
    content = content.replace(
      /console\.(log|error|warn)\(`\[([^\]]+)\]\s*([^`]*)`\)/g,
      (match, level, prefix, message) => {
        modified = true;
        const logLevel = level === 'log' ? 'info' : level;
        return `logger.${logLevel}({ module: '${prefix}' }, '${message.trim()}');`;
      }
    );
    
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf-8');
      replacements.push(file);
    }
  }
}

console.log('Replacements completed:');
console.log(`- Files processed: ${files.length}`);
console.log(`- Files modified: ${replacements.length}`);
if (replacements.length > 0) {
  console.log('\nModified files:');
  replacements.forEach(f => console.log(`  - ${f}`));
}

if (errors.length > 0) {
  console.error('\nErrors:');
  errors.forEach(e => console.error(`  - ${e}`));
}
