# REQ-00422: 精灵数据预编译缓存系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00422 |
| 标题 | 精灵数据预编译缓存系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-core、catch-service、battle-service、shared/cache、admin-dashboard |
| 创建时间 | 2026-07-02 03:00 |

## 需求描述

当前系统在处理精灵相关查询时，存在以下性能瓶颈：

1. **冷启动延迟**：服务启动后首次查询精灵数据需要从数据库加载，延迟较高
2. **重复计算**：精灵属性计算（基础属性、成长曲线、技能效果等）每次都实时计算，浪费 CPU
3. **关联查询开销**：精灵详情需要关联查询技能、进化链、栖息地等多表数据，查询开销大
4. **缓存粒度粗**：当前缓存以完整精灵对象为单位，无法有效利用部分数据
5. **缓存失效频繁**：任何属性变更都导致整个缓存失效，命中率低

本需求实现精灵数据预编译缓存系统，通过编译时预处理、分层缓存、智能预加载等技术，将精灵查询延迟降低 70% 以上。

### 核心目标

- 预编译热点精灵数据，消除启动时冷查询
- 分层缓存（基础属性/计算属性/关联数据），提高缓存命中率
- 智能预加载，预测用户可能查询的精灵并提前加载
- 增量更新机制，减少缓存失效范围
- 提供缓存预热、刷新、统计等管理能力

## 技术方案

### 1. 预编译数据模型

```typescript
// backend/shared/cache/src/sprite-precompiled/types.ts

/**
 * 预编译精灵数据结构
 */
export interface PrecompiledSpriteData {
  // 基础元数据（不可变）
  baseInfo: {
    spriteId: string;
    name: string;
    rarity: Rarity;
    elementalType: ElementalType[];
    baseStats: BaseStats;
    evolutionChain: EvolutionStep[];
    learnableSkills: string[];
    habitatZones: string[];
    version: number;
    compiledAt: Date;
  };

  // 预计算属性（各级别）
  precomputedStats: {
    byLevel: Map<number, PrecomputedStats>;
    byRarity: Map<Rarity, PrecomputedStats>;
    atMaxLevel: PrecomputedStats;
  };

  // 预编译技能效果
  skillEffects: Map<string, PrecompiledSkillEffect>;

  // 预编译战斗属性
  battleProperties: {
    typeAdvantages: Map<ElementalType, number>;
    typeDisadvantages: Map<ElementalType, number>;
    counterTo: string[];
    counteredBy: string[];
  };

  // 预编译元数据
  metadata: {
    searchKeywords: string[];
    tags: string[];
    recommendedTeamRoles: TeamRole[];
    synergies: SynergyBonus[];
  };
}

export interface PrecomputedStats {
  hp: number;
  attack: number;
  defense: number;
  specialAttack: number;
  specialDefense: number;
  speed: number;
  critRate: number;
  critDamage: number;
  evasion: number;
  accuracy: number;
  totalPower: number;
}

export interface PrecompiledSkillEffect {
  skillId: string;
  baseDamage: number;
  damageFormula: string; // 预编译的公式字符串
  effects: SkillEffect[];
  cooldown: number;
  energyCost: number;
  targetType: TargetType;
  aoeRadius?: number;
}

/**
 * 缓存分层定义
 */
export enum CacheLayer {
  IMMUTABLE = 'immutable',   // 不可变基础数据（精灵模板）
  COMPUTED = 'computed',     // 计算属性（按级别/稀有度）
  ASSOCIATED = 'associated', // 关联数据（技能、栖息地）
  DYNAMIC = 'dynamic'        // 动态数据（玩家特定精灵实例）
}
```

### 2. 预编译缓存管理器

