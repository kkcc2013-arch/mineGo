# 捕捉精灵 - API 调用示例

## 基本信息

- **服务**: catch-service
- **端点**: `POST /api/v1/catch`
- **功能**: 发起精灵捕捉尝试
- **认证**: 需要 JWT Token
- **权限**: 已登录用户

## 请求示例

### cURL

```bash
curl -X POST "${API_BASE}/api/v1/catch" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "spawnId": "spawn-xxx",
    "itemId": "item-pokeball-normal",
    "location": {
      "lat": 31.2304,
      "lng": 121.4737
    },
    "throwType": "normal",
    "curveBall": false
  }'
```

### JavaScript (fetch)

```javascript
const response = await fetch(`${API_BASE}/api/v1/catch`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    spawnId: 'spawn-xxx',
    itemId: 'item-pokeball-normal',
    location: { lat: 31.2304, lng: 121.4737 },
    throwType: 'normal',
    curveBall: false
  })
});

const data = await response.json();
```

### JavaScript (ApiClient)

```javascript
const ApiClient = require('@pmg/shared/ApiClient');

const result = await ApiClient.post('/api/v1/catch', {
  spawnId: 'spawn-xxx',
  itemId: 'item-pokeball-normal',
  location: { lat: 31.2304, lng: 121.4737 },
  throwType: 'normal',
  curveBall: false
});
```

## 请求参数

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `spawnId` | string | ✓ | 精灵刷新点 ID |
| `itemId` | string | ✓ | 使用道具 ID（精灵球类型） |
| `location` | object | ✓ | 当前 GPS 位置 |
| `location.lat` | number | ✓ | 纬度 |
| `location.lng` | number | ✓ | 经度 |
| `throwType` | string | ○ | 投掷类型：normal/nice/great/excellent |
| `curveBall` | boolean | ○ | 是否为曲线球（增加捕捉概率） |

**道具 ID**：

| 道具 | ID |
|------|------|
| 普通精灵球 | `item-pokeball-normal` |
| 高级精灵球 | `item-pokeball-great` |
| 超级精灵球 | `item-pokeball-ultra` |
| 掌门精灵球 | `item-pokeball-master` |

## 成功响应

```json
{
  "success": true,
  "data": {
    "caught": true,
    "pokemon": {
      "id": "pokemon-instance-xxx",
      "speciesId": 25,
      "speciesName": "Pikachu",
      "cp": 1500,
      "iv": {
        "attack": 15,
        "defense": 14,
        "stamina": 13
      },
      "moves": {
        "fast": "Thunder Shock",
        "charge": "Thunderbolt"
      },
      "caughtAt": "2026-07-06T17:00:00Z",
      "caughtLocation": {
        "lat": 31.2304,
        "lng": 121.4737
      }
    },
    "rewards": {
      "experience": 100,
      "stardust": 100,
      "candy": {
        "speciesId": 25,
        "amount": 3
      }
    },
    "itemUsed": {
      "id": "item-pokeball-normal",
      "remaining": 49
    }
  },
  "meta": {
    "requestId": "req-xxx",
    "timestamp": "2026-07-06T17:00:00Z"
  }
}
```

## 捕捉失败响应

```json
{
  "success": true,
  "data": {
    "caught": false,
    "reason": "escaped",
    "escapeCount": 2,
    "maxEscapes": 3,
    "remainingAttempts": 1,
    "pokemon": {
      "speciesId": 25,
      "speciesName": "Pikachu",
      "cp": 1500
    },
    "itemUsed": {
      "id": "item-pokeball-normal",
      "remaining": 49
    }
  }
}
```

## 错误响应示例

### 精灵已消失

```json
{
  "success": false,
  "error": {
    "code": "SPAWN_NOT_FOUND",
    "message": "该精灵已消失或被其他玩家捕捉",
    "i18nKey": "error.spawn_not_found",
    "docUrl": "https://docs.minego.example.com/errors/SPAWN_NOT_FOUND"
  }
}
```

