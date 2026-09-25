/**
 * REQ-00518: 超媒体链接（HATEOAS / HAL）与资源发现
 *
 * - LinkRegistry：资源类型 → 链接模板（rel、href 模板、method、title、条件）
 * - LinksBuilder：展开模板、生成资源/集合/分页链接、RFC 8288 Link 头
 * - HalFormatter：HAL 表示（_links / _embedded），Accept: application/hal+json 时使用
 * - ResourceDiscoverer：/api/discover 发现文档
 * - resolveRoute()：把网关对外路径映射到资源类型（item/collection）
 *
 * 链接只指向经网关可达的路径（/v1/...），不暴露内部服务地址。
 */
'use strict';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 展开 {name} 模板；缺少变量返回 null（该链接不生成） */
function expand(template, vars) {
  let missing = false;
  const href = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') { missing = true; return ''; }
    return encodeURIComponent(String(v));
  });
  return missing ? null : href;
}

class LinkRegistry {
  constructor() {
    this.resources = new Map(); // type -> { links: [], collection, title }
    this.routes = [];           // { re, type, kind, idGroup }
    this.embeds = [];           // { re, map: { 字段名: 资源类型 } }：复合响应里内嵌集合的逐项链接
  }

  /** 复合响应（如 /v1/map/nearby 的 wildPokemons / pokestops / gyms）：为 data 下的内嵌数组逐项附操作链接 */
  embed(pattern, map) {
    this.embeds.push({ re: pattern instanceof RegExp ? pattern : new RegExp(pattern), map });
    return this;
  }

  embedsFor(path) {
    const e = this.embeds.find((x) => x.re.test(path));
    return e ? e.map : null;
  }

  /**
   * @param {string} type 资源类型
   * @param {object} def { title, collection: '/v1/..', links: [{ rel, href, method, title, when(data,ctx) }] }
   */
  define(type, def) {
    this.resources.set(type, { title: def.title || type, collection: def.collection || null, links: def.links || [], idField: def.idField || 'id' });
    return this;
  }

  get(type) { return this.resources.get(type) || null; }
  types() { return [...this.resources.keys()]; }

  /** 注册网关路径 → 资源类型映射 */
  route(pattern, type, kind = 'item') {
    this.routes.push({ re: pattern instanceof RegExp ? pattern : new RegExp(pattern), type, kind });
    return this;
  }

  resolve(path) {
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (m) return { type: r.type, kind: r.kind, pathId: m[1] ? decodeURIComponent(m[1]) : null };
    }
    return null;
  }
}

class LinksBuilder {
  constructor(registry) {
    this.registry = registry;
  }

  /** 资源级链接（含操作链接）；data 为资源对象 */
  forResource(type, data, ctx = {}) {
    const def = this.registry.get(type);
    const links = {};
    if (!def || !isPlainObject(data)) return links;
    const vars = { ...data, id: data[def.idField] !== undefined ? data[def.idField] : ctx.pathId };
    for (const l of def.links) {
      try {
        if (typeof l.when === 'function' && !l.when(data, ctx)) continue;
      } catch { continue; }
      const href = expand(l.href, vars);
      if (!href) continue;
      const link = { href };
      if (l.method && l.method !== 'GET') link.method = l.method;
      if (l.title) link.title = l.title;
      if (l.templated) link.templated = true;
      links[l.rel] = link;
    }
    if (def.collection && !links.collection) links.collection = { href: def.collection };
    return links;
  }

  /** 集合级链接：self + 资源集合入口 */
  forCollection(type, selfHref) {
    const def = this.registry.get(type);
    const links = { self: { href: selfHref } };
    if (def && def.collection && def.collection !== selfHref.split('?')[0]) links.collection = { href: def.collection };
    return links;
  }

  static toLinkHeader(links) {
    return Object.entries(links || {})
      .filter(([, l]) => l && l.href)
      .map(([rel, l]) => `<${l.href}>; rel="${rel}"${l.title ? `; title="${String(l.title).replace(/"/g, "'")}"` : ''}`)
      .join(', ');
  }

  /** 解析 Link 头为 { rel: { href } } */
  static parseLinkHeader(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(/,(?=\s*<)/)) {
      const m = part.match(/<([^>]*)>\s*;(.*)/);
      if (!m) continue;
      const rel = (m[2].match(/rel="?([^";]+)"?/) || [])[1];
      if (rel) for (const r of rel.split(/\s+/)) out[r] = { href: m[1] };
    }
    return out;
  }
}

