// payment-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const crypto  = require('crypto');
const { query, transactionManager } = require('../../../shared/db');
const { transactionSerializable, IsolationLevel } = transactionManager;
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { getRedis, getJSON, setJSON } = require('../../../shared/redis');

const logger = createLogger('payment-service');
const SERVICE_NAME = 'payment-service';

// Order status state machine
const ORDER_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
};

// Valid state transitions
const VALID_TRANSITIONS = {
  PENDING: [ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED],
  PAID: [ORDER_STATUS.FULFILLED, ORDER_STATUS.REFUNDED],
  FULFILLED: [],
  CANCELLED: [],
  REFUNDED: []
};

// Payment channel secrets (from environment)
const CHANNEL_SECRETS = {
  WECHAT: process.env.WECHAT_SECRET || 'dev_wechat_secret_key',
  ALIPAY: process.env.ALIPAY_SECRET || 'dev_alipay_secret_key',
  APPLE: process.env.APPLE_SHARED_SECRET || 'dev_apple_secret_key'
};

const app  = express();
const PORT = process.env.PORT || 8088;
app.use(helmet()); app.use(cors()); app.use(express.json());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'payment-service' }));

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

// Product catalog
const PRODUCTS = {
  'coins_60':   { name: '60精币',   amountFen: 600,  coinsGrant: 60   },
  'coins_300':  { name: '300精币',  amountFen: 3000, coinsGrant: 300  },
  'coins_600':  { name: '600精币',  amountFen: 5800, coinsGrant: 600  },
  'coins_1200': { name: '1200精币', amountFen: 9800, coinsGrant: 1200 },
  'coins_2500': { name: '2500精币', amountFen: 19800,coinsGrant: 2500 },
};

// ── GET /payment/products ─────────────────────────────────────
app.get('/payment/products', requireAuth, async (req, res, next) => {
  try {
    const products = Object.entries(PRODUCTS).map(([id, p]) => ({
      id, ...p, amountYuan: (p.amountFen / 100).toFixed(2),
    }));
    res.json(successResp(products));
  } catch (err) { next(err); }
});

// ── POST /payment/orders ──────────────────────────────────────
app.post('/payment/orders', requireAuth, async (req, res, next) => {
  try {
    const { productId, paymentChannel, idempotencyKey } = req.body;
    const userId = req.user.sub;

    if (!productId || !paymentChannel || !idempotencyKey) {
      throw new AppError(1001, '缺少必填参数', 400);
    }

    const product = PRODUCTS[productId];
    if (!product) throw new AppError(5001, '商品不存在', 404);

    if (!['WECHAT', 'ALIPAY'].includes(paymentChannel)) {
      throw new AppError(5002, '不支持的支付渠道', 400);
    }

    // REQ-00034: 检查未成年人消费限制
    try {
      const { checkSpendLimit, isMinor, getAgeProfile } = require('../../../shared/ageVerification');
      const profile = await getAgeProfile(userId);
      
      if (profile && isMinor(profile)) {
        const spendCheck = await checkSpendLimit(userId, product.amountFen);
        
        if (!spendCheck.withinLimit) {
          logger.warn({ 
            userId, 
            productId, 
            amountFen: product.amountFen,
            currentSpend: spendCheck.currentSpend,
            limit: spendCheck.limitSpend 
          }, 'Minor user spend limit exceeded');
          
          throw new AppError(4032, 
            `月度消费已达上限 ¥${(spendCheck.limitSpend / 100).toFixed(2)}，请家长调整限制`,
            403
          );
        }
      }
    } catch (ageErr) {
      // 如果是消费限制错误，直接抛出
      if (ageErr.code === 4032) throw ageErr;
      // 其他错误（如年龄验证服务不可用），记录日志但继续
      logger.error({ err: ageErr }, 'Age verification check failed');
    }

    // Idempotency check using Redis
    const idempotencyRedisKey = `payment:idempotency:${userId}:${idempotencyKey}`;
    const cachedOrder = await getJSON(idempotencyRedisKey);
    
    if (cachedOrder) {
      logger.info({ orderId: cachedOrder.orderId, idempotencyKey }, 'Idempotent request - returning cached order');
      
      // Check if order exists in DB (for consistency)
      const { rows: [existing] } = await query(
        'SELECT id, status, amount_fen FROM orders WHERE id=$1', [cachedOrder.orderId]
      );
      
      if (existing) {
        if (existing.status === ORDER_STATUS.PAID) {
          throw new AppError(5003, '订单已支付', 409);
        }
        return res.json(successResp({ 
          orderId: existing.id, 
          status: existing.status,
          amountFen: existing.amount_fen
        }));
      }
    }

    // Create order
    const { rows: [order] } = await query(`
      INSERT INTO orders (user_id, idempotency_key, product_id, product_name,
                          amount_fen, premium_coins_grant, payment_channel, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, status, amount_fen
    `, [userId, idempotencyKey, productId, product.name,
        product.amountFen, product.coinsGrant, paymentChannel, ORDER_STATUS.PENDING]);

    // Store idempotency key in Redis (TTL 24h)
    await setJSON(idempotencyRedisKey, {
      orderId: order.id,
      status: order.status,
      createdAt: new Date().toISOString()
    }, 86400);

    // In production: call WeChat Pay / AliPay API to create pre-pay order
    // Return mock payment params for now
    const payParams = generateMockPayParams(order.id, product.amountFen, paymentChannel);

    logger.info({ orderId: order.id, userId, productId, amountFen: order.amount_fen }, 'Order created');

    res.status(201).json(successResp({
      orderId: order.id,
      amountFen: order.amount_fen,
      payParams,
    }));
  } catch (err) { next(err); }
});

