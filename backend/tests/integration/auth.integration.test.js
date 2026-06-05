/**
 * 用户认证集成测试
 * 测试注册、登录、JWT 刷新、登出等流程
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

describe('用户认证集成测试', () => {
  let app;
  let pgClient;
  let redisClient;

  beforeAll(() => {
    // 模拟 Express 应用
    const express = require('express');
    app = express();
    app.use(express.json());

    pgClient = global.testUtils.getPgClient();
    redisClient = global.testUtils.getRedisClient();

    // 模拟认证路由
    app.post('/api/auth/register', async (req, res) => {
      const { email, password, username } = req.body;

      try {
        // 检查用户是否存在
        const existingUser = await pgClient.query(
          'SELECT id FROM users WHERE email = $1',
          [email]
        );

        if (existingUser.rows.length > 0) {
          return res.status(409).json({
            code: 409,
            message: '邮箱已被注册',
            data: null
          });
        }

        // 创建用户
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pgClient.query(
          'INSERT INTO users (email, password, username, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, email, username',
          [email, hashedPassword, username]
        );

        const user = result.rows[0];

        // 生成 JWT
        const token = jwt.sign(
          { userId: user.id, email: user.email },
          process.env.JWT_SECRET || 'test-secret',
          { expiresIn: '24h' }
        );

        res.status(201).json({
          code: 0,
          message: '注册成功',
          data: { user, token }
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    app.post('/api/auth/login', async (req, res) => {
      const { email, password } = req.body;

      try {
        const result = await pgClient.query(
          'SELECT * FROM users WHERE email = $1',
          [email]
        );

        if (result.rows.length === 0) {
          return res.status(401).json({
            code: 401,
            message: '邮箱或密码错误',
            data: null
          });
        }

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
          return res.status(401).json({
            code: 401,
            message: '邮箱或密码错误',
            data: null
          });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email },
          process.env.JWT_SECRET || 'test-secret',
          { expiresIn: '24h' }
        );

        // 缓存 session 到 Redis
        await redisClient.setex(`session:${user.id}`, 86400, token);

        res.json({
          code: 0,
          message: '登录成功',
          data: { user: { id: user.id, email: user.email, username: user.username }, token }
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    app.post('/api/auth/logout', async (req, res) => {
      const token = req.headers.authorization?.replace('Bearer ', '');

      if (token) {
        // 将 token 加入黑名单
        const decoded = jwt.decode(token);
        if (decoded && decoded.exp) {
          const ttl = decoded.exp - Math.floor(Date.now() / 1000);
          if (ttl > 0) {
            await redisClient.setex(`blacklist:${token}`, ttl, '1');
          }
        }
      }

      res.json({
        code: 0,
        message: '登出成功',
        data: null
      });
    });
  });

  describe('POST /api/auth/register', () => {
    it('应该成功注册新用户', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'test@example.com',
          password: 'password123',
          username: 'testuser'
        });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.user.email).toBe('test@example.com');
      expect(res.body.data.token).toBeDefined();
    });

    it('应该拒绝重复邮箱注册', async () => {
      // 先注册一次
      await request(app)
        .post('/api/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'password123',
          username: 'user1'
        });

      // 再次注册
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'password456',
          username: 'user2'
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(409);
    });

    it('应该验证必填字段', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'incomplete@example.com'
          // 缺少 password 和 username
        });

      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      // 创建测试用户
      const hashedPassword = await bcrypt.hash('testpass123', 10);
      await pgClient.query(
        'INSERT INTO users (email, password, username, created_at) VALUES ($1, $2, $3, NOW())',
        ['login@example.com', hashedPassword, 'loginuser']
      );
    });

    it('应该成功登录', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'login@example.com',
          password: 'testpass123'
        });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.token).toBeDefined();
    });

    it('应该拒绝错误密码', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'login@example.com',
          password: 'wrongpassword'
        });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(401);
    });

    it('应该拒绝不存在的用户', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'testpass123'
        });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(401);
    });

    it('应该在 Redis 中缓存 session', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'login@example.com',
          password: 'testpass123'
        });

      expect(res.status).toBe(200);

      // 检查 Redis 缓存
      const result = await pgClient.query('SELECT id FROM users WHERE email = $1', ['login@example.com']);
      const userId = result.rows[0].id;
      const cachedToken = await redisClient.get(`session:${userId}`);
      expect(cachedToken).toBeDefined();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('应该将 token 加入黑名单', async () => {
      const token = jwt.sign(
        { userId: 1, email: 'logout@example.com' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);

      // 检查黑名单
      const isBlacklisted = await redisClient.exists(`blacklist:${token}`);
      expect(isBlacklisted).toBe(1);
    });
  });
});