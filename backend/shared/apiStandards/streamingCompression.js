/**
 * REQ-00526: 流式压缩中间件（替代整包缓冲的 REQ-00072 压缩实现）
 *
 * - Brotli 优先（br > gzip > deflate，按 Accept-Encoding q 值），zlib Transform 流式压缩，不缓冲整个响应体
 * - 只在累计字节达到阈值（默认 1KB）后才启动压缩；小响应直接明文输出并带 Content-Length
 * - 流式内容（application/x-ndjson、text/event-stream、X-Stream: 1）每次 write 后 flush，保证首字节尽快到达
 * - 背压：压缩流 write 返回 false 时透传给上游，drain 时在 res 上重新触发
 * - 客户端中途断开（res 'close' 早于 'finish'）→ 销毁压缩流，释放 zlib 资源
 * - 已设置 Content-Encoding、不可压缩类型、HEAD/204/304、Cache-Control: no-transform 时透传
 */
'use strict';

const zlib = require('zlib');

const INCOMPRESSIBLE = /^(image\/(?!svg)|video\/|audio\/|application\/(zip|gzip|x-gzip|octet-stream|pdf|x-msgpack|msgpack|vnd\.msgpack|x-protobuf|protobuf)|font\/woff2?)/i;
const STREAMING_TYPES = /^(application\/x-ndjson|application\/stream\+json|text\/event-stream)/i;

function parseAcceptEncoding(header) {
  const m = new Map();
  for (const part of String(header || '').split(',')) {
    const [enc, ...params] = part.trim().split(';');
    if (!enc) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = Number.isFinite(Number(v)) ? Number(v) : 1;
    }
    m.set(enc.trim().toLowerCase(), q);
  }
  return m;
}

function selectEncoding(header, prefer = ['br', 'gzip', 'deflate']) {
  const m = parseAcceptEncoding(header);
  let best = null, bestQ = 0;
  for (const enc of prefer) {
    const q = m.has(enc) ? m.get(enc) : (m.has('*') ? m.get('*') : 0);
    if (q > bestQ) { best = enc; bestQ = q; }
  }
  return best;
}

function createEncoder(encoding, { brotliQuality = 4, gzipLevel = 6 } = {}) {
  if (encoding === 'br') {
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      },
    });
  }
  if (encoding === 'gzip') return zlib.createGzip({ level: gzipLevel });
  return zlib.createDeflate({ level: gzipLevel });
}

/**
 * @param {object} opts { threshold=1024, brotliQuality=4, gzipLevel=6, metrics:{ bytes, ratio, streams }, skip(req,res) }
 */
