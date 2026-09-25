/**
 * REQ-00554: MessagePack 编解码（无第三方依赖）
 *
 * 只覆盖 JSON 数据模型（null/boolean/number/string/array/object）+ Buffer(bin)，
 * 足以把网关已解析的 JSON 响应体二进制化；解码用于测试与 Node 客户端。
 * 规范：https://github.com/msgpack/msgpack/blob/master/spec.md
 */
'use strict';

function encode(value) {
  const chunks = [];
  let size = 0;
  const push = (buf) => { chunks.push(buf); size += buf.length; };
  const byte = (b) => push(Buffer.from([b]));

  function writeUInt(prefix, n, bytes) {
    const b = Buffer.alloc(1 + bytes);
    b[0] = prefix;
    if (bytes === 1) b.writeUInt8(n, 1);
    else if (bytes === 2) b.writeUInt16BE(n, 1);
    else if (bytes === 4) b.writeUInt32BE(n, 1);
    else b.writeBigUInt64BE(BigInt(n), 1);
    push(b);
  }
  function writeInt(prefix, n, bytes) {
    const b = Buffer.alloc(1 + bytes);
    b[0] = prefix;
    if (bytes === 1) b.writeInt8(n, 1);
    else if (bytes === 2) b.writeInt16BE(n, 1);
    else if (bytes === 4) b.writeInt32BE(n, 1);
    else b.writeBigInt64BE(BigInt(n), 1);
    push(b);
  }
  function writeNumber(n) {
    if (Number.isInteger(n) && Number.isSafeInteger(n)) {
      if (n >= 0) {
        if (n < 0x80) return byte(n);
        if (n <= 0xff) return writeUInt(0xcc, n, 1);
        if (n <= 0xffff) return writeUInt(0xcd, n, 2);
        if (n <= 0xffffffff) return writeUInt(0xce, n, 4);
        return writeUInt(0xcf, n, 8);
      }
      if (n >= -32) return byte(0x100 + n);
      if (n >= -128) return writeInt(0xd0, n, 1);
      if (n >= -32768) return writeInt(0xd1, n, 2);
      if (n >= -2147483648) return writeInt(0xd2, n, 4);
      return writeInt(0xd3, n, 8);
    }
    if (!Number.isFinite(n)) return byte(0xc0); // JSON 语义：NaN/Infinity → null
    const b = Buffer.alloc(9);
    b[0] = 0xcb;
    b.writeDoubleBE(n, 1);
    return push(b);
  }
  function writeString(s) {
    const data = Buffer.from(s, 'utf8');
    const len = data.length;
    if (len < 32) byte(0xa0 | len);
    else if (len <= 0xff) writeUInt(0xd9, len, 1);
    else if (len <= 0xffff) writeUInt(0xda, len, 2);
    else writeUInt(0xdb, len, 4);
    push(data);
  }
  function writeBin(buf) {
    const len = buf.length;
    if (len <= 0xff) writeUInt(0xc4, len, 1);
    else if (len <= 0xffff) writeUInt(0xc5, len, 2);
    else writeUInt(0xc6, len, 4);
    push(Buffer.from(buf));
  }
  function write(v, depth) {
    if (depth > 512) throw new Error('msgpack: nesting too deep');
    if (v === null || v === undefined) return byte(0xc0);
    switch (typeof v) {
      case 'boolean': return byte(v ? 0xc3 : 0xc2);
      case 'number': return writeNumber(v);
      case 'bigint': return v >= 0n ? writeUInt(0xcf, v, 8) : writeInt(0xd3, v, 8);
      case 'string': return writeString(v);
      default: break;
    }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return writeBin(v);
    if (v instanceof Date) return writeString(v.toISOString());
    if (typeof v.toJSON === 'function') return write(v.toJSON(), depth + 1);
    if (Array.isArray(v)) {
      const len = v.length;
      if (len < 16) byte(0x90 | len);
      else if (len <= 0xffff) writeUInt(0xdc, len, 2);
      else writeUInt(0xdd, len, 4);
      for (const item of v) write(item === undefined || typeof item === 'function' ? null : item, depth + 1);
      return undefined;
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function');
    const len = keys.length;
    if (len < 16) byte(0x80 | len);
    else if (len <= 0xffff) writeUInt(0xde, len, 2);
    else writeUInt(0xdf, len, 4);
    for (const k of keys) { writeString(k); write(v[k], depth + 1); }
    return undefined;
  }
  write(value, 0);
  return Buffer.concat(chunks, size);
}

function decode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let pos = 0;
  const need = (n) => { if (pos + n > buf.length) throw new Error('msgpack: unexpected end of buffer'); };
  const str = (len) => { need(len); const s = buf.toString('utf8', pos, pos + len); pos += len; return s; };
  const bin = (len) => { need(len); const b = buf.subarray(pos, pos + len); pos += len; return Buffer.from(b); };
  const u8 = () => { need(1); return buf[pos++]; };
  const u16 = () => { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; };
  const u32 = () => { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; };
  const big = (signed) => {
    need(8);
    const v = signed ? buf.readBigInt64BE(pos) : buf.readBigUInt64BE(pos);
    pos += 8;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  };
  const arr = (len) => { const a = new Array(len); for (let i = 0; i < len; i++) a[i] = read(); return a; };
  const map = (len) => { const o = {}; for (let i = 0; i < len; i++) { const k = read(); o[String(k)] = read(); } return o; };

  function read() {
    const t = u8();
    if (t < 0x80) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x80) return map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u8());
      case 0xc5: return bin(u16());
      case 0xc6: return bin(u32());
      case 0xca: { need(4); const v = buf.readFloatBE(pos); pos += 4; return v; }
      case 0xcb: { need(8); const v = buf.readDoubleBE(pos); pos += 8; return v; }
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: return big(false);
      case 0xd0: { need(1); const v = buf.readInt8(pos); pos += 1; return v; }
      case 0xd1: { need(2); const v = buf.readInt16BE(pos); pos += 2; return v; }
      case 0xd2: { need(4); const v = buf.readInt32BE(pos); pos += 4; return v; }
      case 0xd3: return big(true);
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16());
      case 0xdd: return arr(u32());
      case 0xde: return map(u16());
      case 0xdf: return map(u32());
      default: throw new Error(`msgpack: unsupported type 0x${t.toString(16)}`);
    }
  }
  const value = read();
  if (pos !== buf.length) throw new Error('msgpack: trailing bytes');
  return value;
}

module.exports = { encode, decode };