### 道具不足

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_ITEMS",
    "message": "精灵球数量不足",
    "details": {
      "itemId": "item-pokeball-normal",
      "required": 1,
      "available": 0
    },
    "i18nKey": "error.insufficient_items"
  }
}
```

### 位置验证失败

```json
{
  "success": false,
  "error": {
    "code": "LOCATION_INVALID",
    "message": "位置验证失败：距离精灵刷新点过远",
    "details": {
      "playerLocation": { "lat": 31.2304, "lng": 121.4737 },
      "spawnLocation": { "lat": 31.2504, "lng": 121.4937 },
      "distance": 2500,
      "maxAllowed": 100
    },
    "i18nKey": "error.location_invalid"
  }
}
```

### 反作弊触发

```json
{
  "success": false,
  "error": {
    "code": "ANTI_CHEAT_TRIGGERED",
    "message": "可疑行为检测，请稍后再试",
    "details": {
      "reason": "teleport_detected",
      "cooldown": 60000
    },
    "i18nKey": "error.anti_cheat_triggered"
  }
}
```

## 前端最佳实践

### 捕捉流程封装

```javascript
class CatchManager {
  constructor(apiClient, gameState) {
    this.apiClient = apiClient;
    this.gameState = gameState;
  }

  async attemptCatch(spawnId, throwQuality) {
    try {
      const location = await this.getCurrentLocation();
      const itemId = this.selectBestBall(spawnId);
      
      const result = await this.apiClient.post('/api/v1/catch', {
        spawnId,
        itemId,
        location,
        throwType: throwQuality.type,
        curveBall: throwQuality.curve
      });

      if (result.success) {
        if (result.data.caught) {
          // 播放成功动画
          this.playCatchAnimation(result.data.pokemon);
          // 更新游戏状态
          this.gameState.addPokemon(result.data.pokemon);
          this.gameState.addRewards(result.data.rewards);
          this.gameState.updateItem(result.data.itemUsed);
          // 发送通知
          this.notifyFriends(result.data.pokemon);
        } else {
          // 播放逃跑动画
          this.playEscapeAnimation(result.data);
          // 提示剩余次数
          if (result.data.remainingAttempts > 0) {
            this.promptRetry(spawnId, throwQuality);
          }
        }
      }

      return result;
    } catch (error) {
      return this.handleCatchError(error);
    }
  }

  selectBestBall(spawnId) {
    const spawn = this.gameState.getSpawn(spawnId);
    const catchRate = this.calculateCatchRate(spawn);
    
    if (catchRate < 0.1) {
      return 'item-pokeball-ultra';
    } else if (catchRate < 0.3) {
      return 'item-pokeball-great';
    }
    return 'item-pokeball-normal';
  }

