# REQ-00419: 精灵栖息地系统与生态环境影响机制

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00419 |
| 标题 | 精灵栖息地系统与生态环境影响机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-core、catch-service、location-service、map-service、shared/ecosystem、admin-dashboard |
| 创建时间 | 2026-07-01 21:00 |

## 需求描述

### 背景

当前游戏中的精灵生成较为随机，缺乏地理生态逻辑。玩家在任何地点都可能遇到任何精灵，这不仅降低了探索的沉浸感，也削弱了游戏世界的一致性。

### 目标

建立完整的精灵栖息地系统，让不同类型的精灵在特定生态环境中生成，并引入环境因素（时间、天气、季节）对精灵出现率和属性的影响机制。

### 核心功能

1. **栖息地类型定义**
   - 森林、草原、沙漠、湿地、山地、海洋、城市、极地等
   - 每种栖息地关联特定的精灵类型和出现概率

2. **环境因素影响**
   - 时间段影响：日行/夜行精灵
   - 天气影响：雨天增加水系精灵出现率
   - 季节影响：特定精灵在特定季节更活跃

3. **栖息地动态变化**
   - 季节性栖息地迁移
   - 特殊事件触发临时栖息地

4. **生态链关联**
   - 捕食者-猎物关系影响生成
   - 区域精灵密度动态平衡

## 技术方案

### 1. 栖息地类型枚举与服务

```typescript
// shared/ecosystem/types/habitat.ts

export enum HabitatType {
  FOREST = 'forest',        // 森林
  GRASSLAND = 'grassland',  // 草原
  DESERT = 'desert',        // 沙漠
  WETLAND = 'wetland',      // 湿地
  MOUNTAIN = 'mountain',    // 山地
  OCEAN = 'ocean',          // 海洋
  COASTAL = 'coastal',      // 沿海
  URBAN = 'urban',          // 城市
  POLAR = 'polar',          // 极地
  CAVE = 'cave',            // 洞穴
  VOLCANIC = 'volcanic',    // 火山
  SKY = 'sky',              // 天空
}

export enum TimeOfDay {
  DAWN = 'dawn',        // 黎明 05:00-07:00
  MORNING = 'morning',  // 上午 07:00-12:00
  NOON = 'noon',        // 正午 12:00-14:00
  AFTERNOON = 'afternoon', // 下午 14:00-18:00
  DUSK = 'dusk',        // 黄昏 18:00-20:00
  NIGHT = 'night',      // 夜晚 20:00-05:00
}

export enum Season {
  SPRING = 'spring',
  SUMMER = 'summer',
  AUTUMN = 'autumn',
  WINTER = 'winter',
}

export enum Weather {
  CLEAR = 'clear',
  CLOUDY = 'cloudy',
  RAIN = 'rain',
  STORM = 'storm',
  SNOW = 'snow',
  FOG = 'fog',
  SANDSTORM = 'sandstorm',
}

export interface HabitatConfig {
  type: HabitatType;
  baseSpawnMultiplier: number;
  spiritTypeAffinities: Map<SpiritType, number>;  // 类型亲和度
  environmentalModifiers: EnvironmentalModifiers;
  seasonalVariations: SeasonalVariation[];
}

export interface EnvironmentalModifiers {
  timeOfDay: Map<TimeOfDay, number>;
  weather: Map<Weather, number>;
  season: Map<Season, number>;
}
```

### 2. 栖息地管理服务

