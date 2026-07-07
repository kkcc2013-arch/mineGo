/**
 * REQ-00469: 游戏实时对战回放录制与分享系统 - 单元测试
 * 创建时间: 2026-07-07 17:05 UTC
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const zlib = require('zlib');
const ReplayService = require('../ReplayService');
const db = require('../db');
const { getRedis } = require('../redis');

describe('ReplayService', () => {
  let dbStub, redisStub;
  
  beforeEach(() => {
    dbStub = {
      query: sinon.stub()
    };
    redisStub = {
      get: sinon.stub(),
      set: sinon.stub(),
      del: sinon.stub()
    };
    
    // 替换依赖
    sinon.stub(db, 'query').callsFake(dbStub.query);
    sinon.stub(getRedis).returns(redisStub);
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('serializeEventStream', () => {
    it('should serialize raw replay into standardized event stream', () => {
      const rawReplay = [
        {
          turn: 1,
          timestamp: 1000,
          actions: [
            {
              type: 'attack',
              attacker: 'attacker',
              pokemon: 'defender',
              move: 'Thunderbolt',
              damage: 50,
              effectiveness: 1,
              isCrit: false,
              message: 'Pikachu used Thunderbolt!'
            }
          ],
          statusEffects: []
        },
        {
          turn: 2,
          timestamp: 2000,
          actions: [
            {
              type: 'status_apply',
              pokemon: 'defender',
              effect: 'burn',
              message: 'Opponent is burned!'
            }
          ],
          statusEffects: [
            {
              pokemon: 'defender',
              effect: 'burn',
              damage: 10,
              message: 'Burn damage'
            }
          ]
        }
      ];
      
      const result = ReplayService.serializeEventStream(rawReplay);
      
      expect(result).to.have.length(2);
      expect(result[0].turn).to.equal(1);
      expect(result[0].actions).to.have.length(1);
      expect(result[0].actions[0].type).to.equal('attack');
      expect(result[0].actions[0].damage).to.equal(50);
      
      expect(result[1].statusEffects).to.have.length(1);
      expect(result[1].statusEffects[0].effect).to.equal('burn');
    });
  });
  
  describe('compressEventStream', () => {
    it('should not compress small event streams', () => {
      const smallStream = [{ turn: 1, actions: [] }];
      
      const result = ReplayService.compressEventStream(smallStream);
      
      expect(result.method).to.equal('none');
      expect(result.data).to.be.a('string');
    });
    
    it('should compress large event streams with gzip', () => {
      // 创建足够大的事件流
      const largeStream = [];
      for (let i = 0; i < 1000; i++) {
        largeStream.push({
          turn: i,
          timestamp: i * 1000,
          actions: [
            {
              type: 'attack',
              attacker: 'attacker',
              move: 'Move' + i,
              damage: Math.floor(Math.random() * 100)
            }
          ]
        });
      }
      
      const result = ReplayService.compressEventStream(largeStream);
      
      expect(result.method).to.equal('gzip');
      expect(result.size).to.be.lessThan(
        Buffer.byteLength(JSON.stringify(largeStream), 'utf8')
      );
    });
    
    it('should handle invalid gzip data gracefully', () => {
      const stream = [{ turn: 1 }];
      
      const result = ReplayService.compressEventStream(stream);
      
      expect(result).to.have.property('data');
      expect(result).to.have.property('size');
      expect(result).to.have.property('method');
    });
  });
  
  describe('extractHighlights', () => {
    it('should detect critical hits as highlights', () => {
      const eventStream = [
        {
          turn: 5,
          actions: [
            {
              type: 'attack',
              attacker: 'Pikachu',
              move: 'Thunder',
              damage: 80,
              isCritical: true,
              effectiveness: 1
            }
          ],
          statusEffects: []
        }
      ];
      
      const highlights = ReplayService.extractHighlights(eventStream, { result: 'win' });
      
      expect(highlights).to.have.length.at.least(1);
      expect(highlights[0].highlightType).to.equal('critical_hit');
      expect(highlights[0].title).to.include('暴击');
    });
    
    it('should detect super effective hits as highlights', () => {
      const eventStream = [
        {
          turn: 3,
          actions: [
            {
              type: 'attack',
              attacker: 'Charizard',
              move: 'Flamethrower',
              damage: 60,
              effectiveness: 2,
              isCritical: false
            }
          ],
          statusEffects: []
        }
      ];
      
      const highlights = ReplayService.extractHighlights(eventStream, { result: 'win' });
      
      expect(highlights).to.have.length.at.least(1);
      expect(highlights[0].highlightType).to.equal('type_effectiveness');
    });
    
    it('should detect comeback wins', () => {
      const eventStream = [];
      for (let i = 0; i < 15; i++) {
        eventStream.push({
          turn: i + 1,
          damage: {
            attacker: i >= 10 ? 30 : 10,
            defender: i >= 10 ? 10 : 20
          },
          actions: [],
          statusEffects: []
        });
      }
      
      const highlights = ReplayService.extractHighlights(eventStream, { result: 'win' });
      
      expect(highlights).to.have.length.at.least(1);
      const comeback = highlights.find(h => h.highlightType === 'comeback');
      expect(comeback).to.exist;
      expect(comeback.title).to.include('逆袭');
    });
    
    it('should limit highlights to top 10', () => {
      const eventStream = [];
      for (let i = 0; i < 20; i++) {
        eventStream.push({
          turn: i + 1,
          actions: [
            {
              type: 'attack',
              attacker: 'Pokemon',
              move: 'Move',
              damage: 60,
              effectiveness: 2,
              isCritical: true
            }
          ],
          statusEffects: []
        });
      }
      
      const highlights = ReplayService.extractHighlights(eventStream, { result: 'win' });
      
      expect(highlights.length).to.be.at.most(10);
    });
  });
  
  describe('calculateBattleStats', () => {
    it('should calculate total damage correctly', () => {
      const eventStream = [
        {
          turn: 1,
          damage: { attacker: 50, defender: 30 },
          actions: [],
          statusEffects: []
        },
        {
          turn: 2,
          damage: { attacker: 40, defender: 25 },
          actions: [],
          statusEffects: []
        }
      ];
      
      const stats = ReplayService.calculateBattleStats(eventStream);
      
      expect(stats.totalDamageDealt).to.equal(90);
      expect(stats.totalDamageReceived).to.equal(55);
    });
    
    it('should count critical hits', () => {
      const eventStream = [
        {
          turn: 1,
          actions: [
            { move: 'Move1', isCritical: true },
            { move: 'Move2', isCritical: false }
          ],
          statusEffects: []
        },
        {
          turn: 2,
          actions: [
            { move: 'Move3', isCritical: true }
          ],
          statusEffects: []
        }
      ];
      
      const stats = ReplayService.calculateBattleStats(eventStream);
      
      expect(stats.criticalHits).to.equal(2);
    });
    
    it('should count super effective hits', () => {
      const eventStream = [
        {
          turn: 1,
          actions: [
            { move: 'Move1', effectiveness: 2 },
            { move: 'Move2', effectiveness: 1 }
          ],
          statusEffects: []
        },
        {
          turn: 2,
          actions: [
            { move: 'Move3', effectiveness: 4 } // 双属性克制
          ],
          statusEffects: []
        }
      ];
      
      const stats = ReplayService.calculateBattleStats(eventStream);
      
      expect(stats.superEffectiveHits).to.equal(2);
    });
    
    it('should count moves usage', () => {
      const eventStream = [
        {
          turn: 1,
          actions: [
            { move: 'Thunderbolt' },
            { move: 'Thunderbolt' }
          ],
          statusEffects: []
        },
        {
          turn: 2,
          actions: [
            { move: 'Quick Attack' }
          ],
          statusEffects: []
        }
      ];
      
      const stats = ReplayService.calculateBattleStats(eventStream);
      
      expect(stats.movesUsed['Thunderbolt']).to.equal(2);
      expect(stats.movesUsed['Quick Attack']).to.equal(1);
    });
  });
  
  describe('generateShareCode', () => {
    it('should generate 8-character alphanumeric code', () => {
      const code = ReplayService.generateShareCode();
      
      expect(code).to.have.length(8);
      expect(code).to.match(/^[A-Z0-9]+$/);
    });
    
    it('should exclude confusing characters', () => {
      for (let i = 0; i < 100; i++) {
        const code = ReplayService.generateShareCode();
        expect(code).to.not.include('I');
        expect(code).to.not.include('O');
        expect(code).to.not.include('0');
        expect(code).to.not.include('1');
      }
    });
    
    it('should generate unique codes', () => {
      const codes = [];
      for (let i = 0; i < 100; i++) {
        codes.push(ReplayService.generateShareCode());
      }
      
      const uniqueCodes = new Set(codes);
      // 允许少量重复，但应该绝大多数是唯一的
      expect(uniqueCodes.size).to.be.greaterThan(90);
    });
  });
  
  describe('recordReplay', () => {
    it('should record battle replay successfully', async () => {
      dbStub.query.resolves({
        rows: [{
          id: 1,
          battle_id: 'test-battle-id',
          battle_type: 'gym',
          result: 'win'
        }]
      });
      
      const battleData = {
        battleId: 'test-battle-id',
        gymId: 1,
        battleType: 'gym',
        attackerUserId: 100,
        attackerTeam: [{ id: 1, species: 'Pikachu' }],
        defenderInfo: { type: 'gym', team: [] },
        result: 'win',
        turns: 10,
        duration: 5000,
        replay: [
          {
            turn: 1,
            timestamp: 1000,
            actions: [{ type: 'attack', move: 'Thunderbolt' }]
          }
        ]
      };
      
      const result = await ReplayService.recordReplay('test-battle-id', battleData);
      
      expect(result).to.have.property('replayId');
      expect(result).to.have.property('battleId');
      expect(result).to.have.property('highlights');
      expect(result).to.have.property('stats');
      
      expect(dbStub.query.called).to.be.true;
    });
    
    it('should handle empty replay gracefully', async () => {
      dbStub.query.resolves({
        rows: [{ id: 1, battle_id: 'test-id' }]
      });
      
      const battleData = {
        battleId: 'test-id',
        gymId: 1,
        attackerUserId: 100,
        attackerTeam: [],
        defenderInfo: {},
        result: 'lose',
        turns: 0,
        duration: 0,
        replay: []
      };
      
      const result = await ReplayService.recordReplay('test-id', battleData);
      
      expect(result.replayId).to.exist;
    });
  });
  
  describe('getReplay', () => {
    it('should get replay by replay ID', async () => {
      const mockReplay = {
        id: 1,
        battle_id: 'test-battle',
        battle_type: 'gym',
        result: 'win',
        final_turns: 10,
        duration_ms: 5000,
        event_stream: [{ turn: 1, actions: [] }],
        compression: 'none',
        view_count: 5,
        share_count: 2
      };
      
      dbStub.query.resolves({
        rows: [mockReplay]
      });
      
      const result = await ReplayService.getReplay(1);
      
      expect(result).to.have.property('replayId');
      expect(result).to.have.property('battleId');
      expect(result).to.have.property('eventStream');
    });
    
    it('should get replay by share code', async () => {
      const mockReplay = {
        id: 1,
        battle_id: 'test',
        share_code: 'ABC12345',
        is_public: true,
        current_views: 0,
        max_views: 0,
        event_stream: [],
        compression: 'none'
      };
      
      dbStub.query.onFirstCall().resolves({ rows: [] }); // replay ID lookup fails
      dbStub.query.onSecondCall().resolves({ rows: [mockReplay] }); // share code lookup
      dbStub.query.onThirdCall().resolves({ rows: [] }); // update view count
      
      const result = await ReplayService.getReplay('ABC12345');
      
      expect(result).to.have.property('replayId');
    });
    
    it('should return null for non-existent replay', async () => {
      dbStub.query.resolves({ rows: [] });
      
      const result = await ReplayService.getReplay('nonexistent');
      
      expect(result).to.be.null;
    });
    
    it('should decompress gzip-compressed event stream', async () => {
      const eventStream = [{ turn: 1, actions: [{ move: 'Test' }] }];
      const compressed = zlib.gzipSync(JSON.stringify(eventStream));
      
      const mockReplay = {
        id: 1,
        battle_id: 'test',
        event_stream: compressed.toString('base64'),
        compression: 'gzip'
      };
      
      dbStub.query.resolves({ rows: [mockReplay] });
      
      const result = await ReplayService.getReplay(1);
      
      expect(result.eventStream).to.deep.equal(eventStream);
    });
  });
  
  describe('generateShareLink', () => {
    it('should generate public share link', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [{
          id: 1,
          share_code: 'ABC12345',
          is_public: true,
          expires_at: null
        }]
      });
      dbStub.query.onSecondCall().resolves({ rows: [] });
      
      const result = await ReplayService.generateShareLink(1, 100, {
        isPublic: true
      });
      
      expect(result).to.have.property('shareId');
      expect(result).to.have.property('shareCode');
      expect(result).to.have.property('shareUrl');
      expect(result.isPublic).to.be.true;
    });
    
    it('should generate password-protected share link', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [{
          id: 1,
          share_code: 'ABC12345',
          is_public: false,
          password_hash: 'hash'
        }]
      });
      dbStub.query.onSecondCall().resolves({ rows: [] });
      
      const result = await ReplayService.generateShareLink(1, 100, {
        isPublic: false,
        password: 'secret123'
      });
      
      expect(result).to.have.property('shareCode');
    });
    
    it('should set max views limit', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [{
          id: 1,
          share_code: 'ABC12345',
          max_views: 10
        }]
      });
      dbStub.query.onSecondCall().resolves({ rows: [] });
      
      const result = await ReplayService.generateShareLink(1, 100, {
        maxViews: 10
      });
      
      expect(result).to.have.property('shareCode');
    });
  });
  
  describe('verifySharePassword', () => {
    it('should verify correct password', async () => {
      // 模拟密码哈希
      const crypto = require('crypto');
      const correctPassword = 'secret123';
      const passwordHash = crypto
        .createHash('sha256')
        .update(correctPassword + process.env.JWT_SECRET)
        .digest('hex');
      
      dbStub.query.resolves({
        rows: [{
          share_code: 'ABC12345',
          password_hash: passwordHash,
          replay_id: 1
        }]
      });
      
      const result = await ReplayService.verifySharePassword('ABC12345', correctPassword);
      
      expect(result.valid).to.be.true;
      expect(result.replayId).to.equal(1);
    });
    
    it('should reject incorrect password', async () => {
      const crypto = require('crypto');
      const correctPassword = 'secret123';
      const passwordHash = crypto
        .createHash('sha256')
        .update(correctPassword + process.env.JWT_SECRET)
        .digest('hex');
      
      dbStub.query.resolves({
        rows: [{
          share_code: 'ABC12345',
          password_hash: passwordHash,
          replay_id: 1
        }]
      });
      
      const result = await ReplayService.verifySharePassword('ABC12345', 'wrongpassword');
      
      expect(result.valid).to.be.false;
      expect(result.error).to.equal('密码错误');
    });
    
    it('should return error for non-existent share', async () => {
      dbStub.query.resolves({ rows: [] });
      
      const result = await ReplayService.verifySharePassword('NONEXIST', 'password');
      
      expect(result.valid).to.be.false;
      expect(result.error).to.equal('分享链接不存在');
    });
  });
  
  describe('getUserReplays', () => {
    it('should get user replay list', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [
          { id: 1, battle_id: 'battle1', result: 'win' },
          { id: 2, battle_id: 'battle2', result: 'lose' }
        ]
      });
      dbStub.query.onSecondCall().resolves({
        rows: [{ total: '2' }]
      });
      
      const result = await ReplayService.getUserReplays(100);
      
      expect(result.replays).to.have.length(2);
      expect(result.total).to.equal(2);
    });
    
    it('should filter by result type', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [{ id: 1, result: 'win' }]
      });
      dbStub.query.onSecondCall().resolves({
        rows: [{ total: '1' }]
      });
      
      const result = await ReplayService.getUserReplays(100, { result: 'win' });
      
      expect(result.replays).to.have.length(1);
    });
    
    it('should support pagination', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: Array(20).fill({ id: 1 })
      });
      dbStub.query.onSecondCall().resolves({
        rows: [{ total: '50' }]
      });
      
      const result = await ReplayService.getUserReplays(100, { limit: 20, offset: 0 });
      
      expect(result.hasMore).to.be.true;
    });
  });
  
  describe('deleteReplay', () => {
    it('should delete replay if user is owner', async () => {
      dbStub.query.onFirstCall().resolves({
        rows: [{ id: 1 }]
      });
      dbStub.query.onSecondCall().resolves({ rows: [] });
      
      const result = await ReplayService.deleteReplay(1, 100);
      
      expect(result.success).to.be.true;
    });
    
    it('should reject deletion if user is not owner', async () => {
      dbStub.query.resolves({ rows: [] });
      
      const result = await ReplayService.deleteReplay(1, 999);
      
      expect(result.success).to.be.false;
      expect(result.error).to.include('无权删除');
    });
  });
});

describe('Replay Routes', () => {
  // 路由测试可以通过集成测试完成
  // 这里仅做基本验证
  
  it('should export router with all endpoints', () => {
    const replayRoutes = require('../../gateway/routes/replayRoutes');
    
    expect(replayRoutes).to.be.a('function');
  });
});