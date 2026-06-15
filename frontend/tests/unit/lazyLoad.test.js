// frontend/tests/unit/lazyLoad.test.js
// Unit tests for lazy loading system
'use strict';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LazyLoader, createLazyComponent, lazyLoader } from '../../game-client/src/utils/lazyLoad.js';

describe('LazyLoader', () => {
  let loader;

  beforeEach(() => {
    loader = new LazyLoader();
  });

  describe('load()', () => {
    it('should load a module successfully', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn().mockResolvedValue(mockModule);

      const result = await loader.load('test-chunk', importFn);

      expect(result).toEqual(mockModule.default);
      expect(loader.isLoaded('test-chunk')).toBe(true);
      expect(importFn).toHaveBeenCalledTimes(1);
    });

    it('should return cached module on second load', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn().mockResolvedValue(mockModule);

      await loader.load('test-chunk', importFn);
      const result = await loader.load('test-chunk', importFn);

      expect(result).toEqual(mockModule.default);
      expect(importFn).toHaveBeenCalledTimes(1); // 只调用一次
      expect(loader.metrics.cacheHits).toBe(1);
    });

    it('should handle load error', async () => {
      const error = new Error('Network error');
      const importFn = vi.fn().mockRejectedValue(error);

      await expect(loader.load('test-chunk', importFn)).rejects.toThrow('Network error');
      expect(loader.metrics.errors).toBe(1);
    });

    it('should retry on failure', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn()
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValue(mockModule);

      const result = await loader.load('test-chunk', importFn, { retryCount: 1, retryDelay: 100 });

      expect(result).toEqual(mockModule.default);
      expect(importFn).toHaveBeenCalledTimes(2);
    });

    it('should track loading state', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      let resolveImport;
      const importFn = vi.fn().mockImplementation(() => new Promise(resolve => {
        resolveImport = () => resolve(mockModule);
      }));

      const loadPromise = loader.load('test-chunk', importFn);

      expect(loader.getStatus('test-chunk')).toBe('loading');

      resolveImport();
      await loadPromise;

      expect(loader.getStatus('test-chunk')).toBe('loaded');
    });
  });

  describe('prefetch()', () => {
    it('should add chunk to prefetch queue', () => {
      const importFn = vi.fn();

      loader.prefetch('test-chunk', importFn);

      expect(loader.prefetchQueue.length).toBe(1);
      expect(loader.prefetchQueue[0]).toEqual({ chunkName: 'test-chunk', importFn });
    });

    it('should not add duplicate prefetch', () => {
      const importFn = vi.fn();

      loader.prefetch('test-chunk', importFn);
      loader.prefetch('test-chunk', importFn);

      expect(loader.prefetchQueue.length).toBe(1);
    });
  });

  describe('clearCache()', () => {
    it('should clear specific chunk cache', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn().mockResolvedValue(mockModule);

      await loader.load('test-chunk', importFn);
      loader.clearCache('test-chunk');

      expect(loader.isLoaded('test-chunk')).toBe(false);
    });

    it('should clear all cache', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn().mockResolvedValue(mockModule);

      await loader.load('chunk1', importFn);
      await loader.load('chunk2', importFn);
      loader.clearCache();

      expect(loader.loadedChunks.size).toBe(0);
    });
  });

  describe('getReport()', () => {
    it('should return performance metrics', async () => {
      const mockModule = { default: { name: 'TestComponent' } };
      const importFn = vi.fn().mockResolvedValue(mockModule);

      await loader.load('test-chunk', importFn);
      const report = loader.getReport();

      expect(report.chunksLoaded).toBe(1);
      expect(report.totalLoadTime).toBeGreaterThan(0);
      expect(report.averageLoadTime).toBeGreaterThan(0);
    });
  });
});

describe('createLazyComponent()', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it('should create lazy component class', () => {
    const importFn = vi.fn().mockResolvedValue({ default: class TestComponent {} });
    const LazyComponent = createLazyComponent(importFn, { chunkName: 'test' });

    expect(LazyComponent).toBeDefined();
    expect(typeof LazyComponent).toBe('function');
  });

  it('should show placeholder while loading', async () => {
    const importFn = vi.fn().mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ default: class TestComponent {} }), 100);
    }));

    const LazyComponent = createLazyComponent(importFn, {
      chunkName: 'test',
      placeholder: '<div class="test-placeholder">Loading...</div>'
    });

    const component = new LazyComponent({ prop1: 'value1' });
    component.mount(container);

    expect(container.querySelector('.test-placeholder')).toBeDefined();
  });

  it('should show error on load failure', async () => {
    const importFn = vi.fn().mockRejectedValue(new Error('Load failed'));

    const LazyComponent = createLazyComponent(importFn, {
      chunkName: 'test',
      errorComponent: '<div class="test-error">Error</div>'
    });

    const component = new LazyComponent({});
    await component.mount(container);

    expect(container.querySelector('.test-error')).toBeDefined();
  });

  it('should retry on error when retry button clicked', async () => {
    const mockModule = { default: class TestComponent { mount() {} } };
    const importFn = vi.fn()
      .mockRejectedValueOnce(new Error('First error'))
      .mockResolvedValue(mockModule);

    const LazyComponent = createLazyComponent(importFn, { chunkName: 'test' });
    const component = new LazyComponent({});

    await component.mount(container);

    // 应该显示错误和重试按钮
    const retryBtn = container.querySelector('.retry-btn');
    expect(retryBtn).toBeDefined();
  });
});

describe('Performance Metrics', () => {
  let loader;

  beforeEach(() => {
    loader = new LazyLoader();
  });

  it('should track load time', async () => {
    const mockModule = { default: {} };
    const importFn = vi.fn().mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(mockModule), 50);
    }));

    await loader.load('test-chunk', importFn);

    expect(loader.metrics.chunkLoadTimes['test-chunk']).toBeGreaterThan(0);
    expect(loader.metrics.totalLoadTime).toBeGreaterThan(0);
  });

  it('should calculate average load time', async () => {
    const mockModule = { default: {} };
    const importFn = vi.fn().mockResolvedValue(mockModule);

    await loader.load('chunk1', importFn);
    await loader.load('chunk2', importFn);

    const report = loader.getReport();
    expect(report.averageLoadTime).toBeGreaterThan(0);
    expect(report.averageLoadTime).toBeLessThan(100);
  });

  it('should calculate cache hit rate', async () => {
    const mockModule = { default: {} };
    const importFn = vi.fn().mockResolvedValue(mockModule);

    await loader.load('test-chunk', importFn);
    await loader.load('test-chunk', importFn); // 从缓存加载

    const report = loader.getReport();
    expect(report.cacheHitRate).toBe(0.5);
  });
});

describe('Concurrent Loads', () => {
  let loader;

  beforeEach(() => {
    loader = new LazyLoader();
  });

  it('should handle concurrent load requests for same chunk', async () => {
    const mockModule = { default: { name: 'TestComponent' } };
    let importCallCount = 0;
    const importFn = vi.fn().mockImplementation(() => {
      importCallCount++;
      return new Promise(resolve => {
        setTimeout(() => resolve(mockModule), 100);
      });
    });

    // 同时发起多个加载请求
    const promises = [
      loader.load('test-chunk', importFn),
      loader.load('test-chunk', importFn),
      loader.load('test-chunk', importFn)
    ];

    const results = await Promise.all(promises);

    // 应该只调用一次 import
    expect(importCallCount).toBe(1);
    expect(results[0]).toEqual(mockModule.default);
    expect(results[1]).toEqual(mockModule.default);
    expect(results[2]).toEqual(mockModule.default);
  });
});