```typescript
// backend/location-service/src/habitat/habitat.service.ts

import { Injectable } from '@nestjs/common';
import { HabitatType, TimeOfDay, Weather, Season } from '@app/shared/ecosystem';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class HabitatService {
  private habitatConfigs: Map<HabitatType, HabitatConfig>;
  
  constructor(
    private configService: ConfigService,
    private cacheService: CacheService,
  ) {
    this.loadHabitatConfigs();
  }

  /**
   * 根据地理位置获取栖息地类型
   */
  async getHabitatAtLocation(
    latitude: number,
    longitude: number,
  ): Promise<HabitatType> {
    // 1. 尝试缓存命中
    const cacheKey = `habitat:${latitude.toFixed(3)}:${longitude.toFixed(3)}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached) return cached as HabitatType;

    // 2. 调用地理数据服务确定栖息地类型
    const habitatType = await this.determineHabitatType(latitude, longitude);
    
    // 3. 缓存结果（24小时）
    await this.cacheService.set(cacheKey, habitatType, 86400);
    
    return habitatType;
  }

  /**
   * 根据多因素计算精灵出现概率
   */
  calculateSpawnProbability(
    spiritId: string,
    habitatType: HabitatType,
    context: SpawnContext,
  ): number {
    const spirit = this.spiritRegistry.get(spiritId);
    const habitatConfig = this.habitatConfigs.get(habitatType);
    
    // 基础概率
    let probability = spirit.baseSpawnRate;
    
    // 栖息地类型加成
    const typeAffinity = habitatConfig.spiritTypeAffinities.get(spirit.type) ?? 1.0;
    probability *= typeAffinity;
    
    // 时间段加成
    const timeModifier = habitatConfig.environmentalModifiers.timeOfDay.get(context.timeOfDay) ?? 1.0;
    probability *= timeModifier;
    
    // 天气加成
    const weatherModifier = habitatConfig.environmentalModifiers.weather.get(context.weather) ?? 1.0;
    probability *= weatherModifier;
    
    // 季节加成
    const seasonModifier = habitatConfig.environmentalModifiers.season.get(context.season) ?? 1.0;
    probability *= seasonModifier;
    
    // 稀有度衰减
    probability *= this.getRarityDecay(spirit.rarity);
    
    return Math.min(probability, 1.0);
  }

  /**
   * 获取当前环境上下文
   */
  async getEnvironmentalContext(
    latitude: number,
    longitude: number,
  ): Promise<EnvironmentalContext> {
    const now = new Date();
    
    return {
      timeOfDay: this.getTimeOfDay(now, longitude),
      weather: await this.getWeatherAtLocation(latitude, longitude),
      season: this.getSeason(now, latitude),
      temperature: await this.getTemperature(latitude, longitude),
      humidity: await this.getHumidity(latitude, longitude),
    };
  }

  /**
   * 根据经度计算本地时间段
   */
  private getTimeOfDay(date: Date, longitude: number): TimeOfDay {
    // 每15度经度 = 1小时偏移
    const offsetHours = longitude / 15;
    const localHour = (date.getUTCHours() + offsetHours + 24) % 24;
    
    if (localHour >= 5 && localHour < 7) return TimeOfDay.DAWN;
    if (localHour >= 7 && localHour < 12) return TimeOfDay.MORNING;
    if (localHour >= 12 && localHour < 14) return TimeOfDay.NOON;
    if (localHour >= 14 && localHour < 18) return TimeOfDay.AFTERNOON;
    if (localHour >= 18 && localHour < 20) return TimeOfDay.DUSK;
    return TimeOfDay.NIGHT;
  }

  /**
   * 获取季节（考虑南北半球）
   */
  private getSeason(date: Date, latitude: number): Season {
    const month = date.getMonth();
    const isNorthernHemisphere = latitude >= 0;
    
    const northernSeasons: Season[] = [
      Season.WINTER, Season.WINTER,  // 0, 1
      Season.SPRING, Season.SPRING, Season.SPRING,  // 2, 3, 4
      Season.SUMMER, Season.SUMMER, Season.SUMMER,  // 5, 6, 7
      Season.AUTUMN, Season.AUTUMN, Season.AUTUMN,  // 8, 9, 10
      Season.WINTER,  // 11
    ];
    
    const season = northernSeasons[month];
    return isNorthernHemisphere ? season : this.getOppositeSeason(season);
  }

  private getOppositeSeason(season: Season): Season {
    const opposites: Record<Season, Season> = {
      [Season.SPRING]: Season.AUTUMN,
      [Season.SUMMER]: Season.WINTER,
      [Season.AUTUMN]: Season.SPRING,
      [Season.WINTER]: Season.SUMMER,
    };
    return opposites[season];
  }
}
```

### 3. 生态链关联服务

```typescript
// backend/shared/ecosystem/services/ecosystem-chain.service.ts

