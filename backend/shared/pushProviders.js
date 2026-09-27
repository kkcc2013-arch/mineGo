/**
 * 系统推送渠道（REQ-00425）：FCM HTTP v1 / APNs（HTTP/2 + JWT）
 *
 * 凭据通过环境变量提供；未配置时 isConfigured() 为 false，投递计划自动降级为"仅站内消息"
 * （notification_events 记录 deferred + push_provider_unconfigured）。
 *   FCM：FCM_PROJECT_ID、FCM_CLIENT_EMAIL、FCM_PRIVATE_KEY（服务账号，\n 转义换行）
 *   APNs：APNS_KEY_ID、APNS_TEAM_ID、APNS_PRIVATE_KEY（p8，\n 转义换行）、APNS_BUNDLE_ID、APNS_PRODUCTION=true|false
 * 生产环境当前没有推送凭据：发送链路只做了本地静态校验，未在生产环境验证。
 */
'use strict';

const http2 = require('http2');
const jwt = require('jsonwebtoken');

const env = (k) => (process.env[k] || '').trim();
const pem = (k) => env(k).replace(/\\n/g, '\n');

function fcmConfigured() { return !!(env('FCM_PROJECT_ID') && env('FCM_CLIENT_EMAIL') && env('FCM_PRIVATE_KEY')); }
function apnsConfigured() { return !!(env('APNS_KEY_ID') && env('APNS_TEAM_ID') && env('APNS_PRIVATE_KEY') && env('APNS_BUNDLE_ID')); }

function status() { return { fcm: fcmConfigured(), apns: apnsConfigured() }; }

let fcmToken = { value: null, exp: 0 };
async function fcmAccessToken() {
  if (fcmToken.value && Date.now() < fcmToken.exp - 60000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: env('FCM_CLIENT_EMAIL'), scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }, pem('FCM_PRIVATE_KEY'), { algorithm: 'RS256' });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const j = await res.json();
  fcmToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmToken.value;
}

async function sendFcm(deviceToken, n) {
  const token = await fcmAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env('FCM_PROJECT_ID')}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, notification: { title: n.title, body: n.body },
      data: { notificationId: String(n.id), type: n.type, actionUrl: n.actionUrl || '' },
      android: { priority: n.priority === 'urgent' || n.priority === 'high' ? 'high' : 'normal' } } }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`fcm send ${res.status}`);
  return { provider: 'fcm' };
}

let apnsJwt = { value: null, at: 0 };
function apnsAuth() {
  if (apnsJwt.value && Date.now() - apnsJwt.at < 50 * 60 * 1000) return apnsJwt.value;
  apnsJwt = { value: jwt.sign({ iss: env('APNS_TEAM_ID'), iat: Math.floor(Date.now() / 1000) }, pem('APNS_PRIVATE_KEY'),
    { algorithm: 'ES256', header: { alg: 'ES256', kid: env('APNS_KEY_ID') } }), at: Date.now() };
  return apnsJwt.value;
}

function sendApns(deviceToken, n) {
  const host = env('APNS_PRODUCTION') === 'true' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${encodeURIComponent(deviceToken)}`,
      authorization: `bearer ${apnsAuth()}`, 'apns-topic': env('APNS_BUNDLE_ID'), 'apns-push-type': 'alert',
      'apns-priority': n.priority === 'low' ? '5' : '10',
    });
    let status = 0;
    req.setTimeout(5000, () => { req.close(); reject(new Error('apns timeout')); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('end', () => { client.close(); status === 200 ? resolve({ provider: 'apns' }) : reject(new Error(`apns send ${status}`)); });
    req.on('data', () => {});
    req.end(JSON.stringify({ aps: { alert: { title: n.title, body: n.body }, sound: 'default' }, notificationId: String(n.id), actionUrl: n.actionUrl || '' }));
  });
}

async function send(provider, deviceToken, notification) {
  if (provider === 'fcm') return sendFcm(deviceToken, notification);
  if (provider === 'apns') return sendApns(deviceToken, notification);
  throw new Error(`unknown provider ${provider}`);
}

module.exports = { status, send, fcmConfigured, apnsConfigured };
