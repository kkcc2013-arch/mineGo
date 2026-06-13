// backend/tests/unit/openapi-i18n.test.js
// OpenAPI i18n 单元测试（REQ-00155）
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const yaml = require('js-yaml');

const TRANSLATIONS_DIR = path.join(__dirname, '../../docs/api-spec/openapi/translations');
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

describe('OpenAPI i18n', () => {
  
  describe('翻译文件存在性', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      it(`应该存在 ${lang}.yaml 文件`, async () => {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const exists = await fs.access(filePath).then(() => true).catch(() => false);
        assert.strictEqual(exists, true, `${lang}.yaml 文件不存在`);
      });
    }
  });
  
  describe('YAML 语法验证', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      it(`${lang}.yaml 应该是有效的 YAML`, async () => {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        
        // 不应该抛出异常
        const spec = yaml.load(content);
        assert.ok(spec, 'YAML 解析结果不应为空');
        assert.ok(spec.openapi, '应该有 openapi 字段');
        assert.ok(spec.info, '应该有 info 字段');
      });
    }
  });
  
  describe('OpenAPI 规范结构', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      it(`${lang} 应该有完整的 OpenAPI 结构`, async () => {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        const spec = yaml.load(content);
        
        // 必需字段
        assert.ok(spec.openapi, '应该有 openapi 版本');
        assert.ok(spec.info, '应该有 info 对象');
        assert.ok(spec.info.title, '应该有 title');
        assert.ok(spec.info.description, '应该有 description');
        assert.ok(spec.servers, '应该有 servers 数组');
        assert.ok(spec.tags, '应该有 tags 数组');
        assert.ok(spec.paths, '应该有 paths 对象');
      });
    }
  });
  
  describe('翻译键一致性', () => {
    it('所有语言应该有相同的翻译键', async () => {
      const allKeys = {};
      
      for (const lang of SUPPORTED_LANGUAGES) {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        const spec = yaml.load(content);
        allKeys[lang] = extractKeys(spec);
      }
      
      const baseKeys = allKeys['zh-CN'];
      
      for (const lang of ['en-US', 'ja-JP']) {
        const langKeys = allKeys[lang];
        const missing = baseKeys.filter(k => !langKeys.includes(k));
        const extra = langKeys.filter(k => !baseKeys.includes(k));
        
        // 允许少量差异，但不应该太多
        assert.ok(missing.length <= 5, `${lang} 缺少 ${missing.length} 个键`);
        assert.ok(extra.length <= 5, `${lang} 多出 ${extra.length} 个键`);
      }
    });
  });
  
  describe('API 端点覆盖', () => {
    const expectedPaths = [
      '/auth/register',
      '/auth/login',
      '/auth/refresh',
      '/users/me',
      '/map/nearby',
      '/catch/{wildId}',
      '/pokemon',
      '/gym/{gymId}/battle',
      '/social/friends',
      '/reward/daily',
      '/payment/orders'
    ];
    
    for (const lang of SUPPORTED_LANGUAGES) {
      it(`${lang} 应该包含所有核心 API 端点`, async () => {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        const spec = yaml.load(content);
        
        for (const expectedPath of expectedPaths) {
          assert.ok(spec.paths[expectedPath], `应该有 ${expectedPath} 端点`);
        }
      });
    }
  });
  
  describe('描述完整性', () => {
    it('所有端点应该有 summary 和 description', async () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        const spec = yaml.load(content);
        
        for (const [pathName, methods] of Object.entries(spec.paths)) {
          for (const [method, operation] of Object.entries(methods)) {
            if (!operation || typeof operation !== 'object') continue;
            
            assert.ok(operation.summary, 
              `${lang} ${method.toUpperCase()} ${pathName} 应该有 summary`);
            assert.ok(operation.description, 
              `${lang} ${method.toUpperCase()} ${pathName} 应该有 description`);
          }
        }
      }
    });
  });
  
  describe('错误码范围说明', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      it(`${lang} 应该包含错误码范围说明`, async () => {
        const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
        const content = await fs.readFile(filePath, 'utf-8');
        const spec = yaml.load(content);
        
        assert.ok(spec.info.description.includes('1000'), 
          `${lang} 应该说明错误码范围`);
      });
    }
  });
});

// ── Helper Functions ────────────────────────────────────────────────

function extractKeys(spec, prefix = '') {
  const keys = [];
  
  if (!spec || typeof spec !== 'object') return keys;
  
  for (const [key, value] of Object.entries(spec)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (typeof value === 'string' && (key === 'description' || key === 'summary')) {
      keys.push(fullKey);
    } else if (typeof value === 'object' && value !== null) {
      keys.push(...extractKeys(value, fullKey));
    }
  }
  
  return keys;
}