import { Injectable } from '@nestjs/common';

interface PredatorPreyRelation {
  predator: string;    // 捕食者精灵ID
  prey: string;        // 猎物精灵ID
  interactionRadius: number;  // 交互半径（米）
  spawnSuppression: number;   // 猎物生成抑制系数
}

@Injectable()
export class EcosystemChainService {
  private predatorPreyRelations: PredatorPreyRelation[] = [];

  /**
   * 检查区域生态平衡
   */
  async checkEcosystemBalance(
    location: Location,
    recentSpawns: SpiritSpawn[],
  ): Promise<EcosystemStatus> {
    const predators = recentSpawns.filter(s => this.isPredator(s.spiritId));
    const preys = recentSpawns.filter(s => this.isPrey(s.spiritId));
    
    // 计算捕食者/猎物比例
    const ratio = predators.length / (preys.length || 1);
    
    // 判断生态平衡状态
    if (ratio > 0.5) {
      return {
        status: 'predator_dominated',
        spawnAdjustment: {
          predatorMultiplier: 0.7,  // 减少捕食者生成
          preyMultiplier: 1.3,       // 增加猎物生成
        },
      };
    } else if (ratio < 0.1) {
      return {
        status: 'prey_dominated',
        spawnAdjustment: {
          predatorMultiplier: 1.2,
          preyMultiplier: 0.9,
        },
      };
    }
    
    return { status: 'balanced', spawnAdjustment: null };
  }

  /**
   * 获取精灵的出现条件
   */
  getSpawnConditions(spiritId: string): SpawnConditions {
    const relations = this.predatorPreyRelations.filter(r => 
      r.predator === spiritId || r.prey === spiritId
    );
    
    return {
      requiredPreyNearby: relations
        .filter(r => r.predator === spiritId)
        .map(r => ({ preyId: r.prey, minCount: 1 })),
      avoidsPredators: relations
        .filter(r => r.prey === spiritId)
        .map(r => ({ predatorId: r.predator, maxDistance: r.interactionRadius })),
    };
  }
}
```

### 4. 精灵生成优化

```typescript
// backend/catch-service/src/spawn/ecosystem-spawn.service.ts

import { Injectable } from '@nestjs/common';
import { HabitatService } from '@app/location-service';
import { EcosystemChainService } from '@app/shared/ecosystem';

@Injectable()
export class EcosystemSpawnService {
  constructor(
    private habitatService: HabitatService,
    private ecosystemChainService: EcosystemChainService,
  ) {}

  /**
   * 基于生态系统生成精灵
   */
  async spawnSpiritsForPlayer(
    playerId: string,
    location: Location,
    count: number = 3,
  ): Promise<SpawnedSpirit[]> {
    // 1. 获取栖息地和环境上下文
    const habitatType = await this.habitatService.getHabitatAtLocation(
      location.latitude,
      location.longitude,
    );
    const context = await this.habitatService.getEnvironmentalContext(
      location.latitude,
      location.longitude,
    );
    
    // 2. 检查生态平衡
    const ecosystemStatus = await this.ecosystemChainService.checkEcosystemBalance(
      location,
      await this.getRecentSpawns(location),
    );
    
    // 3. 候选精灵池
    const candidates = await this.buildCandidatePool(habitatType, context, ecosystemStatus);
    
    // 4. 加权随机选择
    const selected = this.weightedRandomSelect(candidates, count);
    
    // 5. 生成精灵实例
    return selected.map(spirit => this.createSpiritInstance(spirit, location, context));
  }