// ── POST /payment/orders/:id/verify ──────────────────────────
// Called by client after payment completes; server verifies with channel
app.post('/payment/orders/:id/verify', requireAuth, async (req, res, next) => {
  try {
    const { channelOrderId, channelSign } = req.body;
    const userId  = req.user.sub;
    const orderId = req.params.id;

    const { rows: [order] } = await query(`
      SELECT * FROM orders WHERE id=$1 AND user_id=$2
    `, [orderId, userId]);
    if (!order) throw new AppError(5004, '订单不存在', 404);
    if (order.status === ORDER_STATUS.PAID) return res.json(successResp({ alreadyPaid: true }));
    
    // Validate state transition
    if (!canTransition(order.status, ORDER_STATUS.PAID)) {
      logger.warn({ orderId, currentStatus: order.status }, 'Invalid state transition');
      throw new AppError(5005, `订单状态异常: ${order.status}`, 400);
    }

    // In prod: verify signature with payment channel
    // Here we simulate verification success
    const verified = verifyPaymentSign(channelSign, order);

    if (!verified) {
      logger.warn({ orderId, channelOrderId }, 'Payment signature verification failed');
      throw new AppError(5006, '支付验证失败', 400);
    }

    await transactionSerializable(async (client) => {
      await client.query(`
        UPDATE orders SET status=$1, channel_order_id=$2, paid_at=NOW(), updated_at=NOW()
        WHERE id=$3
      `, [ORDER_STATUS.PAID, channelOrderId || `MOCK_${Date.now()}`, orderId]);

      // Grant premium coins
      await client.query(`
        UPDATE users SET premium_coins=premium_coins+$1 WHERE id=$2
      `, [order.premium_coins_grant, userId]);
    });

    logger.info({ orderId, userId, coinsGranted: order.premium_coins_grant }, 'Payment verified and coins granted');

    res.json(successResp({
      orderId, coinsGranted: order.premium_coins_grant,
      message: `成功充值 ${order.premium_coins_grant} 精币`,
    }));
  } catch (err) { next(err); }
});

