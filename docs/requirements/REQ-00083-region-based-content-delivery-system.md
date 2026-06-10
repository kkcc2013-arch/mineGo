# REQ-00083：区域化内容分发与地区专属活动管理系统

- **编号**：REQ-00083
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：location-service、reward-service、pokemon-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-10 08:15
- **依赖需求**：REQ-00011、REQ-00029、REQ-00051

## 1. 背景与问题

当前 mineGo 已实现多语言（REQ-00011）、多时区（REQ-00029）、多货币（REQ-00051）支持，但内容分发仍然是全球统一的。实际运营中存在以下痛点：

1. **精灵分布无区域差异**：所有地区玩家看到相同的精灵刷新池，无法针对不同地区进行本地化运营（如亚洲限定精灵、欧洲限定精灵）
2. **活动无法地区差异化**：全球活动无法按地区定制（如中国的春节活动、美国的感恩节活动、日本的樱花季活动）
3. **合规要求差异**：不同国家对游戏内容有不同要求（如欧洲 GDPR、中国版号要求、中东宗教禁忌），缺乏区域化内容控制
4. **运营效率低**：运营团队无法快速针对特定地区推出专属内容，需要修改代码

## 2. 目标

建立完整的区域化内容分发系统：

- 支持 **区域精灵池管理**：不同地区有不同的精灵刷新权重
- 支持 **地区专属活动**：按地理区域配置不同的活动和奖励
- 支持 **合规内容过滤**：根据用户所在地区自动过滤敏感内容
- 提供 **运营配置后台**：无需修改代码即可配置区域内容
- 预期提升用户留存率 15%+（通过本地化运营）

## 3. 范围

### 包含
- 区域定义与管理（按国家/省份/城市级别）
- 精灵刷新区域权重配置
- 地区专属活动配置系统
- 合规内容过滤规则引擎
- 运营后台 API（增删改查区域配置）
- 客户端区域感知能力
- 区域数据统计与报表

### 不包含
- 具体的活动内容设计（由运营团队负责）
- 实时地理位置验证（已有 REQ-00010）
- 翻译管理（已有 REQ-00011）

## 4. 详细需求

### 4.1 区域定义系统

```sql
-- 区域定义表
CREATE TABLE regions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,        -- 区域代码 如 CN, CN-BJ, US-CA
  parent_code VARCHAR(20),                  -- 父区域代码
  name VARCHAR(100) NOT NULL,               -- 区域名称
  level VARCHAR(20) NOT NULL,               -- country/province/city
  geo_bounds JSONB,                         -- 地理边界 GeoJSON
  timezone VARCHAR(50),                     -- 默认时区
  currency VARCHAR(10),                     -- 默认货币
  language VARCHAR(10),                     -- 默认语言
  compliance_rules JSONB,                   -- 合规规则
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 区域精灵权重配置表
CREATE TABLE region_pokemon_weights (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL,
  pokemon_id INTEGER NOT NULL,
  spawn_weight DECIMAL(5,4) DEFAULT 1.0,    -- 刷新权重 (0.0-10.0)
  is_exclusive BOOLEAN DEFAULT false,       -- 是否区域专属
  start_date TIMESTAMP,                     -- 生效开始时间
  end_date TIMESTAMP,                       -- 生效结束时间
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(region_code, pokemon_id)
);

-- 区域活动配置表
CREATE TABLE region_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(50) NOT NULL,
  region_codes TEXT[] NOT NULL,             -- 适用区域列表
  title JSONB NOT NULL,                     -- 多语言标题
  description JSONB NOT NULL,               -- 多语言描述
  event_type VARCHAR(50) NOT NULL,          -- spawn_bonus/catch_bonus/stardust_bonus
  bonuses JSONB NOT NULL,                   -- 奖励配置
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 合规过滤规则表
CREATE TABLE compliance_rules (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL,
  content_type VARCHAR(50) NOT NULL,        -- pokemon/item/event
  content_id INTEGER,                       -- 内容ID (null表示全部)
  filter_action VARCHAR(20) NOT NULL,       -- hide/modify/restrict
  reason VARCHAR(200),                      -- 过滤原因
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.2 区域感知 API

```javascript
// GET /api/v2/region/config
// 根据用户当前位置返回区域配置
{
  "region": {
    "code": "CN-BJ",
    "name": "北京市",
    "country": "CN",
    "timezone": "Asia/Shanghai",
    "currency": "CNY",
    "language": "zh-CN"
  },
  "spawnModifiers": {
    "pokemonBonus": [25, 26, 27],    // 当前区域加成的精灵
    "exclusivePokemon": [311, 312]   // 区域专属精灵
  },
  "activeEvents": [
    {
      "eventId": "spring-festival-2026",
      "title": "春节特别活动",
      "bonuses": { "catchRate": 1.5, "stardustMultiplier": 2.0 }
    }
  ],
  "restrictedContent": [439, 440]    // 被过滤的内容ID
}
```

### 4.3 精灵刷新区域适配

```javascript
// location-service 精灵刷新逻辑
class RegionAwareSpawnEngine {
  async generateSpawnPool(lat, lng, radius) {
    // 1. 获取用户所在区域
    const region = await this.detectRegion(lat, lng);
    
    // 2. 获取区域精灵权重
    const weights = await this.getPokemonWeights(region.code);
    
    // 3. 应用合规过滤
    const allowed = await this.filterByCompliance(region.code, basePool);
    
    // 4. 根据权重生成刷新池
    return this.applyWeights(allowed, weights);
  }
}
```

### 4.4 运营后台 API

| 端点 | 方法 | 功能 |
|------|------|------|
| `/admin/regions` | GET | 获取所有区域列表 |
| `/admin/regions` | POST | 创建新区域 |
| `/admin/regions/:code/pokemon-weights` | GET/POST | 管理区域精灵权重 |
| `/admin/regions/:code/events` | GET/POST | 管理区域活动 |
| `/admin/regions/:code/compliance` | GET/POST | 管理合规规则 |
| `/admin/regions/stats` | GET | 区域数据统计 |

### 4.5 Prometheus 指标

```javascript
// 区域相关指标
region_config_requests_total{region_code, country}
region_event_participants{event_id, region_code}
region_pokemon_spawn_count{pokemon_id, region_code}
region_compliance_filters_applied{region_code, filter_action}
```

## 5. 验收标准（可测试）

- [ ] 管理员可通过 API 创建区域并配置精灵刷新权重
- [ ] 不同区域玩家看到的精灵刷新池权重不同，差异率符合配置
- [ ] 运营配置的区域专属活动仅在指定区域内显示
- [ ] 合规规则自动过滤敏感内容，过滤日志可追溯
- [ ] 客户端通过 `/api/v2/region/config` 获取区域配置，响应时间 < 100ms
- [ ] 区域配置变更在 5 分钟内生效（缓存刷新）
- [ ] 单元测试覆盖所有核心模块，覆盖率 > 80%
- [ ] 集成测试验证端到端区域感知流程

## 6. 工作量估算

**L**（大型）

理由：
- 需要新增 4 个数据库表
- 修改 location-service 核心刷新逻辑
- 新增运营后台 API（6 个端点）
- 客户端区域感知能力
- 涉及多个服务协调

预计开发时间：3-4 天

## 7. 优先级理由

**P1** - 区域化运营是全球化游戏的核心能力，直接影响：
- 用户留存（本地化活动提升参与度）
- 合规风险（避免内容违规）
- 运营效率（无需代码修改即可配置）

虽不是 P0 级紧急需求，但对项目全球化扩展至关重要。
