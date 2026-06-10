/**
 * REQ-00073: PVP 玩家对战系统 - 单元测试
 * 创建时间: 2026-06-10 02:00
 */

const pvpMatching = require('../../shared/pvpMatching');
const { PVPBattleRoom, PVPBattleManager } = require('../../shared/pvpBattleRoom');

// Mock database
jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

const { query } = require('../../shared/db');

describe('PVP Matching Engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('calculateEloChange', () => {
    test('应该正确计算 ELO 变化 - 平局对战', () => {
      const result = pvpMatching.calculateEloChange(1000, 1000);
      
      expect(result.winnerChange).toBe(16);
      expect(result.loserChange).toBe(-16);
    });
    
    test('应该正确计算 ELO 变化 - 高分者胜', () => {
      const result = pvpMatching.calculateEloChange(1500, 1000);
      
      // 高分者战胜低分者，获得较少积分
      expect(result.winnerChange).toBeLessThan(16);
      expect(result.loserChange).toBeLessThan(-16);
    });
    
    test('应该正确计算 ELO 变化 - 低分者胜', () => {
      const result = pvpMatching.calculateEloChange(1000, 1500);
      
      // 低分者战胜高分者，获得较多积分
      expect(result.winnerChange).toBeGreaterThan(16);
      expect(result.loserChange).toBeGreaterThan(-32);
    });
    
    test('极端分差应该限制 ELO 变化', () => {
      const result = pvpMatching.calculateEloChange(2400, 1000);
      
      // 极端分差，低分者应该获得最大积分
      expect(result.winnerChange).toBeLessThanOrEqual(32);
      expect(Math.abs(result.loserChange)).toBeLessThanOrEqual(32);
    });
  });
  
  describe('calculateTier', () => {
    test('0-699 应该是青铜', () => {
      const result = pvpMatching.calculateTier(0);
      expect(result.tier).toBe('bronze');
      
      const result2 = pvpMatching.calculateTier(699);
      expect(result2.tier).toBe('bronze');
    });
    
    test('700-999 应该是白银', () => {
      const result = pvpMatching.calculateTier(700);
      expect(result.tier).toBe('silver');
      
      const result2 = pvpMatching.calculateTier(999);
      expect(result2.tier).toBe('silver');
    });
    
    test('1000-1299 应该是黄金', () => {
      const result = pvpMatching.calculateTier(1000);
      expect(result.tier).toBe('gold');
    });
    
    test('1300-1599 应该是铂金', () => {
      const result = pvpMatching.calculateTier(1300);
      expect(result.tier).toBe('platinum');
    });
    
    test('1600-1999 应该是钻石', () => {
      const result = pvpMatching.calculateTier(1600);
      expect(result.tier).toBe('diamond');
    });
    
    test('2000-2399 应该是大师', () => {
      const result = pvpMatching.calculateTier(2000);
      expect(result.tier).toBe('master');
    });
    
    test('2400+ 应该是传奇大师', () => {
      const result = pvpMatching.calculateTier(2400);
      expect(result.tier).toBe('grandmaster');
      
      const result2 = pvpMatching.calculateTier(3000);
      expect(result2.tier).toBe('grandmaster');
    });
  });
  
  describe('getTierDisplayName', () => {
    test('应该返回正确的段位显示名称', () => {
      expect(pvpMatching.getTierDisplayName('bronze', 0)).toBe('青铜 I');
      expect(pvpMatching.getTierDisplayName('silver', 1)).toBe('白银 II');
      expect(pvpMatching.getTierDisplayName('gold', 2)).toBe('黄金 III');
      expect(pvpMatching.getTierDisplayName('master', 0)).toBe('大师 I');
      expect(pvpMatching.getTierDisplayName('grandmaster', 1)).toBe('传奇大师 II');
    });
  });
  
  describe('calculateAllowedRatingDiff', () => {
    test('初始等待应该使用基础 ELO 差', () => {
      const diff = pvpMatching.calculateAllowedRatingDiff(0);
      expect(diff).toBe(200);
    });
    
    test('等待时间增加应该扩大 ELO 差', () => {
      const diff = pvpMatching.calculateAllowedRatingDiff(10000); // 10秒
      expect(diff).toBe(300);
    });
    
    test('ELO 差应该有上限', () => {
      const diff = pvpMatching.calculateAllowedRatingDiff(60000); // 60秒
      expect(diff).toBe(500); // maxRatingDiffCap
    });
  });
  
  describe('findMatch', () => {
    test('没有匹配时应该加入队列', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      query.mockResolvedValueOnce({ rowCount: 1 });
      query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await pvpMatching.findMatch(1, 1000);
      
      expect(result).toBeNull();
    });
    
    test('找到匹配时应该返回对手信息', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          user_id: 2,
          elo_rating: 1050,
          wait_time_ms: 5000
        }]
      });
      query.mockResolvedValueOnce({ rowCount: 1 });
      query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await pvpMatching.findMatch(1, 1000);
      
      expect(result).not.toBeNull();
      expect(result.opponentId).toBe(2);
      expect(result.opponentRating).toBe(1050);
    });
  });
  
  describe('joinQueue', () => {
    test('应该成功加入队列', async () => {
      query.mockResolvedValueOnce({ rowCount: 1 });
      
      await expect(pvpMatching.joinQueue(1, 1000)).resolves.not.toThrow();
    });
  });
  
  describe('leaveQueue', () => {
    test('应该成功离开队列', async () => {
      query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await pvpMatching.leaveQueue(1);
      expect(result).toBe(true);
    });
    
    test('不在队列中应该返回 false', async () => {
      query.mockResolvedValueOnce({ rowCount: 0 });
      
      const result = await pvpMatching.leaveQueue(1);
      expect(result).toBe(false);
    });
  });
  
  describe('getLeaderboard', () => {
    test('应该返回排行榜列表', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { user_id: 1, elo_rating: 2000, tier: 'master', wins: 50, losses: 10, username: 'player1' },
          { user_id: 2, elo_rating: 1900, tier: 'diamond', wins: 40, losses: 20, username: 'player2' }
        ]
      });
      
      const result = await pvpMatching.getLeaderboard();
      
      expect(result).toHaveLength(2);
      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
    });
  });
});

