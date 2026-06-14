# REQ-00092：API 请求合并与批量查询优化

- **编号**：REQ-00092
- **类别**：性能优化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、gateway、pokemon-service、social-service、gym-service
- **创建时间**：2026-06-10 15:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 前端存在以下性能问题：

1. **N+1 查询问题**：用户查看精灵列表后，如果需要加载多个精灵详情，会发起多个独立的 `GET /pokemon/my/:id` 请求，导致：
   - 网络请求数量激增（如用户有 50 个精灵，可能发起 50 个请求）
   - 浏览器并发连接数限制（同一域名最多 6 个并发）
   - 服务端资源浪费（每个请求都需要独立的认证、数据库连接）

2. **请求未去重**：在快速切换标签页或网络波动时，可能短时间内对同一接口发起多次请求，造成：
   - 重复的数据库查询
   - 不必要的带宽消耗
   - 用户界面闪烁（多次数据更新）

3. **缺少批量查询接口**：后端服务未提供批量查询端点，前端只能串行或并发发起多个单条查询请求。

**真实场景**：
- 用户打开精灵收藏页（需要加载 30+ 个精灵详情）
- 用户查看好友列表并批量发送礼物（需要查询 20+ 个好友状态）
- 用户查看附近道馆列表并获取详细信息（需要查询 10+ 个道馆）

## 2. 目标

1. **减少网络请求数量 70%+**：通过请求合并和批量查询接口
2. **消除重复请求**：通过请求去重机制
3. **提升页面加载速度**：首屏渲染时间减少 40%+
4. **降低服务端压力**：数据库连接数、CPU、内存使用减少

## 3. 范围

### 包含
- 前端 API 客户端增强：请求去重、请求合并、批量查询支持
- 后端批量查询 API：精灵批量详情、好友批量状态、道馆批量信息
- Gateway 批量请求路由和限流调整
- 请求合并策略配置（窗口期、最大批量大小）
- 性能指标监控（批量请求成功率、平均批量大小）

### 不包含
- GraphQL 协议迁移（属于更大规模重构）
- WebSocket 批量推送（已有通知系统）
- 缓存策略优化（已有 REQ-00031、REQ-00039）

## 4. 详细需求

### 4.1 前端请求去重机制

在 `frontend/game-client/src/api/client.js` 中实现请求去重：

```javascript
class ApiClient {
  constructor() {
    this._pendingRequests = new Map(); // 正在进行的请求去重
    this._dedupeWindow = 100; // 去重窗口期（毫秒）
  }

  // 请求去重：短时间内对同一端点的请求合并为一个
  async request(method, path, body, opts = {}) {
    const requestKey = `${method}:${path}:${JSON.stringify(body || {})}`;
    
    // 检查是否有正在进行的相同请求
    if (this._pendingRequests.has(requestKey)) {
      return this._pendingRequests.get(requestKey);
    }

    const promise = this._executeRequest(method, path, body, opts)
      .finally(() => {
        // 请求完成后延迟移除（窗口期内相同请求仍可去重）
        setTimeout(() => {
          this._pendingRequests.delete(requestKey);
        }, this._dedupeWindow);
      });

    this._pendingRequests.set(requestKey, promise);
    return promise;
  }
}
```

### 4.2 前端请求合并机制

新增 `frontend/game-client/src/api/batchClient.js`：

```javascript
class BatchApiClient {
  constructor(apiClient) {
    this._apiClient = apiClient;
    this._batchQueue = new Map(); // 批量请求队列
    this._batchWindow = 50; // 批量窗口期（毫秒）
    this._maxBatchSize = 20; // 单次批量最大请求数
  }

  // 批量获取精灵详情
  async batchGetPokemonDetails(ids) {
    if (ids.length === 0) return [];
    if (ids.length === 1) {
      return [await this._apiClient.get(`/pokemon/my/${ids[0]}`)];
    }
    
    // 使用批量接口
    return this._apiClient.post('/pokemon/batch/details', { ids });
  }

  // 批量获取好友状态
  async batchGetFriendStatus(friendIds) {
    if (friendIds.length === 0) return [];
    return this._apiClient.post('/social/batch/friends/status', { friendIds });
  }

  // 批量获取道馆信息
  async batchGetGyms(gymIds) {
    if (gymIds.length === 0) return [];
    return this._apiClient.post('/gym/batch/details', { gymIds });
  }

  // 智能请求合并（延迟窗口内的请求自动合并）
  queueBatchRequest(endpoint, id, collection) {
    return new Promise((resolve, reject) => {
      if (!this._batchQueue.has(endpoint)) {
        this._batchQueue.set(endpoint, {
          ids: [],
          resolves: [],
          rejects: [],
          timer: null
        });
      }

      const batch = this._batchQueue.get(endpoint);
      batch.ids.push(id);
      batch.resolves.push(resolve);
      batch.rejects.push(reject);

      // 达到最大批量大小立即执行
      if (batch.ids.length >= this._maxBatchSize) {
        this._executeBatch(endpoint);
      } else if (!batch.timer) {
        // 设置窗口期定时器
        batch.timer = setTimeout(() => {
          this._executeBatch(endpoint);
        }, this._batchWindow);
      }
    });
  }

  async _executeBatch(endpoint) {
    const batch = this._batchQueue.get(endpoint);
    if (!batch || batch.ids.length === 0) return;

    this._batchQueue.delete(endpoint);
    clearTimeout(batch.timer);

    try {
      const results = await this._apiClient.post(endpoint, { ids: batch.ids });
      batch.resolves.forEach((resolve, i) => resolve(results[i]));
    } catch (error) {
      batch.rejects.forEach(reject => reject(error));
    }
  }
}
```

