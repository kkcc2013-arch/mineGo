// frontend/game-client/src/api/client.js
// Unified API client with auth, retry, and error handling
// Epic E25：幂等请求退避重试（REQ-00402）、别名还原（REQ-00251）、弃用提示（REQ-00407）、
//           超媒体导航 / 翻页（REQ-00518/302）、NDJSON 流（REQ-00526）、批量请求（REQ-00308/350）
'use strict';

import {
  expandAliasedBody, shouldRetry, retryDelay, sleep, readNdjson,
  LinkNavigator, pageIterator, resolveHref,
} from './apiStandards.js';

const BASE_URL = window.PMG_CONFIG?.apiBase || 'https://api.pocketmonstergo.com/v1';
const CLIENT_ID = 'game-client-web';
const CLIENT_VERSION = window.PMG_CONFIG?.version || '1.0.0';
const MAX_RETRIES = 2;
const warnedDeprecations = new Set();

class ApiClient {
  constructor() {
    this._accessToken  = localStorage.getItem('pmg_access_token');
    this._refreshToken = localStorage.getItem('pmg_refresh_token');
    this._refreshing   = null; // Promise de-dup
  }

  // ── Token management ────────────────────────────────────
  setTokens(accessToken, refreshToken) {
    this._accessToken  = accessToken;
    this._refreshToken = refreshToken;
    localStorage.setItem('pmg_access_token',  accessToken);
    localStorage.setItem('pmg_refresh_token', refreshToken);
  }

  clearTokens() {
    this._accessToken = this._refreshToken = null;
    localStorage.removeItem('pmg_access_token');
    localStorage.removeItem('pmg_refresh_token');
    window.dispatchEvent(new Event('pmg:logout'));
  }