describe('PVP Battle Room', () => {
  let battleRoom;
  const mockWs1 = { readyState: 1, send: jest.fn() };
  const mockWs2 = { readyState: 1, send: jest.fn() };
  
  const player1 = {
    id: 1,
    ws: mockWs1,
    team: [
      { id: 1, name: 'Pikachu', types: ['electric'], hp_current: 100, hp_max: 100, attack: 100, speed: 120 },
      { id: 2, name: 'Charmander', types: ['fire'], hp_current: 80, hp_max: 80, attack: 90, speed: 100 },
      { id: 3, name: 'Squirtle', types: ['water'], hp_current: 90, hp_max: 90, attack: 85, speed: 90 }
    ],
    eloRating: 1000
  };
  
  const player2 = {
    id: 2,
    ws: mockWs2,
    team: [
      { id: 4, name: 'Bulbasaur', types: ['grass'], hp_current: 95, hp_max: 95, attack: 80, speed: 85 },
      { id: 5, name: 'Geodude', types: ['rock', 'ground'], hp_current: 70, hp_max: 70, attack: 110, speed: 50 },
      { id: 6, name: 'Gastly', types: ['ghost', 'poison'], hp_current: 60, hp_max: 60, attack: 95, speed: 110 }
    ],
    eloRating: 1050
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
    battleRoom = new PVPBattleRoom('test-battle-id', player1, player2, 'ranked');
  });
  
  describe('构造函数', () => {
    test('应该正确初始化战斗室', () => {
      expect(battleRoom.battleId).toBe('test-battle-id');
      expect(battleRoom.battleType).toBe('ranked');
      expect(battleRoom.status).toBe('pending');
      expect(battleRoom.players.size).toBe(2);
    });
    
    test('应该正确设置初始回合玩家', () => {
      expect(battleRoom.currentTurn).toBe(1);
    });
  });
  
  describe('setPlayerReady', () => {
    test('应该标记玩家准备', () => {
      const result = battleRoom.setPlayerReady(1);
      
      expect(result).toBe(true);
      expect(battleRoom.players.get(1).ready).toBe(true);
    });
    
    test('双方准备后应该开始战斗', () => {
      battleRoom.setPlayerReady(1);
      battleRoom.setPlayerReady(2);
      
      expect(battleRoom.status).toBe('in_progress');
      expect(battleRoom.startTime).toBeDefined();
    });
    
    test('无效玩家应该返回 false', () => {
      const result = battleRoom.setPlayerReady(999);
      expect(result).toBe(false);
    });
  });
  
  describe('validateAction', () => {
    beforeEach(() => {
      battleRoom.players.get(1).team[0].moves = [
        { id: 'thunderbolt', name: 'Thunderbolt', type: 'electric', power: 90, pp: 15 }
      ];
    });
    
    test('有效技能应该通过验证', () => {
      const action = { type: 'move', moveId: 'thunderbolt' };
      const result = battleRoom.validateAction(1, action);
      
      expect(result).toBe(true);
    });
    
    test('无效技能应该失败', () => {
      const action = { type: 'move', moveId: 'invalid-move' };
      const result = battleRoom.validateAction(1, action);
      
      expect(result).toBe(false);
    });
    
    test('切换到有效精灵应该通过', () => {
      const action = { type: 'switch', pokemonIndex: 1 };
      const result = battleRoom.validateAction(1, action);
      
      expect(result).toBe(true);
    });
    
    test('切换到当前精灵应该失败', () => {
      const action = { type: 'switch', pokemonIndex: 0 };
      const result = battleRoom.validateAction(1, action);
      
      expect(result).toBe(false);
    });
  });
  
  describe('calculateTypeEffectiveness', () => {
    test('电系对水系应该效果拔群', () => {
      const result = battleRoom.calculateTypeEffectiveness('electric', ['water']);
      expect(result.multiplier).toBe(2);
    });
    
    test('电系对地面系应该无效', () => {
      const result = battleRoom.calculateTypeEffectiveness('electric', ['ground']);
      expect(result.multiplier).toBe(0);
    });
    
    test('火系对水系应该效果不佳', () => {
      const result = battleRoom.calculateTypeEffectiveness('fire', ['water']);
      expect(result.multiplier).toBe(0.5);
    });
    
    test('火系对草系应该效果拔群', () => {
      const result = battleRoom.calculateTypeEffectiveness('fire', ['grass']);
      expect(result.multiplier).toBe(2);
    });
  });
  
  describe('checkBattleEnd', () => {
    test('所有精灵倒下应该结束战斗', () => {
      player1.team.forEach(p => p.hp_current = 0);
      
      const result = battleRoom.checkBattleEnd();
      
      expect(result).toBe(true);
      expect(battleRoom.winnerId).toBe(2);
    });
    
    test('还有精灵存活不应该结束', () => {
      const result = battleRoom.checkBattleEnd();
      
      expect(result).toBe(false);
    });
  });
  
  describe('surrender', () => {
    test('投降应该结束战斗', () => {
      battleRoom.surrender(1);
      
      expect(battleRoom.status).toBe('completed');
      expect(battleRoom.winnerId).toBe(2);
    });
  });
  
  describe('broadcast', () => {
    test('应该向所有玩家发送消息', () => {
      battleRoom.broadcast({ type: 'test', data: 'hello' });
      
      expect(mockWs1.send).toHaveBeenCalledTimes(1);
      expect(mockWs2.send).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('sendToPlayer', () => {
    test('应该向指定玩家发送消息', () => {
      battleRoom.sendToPlayer(1, { type: 'test', data: 'hello' });
      
      expect(mockWs1.send).toHaveBeenCalledTimes(1);
      expect(mockWs2.send).not.toHaveBeenCalled();
    });
  });
});

describe('PVP Battle Manager', () => {
  test('应该成功创建战斗', () => {
    const player1 = { id: 1, team: [], ws: {}, eloRating: 1000 };
    const player2 = { id: 2, team: [], ws: {}, eloRating: 1050 };
    
    const battle = PVPBattleManager.createBattle(player1, player2, 'ranked');
    
    expect(battle).toBeDefined();
    expect(battle.battleType).toBe('ranked');
  });
  
  test('应该正确获取战斗', () => {
    const player1 = { id: 1, team: [], ws: {}, eloRating: 1000 };
    const player2 = { id: 2, team: [], ws: {}, eloRating: 1050 };
    
    const battle = PVPBattleManager.createBattle(player1, player2, 'ranked');
    const retrieved = PVPBattleManager.getBattle(battle.battleId);
    
    expect(retrieved).toBe(battle);
  });
  
  test('应该正确获取玩家当前战斗', () => {
    const player1 = { id: 'player1', team: [], ws: {}, eloRating: 1000 };
    const player2 = { id: 'player2', team: [], ws: {}, eloRating: 1050 };
    
    const battle = PVPBattleManager.createBattle(player1, player2, 'ranked');
    const playerBattle = PVPBattleManager.getPlayerBattle('player1');
    
    expect(playerBattle).toBe(battle);
  });
  
  test('应该正确结束战斗', () => {
    const player1 = { id: 'player1', team: [], ws: {}, eloRating: 1000 };
    const player2 = { id: 'player2', team: [], ws: {}, eloRating: 1050 };
    
    const battle = PVPBattleManager.createBattle(player1, player2, 'ranked');
    PVPBattleManager.endBattle(battle.battleId);
    
    expect(PVPBattleManager.getBattle(battle.battleId)).toBeUndefined();
    expect(PVPBattleManager.getPlayerBattle('player1')).toBeNull();
  });
});