### 4.3 后端批量查询 API

#### 精灵批量详情 API

**POST /pokemon/batch/details**

路径：`backend/services/pokemon-service/src/routes/batch.js`

```javascript
/**
 * 批量获取精灵详情
 * POST /pokemon/batch/details
 * Body: { ids: [123, 456, 789] }
 * Response: { code: 0, data: [pokemon1, pokemon2, pokemon3] }
 */
router.post('/batch/details', requireAuth, async (req, res, next) => {
  try {
    const { ids } = req.body;
    const userId = req.user.sub;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError(1001, 'ids 必须是非空数组', 400);
    }

    if (ids.length > 50) {
      throw new AppError(1002, '单次批量查询最多 50 条', 400);
    }

    // 去重
    const uniqueIds = [...new Set(ids)];

    // 批量查询
    const { rows } = await query(`
      SELECT pi.id, pi.species_id, pi.nickname, pi.cp,
             pi.hp_current, pi.hp_max,
             pi.iv_attack, pi.iv_defense, pi.iv_hp,
             ROUND((pi.iv_attack+pi.iv_defense+pi.iv_hp)*100.0/45, 1) AS iv_pct,
             pi.is_shiny, pi.is_lucky, pi.is_favorite,
             pi.fast_move, pi.charge_move, pi.caught_at,
             ps.name_zh, ps.name_en, ps.type1, ps.type2, 
             ps.sprite_url, ps.rarity
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = ANY($1) AND pi.user_id = $2
    `, [uniqueIds, userId]);

    // 按 ids 顺序返回（保持前端顺序）
    const pokemonMap = new Map(rows.map(p => [p.id, p]));
    const results = ids.map(id => pokemonMap.get(id) || null);

    res.json(successResp(results));
  } catch (err) { next(err); }
});
```

#### 好友批量状态 API

**POST /social/batch/friends/status**

路径：`backend/services/social-service/src/routes/batch.js`

```javascript
/**
 * 批量获取好友在线状态和最后活跃时间
 * POST /social/batch/friends/status
 * Body: { friendIds: ['user1', 'user2', 'user3'] }
 */
router.post('/batch/friends/status', requireAuth, async (req, res, next) => {
  try {
    const { friendIds } = req.body;
    const userId = req.user.sub;

    if (!Array.isArray(friendIds) || friendIds.length === 0) {
      throw new AppError(1001, 'friendIds 必须是非空数组', 400);
    }

    if (friendIds.length > 100) {
      throw new AppError(1002, '单次批量查询最多 100 条', 400);
    }

    // 验证好友关系
    const { rows: friendships } = await query(`
      SELECT 
        CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS friend_id
      FROM friendships f
      WHERE (f.user_a=$1 OR f.user_b=$1)
        AND (f.user_a = ANY($2) OR f.user_b = ANY($2))
    `, [userId, friendIds]);

    const validFriendIds = new Set(friendships.map(f => f.friend_id));

    // 从 Redis 获取在线状态（最近 5 分钟活跃）
    const redis = require('../../../shared/redis').getClient();
    const onlineStatuses = await redis.mget(
      friendIds.map(id => `user:online:${id}`)
    );

    // 批量查询用户信息
    const { rows: users } = await query(`
      SELECT id, nickname, level, team, last_active_at
      FROM users
      WHERE id = ANY($1)
    `, [friendIds]);

    const userMap = new Map(users.map(u => [u.id, u]));

    const results = friendIds.map((friendId, index) => {
      const user = userMap.get(friendId);
      const isOnline = onlineStatuses[index] === '1';
      const isFriend = validFriendIds.has(friendId);

      return {
        friendId,
        isFriend,
        nickname: user?.nickname || null,
        level: user?.level || null,
        team: user?.team || null,
        isOnline,
        lastActiveAt: user?.last_active_at || null
      };
    });

    res.json(successResp(results));
  } catch (err) { next(err); }
});
```

#### 道馆批量信息 API

**POST /gym/batch/details**

路径：`backend/services/gym-service/src/routes/batch.js`