```typescript
// backend/shared/cache/src/sprite-precompiled/precompiled-cache-manager.ts

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';
import { 
  PrecompiledSpriteData, 
  CacheLayer,
  PrecomputedStats 
} from './types';

@Injectable()
export class PrecompiledCacheManager implements OnModuleInit {
  private readonly redis: Redis;
  private readonly localCache: LRUCache<string, PrecompiledSpriteData>;
  private readonly compiledVersion: string;
  private isWarmedUp = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly spriteRepository: SpriteRepository,
    private readonly metricsService: MetricsService,
    private readonly logger: Logger
  ) {
    this.redis = new Redis(configService.get('REDIS_URL'));
    this.localCache = new LRUCache<string, PrecompiledSpriteData>({
      max: 5000,
      ttl: 1000 * 60 * 60, // 1 hour
      updateAgeOnGet: true,
      updateAgeOnHas: true
    });
    this.compiledVersion = this.generateVersion();
  }

  async onModuleInit() {
    // 启动时预热缓存
    await this.warmupCache();
  }

  /**
   * 缓存预热：预编译所有精灵数据
   */
  async warmupCache(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting sprite cache warmup...');

    try {
      // 1. 获取所有精灵模板
      const sprites = await this.spriteRepository.findAllTemplates();
      
      // 2. 并行预编译
      const batchSize = 100;
      const batches = this.chunkArray(sprites, batchSize);
      
      let compiled = 0;
      for (const batch of batches) {
        await Promise.all(
          batch.map(sprite => this.precompileSprite(sprite))
        );
        compiled += batch.length;
        this.logger.debug(`Precompiled ${compiled}/${sprites.length} sprites`);
      }

      // 3. 标记预热完成
      await this.redis.set('sprite:cache:warmed', 'true', 'EX', 86400);
      this.isWarmedUp = true;

      const duration = Date.now() - startTime;
      this.logger.log(
        `Cache warmup completed: ${sprites.length} sprites in ${duration}ms`
      );

      // 4. 记录指标
      this.metricsService.gauge('sprite_cache_warmed', 1);
      this.metricsService.histogram(
        'sprite_cache_warmup_duration_ms',
        duration
      );

    } catch (error) {
      this.logger.error('Cache warmup failed', error);
      this.metricsService.increment('sprite_cache_warmup_errors');
      throw error;
    }
  }

  /**
   * 预编译单个精灵
   */
  private async precompileSprite(sprite: SpriteTemplate): Promise<void> {
    const startTime = Date.now();

    try {
      // 1. 编译基础信息
      const baseInfo = await this.compileBaseInfo(sprite);

      // 2. 预计算各级别属性
      const precomputedStats = await this.precomputeStats(sprite);

      // 3. 预编译技能效果
      const skillEffects = await this.compileSkillEffects(sprite);

      // 4. 预编译战斗属性
      const battleProperties = await this.compileBattleProperties(sprite);

      // 5. 预编译元数据
      const metadata = await this.compileMetadata(sprite);

      // 6. 组装预编译数据
      const precompiled: PrecompiledSpriteData = {
        baseInfo,
        precomputedStats,
        skillEffects,
        battleProperties,
        metadata,
      };

      // 7. 分层存储
      const cacheKey = this.getCacheKey(sprite.id);
      
      // 存储到本地缓存（L1）
      this.localCache.set(cacheKey, precompiled);

      // 存储到 Redis（L2）
      await this.redis.hset(
        `sprite:precompiled:${CacheLayer.IMMUTABLE}`,
        sprite.id,
        JSON.stringify(baseInfo)
      );

      await this.redis.hset(
        `sprite:precompiled:${CacheLayer.COMPUTED}`,
        sprite.id,
        JSON.stringify({
          precomputedStats: Array.from(precomputedStats.byLevel.entries()),
          skillEffects: Array.from(skillEffects.entries()),
        })
      );

      // 8. 记录指标
      const duration = Date.now() - startTime;
      this.metricsService.histogram(
        'sprite_precompile_duration_ms',
        duration,
        { spriteId: sprite.id }
      );

    } catch (error) {
      this.logger.error(
        `Failed to precompile sprite ${sprite.id}`,
        error
      );
      throw error;
    }
  }

  /**
   * 获取预编译数据
   */
  async getPrecompiled(
    spriteId: string,
    options: GetPrecompiledOptions = {}
  ): Promise<PrecompiledSpriteData | null> {
    const cacheKey = this.getCacheKey(spriteId);

    // 1. 尝试从本地缓存获取（L1）
    let data = this.localCache.get(cacheKey);
    if (data) {
      this.metricsService.increment('sprite_cache_hit', { layer: 'local' });
      return data;
    }

    // 2. 从 Redis 获取（L2）
    const [baseInfo, computed] = await Promise.all([
      this.redis.hget(`sprite:precompiled:${CacheLayer.IMMUTABLE}`, spriteId),
      this.redis.hget(`sprite:precompiled:${CacheLayer.COMPUTED}`, spriteId),
    ]);

    if (!baseInfo || !computed) {
      this.metricsService.increment('sprite_cache_miss');
      return null;
    }

    // 3. 重建完整对象
    data = this.rebuildFromCache(
      JSON.parse(baseInfo),
      JSON.parse(computed)
    );

    // 4. 回填本地缓存
    this.localCache.set(cacheKey, data);

    this.metricsService.increment('sprite_cache_hit', { layer: 'redis' });
    return data;
  }

  /**
   * 获取预计算属性（指定级别）
   */
  async getPrecomputedStats(
    spriteId: string,
    level: number
  ): Promise<PrecomputedStats | null> {
    // 先尝试直接获取缓存级别
    const levelKey = `sprite:stats:${spriteId}:level:${level}`;
    const cached = await this.redis.get(levelKey);
    
    if (cached) {
      return JSON.parse(cached);
    }

    // 获取完整预编译数据
    const precompiled = await this.getPrecompiled(spriteId);
    if (!precompiled) {
      return null;
    }

    // 查找预计算值
    let stats = precompiled.precomputedStats.byLevel.get(level);
    
    // 如果没有精确匹配，插值计算
    if (!stats) {
      stats = this.interpolateStats(
        precompiled.precomputedStats.byLevel,
        level
      );
    }

    // 缓存到 Redis
    await this.redis.set(
      levelKey,
      JSON.stringify(stats),
      'EX',
      3600 // 1 hour
    );

    return stats;
  }

  /**
   * 批量获取预编译数据
   */
  async getPrecompiledBatch(
    spriteIds: string[]
  ): Promise<Map<string, PrecompiledSpriteData>> {
    const result = new Map<string, PrecompiledSpriteData>();
    const missing: string[] = [];

    // 1. 批量检查本地缓存
    for (const id of spriteIds) {
      const cached = this.localCache.get(this.getCacheKey(id));
      if (cached) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) {
      return result;
    }

    // 2. 批量从 Redis 获取
    const pipeline = this.redis.pipeline();
    for (const id of missing) {
      pipeline.hget(`sprite:precompiled:${CacheLayer.IMMUTABLE}`, id);
      pipeline.hget(`sprite:precompiled:${CacheLayer.COMPUTED}`, id);
    }

    const results = await pipeline.exec();

    // 3. 处理结果
    for (let i = 0; i < missing.length; i++) {
      const baseInfo = results[i * 2][1];
      const computed = results[i * 2 + 1][1];

      if (baseInfo && computed) {
        const data = this.rebuildFromCache(
          JSON.parse(baseInfo),
          JSON.parse(computed)
        );
        result.set(missing[i], data);
        this.localCache.set(this.getCacheKey(missing[i]), data);
      }
    }

    // 4. 记录批量查询指标
    this.metricsService.histogram(
      'sprite_batch_query_size',
      spriteIds.length
    );
    this.metricsService.gauge(
      'sprite_batch_cache_hit_rate',
      result.size / spriteIds.length
    );

    return result;
  }

  /**
   * 智能预加载
   */
  async intelligentPreload(
    context: PreloadContext
  ): Promise<void> {
    const predictions = await this.predictNeededSprites(context);
    
    // 并行预加载
    await Promise.all(
      predictions.map(spriteId => this.getPrecompiled(spriteId))
    );

    this.metricsService.histogram(
      'sprite_intelligent_preload_count',
      predictions.length
    );
  }

  /**
   * 预测需要的精灵
   */
  private async predictNeededSprites(
    context: PreloadContext
  ): Promise<string[]> {
    const predictions: Set<string> = new Set();

    // 1. 基于当前位置预测
    if (context.location) {
      const nearbySprites = await this.getSpritesNearLocation(
        context.location,
        5 // 预测半径 5km
      );
      nearbySprites.forEach(s => predictions.add(s));
    }

    // 2. 基于玩家背包预测
    if (context.playerId) {
      const playerSprites = await this.getPlayerTeamSprites(
        context.playerId
      );
      playerSprites.forEach(s => predictions.add(s));

      // 预测可能遇到的对手精灵
      const counterSprites = await this.getCounterSprites(playerSprites);
      counterSprites.forEach(s => predictions.add(s));
    }

    // 3. 基于时间和天气预测
    const timeWeatherSprites = await this.getSpritesByTimeAndWeather(
      context.currentTime,
      context.weather
    );
    timeWeatherSprites.forEach(s => predictions.add(s));

    // 4. 基于近期查询历史预测
    if (context.recentQueries) {
      const relatedSprites = await this.getRelatedSprites(
        context.recentQueries
      );
      relatedSprites.forEach(s => predictions.add(s));
    }

    return Array.from(predictions).slice(0, 50); // 限制预测数量
  }

  /**
   * 缓存失效（增量更新）
   */
  async invalidatePartial(
    spriteId: string,
    layers: CacheLayer[]
  ): Promise<void> {
    // 删除本地缓存
    this.localCache.delete(this.getCacheKey(spriteId));

    // 删除 Redis 指定层
    for (const layer of layers) {
      await this.redis.hdel(
        `sprite:precompiled:${layer}`,
        spriteId
      );
    }

    this.logger.log(
      `Invalidated sprite ${spriteId} layers: ${layers.join(', ')}`
    );
    this.metricsService.increment('sprite_cache_invalidation');
  }

  /**
   * 重新编译单个精灵
   */
  async recompile(spriteId: string): Promise<void> {
    const sprite = await this.spriteRepository.findTemplateById(spriteId);
    if (!sprite) {
      throw new Error(`Sprite ${spriteId} not found`);
    }

    await this.precompileSprite(sprite);
    this.logger.log(`Recompiled sprite ${spriteId}`);
  }

  /**
   * 获取缓存统计
   */
  async getCacheStats(): Promise<CacheStats> {
    const [immutableCount, computedCount] = await Promise.all([
      this.redis.hlen(`sprite:precompiled:${CacheLayer.IMMUTABLE}`),
      this.redis.hlen(`sprite:precompiled:${CacheLayer.COMPUTED}`),
    ]);

    return {
      localCacheSize: this.localCache.size,
      localCacheMaxSize: this.localCache.max,
      immutableCount,
      computedCount,
      warmedUp: this.isWarmedUp,
      compiledVersion: this.compiledVersion,
      hitRate: await this.calculateHitRate(),
    };
  }

  private getCacheKey(spriteId: string): string {
    return `sprite:${spriteId}:v${this.compiledVersion}`;
  }

  private generateVersion(): string {
    // 基于代码版本和配置生成
    return `${process.env.npm_package_version || '1.0.0'}-${Date.now()}`;
  }

  private async calculateHitRate(): Promise<number> {
    const hits = await this.redis.get('sprite:cache:hits') || '0';
    const misses = await this.redis.get('sprite:cache:misses') || '0';
    const total = parseInt(hits) + parseInt(misses);
    return total > 0 ? parseInt(hits) / total : 0;
  }
}

interface GetPrecompiledOptions {
  includeSkillEffects?: boolean;
  includeBattleProperties?: boolean;
  includeMetadata?: boolean;
}

interface PreloadContext {
  location?: GeoLocation;
  playerId?: string;
  currentTime?: Date;
  weather?: Weather;
  recentQueries?: string[];
}

interface CacheStats {
  localCacheSize: number;
  localCacheMaxSize: number;
  immutableCount: number;
  computedCount: number;
  warmedUp: boolean;
  compiledVersion: string;
  hitRate: number;
}
```

