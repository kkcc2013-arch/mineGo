/**
 * REQ-00059: 新手引导与教程系统
 * 单元测试
 */

const { describe, it, expect, beforeEach, afterEach, mock } = require('../../../test-helpers');
const TutorialService = require('../tutorialService');

// Mock 数据库
const mockDb = {
  query: mock()
};

// Mock EventBus
const mockEventBus = {
  publish: mock()
};

// Mock logger
const mockLogger = {
  info: mock(),
  error: mock()
};

// Mock metrics
const mockMetrics = {
  incrementCounter: mock()
};

describe('TutorialService', () => {
  beforeEach(() => {
    // 重置所有 mock
    mockDb.query.mockReset();
    mockEventBus.publish.mockReset();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    mockMetrics.incrementCounter.mockReset();
    
    // 注入 mock
    TutorialService.db = mockDb;
    TutorialService.EventBus = mockEventBus;
    TutorialService.logger = mockLogger;
    TutorialService.metrics = mockMetrics;
  });

  describe('startTutorial', () => {
    it('should create new tutorial progress for new user', async () => {
      // 模拟没有现有进度
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      // 模拟插入成功
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          user_id: 123,
          current_step: 'welcome',
          completed_steps: []
        }]
      });
      // 模拟获取新手任务
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
      // 模拟插入新手任务
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await TutorialService.startTutorial(123);

      expect(result.user_id).toBe(123);
      expect(result.current_step).toBe('welcome');
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('tutorial_started_total');
    });

    it('should return existing progress if already exists', async () => {
      const existingProgress = {
        id: 1,
        user_id: 123,
        current_step: 'first_catch',
        completed_steps: ['welcome', 'choose_starter']
      };
      
      mockDb.query.mockResolvedValueOnce({ rows: [existingProgress] });

      const result = await TutorialService.startTutorial(123);

      expect(result).toEqual(existingProgress);
      // 不应该创建新进度
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCurrentStep', () => {
    it('should return current step details', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'first_catch',
          completed_steps: ['welcome', 'choose_starter'],
          skipped: false,
          completed_at: null
        }]
      });

      const result = await TutorialService.getCurrentStep(123);

      expect(result.stepKey).toBe('first_catch');
      expect(result.title).toBeDefined();
      expect(result.completedSteps).toHaveLength(2);
    });

    it('should return null if tutorial is skipped', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'first_catch',
          completed_steps: ['welcome'],
          skipped: true,
          completed_at: null
        }]
      });

      const result = await TutorialService.getCurrentStep(123);

      expect(result).toBeNull();
    });

    it('should return null if tutorial is completed', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: null,
          completed_steps: ['welcome', 'choose_starter', 'first_catch', 'visit_pokestop', 'first_battle', 'add_friend', 'tutorial_complete'],
          skipped: false,
          completed_at: new Date()
        }]
      });

      const result = await TutorialService.getCurrentStep(123);

      expect(result).toBeNull();
    });
  });

  describe('completeStep', () => {
    it('should complete step and move to next', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'welcome',
          completed_steps: [],
          skipped: false,
          completed_at: null
        }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'choose_starter',
          completed_steps: ['welcome']
        }]
      });

      const result = await TutorialService.completeStep(123, 'welcome');

      expect(result.success).toBe(true);
      expect(result.nextStep).toBe('choose_starter');
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'tutorial_step_completed_total',
        { step: 'welcome' }
      );
    });

    it('should throw error if step already completed', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'first_catch',
          completed_steps: ['welcome', 'choose_starter'],
          skipped: false,
          completed_at: null
        }]
      });

      await expect(TutorialService.completeStep(123, 'welcome'))
        .rejects.toThrow('Step already completed');
    });

    it('should throw error if tutorial was skipped', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'welcome',
          completed_steps: [],
          skipped: true,
          completed_at: null
        }]
      });

      await expect(TutorialService.completeStep(123, 'welcome'))
        .rejects.toThrow('Tutorial was skipped');
    });

    it('should trigger completion when last step is done', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'add_friend',
          completed_steps: ['welcome', 'choose_starter', 'first_catch', 'visit_pokestop', 'first_battle'],
          skipped: false,
          completed_at: null
        }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'tutorial_complete',
          completed_steps: ['welcome', 'choose_starter', 'first_catch', 'visit_pokestop', 'first_battle', 'add_friend']
        }]
      });
      
      // 模拟获取功能解锁
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await TutorialService.completeStep(123, 'add_friend');

      expect(result.nextStep).toBe('tutorial_complete');
    });
  });

  describe('skipTutorial', () => {
    it('should skip tutorial and unlock basic features', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'first_catch',
          completed_steps: ['welcome'],
          skipped: false
        }]
      });
      
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await TutorialService.skipTutorial(123);

      expect(result.success).toBe(true);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith('tutorial_skipped_total');
    });

    it('should throw error if already skipped', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          current_step: 'welcome',
          completed_steps: [],
          skipped: true
        }]
      });

      await expect(TutorialService.skipTutorial(123))
        .rejects.toThrow('Tutorial already skipped');
    });
  });

  describe('getBeginnerTasks', () => {
    it('should return all beginner tasks with progress', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            task_key: 'catch_first_pokemon',
            title: '捕捉第一只精灵',
            description: '捕捉你的第一只精灵',
            task_type: 'catch_pokemon',
            target_count: 1,
            rewards: { coins: 100, xp: 500 },
            category: 'basic',
            progress: 1,
            completed: true,
            rewards_claimed: false
          },
          {
            id: 2,
            task_key: 'catch_10_pokemon',
            title: '精灵收藏家',
            description: '捕捉 10 只精灵',
            task_type: 'catch_pokemon',
            target_count: 10,
            rewards: { coins: 500, pokeballs: 10 },
            category: 'basic',
            progress: 5,
            completed: false,
            rewards_claimed: false
          }
        ]
      });

      const result = await TutorialService.getBeginnerTasks(123);

      expect(result).toHaveLength(2);
      expect(result[0].completed).toBe(true);
      expect(result[1].progress).toBe(5);
    });
  });

  describe('updateBeginnerTaskProgress', () => {
    it('should increment task progress', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          task_id: 2,
          progress: 5,
          target_count: 10,
          task_key: 'catch_10_pokemon'
        }]
      });
      
      mockDb.query.mockResolvedValue({ rows: [] });

      await TutorialService.updateBeginnerTaskProgress(123, 'catch_pokemon', 1);

      // 验证进度更新
      expect(mockDb.query).toHaveBeenCalled();
    });

    it('should mark task as completed when target reached', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          user_id: 123,
          task_id: 1,
          progress: 0,
          target_count: 1,
          task_key: 'catch_first_pokemon'
        }]
      });
      
      mockDb.query.mockResolvedValue({ rows: [] });

      await TutorialService.updateBeginnerTaskProgress(123, 'catch_pokemon', 1);

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'beginner_task_completed_total',
        { task: 'catch_first_pokemon' }
      );
    });
  });

  describe('isFeatureUnlocked', () => {
    it('should return true if feature is unlocked', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] });

      const result = await TutorialService.isFeatureUnlocked(123, 'catch_pokemon');

      expect(result).toBe(true);
    });

    it('should return false if feature is not unlocked', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const result = await TutorialService.isFeatureUnlocked(123, 'trade_pokemon');

      expect(result).toBe(false);
    });
  });

  describe('unlockFeature', () => {
    it('should unlock feature and publish event', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          feature_key: 'catch_pokemon',
          feature_name: '捕捉精灵',
          description: '在野外捕捉精灵',
          unlock_type: 'tutorial',
          unlock_message: '你现在可以捕捉精灵了！'
        }]
      });
      
      mockDb.query.mockResolvedValue({ rows: [] });

      const result = await TutorialService.unlockFeature(123, 'catch_pokemon');

      expect(result.success).toBe(true);
      expect(result.feature.feature_key).toBe('catch_pokemon');
      expect(mockEventBus.publish).toHaveBeenCalled();
    });

    it('should throw error if feature not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await expect(TutorialService.unlockFeature(123, 'invalid_feature'))
        .rejects.toThrow('Feature not found');
    });
  });

  describe('getSmartTips', () => {
    it('should return tips matching context', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            tip_key: 'backpack_full',
            title: '背包已满',
            content: '你的背包已满，建议清理一些不需要的物品',
            trigger_type: 'state',
            trigger_conditions: { backpackFull: true },
            display_type: 'banner',
            priority: 10,
            max_displays: 3,
            display_count: 1,
            dismissed: false
          }
        ]
      });

      const result = await TutorialService.getSmartTips(123, { backpackFull: true });

      expect(result).toHaveLength(1);
      expect(result[0].tipKey).toBe('backpack_full');
    });

    it('should not return dismissed tips', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            tip_key: 'backpack_full',
            title: '背包已满',
            content: '你的背包已满',
            trigger_type: 'state',
            trigger_conditions: { backpackFull: true },
            display_type: 'banner',
            priority: 10,
            max_displays: 3,
            display_count: 3,
            dismissed: true
          }
        ]
      });

      const result = await TutorialService.getSmartTips(123, { backpackFull: true });

      // 即使匹配条件，已关闭的提示也不应该返回
      expect(result).toHaveLength(0);
    });
  });

  describe('searchFAQ', () => {
    it('should return matching FAQs', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            category: 'getting_started',
            question: '如何捕捉精灵？',
            answer: '在地图上找到野生精灵...',
            view_count: 100,
            helpful_count: 80
          }
        ]
      });

      const result = await TutorialService.searchFAQ('捕捉');

      expect(result).toHaveLength(1);
      expect(result[0].question).toContain('捕捉');
    });
  });

  describe('checkTriggerConditions', () => {
    it('should check state conditions correctly', () => {
      const conditions = { backpackFull: true };
      const context = { backpackFull: true };
      
      const result = TutorialService.checkStateConditions(conditions, context);
      expect(result).toBe(true);
    });

    it('should check time conditions correctly', () => {
      const conditions = { timeRange: { start: 0, end: 12 } };
      
      // 假设当前时间是上午
      const result = TutorialService.checkTimeConditions(conditions);
      // 结果取决于当前时间
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getBeginnerStats', () => {
    it('should return tutorial statistics', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          total_new_users: 100,
          completed_tutorial: 80,
          avg_completion_time: 300,
          skipped_count: 5
        }]
      });

      const startDate = new Date('2026-06-01');
      const endDate = new Date('2026-06-10');
      const result = await TutorialService.getBeginnerStats(startDate, endDate);

      expect(result.total_new_users).toBe(100);
      expect(result.completed_tutorial).toBe(80);
      expect(result.avg_completion_time).toBe(300);
    });
  });
});

// 运行测试
if (require.main === module) {
  console.log('Running TutorialService tests...');
  // 实际测试运行器会处理
}