// ── GET /payment/orders ───────────────────────────────────────
app.get('/payment/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id, product_name, amount_fen, premium_coins_grant,
             status, payment_channel, paid_at, created_at
      FROM orders WHERE user_id=$1
      ORDER BY created_at DESC LIMIT 20
    `, [req.user.sub]);
    // Sanitize response - remove sensitive fields
    const sanitizedOrders = rows.map(order => ({
      orderId: order.id,
      productName: order.product_name,
      amountFen: order.amount_fen,
      coinsGranted: order.premium_coins_grant,
      status: order.status,
      paymentChannel: order.payment_channel,
      paidAt: order.paid_at,
      createdAt: order.created_at
      // Note: NOT returning channelResponse, rawCallback, signature, etc.
    }));
    res.json(successResp(sanitizedOrders));
  } catch (err) { next(err); }
});

// ── POST /payment/webhook/:channel  (channel callback) ─────────────────
app.post('/payment/webhook/:channel', express.raw({ type: '*/*' }), async (req, res, next) => {
  try {
    const channel = req.params.channel.toUpperCase();
    const signature = req.headers['x-signature'] || req.headers['x-pay-signature'];
    const rawBody = req.body.toString('utf-8');
    
    logger.info({ channel, hasSignature: !!signature }, 'Received payment webhook callback');
    
    // Validate channel
    if (!['WECHAT', 'ALIPAY', 'APPLE'].includes(channel)) {
      logger.warn({ channel }, 'Invalid payment channel in webhook');
      return res.status(400).send('INVALID_CHANNEL');
    }
    
    // Verify signature
    if (!signature) {
      logger.error({ channel }, 'Webhook missing signature');
      return res.status(401).send('MISSING_SIGNATURE');
    }
    
    const secret = CHANNEL_SECRETS[channel];
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      logger.error({ channel }, 'Webhook signature verification failed');
      return res.status(401).send('INVALID_SIGNATURE');
    }
    
    // Parse callback data (simplified - real implementation depends on channel)
    const callbackData = parseWebhookData(channel, rawBody);
    
    // Verify order exists and update status
    const { rows: [order] } = await query(
      'SELECT * FROM orders WHERE id=$1', [callbackData.orderId]
    );
    
    if (!order) {
      logger.warn({ orderId: callbackData.orderId }, 'Order not found for webhook callback');
      return res.status(404).send('ORDER_NOT_FOUND');
    }
    
    // Validate state transition
    if (canTransition(order.status, ORDER_STATUS.PAID)) {
      await transaction(async (client) => {
        await client.query(`
          UPDATE orders 
          SET status=$1, channel_order_id=$2, channel_response=$3, paid_at=NOW(), updated_at=NOW()
          WHERE id=$4
        `, [ORDER_STATUS.PAID, callbackData.channelOrderId, rawBody, order.id]);
        
        // Grant premium coins
        await client.query(`
          UPDATE users SET premium_coins=premium_coins+$1 WHERE id=$2
        `, [order.premium_coins_grant, order.user_id]);
      });
      
      logger.info({ orderId: order.id, channel }, 'Payment confirmed via webhook');
    } else {
      logger.info({ orderId: order.id, status: order.status }, 'Order already processed');
    }
    
    res.status(200).send('SUCCESS'); // WeChat expects 'SUCCESS'
  } catch (err) {
    logger.error({ err }, 'Webhook processing error');
    next(err);
  }
});

// ── State Machine Helpers ─────────────────────────────────────

function canTransition(fromStatus, toStatus) {
  const allowed = VALID_TRANSITIONS[fromStatus];
  return allowed && allowed.includes(toStatus);
}

// ── Signature Verification Helpers ─────────────────────────────

function verifyWebhookSignature(payload, signature, secret) {
  try {
    // Support multiple signature formats
    // Format 1: simple HMAC-SHA256 hex
    // Format 2: "sign_type=HMAC-SHA256&sign=xxx"
    
    let actualSignature = signature;
    if (signature.includes('sign=')) {
      const match = signature.match(/sign=([a-fA-F0-9]+)/);
      if (match) actualSignature = match[1];
    }
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    // Timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(actualSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (err) {
    logger.error({ err }, 'Signature verification error');
    return false;
  }
}

function parseWebhookData(channel, rawBody) {
  // Simplified parser - real implementation needs channel-specific parsing
  // WeChat: XML format
  // Alipay: Form-urlencoded
  // Apple: JSON
  
  try {
    if (channel === 'WECHAT') {
      // Parse XML (simplified - use xml2js in production)
      const orderIdMatch = rawBody.match(/<out_trade_no>([^<]+)<\/out_trade_no>/);
      const channelOrderIdMatch = rawBody.match(/<transaction_id>([^<]+)<\/transaction_id>/);
      return {
        orderId: orderIdMatch ? orderIdMatch[1] : null,
        channelOrderId: channelOrderIdMatch ? channelOrderIdMatch[1] : null
      };
    } else if (channel === 'ALIPAY') {
      // Parse form data
      const params = new URLSearchParams(rawBody);
      return {
        orderId: params.get('out_trade_no'),
        channelOrderId: params.get('trade_no')
      };
    } else if (channel === 'APPLE') {
      // Parse JSON
      const data = JSON.parse(rawBody);
      return {
        orderId: data.transactionId || data.orderId,
        channelOrderId: data.originalTransactionId
      };
    }
  } catch (err) {
    logger.error({ err, channel }, 'Failed to parse webhook data');
  }
  
  return { orderId: null, channelOrderId: null };
}

function generateMockPayParams(orderId, amountFen, channel) {
  return {
    channel,
    orderId,
    amountFen,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(8).toString('hex'),
    // In prod: appId, prepayId, sign etc.
  };
}

function verifyPaymentSign(sign, order) {
  // In prod: verify HMAC-SHA256 signature from payment channel
  // For dev/test: accept any non-null sign
  return !!sign || process.env.NODE_ENV !== 'production';
}

// REQ-00131: 多货币支持路由
const currencyRouter = require('./routes/currency');
app.use('/currency', currencyRouter);

app.use(errorHandler);
app.listen(PORT, () => logger.info({ port: PORT }, 'payment-service started'));
module.exports = app;
