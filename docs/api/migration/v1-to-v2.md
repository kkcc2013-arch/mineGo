# API v1 → v2 迁移指南

> 本文档描述从 mineGo API v1 迁移到 v2 的步骤和注意事项。

## 变更概览

| 端点 | 变更类型 | 影响级别 | 描述 |
|------|----------|----------|------|
| `GET /api/v2/catch/nearby` | 新增参数 | 低 | 新增 `rarity` 过滤参数 |
| `GET /api/v2/users/:id/profile` | 响应扩展 | 低 | 新增 `stats` 字段 |
| `GET /api/v2/pokemon` | 响应扩展 | 低 | 新增 `moves` 和 `iv` 字段 |
| `POST /api/v2/pokemon/:id/learn-move` | 新增端点 | 低 | 技能学习功能 |
| `GET /api/v2/map/nearby` | 性能优化 | 低 | 响应体积减少 40% |

## 详细变更

### 1. GET /api/v2/catch/nearby

**v1 请求:**
```
GET /api/v1/catch/nearby?lat=31.2304&lng=121.4737&radius=500
```

**v2 请求（新增参数）:**
```
GET /api/v2/catch/nearby?lat=31.2304&lng=121.4737&radius=500&rarity=legendary
```

**新增参数:**
- `rarity` (可选): 过滤指定稀有度的精灵
  - 可选值: `common`, `uncommon`, `rare`, `epic`, `legendary`

**兼容性:** ✅ 完全向后兼容，v1 客户端可忽略新参数

---

### 2. GET /api/v2/users/:id/profile

**v1 响应:**
```json
{
  "id": "123",
  "username": "trainer_ash",
  "email": "ash@example.com",
  "level": 25,
  "createdAt": "2026-01-15T08:00:00Z"
}
```

**v2 响应（扩展）:**
```json
{
  "id": "123",
  "username": "trainer_ash",
  "email": "ash@example.com",
  "level": 25,
  "createdAt": "2026-01-15T08:00:00Z",
  "stats": {
    "pokemonCaught": 150,
    "gymsVisited": 23,
    "raidsCompleted": 8,
    "distanceWalked": 125.5
  },
  "achievements": [
    { "id": "first_catch", "name": "初次捕捉", "unlockedAt": "2026-01-15T08:30:00Z" },
    { "id": "gym_leader", "name": "道馆领袖", "unlockedAt": "2026-03-20T14:00:00Z" }
  ],
  "lastActiveAt": "2026-06-09T06:45:00Z"
}
```

**新增字段:**
- `stats`: 用户统计数据对象
  - `pokemonCaught`: 捕捉的精灵总数
  - `gymsVisited`: 访问过的道馆数
  - `raidsCompleted`: 完成的 Raid 数
  - `distanceWalked`: 行走距离（公里）
- `achievements`: 成就列表
- `lastActiveAt`: 最后活跃时间

**兼容性:** ✅ 向后兼容，新字段为可选，不影响现有代码

**迁移建议:**
```javascript
// v1 代码无需修改
const profile = await fetch('/api/v1/users/123/profile');

// v2 代码可以使用新字段
const profile = await fetch('/api/v2/users/123/profile');
console.log(`已捕捉 ${profile.stats.pokemonCaught} 只精灵`);
```

---

### 3. GET /api/v2/pokemon

**v1 响应:**
```json
[
  {
    "id": "pk-001",
    "speciesId": "pikachu",
    "name": "皮卡丘",
    "level": 15,
    "cp": 450
  }
]
```

**v2 响应（扩展）:**
```json
[
  {
    "id": "pk-001",
    "speciesId": "pikachu",
    "name": "皮卡丘",
    "level": 15,
    "cp": 450,
    "moves": [
      { "id": "thunder-shock", "name": "电击", "type": "electric" },
      { "id": "quick-attack", "name": "电光一闪", "type": "normal" }
    ],
    "iv": {
      "attack": 15,
      "defense": 12,
      "stamina": 14,
      "total": 41
    },
    "potentialMoves": [
      { "id": "thunder", "name": "打雷", "type": "electric", "requiredLevel": 25 }
    ]
  }
]
```

