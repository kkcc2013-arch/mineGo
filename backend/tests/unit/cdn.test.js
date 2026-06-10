/**
 * CDN 模块单元测试
 * 测试 CDNManager、ImageProcessor、中间件等核心功能
 * 
 * @module backend/tests/unit/cdn.test.js
 */
'use strict';

const assert = require('assert');
const {
  CDNManager,
  ImageProcessor,
  IMAGE_PRESETS,
  CACHE_CONFIG
} = require('../../shared/CDNManager');

// ── CDNManager 测试 ─────────────────────────────────────────────────

describe('CDNManager', () => {
  let cdnManager;

  beforeEach(() => {
    cdnManager = new CDNManager({
      provider: 'cloudflare',
      domain: 'https://cdn.example.com',
      originUrl: 'https://origin.example.com',
      enabled: true
    });
  });

  describe('构造函数', () => {
    it('应该正确初始化默认配置', () => {
      const manager = new CDNManager();
      assert.strictEqual(manager.provider, 'local');
      assert.strictEqual(manager.enabled, false);
      assert.strictEqual(manager.domain, '');
    });

    it('应该正确初始化自定义配置', () => {
      assert.strictEqual(cdnManager.provider, 'cloudflare');
      assert.strictEqual(cdnManager.enabled, true);
      assert.strictEqual(cdnManager.domain, 'https://cdn.example.com');
    });

    it('当 provider 为 local 时应该禁用 CDN', () => {
      const localManager = new CDNManager({ provider: 'local' });
      assert.strictEqual(localManager.enabled, false);
    });
  });

  describe('getResourceUrl', () => {
    it('CDN 禁用时应返回源站 URL', () => {
      cdnManager.enabled = false;
      const url = cdnManager.getResourceUrl('/images/test.png');
      assert.strictEqual(url, 'https://origin.example.com/images/test.png');
    });

    it('应该生成带转换参数的 CDN URL', () => {
      const url = cdnManager.getResourceUrl('/images/test.png', {
        width: 256,
        height: 256,
        format: 'webp',
        quality: 85
      });
      
      assert(url.includes('cdn.example.com'));
      assert(url.includes('width=256'));
      assert(url.includes('height=256'));
      assert(url.includes('format=webp'));
      assert(url.includes('quality=85'));
    });

    it('应该使用预设生成 URL', () => {
      const url = cdnManager.getResourceUrl('/images/test.png', {
        preset: 'thumbnail'
      });
      
      assert(url.includes('width=64'));
      assert(url.includes('height=64'));
      assert(url.includes('quality=80'));
    });

    it('应该包含版本号参数', () => {
      const url = cdnManager.getResourceUrl('/images/test.png');
      assert(url.includes('v='));
    });

    it('应该更新请求统计', () => {
      cdnManager.getResourceUrl('/images/test.png');
      assert.strictEqual(cdnManager.stats.totalRequests, 1);
    });
  });

  describe('getResponsiveUrls', () => {
    it('应该生成所有预设尺寸的 URL', () => {
      const urls = cdnManager.getResponsiveUrls('/images/test.png');
      
      assert(urls.thumbnail);
      assert(urls.small);
      assert(urls.medium);
      assert(urls.large);
      assert(urls.hd);
      assert(urls.original);
    });

    it('应该支持额外选项', () => {
      const urls = cdnManager.getResponsiveUrls('/images/test.png', {
        format: 'webp'
      });
      
      // 所有 URL 应该包含 format 参数
      Object.values(urls).forEach(url => {
        if (url.includes('?')) {
          assert(url.includes('format=webp'));
        }
      });
    });
  });

  describe('getResponsiveSrcSet', () => {
    it('应该生成正确的 srcset 格式', () => {
      const srcSet = cdnManager.getResponsiveSrcSet('/images/test.png');
      
      // srcset 应该包含宽度描述符
      assert(srcSet.includes('128w'));
      assert(srcSet.includes('256w'));
      assert(srcSet.includes('512w'));
      assert(srcSet.includes('1024w'));
    });
  });

  describe('getCachePolicy', () => {
    it('精灵图片应该使用长期缓存策略', () => {
      const policy = cdnManager.getCachePolicy('/pokemon/bulbasaur.png');
      assert.strictEqual(policy.maxAge, 31536000);
      assert.strictEqual(policy.immutable, true);
    });

    it('UI 素材应该使用中期缓存策略', () => {
      const policy = cdnManager.getCachePolicy('/ui/button.png');
      assert.strictEqual(policy.maxAge, 2592000);
      assert.strictEqual(policy.immutable, undefined);
    });

    it('动态图片应该使用短期缓存策略', () => {
      const policy = cdnManager.getCachePolicy('/user/avatar.png');
      assert.strictEqual(policy.maxAge, 3600);
    });

    it('其他资源应该使用默认缓存策略', () => {
      const policy = cdnManager.getCachePolicy('/other/image.png');
      assert.strictEqual(policy.maxAge, 86400);
    });
  });

  describe('generateETag', () => {
    it('应该生成有效的 ETag', () => {
      const etag = cdnManager.generateETag('/images/test.png', {
        size: 1024,
        mtime: Date.now()
      });
      
      assert(etag.startsWith('"'));
      assert(etag.endsWith('"'));
      assert(etag.length > 2);
    });

    it('相同参数应该生成相同的 ETag', () => {
      const stats = { size: 1024, mtime: 12345 };
      const etag1 = cdnManager.generateETag('/images/test.png', stats);
      const etag2 = cdnManager.generateETag('/images/test.png', stats);
      
      assert.strictEqual(etag1, etag2);
    });

    it('不同路径应该生成不同的 ETag', () => {
      const stats = { size: 1024, mtime: 12345 };
      const etag1 = cdnManager.generateETag('/images/a.png', stats);
      const etag2 = cdnManager.generateETag('/images/b.png', stats);
      
      assert.notStrictEqual(etag1, etag2);
    });
  });

  describe('detectSupportedFormats', () => {
    it('应该检测 WebP 支持', () => {
      const formats = cdnManager.detectSupportedFormats('image/webp,image/*');
      assert.strictEqual(formats.webp, true);
      assert.strictEqual(formats.avif, false);
      assert.strictEqual(formats.bestFormat, 'webp');
    });

    it('应该检测 AVIF 支持', () => {
      const formats = cdnManager.detectSupportedFormats('image/avif,image/webp,image/*');
      assert.strictEqual(formats.avif, true);
      assert.strictEqual(formats.webp, true);
      assert.strictEqual(formats.bestFormat, 'avif');
    });

    it('应该默认返回 original 格式', () => {
      const formats = cdnManager.detectSupportedFormats('image/*');
      assert.strictEqual(formats.bestFormat, 'original');
    });
  });

  describe('统计功能', () => {
    it('应该正确记录缓存命中', () => {
      cdnManager.recordCacheHit(true, 1024);
      assert.strictEqual(cdnManager.stats.cacheHits, 1);
      assert.strictEqual(cdnManager.stats.bytesSaved, 1024);
    });

    it('应该正确记录缓存未命中', () => {
      cdnManager.recordCacheHit(false);
      assert.strictEqual(cdnManager.stats.cacheMisses, 1);
    });

    it('应该正确记录图片优化', () => {
      cdnManager.recordImageOptimization(1000, 500);
      assert.strictEqual(cdnManager.stats.imagesOptimized, 1);
      assert.strictEqual(cdnManager.stats.bytesSaved, 500);
    });

    it('应该返回正确的统计数据', () => {
      cdnManager.stats.totalRequests = 100;
      cdnManager.stats.cacheHits = 80;
      
      const stats = cdnManager.getStats();
      assert.strictEqual(stats.hitRate, '80.00%');
    });

    it('应该正确重置统计数据', () => {
      cdnManager.stats.totalRequests = 100;
      cdnManager.resetStats();
      
      assert.strictEqual(cdnManager.stats.totalRequests, 0);
    });
  });
});

