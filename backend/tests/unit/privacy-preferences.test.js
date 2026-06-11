/**
 * REQ-00053: 用户隐私偏好管理中心 - 单元测试
 */

const { 
  PrivacyPreferencesService, 
  PrivacyPolicyService,
  DATA_CATEGORIES 
} = require('../shared/privacyPreferences');

// Mock database
const mockDb = {
  pool: {
    connect: jest.fn()
  },
  query: jest.fn()
};

const mockClient = {
  query: jest.fn(),
  release: jest.fn()
};

describe('PrivacyPreferencesService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PrivacyPreferencesService(mockDb);
    mockDb.pool.connect.mockResolvedValue(mockClient);
  });

  describe('getDataCategories', () => {
    test('should return all categories in Chinese by default', () => {
      const categories = service.getDataCategories('zh-CN');
      expect(categories.length).toBe(8);
      expect(categories[0].name).toBe('位置数据');
    });

    test('should return categories in English', () => {
      const categories = service.getDataCategories('en-US');
      expect(categories[0].name).toBe('Location Data');
    });

    test('should return categories in Japanese', () => {
      const categories = service.getDataCategories('ja-JP');
      expect(categories[0].name).toBe('位置データ');
    });

    test('should mark required categories correctly', () => {
      const categories = service.getDataCategories();
      const locationCat = categories.find(c => c.id === 'location');
      const deviceCat = categories.find(c => c.id === 'device');
      expect(locationCat.required).toBe(true);
      expect(deviceCat.required).toBe(true);
    });
  });

  describe('initializeUserPreferences', () => {
    test('should initialize all categories for new user', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      
      await service.initializeUserPreferences('user-123');
      
      expect(mockClient.query).toHaveBeenCalledTimes(10); // 8 categories + BEGIN + COMMIT
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should rollback on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));
      
      await expect(service.initializeUserPreferences('user-123')).rejects.toThrow('DB error');
      
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('getUserPreferences', () => {
    test('should return user preferences', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { category: 'location', collectable: true, consented_at: '2024-01-01', updated_at: '2024-01-01' },
          { category: 'marketing', collectable: false, consented_at: null, updated_at: '2024-06-01' }
        ]
      });
      
      const preferences = await service.getUserPreferences('user-123');
      
      expect(preferences.location.collectable).toBe(true);
      expect(preferences.marketing.collectable).toBe(false);
      expect(Object.keys(preferences).length).toBe(8); // All categories
    });

    test('should return default values for missing categories', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const preferences = await service.getUserPreferences('user-123');
      
      expect(Object.keys(preferences).length).toBe(8);
      for (const cat of Object.values(preferences)) {
        expect(cat.collectable).toBe(true);
      }
    });
  });

  describe('updateUserPreferences', () => {
    test('should update non-required categories', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      
      const result = await service.updateUserPreferences('user-123', {
        marketing: false,
        analytics: false
      });
      
      expect(result.success).toBe(true);
      expect(result.updated.length).toBe(2);
    });

    test('should reject disabling required categories', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      
      const result = await service.updateUserPreferences('user-123', {
        location: false
      });
      
      expect(result.errors).toBeDefined();
      expect(result.errors[0].error).toContain('必需');
    });

    test('should reject unknown categories', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      
      const result = await service.updateUserPreferences('user-123', {
        unknown: false
      });
      
      expect(result.errors).toBeDefined();
      expect(result.errors[0].error).toContain('未知');
    });
  });

  describe('canCollectData', () => {
    test('should return true when allowed', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ collectable: true }]
      });
      
      const canCollect = await service.canCollectData('user-123', 'marketing');
      expect(canCollect).toBe(true);
    });

    test('should return false when disabled', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ collectable: false }]
      });
      
      const canCollect = await service.canCollectData('user-123', 'marketing');
      expect(canCollect).toBe(false);
    });

    test('should return true by default when no preference', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const canCollect = await service.canCollectData('user-123', 'marketing');
      expect(canCollect).toBe(true);
    });
  });

  describe('logDataAccess', () => {
    test('should insert access log', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await service.logDataAccess('user-123', 'location', 'query', 'nearby-pokemon', '查询附近精灵');
      
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO data_access_logs'),
        ['user-123', 'location', 'query', 'nearby-pokemon', '查询附近精灵']
      );
    });
  });

  describe('generateMonthlyReport', () => {
    test('should generate report for specified month', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            { category: 'location', action: 'query', purpose: 'nearby-pokemon', count: '50' },
            { category: 'behavior', action: 'record', purpose: 'catch', count: '30' }
          ]
        })
        .mockResolvedValueOnce({ rows: [] });
      
      const report = await service.generateMonthlyReport('user-123', '2024-06');
      
      expect(report.month).toBe('2024-06');
      expect(report.summary.totalDataPoints).toBe(80);
      expect(report.summary.dataByCategory.location).toBe(50);
      expect(report.retentionStatus).toBeDefined();
    });

    test('should handle empty data', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      
      const report = await service.generateMonthlyReport('user-123', '2024-06');
      
      expect(report.summary.totalDataPoints).toBe(0);
      expect(report.details).toEqual([]);
    });
  });

  describe('getReportHistory', () => {
    test('should return report history', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { month: '2024-06', report_json: { summary: { totalDataPoints: 100 } }, generated_at: '2024-07-01' },
          { month: '2024-05', report_json: { summary: { totalDataPoints: 80 } }, generated_at: '2024-06-01' }
        ]
      });
      
      const history = await service.getReportHistory('user-123', 12);
      
      expect(history.length).toBe(2);
      expect(history[0].month).toBe('2024-06');
    });
  });
});

