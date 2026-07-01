'use strict';

/**
 * REQ-00398: API 错误消息动态翻译管理系统单元测试
 */

const { describe, it, beforeEach, afterEach, expect, mock } = require('@jest/globals');
const DynamicTranslationManager = require('../../shared/DynamicTranslationManager').DynamicTranslationManager;

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn(),
  pool: {
    connect: jest.fn()
  }
}));

jest.mock('../../shared/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('ioredis', () => {
  const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(() => ({
      setex: jest.fn(),
      exec: jest.fn()
    })),
    quit: jest.fn()
  };
  return jest.fn(() => mockRedis);
});

describe('DynamicTranslationManager', () => {
  let manager;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    jest.clearAllMocks();
    
    manager = new DynamicTranslationManager({
      cacheTTL: 3600
    });
    
    mockDb = require('../../shared/db');
    mockRedis = manager.redis;
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
  });

  describe('getLocalizedMessage', () => {
    it('应该从缓存中获取翻译', async () => {
      const errorCode = 'POKEMON_NOT_FOUND';
      const language = 'zh-CN';
      const cachedMessage = '未找到指定的精灵';
      
      mockRedis.get.mockResolvedValueOnce(cachedMessage);
      
      const result = await manager.getLocalizedMessage(errorCode, language);
      
      expect(result).toBe(cachedMessage);
      expect(mockRedis.get).toHaveBeenCalledWith(
        `error_translations:${errorCode}:${language}`
      );
    });

    it('应该从数据库查询并缓存翻译（缓存未命中）', async () => {
      const errorCode = 'POKEMON_NOT_FOUND';
      const language = 'zh-CN';
      const dbMessage = '未找到指定的精灵: pk001';
      
      mockRedis.get.mockResolvedValueOnce(null);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ message: dbMessage }]
      });
      mockRedis.setex.mockResolvedValueOnce('OK');
      
      const result = await manager.getLocalizedMessage(errorCode, language, { pokemon_id: 'pk001' });
      
      expect(result).toBe('未找到指定的精灵: pk001');
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('应该使用回退策略（数据库无结果）', async () => {
      const errorCode = 'NEW_ERROR_CODE';
      const language = 'ja-JP';
      
      mockRedis.get.mockResolvedValue(null);
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const result = await manager.getLocalizedMessage(errorCode, language);
      
      // 最终回退到错误码
      expect(result).toContain(errorCode);
    });

    it('应该正确处理参数插值', async () => {
      const message = '精灵距离太远（{distance}米）';
      const params = { distance: 100 };
      const expected = '精灵距离太远（100米）';
      
      const interpolated = manager.interpolateMessage(message, params);
      
      expect(interpolated).toBe(expected);
    });

    it('应该处理多个参数', async () => {
      const message = '{user} 在 {location} 捕捉了 {pokemon}';
      const params = { user: 'Alice', location: '公园', pokemon: '皮卡丘' };
      
      const interpolated = manager.interpolateMessage(message, params);
      
      expect(interpolated).toBe('Alice 在 公园 捕捉了 皮卡丘');
    });

    it('应该忽略不存在的参数', async () => {
      const message = 'Hello {name}';
      const params = { other: 'value' };
      
      const interpolated = manager.interpolateMessage(message, params);
      
      expect(interpolated).toBe('Hello {name}');
    });
  });

  describe('normalizeLanguage', () => {
    it('应该标准化语言代码格式', () => {
      expect(manager.normalizeLanguage('zh_CN')).toBe('zh-CN');
      expect(manager.normalizeLanguage('ZH-CN')).toBe('zh-CN');
      expect(manager.normalizeLanguage('en_us')).toBe('en-US');
    });

    it('应该返回默认语言（不支持的）', () => {
      expect(manager.normalizeLanguage('')).toBe(manager.defaultLanguage);
      expect(manager.normalizeLanguage(null)).toBe(manager.defaultLanguage);
      expect(manager.normalizeLanguage('xx-XX')).toBe(manager.defaultLanguage);
    });

    it('应该匹配主语言', () => {
      expect(manager.normalizeLanguage('zh')).toBe('zh-CN');
      expect(manager.normalizeLanguage('en')).toBe('en-US');
    });
  });

  describe('getFallbackMessage', () => {
    it('应该按照回退链查询', async () => {
      const errorCode = 'TEST_ERROR';
      
      // 设置数据库返回英语翻译
      mockRedis.get.mockResolvedValue(null);
      mockDb.query
        .mockResolvedValueOnce({ rows: [] }) // ja-JP
        .mockResolvedValueOnce({ rows: [{ message: 'Test error message' }] }); // en-US
      
      const result = await manager.getFallbackMessage(errorCode, 'ja-JP');
      
      expect(result).toBe('Test error message');
    });
  });

  describe('clearCache', () => {
    it('应该清除指定翻译的缓存', async () => {
      mockRedis.keys.mockResolvedValueOnce([
        'error_translations:TEST_ERROR:zh-CN',
        'error_translations:TEST_ERROR:en-US'
      ]);
      mockRedis.del.mockResolvedValueOnce(2);
      
      await manager.clearCache('TEST_ERROR');
      
      expect(mockRedis.keys).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('应该清除所有缓存', async () => {
      mockRedis.keys.mockResolvedValueOnce([
        'error_translations:A:zh-CN',
        'error_translations:B:en-US'
      ]);
      mockRedis.del.mockResolvedValueOnce(2);
      
      await manager.clearCache();
      
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  describe('saveTranslation', () => {
    it('应该创建新翻译', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };
      
      mockDb.pool.connect.mockResolvedValueOnce(mockClient);
      
      await manager.saveTranslation(
        'NEW_ERROR',
        'zh-CN',
        '新错误消息',
        null,
        null,
        1
      );
      
      expect(mockClient.query).toHaveBeenCalled();
    });

    it('应该更新现有翻译并记录审计日志', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, message: '旧消息', metadata: null }] })
          .mockResolvedValueOnce({ rows: [{ id: 1 }] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };
      
      mockDb.pool.connect.mockResolvedValueOnce(mockClient);
      
      await manager.saveTranslation(
        'TEST_ERROR',
        'zh-CN',
        '新消息',
        null,
        null,
        1
      );
      
      // 应该执行事务中的多条 SQL
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('batch operations', () => {
    it('应该批量获取翻译', async () => {
      mockRedis.mget.mockResolvedValueOnce([
        '消息1',
        null,
        '消息3'
      ]);
      
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { error_code: 'ERROR_2', message: '消息2' }
        ]
      });
      
      const result = await manager.getBatchTranslations(
        ['ERROR_1', 'ERROR_2', 'ERROR_3'],
        'zh-CN'
      );
      
      expect(result['ERROR_1']).toBe('消息1');
      expect(result['ERROR_2']).toBeDefined();
      expect(result['ERROR_3']).toBe('消息3');
    });

    it('应该批量导入翻译', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
      };
      
      mockDb.pool.connect.mockResolvedValueOnce(mockClient);
      
      const translations = {
        'ERROR_A': '消息A',
        'ERROR_B': '消息B'
      };
      
      const result = await manager.importTranslations('zh-CN', translations, 1);
      
      expect(result.imported).toBeGreaterThanOrEqual(0);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('exportTranslations', () => {
    it('应该导出翻译为对象', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { error_code: 'ERROR_1', message: '消息1' },
          { error_code: 'ERROR_2', message: '消息2' }
        ]
      });
      
      const result = await manager.exportTranslations('zh-CN');
      
      expect(result['ERROR_1']).toBe('消息1');
      expect(result['ERROR_2']).toBe('消息2');
    });
  });

  describe('error handling', () => {
    it('应该处理数据库错误', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis error'));
      
      const result = await manager.getLocalizedMessage('TEST', 'zh-CN');
      
      // 应该返回错误码作为回退
      expect(result).toContain('TEST');
    });
  });
});

describe('Translation API Routes', () => {
  // API 路由测试
  // 在集成测试中进行更详细的测试
});