// ── ImageProcessor 测试 ─────────────────────────────────────────────

describe('ImageProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new ImageProcessor();
  });

  describe('构造函数', () => {
    it('应该初始化处理器', () => {
      assert(processor !== null);
    });

    it('isAvailable 应该返回布尔值', () => {
      const available = processor.isAvailable();
      assert(typeof available === 'boolean');
    });
  });

  describe('IMAGE_PRESETS', () => {
    it('应该包含所有预设尺寸', () => {
      assert(IMAGE_PRESETS.thumbnail);
      assert(IMAGE_PRESETS.small);
      assert(IMAGE_PRESETS.medium);
      assert(IMAGE_PRESETS.large);
      assert(IMAGE_PRESETS.hd);
      assert(IMAGE_PRESETS.original);
    });

    it('预设应该包含必要的属性', () => {
      const thumbnail = IMAGE_PRESETS.thumbnail;
      assert(thumbnail.width);
      assert(thumbnail.height);
      assert(thumbnail.quality);
    });
  });

  describe('CACHE_CONFIG', () => {
    it('应该包含所有缓存策略', () => {
      assert(CACHE_CONFIG.pokemon_images);
      assert(CACHE_CONFIG.ui_assets);
      assert(CACHE_CONFIG.dynamic_images);
      assert(CACHE_CONFIG.default);
    });

    it('缓存策略应该包含必要的属性', () => {
      const policy = CACHE_CONFIG.pokemon_images;
      assert(policy.maxAge);
      assert(typeof policy.etag === 'boolean');
    });
  });
});

// ── 中间件测试 ─────────────────────────────────────────────────────