class HalFormatter {
  /**
   * 把标准信封 { success, data, meta, _links } 转为 HAL：
   *   单资源：{ ...data, _links, _meta }
   *   集合：  { _links, _embedded: { <rel>: [...] }, page: {...}, _meta }
   */
  static format(body, { rel = 'items' } = {}) {
    if (!isPlainObject(body)) return body;
    const { data, _links, meta, pagination, success, code, message, ...rest } = body;
    const _meta = { ...(meta || {}), ...(success !== undefined ? { success } : {}), ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) };
    if (Array.isArray(data)) {
      return { _links: _links || {}, _embedded: { [rel]: data }, ...(pagination ? { page: pagination } : {}), _meta, ...rest };
    }
    if (isPlainObject(data)) {
      const list = Object.entries(data).find(([, v]) => Array.isArray(v));
      if (list && pagination) {
        const [k, arr] = list;
        const others = Object.fromEntries(Object.entries(data).filter(([key]) => key !== k));
        return { ...others, _links: _links || {}, _embedded: { [k]: arr }, page: pagination, _meta, ...rest };
      }
      return { ...data, _links: _links || data._links || {}, _meta, ...rest };
    }
    return { value: data, _links: _links || {}, _meta, ...rest };
  }

  static isValid(hal) {
    if (!isPlainObject(hal) || !isPlainObject(hal._links)) return false;
    return Object.values(hal._links).every((l) => (Array.isArray(l) ? l : [l]).every((x) => isPlainObject(x) && typeof x.href === 'string'));
  }
}

class ResourceDiscoverer {
  constructor(registry, { apiVersion = '1.0.0', documentation = '/api-docs', extraLinks = {} } = {}) {
    this.registry = registry;
    this.apiVersion = apiVersion;
    this.documentation = documentation;
    this.extraLinks = extraLinks;
    this.cache = null;
    this.cacheAt = 0;
    this.cacheTTL = 3600 * 1000;
  }

  discover() {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < this.cacheTTL) {
      return { ...this.cache, _meta: { ...this.cache._meta, server_time: new Date().toISOString() } };
    }
    const links = { self: { href: '/api/discover' } };
    const resources = {};
    for (const type of this.registry.types()) {
      const def = this.registry.get(type);
      if (def.collection) links[type] = { href: def.collection, title: def.title };
      resources[type] = {
        title: def.title,
        collection: def.collection,
        actions: def.links.map((l) => ({ rel: l.rel, href: l.href, method: l.method || 'GET', title: l.title || null, templated: /\{/.test(l.href) })),
      };
    }
    Object.assign(links, this.extraLinks);
    this.cache = {
      _links: links,
      resources,
      _meta: { api_version: this.apiVersion, documentation: this.documentation, server_time: new Date().toISOString() },
    };
    this.cacheAt = now;
    return this.cache;
  }
}

