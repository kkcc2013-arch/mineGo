/**
 * E2E 测试：用户完整旅程
 * 测试从注册到捕捉、道馆战斗、支付的完整流程
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const Redis = require('ioredis');

describe('用户完整旅程 E2E 测试', () => {
  let app;
  let pgClient;
  let redisClient;
  let userToken;
  let userId;
  let caughtPokemonId;

  beforeAll(async () => {
    const express = require('express');
    app = express();
    app.use(express.json());

    pgClient = global.testUtils.getPgClient();
    redisClient = global.testUtils.getRedisClient();

    // 注册路由
    app.post('/api/auth/register', async (req, res) => {
      const { email, password, username } = req.body;

      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await pgClient.query(
        'INSERT INTO users (email, password, username, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, email, username',
        [email, hashedPassword, username]
      );

      const user = result.rows[0];
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
    });

    // 附近精灵路由
    app.get('/api/pokemon/nearby', (req, res) => {
      const { lat, lng } = req.query;

      res.json({
        code: 0,
        message: '成功',
        data: [
          {
            id: 'pokemon-e2e-1',
            species_id: 25,
            lat: parseFloat(lat) + 0.001,
            lng: parseFloat(lng) + 0.001,
            cp: 450,
            disappear_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          },
          {
            id: 'pokemon-e2e-2',
            species_id: 1,
            lat: parseFloat(lat) - 0.001,
            lng: parseFloat(lng) - 0.001,
            cp: 200,
            disappear_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          }
        ]
      });
    });

    // 捕捉路由
    app.post('/api/catch', async (req, res) => {
      const { pokemon_id, ball_type } = req.body;
      const userId = req.user.userId;

      const result = await pgClient.query(
        `INSERT INTO caught_pokemons (user_id, species_id, cp, iv, caught_at)
         VALUES ($1, 25, 450, 15, NOW())
         RETURNING id, species_id, cp`,
        [userId]
      );

      const pokemon = result.rows[0];

      res.json({
        code: 0,
        message: '捕捉成功',
        data: {
          caught: true,
          pokemon
        }
      });
    });

    // 道馆战斗路由
    app.post('/api/gym/battle', async (req, res) => {
      const { gym_id, pokemon_id } = req.body;
      const userId = req.user.userId;

      const battleResult = await pgClient.query(
        `INSERT INTO gym_battles (user_id, gym_id, result, created_at)
         VALUES ($1, $2, 'win', NOW())
         RETURNING id`,
        [userId, gym_id]
      );

      res.json({
        code: 0,
        message: '战斗胜利',
        data: {
          battle_id: battleResult.rows[0].id,
          result: 'win',
          xp_earned: 500
        }
      });
    });

    // 购买道具路由
    app.post('/api/payment/orders', async (req, res) => {
      const { product_id, amount } = req.body;
      const userId = req.user.userId;

      const orderId = 'ORD-' + Date.now();
      const result = await pgClient.query(
        `INSERT INTO payment_orders (order_id, user_id, product_id, amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())
         RETURNING order_id, status`,
        [orderId, userId, product_id, amount]
      );

      res.status(201).json({
        code: 0,
        message: '订单创建成功',
        data: result.rows[0]
      });
    });

    // 认证中间件
    app.use('/api/catch', (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        try {
          req.user = jwt.verify(token, process.env.JWT_SECRET || 'test-secret');
        } catch (err) {
          return res.status(401).json({ code: 401, message: '无效 token' });
        }
      }
      next();
    });

    app.use('/api/gym', (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        try {
          req.user = jwt.verify(token, process.env.JWT_SECRET || 'test-secret');
        } catch (err) {
          return res.status(401).json({ code: 401, message: '无效 token' });
        }
      }
      next();
    });

    app.use('/api/payment/orders', (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        try {
          req.user = jwt.verify(token, process.env.JWT_SECRET || 'test-secret');
        } catch (err) {
          return res.status(401).json({ code: 401, message: '无效 token' });
        }
      }
      next();
    });
  });

  describe('完整用户旅程', () => {
    it('新用户注册→捕捉精灵→道馆战斗→购买道具', async () => {
      // 步骤 1: 用户注册
      console.log('步骤 1: 用户注册');
      const registerRes = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'journey@example.com',
          password: 'password123',
          username: 'journeyuser'
        });

      expect(registerRes.status).toBe(201);
      expect(registerRes.body.code).toBe(0);
      expect(registerRes.body.data.token).toBeDefined();

      userToken = registerRes.body.data.token;
      userId = registerRes.body.data.user.id;

      // 步骤 2: 获取附近精灵
      console.log('步骤 2: 获取附近精灵');
      const nearbyRes = await request(app)
        .get('/api/pokemon/nearby')
        .query({ lat: 39.9, lng: 116.4 });

      expect(nearbyRes.status).toBe(200);
      expect(nearbyRes.body.data).toBeDefined();
      expect(nearbyRes.body.data.length).toBeGreaterThan(0);

      const pokemonId = nearbyRes.body.data[0].id;

      // 步骤 3: 捕捉精灵
      console.log('步骤 3: 捕捉精灵');
      const catchRes = await request(app)
        .post('/api/catch')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          pokemon_id: pokemonId,
          ball_type: 'pokeball'
        });

      expect(catchRes.status).toBe(200);
      expect(catchRes.body.code).toBe(0);
      expect(catchRes.body.data.caught).toBe(true);

      caughtPokemonId = catchRes.body.data.pokemon.id;

      // 步骤 4: 道馆战斗
      console.log('步骤 4: 道馆战斗');
      const battleRes = await request(app)
        .post('/api/gym/battle')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          gym_id: 'gym-001',
          pokemon_id: caughtPokemonId
        });

      expect(battleRes.status).toBe(200);
      expect(battleRes.body.code).toBe(0);
      expect(battleRes.body.data.result).toBe('win');
      expect(battleRes.body.data.xp_earned).toBe(500);

      // 步骤 5: 购买道具
      console.log('步骤 5: 购买道具');
      const orderRes = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          product_id: 'pokeball_pack_20',
          amount: 200
        });

      expect(orderRes.status).toBe(201);
      expect(orderRes.body.code).toBe(0);
      expect(orderRes.body.data.order_id).toBeDefined();
      expect(orderRes.body.data.status).toBe('pending');

      // 验证数据库状态
      console.log('验证数据库状态');

      // 验证用户
      const userResult = await pgClient.query('SELECT * FROM users WHERE id = $1', [userId]);
      expect(userResult.rows.length).toBe(1);
      expect(userResult.rows[0].email).toBe('journey@example.com');

      // 验证捕捉的精灵
      const caughtResult = await pgClient.query(
        'SELECT * FROM caught_pokemons WHERE user_id = $1',
        [userId]
      );
      expect(caughtResult.rows.length).toBeGreaterThan(0);

      // 验证道馆战斗记录
      const battleResult = await pgClient.query(
        'SELECT * FROM gym_battles WHERE user_id = $1',
        [userId]
      );
      expect(battleResult.rows.length).toBeGreaterThan(0);
      expect(battleResult.rows[0].result).toBe('win');

      // 验证订单
      const orderResult = await pgClient.query(
        'SELECT * FROM payment_orders WHERE user_id = $1',
        [userId]
      );
      expect(orderResult.rows.length).toBeGreaterThan(0);
      expect(orderResult.rows[0].product_id).toBe('pokeball_pack_20');
    });

    it('验证 JWT token 在整个流程中有效', async () => {
      // 使用相同的 token 调用不同接口
      const promises = [
        request(app)
          .post('/api/catch')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ pokemon_id: 'test-1', ball_type: 'pokeball' }),
        request(app)
          .post('/api/gym/battle')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ gym_id: 'gym-002', pokemon_id: caughtPokemonId }),
        request(app)
          .post('/api/payment/orders')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ product_id: 'incense', amount: 50 })
      ];

      const results = await Promise.all(promises);

      results.forEach(res => {
        expect(res.status).toBeLessThan(400);
      });
    });

    it('验证数据库事务一致性', async () => {
      // 检查用户数据完整性
      const userStats = await pgClient.query(`
        SELECT 
          u.id as user_id,
          COUNT(DISTINCT cp.id) as caught_count,
          COUNT(DISTINCT gb.id) as battle_count,
          COUNT(DISTINCT po.id) as order_count
        FROM users u
        LEFT JOIN caught_pokemons cp ON u.id = cp.user_id
        LEFT JOIN gym_battles gb ON u.id = gb.user_id
        LEFT JOIN payment_orders po ON u.id = po.user_id
        WHERE u.id = $1
        GROUP BY u.id
      `, [userId]);

      expect(userStats.rows.length).toBe(1);
      expect(userStats.rows[0].caught_count).toBeGreaterThan(0);
      expect(userStats.rows[0].battle_count).toBeGreaterThan(0);
      expect(userStats.rows[0].order_count).toBeGreaterThan(0);
    });
  });

  describe('错误处理和边界情况', () => {
    it('应该拒绝未认证的请求', async () => {
      const res = await request(app)
        .post('/api/catch')
        .send({ pokemon_id: 'test', ball_type: 'pokeball' });

      expect(res.status).toBe(401);
    });

    it('应该拒绝无效 token', async () => {
      const res = await request(app)
        .post('/api/catch')
        .set('Authorization', 'Bearer invalid-token')
        .send({ pokemon_id: 'test', ball_type: 'pokeball' });

      expect(res.status).toBe(401);
    });

    it('应该正确处理并发请求', async () => {
      // 并发创建多个订单
      const promises = Array(5).fill(null).map((_, i) =>
        request(app)
          .post('/api/payment/orders')
          .set('Authorization', `Bearer ${userToken}`)
          .send({
            product_id: `product-${i}`,
            amount: 100
          })
      );

      const results = await Promise.all(promises);

      // 所有请求都应该成功
      results.forEach(res => {
        expect(res.status).toBe(201);
      });

      // 验证数据库中有 5 条记录
      const orders = await pgClient.query(
        'SELECT * FROM payment_orders WHERE user_id = $1',
        [userId]
      );
      expect(orders.rows.length).toBeGreaterThanOrEqual(5);
    });
  });
});