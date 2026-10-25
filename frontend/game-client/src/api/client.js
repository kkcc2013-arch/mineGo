// frontend/game-client/src/api/client.js
// Unified API client with auth, retry, and error handling
'use strict';

const BASE_URL = (window.PMG_CONFIG?.apiBase || '/v1').replace(/\/$/,'');

class ApiClient {
  constructor() {
    this._accessToken  = localStorage.getItem('pmg_access_token');
    this._refreshToken = localStorage.getItem('pmg_refresh_token');
    this._refreshing   = null; // Promise de-dup
    this._authEpoch=0;
    this._pendingMfa=null;
    this._mfaCompleting=null;
    if([this._accessToken,this._refreshToken].some(value=>value==='undefined'||value==='null'))this.clearTokens({notify:false});
  }

  // ── Token management ────────────────────────────────────
  setTokens(accessToken, refreshToken) {
    if(![accessToken,refreshToken].every(value=>typeof value==='string'&&value.trim()&&!['undefined','null'].includes(value)))throw new ApiError('AUTH_RESPONSE_INVALID','登录响应不完整，请重试',503);
    try{localStorage.setItem('pmg_access_token',accessToken);localStorage.setItem('pmg_refresh_token',refreshToken);}
    catch{this._accessToken=this._refreshToken=null;try{localStorage.removeItem('pmg_access_token');localStorage.removeItem('pmg_refresh_token');}catch{}throw new ApiError('AUTH_STORAGE_UNAVAILABLE','无法保存登录状态，请重试',503);}
    this._accessToken=accessToken;this._refreshToken=refreshToken;
  }
  clearTokens({notify=true}={}) {
    this._authEpoch++;
    this._accessToken=this._refreshToken=null;
    this._pendingMfa=null;this._mfaCompleting=null;this._refreshing=null;
    localStorage.removeItem('pmg_access_token');localStorage.removeItem('pmg_refresh_token');
    if(notify)window.dispatchEvent(new Event('pmg:logout'));
  }
  cancelMfaLogin(){this._authEpoch++;this._pendingMfa=null;this._mfaCompleting=null;}
  get hasSession(){return typeof this._accessToken==='string'&&!!this._accessToken;}
  get mfaPending(){return !!this._pendingMfa;}
  async refreshAccessToken() {
    if(this._refreshing)return this._refreshing;
    const epoch=this._authEpoch,refreshToken=this._refreshToken;
    const pending=(async()=>{
      if(!refreshToken)throw new ApiError(1002,'请重新登录',401);
      const response=await fetch(`${BASE_URL}/auth/refresh`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken}),signal:AbortSignal.timeout(10000)});
      const envelope=await response.json();
      if(epoch!==this._authEpoch||refreshToken!==this._refreshToken)throw new ApiError('AUTH_CANCELLED','登录状态已改变',401);
      if(!response.ok||envelope.code!==0)throw new ApiError(1002,'请重新登录',401);
      this.setTokens(envelope.data?.accessToken,envelope.data?.refreshToken);
      return this._accessToken;
    })().finally(()=>{if(this._refreshing===pending)this._refreshing=null;});
    this._refreshing=pending;return pending;
  }

  // ── Core request ─────────────────────────────────────────
  async request(method, path, body, opts = {}) {
    const url     = `${BASE_URL}${path}`;
    const epoch=this._authEpoch;
    const headers = new Headers({
      'Content-Type':   'application/json',
      'X-Request-ID':   crypto.randomUUID(),
      'X-Client-Ver':   '1.0.0',
      'X-Platform':     'web',
      ...opts.headers
    });

    if (this._accessToken && !opts.noAuth) {
      headers.set('Authorization',`Bearer ${this._accessToken}`);
    }else headers.delete('Authorization');

    const fetchOpts = {
      method,
      cache: 'no-store',
      headers,
      signal: opts.signal || AbortSignal.timeout(opts.timeout || 10000),
    };
    if (body) fetchOpts.body = JSON.stringify(body);

    let res = await fetch(url, fetchOpts);

    // Auto-refresh on 401
    if (res.status === 401 && !opts.noAuth && !opts.noRefresh && !opts._retried) {
      try {
        if(epoch!==this._authEpoch)throw new ApiError('AUTH_CANCELLED','登录状态已改变',401);
        await this.refreshAccessToken();
        headers.set('Authorization',`Bearer ${this._accessToken}`);
        res = await fetch(url, { ...fetchOpts, headers, signal: AbortSignal.timeout(10000) });
      } catch {
        if(epoch===this._authEpoch)this.clearTokens();
        throw new ApiError(1002, '请重新登录', 401);
      }
    }

    if(!opts.noAuth&&epoch!==this._authEpoch)throw new ApiError('AUTH_CANCELLED','登录状态已改变',401);
    const data = await res.json();
    if(!opts.noAuth&&epoch!==this._authEpoch)throw new ApiError('AUTH_CANCELLED','登录状态已改变',401);

    if (!res.ok || !(data.code===0||data.success===true&&data.code===undefined)) {
      // Handle offline response from service worker
      if (data.offline || data.code === 9999) {
        throw new ApiError(9999, data.message || '当前离线，请检查网络连接', 503);
      }
      const code=data.code??(typeof data.error==='string'?data.error:data.error?.code)??res.status;
      throw new ApiError(code, data.message||data.error?.message||MFA_MESSAGES[code]||'请求失败',res.status);
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
    this.clearTokens({notify:false});const epoch=this._authEpoch;
    const data=await this.post('/auth/register',{phone,smsCode,nickname},{noAuth:true});
    if(epoch!==this._authEpoch)throw new ApiError('AUTH_CANCELLED','登录已取消',401);
    this.setTokens(data.accessToken,data.refreshToken);return data;
  }
  async login(phone,smsCode) {
    this.clearTokens({notify:false});const epoch=this._authEpoch;
    const data=await this.post('/auth/login',{phone,smsCode},{noAuth:true});
    if(epoch!==this._authEpoch)throw new ApiError('AUTH_CANCELLED','登录已取消',401);
    if(data.mfaRequired===true){
      if(typeof data.tempToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.tempToken))throw new ApiError('AUTH_RESPONSE_INVALID','验证请求无效，请重新登录',503);
      this._pendingMfa={challenge:data.tempToken,deadline:performance.now()+300000};
      return {mfaRequired:true,expiresAt:data.expiresAt};
    }
    this.setTokens(data.accessToken,data.refreshToken);return data;
  }
  completeMfaLogin(code,recovery=false,opts={}) {
    if(this._mfaCompleting)return this._mfaCompleting;
    const epoch=this._authEpoch,pending=this._pendingMfa;
    if(!pending||performance.now()>=pending.deadline){this.cancelMfaLogin();return Promise.reject(new ApiError('MFA_CHALLENGE_INVALID','验证请求已过期，请重新登录',401));}
    const operation=(async()=>{
      try{
        const data=await this.post(recovery?'/auth/mfa/recovery':'/auth/mfa/verify',{challenge:pending.challenge,code},{...opts,noAuth:true,noRefresh:true});
        if(epoch!==this._authEpoch||this._pendingMfa!==pending)throw new ApiError('AUTH_CANCELLED','登录已取消',401);
        this.setTokens(data.accessToken,data.refreshToken);this._pendingMfa=null;return data;
      }catch(error){if(error.code==='MFA_CHALLENGE_INVALID'&&epoch===this._authEpoch)this.cancelMfaLogin();throw error;}
    })().finally(()=>{if(this._mfaCompleting===operation)this._mfaCompleting=null;});
    this._mfaCompleting=operation;return operation;
  }
  async logout() {
    const token=this._accessToken;this.clearTokens();
    if(token){try{await fetch(`${BASE_URL}/auth/logout`,{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});}catch{}}
  }
  getMfaStatus(opts={}){return this.get('/users/me/mfa/status',opts);}
  setupMfa(opts={}){return this.post('/users/me/mfa/setup',{}, {...opts,noRefresh:true});}
  enableMfa(code,opts={}){return this.post('/users/me/mfa/enable',{code},{...opts,noRefresh:true});}
  disableMfa(code,opts={}){return this.post('/users/me/mfa/disable',{code},{...opts,noRefresh:true});}
  regenerateMfaCodes(code,opts={}){return this.post('/users/me/mfa/recovery-codes/regenerate',{code},{...opts,noRefresh:true});}
  verifyMfa(code,scope,opts={}){return this.post('/users/me/mfa/step-up',{code,scope},{...opts,noRefresh:true});}

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
  createOrder(productId,channel,key=crypto.randomUUID()){
    return this.post('/payment/orders',{productId,paymentChannel:channel,idempotencyKey:key},{headers:{'X-Idempotency-Key':key},noRefresh:true});
  }
  verifyPayment(orderId,channelSign,channelOrderId){return this.post(`/payment/orders/${orderId}/verify`,{channelSign,channelOrderId},{noRefresh:true});}
}

const MFA_MESSAGES={
  MFA_INVALID_FACTOR:'验证码无效或已使用，请输入新的验证码',
  MFA_FACTOR_INVALID:'请输入六位验证码或 XXXX-XXXX 格式的恢复码',
  MFA_LOCKED:'验证失败次数过多，账户验证已锁定十五分钟',
  MFA_CHALLENGE_INVALID:'验证请求已过期或已使用，请重新登录',
  MFA_UNAVAILABLE:'暂时无法验证，请稍后重试',
  MFA_LEGACY_PROFILE_REVIEW:'此账户需要管理员协助恢复验证设置',
  MFA_ALREADY_ENABLED:'此账户已启用验证，请刷新状态',
  MFA_SETUP_REQUIRED:'请重新开始验证器设置',
};

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