/** mineGo 核心资源链接定义（REQ-00518 §4.7），路径均为网关对外路径 */
function createDefaultRegistry() {
  const r = new LinkRegistry();
  r.define('pokemon', {
    title: '我的精灵',
    collection: '/v1/pokemon/my',
    links: [
      { rel: 'self', href: '/v1/pokemon/my/{id}' },
      { rel: 'species', href: '/v1/pokemon/species/{species_id}', title: '精灵图鉴' },
      { rel: 'evolve', href: '/v1/pokemon/my/{id}/evolve', method: 'POST', title: '进化精灵',
        when: (d) => d.evolves_to === undefined || (d.evolves_to !== null && (d.candy_count === undefined || d.candy_to_evolve === undefined || Number(d.candy_count) >= Number(d.candy_to_evolve))) },
      { rel: 'powerUp', href: '/v1/pokemon/my/{id}/power-up', method: 'POST', title: '强化精灵' },
      { rel: 'setFavorite', href: '/v1/pokemon/favorites', method: 'POST', title: '设为收藏（body: {pokemonId}）' },
      { rel: 'transfer', href: '/v1/pokemon/release/execute', method: 'POST', title: '放生/转移精灵（body: {pokemonIds}）' },
      { rel: 'trainer', href: '/v1/users/{user_id}', title: '所属训练师' },
      { rel: 'batch', href: '/v1/pokemon/batch/details', method: 'POST', title: '批量查询详情' },
    ],
  });
  r.define('species', {
    title: '精灵图鉴',
    collection: '/v1/pokemon/species',
    links: [
      { rel: 'self', href: '/v1/pokemon/species/{id}' },
      { rel: 'evolvesTo', href: '/v1/pokemon/species/{evolves_to}', title: '进化形态' },
    ],
  });
  r.define('gym', {
    title: '道馆',
    collection: '/v1/gyms/nearby',
    links: [
      { rel: 'self', href: '/v1/gyms/{id}' },
      { rel: 'defend', href: '/v1/gyms/{id}/defend', method: 'POST', title: '派驻防守' },
      { rel: 'nearby', href: '/v1/gyms/nearby?lat={lat}&lng={lng}', title: '附近道馆' },
    ],
  });
  r.define('user', {
    title: '训练师',
    collection: null,
    links: [
      { rel: 'self', href: '/v1/users/{id}' },
      { rel: 'profile', href: '/v1/users/{id}/profile', title: '公开资料' },
      { rel: 'inventory', href: '/v1/users/me/inventory', title: '背包道具', when: (d, ctx) => ctx.isMe },
      { rel: 'friends', href: '/v1/friends', title: '好友', when: (d, ctx) => ctx.isMe },
      { rel: 'achievements', href: '/v1/users/me/achievements', title: '成就', when: (d, ctx) => ctx.isMe },
      { rel: 'pokemon', href: '/v1/pokemon/my', title: '我的精灵', when: (d, ctx) => ctx.isMe },
    ],
  });
  r.define('trade', {
    title: '交易',
    collection: '/v1/trades/history',
    links: [
      { rel: 'self', href: '/v1/trades/{id}' },
      { rel: 'accept', href: '/v1/trades/{id}/confirm', method: 'POST', title: '确认交易', when: (d) => !d.status || ['PENDING', 'pending', 'REQUESTED', 'requested'].includes(d.status) },
      { rel: 'cancel', href: '/v1/trades/{id}/cancel', method: 'POST', title: '取消交易', when: (d) => !d.status || !['COMPLETED', 'completed', 'CANCELLED', 'cancelled'].includes(d.status) },
      { rel: 'initiator', href: '/v1/users/{initiator_id}', title: '发起人' },
      { rel: 'receiver', href: '/v1/users/{receiver_id}', title: '接收人' },
    ],
  });
  r.define('spawn', {
    title: '野生精灵',
    collection: null,
    links: [
      { rel: 'catch', href: '/v1/catch/session', method: 'POST', title: '开始捕捉（body: {spawnId: id, playerLat, playerLng}）' },
      { rel: 'species', href: '/v1/pokemon/species/{species_id}', title: '精灵图鉴' },
    ],
  });
  r.define('pokestop', {
    title: '补给站',
    collection: null,
    links: [
      { rel: 'spin', href: '/v1/pokestops/{id}/spin', method: 'POST', title: '转动补给站', when: (d) => d.can_spin !== false },
    ],
  });
  r.define('raid', {
    title: '团体战',
    collection: '/v1/raids/nearby',
    links: [
      { rel: 'self', href: '/v1/raids/{id}' },
      { rel: 'join', href: '/v1/raids/{id}/join', method: 'POST', title: '加入团体战' },
    ],
  });

  const V = '(?:/api)?/v\\d+';
  r.route(new RegExp(`^${V}/pokemon/my/([0-9a-fA-F-]{8,})$`), 'pokemon', 'item');
  r.route(new RegExp(`^${V}/pokemon/my$`), 'pokemon', 'collection');
  r.route(new RegExp(`^${V}/pokemon/species/(\\d+)$`), 'species', 'item');
  r.route(new RegExp(`^${V}/pokemon/species$`), 'species', 'collection');
  r.route(new RegExp(`^${V}/gyms/nearby$`), 'gym', 'collection');
  r.route(new RegExp(`^${V}/gyms/([^/]+)$`), 'gym', 'item');
  r.route(new RegExp(`^${V}/raids/nearby$`), 'raid', 'collection');
  r.route(new RegExp(`^${V}/raids/([^/]+)$`), 'raid', 'item');
  r.embed(new RegExp(`^${V}/map/nearby$`), { wildPokemons: 'spawn', pokestops: 'pokestop', gyms: 'gym' });
  r.route(new RegExp(`^${V}/users/me$`), 'user', 'item');
  r.route(new RegExp(`^${V}/users/([0-9a-fA-F-]{8,})$`), 'user', 'item');
  r.route(new RegExp(`^${V}/trades/([0-9a-fA-F-]{8,})$`), 'trade', 'item');
  return r;
}

module.exports = {
  expand,
  LinkRegistry,
  LinksBuilder,
  HalFormatter,
  ResourceDiscoverer,
  createDefaultRegistry,
};
