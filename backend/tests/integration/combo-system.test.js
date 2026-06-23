/**
 * 连击系统集成测试
 */

const chai = require('chai');
const { expect } = chai;
const request = require('supertest');
const app = require('../../../gym-service/src/index'); // 假设的 app 入口
const sinon = require('sinon');

describe('Combo System Integration Tests', () => {
  let authToken;
  let testUserId;

  before(async () => {
    // 获取测试用户 token
    authToken = 'test-auth-token';
    testUserId = 'test-user-123';
  });

  describe('GET /api/v1/combos', () => {
    it('should return available combos for user', async () => {
      const response = await request(app)
        .get('/api/v1/combos')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data).to.be.an('array');
      expect(response.body.total).to.be.a('number');
    });

    it('should return combos with stats when requested', async () => {
      const response = await request(app)
        .get('/api/v1/combos?includeStats=true')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data[0].stats).to.exist;
    });
  });

  describe('GET /api/v1/combos/:chainId', () => {
    it('should return combo details', async () => {
      const response = await request(app)
        .get('/api/v1/combos/THUNDER_TRINITY')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data.chain_id).to.equal('THUNDER_TRINITY');
      expect(response.body.data.trigger_sequence).to.be.an('array');
      expect(response.body.data.rank).to.exist;
    });

    it('should return 404 for non-existent combo', async () => {
      const response = await request(app)
        .get('/api/v1/combos/INVALID_COMBO')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).to.be.false;
      expect(response.body.error).to.equal('Combo not found');
    });
  });

  describe('GET /api/v1/combos/my/stats', () => {
    it('should return user combo statistics', async () => {
      const response = await request(app)
        .get('/api/v1/combos/my/stats')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data).to.be.an('array');
    });
  });

  describe('GET /api/v1/combos/leaderboard', () => {
    it('should return combo leaderboard', async () => {
      const response = await request(app)
        .get('/api/v1/combos/leaderboard')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data).to.be.an('array');
      expect(response.body.filters).to.exist;
    });

    it('should filter leaderboard by chain and period', async () => {
      const response = await request(app)
        .get('/api/v1/combos/leaderboard?chainId=THUNDER_TRINITY&period=weekly')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.filters.chainId).to.equal('THUNDER_TRINITY');
      expect(response.body.filters.period).to.equal('weekly');
    });
  });

  describe('POST /api/v1/combos/:chainId/practice', () => {
    it('should start practice session', async () => {
      const response = await request(app)
        .post('/api/v1/combos/THUNDER_TRINITY/practice')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ pokemonId: 'pokemon-456' })
        .expect(200);

      expect(response.body.success).to.be.true;
      expect(response.body.data.combo).to.exist;
      expect(response.body.data.instructions).to.be.a('string');
    });

    it('should return 403 if level too low', async () => {
      const response = await request(app)
        .post('/api/v1/combos/FIRE_STORM/practice')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ pokemonId: 'pokemon-456' })
        .expect(403);

      expect(response.body.success).to.be.false;
      expect(response.body.error).to.include('level');
    });

    it('should return 400 if pokemon ID missing', async () => {
      const response = await request(app)
        .post('/api/v1/combos/THUNDER_TRINITY/practice')
        .set('Authorization', `Bearer ${authToken}`)
        .send({})
        .expect(400);

      expect(response.body.success).to.be.false;
      expect(response.body.error).to.include('Pokemon ID');
    });
  });

  describe('Battle Integration', () => {
    it('should trigger combo in battle', async () => {
      // 模拟战斗中释放技能
      const response = await request(app)
        .post('/api/v1/battle/skill')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          battleId: 'battle-123',
          pokemonId: 'pokemon-456',
          skillId: 'THUNDERBOLT'
        })
        .expect(200);

      // 如果之前释放了正确的技能序列，应该触发连击
      if (response.body.comboTriggered) {
        expect(response.body.combo).to.exist;
        expect(response.body.effect.damageMultiplier).to.be.at.least(1.0);
      }
    });
  });
});
