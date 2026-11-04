'use strict';

const {
    test
  } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const p = require('../../services/payment-service/src/payment/protocol');
const key = crypto.randomUUID(),
  secret = 'owned-unit-payment-key-32-bytes-only';
test('production payment input binds the required header, body, immutable catalog and quantity', () => {
  const input = p.requestInput({
    productId: 'coins_300',
    quantity: 3,
    channel: 'WECHAT'
  }, key);
  assert.equal(input.amountFen, 9000);
  assert.equal(input.coinsGrant, 900);
  assert.equal(input.key, key);
  assert.equal(input.requestHash, p.requestInput({
    productId: 'coins_300',
    quantity: 3,
    paymentChannel: 'WECHAT',
    idempotencyKey: key
  }, key).requestHash);
  for (const body of [null, [], {}, {
    productId: 'constructor',
    channel: 'WECHAT'
  }, {
    productId: 'coins_60',
    channel: 'NO'
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    quantity: 0
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    quantity: 101
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    quantity: '1'
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    amountFen: 1
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    paymentChannel: 'WECHAT'
  }, {
    productId: 'coins_60',
    channel: 'APPLE',
    idempotencyKey: crypto.randomUUID()
  }]) assert.throws(() => p.requestInput(body, key));
  assert.throws(() => p.requestInput({
    productId: 'coins_60',
    channel: 'WECHAT'
  }, undefined));
  assert.throws(() => p.identity(123));
  assert.throws(() => p.transactionId('bad\nvalue'));
  assert.throws(() => p.channel('__proto__'));
  assert.equal(p.requestInput({
    productId: 'coins_60',
    paymentChannel: 'WECHAT'
  }, key).quantity, 1);
});
test('production signature verification authenticates exact bytes with fixed-length constant-time comparison', () => {
  const raw = Buffer.from('{ "orderId":"owned" }'),
    sign = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(p.validSignature(raw, sign, secret), true);
  assert.equal(p.validSignature(raw, sign.toUpperCase(), secret), true);
  for (const value of [undefined, null, 1, '', sign.slice(2), sign + '00', 'sign=' + sign, 'f'.repeat(64)]) assert.equal(p.validSignature(raw, value, secret), false);
  assert.equal(p.validSignature(Buffer.from('{"orderId":"owned"}'), sign, secret), false);
  assert.equal(p.validSignature(raw.toString(), sign, secret), false);
  assert.equal(p.validSignature(raw, sign, undefined), false);
});
test('all production state pairs match the original state graph without prototype states', () => {
  const allowed = new Set(['PENDING:PAID', 'PENDING:CANCELLED', 'PAID:FULFILLED', 'PAID:REFUNDED']);
  for (const a of Object.keys(p.TRANSITIONS)) for (const b of Object.keys(p.TRANSITIONS)) assert.equal(p.canTransition(a, b), allowed.has(a + ':' + b));
  assert.equal(p.canTransition('constructor', 'PAID'), false);
  assert.equal(p.canTransition(null, 'PAID'), false);
});
test('production callback validation requires an exact success, amount, currency and transaction identity', () => {
  const body = {
    orderId: key,
    channelOrderId: 'owned:tx-1',
    amountFen: 600,
    currency: 'CNY',
    status: 'PAID'
  };
  assert.deepEqual(p.callbackInput(Buffer.from(JSON.stringify(body))), body);
  for (const raw of ['{', 'null', '[]', JSON.stringify({
    ...body,
    status: 'FAILED'
  }), JSON.stringify({
    ...body,
    currency: 'USD'
  }), JSON.stringify({
    ...body,
    amountFen: 0
  }), JSON.stringify({
    ...body,
    amountFen: '600'
  }), JSON.stringify({
    ...body,
    rawCallback: 'private'
  }), JSON.stringify({
    ...body,
    orderId: 'bad'
  }), JSON.stringify({
    ...body,
    channelOrderId: ''
  })]) assert.throws(() => p.callbackInput(Buffer.from(raw)));
});
test('production secrets have no public development fallback and projections are a fixed whitelist', () => {
  const env = {
    WECHAT_SECRET: secret,
    ALIPAY_SECRET: secret,
    APPLE_SHARED_SECRET: secret
  };
  assert.deepEqual(p.loadSecrets(env), {
    WECHAT: secret,
    ALIPAY: secret,
    APPLE: secret
  });
  assert.throws(() => p.loadSecrets({}));
  assert.throws(() => p.loadSecrets({
    ...env,
    WECHAT_SECRET: 'x'.repeat(4097)
  }));
  const row = {
    id: key,
    amount_fen: 600,
    quantity: 1,
    currency: 'CNY',
    status: 'PENDING',
    rawCallback: 'private',
    channel_response: 'private',
    signature: 'private'
  };
  const dto = p.orderView(row);
  assert.equal(dto.amount, '6.00');
  for (const k of ['rawCallback', 'channel_response', 'signature']) assert.equal(Object.hasOwn(dto, k), false);
});
test('production legacy XML and form callbacks require explicit success, exact minor units and unambiguous fields', () => {
  const xml = `<xml><out_trade_no><![CDATA[${key}]]></out_trade_no><transaction_id>owned-xml</transaction_id><total_fee>600</total_fee><fee_type>CNY</fee_type><return_code>SUCCESS</return_code><result_code>SUCCESS</result_code></xml>`;
  assert.equal(p.callbackInput(Buffer.from(xml), 'WECHAT').amountFen, 600);
  assert.equal(p.callbackInput(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' + xml), 'WECHAT').channelOrderId, 'owned-xml');
  const form = new URLSearchParams({
    out_trade_no: key,
    trade_no: 'owned-form',
    total_amount: '6.00',
    currency: 'CNY',
    trade_status: 'TRADE_SUCCESS'
  }).toString();
  assert.equal(p.callbackInput(Buffer.from(form), 'ALIPAY').amountFen, 600);
  assert.equal(p.callbackInput(Buffer.from(form.replace('TRADE_SUCCESS', 'TRADE_FINISHED')), 'ALIPAY').amountFen, 600);
  for (const amount of ['6', '6.0', '6.01']) assert.equal(p.callbackInput(Buffer.from(form.replace('6.00', amount)), 'ALIPAY').amountFen, amount === '6.01' ? 601 : 600);
  for (const raw of ['<xml></xml>', xml.replace('600', '0'), xml.replace('600', '2147483648'), xml.replace('600', '6.01'), xml.replace('SUCCESS', 'FAIL'), xml.replace('</xml>', '<total_fee>600</total_fee></xml>'), '<!DOCTYPE x>' + xml, xml.replace('<xml>', '<wrong>'), xml.replace('<total_fee>600</total_fee>', '<nested><total_fee>600</total_fee></nested>')]) assert.throws(() => p.callbackInput(Buffer.from(raw), 'WECHAT'));
  for (const raw of [form + '&trade_no=duplicate', form + '&broken=%ZZ', form.replace('6.00', '6.001'), form.replace('6.00', '0.00'), form.replace('6.00', '999999999.99'), form.replace('TRADE_SUCCESS', 'WAIT_BUYER_PAY'), form.replace('&total_amount=6.00', '')]) assert.throws(() => p.callbackInput(Buffer.from(raw), 'ALIPAY'));
  assert.throws(() => p.callbackInput(Buffer.from([255]), 'WECHAT'));
  assert.throws(() => p.callbackInput(Buffer.alloc(65537), 'WECHAT'));
  assert.throws(() => p.callbackInput('not bytes', 'WECHAT'));
});