  /**
   * 构建候选精灵池
   */
  private async buildCandidatePool(
    habitatType: HabitatType,
    context: EnvironmentalContext,
    ecosystemStatus: EcosystemStatus,
  ): Promise<CandidateSpirit[]> {
    const allSpirits = await this.spiritRegistry.getAllActive();
    
    return allSpirits
      .map(spirit => {
        // 计算基础生成概率
        let probability = this.habitatService.calculateSpawnProbability(
          spirit.id,
          habitatType,
          context,
        );
        
        // 应用生态平衡调整
        if (ecosystemStatus.spawnAdjustment) {
          if (this.isPredator(spirit.id)) {
            probability *= ecosystemStatus.spawnAdjustment.predatorMultiplier;
          } else if (this.isPrey(spirit.id)) {
            probability *= ecosystemStatus.spawnAdjustment.preyMultiplier;
          }
        }
        
        // 检查生成条件
        const conditions = this.ecosystemChainService.getSpawnConditions(spirit.id);
        if (!this.checkSpawnConditions(conditions, location)) {
          probability *= 0.1;  // 条件不满足时大幅降低概率
        }
        
        return { spirit, probability };
      })
      .filter(c => c.probability > 0.001);  // 过滤极低概率
  }
}
```

### 5. 栖息地可视化（客户端）

```typescript
// game-client/src/components/HabitatOverlay.ts

import { HabitatType } from '@shared/ecosystem';

export class HabitatOverlay {
  private habitatColors: Record<HabitatType, number> = {
    [HabitatType.FOREST]: 0x228B22,    // 森林绿
    [HabitatType.GRASSLAND]: 0x90EE90, // 草原浅绿
    [HabitatType.DESERT]: 0xF4A460,    // 沙漠黄
    [HabitatType.WETLAND]: 0x20B2AA,   // 湿地青
    [HabitatType.MOUNTAIN]: 0x808080,  // 山地灰
    [HabitatType.OCEAN]: 0x0000CD,     // 海洋蓝
    [HabitatType.COASTAL]: 0x40E0D0,   // 沿海青绿
    [HabitatType.URBAN]: 0x696969,     // 城市灰
    [HabitatType.POLAR]: 0xF0FFFF,     // 极地白
    [HabitatType.CAVE]: 0x2F4F4F,      // 洞穴暗青
    [HabitatType.VOLCANIC]: 0xFF4500,  // 火山橙红
    [HabitatType.SKY]: 0x87CEEB,       // 天空蓝
  };

  /**
   * 渲染栖息地地图图层
   */
  renderHabitatLayer(
    graphics: Phaser.GameObjects.Graphics,
    habitats: HabitatTile[],
    zoom: number,
  ): void {
    const alpha = Math.max(0.1, Math.min(0.3, 0.1 * zoom));
    
    habitats.forEach(tile => {
      const color = this.habitatColors[tile.type];
      graphics.fillStyle(color, alpha);
      graphics.fillRectShape(tile.bounds);
      
      // 绘制边界线
      graphics.lineStyle(1, color, alpha * 0.5);
      graphics.strokeRectShape(tile.bounds);
    });
  }

  /**
   * 显示当前栖息地信息
   */
  showHabitatInfo(habitatType: HabitatType, context: EnvironmentalContext): void {
    const infoPanel = this.scene.get('HabitatInfoPanel');
    
    infoPanel.setData({
      habitat: this.getHabitatName(habitatType),
      timeOfDay: this.formatTimeOfDay(context.timeOfDay),
      weather: this.formatWeather(context.weather),
      season: this.formatSeason(context.season),
      activeSpirits: this.getActiveSpiritTypes(habitatType, context),
      spawnBonus: this.calculateOverallBonus(habitatType, context),
    });
    
    infoPanel.setVisible(true);
  }
}
```

### 6. 管理后台配置

```typescript
// backend/admin-dashboard/src/pages/HabitatConfig.tsx

import React, { useState, useEffect } from 'react';
import { HabitatType, TimeOfDay, Weather, Season } from '@shared/ecosystem';

export const HabitatConfigPage: React.FC = () => {
  const [habitats, setHabitats] = useState<HabitatConfig[]>([]);

  return (
    <div className="habitat-config">
      <h1>栖息地配置管理</h1>
      
      <div className="habitat-grid">
        {habitats.map(habitat => (
          <HabitatCard
            key={habitat.type}
            habitat={habitat}
            onSave={(updated) => handleSaveHabitat(updated)}
          />
        ))}
      </div>
      
      <div className="environmental-factors">
        <h2>环境因素配置</h2>
        <TimeOfDayConfig />
        <WeatherConfig />
        <SeasonConfig />
      </div>
      
      <div className="predator-prey-relations">
        <h2>捕食者-猎物关系</h2>
        <RelationEditor />
      </div>
    </div>
  );
};

