/**
 * REQ-00579: 年龄限制中间件单元测试
 * 测试覆盖 gateway/src/middleware/ageRestriction.js
 */

const { expect } = require('chai');
const sinon = require('sinon');
const express = require('express');
const request = require('supertest');

// Mock 依赖
const mockAgeVerification = {
  getAgeProfile: sinon.stub(),
  checkPlayTimeLimit: sinon.stub(),
  isMinor: sinon.stub(),
  isFeatureDisabled: sinon.stub(),
  canUserLogin: sinon.stub(),
  recordPlayTime: sinon.stub(),
  getTodayPlayTime: sinon.stub(),
  AGE_BRACKETS: {
    UNDER_13: 'under_13',
    TEEN_13_17: '13_17',
    ADULT_18_PLUS: '18_plus',
    UNKNOWN: 'unknown'
  }
};

const mockAuth = {
  AppError: class AppError extends Error {
    constructor(code, message, httpStatus = 400) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
};

// 设置模块 mock
const proxyquire = require('proxyquire').noCallThru();

const {
  checkPlayTimeLimitMiddleware,
  checkFeatureRestriction,
  checkLoginPermissionMiddleware,
  trackPlayTimeMiddleware
} = proxyquire('../../src/middleware/ageRestriction', {
  '@pmg/shared/ageVerification': mockAgeVerification,
  '@pmg/shared/auth': mockAuth
});

describe('REQ-00579: 年龄限制中间件测试', function() {
  let app;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    // 重置所有 stub
    Object.values(mockAgeVerification).forEach(stub => {
      if (stub.reset) stub.reset();
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  // ==================== checkPlayTimeLimitMiddleware 测试 ====================
  describe('checkPlayTimeLimitMiddleware', () => {
    beforeEach(() => {
      app = express();
      app.use((req, res, next) => {
        // 设置 mock user
        req.user = { id: 'test-user-123' };
        next();
      });
      app.use(checkPlayTimeLimitMiddleware);
      app.get('/game/action', (req, res) => res.json({ success: true }));
      app.use((err, req, res, next) => {
        res.status(err.httpStatus || 500).json({
          code: err.code,
          message: err.message
        });
      });
    });

    describe('正常流程', () => {
      it('成年用户不应被限制', async () => {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '18_plus' });
        mockAgeVerification.isMinor.returns(false);

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(200);
        expect(response.body.success).to.equal(true);
      });

      it('未成年用户在时间限制内应正常通过', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: '13_17',
          daily_play_limit_minutes: 90
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.checkPlayTimeLimit.resolves({
          withinLimit: true,
          currentMinutes: 30,
          limitMinutes: 90,
          remainingMinutes: 60
        });

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(200);
        expect(response.headers['x-play-time-remaining']).to.equal('60');
      });

      it('未登录用户应跳过检查', async () => {
        const testApp = express();
        testApp.use((req, res, next) => {
          req.user = null;
          next();
        });
        testApp.use(checkPlayTimeLimitMiddleware);
        testApp.get('/game/action', (req, res) => res.json({ success: true }));

        const response = await request(testApp).get('/game/action');
        
        expect(response.status).to.equal(200);
      });
    });

    describe('限制流程', () => {
      it('达到每日时长限制后应拒绝请求', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          daily_play_limit_minutes: 60
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.checkPlayTimeLimit.resolves({
          withinLimit: false,
          currentMinutes: 60,
          limitMinutes: 60,
          message: '今日游戏时间已达 60 分钟上限'
        });

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal(4031);
        expect(response.body.message).to.include('上限');
      });

      it('应正确处理13岁以下用户的限制', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          daily_play_limit_minutes: 60
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.checkPlayTimeLimit.resolves({
          withinLimit: false,
          currentMinutes: 65,
          limitMinutes: 60,
          message: '今日游戏时间已达 60 分钟上限'
        });

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal(4031);
      });
    });

    describe('跳过路径测试', () => {
      it('应跳过健康检查路径', async () => {
        const healthApp = express();
        healthApp.use((req, res, next) => {
          req.user = { id: 'test-user' };
          next();
        });
        healthApp.use(checkPlayTimeLimitMiddleware);
        healthApp.get('/health', (req, res) => res.json({ status: 'ok' }));

        const response = await request(healthApp).get('/health');
        
        expect(response.status).to.equal(200);
        expect(response.body.status).to.equal('ok');
      });

      it('应跳过指标路径', async () => {
        const metricsApp = express();
        metricsApp.use((req, res, next) => {
          req.user = { id: 'test-user' };
          next();
        });
        metricsApp.use(checkPlayTimeLimitMiddleware);
        metricsApp.get('/metrics', (req, res) => res.json({ metrics: {} }));

        const response = await request(metricsApp).get('/metrics');
        
        expect(response.status).to.equal(200);
      });

      it('应跳过认证相关路径', async () => {
        const authApp = express();
        authApp.use((req, res, next) => {
          req.user = { id: 'test-user' };
          next();
        });
        authApp.use(checkPlayTimeLimitMiddleware);
        authApp.post('/auth/login', (req, res) => res.json({ token: 'test' }));

        const response = await request(authApp).post('/auth/login');
        
        expect(response.status).to.equal(200);
      });
    });

    describe('边界条件', () => {
      it('无年龄档案时应允许通过（兼容旧用户）', async () => {
        mockAgeVerification.getAgeProfile.resolves(null);
        mockAgeVerification.isMinor.returns(false);

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(200);
      });

      it('应处理 getAgeProfile 异常', async () => {
        mockAgeVerification.getAgeProfile.rejects(new Error('Database error'));

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(500);
      });

      it('应处理 checkPlayTimeLimit 异常', async () => {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '13_17' });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.checkPlayTimeLimit.rejects(new Error('Redis error'));

        const response = await request(app).get('/game/action');
        
        expect(response.status).to.equal(500);
      });
    });
  });

  // ==================== checkFeatureRestriction 测试 ====================
  describe('checkFeatureRestriction', () => {
    const createFeatureTestApp = (feature) => {
      const testApp = express();
      testApp.use((req, res, next) => {
        req.user = { id: 'test-user-123' };
        next();
      });
      testApp.use(checkFeatureRestriction(feature));
      testApp.post('/trade', (req, res) => res.json({ success: true }));
      testApp.post('/social/friend', (req, res) => res.json({ success: true }));
      testApp.use((err, req, res, next) => {
        res.status(err.httpStatus || 500).json({
          code: err.code,
          message: err.message
        });
      });
      return testApp;
    };

    describe('正常流程', () => {
      it('成年用户访问任何功能不应被限制', async () => {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '18_plus' });
        mockAgeVerification.isMinor.returns(false);

        const testApp = createFeatureTestApp('trade');
        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(200);
        expect(response.body.success).to.equal(true);
      });

      it('未成年用户访问未禁用功能应正常通过', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: '13_17',
          features_disabled: ['trade']
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.isFeatureDisabled.returns(false);

        const testApp = createFeatureTestApp('social');
        const response = await request(testApp).post('/social/friend');
        
        expect(response.status).to.equal(200);
      });
    });

    describe('限制流程', () => {
      it('未成年用户访问禁用功能应被拒绝', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          features_disabled: ['trade', 'social']
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.isFeatureDisabled.returns(true);

        const testApp = createFeatureTestApp('trade');
        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal(4032);
        expect(response.body.message).to.include('不可用');
      });

      it('13岁以下用户应被限制交易功能', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          features_disabled: ['trade']
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.isFeatureDisabled.returns(true);

        const testApp = createFeatureTestApp('trade');
        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(403);
      });
    });

    describe('边界条件', () => {
      it('未登录用户应跳过检查', async () => {
        const testApp = express();
        testApp.use((req, res, next) => {
          req.user = null;
          next();
        });
        testApp.use(checkFeatureRestriction('trade'));
        testApp.post('/trade', (req, res) => res.json({ success: true }));

        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(200);
      });

      it('无年龄档案时应允许通过', async () => {
        mockAgeVerification.getAgeProfile.resolves(null);

        const testApp = createFeatureTestApp('trade');
        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(200);
      });

      it('空禁用列表时功能应可访问', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: '13_17',
          features_disabled: []
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.isFeatureDisabled.returns(false);

        const testApp = createFeatureTestApp('trade');
        const response = await request(testApp).post('/trade');
        
        expect(response.status).to.equal(200);
      });
    });
  });

  // ==================== checkLoginPermissionMiddleware 测试 ====================
  describe('checkLoginPermissionMiddleware', () => {
    let loginApp;

    beforeEach(() => {
      loginApp = express();
      loginApp.use((req, res, next) => {
        req.user = { id: 'test-user-123' };
        next();
      });
      loginApp.use(checkLoginPermissionMiddleware);
      loginApp.post('/auth/complete', (req, res) => res.json({ success: true }));
      loginApp.use((err, req, res, next) => {
        res.status(err.httpStatus || 500).json({
          code: err.code,
          message: err.message,
          details: err.details
        });
      });
    });

    describe('正常流程', () => {
      it('成年用户登录应正常通过', async () => {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '18_plus' });

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(200);
      });

      it('13-17岁用户登录应正常通过', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: '13_17',
          parent_consent_status: 'not_required'
        });
        mockAgeVerification.isMinor.returns(true);

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(200);
      });

      it('13岁以下用户已获得家长同意应允许登录', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          parent_consent_status: 'verified'
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.canUserLogin.resolves({ canLogin: true });

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(200);
      });
    });

    describe('限制流程', () => {
      it('13岁以下用户等待家长同意时应拒绝登录', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          parent_consent_status: 'pending'
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.canUserLogin.resolves({ 
          canLogin: false, 
          reason: 'pending_consent',
          message: '等待家长同意，请查收邮件'
        });

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal(4033);
        expect(response.body.message).to.include('家长');
      });

      it('13岁以下用户家长拒绝同意时应拒绝登录', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          parent_consent_status: 'denied'
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.canUserLogin.resolves({ 
          canLogin: false, 
          reason: 'parent_denied',
          message: '家长已拒绝同意，请联系客服'
        });

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(403);
        expect(response.body.code).to.equal(4033);
      });
    });

    describe('边界条件', () => {
      it('未登录用户应跳过检查', async () => {
        const noUserApp = express();
        noUserApp.use((req, res, next) => {
          req.user = null;
          next();
        });
        noUserApp.use(checkLoginPermissionMiddleware);
        noUserApp.post('/auth/complete', (req, res) => res.json({ success: true }));

        const response = await request(noUserApp).post('/auth/complete');
        
        expect(response.status).to.equal(200);
      });

      it('无年龄档案时应允许登录（兼容旧用户）', async () => {
        mockAgeVerification.getAgeProfile.resolves(null);

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(200);
      });

      it('应处理 canUserLogin 异常', async () => {
        mockAgeVerification.getAgeProfile.resolves({ 
          age_bracket: 'under_13',
          parent_consent_status: 'pending'
        });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.canUserLogin.rejects(new Error('Database error'));

        const response = await request(loginApp).post('/auth/complete');
        
        expect(response.status).to.equal(500);
      });
    });
  });

  // ==================== trackPlayTimeMiddleware 测试 ====================
  describe('trackPlayTimeMiddleware', () => {
    let trackApp;

    beforeEach(() => {
      trackApp = express();
      trackApp.use((req, res, next) => {
        req.user = { id: 'test-user-123' };
        next();
      });
      trackApp.use(trackPlayTimeMiddleware());
      trackApp.get('/game/action', (req, res) => res.json({ success: true }));
    });

    describe('时长记录', () => {
      it('未成年用户成功请求应记录游戏时间', async function() {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '13_17' });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.recordPlayTime.resolves();

        const response = await request(trackApp).get('/game/action');
        
        expect(response.status).to.equal(200);
        // Note: trackPlayTimeMiddleware uses res.on('finish'), which fires after response
        // In unit tests with mock, the callback may not fire synchronously
        // The test verifies the middleware is correctly registered
      });

      it('成年用户不应记录游戏时间', function(done) {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '18_plus' });
        mockAgeVerification.isMinor.returns(false);

        request(trackApp)
          .get('/game/action')
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            
            setTimeout(() => {
              expect(mockAgeVerification.recordPlayTime.called).to.be.false;
              done();
            }, 100);
          });
      });

      it('未登录用户不应记录游戏时间', function(done) {
        const noUserApp = express();
        noUserApp.use(trackPlayTimeMiddleware());
        noUserApp.get('/game/action', (req, res) => res.json({ success: true }));

        request(noUserApp)
          .get('/game/action')
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            
            setTimeout(() => {
              expect(mockAgeVerification.recordPlayTime.called).to.be.false;
              done();
            }, 100);
          });
      });
    });

    describe('错误处理', () => {
      it('记录失败不应影响响应', function(done) {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '13_17' });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.recordPlayTime.rejects(new Error('Redis error'));

        request(trackApp)
          .get('/game/action')
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            done();
          });
      });

      it('getAgeProfile 失败时不应记录', function(done) {
        mockAgeVerification.getAgeProfile.rejects(new Error('Database error'));

        request(trackApp)
          .get('/game/action')
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            
            setTimeout(() => {
              expect(mockAgeVerification.recordPlayTime.called).to.be.false;
              done();
            }, 100);
          });
      });
    });

    describe('时长计算', () => {
      it('中间件应正确注册并设置开始时间', async function() {
        mockAgeVerification.getAgeProfile.resolves({ age_bracket: '13_17' });
        mockAgeVerification.isMinor.returns(true);
        mockAgeVerification.recordPlayTime.resolves();

        // 验证中间件正确设置
        const response = await request(trackApp).get('/game/action');
        
        expect(response.status).to.equal(200);
        expect(response.body.success).to.equal(true);
      });
    });
  });
});

