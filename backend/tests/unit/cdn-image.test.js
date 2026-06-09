/**
 * CDN Manager and Image Processor Tests
 * 
 * 测试 CDN 管理器和图片处理器的核心功能
 */

'use strict';

const assert = require('assert');
const { CDNManager, PROVIDERS } = require('../../../shared/CDNManager');
const { ImageProcessor, IMAGE_PRESETS, FORMAT_CONFIG } = require('../../../shared/ImageProcessor');

// ============ CDN Manager Tests ============

describe('CDNManager', () => {
  let cdn;

  beforeEach(() => {
    cdn = new CDNManager({
      provider: 'cloudflare',
      domain: 'https://cdn.test.com',
      originUrl: 'https://origin.test.com',
      enabled: true
    });
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const defaultCdn = new CDNManager({
        provider: 'cloudflare',
        domain: 'https://cdn.test.com'
      });
      
      assert.strictEqual(defaultCdn.provider, 'cloudflare');
      assert.strictEqual(defaultCdn.enabled, true);
      assert.strictEqual(defaultCdn.originUrl, '');
    });

    it('should throw error for unsupported provider', () => {
      assert.throws(() => {
        new CDNManager({
          provider: 'invalid-provider',
          domain: 'https://cdn.test.com'
        });
      }, /Unsupported CDN provider/);
    });

    it('should respect enabled=false', () => {
      const disabledCdn = new CDNManager({
        provider: 'cloudflare',
        domain: 'https://cdn.test.com',
        enabled: false
      });
      
      assert.strictEqual(disabledCdn.enabled, false);
    });
  });

  describe('getResourceUrl', () => {
    it('should generate basic CDN URL', () => {
      const url = cdn.getResourceUrl('/pokemon/25.png');
      
      assert.strictEqual(url, 'https://cdn.test.com/pokemon/25.png');
    });

    it('should normalize path without leading slash', () => {
      const url = cdn.getResourceUrl('pokemon/25.png');
      
      assert.strictEqual(url, 'https://cdn.test.com/pokemon/25.png');
    });

    it('should add optimization parameters', () => {
      const url = cdn.getResourceUrl('/pokemon/25.png', {
        width: 128,
        height: 128,
        format: 'webp',
        quality: 85
      });
      
      assert.ok(url.includes('w=128'));
      assert.ok(url.includes('h=128'));
      assert.ok(url.includes('f=webp'));
      assert.ok(url.includes('q=85'));
    });

    it('should clamp dimensions to max 2048', () => {
      const url = cdn.getResourceUrl('/pokemon/25.png', {
        width: 3000,
        height: 3000
      });
      
      assert.ok(url.includes('w=2048'));
      assert.ok(url.includes('h=2048'));
    });

    it('should add cache bust parameter', () => {
      const url = cdn.getResourceUrl('/pokemon/25.png', {
        cacheBust: true
      });
      
      assert.ok(url.includes('v='));
    });

    it('should return fallback URL when CDN disabled', () => {
      const disabledCdn = new CDNManager({
        provider: 'cloudflare',
        domain: 'https://cdn.test.com',
        originUrl: 'https://origin.test.com',
        enabled: false
      });
      
      const url = disabledCdn.getResourceUrl('/pokemon/25.png');
      
      assert.strictEqual(url, 'https://origin.test.com/pokemon/25.png');
    });
  });

  describe('getResponsiveUrls', () => {
    it('should generate URLs for all preset sizes', () => {
      const urls = cdn.getResponsiveUrls('/pokemon/25.png');
      
      assert.ok(urls.thumbnail);
      assert.ok(urls.small);
      assert.ok(urls.medium);
      assert.ok(urls.large);
      assert.ok(urls.original);
      
      assert.ok(urls.thumbnail.includes('w=64'));
      assert.ok(urls.small.includes('w=128'));
      assert.ok(urls.medium.includes('w=256'));
      assert.ok(urls.large.includes('w=512'));
    });

    it('should include format option in all URLs', () => {
      const urls = cdn.getResponsiveUrls('/pokemon/25.png', { format: 'webp' });
      
      Object.values(urls).forEach(url => {
        assert.ok(url.includes('f=webp'));
      });
    });
  });

  describe('generateSrcset', () => {
    it('should generate valid srcset string', () => {
      const srcset = cdn.generateSrcset('/pokemon/25.png');
      
      assert.ok(srcset.includes('64w'));
      assert.ok(srcset.includes('128w'));
      assert.ok(srcset.includes('256w'));
      assert.ok(srcset.includes('512w'));
    });

    it('should include format in srcset URLs', () => {
      const srcset = cdn.generateSrcset('/pokemon/25.png', { format: 'webp' });
      
      assert.ok(srcset.includes('f=webp'));
    });
  });

  describe('setResourceVersion', () => {
    it('should set version for resource', () => {
      cdn.setResourceVersion('/pokemon/25.png', 'v1.0.0');
      
      const url = cdn.getResourceUrl('/pokemon/25.png');
      
      assert.ok(url.includes('v=v1.0.0'));
    });

    it('should auto-generate version when not provided', () => {
      cdn.setResourceVersion('/pokemon/25.png');
      
      const url = cdn.getResourceUrl('/pokemon/25.png');
      
      assert.ok(url.includes('v='));
      assert.ok(url.match(/v=[a-f0-9]{8}/));
    });
  });

  describe('getStats', () => {
    it('should return stats object', () => {
      const stats = cdn.getStats();
      
      assert.ok('requests' in stats);
      assert.ok('cacheHits' in stats);
      assert.ok('cacheMisses' in stats);
      assert.ok('bytesTransferred' in stats);
      assert.ok('errors' in stats);
      assert.ok('cacheHitRate' in stats);
      assert.strictEqual(stats.provider, 'cloudflare');
      assert.strictEqual(stats.enabled, true);
    });

    it('should calculate cache hit rate', () => {
      cdn.recordRequest({ cacheHit: true });
      cdn.recordRequest({ cacheHit: true });
      cdn.recordRequest({ cacheHit: false });
      
      const stats = cdn.getStats();
      
      assert.strictEqual(stats.requests, 3);
      assert.strictEqual(stats.cacheHits, 2);
      assert.strictEqual(stats.cacheMisses, 1);
      assert.strictEqual(stats.cacheHitRate, '66.67%');
    });
  });

  describe('recordRequest', () => {
    it('should increment request counter', () => {
      const initialStats = cdn.getStats();
      
      cdn.recordRequest({ cacheHit: true });
      
      const newStats = cdn.getStats();
      assert.strictEqual(newStats.requests, initialStats.requests + 1);
    });

    it('should track bytes transferred', () => {
      cdn.recordRequest({ bytes: 1024 });
      cdn.recordRequest({ bytes: 2048 });
      
      const stats = cdn.getStats();
      assert.strictEqual(stats.bytesTransferred, 3072);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status when enabled', () => {
      const health = cdn.healthCheck();
      
      assert.strictEqual(health.status, 'healthy');
      assert.strictEqual(health.provider, 'cloudflare');
    });

    it('should return disabled status when not enabled', () => {
      const disabledCdn = new CDNManager({
        provider: 'cloudflare',
        domain: 'https://cdn.test.com',
        enabled: false
      });
      
      const health = disabledCdn.healthCheck();
      
      assert.strictEqual(health.status, 'disabled');
    });
  });

  describe('isFormatSupported', () => {
    it('should return true for supported formats', () => {
      assert.strictEqual(cdn.isFormatSupported('webp'), true);
      assert.strictEqual(cdn.isFormatSupported('avif'), true);
      assert.strictEqual(cdn.isFormatSupported('jpeg'), true);
    });

    it('should return false for unsupported formats', () => {
      assert.strictEqual(cdn.isFormatSupported('bmp'), false);
      assert.strictEqual(cdn.isFormatSupported('tiff'), false);
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types', () => {
      assert.strictEqual(cdn.getMimeType('webp'), 'image/webp');
      assert.strictEqual(cdn.getMimeType('avif'), 'image/avif');
      assert.strictEqual(cdn.getMimeType('jpeg'), 'image/jpeg');
      assert.strictEqual(cdn.getMimeType('png'), 'image/png');
    });

    it('should return default MIME type for unknown format', () => {
      assert.strictEqual(cdn.getMimeType('unknown'), 'application/octet-stream');
    });
  });
});

