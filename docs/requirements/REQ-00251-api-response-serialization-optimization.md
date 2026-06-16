# REQ-00251：API 响应序列化优化与 JSON 压缩系统

- **编号**：REQ-00251
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/JsonOptimizer.js、game-client
- **创建时间**：2026-06-16 08:00
- **依赖需求**：REQ-00072 (API 响应 Gzip/Brotli 压缩优化)

## 1. 背景与问题

当前 mineGo 项目的 API 响应数据量较大，特别是在以下场景：
- 精灵列表查询返回大量嵌套对象（属性、技能、进化链等）
- 地图区域查询返回数百个精灵位置数据
- 排行榜数据包含大量玩家信息

虽然已实现 Gzip/Brotli 压缩（REQ-00072），但 JSON 序列化本身存在优化空间：
1. 冗余字段重复传输（如精灵基础信息在多个接口重复返回）
2. 嵌套层级过深导致序列化耗时
3. 字段命名过长占用带宽（如 `pokemon_evolution_chain_current_stage`）
4. 缺乏字段选择机制，客户端无法按需获取

## 2. 目标

- 减少 JSON 响应体积 30-50%
- 降低序列化耗时 20%+
- 提供客户端字段选择能力（GraphQL-like field selection）
- 实现响应字段别名压缩

## 3. 范围

- **包含**：
  - JSON 字段别名压缩系统（长字段名映射为短别名）
  - 字段选择查询参数支持（`?fields=id,name,type`）
  - 响应扁平化工具（减少嵌套层级）
  - 精灵数据响应优化器
  - 缓存键优化（压缩后的键名）

- **不包含**：
  - GraphQL 完整实现
  - 二进制协议切换（如 protobuf）
  - 前端重构

## 4. 详细需求

### 4.1 字段别名压缩系统

```javascript
// backend/shared/JsonOptimizer.js
const FIELD_ALIASES = {
  // 精灵字段
  'pokemon_id': 'pid',
  'pokemon_name': 'pn',
  'pokemon_type': 'pt',
  'evolution_chain': 'ec',
  'current_stage': 'cs',
  'base_stats': 'bs',
  'iv_values': 'iv',
  'catch_rate': 'cr',
  // 位置字段
  'latitude': 'lat',
  'longitude': 'lng',
  'spawn_point': 'sp',
  // 通用字段
  'created_at': 'ca',
  'updated_at': 'ua',
  'user_id': 'uid'
};

// 压缩响应
function compressResponse(data, aliasMap = FIELD_ALIASES) {
  // 递归替换字段名
}

// 解压缩（客户端使用）
function decompressResponse(data, aliasMap = FIELD_ALIASES) {
  // 递归还原字段名
}
```

### 4.2 字段选择中间件

```javascript
// gateway/middleware/fieldSelector.js
function fieldSelectorMiddleware(req, res, next) {
  const fields = req.query.fields?.split(',').map(f => f.trim());
  if (!fields) return next();
  
  res.json = function(data) {
    const filtered = filterFields(data, fields);
    return originalJson.call(this, filtered);
  };
  next();
}
```

### 4.3 响应扁平化

```javascript
// 将嵌套对象扁平化
// 输入: { pokemon: { info: { name: 'Pikachu' } } }
// 输出: { 'pokemon.info.name': 'Pikachu' } 或自定义扁平规则
```

### 4.4 集成点

- gateway 响应拦截器
- 各微服务路由层
- game-client 响应解析器

## 5. 验收标准（可测试）

- [ ] 精灵列表 API 响应体积减少 >= 30%
- [ ] 字段选择参数 `?fields=id,name` 正确过滤响应
- [ ] 别名压缩后字段名长度 <= 3 字符
- [ ] 客户端解压缩正确还原原始数据结构
- [ ] 序列化性能测试显示耗时降低 >= 20%
- [ ] 现有 API 向后兼容（无 fields 参数时返回完整响应）
- [ ] 单元测试覆盖率 >= 80%

## 6. 工作量估算

**M（中等）**
- 核心压缩逻辑：2-3 小时
- 中间件集成：2 小时
- 客户端适配：2 小时
- 测试与验证：2 小时
- 总计：约 1 个工作日

## 7. 优先级理由

P1 优先级原因：
1. 直接影响 API 性能和用户体验（响应速度）
2. 减少带宽消耗，降低云成本
3. 为移动端用户提供更好的体验（弱网环境）
4. 依赖 REQ-00072 已完成，具备实施条件
5. 对"项目可用"贡献：性能优化是生产可用的关键指标