describe('PrivacyPolicyService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PrivacyPolicyService(mockDb);
  });

  describe('getCurrentPolicy', () => {
    test('should return current policy in Chinese', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          version: 'v1.0',
          effective_date: '2024-01-01',
          changes: ['初始版本'],
          content_zh_cn: '中文隐私政策',
          content_en_us: 'English Privacy Policy',
          content_ja_jp: '日本語プライバシー政策',
          created_at: '2024-01-01'
        }]
      });
      
      const policy = await service.getCurrentPolicy('zh-CN');
      
      expect(policy.version).toBe('v1.0');
      expect(policy.content).toBe('中文隐私政策');
    });

    test('should return current policy in English', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          version: 'v1.0',
          effective_date: '2024-01-01',
          changes: ['Initial version'],
          content_zh_cn: '中文隐私政策',
          content_en_us: 'English Privacy Policy',
          content_ja_jp: '日本語プライバシー政策',
          created_at: '2024-01-01'
        }]
      });
      
      const policy = await service.getCurrentPolicy('en-US');
      
      expect(policy.content).toBe('English Privacy Policy');
    });

    test('should return null when no policy exists', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const policy = await service.getCurrentPolicy();
      
      expect(policy).toBeNull();
    });
  });

  describe('getVersionHistory', () => {
    test('should return version history', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { version: 'v1.2', effective_date: '2024-06-01', changes: ['新增条款'], created_at: '2024-06-01' },
          { version: 'v1.1', effective_date: '2024-03-01', changes: ['修改条款'], created_at: '2024-03-01' },
          { version: 'v1.0', effective_date: '2024-01-01', changes: ['初始版本'], created_at: '2024-01-01' }
        ]
      });
      
      const history = await service.getVersionHistory(10);
      
      expect(history.length).toBe(3);
      expect(history[0].version).toBe('v1.2');
    });
  });

  describe('getPolicyByVersion', () => {
    test('should return specific version', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          version: 'v1.0',
          effective_date: '2024-01-01',
          changes: ['初始版本'],
          content_zh_cn: '中文隐私政策',
          content_en_us: 'English Privacy Policy',
          content_ja_jp: '日本語プライバシー政策',
          created_at: '2024-01-01'
        }]
      });
      
      const policy = await service.getPolicyByVersion('v1.0', 'zh-CN');
      
      expect(policy.version).toBe('v1.0');
    });

    test('should return null for unknown version', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const policy = await service.getPolicyByVersion('v0.0', 'zh-CN');
      
      expect(policy).toBeNull();
    });
  });

  describe('createPolicyVersion', () => {
    test('should create new policy version', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 1,
          version: 'v1.1',
          effective_date: '2024-06-01',
          changes: ['新增条款'],
          created_at: '2024-06-01'
        }]
      });
      
      const policy = await service.createPolicyVersion(
        'v1.1',
        '2024-06-01',
        ['新增条款'],
        '中文内容',
        'English content',
        '日本語内容'
      );
      
      expect(policy.version).toBe('v1.1');
    });
  });

  describe('recordAcceptance', () => {
    test('should record user acceptance', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      await service.recordAcceptance('user-123', 'v1.0');
      
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO privacy_policy_acceptance'),
        ['user-123', 'v1.0']
      );
    });
  });

  describe('hasAcceptedLatestPolicy', () => {
    test('should return true when accepted', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ version: 'v1.0', effective_date: '2024-01-01' }]
        })
        .mockResolvedValueOnce({
          rows: [{ 1: 1 }]
        });
      
      const hasAccepted = await service.hasAcceptedLatestPolicy('user-123');
      
      expect(hasAccepted).toBe(true);
    });

    test('should return false when not accepted', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ version: 'v1.0', effective_date: '2024-01-01' }]
        })
        .mockResolvedValueOnce({ rows: [] });
      
      const hasAccepted = await service.hasAcceptedLatestPolicy('user-123');
      
      expect(hasAccepted).toBe(false);
    });

    test('should return true when no policy exists', async () => {
      mockDb.query.mockResolvedValue({ rows: [] });
      
      const hasAccepted = await service.hasAcceptedLatestPolicy('user-123');
      
      expect(hasAccepted).toBe(true);
    });
  });

  describe('getUsersNotAcceptedLatestPolicy', () => {
    test('should return users who have not accepted', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ version: 'v1.0', effective_date: '2024-01-01' }]
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'user-1', email: 'user1@example.com', username: 'user1' },
            { id: 'user-2', email: 'user2@example.com', username: 'user2' }
          ]
        });
      
      const users = await service.getUsersNotAcceptedLatestPolicy(100);
      
      expect(users.length).toBe(2);
    });
  });
});

describe('DATA_CATEGORIES', () => {
  test('should have 8 categories', () => {
    expect(Object.keys(DATA_CATEGORIES).length).toBe(8);
  });

  test('should have required categories marked', () => {
    expect(DATA_CATEGORIES.LOCATION.required).toBe(true);
    expect(DATA_CATEGORIES.DEVICE.required).toBe(true);
    expect(DATA_CATEGORIES.MARKETING.required).toBe(false);
  });

  test('should have retention days defined', () => {
    expect(DATA_CATEGORIES.LOCATION.retentionDays).toBe(90);
    expect(DATA_CATEGORIES.PROFILE.retentionDays).toBeNull(); // Permanent
  });
});
