/**
 * REQ-00269: 精灵锦标赛与竞技场赛季系统 - 单元测试
 */

// Mock DB and Redis before requiring managers
jest.mock('@pmg/shared/db', () => ({
  query: jest.fn(),
  getPool: jest.fn(() => ({
    connect: jest.fn(() => ({
      query: jest.fn(),
      release: jest.fn()
    }))
  }))
}));

jest.mock('@pmg/shared/redis', () => ({
  getRedis: jest.fn(() => ({
    zadd: jest.fn(),
    expire: jest.fn()
  }))
}));

jest.mock('@pmg/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }))
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn()
}));

const RankManager = require('../../services/gym-service/src/services/RankManager');
const TournamentManager = require('../../services/gym-service/src/services/TournamentManager');
const SeasonManager = require('../../services/gym-service/src/services/SeasonManager');

describe('Season & Tournament System Unit Tests', () => {

  describe('RankManager - 段位计算与逻辑', () => {
    test('应该根据积分正确计算段位和等级', () => {
      // Bronze V: 0 - 199
      expect(RankManager.calculateTier(0)).toEqual({ tier: 'bronze', level: 5 });
      expect(RankManager.calculateTier(150)).toEqual({ tier: 'bronze', level: 5 });
      
      // Bronze I: 800 - 999
      expect(RankManager.calculateTier(900)).toEqual({ tier: 'bronze', level: 1 });

      // Silver V: 1000 - 1199
      expect(RankManager.calculateTier(1000)).toEqual({ tier: 'silver', level: 5 });

      // Gold I: 2800 - 2999
      expect(RankManager.calculateTier(2850)).toEqual({ tier: 'gold', level: 1 });

      // Grandmaster: 7000+
      expect(RankManager.calculateTier(7500).tier).toBe('grandmaster');
    });

    test('应该获取正确的段位展示信息', () => {
      const goldInfo = RankManager.getTierInfo('gold', 3);
      expect(goldInfo).toBeDefined();
      expect(goldInfo.name).toBe('黄金III');
      expect(goldInfo.color).toBe('#FFD700');
    });

    test('应该根据段位信息计算到下一段位的进度', () => {
      const rank = {
        tier: 'silver',
        tier_level: 5,
        rank_points: 1200
      };
      
      const progress = RankManager.getProgressToNextTier(rank);
      expect(progress.isMaxTier).toBe(false);
      expect(progress.pointsToNext).toBe(2000 - 1200); // Silver is 1000-1999, Gold starts at 2000
    });

    test('宗师段位（最高段位）应该返回已达上限', () => {
      const rank = {
        tier: 'grandmaster',
        tier_level: 1,
        rank_points: 8000
      };
      
      const progress = RankManager.getProgressToNextTier(rank);
      expect(progress.isMaxTier).toBe(true);
      expect(progress.pointsToNext).toBe(0);
    });

    test('罗马数字转换器应该正确转换 1-5', () => {
      expect(RankManager.getLevelRoman(1)).toBe('I');
      expect(RankManager.getLevelRoman(3)).toBe('III');
      expect(RankManager.getLevelRoman(5)).toBe('V');
    });
  });

  describe('TournamentManager - 对战树生成', () => {
    test('应该为 4 个参与者正确构建淘汰赛树', () => {
      const mockParticipants = [
        { user_id: 1, username: 'Player1', rank_points: 1500 },
        { user_id: 2, username: 'Player2', rank_points: 1400 },
        { user_id: 3, username: 'Player3', rank_points: 1300 },
        { user_id: 4, username: 'Player4', rank_points: 1200 }
      ];

      const bracket = TournamentManager.buildEliminationBracket(mockParticipants, 4, 2);
      expect(bracket.participants).toBe(4);
      expect(bracket.rounds.length).toBe(2);

      // 第一轮应该有 2 场比赛
      const round1 = bracket.rounds[0];
      expect(round1.matches.length).toBe(2);
      // 种子1 (Player1) 应该对阵 种子4 (Player4)
      expect(round1.matches[0].player1.id).toBe(1);
      expect(round1.matches[0].player2.id).toBe(4);
      // 种子2 (Player2) 应该对阵 种子3 (Player3)
      expect(round1.matches[1].player1.id).toBe(2);
      expect(round1.matches[1].player2.id).toBe(3);

      // 第二轮（决赛）应该有 1 场比赛，初始对手为空
      const round2 = bracket.rounds[1];
      expect(round2.matches.length).toBe(1);
      expect(round2.matches[0].player1).toBeNull();
      expect(round2.matches[0].player2).toBeNull();
    });

    test('奇数或不足2的幂次的人数应该在对战树第一轮产生轮空', () => {
      const mockParticipants = [
        { user_id: 1, username: 'Player1', rank_points: 1500 },
        { user_id: 2, username: 'Player2', rank_points: 1400 },
        { user_id: 3, username: 'Player3', rank_points: 1300 }
      ];

      // 3个人需要4人大小的对战树，2轮
      const bracket = TournamentManager.buildEliminationBracket(mockParticipants, 4, 2);
      const round1 = bracket.rounds[0];

      // Match 1: Player1 vs Bye (null)
      expect(round1.matches[0].player1.id).toBe(1);
      expect(round1.matches[0].player2).toBeNull();
      // 轮空应该自动判晋级，结果为 Player1
      expect(round1.matches[0].winner).toBe(1);
      expect(round1.matches[0].status).toBe('completed');
    });
  });

  describe('SeasonManager - 奖励配置', () => {
    test('应该获取默认的赛季各段位及排名奖励', () => {
      const rewards = SeasonManager.getDefaultRewards();
      expect(rewards.bronze).toBeDefined();
      expect(rewards.gold.coins).toBe(400);
      expect(rewards.grandmaster.coins).toBe(5000);
      expect(rewards.top100[1].coins).toBe(10000);
    });
  });
});