### 3. 属性预计算引擎

```typescript
// backend/shared/cache/src/sprite-precompiled/stats-calculator.ts

import { Injectable } from '@nestjs/common';

@Injectable()
export class StatsCalculator {
  /**
   * 预计算所有级别的属性
   */
  async precomputeAllLevels(
    sprite: SpriteTemplate,
    levels: number[] = this.getDefaultLevels()
  ): Promise<Map<number, PrecomputedStats>> {
    const results = new Map<number, PrecomputedStats>();

    for (const level of levels) {
      const stats = this.calculateStatsAtLevel(sprite, level);
      results.set(level, stats);
    }

    return results;
  }

  /**
   * 计算指定级别属性
   */
  private calculateStatsAtLevel(
    sprite: SpriteTemplate,
    level: number
  ): PrecomputedStats {
    const base = sprite.baseStats;
    const growth = sprite.growthCurve;
    const rarity = sprite.rarity;

    // 使用预定义公式计算
    const hp = this.calculateHP(base.hp, level, growth.hpRate, rarity);
    const attack = this.calculateStat(
      base.attack,
      level,
      growth.attackRate,
      rarity
    );
    const defense = this.calculateStat(
      base.defense,
      level,
      growth.defenseRate,
      rarity
    );
    const specialAttack = this.calculateStat(
      base.specialAttack,
      level,
      growth.specialAttackRate,
      rarity
    );
    const specialDefense = this.calculateStat(
      base.specialDefense,
      level,
      growth.specialDefenseRate,
      rarity
    );
    const speed = this.calculateStat(
      base.speed,
      level,
      growth.speedRate,
      rarity
    );

    // 计算衍生属性
    const critRate = this.calculateCritRate(sprite, level);
    const critDamage = this.calculateCritDamage(sprite, level);
    const evasion = this.calculateEvasion(sprite, level);
    const accuracy = this.calculateAccuracy(sprite, level);

    // 计算总战力
    const totalPower = this.calculateTotalPower({
      hp,
      attack,
      defense,
      specialAttack,
      specialDefense,
      speed,
      critRate,
      critDamage,
    });

    return {
      hp,
      attack,
      defense,
      specialAttack,
      specialDefense,
      speed,
      critRate,
      critDamage,
      evasion,
      accuracy,
      totalPower,
    };
  }

  /**
   * HP 计算公式
   */
  private calculateHP(
    base: number,
    level: number,
    rate: number,
    rarity: Rarity
  ): number {
    const rarityMultiplier = this.getRarityMultiplier(rarity);
    return Math.floor(
      (base * 2 + rate * (level - 1)) * level / 100 + level + 10
    ) * rarityMultiplier;
  }

  /**
   * 其他属性计算公式
   */
  private calculateStat(
    base: number,
    level: number,
    rate: number,
    rarity: Rarity
  ): number {
    const rarityMultiplier = this.getRarityMultiplier(rarity);
    return Math.floor(
      (base * 2 + rate * (level - 1)) * level / 100 + 5
    ) * rarityMultiplier;
  }

  /**
   * 暴击率计算
   */
  private calculateCritRate(sprite: SpriteTemplate, level: number): number {
    const baseRate = sprite.baseCritRate || 0.05;
    const levelBonus = level * 0.001;
    return Math.min(baseRate + levelBonus, 0.5); // 最高 50%
  }

  /**
   * 暴击伤害计算
   */
  private calculateCritDamage(sprite: SpriteTemplate, level: number): number {
    const baseDamage = sprite.baseCritDamage || 1.5;
    const levelBonus = level * 0.005;
    return Math.min(baseDamage + levelBonus, 3.0); // 最高 3x
  }

  /**
   * 闪避率计算
   */
  private calculateEvasion(sprite: SpriteTemplate, level: number): number {
    const speed = sprite.baseStats.speed;
    return Math.min(0.02 + speed * 0.001, 0.3); // 最高 30%
  }

  /**
   * 命中率计算
   */
  private calculateAccuracy(sprite: SpriteTemplate, level: number): number {
    return Math.min(0.9 + level * 0.001, 1.0); // 最高 100%
  }

  /**
   * 总战力计算
   */
  private calculateTotalPower(stats: Partial<PrecomputedStats>): number {
    const weights = {
      hp: 0.5,
      attack: 1.0,
      defense: 0.8,
      specialAttack: 1.0,
      specialDefense: 0.8,
      speed: 0.6,
      critRate: 2.0,
      critDamage: 1.5,
    };

    let power = 0;
    for (const [key, weight] of Object.entries(weights)) {
      power += (stats[key] || 0) * weight;
    }

    return Math.floor(power);
  }

  /**
   * 插值计算（用于未缓存的级别）
   */
  interpolateStats(
    cachedStats: Map<number, PrecomputedStats>,
    targetLevel: number
  ): PrecomputedStats {
    // 找到上下界
    const levels = Array.from(cachedStats.keys()).sort((a, b) => a - b);
    
    if (targetLevel <= levels[0]) {
      return cachedStats.get(levels[0])!;
    }
    
    if (targetLevel >= levels[levels.length - 1]) {
      return cachedStats.get(levels[levels.length - 1])!;
    }

    // 找到插值区间
    let lowerLevel = levels[0];
    let upperLevel = levels[levels.length - 1];
    
    for (let i = 0; i < levels.length - 1; i++) {
      if (levels[i] <= targetLevel && targetLevel < levels[i + 1]) {
        lowerLevel = levels[i];
        upperLevel = levels[i + 1];
        break;
      }
    }

    // 线性插值
    const lowerStats = cachedStats.get(lowerLevel)!;
    const upperStats = cachedStats.get(upperLevel)!;
    const ratio = (targetLevel - lowerLevel) / (upperLevel - lowerLevel);

    return this.interpolate(lowerStats, upperStats, ratio);
  }

  private interpolate(
    lower: PrecomputedStats,
    upper: PrecomputedStats,
    ratio: number
  ): PrecomputedStats {
    const result: any = {};
    
    for (const key of Object.keys(lower)) {
      result[key] = Math.floor(
        lower[key] + (upper[key] - lower[key]) * ratio
      );
    }

    return result as PrecomputedStats;
  }

  private getRarityMultiplier(rarity: Rarity): number {
    const multipliers: Record<Rarity, number> = {
      [Rarity.COMMON]: 1.0,
      [Rarity.UNCOMMON]: 1.1,
      [Rarity.RARE]: 1.2,
      [Rarity.EPIC]: 1.35,
      [Rarity.LEGENDARY]: 1.5,
      [Rarity.MYTHIC]: 1.7,
    };
    return multipliers[rarity] || 1.0;
  }

  private getDefaultLevels(): number[] {
    // 预计算关键级别
    return [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  }
}
```

