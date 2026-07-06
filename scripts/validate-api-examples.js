#!/usr/bin/env node
/**
 * API 示例验证脚本
 * 验证 API 示例与 OpenAPI 规范的一致性
 */

const fs = require('fs');
const path = require('path');

class ExampleValidator {
  constructor() {
    this.examplesDir = path.join(__dirname, '../docs/api-examples');
    this.errors = [];
    this.warnings = [];
    this.stats = {
      total: 0,
      valid: 0,
      invalid: 0
    };
  }

  async validate() {
    console.log('🔍 开始验证 API 示例...\n');
    
    const examples = this.loadExamples();
    this.stats.total = examples.length;

    for (const example of examples) {
      const isValid = this.validateExample(example);
      
      if (isValid) {
        this.stats.valid++;
      } else {
        this.stats.invalid++;
      }
    }

    this.generateReport();
    return this.errors.length === 0;
  }

  loadExamples() {
    const examples = [];
    
    const walkDir = (dir) => {
      const files = fs.readdirSync(dir);
      
      for (const file of files) {
        const fullPath = path.join(dir, file);
        
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath);
        } else if (file.endsWith('.md') && file !== 'README.md') {
          examples.push({
            file: fullPath,
            relativePath: path.relative(this.examplesDir, fullPath),
            content: fs.readFileSync(fullPath, 'utf8')
          });
        }
      }
    };

    walkDir(this.examplesDir);
    return examples;
  }

  validateExample(example) {
    let isValid = true;
    
    // 1. 检查基本结构
    if (!this.checkBasicStructure(example)) {
      isValid = false;
    }

    // 2. 检查端点定义
    if (!this.checkEndpointDefinition(example)) {
      isValid = false;
    }

    // 3. 检查请求示例
    if (!this.checkRequestExamples(example)) {
      isValid = false;
    }

    // 4. 检查响应示例
    if (!this.checkResponseExamples(example)) {
      isValid = false;
    }

    // 5. 检查代码语法
    if (!this.checkCodeSyntax(example)) {
      isValid = false;
    }

    return isValid;
  }

  checkBasicStructure(example) {
    const requiredSections = ['基本信息', '请求示例', '成功响应'];
    let hasAll = true;

    for (const section of requiredSections) {
      if (!example.content.includes(section)) {
        this.warnings.push({
          file: example.relativePath,
          message: `缺少必要章节: ${section}`
        });
        hasAll = false;
      }
    }

    return hasAll;
  }

  checkEndpointDefinition(example) {
    // 检查端点格式：`METHOD /path`
    const endpointRegex = /端点[`：:\s]*`?([A-Z]+)\s+([\/\w\-{}]+)`?/i;
    const match = example.content.match(endpointRegex);

    if (!match) {
      this.warnings.push({
        file: example.relativePath,
        message: '未找到明确的端点定义'
      });
      return false;
    }

    const [, method, endpointPath] = match;
    
    // 验证 HTTP 方法
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!validMethods.includes(method.toUpperCase())) {
      this.errors.push({
        file: example.relativePath,
        message: `无效的 HTTP 方法: ${method}`
      });
      return false;
    }

    // 验证路径格式
    if (!endpointPath.startsWith('/')) {
      this.errors.push({
        file: example.relativePath,
        message: `端点路径必须以 / 开头: ${endpointPath}`
      });
      return false;
    }

    return true;
  }

  checkRequestExamples(example) {
    // 检查 cURL 示例
    const hasCurl = example.content.includes('curl -X');
    
    // 检查 JavaScript 示例
    const hasJsFetch = example.content.includes('fetch(');
    const hasApiClient = example.content.includes('ApiClient.');

    if (!hasCurl && !hasJsFetch && !hasApiClient) {
      this.warnings.push({
        file: example.relativePath,
        message: '缺少请求示例（cURL 或 JavaScript）'
      });
      return false;
    }

    // 检查 JavaScript 代码语法
    const jsCodeRegex = /```javascript\s*\n([\s\S]*?)\n```/g;
    let match;
    
    while ((match = jsCodeRegex.exec(example.content)) !== null) {
      try {
        // 简单语法检查
        new Function(match[1]);
      } catch (e) {
        this.errors.push({
          file: example.relativePath,
          message: `JavaScript 代码语法错误: ${e.message}`
        });
        return false;
      }
    }

    return true;
  }

  checkResponseExamples(example) {
    // 检查 JSON 响应示例
    const jsonRegex = /```json\s*\n([\s\S]*?)\n```/g;
    let hasValidJson = false;
    let match;
    
    while ((match = jsonRegex.exec(example.content)) !== null) {
      try {
        const json = JSON.parse(match[1]);
        
        // 检查响应格式规范
        if (json.hasOwnProperty('success')) {
          hasValidJson = true;
          
          // 检查 meta 字段
          if (json.success === true && !json.meta) {
            this.warnings.push({
              file: example.relativePath,
              message: '成功响应缺少 meta 字段'
            });
          }
          
          // 检查 error 字段
          if (json.success === false && !json.error) {
            this.warnings.push({
              file: example.relativePath,
              message: '错误响应缺少 error 字段'
            });
          }
        }
      } catch (e) {
        this.errors.push({
          file: example.relativePath,
          message: `JSON 格式错误: ${e.message}`
        });
        return false;
      }
    }

    if (!hasValidJson) {
      this.warnings.push({
        file: example.relativePath,
        message: '未找到标准的 JSON 响应示例'
      });
      return false;
    }

    return true;
  }

  checkCodeSyntax(example) {
    // 检查代码块
    const codeBlocks = example.content.matchAll(/```(\w+)\s*\n([\s\S]*?)\n```/g);
    
    for (const match of codeBlocks) {
      const [, lang, code] = match;
      
      if (lang === 'javascript' || lang === 'js') {
        try {
          new Function(code);
        } catch (e) {
          this.errors.push({
            file: example.relativePath,
            message: `JavaScript 语法错误: ${e.message}`
          });
          return false;
        }
      } else if (lang === 'json') {
        try {
          JSON.parse(code);
        } catch (e) {
          this.errors.push({
            file: example.relativePath,
            message: `JSON 语法错误: ${e.message}`
          });
          return false;
        }
      }
    }

    return true;
  }

  generateReport() {
    console.log('📊 验证报告\n');
    console.log('━'.repeat(60));
    console.log(`总示例数: ${this.stats.total}`);
    console.log(`有效示例: ${this.stats.valid} ✓`);
    console.log(`无效示例: ${this.stats.invalid} ✗`);
    console.log('━'.repeat(60));

    if (this.errors.length > 0) {
      console.log('\n❌ 错误:\n');
      for (const error of this.errors) {
        console.log(`  [${error.file}]`);
        console.log(`  ${error.message}\n`);
      }
    }

    if (this.warnings.length > 0) {
      console.log('\n⚠️  警告:\n');
      for (const warning of this.warnings) {
        console.log(`  [${warning.file}]`);
        console.log(`  ${warning.message}\n`);
      }
    }

    if (this.errors.length === 0) {
      console.log('\n✅ 所有 API 示例验证通过！\n');
    } else {
      console.log('\n❌ 存在验证错误，请修复后重新验证。\n');
    }
  }
}

// 运行验证
const validator = new ExampleValidator();
validator.validate().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('验证失败:', error);
  process.exit(1);
});