  async refreshAccessToken() {
    if (this._refreshing) return this._refreshing;

    this._refreshing = (async () => {
      if (!this._refreshToken) throw new Error('No refresh token');
      const res  = await fetch(`${BASE_URL}/auth/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ refreshToken: this._refreshToken }),
      });
      const data = await res.json();
      if (!res.ok || data.code !== 0) {
        this.clearTokens();
        throw new Error('Token refresh failed');
      }
      this._accessToken = data.data.accessToken;
      localStorage.setItem('pmg_access_token', this._accessToken);
      return this._accessToken;
    })().finally(() => { this._refreshing = null; });

    return this._refreshing;
  }

  // ── Core request ─────────────────────────────────────────
  /** path 相对 BASE_URL（如 /users/me）；opts.raw=true 返回完整响应体（含 pagination / _links / meta） */
  async request(method, path, body, opts = {}) {
    return this.requestUrl(method, `${BASE_URL}${path}`, body, opts);
  }

  /** url 可以是绝对地址或网关根相对 href（/v1/…、/api/v1/…，来自 _links） */
  async requestUrl(method, url, body, opts = {}) {
    const target  = resolveHref(BASE_URL, url);
    const headers = {
      'Content-Type':     'application/json',
      'X-Request-ID':     crypto.randomUUID(),
      'X-Client-Ver':     CLIENT_VERSION,
      'X-Client-Id':      CLIENT_ID,        // 弃用接口按客户端统计（REQ-00407）
      'X-Client-Version': CLIENT_VERSION,
      'X-Platform':       'web',
      ...(opts.headers || {}),
    };
    if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

    const authHeader = () => {
      if (this._accessToken && !opts.noAuth) headers['Authorization'] = `Bearer ${this._accessToken}`;
    };
    authHeader();

    const send = () => {
      // 每次尝试独立超时；调用方的 signal 可随时取消（包括退避等待中）
      const timeout = AbortSignal.timeout(opts.timeout || 10000);
      const signal = opts.signal && AbortSignal.any ? AbortSignal.any([opts.signal, timeout]) : (opts.signal || timeout);
      return fetch(target, { method, headers, signal, body: body ? JSON.stringify(body) : undefined });
    };

    // REQ-00402：幂等请求在网络错误 / 408 / 429 / 5xx(502-504) 时指数退避 + full jitter 重试，优先 Retry-After
    let res;
    for (let attempt = 0; ; attempt++) {
      let error = null;
      try {
        res = await send();
      } catch (err) {
        error = err;
      }
      const retry = shouldRetry({ method, status: res && res.status, error, attempt, maxRetries: opts.maxRetries ?? MAX_RETRIES, idempotencyKey: opts.idempotencyKey });
      if (!retry) {
        if (error) {
          if (error.name === 'AbortError' && opts.signal && opts.signal.aborted) throw error;
          throw new ApiError(9999, '网络异常，请检查网络连接', 0);
        }
        break;
      }
      await sleep(retryDelay(attempt + 1, { retryAfter: res && !error ? res.headers.get('Retry-After') : null }), opts.signal);
      res = null;
    }

    // Auto-refresh on 401
    if (res.status === 401 && !opts.noAuth && !opts._retried) {
      try {
        await this.refreshAccessToken();
        authHeader();
        res = await send();
      } catch {
        this.clearTokens();
        throw new ApiError(1002, '请重新登录', 401);
      }
    }

    // REQ-00407：弃用接口提示（每个接口只提示一次），界面可监听 pmg:api-deprecated
    const deprecation = res.headers.get('Deprecation');
    if (deprecation) {
      const key = `${method} ${new URL(target, 'http://x').pathname}`;
      if (!warnedDeprecations.has(key)) {
        warnedDeprecations.add(key);
        const detail = { endpoint: key, sunset: res.headers.get('Sunset'), link: res.headers.get('Link') };
        console.warn('[api] 调用了已弃用的接口', detail);
        try { window.dispatchEvent(new CustomEvent('pmg:api-deprecated', { detail })); } catch { /* 非浏览器环境 */ }
      }
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }
    data = expandAliasedBody(data); // REQ-00251：?_aliases=1 时还原字段名

    if (!res.ok || data.code !== 0) {
      // Handle offline response from service worker
      if (data.offline || data.code === 9999) {
        throw new ApiError(9999, data.message || '当前离线，请检查网络连接', 503);
      }
      const err = new ApiError(data.code || res.status, data.message || '请求失败', res.status);
      if (data.error && typeof data.error === 'object') err.details = data.error;
      throw err;
    }

    return opts.raw ? data : data.data;
  }

  get(path, opts)        { return this.request('GET',    path, null,  opts); }
  navigate(resource)     { return new LinkNavigator(this, resource); }
  pages(path, opts)      { return pageIterator(this, `${BASE_URL}${path}`, opts); }
  post(path, body, opts) { return this.request('POST',   path, body,  opts); }
  patch(path, body, opts){ return this.request('PATCH',  path, body,  opts); }
  del(path, opts)        { return this.request('DELETE', path, null,  opts); }

  // ── Auth ─────────────────────────────────────────────────
  async sendSmsCode(phone, scene = 'login') {
    return this.post('/auth/sms-code', { phone, scene }, { noAuth: true });
  }

  // consent: { privacyPolicy: boolean, termsOfService: boolean } —— 必须来自用户在界面上的勾选，
  // 服务端缺少 consent 会返回 400（code 1010）
  async register(phone, smsCode, nickname, consent) {
    const data = await this.post('/auth/register', { phone, smsCode, nickname, consent }, { noAuth: true });
    this.setTokens(data.accessToken, data.refreshToken);
    return data;
  }

  async login(phone, smsCode) {
    const data = await this.post('/auth/login', { phone, smsCode }, { noAuth: true });
    this.setTokens(data.accessToken, data.refreshToken);
    return data;
  }

  async logout() {
    try { await this.post('/auth/logout'); } catch {}
    this.clearTokens();
  }

  // ── User ─────────────────────────────────────────────────
  getMe()                              { return this.get('/users/me'); }
  updateMe(data)                       { return this.patch('/users/me', data); }
  joinTeam(team)                       { return this.post('/users/team', { team }); }
  getInventory()                       { return this.get('/users/me/inventory'); }
  getQuests()                          { return this.get('/users/me/quests'); }
  getAchievements()                    { return this.get('/users/me/achievements'); }

  // ── Map ──────────────────────────────────────────────────
  getNearby(lat, lng, radius = 500)    { return this.get(`/map/nearby?lat=${lat}&lng=${lng}&radius=${radius}`); }
  updateLocation(lat, lng, accuracy, extra = {}) { return this.post('/location', { lat, lng, accuracy, timestamp: Date.now(), ...extra }); }

  // ── Catch ────────────────────────────────────────────────
  startCatch(spawnId, lat, lng)        { return this.post('/catch/session', { spawnId, playerLat: lat, playerLng: lng }); }
  throwBall(sessionId, ballType, throwRating, isCurve, berryUsed) {
    return this.post('/catch/throw', { sessionId, ballType, throwRating, isCurve, berryUsed });
  }

  // ── Pokemon ──────────────────────────────────────────────
  getMyPokemon(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/pokemon/my${q ? '?'+q : ''}`);
  }
  getPokemonDetail(id)                 { return this.get(`/pokemon/my/${id}`); }
  /** 精灵详情 + 可执行操作（_links.evolve / powerUp / trainer …），用 nav.follow('evolve') 执行 */
  async getPokemonNavigator(id)        { return this.navigate(await this.get(`/pokemon/my/${id}`, { raw: true })); }
  /** REQ-00350：一次取最多 100 只精灵详情，include: skills / equipment / effects / battle / history */
  batchPokemonDetails(ids, include = [], options = {}) {
    return this.post('/pokemon/batch/details', { ids, include, options });
  }
  /** REQ-00526：图鉴 NDJSON 流（网关 Brotli 流式压缩，浏览器自动解压），逐条回调 */
  async streamSpecies(onItem, { signal } = {}) {
    const headers = { Accept: 'application/x-ndjson', 'X-Client-Id': CLIENT_ID };
    if (this._accessToken) headers.Authorization = `Bearer ${this._accessToken}`;
    const res = await fetch(resolveHref(BASE_URL, `${BASE_URL}/pokemon/species/stream`), { headers, signal });
    if (!res.ok) throw new ApiError(res.status, '图鉴数据加载失败', res.status);
    return readNdjson(res, onItem, { signal });
  }
  evolvePokemon(id)                    { return this.post(`/pokemon/my/${id}/evolve`); }
  powerUpPokemon(id)                   { return this.post(`/pokemon/my/${id}/power-up`); }
  getPokedex()                         { return this.get('/pokemon/pokedex'); }
  spinPokestop(id)                     { return this.post(`/pokestops/${id}/spin`); }

  // ── Gym / Raid ────────────────────────────────────────────
  getGym(id)                           { return this.get(`/gyms/${id}`); }
  defendGym(gymId, pokemonId)          { return this.post(`/gyms/${gymId}/defend`, { pokemonId }); }
  battleGym(gymId, pokemonIds)         { return this.post(`/gyms/${gymId}/battle/start`, { pokemonIds }); }
  getRaid(id)                          { return this.get(`/raids/${id}`); }
  joinRaid(id)                         { return this.post(`/raids/${id}/join`); }

  // ── Social ────────────────────────────────────────────────
  getFriends()                         { return this.get('/friends'); }
  addFriend(friendCode)                { return this.post('/friends/add', { friendCode }); }
  sendGift(friendId)                   { return this.post(`/friends/${friendId}/gift`); }
  getGifts()                           { return this.get('/friends/gifts'); }
  openGift(giftId)                     { return this.post(`/friends/gifts/${giftId}/open`); }

  // ── Rewards ───────────────────────────────────────────────
  getDailyReward()                     { return this.get('/rewards/daily'); }
  claimDailyReward()                   { return this.post('/rewards/daily/claim'); }
  getLeaderboard(type = 'xp', team)    { return this.get(`/rewards/leaderboard?type=${type}${team?'&team='+team:''}`); }
  getSeason()                          { return this.get('/rewards/season'); }

  // ── Payment ───────────────────────────────────────────────
  getProducts()                        { return this.get('/payment/products'); }
  createOrder(productId, channel)      {
    const idempotencyKey = crypto.randomUUID();
    // 带幂等键：网络抖动时可安全重试（REQ-00402）
    return this.post('/payment/orders', {
      productId,
      paymentChannel: channel,
      idempotencyKey,
    }, { idempotencyKey });
  }

  // ── Batch（REQ-00308）────────────────────────────────────
  /** requests: [{ id?, method?, path: '/v1/...', body?, priority? }]；返回 { responses, summary } */
  batch(requests, options = {}) {
    return this.requestUrl('POST', '/api/v1/batch', { requests, options });
  }
  verifyPayment(orderId, channelSign)  { return this.post(`/payment/orders/${orderId}/verify`, { channelSign }); }
}

class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name       = 'ApiError';
    this.code       = code;
    this.httpStatus = httpStatus;
  }
}

// Singleton
const api = new ApiClient();
window.pmgApi = api;
export { api, ApiError };
