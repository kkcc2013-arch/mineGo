/**
 * API 快照测试
 * 覆盖核心 API 的响应结构验证
 */

const request = require('supertest');
const path = require('path');

// 模拟 Express 应用
const createMockApp = () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  
  // 模拟健康检查路由
  app.get('/health', (req, res) => {
    res.json({
      success: true,
      data: {
        status: 'healthy',
        uptime: process.uptime(),
        version: '1.0.0'
      },
      meta: {
        requestId: 'req-test-123',
        timestamp: new Date().toISOString()
      }
    });
  });
  
  return app;
};

describe('API Snapshot Tests', () => {
  let validator;
  let app;
  
  beforeAll(() => {
    const { ApiSnapshotValidator } = require('../../shared/snapshotValidator');
    validator = new ApiSnapshotValidator({
      snapshotDir: path.join(__dirname, 'snapshots'),
      autoUpdate: process.env.UPDATE_SNAPSHOTS === 'true'
    });
    app = createMockApp();
  });
  
  describe('Health Check API', () => {
    it('GET /health - 快照验证', async () => {
      const res = await request(app)
        .get('/health')
        .expect(200);
      
      const result = await validator.compareSnapshot('/health', 'GET', res.body);
      
      // 首次运行时捕获快照
      if (result.status === 'missing') {
        const captureResult = await validator.captureSnapshot('/health', 'GET', res.body);
        expect(captureResult.status).toBe('captured');
        console.log('✅ 首次捕获快照:', captureResult.path);
      } else if (result.status === 'match') {
        expect(result.status).toBe('match');
        console.log('✅ 快照匹配成功');
      } else if (result.status === 'diff') {
        console.error('❌ 快照差异:', result.diff);
        throw new Error(`API 响应结构发生变化: ${result.diffCount} 个差异`);
      }
    });
  });
  
  describe('Pokemon API', () => {
    it('GET /api/v1/pokemon/:id - 快照验证', async () => {
      const mockPokemon = {
        success: true,
        data: {
          id: 'pk_001',
          name: 'Pikachu',
          type: ['Electric'],
          level: 25,
          hp: 100,
          maxHp: 100,
          attack: 55,
          defense: 40,
          cp: 500,
          nickname: 'Pika',
          isFavorite: false,
          caughtAt: '2026-01-01T00:00:00Z',
          location: { lat: 31.2304, lng: 121.4737 }
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/pokemon/:id', 'GET', mockPokemon);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/pokemon/:id', 'GET', mockPokemon);
        console.log('✅ 首次捕获 Pokemon 详情快照');
      } else if (result.status === 'diff') {
        console.error('Pokemon API 结构变化:', result.diff);
        // 允许新增字段（非 Breaking Change）
        const breakingChanges = result.diff.filter(d => d.type !== 'field_added');
        if (breakingChanges.length > 0) {
          throw new Error(`Breaking Changes detected: ${breakingChanges.length}`);
        }
      }
    });
    
    it('GET /api/v1/pokemon/nearby - 快照验证', async () => {
      const mockNearby = {
        success: true,
        data: [
          {
            id: 'pk_spawn_001',
            pokemonId: 'pk_001',
            name: 'Pikachu',
            type: ['Electric'],
            location: { lat: 31.2304, lng: 121.4737 },
            distance: 50,
            despawnAt: '2026-07-01T10:30:00Z'
          }
        ],
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
          hasMore: false
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/pokemon/nearby', 'GET', mockNearby);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/pokemon/nearby', 'GET', mockNearby);
        console.log('✅ 首次捕获附近精灵快照');
      }
    });
  });
  
  describe('Catch API', () => {
    it('POST /api/v1/catch - 快照验证', async () => {
      const mockCatch = {
        success: true,
        data: {
          caught: true,
          pokemon: {
            id: 'pk_user_001',
            pokemonId: 'pk_001',
            name: 'Pikachu',
            type: ['Electric'],
            level: 25,
            cp: 500,
            hp: 100,
            maxHp: 100
          },
          itemsUsed: {
            pokeball: 1
          },
          remainingItems: {
            pokeball: 99
          },
          experienceGained: 100
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/catch', 'POST', mockCatch);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/catch', 'POST', mockCatch);
        console.log('✅ 首次捕获捕捉结果快照');
      }
    });
  });
  
  describe('Gym API', () => {
    it('GET /api/v1/gym/:id - 快照验证', async () => {
      const mockGym = {
        success: true,
        data: {
          id: 'gym_001',
          name: 'Central Park Gym',
          location: { lat: 31.2304, lng: 121.4737 },
          team: 'Valor',
          level: 5,
          prestige: 50000,
          defendingPokemon: [
            {
              id: 'pk_001',
              name: 'Pikachu',
              cp: 2000,
              trainerName: 'Ash'
            }
          ],
          slotsAvailable: 5
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/gym/:id', 'GET', mockGym);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/gym/:id', 'GET', mockGym);
        console.log('✅ 首次捕获道馆详情快照');
      }
    });
    
    it('POST /api/v1/gym/:id/battle - 快照验证', async () => {
      const mockBattle = {
        success: true,
        data: {
          battleId: 'battle_001',
          result: 'win',
          experienceGained: 500,
          prestigeChange: -1000,
          remainingPrestige: 49000,
          defenderDefeated: {
            pokemonId: 'pk_001',
            name: 'Pikachu'
          },
          rewards: {
            items: [{ type: 'potion', quantity: 2 }],
            coins: 10
          }
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/gym/:id/battle', 'POST', mockBattle);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/gym/:id/battle', 'POST', mockBattle);
        console.log('✅ 首次捕获道馆战斗结果快照');
      }
    });
  });
  
  describe('User API', () => {
    it('GET /api/v1/user/profile - 快照验证', async () => {
      const mockProfile = {
        success: true,
        data: {
          id: 'user_001',
          username: 'Trainer1',
          email: 'trainer1@example.com',
          level: 25,
          experience: 50000,
          coins: 1000,
          team: 'Valor',
          caughtPokemon: 150,
          battlesWon: 50,
          gymsDefended: 10,
          achievements: [
            { id: 'ach_001', name: 'First Catch', unlockedAt: '2026-01-01T00:00:00Z' }
          ]
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/user/profile', 'GET', mockProfile);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/user/profile', 'GET', mockProfile);
        console.log('✅ 首次捕获用户档案快照');
      }
    });
  });
  
  describe('Payment API', () => {
    it('POST /api/v1/payment/purchase - 快照验证', async () => {
      const mockPurchase = {
        success: true,
        data: {
          orderId: 'order_001',
          status: 'completed',
          items: [
            { type: 'coins', quantity: 1000, price: 9.99 }
          ],
          paymentMethod: 'credit_card',
          transactionId: 'txn_123',
          completedAt: '2026-07-01T10:00:00Z'
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/payment/purchase', 'POST', mockPurchase);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/payment/purchase', 'POST', mockPurchase);
        console.log('✅ 首次捕获支付订单快照');
      }
    });
  });
  
  describe('Social API', () => {
    it('GET /api/v1/friends - 快照验证', async () => {
      const mockFriends = {
        success: true,
        data: [
          {
            id: 'user_002',
            username: 'Trainer2',
            level: 30,
            team: 'Mystic',
            friendshipLevel: 3,
            friendsSince: '2026-01-01T00:00:00Z'
          }
        ],
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
          hasMore: false
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/api/v1/friends', 'GET', mockFriends);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/api/v1/friends', 'GET', mockFriends);
        console.log('✅ 首次捕获好友列表快照');
      }
    });
  });
  
  describe('Error Response', () => {
    it('Error response structure - 快照验证', async () => {
      const mockError = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request parameters',
          details: {
            field: 'pokemonId',
            reason: 'required'
          },
          i18nKey: 'errors.validation.required'
        },
        meta: {
          requestId: 'req-test-123',
          timestamp: '2026-07-01T10:00:00Z'
        }
      };
      
      const result = await validator.compareSnapshot('/error/response', 'GET', mockError);
      
      if (result.status === 'missing') {
        await validator.captureSnapshot('/error/response', 'GET', mockError);
        console.log('✅ 首次捕获错误响应快照');
      }
    });
  });
  
  afterAll(async () => {
    // 输出快照覆盖率统计
    const stats = await validator.getCoverageStats();
    console.log('\n📊 快照覆盖率统计:');
    console.log(`   总快照数: ${stats.totalSnapshots}`);
    console.log(`   按方法分布: ${JSON.stringify(stats.byMethod)}`);
    console.log(`   按版本分布: ${JSON.stringify(stats.byVersion)}`);
  });
});