### 4. 服务启动预热钩子

```typescript
// backend/game-core/src/hooks/cache-warmup.hook.ts

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { PrecompiledCacheManager } from '@shared/cache';

@Injectable()
export class CacheWarmupHook implements OnApplicationBootstrap {
  constructor(
    private readonly cacheManager: PrecompiledCacheManager,
    private readonly configService: ConfigService,
    private readonly logger: Logger
  ) {}

  async onApplicationBootstrap() {
    // 检查是否需要预热
    const skipWarmup = this.configService.get('SKIP_CACHE_WARMUP');
    if (skipWarmup === 'true') {
      this.logger.log('Skipping cache warmup (SKIP_CACHE_WARMUP=true)');
      return;
    }

    // 等待预热完成（带超时）
    const timeout = 30000; // 30 seconds
    try {
      await Promise.race([
        this.cacheManager.warmupCache(),
        this.timeoutAfter(timeout),
      ]);
    } catch (error) {
      this.logger.error('Cache warmup failed, continuing anyway', error);
    }
  }

  private timeoutAfter(ms: number): Promise<void> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Warmup timeout')), ms);
    });
  }
}
```

### 5. 管理 API

```typescript
// backend/admin-dashboard/src/controllers/sprite-cache.controller.ts

import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { PrecompiledCacheManager } from '@shared/cache';

@Controller('admin/sprite-cache')
export class SpriteCacheController {
  constructor(
    private readonly cacheManager: PrecompiledCacheManager
  ) {}

  /**
   * 获取缓存统计
   */
  @Get('stats')
  async getStats() {
    return this.cacheManager.getCacheStats();
  }

  /**
   * 手动预热缓存
   */
  @Post('warmup')
  async warmup() {
    await this.cacheManager.warmupCache();
    return { success: true, message: 'Cache warmup initiated' };
  }

  /**
   * 清空缓存
   */
  @Post('clear')
  async clear(@Query('layer') layer?: CacheLayer) {
    if (layer) {
      await this.cacheManager.clearLayer(layer);
    } else {
      await this.cacheManager.clearAll();
    }
    return { success: true };
  }

  /**
   * 重新编译单个精灵
   */
  @Post('recompile/:spriteId')
  async recompile(@Param('spriteId') spriteId: string) {
    await this.cacheManager.recompile(spriteId);
    return { success: true, spriteId };
  }

  /**
   * 预测预加载
   */
  @Post('preload')
  async preload(@Body() context: PreloadContext) {
    await this.cacheManager.intelligentPreload(context);
    return { success: true };
  }

  /**
   * 获取缓存命中率趋势
   */
  @Get('hit-rate/trend')
  async getHitRateTrend(@Query('period') period: string = '1h') {
    return this.cacheManager.getHitRateTrend(period);
  }
}
```

