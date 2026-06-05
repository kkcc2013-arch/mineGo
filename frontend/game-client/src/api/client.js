// frontend/game-client/src/api/client.js
// Unified API client with auth, retry, and error handling
'use strict';

const BASE_URL = window.PMG_CONFIG?.apiBase || 'https://api.pocketmonstergo.com/v1';

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
  async request(method, path, body, opts = {}) {
    const url     = `${BASE_URL}${path}`;
    const headers = {
      'Content-Type':   'application/json',
      'X-Request-ID':   crypto.randomUUID(),
      'X-Client-Ver':   '1.0.0',
      'X-Platform':     'web',
    };

    if (this._accessToken && !opts.noAuth) {
      headers['Authorization'] = `Bearer ${this._accessToken}`;
    }

    const fetchOpts = {
      method,
      headers,
      signal: opts.signal || AbortSignal.timeout(opts.timeout || 10000),
    };
    if (body) fetchOpts.body = JSON.stringify(body);

    let res = await fetch(url, fetchOpts);

    // Auto-refresh on 401
    if (res.status === 401 && !opts.noAuth && !opts._retried) {
      try {
        await this.refreshAccessToken();
        headers['Authorization'] = `Bearer ${this._accessToken}`;
        res = await fetch(url, { ...fetchOpts, headers, signal: AbortSignal.timeout(10000) });
      } catch {
        this.clearTokens();
        throw new ApiError(1002, '请重新登录', 401);
      }
    }

    const data = await res.json();

    if (!res.ok || data.code !== 0) {
      // Handle offline response from service worker
      if (data.offline || data.code === 9999) {
        throw new ApiError(9999, data.message || '当前离线，请检查网络连接', 503);
      }
      throw new ApiError(data.code || res.status, data.message || '请求失败', res.status);
    }

    return data.data;
  }

  get(path, opts)        { return this.request('GET',    path, null,  opts); }
  post(path, body, opts) { return this.request('POST',   path, body,  opts); }
  patch(path, body, opts){ return this.request('PATCH',  path, body,  opts); }
  del(path, opts)        { return this.request('DELETE', path, null,  opts); }

  // ── Auth ─────────────────────────────────────────────────
  async sendSmsCode(phone, scene = 'login') {
    return this.post('/auth/sms-code', { phone, scene }, { noAuth: true });
  }

  async register(phone, smsCode, nickname) {
    const data = await this.post('/auth/register', { phone, smsCode, nickname }, { noAuth: true });
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
  updateLocation(lat, lng, accuracy)   { return this.post('/location', { lat, lng, accuracy, timestamp: Date.now() }); }

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
  evolvePokemon(id)                    { return this.post(`/pokemon/my/${id}/evolve`); }
  powerUpPokemon(id)                   { return this.post(`/pokemon/my/${id}/power-up`); }
  getPokedex()                         { return this.get('/pokemon/pokedex'); }
  spinPokestop(id)                     { return this.post(`/pokestops/${id}/spin`); }

  // ── Gym / Raid ────────────────────────────────────────────
  getGym(id)                           { return this.get(`/gyms/${id}`); }
  defendGym(gymId, pokemonId)          { return this.post(`/gyms/${gymId}/defend`, { pokemonId }); }
  battleGym(gymId, pokemonIds)         { return this.post(`/gyms/${gymId}/battle`, { attackerPokemons: pokemonIds }); }
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
    return this.post('/payment/orders', {
      productId,
      paymentChannel: channel,
      idempotencyKey: crypto.randomUUID(),
    });
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
