/**
 * 翻译管理模块单元测试
 * REQ-00137: 游戏内容本地化内容管理与翻译工作流系统
 */
const translationManager = require('../../shared/TranslationManager');
const { getClient } = require('../../shared/db');
const { getRedisClient } = require('../../shared/redis');

// Mock 数据库和 Redis
jest.mock('../../shared/db');
jest.mock('../../shared/redis');

describe('TranslationManager', () => {
  let mockClient;
  let mockRedis;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn()
    };
    
    getClient.mockResolvedValue(mockClient);
    getRedisClient.mockReturnValue(mockRedis);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTranslation', () => {
    it('should return cached translation if available', async () => {
      const cachedData = { content: '测试内容', status: 'approved', version: 1 };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));
      
      const result = await translationManager.getTranslation('test.key', 'zh-CN');
      
      expect(result).toEqual(cachedData);
      expect(mockRedis.get).toHaveBeenCalledWith('translation:zh-CN:test.key');
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should fetch from database if not cached', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockClient.query.mockResolvedValue({
        rows: [{ content: '测试内容', status: 'approved', version: 1 }]
      });
      
      const result = await translationManager.getTranslation('test.key', 'zh-CN');
      
      expect(result).toEqual({ content: '测试内容', status: 'approved', version: 1 });
      expect(mockClient.query).toHaveBeenCalled();
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should fallback to default language if translation not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // zh-CN not found
        .mockResolvedValueOnce({ rows: [{ content: 'Test Content', status: 'approved', version: 1 }] }); // en-US fallback
      
      const result = await translationManager.getTranslation('test.key', 'en-US');
      
      expect(result).toEqual({ content: 'Test Content', status: 'approved', version: 1 });
    });
  });

  describe('getTranslationsByCategory', () => {
    it('should return translations for a category', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockClient.query.mockResolvedValue({
        rows: [
          { key: 'pokemon.1.name', content: '妙蛙种子' },
          { key: 'pokemon.2.name', content: '小火龙' }
        ]
      });
      
      const result = await translationManager.getTranslationsByCategory('pokemon', 'zh-CN');
      
      expect(result).toEqual({
        'pokemon.1.name': '妙蛙种子',
        'pokemon.2.name': '小火龙'
      });
    });
  });

  describe('getAllTranslations', () => {
    it('should return all translations grouped by category', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          { key: 'pokemon.1.name', category: 'pokemon', content: '妙蛙种子' },
          { key: 'skill.1.name', category: 'skill', content: '撞击' },
          { key: 'ui.button.save', category: 'ui', content: '保存' }
        ]
      });
      
      const result = await translationManager.getAllTranslations('zh-CN');
      
      expect(result.pokemon['pokemon.1.name']).toBe('妙蛙种子');
      expect(result.skill['skill.1.name']).toBe('撞击');
      expect(result.ui['ui.button.save']).toBe('保存');
    });
  });

  describe('submitTranslation', () => {
    it('should create new translation with version 1', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // 查询当前版本
        .mockResolvedValueOnce({ // 插入翻译
          rows: [{ id: 1, key_id: 1, language: 'zh-CN', content: '测试', version: 1 }]
        })
        .mockResolvedValueOnce({}); // COMMIT
      
      const result = await translationManager.submitTranslation({
        keyId: 1,
        language: 'zh-CN',
        content: '测试',
        translatedBy: 1
      });
      
      expect(result.version).toBe(1);
    });

    it('should increment version for existing translation', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ version: 1, content: '旧内容' }] }) // 查询当前版本
        .mockResolvedValueOnce({ // 插入翻译
          rows: [{ id: 2, key_id: 1, language: 'zh-CN', content: '新内容', version: 2 }]
        })
        .mockResolvedValueOnce({}) // 记录历史
        .mockResolvedValueOnce({}); // COMMIT
      
      const result = await translationManager.submitTranslation({
        keyId: 1,
        language: 'zh-CN',
        content: '新内容',
        translatedBy: 1
      });
      
      expect(result.version).toBe(2);
    });
  });

  describe('reviewTranslation', () => {
    it('should approve translation', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ // 更新状态
          rows: [{ id: 1, key_id: 1, language: 'zh-CN', status: 'approved' }]
        })
        .mockResolvedValueOnce({ // SELECT count inside updateProgress
          rows: [{ total_keys: 10, translated_keys: 5, approved_keys: 4 }]
        })
        .mockResolvedValueOnce({}) // INSERT inside updateProgress
        .mockResolvedValueOnce({}); // COMMIT
      
      const result = await translationManager.reviewTranslation(1, 'approved', 1);
      
      expect(result.status).toBe('approved');
    });

    it('should reject translation', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ // 更新状态
          rows: [{ id: 1, key_id: 1, language: 'zh-CN', status: 'rejected' }]
        })
        .mockResolvedValueOnce({ // SELECT count inside updateProgress
          rows: [{ total_keys: 10, translated_keys: 5, approved_keys: 4 }]
        })
        .mockResolvedValueOnce({}) // INSERT inside updateProgress
        .mockResolvedValueOnce({}); // COMMIT
      
      const result = await translationManager.reviewTranslation(1, 'rejected', 1, '翻译不准确');
      
      expect(result.status).toBe('rejected');
    });
  });

  describe('getProgress', () => {
    it('should return translation progress for all languages', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          { language: 'zh-CN', total_keys: 100, translated_keys: 100, approved_keys: 100, completion_pct: 100 },
          { language: 'en-US', total_keys: 100, translated_keys: 80, approved_keys: 60, completion_pct: 60 },
          { language: 'ja-JP', total_keys: 100, translated_keys: 50, approved_keys: 30, completion_pct: 30 }
        ]
      });
      
      const result = await translationManager.getProgress();
      
      expect(result).toHaveLength(3);
      expect(result[0].completion_pct).toBe(100);
      expect(result[1].completion_pct).toBe(60);
      expect(result[2].completion_pct).toBe(30);
    });
  });

  describe('getMissingTranslations', () => {
    it('should return missing translations for a language', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          { id: 1, key: 'pokemon.100.name', category: 'pokemon', description: '精灵名称' },
          { id: 2, key: 'skill.50.name', category: 'skill', description: '技能名称' }
        ]
      });
      
      const result = await translationManager.getMissingTranslations('ja-JP');
      
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('pokemon.100.name');
    });
  });

  describe('exportLanguagePack', () => {
    it('should export language pack in correct format', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          { key: 'pokemon.1.name', category: 'pokemon', content: '妙蛙种子' },
          { key: 'pokemon.2.name', category: 'pokemon', content: '小火龙' },
          { key: 'skill.1.name', category: 'skill', content: '撞击' }
        ]
      });
      
      const result = await translationManager.exportLanguagePack('zh-CN');
      
      expect(result.language).toBe('zh-CN');
      expect(result.translations.pokemon['pokemon.1.name']).toBe('妙蛙种子');
      expect(result.translations.skill['skill.1.name']).toBe('撞击');
    });
  });

  describe('detectCategory', () => {
    it('should detect pokemon category', () => {
      expect(translationManager.detectCategory('pokemon.1.name')).toBe('pokemon');
      expect(translationManager.detectCategory('species.description')).toBe('pokemon');
    });

    it('should detect skill category', () => {
      expect(translationManager.detectCategory('skill.1.name')).toBe('skill');
      expect(translationManager.detectCategory('move.tackle')).toBe('skill');
    });

    it('should detect item category', () => {
      expect(translationManager.detectCategory('item.pokeball')).toBe('item');
    });

    it('should detect achievement category', () => {
      expect(translationManager.detectCategory('achievement.first_catch')).toBe('achievement');
    });

    it('should detect ui category', () => {
      expect(translationManager.detectCategory('ui.button.save')).toBe('ui');
    });

    it('should return system as default', () => {
      expect(translationManager.detectCategory('unknown.key')).toBe('system');
    });
  });

  describe('createTranslationKey', () => {
    it('should create translation key', async () => {
      mockClient.query.mockResolvedValue({
        rows: [{ id: 1, key: 'test.key', category: 'pokemon', description: '测试' }]
      });
      
      const result = await translationManager.createTranslationKey({
        key: 'test.key',
        category: 'pokemon',
        description: '测试'
      });
      
      expect(result.key).toBe('test.key');
      expect(result.category).toBe('pokemon');
    });
  });

  describe('clearAllCache', () => {
    it('should clear all translation cache', async () => {
      mockRedis.keys.mockResolvedValue(['translation:zh-CN:key1', 'translation:en-US:key2']);
      mockRedis.del.mockResolvedValue(2);
      
      await translationManager.clearAllCache();
      
      expect(mockRedis.keys).toHaveBeenCalledWith('translation:*');
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });
});