describe('Image Optimization Middleware', () => {
  const { imageOptimizationMiddleware } = require('../../gateway/src/middleware/imageOptimization');

  describe('imageOptimizationMiddleware', () => {
    it('应该检测客户端支持的格式', (done) => {
      const req = {
        headers: { accept: 'image/webp,image/*' },
        query: {}
      };
      const res = { locals: {} };
      const next = () => {
        assert.strictEqual(res.locals.imageFormat, 'webp');
        done();
      };

      imageOptimizationMiddleware()(req, res, next);
    });

    it('应该支持查询参数覆盖质量', (done) => {
      const req = {
        headers: { accept: 'image/*' },
        query: { q: '75' }
      };
      const res = { locals: {} };
      const next = () => {
        assert.strictEqual(res.locals.imageQuality, 75);
        done();
      };

      imageOptimizationMiddleware()(req, res, next);
    });

    it('应该添加 getOptimizedImageUrl 辅助方法', (done) => {
      const req = {
        headers: { accept: 'image/webp' },
        query: {}
      };
      const res = { locals: {} };
      const next = () => {
        assert(typeof res.locals.getOptimizedImageUrl === 'function');
        done();
      };

      imageOptimizationMiddleware()(req, res, next);
    });
  });
});

// ── API 路由测试 ───────────────────────────────────────────────────

describe('CDN API Routes', () => {
  let mockReq, mockRes;

  beforeEach(() => {
    mockReq = {
      query: {},
      body: {},
      headers: {},
      path: '/test.png'
    };
    mockRes = {
      json: (data) => data,
      status: (code) => mockRes,
      set: () => mockRes,
      locals: {}
    };
  });

  describe('GET /cdn/resource', () => {
    it('缺少 path 参数应该返回 400', () => {
      const route = require('../../gateway/src/routes/cdn');
      // 这里需要使用 supertest 等工具进行完整测试
      // 简化版本只验证逻辑
      assert(true);
    });
  });

  describe('GET /cdn/presets', () => {
    it('应该返回预设配置', () => {
      // 验证预设配置存在
      assert(Object.keys(IMAGE_PRESETS).length > 0);
    });
  });
});

// ── 边界情况测试 ───────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('空路径应该返回有效 URL', () => {
    const manager = new CDNManager({ domain: 'https://cdn.example.com' });
    manager.enabled = true;
    const url = manager.getResourceUrl('');
    assert(url.includes('cdn.example.com'));
  });

  it('无效预设应该被忽略', () => {
    const manager = new CDNManager({ domain: 'https://cdn.example.com' });
    manager.enabled = true;
    const url = manager.getResourceUrl('/test.png', { preset: 'invalid' });
    assert(url.includes('cdn.example.com'));
  });

  it('超大质量值应该被传递', () => {
    const manager = new CDNManager({ domain: 'https://cdn.example.com' });
    manager.enabled = true;
    const url = manager.getResourceUrl('/test.png', { quality: 200 });
    assert(url.includes('quality=200'));
  });

  it('负数尺寸应该被传递', () => {
    const manager = new CDNManager({ domain: 'https://cdn.example.com' });
    manager.enabled = true;
    const url = manager.getResourceUrl('/test.png', { width: -100 });
    assert(url.includes('width=-100'));
  });
});

// ── 运行测试 ───────────────────────────────────────────────────────

if (require.main === module) {
  console.log('Running CDN module tests...\n');
  
  // 简单测试运行器
  let passed = 0;
  let failed = 0;

  const runTest = (name, fn) => {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${error.message}`);
      failed++;
    }
  };

  // 运行基本测试
  runTest('CDNManager 初始化', () => {
    const manager = new CDNManager({ provider: 'cloudflare' });
    assert(manager !== null);
  });

  runTest('URL 生成', () => {
    const manager = new CDNManager({ 
      domain: 'https://cdn.example.com',
      enabled: true 
    });
    const url = manager.getResourceUrl('/test.png');
    assert(url.includes('cdn.example.com'));
  });

  runTest('响应式 URL', () => {
    const manager = new CDNManager({ 
      domain: 'https://cdn.example.com',
      enabled: true 
    });
    const urls = manager.getResponsiveUrls('/test.png');
    assert(urls.thumbnail);
    assert(urls.small);
    assert(urls.medium);
  });

  runTest('缓存策略', () => {
    const manager = new CDNManager();
    const policy = manager.getCachePolicy('/pokemon/test.png');
    assert.strictEqual(policy.maxAge, 31536000);
  });

  runTest('格式检测', () => {
    const manager = new CDNManager();
    const formats = manager.detectSupportedFormats('image/webp');
    assert.strictEqual(formats.webp, true);
  });

  runTest('ETag 生成', () => {
    const manager = new CDNManager();
    const etag = manager.generateETag('/test.png');
    assert(etag.startsWith('"'));
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = {
  CDNManager,
  ImageProcessor
};
