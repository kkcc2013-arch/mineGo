#!/usr/bin/env node
// backend/scripts/extract-openapi-keys.js
// 从 OpenAPI 规范中提取所有需要翻译的键
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const TRANSLATIONS_DIR = path.join(__dirname, '../../docs/api-spec/openapi/translations');
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

/**
 * 从 OpenAPI 规范中提取所有需要翻译的键
 */
function extractTranslationKeys(spec) {
  const keys = [];
  
  if (!spec || typeof spec !== 'object') return keys;
  
  // info 字段
  if (spec.info) {
    if (spec.info.title) {
      keys.push({ key: 'info.title', text: spec.info.title, category: 'info' });
    }
    if (spec.info.description) {
      keys.push({ key: 'info.description', text: spec.info.description, category: 'info' });
    }
  }
  
  // tags
  if (spec.tags && Array.isArray(spec.tags)) {
    spec.tags.forEach(tag => {
      if (tag.description) {
        keys.push({ 
          key: `tags.${tag.name}.description`, 
          text: tag.description,
          category: 'tags'
        });
      }
    });
  }
  
  // paths
  if (spec.paths) {
    for (const [pathName, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation || typeof operation !== 'object') continue;
        
        const pathPrefix = `paths.${pathName}.${method}`;
        
        if (operation.summary) {
          keys.push({ 
            key: `${pathPrefix}.summary`, 
            text: operation.summary,
            category: 'paths'
          });
        }
        if (operation.description) {
          keys.push({ 
            key: `${pathPrefix}.description`, 
            text: operation.description,
            category: 'paths'
          });
        }
        
        // parameters
        if (operation.parameters && Array.isArray(operation.parameters)) {
          operation.parameters.forEach(param => {
            if (param.description) {
              keys.push({ 
                key: `${pathPrefix}.parameters.${param.name}.description`, 
                text: param.description,
                category: 'parameters'
              });
            }
          });
        }
        
        // requestBody
        if (operation.requestBody?.description) {
          keys.push({ 
            key: `${pathPrefix}.requestBody.description`, 
            text: operation.requestBody.description,
            category: 'requestBody'
          });
        }
        
        // responses
        if (operation.responses) {
          for (const [status, response] of Object.entries(operation.responses)) {
            if (response?.description) {
              keys.push({ 
                key: `${pathPrefix}.responses.${status}.description`, 
                text: response.description,
                category: 'responses'
              });
            }
          }
        }
      }
    }
  }
  
  return keys;
}

/**
 * 主函数
 */
function main() {
  console.log('🔍 开始提取 OpenAPI 翻译键...\n');
  
  const allKeys = {};
  
  for (const lang of SUPPORTED_LANGUAGES) {
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
    
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  文件不存在: ${lang}.yaml`);
      continue;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const spec = yaml.load(content);
      const keys = extractTranslationKeys(spec);
      allKeys[lang] = keys;
      
      console.log(`✅ ${lang}: ${keys.length} 个翻译键`);
    } catch (err) {
      console.error(`❌ ${lang} 解析失败:`, err.message);
    }
  }
  
  // 输出为 JSON（供翻译工具使用）
  const outputFile = path.join(TRANSLATIONS_DIR, '../translation-keys.json');
  fs.writeFileSync(outputFile, JSON.stringify(allKeys, null, 2));
  console.log(`\n✅ 已写入: ${outputFile}\n`);
  
  // 按类别分组统计
  if (allKeys['zh-CN']) {
    const grouped = {};
    allKeys['zh-CN'].forEach(k => {
      grouped[k.category] = (grouped[k.category] || 0) + 1;
    });
    
    console.log('📈 分类统计（zh-CN）：');
    Object.entries(grouped).forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count}`);
    });
  }
  
  // 对比覆盖率
  console.log('\n📊 翻译覆盖率：');
  const baseKeys = allKeys['zh-CN']?.map(k => k.key) || [];
  
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === 'zh-CN') continue;
    
    const langKeys = allKeys[lang]?.map(k => k.key) || [];
    const missing = baseKeys.filter(k => !langKeys.includes(k));
    const coverage = baseKeys.length > 0 
      ? ((baseKeys.length - missing.length) / baseKeys.length * 100).toFixed(2)
      : 0;
    
    console.log(`  ${lang}: ${coverage}% (${langKeys.length}/${baseKeys.length})`);
    
    if (missing.length > 0 && missing.length <= 10) {
      console.log(`    缺失: ${missing.join(', ')}`);
    }
  }
}

main();