**新增字段:**
- `moves`: 已学技能列表
- `iv`: 个体值
- `potentialMoves`: 可学技能列表

**兼容性:** ✅ 向后兼容

---

### 4. 新增端点

#### POST /api/v2/pokemon/:id/learn-move

让精灵学习新技能。

**请求:**
```json
{
  "moveId": "thunder",
  "tmId": "tm-025"  // 可选，使用技能机器
}
```

**响应:**
```json
{
  "success": true,
  "pokemon": {
    "id": "pk-001",
    "moves": [
      { "id": "thunder-shock", "name": "电击" },
      { "id": "thunder", "name": "打雷" }
    ]
  }
}
```

#### DELETE /api/v2/pokemon/:id/moves/:moveId

遗忘技能。

**响应:**
```json
{
  "success": true,
  "message": "已遗忘技能: 打雷"
}
```

---

## 版本协商

### URL 路径版本控制（推荐）

```
GET /api/v1/users/123/profile
GET /api/v2/users/123/profile
```

### Header 版本协商

```http
GET /api/users/123/profile
Accept-Version: 2
```

### 响应头

所有 v2 API 响应包含以下头：

```http
X-API-Version: 2
X-API-Supported-Versions: 1, 2
```

废弃版本会额外返回：

```http
X-API-Deprecated: true
X-API-Sunset: 2027-06-09T00:00:00Z
X-API-Replacement: /api/v2/
X-API-Migration-Guide: https://docs.minego.com/api/migration/v1-to-v2
```

---

## 废弃时间线

| 日期 | 事件 |
|------|------|
| 2026-06-09 | v2 发布，v1 进入维护模式 |
| 2026-12-09 | v1 废弃，不再接受新功能 |
| 2027-06-09 | v1 下线，返回 `410 Gone` |

### v1 下线后行为

```json
// v1 端点响应
HTTP/1.1 410 Gone

{
  "code": 1012,
  "message": "API v1 已下线",
  "data": {
    "deprecatedAt": "2026-12-09T00:00:00Z",
    "sunsetAt": "2027-06-09T00:00:00Z",
    "currentVersion": 2,
    "migrationGuide": "https://docs.minego.com/api/migration/v1-to-v2"
  }
}
```

---

## 迁移检查清单

### 迁移前

- [ ] 审查当前使用的所有 API 端点
- [ ] 识别依赖 v1 特有的响应格式
- [ ] 准备测试环境验证 v2 兼容性

### 迁移步骤

1. **更新 API 基础路径**
   ```javascript
   // 修改前
   const API_BASE = '/api/v1';
   
   // 修改后
   const API_BASE = '/api/v2';
   ```

2. **处理新增字段**
   - 确保 JSON 解析器能处理新字段
   - 更新 UI 显示新字段（可选）

3. **利用新功能**
   - 使用 `rarity` 参数过滤精灵
   - 显示用户统计数据
   - 实现技能学习功能

4. **测试验证**
   - 运行完整回归测试
   - 验证所有功能正常工作
   - 检查性能指标

### 迁移后

- [ ] 移除 v1 相关代码
- [ ] 更新文档引用
- [ ] 监控 v2 API 使用情况

---

## 常见问题

### Q: v1 和 v2 可以同时使用吗？

A: 可以，但建议统一使用一个版本。如果必须混用，确保正确处理不同版本的响应格式。

### Q: v1 什么时候完全下线？

A: v1 将在 2027-06-09 完全下线，在此期间仍可使用，但不再添加新功能。

### Q: 如何知道我使用的版本是否被废弃？

A: 检查响应头 `X-API-Deprecated`。如果为 `true`，请尽快迁移到新版本。

### Q: 迁移需要多长时间？

A: 大多数客户端可以在 1-2 小时内完成迁移。建议预留充分测试时间。

---

## 联系支持

如有迁移问题，请联系：

- GitHub Issues: https://github.com/kkcc2013-arch/mineGo/issues
- 技术文档: https://docs.minego.com/api