### 6. Prometheus 指标

```typescript
// backend/shared/cache/src/sprite-precompiled/metrics.ts

import { Injectable } from '@nestjs/common';
import { Registry, Gauge, Histogram, Counter } from 'prom-client';

@Injectable()
export class SpriteCacheMetrics {
  private readonly registry: Registry;

  // 缓存状态
  readonly warmedUp: Gauge;
  readonly cacheSize: Gauge;
  readonly hitRate: Gauge;

  // 性能指标
  readonly warmupDuration: Histogram;
  readonly precompileDuration: Histogram;
  readonly queryDuration: Histogram;

  // 计数器
  readonly cacheHits: Counter;
  readonly cacheMisses: Counter;
  readonly invalidations: Counter;

  constructor(registry: Registry) {
    this.registry = registry;

    this.warmedUp = new Gauge({
      name: 'sprite_cache_warmed_up',
      help: 'Whether sprite cache has been warmed up',
      registers: [registry],
    });

    this.cacheSize = new Gauge({
      name: 'sprite_cache_size',
      help: 'Number of sprites in cache',
      labelNames: ['layer'],
      registers: [registry],
    });

    this.hitRate = new Gauge({
      name: 'sprite_cache_hit_rate',
      help: 'Cache hit rate',
      labelNames: ['layer'],
      registers: [registry],
    });

    this.warmupDuration = new Histogram({
      name: 'sprite_cache_warmup_duration_ms',
      help: 'Time to warmup cache',
      buckets: [100, 500, 1000, 5000, 10000, 30000],
      registers: [registry],
    });

    this.precompileDuration = new Histogram({
      name: 'sprite_precompile_duration_ms',
      help: 'Time to precompile a sprite',
      buckets: [1, 5, 10, 25, 50, 100],
      registers: [registry],
    });

    this.queryDuration = new Histogram({
      name: 'sprite_query_duration_ms',
      help: 'Time to query sprite data',
      labelNames: ['cache_result'],
      buckets: [0.1, 0.5, 1, 5, 10, 25],
      registers: [registry],
    });

    this.cacheHits = new Counter({
      name: 'sprite_cache_hits_total',
      help: 'Total cache hits',
      labelNames: ['layer'],
      registers: [registry],
    });

    this.cacheMisses = new Counter({
      name: 'sprite_cache_misses_total',
      help: 'Total cache misses',
      registers: [registry],
    });

    this.invalidations = new Counter({
      name: 'sprite_cache_invalidations_total',
      help: 'Total cache invalidations',
      labelNames: ['reason'],
      registers: [registry],
    });
  }
}
```