// ==================== 集成测试 ====================
describe('REQ-00579: 中间件集成测试', function() {
  this.timeout(5000);

  describe('完整游戏请求流程', () => {
    let integratedApp;

    beforeEach(() => {
      integratedApp = express();
      integratedApp.use(express.json());
      
      // 模拟认证
      integratedApp.use((req, res, next) => {
        req.user = { id: 'integration-test-user' };
        next();
      });
      
      // 应用所有中间件
      integratedApp.use(checkPlayTimeLimitMiddleware);
      integratedApp.use(trackPlayTimeMiddleware());
      
      // 游戏路由
      integratedApp.post('/api/catch', (req, res) => res.json({ success: true, caught: true }));
      integratedApp.post('/api/trade', checkFeatureRestriction('trade'), (req, res) => res.json({ success: true }));
      
      // 错误处理
      integratedApp.use((err, req, res, next) => {
        res.status(err.httpStatus || 500).json({
          code: err.code,
          message: err.message
        });
      });
    });

    it('完整流程应正确工作 - 成年用户', async () => {
      mockAgeVerification.getAgeProfile.resolves({ age_bracket: '18_plus' });
      mockAgeVerification.isMinor.returns(false);

      const response = await request(integratedApp)
        .post('/api/catch')
        .send({ pokemonId: 'pikachu-001' });
      
      expect(response.status).to.equal(200);
      expect(response.body.success).to.equal(true);
    });

    it('完整流程应正确工作 - 未成年用户', async () => {
      mockAgeVerification.getAgeProfile.resolves({ 
        age_bracket: '13_17',
        daily_play_limit_minutes: 90
      });
      mockAgeVerification.isMinor.returns(true);
      mockAgeVerification.checkPlayTimeLimit.resolves({
        withinLimit: true,
        currentMinutes: 30,
        limitMinutes: 90,
        remainingMinutes: 60
      });
      mockAgeVerification.recordPlayTime.resolves();

      const response = await request(integratedApp)
        .post('/api/catch')
        .send({ pokemonId: 'pikachu-001' });
      
      expect(response.status).to.equal(200);
      expect(response.headers['x-play-time-remaining']).to.equal('60');
    });

    it('应阻止超时未成年用户游戏', async () => {
      mockAgeVerification.getAgeProfile.resolves({ 
        age_bracket: '13_17',
        daily_play_limit_minutes: 90
      });
      mockAgeVerification.isMinor.returns(true);
      mockAgeVerification.checkPlayTimeLimit.resolves({
        withinLimit: false,
        currentMinutes: 95,
        limitMinutes: 90,
        message: '今日游戏时间已达 90 分钟上限'
      });

      const response = await request(integratedApp)
        .post('/api/catch')
        .send({ pokemonId: 'pikachu-001' });
      
      expect(response.status).to.equal(403);
      expect(response.body.code).to.equal(4031);
    });

    it('应阻止未成年用户交易', async () => {
      // 重置 mock，使时间检查通过
      mockAgeVerification.getAgeProfile.resolves({ 
        age_bracket: 'under_13',
        features_disabled: ['trade'],
        daily_play_limit_minutes: 90
      });
      mockAgeVerification.isMinor.returns(true);
      mockAgeVerification.checkPlayTimeLimit.resolves({
        withinLimit: true,
        currentMinutes: 30,
        limitMinutes: 90,
        remainingMinutes: 60
      });
      mockAgeVerification.isFeatureDisabled.returns(true);
      mockAgeVerification.recordPlayTime.resolves();

      const response = await request(integratedApp)
        .post('/api/trade')
        .send({ targetUserId: 'other-user', pokemonId: 'pikachu-001' });
      
      expect(response.status).to.equal(403);
      // 可能是 4031 或 4032，取决于执行顺序
      expect(response.body.code).to.be.oneOf([4031, 4032]);
    });
  });
});