// ============ Image Processor Tests ============

describe('ImageProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new ImageProcessor({
      outputDir: './test-output',
      webpEnabled: true,
      avifEnabled: true
    });
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const defaultProcessor = new ImageProcessor();
      
      assert.strictEqual(defaultProcessor.defaultQuality, 85);
      assert.strictEqual(defaultProcessor.webpEnabled, true);
      assert.strictEqual(defaultProcessor.avifEnabled, true);
    });

    it('should respect config options', () => {
      const customProcessor = new ImageProcessor({
        outputDir: './custom-output',
        defaultQuality: 90,
        webpEnabled: false,
        avifEnabled: false
      });
      
      assert.strictEqual(customProcessor.outputDir, './custom-output');
      assert.strictEqual(customProcessor.defaultQuality, 90);
      assert.strictEqual(customProcessor.webpEnabled, false);
      assert.strictEqual(customProcessor.avifEnabled, false);
    });
  });

  describe('generateResponsiveImages', () => {
    it('should generate images for all presets', async () => {
      const result = await processor.generateResponsiveImages('/test/pokemon.png');
      
      assert.ok(result.images);
      assert.ok(result.images.thumbnail);
      assert.ok(result.images.small);
      assert.ok(result.images.medium);
      assert.ok(result.images.large);
      assert.ok(result.meta.totalFiles > 0);
    });

    it('should generate only specified presets', async () => {
      const result = await processor.generateResponsiveImages('/test/pokemon.png', {
        presets: ['thumbnail', 'small']
      });
      
      assert.ok(result.images.thumbnail);
      assert.ok(result.images.small);
      assert.strictEqual(result.images.medium, undefined);
      assert.strictEqual(result.images.large, undefined);
    });

    it('should generate only enabled formats', async () => {
      const result = await processor.generateResponsiveImages('/test/pokemon.png', {
        formats: ['webp']
      });
      
      assert.ok(result.images.thumbnail.webp);
      assert.strictEqual(result.images.thumbnail.avif, undefined);
    });

    it('should include metadata', async () => {
      const result = await processor.generateResponsiveImages('/test/pokemon.png');
      
      assert.ok(result.meta.generatedAt);
      assert.ok(result.meta.totalFiles > 0);
      assert.ok(result.meta.totalBytes >= 0);
    });
  });

  describe('convert', () => {
    it('should convert to specified format', async () => {
      const result = await processor.convert('/test/pokemon.png', {
        format: 'webp',
        quality: 90
      });
      
      assert.strictEqual(result.format, 'webp');
      assert.strictEqual(result.quality, 90);
      assert.ok(result.outputPath.includes('.webp'));
    });

    it('should use default quality', async () => {
      const result = await processor.convert('/test/pokemon.png', {
        format: 'webp'
      });
      
      assert.strictEqual(result.quality, 85);
    });
  });

  describe('compress', () => {
    it('should compress with options', async () => {
      const result = await processor.compress('/test/pokemon.png', {
        quality: 80,
        maxWidth: 512
      });
      
      assert.ok(result);
      assert.strictEqual(result.quality, 80);
    });
  });

  describe('getImageInfo', () => {
    it('should return image information', async () => {
      const info = await processor.getImageInfo('/test/pokemon.png');
      
      assert.ok(info.path);
      assert.ok(info.format);
      assert.ok(info.mimeType);
      assert.ok(info.hash);
    });
  });

  describe('batchProcess', () => {
    it('should process multiple images', async () => {
      const results = await processor.batchProcess([
        '/test/pokemon1.png',
        '/test/pokemon2.png'
      ]);
      
      assert.strictEqual(results.length, 2);
      assert.ok(results[0].images);
      assert.ok(results[1].images);
    });

    it('should handle errors in batch', async () => {
      const results = await processor.batchProcess([
        '/test/pokemon.png',
        null, // 无效路径
        '/test/pokemon2.png'
      ]);
      
      assert.strictEqual(results.length, 3);
      assert.ok(results[0].images);
      assert.ok(results[1].error);
      assert.ok(results[2].images);
    });
  });

  describe('calculateSavings', () => {
    it('should calculate optimization savings', () => {
      const result = processor.calculateSavings(
        { size: 100000 },
        { size: 50000 }
      );
      
      assert.strictEqual(result.originalSize, 100000);
      assert.strictEqual(result.optimizedSize, 50000);
      assert.strictEqual(result.savedBytes, 50000);
      assert.strictEqual(result.savedPercentage, '50.00%');
    });

    it('should handle zero savings', () => {
      const result = processor.calculateSavings(
        { size: 50000 },
        { size: 60000 }
      );
      
      assert.strictEqual(result.savedBytes, 0);
      assert.strictEqual(result.savedPercentage, '0.00%');
    });
  });

  describe('getStats', () => {
    it('should return stats object', () => {
      const stats = processor.getStats();
      
      assert.ok('processed' in stats);
      assert.ok('bytesSaved' in stats);
      assert.ok('errors' in stats);
      assert.ok('byFormat' in stats);
      assert.strictEqual(stats.webpEnabled, true);
      assert.strictEqual(stats.avifEnabled, true);
    });
  });

  describe('static methods', () => {
    it('should return presets', () => {
      const presets = ImageProcessor.getPresets();
      
      assert.ok(presets.thumbnail);
      assert.ok(presets.small);
      assert.ok(presets.medium);
      assert.ok(presets.large);
    });

    it('should return format config', () => {
      const config = ImageProcessor.getFormatConfig();
      
      assert.ok(config.webp);
      assert.ok(config.avif);
      assert.ok(config.jpeg);
      assert.ok(config.png);
    });
  });
});

// ============ Integration Tests ============

describe('CDN + ImageProcessor Integration', () => {
  let cdn;
  let processor;

  beforeEach(() => {
    cdn = new CDNManager({
      provider: 'cloudflare',
      domain: 'https://cdn.test.com',
      enabled: true
    });
    
    processor = new ImageProcessor({
      webpEnabled: true,
      avifEnabled: true
    });
  });

  it('should work together for responsive images', async () => {
    // 生成响应式图片
    const processed = await processor.generateResponsiveImages('/pokemon/25.png');
    
    // 获取 CDN URL
    const urls = cdn.getResponsiveUrls('/pokemon/25.png', { format: 'webp' });
    
    assert.ok(processed.images.thumbnail);
    assert.ok(urls.thumbnail);
    assert.ok(urls.thumbnail.includes('cdn.test.com'));
  });

  it('should track optimization stats', async () => {
    // 处理图片
    await processor.generateResponsiveImages('/pokemon/25.png');
    
    // 计算收益
    const savings = processor.calculateSavings(
      { size: 200000 },
      { size: 70000 }
    );
    
    const stats = processor.getStats();
    assert.ok(stats.bytesSaved > 0);
    assert.strictEqual(stats.bytesSaved, 130000);
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}
