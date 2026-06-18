# REQ-00271：精灵昵称与自定义名牌系统

- **编号**：REQ-00271
- **类别**：功能增强
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：pokemon-service、user-service、gateway、game-client、database/migrations
- **创建时间**：2026-06-18 23:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目的精灵系统虽然支持捕捉、进化、战斗等核心玩法，但玩家与精灵之间的个性化互动体验较为有限。具体问题：

- **精灵命名缺失**：玩家无法为自己的精灵设置昵称，所有精灵显示为默认名称，缺乏个性化
- **名牌系统空缺**：没有自定义名牌系统，玩家无法展示自己对精灵的独特情感或标记
- **情感连接不足**：缺乏让玩家与精灵建立情感连接的功能，影响长期留存

类似《Pokemon GO》的昵称系统和《原神》的角色命名，精灵昵称系统能显著增强玩家与精灵的情感纽带。

## 2. 目标

实现精灵昵称与自定义名牌系统，让玩家可以：
- 为每只精灵设置独特的昵称（替代默认名称）
- 创建自定义名牌，记录精灵的获得日期、特殊经历等
- 在战斗、交换、展示时显示昵称和名牌信息
- 通过昵称系统增强玩家与精灵的情感连接

## 3. 范围

### 包含
- 精灵昵称设置与管理（设置、修改、重置）
- 昵称规则校验（长度、敏感词、特殊字符）
- 自定义名牌系统（获得日期、特殊经历、训练师寄语）
- 昵称在战斗/交换/展示时的显示
- 昵称历史记录
- 管理后台昵称审核（敏感词过滤）

### 不包含
- 昵称交易市场（后续扩展）
- 昵称特效系统（后续扩展）
- 批量昵称设置（本次仅支持单只设置）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 精灵昵称表
CREATE TABLE pokemon_nicknames (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname VARCHAR(32) NOT NULL,
  previous_nickname VARCHAR(32),
  name_tag JSONB DEFAULT '{}', -- { catchDate: '2024-01-01', specialEvent: 'First Catch', message: 'My best buddy!' }
  is_approved BOOLEAN DEFAULT true, -- 审核状态（敏感词过滤）
  set_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(pokemon_instance_id)
);

-- 昵称历史记录表
CREATE TABLE nickname_history (
  id SERIAL PRIMARY KEY,
  pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_nickname VARCHAR(32),
  new_nickname VARCHAR(32),
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  reason VARCHAR(50) -- 'user_change', 'reset', 'moderation'
);

-- 创建索引
CREATE INDEX idx_pokemon_nicknames_pokemon ON pokemon_nicknames(pokemon_instance_id);
CREATE INDEX idx_pokemon_nicknames_user ON pokemon_nicknames(user_id);
CREATE INDEX idx_nickname_history_pokemon ON nickname_history(pokemon_instance_id);
```

### 4.2 API 设计

#### POST /api/pokemon/:id/nickname
设置或更新精灵昵称

**请求**：
```json
{
  "nickname": "小黄",
  "nameTag": {
    "message": "我的第一只精灵"
  }
}
```

**响应**：
```json
{
  "success": true,
  "nickname": "小黄",
  "nameTag": {
    "message": "我的第一只精灵"
  },
  "setAt": "2026-06-18T23:00:00Z"
}
```

#### DELETE /api/pokemon/:id/nickname
重置精灵昵称为默认名称

#### GET /api/pokemon/:id/nickname
获取精灵昵称和名牌信息

#### GET /api/pokemon/:id/nickname/history
获取昵称修改历史

### 4.3 昵称规则

```javascript
const NICKNAME_RULES = {
  minLength: 1,
  maxLength: 16,
  // 允许中英文、数字、部分特殊符号
  allowedPattern: /^[\u4e00-\u9fa5a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\s\-_！？·]+$/,
  forbiddenPatterns: [
    /敏感词1/i,
    /敏感词2/i,
    // 从敏感词库加载
  ],
  // 同一用户昵称重复限制
  maxDuplicates: 5
};

function validateNickname(nickname, userId) {
  // 1. 长度检查
  if (nickname.length < 1 || nickname.length > 16) {
    return { valid: false, error: '昵称长度必须在 1-16 个字符之间' };
  }
  
  // 2. 字符检查
  if (!NICKNAME_RULES.allowedPattern.test(nickname)) {
    return { valid: false, error: '昵称包含不允许的字符' };
  }
  
  // 3. 敏感词检查
  if (containsForbiddenWord(nickname)) {
    return { valid: false, error: '昵称包含敏感词，请修改' };
  }
  
  // 4. 重复检查
  // 允许同一用户有相同昵称的精灵，但有上限
  
  return { valid: true };
}
```

### 4.4 前端功能

- 精灵详情页：昵称编辑入口、名牌编辑弹窗
- 战斗界面：显示精灵昵称（如设置了的话）
- 交换界面：展示对方精灵昵称
- 展示系统：昵称和名牌信息完整展示

## 5. 验收标准

- [ ] POST /api/pokemon/:id/nickname 能成功设置昵称
- [ ] 昵称长度限制在 1-16 个字符
- [ ] 敏感词过滤生效，违规昵称被拒绝
- [ ] DELETE /api/pokemon/:id/nickname 能重置昵称
- [ ] 昵称历史记录正确保存
- [ ] 战斗界面正确显示精灵昵称
- [ ] 交换界面展示对方精灵昵称
- [ ] 前端昵称编辑功能正常
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**S**（1-2 天）

理由：
- 数据库设计简单（2 个表）
- API 逻辑简单（4 个端点）
- 规则校验逻辑清晰
- 前端改动较小（主要是显示逻辑）

## 7. 优先级理由

P2 理由：
- 属于增强型功能，不影响核心玩法
- 能提升玩家体验和情感连接
- 实现成本较低，收益明显
- 为后续成就系统、展示系统打基础