### 7. Grafana 仪表板

```json
{
  "title": "Sprite Cache Dashboard",
  "panels": [
    {
      "title": "Cache Hit Rate",
      "type": "gauge",
      "targets": [
        {
          "expr": "sprite_cache_hit_rate"
        }
      ],
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "value": 0, "color": "red" },
          { "value": 0.7, "color": "yellow" },
          { "value": 0.9, "color": "green" }
        ]
      }
    },
    {
      "title": "Cache Size by Layer",
      "type": "stat",
      "targets": [
        {
          "expr": "sprite_cache_size",
          "legendFormat": "{{layer}}"
        }
      ]
    },
    {
      "title": "Query Latency P99",
      "type": "graph",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, rate(sprite_query_duration_ms_bucket[5m]))",
          "legendFormat": "P99"
        }
      ]
    },
    {
      "title": "Cache Warmup Status",
      "type": "stat",
      "targets": [
        {
          "expr": "sprite_cache_warmed_up"
        }
      ]
    }
  ]
}
```

## 验收标准

- [ ] 服务启动时自动预热缓存，冷启动查询延迟 < 10ms
- [ ] 本地缓存 + Redis 两级缓存，缓存命中率 > 90%
- [ ] 预编译数据结构完整，包含基础属性/计算属性/关联数据
- [ ] 支持批量获取预编译数据，单次批量查询 100 个精灵 < 50ms
- [ ] 智能预加载准确率 > 80%，预加载命中率 > 60%
- [ ] 缓存失效后自动重新编译，增量更新不影响其他数据
- [ ] 管理后台提供缓存统计、手动预热、清空、重编译功能
- [ ] Prometheus 指标完整，包括命中率、延迟、大小等关键指标
- [ ] Grafana 仪表板可视化缓存状态和趋势
- [ ] 插值计算准确，误差 < 5%
- [ ] 压测验证：10000 QPS 下缓存命中率 > 95%，P99 延迟 < 20ms

