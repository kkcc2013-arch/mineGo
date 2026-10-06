'use strict';

const express = require('express');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');
const request = require('supertest');
const { createProxyMiddleware, rewritePath } = require('../../gateway/src/proxy');

let upstream;
let target;
let websocketServer;
const proxies = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
  });
  websocketServer = new WebSocketServer({ server: upstream });
  websocketServer.on('connection', socket => socket.on('message', data => socket.send(data)));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  target = `http://127.0.0.1:${upstream.address().port}`;
});

afterAll(async () => {
  for (const proxy of proxies) proxy.close();
  await new Promise(resolve => websocketServer.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
});

function gateway(options = {}, parse = true) {
  const server = express();
  if (parse) {
    server.use(express.json());
    server.use(express.urlencoded({ extended: false }));
  }
  const proxy = createProxyMiddleware({ target, changeOrigin: true, pathRewrite: { '^/': '/users/' }, ...options });
  proxies.push(proxy);
  server.use('/api/v1/users', proxy);
  server.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  return server;
}

test('mount-relative paths and query parameters reach the static upstream', async () => {
  const result = await request(gateway()).get('/api/v1/users/123?locale=zh');
  expect(result.status).toBe(200);
  expect(result.body.path).toBe('/users/123?locale=zh');
  expect(result.body.headers.host).toBe(new URL(target).host);
});

test('a legacy rule naming the full mount prefix uses the original URL', async () => {
  const result = await request(gateway({ pathRewrite: { '^/api/v1/': '/' } })).get('/api/v1/users/123');
  expect(result.body.path).toBe('/users/123');
});

test('parsed JSON bodies are replayed with the correct content length', async () => {
  const body = { nickname: '精灵😀', count: 3 };
  const result = await request(gateway()).post('/api/v1/users/profile').send(body);
  expect(JSON.parse(result.body.body)).toEqual(body);
  expect(Number(result.body.headers['content-length'])).toBe(Buffer.byteLength(JSON.stringify(body)));
  expect(result.body.method).toBe('POST');
});

test('parsed form bodies retain repeated values', async () => {
  const result = await request(gateway()).post('/api/v1/users/profile').type('form').send('name=Test&tag=a&tag=b');
  expect(result.body.body).toBe('name=Test&tag=a&tag=b');
});

test('unparsed request streams remain intact', async () => {
  const result = await request(gateway({}, false)).post('/api/v1/users/raw').type('text').send('original raw body');
  expect(result.body.body).toBe('original raw body');
});

test('empty parsed JSON bodies are forwarded', async () => {
  const result = await request(gateway()).post('/api/v1/users/profile').send({});
  expect(result.body.body).toBe('{}');
});

test('request and response callbacks still run', async () => {
  const proxyRes = jest.fn();
  const result = await request(gateway({ on: { proxyReq: proxyReq => proxyReq.setHeader('X-API-Version', '2'), proxyRes } })).get('/api/v1/users/profile');
  expect(result.body.headers['x-api-version']).toBe('2');
  expect(proxyRes).toHaveBeenCalledTimes(1);
});

test('incoming Host headers cannot change the upstream target', async () => {
  const result = await request(gateway()).get('/api/v1/users/profile').set('Host', 'attacker.invalid');
  expect(result.status).toBe(200);
  expect(result.body.headers.host).toBe(new URL(target).host);
});

test('unavailable upstreams return 502', async () => {
  const result = await request(gateway({ target: 'http://127.0.0.1:1' })).get('/api/v1/users/profile');
  expect(result.status).toBe(502);
});

test('configured error callbacks are honored', async () => {
  const result = await request(gateway({ target: 'http://127.0.0.1:1', on: { error: (error, req, res) => res.status(503).json({ message: 'retry' }) } })).get('/api/v1/users/profile');
  expect(result.status).toBe(503);
  expect(result.body.message).toBe('retry');
});

test('callback failures return an error without crashing the gateway', async () => {
  const result = await request(gateway({ on: { proxyReq: () => { throw new Error('invalid header'); } } })).get('/api/v1/users/profile');
  expect(result.status).toBe(502);
});

test('WebSocket upgrades forward bidirectional frames', async () => {
  const proxy = createProxyMiddleware({ target, pathRewrite: { '^/ws$': '/echo' } });
  proxies.push(proxy);
  const server = http.createServer();
  server.on('upgrade', proxy.upgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  let received;
  try {
    await new Promise((resolve, reject) => {
      client.once('error', reject);
      client.once('open', () => client.send('battle-frame'));
      client.once('message', data => { received = data.toString(); client.close(); });
      client.once('close', resolve);
    });
    expect(received).toBe('battle-frame');
  } finally {
    client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('unsupported target protocols fail at startup', () => {
  expect(() => createProxyMiddleware({ target: 'file:///etc/passwd' })).toThrow(/HTTP or HTTPS/);
});

test('function rewrites and unchanged paths are supported', () => {
  expect(rewritePath({ url: '/path' }, value => '/new' + value)).toBe('/new/path');
  expect(rewritePath({ url: '/path' }, { '^/other': '/new' })).toBe('/path');
  expect(rewritePath({ url: '/path' })).toBe('/path');
});
