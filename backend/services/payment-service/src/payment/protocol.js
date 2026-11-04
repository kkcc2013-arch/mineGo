'use strict';

const crypto = require('node:crypto');
const {
  AppError
} = require('../../../../shared/auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = Object.freeze(['WECHAT', 'ALIPAY', 'APPLE']);
const PRODUCTS = Object.freeze({
  coins_60: Object.freeze({
    name: '60精币',
    amountFen: 600,
    coinsGrant: 60
  }),
  coins_300: Object.freeze({
    name: '300精币',
    amountFen: 3000,
    coinsGrant: 300
  }),
  coins_600: Object.freeze({
    name: '600精币',
    amountFen: 5800,
    coinsGrant: 600
  }),
  coins_1200: Object.freeze({
    name: '1200精币',
    amountFen: 9800,
    coinsGrant: 1200
  }),
  coins_2500: Object.freeze({
    name: '2500精币',
    amountFen: 19800,
    coinsGrant: 2500
  })
});
const TRANSITIONS = Object.freeze({
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'REFUNDED'],
  FULFILLED: [],
  CANCELLED: [],
  REFUNDED: []
});
const fail = (code, status = 400) => new AppError(code, code, status);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function identity(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('PAYMENT_ID_INVALID');
  return value.toLowerCase();
}
function channel(value) {
  if (typeof value !== 'string' || !CHANNELS.includes(value)) throw fail('PAYMENT_CHANNEL_INVALID');
  return value;
}
function transactionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw fail('PAYMENT_TRANSACTION_INVALID');
  return value;
}
function requestInput(body, header) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['productId', 'quantity', 'channel', 'paymentChannel', 'idempotencyKey'].includes(k))) throw fail('PAYMENT_INPUT_INVALID');
  const key = identity(header);
  if (body.idempotencyKey !== undefined && identity(body.idempotencyKey) !== key) throw fail('PAYMENT_KEY_MISMATCH');
  if (!Object.hasOwn(PRODUCTS, body.productId)) throw fail('PAYMENT_PRODUCT_NOT_FOUND', 404);
  if (body.channel !== undefined && body.paymentChannel !== undefined && body.channel !== body.paymentChannel) throw fail('PAYMENT_CHANNEL_MISMATCH');
  const selected = channel(body.channel ?? body.paymentChannel),
    quantity = body.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw fail('PAYMENT_QUANTITY_INVALID');
  const product = PRODUCTS[body.productId];
  return {
    key,
    productId: body.productId,
    channel: selected,
    quantity,
    name: product.name,
    amountFen: product.amountFen * quantity,
    coinsGrant: product.coinsGrant * quantity,
    requestHash: digest(JSON.stringify([body.productId, selected, quantity]))
  };
}
function loadSecrets(env = process.env) {
  const values = {
    WECHAT: env.WECHAT_SECRET,
    ALIPAY: env.ALIPAY_SECRET,
    APPLE: env.APPLE_SHARED_SECRET
  };
  for (const c of CHANNELS) if (typeof values[c] !== 'string' || Buffer.byteLength(values[c]) < 32 || Buffer.byteLength(values[c]) > 4096) throw fail('PAYMENT_SECRET_CONFIGURATION', 503);
  return Object.freeze(values);
}
function validSignature(payload, signature, secret) {
  if (!Buffer.isBuffer(payload) || typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature) || typeof secret !== 'string') return false;
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), crypto.createHmac('sha256', secret).update(payload).digest());
}
function legacyXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail('PAYMENT_CALLBACK_INVALID');
  text = text.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>\s*/i, '');
  if (!text.startsWith('<xml>') || !text.endsWith('</xml>')) throw fail('PAYMENT_CALLBACK_INVALID');
  const content = text.slice(5, -6).trim(),
    fields = Object.create(null),
    field = /<([A-Za-z_][A-Za-z0-9_.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<>]*))<\/\1>\s*/y;
  let offset = 0;
  while (offset < content.length) {
    field.lastIndex = offset;
    const match = field.exec(content);
    if (!match || Object.hasOwn(fields, match[1])) throw fail('PAYMENT_CALLBACK_INVALID');
    fields[match[1]] = (match[2] ?? match[3]).trim();
    offset = field.lastIndex;
  }
  return fields;
}
function legacyAmount(value, decimal) {
  if (typeof value !== 'string') throw fail('PAYMENT_CALLBACK_INVALID');
  const match = decimal ? /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/.exec(value) : /^([1-9][0-9]{0,9})$/.exec(value);
  if (!match) throw fail('PAYMENT_CALLBACK_INVALID');
  const amount = decimal ? BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')) : BigInt(match[1]);
  if (amount < 1n || amount > 2147483647n) throw fail('PAYMENT_CALLBACK_INVALID');
  return Number(amount);
}
function callbackInput(raw, selectedChannel) {
  let value, text;
  try {
    if (!Buffer.isBuffer(raw) || raw.length > 65536) throw Error();
    text = new TextDecoder('utf-8', {
      fatal: true
    }).decode(raw).trim();
  } catch {
    throw fail('PAYMENT_CALLBACK_INVALID');
  }
  if (text.startsWith('{')) {
    try {
      value = JSON.parse(text);
    } catch {
      throw fail('PAYMENT_CALLBACK_INVALID');
    }
  } else if (selectedChannel === 'WECHAT') {
    const fields = legacyXml(text);
    value = {
      orderId: fields.out_trade_no,
      channelOrderId: fields.transaction_id,
      amountFen: legacyAmount(fields.total_fee, false),
      currency: fields.fee_type,
      status: fields.return_code === 'SUCCESS' && fields.result_code === 'SUCCESS' ? 'PAID' : 'FAILED'
    };
  } else if (selectedChannel === 'ALIPAY') {
    if (/%(?![0-9a-f]{2})/i.test(text)) throw fail('PAYMENT_CALLBACK_INVALID');
    const fields = Object.create(null);
    for (const [key, val] of new URLSearchParams(text)) {
      if (Object.hasOwn(fields, key)) throw fail('PAYMENT_CALLBACK_INVALID');
      fields[key] = val;
    }
    value = {
      orderId: fields.out_trade_no,
      channelOrderId: fields.trade_no,
      amountFen: legacyAmount(fields.total_amount, true),
      currency: fields.currency,
      status: ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(fields.trade_status) ? 'PAID' : 'FAILED'
    };
  } else throw fail('PAYMENT_CALLBACK_INVALID');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['orderId', 'channelOrderId', 'amountFen', 'currency', 'status'].includes(k)) || value.status !== 'PAID' || value.currency !== 'CNY' || !Number.isSafeInteger(value.amountFen) || value.amountFen < 1) throw fail('PAYMENT_CALLBACK_INVALID');
  return {
    orderId: identity(value.orderId),
    channelOrderId: transactionId(value.channelOrderId),
    amountFen: value.amountFen,
    currency: value.currency,
    status: value.status
  };
}
function orderView(row) {
  return {
    orderId: row.id,
    productName: row.product_name,
    productId: row.product_id,
    quantity: row.quantity,
    amountFen: row.amount_fen,
    amount: (row.amount_fen / 100).toFixed(2),
    currency: row.currency,
    status: row.status,
    coinsGranted: row.premium_coins_grant,
    paymentChannel: row.payment_channel,
    createdAt: row.created_at,
    paidAt: row.paid_at
  };
}
function canTransition(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}
module.exports = {
  CHANNELS,
  PRODUCTS,
  TRANSITIONS,
  fail,
  digest,
  identity,
  channel,
  transactionId,
  requestInput,
  loadSecrets,
  validSignature,
  callbackInput,
  orderView,
  canTransition
};