## 影响范围

**新增文件：**
- `backend/shared/cache/src/sprite-precompiled/types.ts` - 类型定义
- `backend/shared/cache/src/sprite-precompiled/precompiled-cache-manager.ts` - 缓存管理器
- `backend/shared/cache/src/sprite-precompiled/stats-calculator.ts` - 属性计算引擎
- `backend/shared/cache/src/sprite-precompiled/metrics.ts` - 指标定义
- `backend/game-core/src/hooks/cache-warmup.hook.ts` - 启动预热钩子
- `backend/admin-dashboard/src/controllers/sprite-cache.controller.ts` - 管理 API
- `docs/grafana/dashboards/sprite-cache.json` - Grafana 仪表板

**修改文件：**
- `backend/shared/cache/src/index.ts` - 导出新模块
- `backend/game-core/src/game-core.module.ts` - 注册预热钩子
- `backend/catch-service/src/catch.service.ts` - 使用预编译缓存
- `backend/battle-service/src/battle.service.ts` - 使用预编译缓存
- `docker-compose.yml` - 添加缓存预热配置

## 参考

- [Redis Hash 数据结构最佳实践](https://redis.io/docs/data-types/hashes/)
- [LRU Cache 实现原理](https://github.com/isaacs/node-lru-cache)
- [Prometheus Histogram 使用指南](https://prometheus.io/docs/concepts/metric_types/#histogram)
- [NestJS 生命周期钩子](https://docs.nestjs.com/fundamentals/lifecycle-events)
- [精灵属性计算公式设计文档](/docs/design/sprite-stats-formula.md)
- [REQ-00340] 精灵数据预编译缓存原始需求（已创建）
