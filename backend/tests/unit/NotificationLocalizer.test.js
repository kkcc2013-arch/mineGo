// backend/tests/unit/NotificationLocalizer.test.js
// REQ-00496: 推送通知内容多语言本地化测试
'use strict';

const { NotificationLocalizer, createNotificationLocalizer, DEFAULT_LANGUAGE, FALLBACK_LANGUAGE, SUPPORTED_LANGUAGES } = require('../../shared/NotificationLocalizer');
const { Pool } = require('pg');
const { createLogger } = require('../../shared/logger');

// Mock Redis
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1)
};

// Mock Database
const mockDb = {
  query: jest.fn()
};

// Mock Pool
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => mockDb)
}));

describe('NotificationLocalizer', () => {
  let localizer;

  beforeEach(() => {
    jest.clearAllMocks();
    localizer = new NotificationLocalizer(mockDb, mockRedis);
    localizer.clearCache();
  });

  describe('getUserNotificationLanguage', () => {
    test('应该返回用户偏好语言', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // 缓存表无数据
      mockDb.query.mockResolvedValueOnce({ rows: [{ language_preference: 'ja-JP' }] }); // 用户表有偏好
      
      const language = await localizer.getUserNotificationLanguage('user123');
      
      expect(language).toBe('ja-JP');
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    test('应该返回默认语言当无偏好时', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const language = await localizer.getUserNotificationLanguage('user456');
      
      expect(language).toBe(DEFAULT_LANGUAGE);
    });

    test('应该使用缓存表的语言', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'en-US', language_source: 'header' }] });
      
      const language = await localizer.getUserNotificationLanguage('user789');
      
      expect(language).toBe('en-US');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    test('内存缓存应该生效', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'zh-CN' }] });
      
      await localizer.getUserNotificationLanguage('cachedUser');
      await localizer.getUserNotificationLanguage('cachedUser');
      
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    test('Redis 缓存应该生效', async () => {
      mockRedis.get.mockResolvedValueOnce('en-US');
      
      const language = await localizer.getUserNotificationLanguage('redisCachedUser');
      
      expect(language).toBe('en-US');
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('getTemplate', () => {
    test('应该返回正确语言的模板', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          template_key: 'friend_request',
          category: 'social',
          priority: 'normal',
          variables: { variables: ['sender_name'] },
          title_template: '友達申請',
          body_template: '{{sender_name}}が友達申請を送りました',
          action_text: '確認'
        }]
      });
      
      const template = await localizer.getTemplate('friend_request', 'ja-JP');
      
      expect(template).toBeDefined();
      expect(template.title_template).toBe('友達申請');
      expect(template.template_key).toBe('friend_request');
    });

    test('应该缓存模板到内存', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ template_key: 'test', title_template: 'Test' }] });
      
      await localizer.getTemplate('test', 'zh-CN');
      await localizer.getTemplate('test', 'zh-CN');
      
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    test('无模板时返回 null', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const template = await localizer.getTemplate('nonexistent', 'en-US');
      
      expect(template).toBeNull();
    });
  });

  describe('fillTemplate', () => {
    test('应该正确替换变量', () => {
      const template = {
        title_template: '{{sender_name}} 想和你成为好友',
        body_template: '点击查看 {{sender_name}} 的请求',
        action_text: '查看',
        category: 'social',
        priority: 'normal'
      };
      
      const variables = { sender_name: '小明' };
      
      const result = localizer.fillTemplate(template, variables);
      
      expect(result.title).toBe('小明 想和你成为好友');
      expect(result.body).toBe('点击查看 小明 的请求');
      expect(result.actionText).toBe('查看');
    });

    test('应该处理多个变量', () => {
      const template = {
        title_template: '传说精灵 {{pokemon_name}} 出现于 {{location}}',
        body_template: '立即前往捕捉 {{pokemon_name}}！',
        action_text: '立即前往',
        category: 'activity',
        priority: 'critical'
      };
      
      const variables = { pokemon_name: 'Mewtwo', location: '东京塔' };
      
      const result = localizer.fillTemplate(template, variables);
      
      expect(result.title).toBe('传说精灵 Mewtwo 出现于 东京塔');
      expect(result.body).toBe('立即前往捕捉 Mewtwo！');
    });

    test('缺失变量时保持原样', () => {
      const template = {
        title_template: '系统将于 {{start_time}} 开始维护',
        body_template: '预计 {{duration}}',
        action_text: '了解更多',
        category: 'system',
        priority: 'critical'
      };
      
      const variables = {};
      
      const result = localizer.fillTemplate(template, variables);
      
      expect(result.title).toBe('系统将于 {{start_time}} 开始维护');
      expect(result.body).toBe('预计 {{duration}}');
    });

    test('变量值为 null/undefined 时转为空字符串', () => {
      const template = {
        title_template: '礼物 {{gift_name}}',
        body_template: '来自 {{sender_name}}',
        action_text: '领取'
      };
      
      const variables = { gift_name: null, sender_name: undefined };
      
      const result = localizer.fillTemplate(template, variables);
      
      expect(result.title).toBe('礼物 ');
      expect(result.body).toBe('来自 ');
    });
  });

  describe('localizeNotification', () => {
    test('应该根据用户语言本地化通知', async () => {
      // 用户语言
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'ja-JP' }] });
      // 模板查询
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          template_key: 'achievement_unlock',
          category: 'reward',
          priority: 'high',
          title_template: '実績解除',
          body_template: '実績解除：{{achievement_name}}',
          action_text: '報酬を見る'
        }]
      });
      
      const result = await localizer.localizeNotification('achievement_unlock', { achievement_name: '初次捕捉' }, 'user1');
      
      expect(result.title).toBe('実績解除');
      expect(result.body).toBe('実績解除：初次捕捉');
      expect(result.actionText).toBe('報酬を見る');
    });

    test('语言回退到英文', async () => {
      // 用户语言
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'fr-FR' }] }); // 不支持的语言
      // 模板查询（ja-JP无）
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      // 回退到英文
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          template_key: 'daily_reward',
          title_template: 'Daily Reward',
          body_template: 'Daily reward ready: {{reward_name}} {{amount}}',
          action_text: 'Claim'
        }]
      });
      
      const result = await localizer.localizeNotification('daily_reward', { reward_name: 'Gold', amount: '100' }, 'user2');
      
      expect(result.title).toBe('Daily Reward');
      expect(result.body).toBe('Daily reward ready: Gold 100');
    });

    test('最终回退到中文', async () => {
      // 用户语言
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'ko-KR' }] });
      // 无模板
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      // 中文模板
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          template_key: 'system_maintenance',
          title_template: '系统维护通知',
          body_template: '系统将于 {{start_time}} 开始维护',
          action_text: '了解更多'
        }]
      });
      
      const result = await localizer.localizeNotification('system_maintenance', { start_time: '22:00' }, 'user3');
      
      expect(result.title).toBe('系统维护通知');
    });

    test('无模板时使用默认通知', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'zh-CN' }] });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const result = await localizer.localizeNotification('unknown_template', { foo: 'bar' }, 'user4');
      
      expect(result.title).toBe('Unknown Template');
      expect(result.category).toBe('system');
    });
  });

  describe('batchLocalize', () => {
    test('应该按语言分组批量本地化', async () => {
      // 用户语言查询
      mockDb.query.mockResolvedValue({ rows: [] });
      mockDb.query
        .mockResolvedValueOnce({ rows: [] }) // user1
        .mockResolvedValueOnce({ rows: [{ language_preference: 'zh-CN' }] }) // user2
        .mockResolvedValueOnce({ rows: [{ language_preference: 'en-US' }] }); // user3
      
      // 模板查询
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ template_key: 'gift_received', title_template: '收到礼物', body_template: '{{sender_name}} 送了你一个 {{gift_name}}', action_text: '领取' }]
        })
        .mockResolvedValueOnce({
          rows: [{ template_key: 'gift_received', title_template: 'Gift Received', body_template: '{{sender_name}} sent you a {{gift_name}}', action_text: 'Claim' }]
        });
      
      const result = await localizer.batchLocalize('gift_received', { sender_name: '小红', gift_name: '精灵球' }, ['user1', 'user2', 'user3']);
      
      expect(result['zh-CN']).toBeDefined();
      expect(result['en-US']).toBeDefined();
      expect(result['zh-CN'].userIds).toContain('user1');
      expect(result['zh-CN'].userIds).toContain('user2');
      expect(result['en-US'].userIds).toContain('user3');
    });

    test('空用户列表应返回空对象', async () => {
      const result = await localizer.batchLocalize('test', {}, []);
      
      expect(result).toEqual({});
    });
  });

  describe('updateUserLanguage', () => {
    test('应该更新用户语言偏好', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const result = await localizer.updateUserLanguage('user5', 'ja-JP', 'preference');
      
      expect(result).toBe(true);
      expect(mockDb.query).toHaveBeenCalled();
    });

    test('不支持的语言应设为默认', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      await localizer.updateUserLanguage('user6', 'fr-FR', 'header');
      
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining(['user6', DEFAULT_LANGUAGE, 'header'])
      );
    });
  });

  describe('clearCache', () => {
    test('应该清除所有缓存', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'zh-CN' }] });
      
      await localizer.getUserNotificationLanguage('testUser');
      expect(localizer.userLanguageCache.size).toBeGreaterThan(0);
      
      localizer.clearCache();
      
      expect(localizer.userLanguageCache.size).toBe(0);
      expect(localizer.templateCache.size).toBe(0);
    });
  });

  describe('helper methods', () => {
    test('getSupportedLanguages 应返回正确列表', () => {
      const languages = localizer.getSupportedLanguages();
      
      expect(languages).toEqual(SUPPORTED_LANGUAGES);
    });

    test('getDefaultLanguage 应返回 zh-CN', () => {
      const defaultLang = localizer.getDefaultLanguage();
      
      expect(defaultLang).toBe(DEFAULT_LANGUAGE);
    });

    test('getFallbackLanguage 应返回 en-US', () => {
      const fallbackLang = localizer.getFallbackLanguage();
      
      expect(fallbackLang).toBe(FALLBACK_LANGUAGE);
    });
  });

  describe('error handling', () => {
    test('数据库错误时应返回默认语言', async () => {
      mockDb.query.mockRejectedValue(new Error('Database connection failed'));
      
      const language = await localizer.getUserNotificationLanguage('errorUser');
      
      expect(language).toBe(DEFAULT_LANGUAGE);
    });

    test('Redis 错误应不影响正常流程', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));
      mockDb.query.mockResolvedValueOnce({ rows: [{ language: 'en-US' }] });
      
      const language = await localizer.getUserNotificationLanguage('redisErrorUser');
      
      expect(language).toBe('en-US');
    });
  });
});

describe('createNotificationLocalizer', () => {
  test('应该创建本地化器实例', () => {
    const localizer = createNotificationLocalizer(mockDb, mockRedis);
    
    expect(localizer).toBeInstanceOf(NotificationLocalizer);
  });

  test('Redis 为 null 时仍应工作', () => {
    const localizer = createNotificationLocalizer(mockDb, null);
    
    expect(localizer).toBeInstanceOf(NotificationLocalizer);
    expect(localizer.redis).toBeNull();
  });
});

describe('constants', () => {
  test('DEFAULT_LANGUAGE 应为 zh-CN', () => {
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
  });

  test('FALLBACK_LANGUAGE 应为 en-US', () => {
    expect(FALLBACK_LANGUAGE).toBe('en-US');
  });

  test('SUPPORTED_LANGUAGES 应包含三种语言', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en-US', 'ja-JP']);
  });
});