const HabitatCard: React.FC<{ habitat: HabitatConfig; onSave: (h: HabitatConfig) => void }> = 
  ({ habitat, onSave }) => {
  const [editing, setEditing] = useState(false);
  
  return (
    <div className={`habitat-card ${habitat.type}`}>
      <h3>{formatHabitatType(habitat.type)}</h3>
      
      <div className="spawn-multiplier">
        <label>基础生成倍率:</label>
        <input 
          type="number" 
          step="0.1"
          value={habitat.baseSpawnMultiplier}
          onChange={(e) => handleMultiplierChange(e.target.value)}
        />
      </div>
      
      <div className="spirit-affinities">
        <h4>精灵类型亲和度</h4>
        {Array.from(habitat.spiritTypeAffinities.entries()).map(([type, affinity]) => (
          <div key={type} className="affinity-row">
            <span>{type}</span>
            <input type="range" min="0" max="3" step="0.1" value={affinity} />
            <span>{affinity.toFixed(1)}x</span>
          </div>
        ))}
      </div>
      
      <div className="actions">
        <button onClick={() => setEditing(!editing)}>
          {editing ? '取消' : '编辑'}
        </button>
        {editing && <button onClick={() => onSave(habitat)}>保存</button>}
      </div>
    </div>
  );
};
```

### 7. 数据库设计

```sql
-- 栖息地配置表
CREATE TABLE habitat_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL UNIQUE,
  base_spawn_multiplier DECIMAL(4,2) NOT NULL DEFAULT 1.0,
  spirit_type_affinities JSONB NOT NULL DEFAULT '{}',
  environmental_modifiers JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 捕食者-猎物关系表
CREATE TABLE predator_prey_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  predator_spirit_id VARCHAR(50) NOT NULL REFERENCES spirits(id),
  prey_spirit_id VARCHAR(50) NOT NULL REFERENCES spirits(id),
  interaction_radius INT NOT NULL DEFAULT 100,
  spawn_suppression DECIMAL(4,3) NOT NULL DEFAULT 0.8,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 栖息地区域映射表（用于缓存地理区域的栖息地类型）
CREATE TABLE habitat_regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geohash VARCHAR(12) NOT NULL UNIQUE,
  habitat_type VARCHAR(50) NOT NULL REFERENCES habitat_configs(type),
  confidence DECIMAL(4,3) NOT NULL DEFAULT 1.0,
  source VARCHAR(50) NOT NULL,  -- 'osm', 'manual', 'ml'
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  INDEX idx_habitat_regions_geohash (geohash),
  INDEX idx_habitat_regions_type (habitat_type)
);

-- 环境上下文缓存表
CREATE TABLE environmental_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geohash VARCHAR(12) NOT NULL,
  weather VARCHAR(30),
  temperature DECIMAL(5,2),
  humidity DECIMAL(5,2),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(geohash)
);

