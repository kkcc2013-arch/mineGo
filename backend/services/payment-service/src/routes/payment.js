'use strict';

const express = require('express');
const {
  requireAuth,
  successResp
} = require('../../../../shared/auth');
const p = require('../payment/protocol');
const {
  PaymentStore
} = require('../payment/PaymentStore');
const {RiskVerifier, paymentPolicy} = require('../../../../shared/riskVerifier');
function createPaymentRouter({
  store = new PaymentStore(),
  secrets = p.loadSecrets(),
  risk = new RiskVerifier({database: store.db, cache: store.cache})
} = {}) {
  const router = express.Router();
  const context = req => ({
    requestId: req.headers['x-request-id'],
    ipAddress: req.ip
  });
  const handler = fn => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };
  router.post('/webhook/:channel', express.raw({
    type: () => true,
    limit: '64kb',
    inflate: false
  }), handler(async (req, res) => {
    try {
      const channel = p.channel(req.params.channel.toUpperCase()),
        raw = req.body;
      const first = req.headers['x-signature'],
        second = req.headers['x-pay-signature'];
      if (!Buffer.isBuffer(raw) || !p.validSignature(raw, first ?? second, secrets[channel]) || first && second && first !== second) {
        throw p.fail('PAYMENT_SIGNATURE_INVALID', 401);
      }
      const input = p.callbackInput(raw, channel);
      const result = await store.settle({
        ...input,
        channel,
        payloadHash: p.digest(raw)
      }, context(req));
      res.json({
        success: true,
        ...successResp({
          orderId: result.order.id,
          alreadyPaid: result.replayed
        })
      });
    } catch (error) {
      await store.denied(typeof error.code === 'string' && error.code.startsWith('PAYMENT_') ? error.code : 'PAYMENT_OPERATION_FAILED', context(req));
      throw error;
    }
  }));
  router.use(express.json({
    limit: '16kb'
  }));
  router.get('/products', requireAuth, handler(async (_req, res) => res.json(successResp(Object.entries(p.PRODUCTS).map(([id, v]) => ({
    id,
    ...v,
    amountYuan: (v.amountFen / 100).toFixed(2)
  }))))));
  router.use('/orders', requireAuth, risk.middleware());
  router.post('/orders', risk.middleware(req => {
    req.paymentInput = p.requestInput(req.body, req.headers['x-idempotency-key']);
    return paymentPolicy(req.paymentInput.amountFen, risk.largeTransactionFen);
  }), handler(async (req, res) => {
    const input = req.paymentInput;
    const result = await store.create(req.user.sub, input, context(req));
    res.status(result.replayed ? 200 : 201).json(successResp({
      ...p.orderView(result.order),
      expiresAt: result.expiresAt,
      providerReady: false,
      payParams: null
    }));
  }));
  router.get('/orders', requireAuth, handler(async (req, res) => res.json(successResp((await store.list(req.user.sub)).map(p.orderView)))));
  router.post('/orders/:id/verify', risk.middleware(async req => {
    const id = p.identity(req.params.id);
    const order = (await store.db.query('SELECT amount_fen FROM orders WHERE id=$1 AND user_id=$2', [id, req.user.sub])).rows[0];
    if (!order) throw p.fail('PAYMENT_ORDER_NOT_FOUND', 404);
    return paymentPolicy(order.amount_fen, risk.largeTransactionFen);
  }), handler(async (req, res) => {
    const id = p.identity(req.params.id),
      body = req.body;
    if (!body || Object.keys(body).some(k => !['channelOrderId', 'channelSign'].includes(k))) throw p.fail('PAYMENT_INPUT_INVALID');
    const channelOrderId = p.transactionId(body.channelOrderId);
    const result = await store.settle({
      orderId: id,
      userId: req.user.sub,
      channelOrderId,
      // Channel is selected from the locked owned order, never a client declaration.
      verify: order => p.validSignature(Buffer.from(`${order.id}|${order.amount_fen}|${order.product_id}|${channelOrderId}`), body.channelSign, secrets[order.payment_channel]),
      payloadHash: p.digest(JSON.stringify([id, channelOrderId]))
    }, context(req));
    res.json(successResp({
      orderId: result.order.id,
      alreadyPaid: result.replayed,
      coinsGranted: result.replayed ? 0 : result.order.premium_coins_grant
    }));
  }));
  return router;
}
module.exports = {
  createPaymentRouter
};