function createStreamingCompression(opts = {}) {
  const threshold = opts.threshold ?? 1024;
  const skipPaths = opts.skipPaths || ['/metrics'];

  return function streamingCompression(req, res, next) {
    const acceptEncoding = req.headers['accept-encoding'];
    const encoding = selectEncoding(acceptEncoding);
    if (!encoding || req.method === 'HEAD' || skipPaths.some((p) => (req.path || req.url).startsWith(p)) || (opts.skip && opts.skip(req, res))) return next();

    const origWrite = res.write;
    const origEnd = res.end;
    const origWriteHead = res.writeHead;
    const origOn = res.on;

    let mode = null;           // null=未决定 | 'identity' | 'compress'
    let pending = [];          // 决定前暂存的数据块
    let pendingSize = 0;
    let encoder = null;
    let streaming = false;
    let bytesIn = 0, bytesOut = 0;
    let ended = false;
    let deferredHead = null;   // 显式 writeHead 的参数延后到决定模式后再发

    function passthroughReason() {
      if (res.getHeader('Content-Encoding') && res.getHeader('Content-Encoding') !== 'identity') return 'encoded';
      const sc = res.statusCode;
      if (sc === 204 || sc === 304 || (sc >= 100 && sc < 200)) return 'status';
      const ct = String(res.getHeader('Content-Type') || '');
      if (ct && INCOMPRESSIBLE.test(ct)) return 'type';
      const cc = String(res.getHeader('Cache-Control') || '');
      if (/no-transform/i.test(cc)) return 'no-transform';
      return null;
    }

    function flushHead() {
      if (deferredHead) {
        const args = deferredHead;
        deferredHead = null;
        origWriteHead.apply(res, args);
      }
    }

    function decide(finalChunkSize, isEnd) {
      if (mode) return mode;
      const ct = String(res.getHeader('Content-Type') || '');
      streaming = STREAMING_TYPES.test(ct) || res.getHeader('X-Stream') === '1';
      const reason = passthroughReason();
      const total = pendingSize + finalChunkSize;
      if (reason || (isEnd && total < threshold)) {
        mode = 'identity';
        res.writeHead = origWriteHead; // 决定后恢复：Node 隐式发头会调用 res.writeHead
        return mode;
      }
      if (!isEnd && !streaming && total < threshold) return null; // 继续积攒
      mode = 'compress';
      res.writeHead = origWriteHead;
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      const vary = res.getHeader('Vary');
      if (!vary) res.setHeader('Vary', 'Accept-Encoding');
      else if (!/accept-encoding/i.test(String(vary))) res.setHeader('Vary', `${vary}, Accept-Encoding`);
      encoder = createEncoder(encoding, opts);
      encoder.on('data', (chunk) => {
        bytesOut += chunk.length;
        if (origWrite.call(res, chunk) === false) {
          encoder.pause();
          res.once('drain', () => encoder.resume());
        }
      });
      encoder.on('end', () => {
        record();
        origEnd.call(res);
      });
      encoder.on('error', (err) => {
        if (!res.destroyed) res.destroy(err);
      });
      encoder.on('drain', () => res.emit('drain'));
      return mode;
    }

    function record() {
      if (!opts.metrics) return;
      try {
        if (opts.metrics.bytes) {
          opts.metrics.bytes.inc({ encoding, stage: 'original' }, bytesIn);
          opts.metrics.bytes.inc({ encoding, stage: 'compressed' }, bytesOut);
        }
        if (opts.metrics.ratio && bytesIn) opts.metrics.ratio.observe({ encoding }, 1 - bytesOut / bytesIn);
        if (opts.metrics.streams) opts.metrics.streams.inc({ encoding, streaming: streaming ? 'true' : 'false' });
      } catch { /* ignore */ }
    }

    function toBuf(chunk, enc) {
      if (chunk === undefined || chunk === null) return null;
      return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
    }

    function drainPendingTo(fn) {
      const p = pending;
      pending = [];
      pendingSize = 0;
      for (const b of p) fn(b);
    }

    res.writeHead = function writeHead(...args) {
      // 延后发出响应头：此时还不知道是否要压缩（需要改 Content-Encoding/Content-Length）
      const [status, reason, headers] = args;
      const hdrs = typeof reason === 'object' && reason !== null ? reason : headers;
      if (hdrs && !Array.isArray(hdrs)) for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
      res.statusCode = status;
      if (typeof reason === 'string') res.statusMessage = reason;
      deferredHead = [status, typeof reason === 'string' ? reason : undefined].filter((x) => x !== undefined);
      return res;
    };

    res.write = function write(chunk, enc, cb) {
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      const buf = toBuf(chunk, enc);
      if (!buf || !buf.length) { if (cb) process.nextTick(cb); return true; }
      bytesIn += buf.length;
      const m = decide(buf.length, false);
      if (m === null) {
        pending.push(buf);
        pendingSize += buf.length;
        if (cb) process.nextTick(cb);
        return true;
      }
      flushHead();
      if (m === 'identity') {
        drainPendingTo((b) => origWrite.call(res, b));
        return origWrite.call(res, buf, cb);
      }
      drainPendingTo((b) => encoder.write(b));
      const ok = encoder.write(buf, cb);
      if (streaming) encoder.flush();
      return ok;
    };

    res.end = function end(chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (ended) return res;
      ended = true;
      const buf = toBuf(chunk, enc);
      if (buf) bytesIn += buf.length;
      const m = decide(buf ? buf.length : 0, true);
      if (m === 'identity') {
        const all = Buffer.concat([...pending, ...(buf ? [buf] : [])]);
        pending = [];
        if (!res.headersSent && !res.getHeader('Content-Encoding') && !res.getHeader('Transfer-Encoding')) res.setHeader('Content-Length', all.length);
        flushHead();
        return origEnd.call(res, all.length ? all : undefined, undefined, cb);
      }
      flushHead();
      drainPendingTo((b) => encoder.write(b));
      if (buf) encoder.write(buf);
      if (cb) res.once('finish', cb);
      encoder.end();
      return res;
    };

    // 客户端断开：释放压缩流
    origOn.call(res, 'close', () => {
      if (encoder && !res.writableFinished) {
        encoder.destroy();
        encoder = null;
      }
      pending = [];
    });

    next();
  };
}

module.exports = { createStreamingCompression, selectEncoding, parseAcceptEncoding, createEncoder, INCOMPRESSIBLE, STREAMING_TYPES };