  handleCatchError(error) {
    const handlers = {
      'SPAWN_NOT_FOUND': () => {
        this.gameState.removeSpawn(error.details.spawnId);
        this.showError(i18n.t('error.spawn_not_found'));
      },
      'INSUFFICIENT_ITEMS': () => {
        this.showShopPrompt();
        this.showError(i18n.t('error.insufficient_items'));
      },
      'LOCATION_INVALID': () => {
        this.refreshLocation();
        this.showError(i18n.t('error.location_invalid'));
      },
      'ANTI_CHEAT_TRIGGERED': () => {
        this.showCooldown(error.details.cooldown);
      }
    };

    const handler = handlers[error.code];
    if (handler) handler();
    else this.showError(error.message);

    return { success: false, error };
  }
}
```

### 投掷质量计算

```javascript
const calculateThrowQuality = (throwData) => {
  let bonus = 0;
  
  // 投掷类型加成
  const typeBonus = {
    'normal': 0,
    'nice': 10,
    'great': 50,
    'excellent': 100
  };
  bonus += typeBonus[throwData.type] || 0;
  
  // 曲线球加成
  if (throwData.curve) {
    bonus += 70;
  }
  
  // 精确度加成（命中精灵圆圈中心）
  const accuracyBonus = throwData.accuracy * 20;
  bonus += accuracyBonus;
  
  return {
    multiplier: 1 + (bonus / 100),
    type: throwData.type,
    curve: throwData.curve
  };
};
```

## 测试示例

### 单元测试

```javascript
describe('Catch API', () => {
  let mockApiClient;
  let catchManager;

  beforeEach(() => {
    mockApiClient = {
      post: jest.fn()
    };
    catchManager = new CatchManager(mockApiClient, mockGameState);
  });

  it('should successfully catch pokemon with valid parameters', async () => {
    const mockResponse = {
      success: true,
      data: {
        caught: true,
        pokemon: { id: 'pokemon-xxx', speciesId: 25 },
        rewards: { experience: 100 }
      }
    };
    mockApiClient.post.mockResolvedValue(mockResponse);

    const result = await catchManager.attemptCatch('spawn-xxx', {
      type: 'normal',
      curve: false
    });

    expect(result.success).toBe(true);
    expect(result.data.caught).toBe(true);
    expect(mockApiClient.post).toHaveBeenCalledWith('/api/v1/catch', {
      spawnId: 'spawn-xxx',
      itemId: 'item-pokeball-normal',
      location: { lat: 31.2304, lng: 121.4737 },
      throwType: 'normal',
      curveBall: false
    });
  });

  it('should handle insufficient items error', async () => {
    const mockError = {
      code: 'INSUFFICIENT_ITEMS',
      message: '精灵球数量不足'
    };
    mockApiClient.post.mockRejectedValue(mockError);

    const result = await catchManager.attemptCatch('spawn-xxx', {});

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INSUFFICIENT_ITEMS');
  });

  it('should select best ball based on catch rate', () => {
    // 稀有精灵应该用高级球
    const rareSpawn = { speciesId: 150, rarity: 'legendary' };
    expect(catchManager.selectBestBall(rareSpawn)).toBe('item-pokeball-ultra');
    
    // 普通精灵用普通球
    const commonSpawn = { speciesId: 25, rarity: 'common' };
    expect(catchManager.selectBestBall(commonSpawn)).toBe('item-pokeball-normal');
  });
});
```

### 集成测试

```javascript
describe('Catch Integration', () => {
  it('should complete full catch flow', async () => {
    // 1. 登录
    const loginResult = await ApiClient.login({
      email: 'test@example.com',
      password: 'testPassword'
    });
    expect(loginResult.success).toBe(true);

    // 2. 查询附近精灵
    const nearbyResult = await ApiClient.get('/api/v1/nearby', {
      location: { lat: 31.2304, lng: 121.4737 }
    });
    expect(nearbyResult.success).toBe(true);
    expect(nearbyResult.data.spawns.length).toBeGreaterThan(0);

    // 3. 发起捕捉
    const spawnId = nearbyResult.data.spawns[0].id;
    const catchResult = await ApiClient.post('/api/v1/catch', {
      spawnId,
      itemId: 'item-pokeball-normal',
      location: { lat: 31.2304, lng: 121.4737 }
    });
    expect(catchResult.success).toBe(true);

    // 4. 验证精灵已添加
    const pokemonResult = await ApiClient.get('/api/v1/pokemon');
    if (catchResult.data.caught) {
      expect(pokemonResult.data).toContainEqual(
        expect.objectContaining({ speciesId: nearbyResult.data.spawns[0].speciesId })
      );
    }
  });
});
```

## 相关文档

- [附近精灵查询](../location-service/nearby-spawn.md)
- [精灵详情查询](../pokemon-service/pokemon-detail.md)
- [道具使用示例](item-usage.md)
- [错误处理指南](../frontend-integration/error-handling-pattern.md)