```javascript
/**
 * 批量获取道馆详细信息
 * POST /gym/batch/details
 * Body: { gymIds: ['gym1', 'gym2', 'gym3'] }
 */
router.post('/batch/details', async (req, res, next) => {
  try {
    const { gymIds } = req.body;

    if (!Array.isArray(gymIds) || gymIds.length === 0) {
      throw new AppError(1001, 'gymIds 必须是非空数组', 400);
    }

    if (gymIds.length > 50) {
      throw new AppError(1002, '单次批量查询最多 50 条', 400);
    }

    // 批量查询道馆信息
    const { rows: gyms } = await query(`
      SELECT g.id, g.name, g.lat, g.lng, g.team, g.prestige,
             g.ex RaidSlots, g.level,
             (SELECT COUNT(*)::int FROM gym_defenders WHERE gym_id = g.id) AS defender_count,
             (SELECT json_agg(json_build_object(
               'pokemon_id', gd.pokemon_id,
               'cp', gd.cp,
               'trainer_name', u.nickname
             )) FROM gym_defenders gd
             JOIN users u ON u.id = gd.user_id
             WHERE gd.gym_id = g.id
             ORDER BY gd.slot_order
             LIMIT 6) AS defenders
      FROM gyms g
      WHERE g.id = ANY($1)
    `, [gymIds]);

    const gymMap = new Map(gyms.map(g => [g.id, g]));
    const results = gymIds.map(id => gymMap.get(id) || null);

    res.json(successResp(results));
  } catch (err) { next(err); }
});
```

### 4.4 Gateway 路由配置

在 `backend/gateway/src/index.js` 中添加批量接口路由：

```javascript
// 批量查询路由（增加限流阈值）
app.post('/pokemon/batch/details', 
  rateLimit({ windowMs: 60000, max: 100 }), // 100 次/分钟
  proxyToService('pokemon-service')
);

app.post('/social/batch/friends/status', 
  rateLimit({ windowMs: 60000, max: 50 }),
  proxyToService('social-service')
);

app.post('/gym/batch/details', 
  rateLimit({ windowMs: 60000, max: 100 }),
  proxyToService('gym-service')
);
```

### 4.5 Prometheus 指标

新增批量请求相关指标：

```javascript
// backend/shared/metrics.js 新增指标
const batchRequestTotal = new Counter({
  name: 'api_batch_request_total',
  help: 'Total number of batch API requests',
  labelNames: ['service', 'endpoint', 'status'],
});

const batchRequestSize = new Histogram({
  name: 'api_batch_request_size',
  help: 'Distribution of batch request sizes',
  labelNames: ['service', 'endpoint'],
  buckets: [1, 5, 10, 20, 30, 40, 50],
});

const requestDeduplicationHits = new Counter({
  name: 'api_request_deduplication_hits_total',
  help: 'Number of requests deduplicated',
  labelNames: ['client_type'],
});
```

## 5. 验收标准（可测试）

- [ ] 前端 API 客户端实现请求去重机制，相同请求在 100ms 窗口期内只发起一次
- [ ] 前端实现 BatchApiClient，支持批量查询精灵详情、好友状态、道馆信息
- [ ] 后端新增 `POST /pokemon/batch/details` 接口，支持单次最多 50 个 ID 查询
- [ ] 后端新增 `POST /social/batch/friends/status` 接口，支持单次最多 100 个好友状态查询
- [ ] 后端新增 `POST /gym/batch/details` 接口，支持单次最多 50 个道馆信息查询
- [ ] 精灵收藏页（30 个精灵）从发起 30 个请求优化为 1 个批量请求
- [ ] 请求去重单元测试覆盖率 ≥ 90%
- [ ] 批量查询接口单元测试覆盖率 ≥ 90%
- [ ] 性能基准测试：批量查询延迟 < 单条查询延迟 × 3（即 50 个查询的批量请求延迟不超过 3 倍单条查询）
- [ ] 前端页面加载时间减少 40%+（通过 Lighthouse 性能测试验证）
- [ ] 新增 3 个 Prometheus 指标：`api_batch_request_total`、`api_batch_request_size`、`api_request_deduplication_hits_total`

## 6. 工作量估算

**M（中等）** - 预计 1-2 天

**理由**：
- 前端改造：0.5 天（请求去重和批量客户端）
- 后端批量接口：0.5 天（3 个批量接口）
- Gateway 路由配置：0.25 天
- 测试编写：0.5 天（单元测试 + 性能测试）
- 文档和代码审查：0.25 天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **性能影响大**：N+1 查询问题是前后端性能优化的常见痛点，直接影响用户体验
2. **实施成本低**：无需引入新技术栈，是对现有 API 的增强
3. **收益明确**：网络请求数减少 70%+，页面加载速度提升 40%+，效果可量化
4. **无副作用**：不影响现有接口，向后兼容
5. **基础能力**：为后续更多批量操作（批量战斗、批量交易）奠定基础
