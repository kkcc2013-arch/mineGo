#!/usr/bin/env node
/**
 * 本地/CI 用的游戏客户端开发服务器（仅依赖 Node 内置模块）
 *
 *   静态文件：frontend/game-client
 *   反向代理：/v1/*、/v2/*、/health、/api/* → 网关（含 WebSocket 升级）
 *
 * 用法：
 *   GATEWAY=http://127.0.0.1:8080 PORT=3000 node scripts/serve-client.js
 * 生产由 nginx 承担同样的职责（见服务器上的站点配置），本脚本不用于生产。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..', 'frontend', 'game-client');
const PORT = Number(process.env.PORT || 3000);
const GATEWAY = new URL(process.env.GATEWAY || process.env.BASE_URL || 'http://127.0.0.1:8080');
const PROXY_PREFIXES = ['/v1/', '/v2/', '/api/', '/health', '/ws'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

function shouldProxy(p) {
  return PROXY_PREFIXES.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`) || p === x.replace(/\/$/, ''));
}

function proxy(req, res) {
  const opts = {
    hostname: GATEWAY.hostname, port: GATEWAY.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: GATEWAY.host },
  };
  const up = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_gateway', message: e.message })); });
  req.pipe(up);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(ROOT, 'index.html'); // SPA 回退
    const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (shouldProxy(p)) return proxy(req, res);
  return serveStatic(req, res);
});

// WebSocket 升级透传
server.on('upgrade', (req, socket, head) => {
  const up = http.request({
    hostname: GATEWAY.hostname, port: GATEWAY.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: GATEWAY.host },
  });
  up.on('upgrade', (r, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
    for (const [k, v] of Object.entries(r.headers)) lines.push(`${k}: ${v}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on('error', () => socket.destroy());
  up.end();
});

server.listen(PORT, () => {
  console.log(`game-client on http://127.0.0.1:${PORT}  (proxy → ${GATEWAY.origin})`);
});
