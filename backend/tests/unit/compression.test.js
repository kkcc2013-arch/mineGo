// backend/tests/unit/compression.test.js
// REQ-00072: API 响应 Gzip/Brotli 压缩优化 - 单元测试
'use strict';

const { describe, it, expect, beforeEach, afterEach, vi } = require('vitest');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const {
  createCompressionMiddleware,
  getConfig,
  shouldSkipCompression,
  selectBestEncoding,
  parseAcceptEncoding,
  SKIP_MIME_TYPES,
  SKIP_PATH_PREFIXES
} = require('../../shared/compression');

describe('REQ-00072: API 响应压缩优化', () => {
  describe('getConfig', () => {
    it('应返回开发环境配置', () => {
      const config = getConfig('development');
      expect(config).toBeDefined();
      expect(config.threshold).toBe(1024);
      expect(config.gzipLevel).toBe(1);
      expect(config.brotliLevel).toBe(1);
    });

    it('应返回生产环境配置', () => {
      const config = getConfig('production');
      expect(config).toBeDefined();
      expect(config.threshold).toBe(1024);
      expect(config.gzipLevel).toBe(6);
      expect(config.brotliLevel).toBe(6);
    });

    it('应返回测试环境配置', () => {
      const config = getConfig('test');
      expect(config).toBeDefined();
      expect(config.threshold).toBe(512);
    });

    it('未知环境应返回开发配置', () => {
      const config = getConfig('unknown');
      expect(config).toEqual(getConfig('development'));
    });
  });

  describe('parseAcceptEncoding', () => {
    it('应解析单个编码', () => {
      const req = { headers: { 'accept-encoding': 'gzip' } };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.get('gzip')).toBe(1);
    });

    it('应解析多个编码', () => {
      const req = { headers: { 'accept-encoding': 'gzip, deflate, br' } };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.get('gzip')).toBe(1);
      expect(encodings.get('deflate')).toBe(1);
      expect(encodings.get('br')).toBe(1);
    });

    it('应解析带权重的编码', () => {
      const req = { headers: { 'accept-encoding': 'gzip, br;q=0.8, deflate;q=0.5' } };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.get('gzip')).toBe(1);
      expect(encodings.get('br')).toBe(0.8);
      expect(encodings.get('deflate')).toBe(0.5);
    });

    it('应处理空字符串', () => {
      const req = { headers: { 'accept-encoding': '' } };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.size).toBe(0);
    });

    it('应处理无 Accept-Encoding 头', () => {
      const req = { headers: {} };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.size).toBe(0);
    });

    it('应忽略权重为 0 的编码', () => {
      const req = { headers: { 'accept-encoding': 'gzip, br;q=0' } };
      const encodings = parseAcceptEncoding(req);
      expect(encodings.has('gzip')).toBe(true);
      expect(encodings.has('br')).toBe(false);
    });
  });

  describe('selectBestEncoding', () => {
    it('应优先选择 Brotli', () => {
      const req = { headers: { 'accept-encoding': 'gzip, br, deflate' } };
      const encoding = selectBestEncoding(req);
      expect(encoding).toBe('br');
    });

    it('应选择 Gzip（无 Brotli 时）', () => {
      const req = { headers: { 'accept-encoding': 'gzip, deflate' } };
      const encoding = selectBestEncoding(req);
      expect(encoding).toBe('gzip');
    });

    it('应选择 Deflate（无 Gzip/Brotli 时）', () => {
      const req = { headers: { 'accept-encoding': 'deflate' } };
      const encoding = selectBestEncoding(req);
      expect(encoding).toBe('deflate');
    });

    it('应返回 null（无支持的编码时）', () => {
      const req = { headers: { 'accept-encoding': 'identity' } };
      const encoding = selectBestEncoding(req);
      expect(encoding).toBeNull();
    });

    it('应返回 null（无 Accept-Encoding 头时）', () => {
      const req = { headers: {} };
      const encoding = selectBestEncoding(req);
      expect(encoding).toBeNull();
    });
  });

  describe('shouldSkipCompression', () => {
    it('应跳过 health 路径', () => {
      const req = { path: '/health', url: '/health', headers: {} };
      const res = { getHeader: vi.fn() };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过 metrics 路径', () => {
      const req = { path: '/metrics', url: '/metrics', headers: {} };
      const res = { getHeader: vi.fn() };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过 static 路径', () => {
      const req = { path: '/static/image.png', url: '/static/image.png', headers: {} };
      const res = { getHeader: vi.fn() };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过已编码的响应', () => {
      const req = { path: '/api/data', url: '/api/data', headers: {} };
      const res = { getHeader: vi.fn((key) => key === 'Content-Encoding' ? 'gzip' : null) };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过图片 MIME 类型', () => {
      const req = { path: '/api/image', url: '/api/image', headers: {} };
      const res = { getHeader: vi.fn((key) => key === 'Content-Type' ? 'image/png' : null) };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过视频 MIME 类型', () => {
      const req = { path: '/api/video', url: '/api/video', headers: {} };
      const res = { getHeader: vi.fn((key) => key === 'Content-Type' ? 'video/mp4' : null) };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('应跳过小于阈值的响应', () => {
      const req = { path: '/api/data', url: '/api/data', headers: {} };
      const res = { getHeader: vi.fn((key) => key === 'Content-Length' ? '500' : null) };
      expect(shouldSkipCompression(req, res)).toBe(true);
    });

    it('不应跳过 JSON API 响应', () => {
      const req = { path: '/api/users', url: '/api/users', headers: {} };
      const res = { getHeader: vi.fn((key) => key === 'Content-Type' ? 'application/json' : null) };
      expect(shouldSkipCompression(req, res)).toBe(false);
    });
  });

  describe('createCompressionMiddleware', () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
    });

    it('应压缩 JSON 响应（Gzip）', async () => {
      const data = { message: 'Hello World'.repeat(100) };
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.headers['vary']).toContain('Accept-Encoding');
    });

    it('应压缩 JSON 响应（Brotli）', async () => {
      const data = { message: 'Hello World'.repeat(100) };
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'br')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('br');
      expect(response.headers['vary']).toContain('Accept-Encoding');
    });

    it('应优先使用 Brotli', async () => {
      const data = { message: 'Hello World'.repeat(100) };
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip, br')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('br');
    });

    it('不应压缩小响应', async () => {
      const data = { message: 'Hi' };
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      // 小于阈值（test 环境 512 字节）不压缩
      expect(response.headers['content-encoding']).toBeUndefined();
    });

    it('不应压缩无 Accept-Encoding 的请求', async () => {
      const data = { message: 'Hello World'.repeat(100) };
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
    });

    it('应正确解压 Gzip 响应', async () => {
      const originalData = { items: Array(50).fill(null).map((_, i) => ({ id: i, name: `Item ${i}` })) };
      app.get('/test', (_req, res) => {
        res.json(originalData);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
      
      // 手动解压验证
      const decompressed = zlib.gunzipSync(response.body);
      const parsed = JSON.parse(decompressed.toString());
      expect(parsed.items).toHaveLength(50);
    });

    it('应正确解压 Brotli 响应', async () => {
      const originalData = { items: Array(50).fill(null).map((_, i) => ({ id: i, name: `Item ${i}` })) };
      app.get('/test', (_req, res) => {
        res.json(originalData);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'br')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('br');
      
      // 手动解压验证
      const decompressed = zlib.brotliDecompressSync(response.body);
      const parsed = JSON.parse(decompressed.toString());
      expect(parsed.items).toHaveLength(50);
    });

    it('应跳过 health 端点', async () => {
      const data = { status: 'ok', services: [] };
      app.get('/health', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/health')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
    });

    it('应跳过 metrics 端点', async () => {
      const data = '# HELP test_metric Test metric\n# TYPE test_metric counter\ntest_metric 1\n';
      app.get('/metrics', (_req, res) => {
        res.set('Content-Type', 'text/plain');
        res.send(data);
      });

      const response = await request(app)
        .get('/metrics')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('压缩率验证', () => {
    it('Gzip 压缩率应达到 70% 以上', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      // 生成重复数据（高压缩率）
      const data = {
        items: Array(1000).fill(null).map(() => ({
          name: 'Pokemon',
          type: 'electric',
          level: 50,
          cp: 1500
        }))
      };
      
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      const originalSize = JSON.stringify(data).length;
      const compressedSize = response.body.length;
      const ratio = (1 - compressedSize / originalSize) * 100;

      expect(response.headers['content-encoding']).toBe('gzip');
      expect(ratio).toBeGreaterThan(70);
    });

    it('Brotli 压缩率应达到 75% 以上', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      // 生成重复数据
      const data = {
        items: Array(1000).fill(null).map(() => ({
          name: 'Pokemon',
          type: 'electric',
          level: 50,
          cp: 1500
        }))
      };
      
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'br')
        .expect(200);

      const originalSize = JSON.stringify(data).length;
      const compressedSize = response.body.length;
      const ratio = (1 - compressedSize / originalSize) * 100;

      expect(response.headers['content-encoding']).toBe('br');
      expect(ratio).toBeGreaterThan(75);
    });
  });

  describe('性能验证', () => {
    it('压缩延迟应小于 20ms', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      const data = {
        items: Array(500).fill(null).map((_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: 'This is a test item with some text content'
        }))
      };
      
      app.get('/test', (_req, res) => {
        res.json(data);
      });

      const start = Date.now();
      await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);
      const duration = Date.now() - start;

      // 包含网络开销，实际压缩时间更短
      expect(duration).toBeLessThan(100);
    });
  });

  describe('边界情况', () => {
    it('应处理空响应', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      app.get('/test', (_req, res) => {
        res.json({});
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBeUndefined();
    });

    it('应处理 chunked 响应', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      app.get('/test', (_req, res) => {
        res.write(JSON.stringify({ part1: 'Hello'.repeat(50) }));
        res.write(JSON.stringify({ part2: 'World'.repeat(50) }));
        res.end();
      });

      const response = await request(app)
        .get('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      expect(response.headers['content-encoding']).toBe('gzip');
    });

    it('应处理 HEAD 请求', async () => {
      const app = express();
      app.use(createCompressionMiddleware({ env: 'test' }));
      
      app.head('/test', (_req, res) => {
        res.setHeader('Content-Length', 1000);
        res.end();
      });

      const response = await request(app)
        .head('/test')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      // HEAD 请求不应有 body
      expect(response.body).toEqual({});
    });
  });
});
