#!/usr/bin/env node
/**
 * OpenAPI 规范合并工具
 * 
 * 将分散的 OpenAPI 文件合并为一个完整的规范文件
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');

const OPENAPI_DIR = path.join(__dirname, '../../docs/api-spec/openapi');
const OUTPUT_FILE = path.join(OPENAPI_DIR, 'bundled.yaml');

function mergeOpenAPI() {
  console.log('🚀 开始合并 OpenAPI 规范...\n');
  
  // 1. 读取基础定义
  const basePath = path.join(OPENAPI_DIR, 'base.yaml');
  if (!fs.existsSync(basePath)) {
    console.error('❌ 基础文件不存在:', basePath);
    process.exit(1);
  }
  
  const bundled = YAML.load(basePath);
  console.log('✅ 已加载基础定义');
  
  // 2. 合并路径
  const pathsDir = path.join(OPENAPI_DIR, 'paths');
  if (fs.existsSync(pathsDir)) {
    const pathFiles = fs.readdirSync(pathsDir).filter(f => f.endsWith('.yaml'));
    
    for (const file of pathFiles) {
      const filePath = path.join(pathsDir, file);
      const content = YAML.load(filePath);
      
      bundled.paths = bundled.paths || {};
      // 直接合并 paths 下的内容，而不是整个文件
      if (content.paths) {
        Object.assign(bundled.paths, content.paths);
      }
      
      console.log(`✅ 已合并路径: ${file}`);
    }
  }
  
  // 3. 合并组件
  const componentsDir = path.join(OPENAPI_DIR, 'components');
  if (fs.existsSync(componentsDir)) {
    const componentFiles = fs.readdirSync(componentsDir).filter(f => f.endsWith('.yaml'));
    
    for (const file of componentFiles) {
      const filePath = path.join(componentsDir, file);
      const components = YAML.load(filePath);
      
      bundled.components = bundled.components || {};
      Object.assign(bundled.components, components);
      
      console.log(`✅ 已合并组件: ${file}`);
    }
  }
  
  // 4. 写入合并后的文件
  const yamlContent = YAML.stringify(bundled, 10, 2);
  fs.writeFileSync(OUTPUT_FILE, yamlContent, 'utf8');
  
  console.log(`\n✨ 合并完成: ${OUTPUT_FILE}`);
  console.log(`📊 统计:`);
  console.log(`   - 路径数: ${Object.keys(bundled.paths || {}).length}`);
  console.log(`   - 组件数: ${Object.keys(bundled.components?.schemas || {}).length}`);
}

// 执行合并
try {
  mergeOpenAPI();
} catch (err) {
  console.error('❌ 合并失败:', err.message);
  process.exit(1);
}