-- 精灵生成日志（用于生态分析）
CREATE TABLE spawn_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spirit_id VARCHAR(50) NOT NULL,
  player_id UUID NOT NULL,
  habitat_type VARCHAR(50) NOT NULL,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  time_of_day VARCHAR(20) NOT NULL,
  weather VARCHAR(30),
  season VARCHAR(20) NOT NULL,
  spawn_probability DECIMAL(6,5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_spawn_logs_habitat ON spawn_logs(habitat_type);
CREATE INDEX idx_spawn_logs_time ON spawn_logs(time_of_day);
CREATE INDEX idx_spawn_logs_spirit ON spawn_logs(spirit_id);
CREATE INDEX idx_spawn_logs_created ON spawn_logs(created_at DESC);
```

### 8. API 端点

```yaml
# 环境与栖息地 API
paths:
  /api/v1/habitat/current:
    get:
      summary: 获取当前位置的栖息地信息
      parameters:
        - name: lat
          in: query
          required: true
          schema:
            type: number
        - name: lng
          in: query
          required: true
          schema:
            type: number
      responses:
        200:
          content:
            application/json:
              schema:
                type: object
                properties:
                  habitatType:
                    type: string
                    enum: [forest, grassland, desert, ...]
                  environmentalContext:
                    $ref: '#/components/schemas/EnvironmentalContext'
                  activeSpiritTypes:
                    type: array
                    items:
                      type: string
                  spawnBonus:
                    type: number

  /api/v1/habitat/{type}/spirits:
    get:
      summary: 获取特定栖息地的活跃精灵类型
      parameters:
        - name: type
          in: path
          required: true
          schema:
            type: string
        - name: timeOfDay
          in: query
          schema:
            type: string
        - name: weather
          in: query
          schema:
            type: string
        - name: season
          in: query
          schema:
            type: string
      responses:
        200:
          content:
            application/json:
              schema:
                type: object
                properties:
                  spirits:
                    type: array
                    items:
                      $ref: '#/components/schemas/SpiritSpawnInfo'

  /api/v1/ecosystem/balance:
    get:
      summary: 获取区域生态平衡状态
      parameters:
        - name: lat
          in: query
          required: true
        - name: lng
          in: query
          required: true
        - name: radius
          in: query
          schema:
            type: number
            default: 500
      responses:
        200:
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EcosystemStatus'

components:
  schemas:
    EnvironmentalContext:
      type: object
      properties:
        timeOfDay:
          type: string
          enum: [dawn, morning, noon, afternoon, dusk, night]
        weather:
          type: string
          enum: [clear, cloudy, rain, storm, snow, fog, sandstorm]
        season:
          type: string
          enum: [spring, summer, autumn, winter]
        temperature:
          type: number
        humidity:
          type: number

    SpiritSpawnInfo:
      type: object
      properties:
        spiritId:
          type: string
        name:
          type: string
        baseProbability:
          type: number
        modifiedProbability:
          type: number
        conditions:
          type: object

    EcosystemStatus:
      type: object
      properties:
        status:
          type: string
          enum: [balanced, predator_dominated, prey_dominated]
        predatorCount:
          type: integer
        preyCount:
          type: integer
        spawnAdjustment:
          type: object
          nullable: true
```

## 验收标准

- [ ] 支持至少 12 种栖息地类型定义，每种有独立的精灵类型亲和度配置
- [ ] 时间段、天气、季节三重环境因素正确影响精灵生成概率
- [ ] 南北半球季节计算正确（如北半球夏季时南半球为冬季）
- [ ] 栖息地信息缓存命中率 > 90%（相同区域请求）
- [ ] 捕食者-猎物关系正确影响区域精灵生成平衡
- [ ] 管理后台可配置所有栖息地参数和环境因素
- [ ] 客户端可显示当前栖息地类型和环境上下文
- [ ] 精灵生成日志完整记录环境因素，支持后续分析
- [ ] 天气 API 调用失败时使用默认值，不影响游戏体验
- [ ] 栖息地可视化图层正确渲染，支持半透明叠加

## 影响范围

- **新增文件**:
  - `backend/shared/ecosystem/` - 生态系统核心模块
  - `backend/location-service/src/habitat/` - 栖息地服务
  - `backend/catch-service/src/spawn/ecosystem-spawn.service.ts`
  - `game-client/src/components/HabitatOverlay.ts`
  - `backend/admin-dashboard/src/pages/HabitatConfig.tsx`

- **修改文件**:
  - `backend/catch-service/src/spawn/spawn.service.ts` - 集成生态生成
  - `game-client/src/scenes/MapScene.ts` - 添加栖息地图层
  - `backend/database/migrations/` - 新增数据库表

- **数据库变更**:
  - 新增 `habitat_configs` 表
  - 新增 `predator_prey_relations` 表
  - 新增 `habitat_regions` 表
  - 新增 `environmental_cache` 表
  - 新增 `spawn_logs` 表

## 参考

- OpenStreetMap Landuse Tags: https://wiki.openstreetmap.org/wiki/Key:landuse
- OpenWeatherMap API: https://openweathermap.org/api
- 生态系统动力学模型: Lotka-Volterra 方程
- 时区与地理经度关系: UTC 偏移计算
