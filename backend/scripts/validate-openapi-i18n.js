#!/usr/bin/env node
// backend/scripts/validate-openapi-i18n.js
// 验证所有语言的翻译完整性
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const TRANSLATIONS_DIR = path.join(__dirname, '../../docs/api-spec/openapi/translations');

/**
 * 验证所有语言的翻译完整性
 */
function validateTranslations() {
  console.log('🔍 开始验证 OpenAPI 多语言翻译...\n');
  
  const errors = [];
  const warnings = [];
  
  // 检查翻译文件是否存在
  for (const lang of SUPPORTED_LANGUAGES) {
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
    
    if (!fs.existsSync(filePath)) {
      errors.push(`❌ 缺少翻译文件: ${lang}.yaml`);
      continue;
    }
    
    // 验证 YAML 语法
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      yaml.load(content);
      console.log(`✅ ${lang}.yaml 语法正确`);
    } catch (err) {
      errors.push(`❌ ${lang}.yaml 语法错误: ${err.message}`);
    }
  }
  
  // 对比翻译键覆盖率
  if (errors.length === 0) {
    const specs = {};
    for (const lang of SUPPORTED_LANGUAGES) {
      const content = fs.readFileSync(path.join(TRANSLATIONS_DIR, `${lang}.yaml`), 'utf-8');
      specs[lang] = yaml.load(content);
    }
    
    // 提取所有键
    const allKeys = {};
    for (const [lang, spec] of Object.entries(specs)) {
      allKeys[lang] = extractAllKeys(spec);
    }
    
    // 对比
    const baseKeys = allKeys['zh-CN'];
    for (const lang of ['en-US', 'ja-JP']) {
      const langKeys = allKeys[lang];
      const missing = baseKeys.filter(k => !langKeys.includes(k));
      const extra = langKeys.filter(k => !baseKeys.includes(k));
      
      if (missing.length > 0) {
        warnings.push(`⚠️  ${lang} 缺少 ${missing.length} 个翻译键`);
        missing.slice(0, 5).forEach(k => warnings.push(`    - ${k}`));
        if (missing.length > 5) warnings.push(`    ... 还有 ${missing.length - 5} 个`);
      }
      
      if (extra.length > 0) {
        warnings.push(`⚠️  ${lang} 多出 ${extra.length} 个翻译键`);
      }
      
      const coverage = baseKeys.length > 0 
        ? ((baseKeys.length - missing.length) / baseKeys.length * 100).toFixed(2)
        : 0;
      console.log(`📊 ${lang} 覆盖率: ${coverage}%`);
    }
  }
  
  // 输出结果
  console.log('\n' + '='.repeat(50));
  
  if (errors.length > 0) {
    console.log('\n❌ 错误：');
    errors.forEach(e => console.log(e));
    process.exit(1);
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️  警告：');
    warnings.forEach(w => console.log(w));
  }
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n✅ 所有翻译验证通过！');
  }
}

function extractAllKeys(obj, prefix = '') {
  const keys = [];
  
  if (!obj || typeof obj !== 'object') return keys;
  
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (typeof value === 'string' && (key === 'description' || key === 'summary')) {
      keys.push(fullKey);
    } else if (typeof value === 'object' && value !== null) {
      keys.push(...extractAllKeys(value, fullKey));
    }
  }
  
  return keys;
}

validateTranslations();
