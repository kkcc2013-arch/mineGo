// payment-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const crypto  = require('crypto');
const { query, transaction } = require('../../../shared/db');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');

const app  = express();
const PORT = process.env.PORT || 8088;
app.use(helmet()); app.use(cors()); app.use(express.json());
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'payment-service' }));

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

    // Idempotency check
    const { rows: [existing] } = await query(
      'SELECT id, status FROM orders WHERE idempotency_key=$1', [idempotencyKey]
    );
    if (existing) {
      if (existing.status === 'PAID') throw new AppError(5003, '订单已支付', 409);
      return res.json(successResp({ orderId: existing.id, status: existing.status }));
    }

    // Create order
    const { rows: [order] } = await query(`
      INSERT INTO orders (user_id, idempotency_key, product_id, product_name,
                          amount_fen, premium_coins_grant, payment_channel)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, status, amount_fen
    `, [userId, idempotencyKey, productId, product.name,
        product.amountFen, product.coinsGrant, paymentChannel]);

    // In production: call WeChat Pay / AliPay API to create pre-pay order
    // Return mock payment params for now
    const payParams = generateMockPayParams(order.id, product.amountFen, paymentChannel);

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
    if (order.status === 'PAID') return res.json(successResp({ alreadyPaid: true }));
    if (order.status !== 'PENDING') throw new AppError(5005, '订单状态异常', 400);

    // In prod: verify signature with payment channel
    // Here we simulate verification success
    const verified = verifyPaymentSign(channelSign, order);

    if (!verified) throw new AppError(5006, '支付验证失败', 400);

    await transaction(async (client) => {
      await client.query(`
        UPDATE orders SET status='PAID', channel_order_id=$1, paid_at=NOW(), updated_at=NOW()
        WHERE id=$2
      `, [channelOrderId || `MOCK_${Date.now()}`, orderId]);

      // Grant premium coins
      await client.query(`
        UPDATE users SET premium_coins=premium_coins+$1 WHERE id=$2
      `, [order.premium_coins_grant, userId]);
    });

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
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

// ── POST /payment/webhook  (channel callback) ─────────────────
app.post('/payment/webhook', express.raw({ type: 'application/xml' }), async (req, res, next) => {
  try {
    // Parse XML/JSON from WeChat/AliPay
    // In production: verify signature, parse order ID, confirm payment
    console.log('[Webhook] Received payment callback');
    res.status(200).send('SUCCESS'); // WeChat expects 'SUCCESS'
  } catch (err) { next(err); }
});

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

app.use(errorHandler);
app.listen(PORT, () => console.log(`[payment-service] listening on :${PORT}`));
module.exports = app;
