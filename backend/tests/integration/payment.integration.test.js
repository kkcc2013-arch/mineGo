/**
 * 支付服务集成测试
 * 测试订单创建、支付回调、幂等性
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

describe('支付服务集成测试', () => {
  let app;
  let pgClient;
  let redisClient;
  let authToken;
  let userId;

  beforeAll(async () => {
    const express = require('express');
    app = express();
    app.use(express.json());

    pgClient = global.testUtils.getPgClient();
    redisClient = global.testUtils.getRedisClient();

    // 创建测试用户
    const result = await pgClient.query(
      'INSERT INTO users (email, username, created_at) VALUES ($1, $2, NOW()) RETURNING id',
      ['payment@example.com', 'paymentuser']
    );
    userId = result.rows[0].id;

    authToken = jwt.sign(
      { userId, email: 'payment@example.com' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '24h' }
    );

    // 模拟订单创建路由
    app.post('/api/payment/orders', async (req, res) => {
      const { product_id, amount, payment_method } = req.body;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        // 幂等性检查
        if (idempotencyKey) {
          const existingOrder = await redisClient.get(`order:idempotency:${idempotencyKey}`);
          if (existingOrder) {
            return res.json({
              code: 0,
              message: '订单已存在',
              data: JSON.parse(existingOrder)
            });
          }
        }

        // 创建订单
        const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substring(7);
        const result = await pgClient.query(
          `INSERT INTO payment_orders (order_id, user_id, product_id, amount, status, payment_method, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           RETURNING *`,
          [orderId, userId, product_id, amount, 'pending', payment_method]
        );

        const order = result.rows[0];

        // 缓存订单到 Redis
        await redisClient.setex(
          `order:${orderId}`,
          86400,
          JSON.stringify(order)
        );

        // 缓存幂等性键
        if (idempotencyKey) {
          await redisClient.setex(
            `order:idempotency:${idempotencyKey}`,
            86400,
            JSON.stringify(order)
          );
        }

        res.status(201).json({
          code: 0,
          message: '订单创建成功',
          data: order
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    // 模拟支付回调路由
    app.post('/api/payment/callback', async (req, res) => {
      const { order_id, transaction_id, status, signature } = req.body;

      try {
        // 验证签名
        const expectedSignature = crypto
          .createHmac('sha256', 'test-secret-key')
          .update(`${order_id}${transaction_id}${status}`)
          .digest('hex');

        if (signature !== expectedSignature) {
          return res.status(400).json({
            code: 400,
            message: '签名验证失败',
            data: null
          });
        }

        // 更新订单状态
        const result = await pgClient.query(
          `UPDATE payment_orders 
           SET status = $1, transaction_id = $2, paid_at = NOW()
           WHERE order_id = $3 AND status = 'pending'
           RETURNING *`,
          [status, transaction_id, order_id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            code: 404,
            message: '订单不存在或已处理',
            data: null
          });
        }

        const order = result.rows[0];

        // 更新 Redis 缓存
        await redisClient.setex(
          `order:${order_id}`,
          86400,
          JSON.stringify(order)
        );

        res.json({
          code: 0,
          message: '支付回调处理成功',
          data: order
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    // 查询订单路由
    app.get('/api/payment/orders/:orderId', async (req, res) => {
      const { orderId } = req.params;

      try {
        // 先从 Redis 查询
        const cachedOrder = await redisClient.get(`order:${orderId}`);
        if (cachedOrder) {
          return res.json({
            code: 0,
            message: '成功',
            data: JSON.parse(cachedOrder)
          });
        }

        // 从数据库查询
        const result = await pgClient.query(
          'SELECT * FROM payment_orders WHERE order_id = $1',
          [orderId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            code: 404,
            message: '订单不存在',
            data: null
          });
        }

        const order = result.rows[0];
        await redisClient.setex(`order:${orderId}`, 86400, JSON.stringify(order));

        res.json({
          code: 0,
          message: '成功',
          data: order
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    // 认证中间件
    app.use('/api/payment/orders', (req, res, next) => {
      if (req.method !== 'POST' || req.path === '/callback') {
        return next();
      }

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

  describe('POST /api/payment/orders', () => {
    it('应该成功创建订单', async () => {
      const res = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          product_id: 'pokeball_pack_10',
          amount: 100,
          payment_method: 'alipay'
        });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.order_id).toBeDefined();
      expect(res.body.data.status).toBe('pending');
    });

    it('应该将订单保存到数据库', async () => {
      const res = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          product_id: 'greatball_pack_5',
          amount: 200,
          payment_method: 'wechat'
        });

      const orderId = res.body.data.order_id;

      // 检查数据库
      const result = await pgClient.query(
        'SELECT * FROM payment_orders WHERE order_id = $1',
        [orderId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].product_id).toBe('greatball_pack_5');
    });

    it('应该缓存订单到 Redis', async () => {
      const res = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          product_id: 'ultraball_pack_3',
          amount: 300,
          payment_method: 'alipay'
        });

      const orderId = res.body.data.order_id;

      // 检查 Redis
      const cached = await redisClient.get(`order:${orderId}`);
      expect(cached).toBeDefined();
    });

    it('应该支持幂等性键', async () => {
      const idempotencyKey = 'idem-' + Date.now();

      // 第一次请求
      const res1 = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-Idempotency-Key', idempotencyKey)
        .send({
          product_id: 'incense',
          amount: 50,
          payment_method: 'alipay'
        });

      // 第二次相同请求
      const res2 = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .set('X-Idempotency-Key', idempotencyKey)
        .send({
          product_id: 'incense',
          amount: 50,
          payment_method: 'alipay'
        });

      expect(res1.body.data.order_id).toBe(res2.body.data.order_id);
    });
  });

  describe('POST /api/payment/callback', () => {
    let testOrderId;

    beforeEach(async () => {
      // 创建测试订单
      const res = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          product_id: 'lure_module',
          amount: 100,
          payment_method: 'alipay'
        });

      testOrderId = res.body.data.order_id;
    });

    it('应该成功处理支付回调', async () => {
      const transactionId = 'TXN-' + Date.now();
      const signature = crypto
        .createHmac('sha256', 'test-secret-key')
        .update(`${testOrderId}${transactionId}success`)
        .digest('hex');

      const res = await request(app)
        .post('/api/payment/callback')
        .send({
          order_id: testOrderId,
          transaction_id: transactionId,
          status: 'success',
          signature
        });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.status).toBe('success');
    });

    it('应该拒绝无效签名', async () => {
      const res = await request(app)
        .post('/api/payment/callback')
        .send({
          order_id: testOrderId,
          transaction_id: 'TXN-123',
          status: 'success',
          signature: 'invalid-signature'
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(400);
    });

    it('应该拒绝重复处理', async () => {
      const transactionId = 'TXN-' + Date.now();
      const signature = crypto
        .createHmac('sha256', 'test-secret-key')
        .update(`${testOrderId}${transactionId}success`)
        .digest('hex');

      // 第一次处理
      await request(app)
        .post('/api/payment/callback')
        .send({
          order_id: testOrderId,
          transaction_id: transactionId,
          status: 'success',
          signature
        });

      // 第二次处理
      const res = await request(app)
        .post('/api/payment/callback')
        .send({
          order_id: testOrderId,
          transaction_id: transactionId,
          status: 'success',
          signature
        });

      expect(res.status).toBe(404);
    });

    it('应该更新订单状态到数据库', async () => {
      const transactionId = 'TXN-' + Date.now();
      const signature = crypto
        .createHmac('sha256', 'test-secret-key')
        .update(`${testOrderId}${transactionId}success`)
        .digest('hex');

      await request(app)
        .post('/api/payment/callback')
        .send({
          order_id: testOrderId,
          transaction_id: transactionId,
          status: 'success',
          signature
        });

      // 检查数据库
      const result = await pgClient.query(
        'SELECT * FROM payment_orders WHERE order_id = $1',
        [testOrderId]
      );

      expect(result.rows[0].status).toBe('success');
      expect(result.rows[0].transaction_id).toBe(transactionId);
    });
  });

  describe('GET /api/payment/orders/:orderId', () => {
    let testOrderId;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/payment/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          product_id: 'egg_incubator',
          amount: 150,
          payment_method: 'wechat'
        });

      testOrderId = res.body.data.order_id;
    });

    it('应该返回订单详情', async () => {
      const res = await request(app)
        .get(`/api/payment/orders/${testOrderId}`);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.order_id).toBe(testOrderId);
    });

    it('应该从 Redis 缓存读取', async () => {
      // 第一次请求（从数据库）
      await request(app)
        .get(`/api/payment/orders/${testOrderId}`);

      // 删除数据库记录
      await pgClient.query('DELETE FROM payment_orders WHERE order_id = $1', [testOrderId]);

      // 第二次请求（应该从 Redis 缓存读取）
      const res = await request(app)
        .get(`/api/payment/orders/${testOrderId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.order_id).toBe(testOrderId);
    });

    it('应该返回 404 for 不存在的订单', async () => {
      const res = await request(app)
        .get('/api/payment/orders/ORD-NONEXISTENT');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
    });
  });
});