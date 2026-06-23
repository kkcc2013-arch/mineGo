# REQ-00295: 游戏资源预热与智能预加载系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00295 |
| 标题 | 游戏资源预热与智能预加载系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client, cdn, location-service, pokemon-service, backend/shared/cache |
| 创建时间 | 2026-06-23 10:00 |

## 需求描述

为 mineGo 游戏客户端实现智能资源预加载系统，通过分析用户行为模式、位置移动趋势和精灵分布预测，提前加载可能需要的游戏资源（精灵模型、音效、地图纹理等）。系统旨在减少游戏内资源加载延迟，提升用户体验流畅度，同时优化带宽使用效率。

### 核心目标

1. **行为预测**：基于用户历史行为预测下一步操作，提前加载相关资源
2. **位置感知预加载**：根据用户移动方向预测可能进入的区域，预加载该区域资源
3. **精灵分布预测**：预加载用户附近可能出现的高概率精灵资源
4. **网络自适应**：根据网络状况动态调整预加载策略
5. **存储管理**：智能管理本地缓存，自动清理过期或低优先级资源
6. **离线优先**：核心资源离线可用，减少网络依赖

### 用户场景

1. **地图探索预加载**：玩家向南行走时，预加载南方区域的地图纹理和地标资源
2. **精灵预加载**：进入水系精灵高概率区域前，预加载水系精灵模型和音效
3. **战斗资源预加载**：精灵战斗概率高的区域预加载战斗场景和技能特效
4. **社交资源预加载**：好友密集区域预加载好友头像和状态资源
5. **活动资源预加载**：活动开始前预加载活动相关资源和 UI 组件

## 技术方案

### 1. 资源预测引擎

```go
// backend/services/prediction/resource_predictor.go
package prediction

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type ResourcePredictor struct {
	redis           *redis.Client
	behaviorModel   *BehaviorModel
	locationService LocationServiceClient
	pokemonService  PokemonServiceClient
	config          *PredictorConfig
	mu              sync.RWMutex
}

type PredictorConfig struct {
	MaxPreloadResources   int           // 最大预加载数量
	PreloadRadius         float64       // 预加载半径（米）
	MinProbability        float64       // 最小预测概率阈值
	CacheTTL              time.Duration // 预测缓存 TTL
	HistoryWindow         time.Duration // 历史数据窗口
	NetworkAwareThreshold int           // 网络自适应阈值（KB/s）
}

type PredictionResult struct {
	UserID          string              `json:"user_id"`
	Location        GeoPoint            `json:"location"`
	PredictedMoves  []MovePrediction    `json:"predicted_moves"`
	PredictedAreas  []AreaPrediction    `json:"predicted_areas"`
	ResourceScores  []ResourceScore     `json:"resource_scores"`
	GeneratedAt     time.Time           `json:"generated_at"`
	ValidUntil      time.Time           `json:"valid_until"`
}

type MovePrediction struct {
	Direction    string    `json:"direction"`     // N, NE, E, SE, S, SW, W, NW
	Probability  float64   `json:"probability"`
	Distance     float64   `json:"distance"`      // 预测移动距离
	ArrivalTime  time.Time `json:"arrival_time"`  // 预计到达时间
}

type AreaPrediction struct {
	AreaID       string    `json:"area_id"`
	Center       GeoPoint  `json:"center"`
	Radius       float64   `json:"radius"`
	VisitProbability float64 `json:"visit_probability"`
	VisitTime    time.Time `json:"estimated_visit_time"`
	AreaType     string    `json:"area_type"` // park, gym, pokestop, water, forest
}

type ResourceScore struct {
	ResourceID   string    `json:"resource_id"`
	ResourceType string    `json:"resource_type"` // model, texture, audio, animation
	Priority     int       `json:"priority"`      // 1-10
	Probability  float64   `json:"probability"`
	Size         int64     `json:"size"`          // 字节
	URL          string    `json:"url"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type GeoPoint struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// PredictResources 预测用户需要的资源
func (p *ResourcePredictor) PredictResources(ctx context.Context, userID string, currentLocation GeoPoint) (*PredictionResult, error) {
	// 检查缓存
	cacheKey := p.getCacheKey(userID)
	cached, err := p.redis.Get(ctx, cacheKey).Result()
	if err == nil {
		var result PredictionResult
		if err := json.Unmarshal([]byte(cached), &result); err == nil {
			if result.ValidUntil.After(time.Now()) {
				return &result, nil
			}
		}
	}

	result := &PredictionResult{
		UserID:      userID,
		Location:    currentLocation,
		GeneratedAt: time.Now(),
		ValidUntil:  time.Now().Add(p.config.CacheTTL),
	}

	// 1. 预测移动方向
	result.PredictedMoves = p.predictMoves(ctx, userID, currentLocation)

	// 2. 预测访问区域
	result.PredictedAreas = p.predictAreas(ctx, userID, currentLocation, result.PredictedMoves)

	// 3. 计算资源优先级
	result.ResourceScores = p.calculateResourceScores(ctx, result.PredictedAreas)

	// 4. 缓存结果
	data, _ := json.Marshal(result)
	p.redis.Set(ctx, cacheKey, data, p.config.CacheTTL)

	return result, nil
}

// predictMoves 预测用户移动方向
func (p *ResourcePredictor) predictMoves(ctx context.Context, userID string, currentLocation GeoPoint) []MovePrediction {
	// 获取用户历史轨迹
	trajectory, err := p.behaviorModel.GetUserTrajectory(ctx, userID, p.config.HistoryWindow)
	if err != nil || len(trajectory) < 3 {
		// 新用户或数据不足，返回默认预测
		return p.getDefaultMovePredictions()
	}

	// 分析移动模式
	velocity := p.calculateVelocity(trajectory)
	direction := p.predictDirection(velocity)

	predictions := make([]MovePrediction, 0, 8)
	
	// 计算各方向概率
	directions := []string{"N", "NE", "E", "SE", "S", "SW", "W", "NW"}
	for _, dir := range directions {
		prob := p.calculateDirectionProbability(dir, direction, trajectory)
		if prob >= p.config.MinProbability {
			distance := p.predictDistance(velocity, prob)
			predictions = append(predictions, MovePrediction{
				Direction:    dir,
				Probability:  prob,
				Distance:     distance,
				ArrivalTime:  time.Now().Add(time.Duration(distance/velocity.Speed) * time.Second),
			})
		}
	}

	return predictions
}

// predictAreas 预测用户可能访问的区域
func (p *ResourcePredictor) predictAreas(ctx context.Context, userID string, location GeoPoint, moves []MovePrediction) []AreaPrediction {
	areas := make([]AreaPrediction, 0)
	
	// 当前位置附近区域
	nearbyAreas := p.getNearbyAreas(ctx, location, p.config.PreloadRadius)
	for _, area := range nearbyAreas {
		prob := p.calculateAreaVisitProbability(ctx, userID, area)
		if prob >= p.config.MinProbability {
			areas = append(areas, AreaPrediction{
				AreaID:           area.ID,
				Center:           area.Center,
				Radius:           area.Radius,
				VisitProbability: prob,
				VisitTime:        time.Now().Add(time.Duration(area.Distance/1.5) * time.Second),
				AreaType:         area.Type,
			})
		}
	}

	// 预测移动方向的目标区域
	for _, move := range moves {
		targetLocation := p.calculateTargetLocation(location, move.Direction, move.Distance)
		targetAreas := p.getNearbyAreas(ctx, targetLocation, p.config.PreloadRadius*0.5)
		
		for _, area := range targetAreas {
			prob := move.Probability * p.calculateAreaVisitProbability(ctx, userID, area)
			if prob >= p.config.MinProbability {
				areas = append(areas, AreaPrediction{
					AreaID:           area.ID,
					Center:           area.Center,
					Radius:           area.Radius,
					VisitProbability: prob,
					VisitTime:        move.ArrivalTime,
					AreaType:         area.Type,
				})
			}
		}
	}

	return p.deduplicateAreas(areas)
}

// calculateResourceScores 计算资源优先级
func (p *ResourcePredictor) calculateResourceScores(ctx context.Context, areas []AreaPrediction) []ResourceScore {
	scores := make([]ResourceScore, 0)
	resourceMap := make(map[string]*ResourceScore)

	for _, area := range areas {
		// 获取区域相关资源
		areaResources := p.getAreaResources(ctx, area)
		
		for _, res := range areaResources {
			existing, found := resourceMap[res.ResourceID]
			if found {
				// 更新优先级（取更高值）
				if int(area.VisitProbability*10) > existing.Priority {
					existing.Priority = int(area.VisitProbability * 10)
				}
				// 累加概率
				existing.Probability = math.Max(existing.Probability, area.VisitProbability)
			} else {
				resourceMap[res.ResourceID] = &ResourceScore{
					ResourceID:   res.ResourceID,
					ResourceType: res.ResourceType,
					Priority:     int(area.VisitProbability * 10),
					Probability:  area.VisitProbability,
					Size:         res.Size,
					URL:          res.URL,
					ExpiresAt:    time.Now().Add(p.config.CacheTTL),
				}
			}
		}
	}

	// 按优先级排序
	for _, score := range resourceMap {
		if score.Priority >= 3 { // 只返回优先级 >= 3 的资源
			scores = append(scores, *score)
		}
	}

	// 限制数量
	if len(scores) > p.config.MaxPreloadResources {
		scores = scores[:p.config.MaxPreloadResources]
	}

	return scores
}
```

### 2. 行为模型分析器

```go
// backend/services/prediction/behavior_model.go
package prediction

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

type BehaviorModel struct {
	redis *redis.Client
}

type UserTrajectory struct {
	UserID    string        `json:"user_id"`
	Points    []TrajectoryPoint `json:"points"`
	StartTime time.Time     `json:"start_time"`
	EndTime   time.Time     `json:"end_time"`
}

type TrajectoryPoint struct {
	Location   GeoPoint  `json:"location"`
	Timestamp  time.Time `json:"timestamp"`
	Speed      float64   `json:"speed"`
	Heading    float64   `json:"heading"` // 方向角度 0-360
	Activity   string    `json:"activity"` // walking, running, stationary
}

type Velocity struct {
	Speed   float64 `json:"speed"`   // 米/秒
	Heading float64 `json:"heading"` // 方向角度
	Bearing float64 `json:"bearing"` // 航向变化率
}

// GetUserTrajectory 获取用户历史轨迹
func (b *BehaviorModel) GetUserTrajectory(ctx context.Context, userID string, window time.Duration) (*UserTrajectory, error) {
	key := "trajectory:" + userID
	
	// 获取时间窗口内的轨迹点
	points, err := b.redis.ZRangeByScore(ctx, key, &redis.ZRangeBy{
		Min:   fmt.Sprintf("%d", time.Now().Add(-window).Unix()),
		Max:   fmt.Sprintf("%d", time.Now().Unix()),
	}).Result()
	if err != nil {
		return nil, err
	}

	trajectory := &UserTrajectory{
		UserID:    userID,
		StartTime: time.Now().Add(-window),
		EndTime:   time.Now(),
	}

	for _, point := range points {
		var tp TrajectoryPoint
		if err := json.Unmarshal([]byte(point), &tp); err == nil {
			trajectory.Points = append(trajectory.Points, tp)
		}
	}

	return trajectory, nil
}

// RecordTrajectoryPoint 记录轨迹点
func (b *BehaviorModel) RecordTrajectoryPoint(ctx context.Context, userID string, point TrajectoryPoint) error {
	key := "trajectory:" + userID
	
	data, err := json.Marshal(point)
	if err != nil {
		return err
	}

	// 添加轨迹点
	member := &redis.Z{
		Score:  float64(point.Timestamp.Unix()),
		Member: string(data),
	}
	
	if err := b.redis.ZAdd(ctx, key, member).Err(); err != nil {
		return err
	}

	// 清理过期数据（保留最近2小时）
	b.redis.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", time.Now().Add(-2*time.Hour).Unix()))

	return nil
}

// calculateVelocity 计算移动速度和方向
func (b *BehaviorModel) calculateVelocity(trajectory *UserTrajectory) *Velocity {
	if len(trajectory.Points) < 2 {
		return &Velocity{Speed: 0, Heading: 0, Bearing: 0}
	}

	// 使用最近几个点计算
	recentPoints := trajectory.Points
	if len(recentPoints) > 5 {
		recentPoints = recentPoints[len(recentPoints)-5:]
	}

	// 计算平均速度
	totalSpeed := 0.0
	for _, p := range recentPoints {
		totalSpeed += p.Speed
	}
	avgSpeed := totalSpeed / float64(len(recentPoints))

	// 计算方向（使用最近的点）
	lastPoint := recentPoints[len(recentPoints)-1]
	heading := lastPoint.Heading

	// 计算航向变化率
	bearing := 0.0
	if len(recentPoints) >= 3 {
		prevHeading := recentPoints[len(recentPoints)-2].Heading
		bearing = math.Mod(lastPoint.Heading-prevHeading+360, 360)
		if bearing > 180 {
			bearing = bearing - 360
		}
	}

	return &Velocity{
		Speed:   avgSpeed,
		Heading: heading,
		Bearing: bearing,
	}
}

// AnalyzeUserPatterns 分析用户行为模式
func (b *BehaviorModel) AnalyzeUserPatterns(ctx context.Context, userID string) (*UserBehaviorPattern, error) {
	// 获取最近7天的行为数据
	trajectory, err := b.GetUserTrajectory(ctx, userID, 7*24*time.Hour)
	if err != nil {
		return nil, err
	}

	pattern := &UserBehaviorPattern{
		UserID:    userID,
		AnalyzedAt: time.Now(),
	}

	// 分析常用路径
	pattern.CommonPaths = b.analyzeCommonPaths(trajectory)

	// 分析活跃时段
	pattern.ActiveHours = b.analyzeActiveHours(trajectory)

	// 分析常访问区域
	pattern.FrequentAreas = b.analyzeFrequentAreas(trajectory)

	// 分析精灵偏好
	pattern.PokemonPreferences = b.analyzePokemonPreferences(ctx, userID)

	return pattern, nil
}

type UserBehaviorPattern struct {
	UserID             string              `json:"user_id"`
	CommonPaths        []CommonPath        `json:"common_paths"`
	ActiveHours        []ActiveHour        `json:"active_hours"`
	FrequentAreas      []FrequentArea      `json:"frequent_areas"`
	PokemonPreferences []PokemonPreference `json:"pokemon_preferences"`
	AnalyzedAt         time.Time           `json:"analyzed_at"`
}

type CommonPath struct {
	StartLocation GeoPoint `json:"start_location"`
	EndLocation   GeoPoint `json:"end_location"`
	Frequency     int      `json:"frequency"`
	AvgDuration   int      `json:"avg_duration_seconds"`
}

type ActiveHour struct {
	Hour       int     `json:"hour"`
	Activity   float64 `json:"activity"` // 0-1 活跃度
	DayOfWeek  int     `json:"day_of_week"` // 0=Sunday
}

type FrequentArea struct {
	AreaID     string  `json:"area_id"`
	VisitCount int     `json:"visit_count"`
	LastVisit  time.Time `json:"last_visit"`
	AvgDuration int     `json:"avg_duration_minutes"`
}

type PokemonPreference struct {
	PokemonType string  `json:"pokemon_type"`
	CatchCount  int     `json:"catch_count"`
	SuccessRate float64 `json:"success_rate"`
}
```

### 3. 客户端预加载管理器

```typescript
// game-client/src/core/preload/PreloadManager.ts

export interface PreloadConfig {
  maxConcurrentPreloads: number;
  maxCacheSize: number; // MB
  preloadRadius: number; // meters
  minNetworkSpeed: number; // KB/s
  idleTimeout: number; // ms
}

export interface PreloadTask {
  resourceId: string;
  resourceType: 'model' | 'texture' | 'audio' | 'animation' | 'config';
  url: string;
  priority: number;
  probability: number;
  size: number;
  status: 'pending' | 'loading' | 'loaded' | 'failed' | 'expired';
  loadedAt?: Date;
  error?: string;
}

export class PreloadManager {
  private config: PreloadConfig;
  private cache: ResourceCache;
  private queue: PriorityQueue<PreloadTask>;
  private activeTasks: Map<string, PreloadTask>;
  private networkMonitor: NetworkMonitor;
  private locationTracker: LocationTracker;
  private behaviorTracker: BehaviorTracker;
  private isPreloading: boolean;

  constructor(config: PreloadConfig) {
    this.config = config;
    this.cache = new ResourceCache(config.maxCacheSize);
    this.queue = new PriorityQueue((a, b) => b.priority - a.priority);
    this.activeTasks = new Map();
    this.networkMonitor = new NetworkMonitor();
    this.locationTracker = new LocationTracker();
    this.behaviorTracker = new BehaviorTracker();
    this.isPreloading = false;
  }

  /**
   * 启动预加载服务
   */
  async start(): Promise<void> {
    this.isPreloading = true;

    // 监听位置变化
    this.locationTracker.on('locationUpdate', (location: GeoPoint) => {
      this.onLocationUpdate(location);
    });

    // 监听网络状态变化
    this.networkMonitor.on('networkChange', (status: NetworkStatus) => {
      this.onNetworkChange(status);
    });

    // 定期刷新预测
    setInterval(() => this.refreshPredictions(), 30000); // 每30秒

    // 启动加载队列处理
    this.processQueue();
  }

  /**
   * 位置更新时触发预测
   */
  private async onLocationUpdate(location: GeoPoint): Promise<void> {
    // 记录轨迹点
    this.behaviorTracker.recordTrajectoryPoint({
      location,
      timestamp: new Date(),
      speed: this.locationTracker.getSpeed(),
      heading: this.locationTracker.getHeading(),
      activity: this.locationTracker.getActivity(),
    });

    // 请求预测
    try {
      const prediction = await this.fetchPrediction(location);
      this.updatePreloadQueue(prediction);
    } catch (error) {
      console.error('Failed to fetch prediction:', error);
    }
  }

  /**
   * 获取资源预测
   */
  private async fetchPrediction(location: GeoPoint): Promise<PredictionResult> {
    const response = await fetch('/api/v1/prediction/resources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location,
        cachedResources: this.cache.getResourceIds(),
      }),
    });

    if (!response.ok) {
      throw new Error('Prediction request failed');
    }

    return response.json();
  }

  /**
   * 更新预加载队列
   */
  private updatePreloadQueue(prediction: PredictionResult): void {
    const networkStatus = this.networkMonitor.getStatus();
    
    for (const resource of prediction.resourceScores) {
      // 检查是否已缓存
      if (this.cache.has(resource.resourceId)) {
        continue;
      }

      // 检查是否已在队列或加载中
      if (this.queue.has(resource.resourceId) || this.activeTasks.has(resource.resourceId)) {
        continue;
      }

      // 网络自适应：低网速时降低预加载数量
      if (networkStatus.speed < this.config.minNetworkSpeed && resource.priority < 7) {
        continue;
      }

      // 添加到队列
      const task: PreloadTask = {
        resourceId: resource.resourceId,
        resourceType: resource.resourceType as any,
        url: resource.url,
        priority: resource.priority,
        probability: resource.probability,
        size: resource.size,
        status: 'pending',
      };

      this.queue.enqueue(task);
    }

    // 触发队列处理
    this.processQueue();
  }

  /**
   * 处理加载队列
   */
  private async processQueue(): Promise<void> {
    if (!this.isPreloading) return;

    // 检查并发限制
    while (this.activeTasks.size < this.config.maxConcurrentPreloads && !this.queue.isEmpty()) {
      const task = this.queue.dequeue();
      if (!task) break;

      // 检查缓存空间
      if (!this.cache.canAllocate(task.size)) {
        this.cache.evictLowPriority();
      }

      // 开始加载
      this.loadResource(task);
    }
  }

  /**
   * 加载资源
   */
  private async loadResource(task: PreloadTask): Promise<void> {
    task.status = 'loading';
    this.activeTasks.set(task.resourceId, task);

    try {
      const startTime = Date.now();

      // 根据资源类型选择加载器
      let data: any;
      switch (task.resourceType) {
        case 'model':
          data = await this.loadModel(task.url);
          break;
        case 'texture':
          data = await this.loadTexture(task.url);
          break;
        case 'audio':
          data = await this.loadAudio(task.url);
          break;
        case 'animation':
          data = await this.loadAnimation(task.url);
          break;
        case 'config':
          data = await this.loadConfig(task.url);
          break;
      }

      // 存入缓存
      this.cache.set(task.resourceId, {
        data,
        type: task.resourceType,
        size: task.size,
        priority: task.priority,
        loadedAt: new Date(),
      });

      task.status = 'loaded';
      task.loadedAt = new Date();

      // 记录加载统计
      this.recordLoadStats(task, Date.now() - startTime);

    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
      console.error(`Failed to preload ${task.resourceId}:`, error);

      // 失败重试（低优先级）
      if (task.priority >= 5) {
        task.status = 'pending';
        task.priority -= 2;
        this.queue.enqueue(task);
      }
    } finally {
      this.activeTasks.delete(task.resourceId);
      this.processQueue();
    }
  }

  /**
   * 网络状态变化处理
   */
  private onNetworkChange(status: NetworkStatus): void {
    if (status.type === 'cellular' && status.expensive) {
      // 移动网络且费用高时，暂停低优先级预加载
      this.queue.filter(task => task.priority >= 7);
    }

    if (status.type === 'wifi') {
      // WiFi 下恢复预加载
      this.processQueue();
    }
  }

  /**
   * 获取预加载统计
   */
  getStats(): PreloadStats {
    return {
      totalPreloaded: this.cache.size(),
      cacheHitRate: this.cache.getHitRate(),
      activeTasks: this.activeTasks.size,
      pendingTasks: this.queue.size(),
      cacheSize: this.cache.getUsedSize(),
      networkStatus: this.networkMonitor.getStatus(),
    };
  }
}

/**
 * 资源缓存管理
 */
class ResourceCache {
  private maxSize: number;
  private usedSize: number;
  private entries: Map<string, CacheEntry>;

  constructor(maxSize: number) {
    this.maxSize = maxSize * 1024 * 1024; // MB to bytes
    this.usedSize = 0;
    this.entries = new Map();
  }

  set(id: string, entry: CacheEntry): void {
    // 检查空间
    while (this.usedSize + entry.size > this.maxSize && this.entries.size > 0) {
      this.evictLowPriority();
    }

    this.entries.set(id, entry);
    this.usedSize += entry.size;
  }

  get(id: string): CacheEntry | null {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastAccess = new Date();
      return entry;
    }
    return null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  canAllocate(size: number): boolean {
    return this.usedSize + size <= this.maxSize;
  }

  evictLowPriority(): void {
    // 找到最低优先级且最久未访问的条目
    let minPriority = Infinity;
    let oldestAccess = new Date();
    let evictKey: string | null = null;

    for (const [key, entry] of this.entries) {
      if (entry.priority < minPriority || 
          (entry.priority === minPriority && entry.lastAccess < oldestAccess)) {
        minPriority = entry.priority;
        oldestAccess = entry.lastAccess;
        evictKey = key;
      }
    }

    if (evictKey) {
      const entry = this.entries.get(evictKey);
      this.usedSize -= entry.size;
      this.entries.delete(evictKey);
    }
  }
}
```

### 4. 网络自适应加载策略

```typescript
// game-client/src/core/preload/NetworkAwareLoader.ts

export interface NetworkStatus {
  type: 'wifi' | 'cellular' | 'unknown';
  speed: number; // KB/s
  expensive: boolean; // 是否为计费网络
  metered: boolean; // 是否为受限网络
}

export class NetworkAwareLoader {
  private currentStatus: NetworkStatus;
  private speedHistory: number[];
  private listeners: Set<(status: NetworkStatus) => void>;

  constructor() {
    this.currentStatus = {
      type: 'unknown',
      speed: 0,
      expensive: false,
      metered: false,
    };
    this.speedHistory = [];
    this.listeners = new Set();
    this.startMonitoring();
  }

  private startMonitoring(): void {
    // 使用 Network Information API
    if ('connection' in navigator) {
      const connection = (navigator as any).connection;
      
      connection.addEventListener('change', () => {
        this.updateStatus(connection);
      });

      this.updateStatus(connection);
    }

    // 定期测量实际速度
    setInterval(() => this.measureSpeed(), 10000);
  }

  private async measureSpeed(): Promise<void> {
    try {
      const startTime = Date.now();
      const response = await fetch('/api/v1/network/test', {
        method: 'HEAD',
        cache: 'no-store',
      });
      const endTime = Date.now();

      // 计算速度（使用已知大小的测试文件）
      const testSize = 1024; // 1KB test file
      const duration = (endTime - startTime) / 1000; // seconds
      const speed = (testSize / duration) / 1024; // KB/s

      // 平滑速度计算
      this.speedHistory.push(speed);
      if (this.speedHistory.length > 10) {
        this.speedHistory.shift();
      }

      const avgSpeed = this.speedHistory.reduce((a, b) => a + b, 0) / this.speedHistory.length;
      
      this.currentStatus.speed = avgSpeed;
      this.notifyListeners();
    } catch (error) {
      // 忽略测量错误
    }
  }

  private updateStatus(connection: any): void {
    this.currentStatus = {
      type: connection.type || 'unknown',
      speed: connection.downlink * 1000 || 0, // Mbps to KB/s
      expensive: connection.saveData || false,
      metered: connection.metered || false,
    };

    this.notifyListeners();
  }

  /**
   * 根据网络状态调整加载策略
   */
  getLoadStrategy(): LoadStrategy {
    const { type, speed, expensive, metered } = this.currentStatus;

    if (type === 'wifi' && !metered) {
      return {
        maxPreloadResources: 50,
        maxResourceSize: 10 * 1024 * 1024, // 10MB
        preloadPriority: 1, // 所有资源
        batchSize: 5,
        delayBetweenBatches: 0,
      };
    }

    if (type === 'cellular' && expensive) {
      return {
        maxPreloadResources: 10,
        maxResourceSize: 1 * 1024 * 1024, // 1MB
        preloadPriority: 7, // 仅高优先级
        batchSize: 2,
        delayBetweenBatches: 2000, // 2s
      };
    }

    if (speed < 500) { // 低速网络
      return {
        maxPreloadResources: 15,
        maxResourceSize: 2 * 1024 * 1024,
        preloadPriority: 5,
        batchSize: 2,
        delayBetweenBatches: 1000,
      };
    }

    // 默认策略
    return {
      maxPreloadResources: 30,
      maxResourceSize: 5 * 1024 * 1024,
      preloadPriority: 3,
      batchSize: 3,
      delayBetweenBatches: 500,
    };
  }
}
```

### 5. API 接口设计

```go
// backend/services/prediction/handler.go
package prediction

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type PredictionHandler struct {
	predictor *ResourcePredictor
}

// PredictResources godoc
// @Summary 获取资源预加载预测
// @Description 根据用户位置和行为预测需要预加载的资源
// @Tags prediction
// @Accept json
// @Produce json
// @Param request body PredictRequest true "预测请求"
// @Success 200 {object} PredictionResult
// @Router /api/v1/prediction/resources [post]
func (h *PredictionHandler) PredictResources(c *gin.Context) {
	var req PredictRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	userID := c.GetString("user_id")

	result, err := h.predictor.PredictResources(c.Request.Context(), userID, req.Location)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "prediction failed"})
		return
	}

	c.JSON(http.StatusOK, result)
}

type PredictRequest struct {
	Location        GeoPoint  `json:"location" binding:"required"`
	CachedResources []string  `json:"cached_resources"`
}

// RecordBehavior godoc
// @Summary 记录用户行为
// @Description 记录用户位置和操作行为用于预测
// @Tags prediction
// @Accept json
// @Produce json
// @Param request body RecordBehaviorRequest true "行为记录请求"
// @Success 200 {object} map[string]interface{}
// @Router /api/v1/prediction/behavior [post]
func (h *PredictionHandler) RecordBehavior(c *gin.Context) {
	var req RecordBehaviorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	userID := c.GetString("user_id")

	// 记录轨迹点
	if req.Trajectory != nil {
		h.predictor.behaviorModel.RecordTrajectoryPoint(c.Request.Context(), userID, *req.Trajectory)
	}

	// 记录操作行为
	if req.Action != nil {
		h.predictor.RecordUserAction(c.Request.Context(), userID, req.Action)
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

type RecordBehaviorRequest struct {
	Trajectory *TrajectoryPoint `json:"trajectory,omitempty"`
	Action     *UserAction      `json:"action,omitempty"`
}

type UserAction struct {
	ActionType string    `json:"action_type"` // catch, battle, visit, trade
	TargetId   string    `json:"target_id"`
	Location   GeoPoint  `json:"location"`
	Timestamp  time.Time `json:"timestamp"`
}
```

## 验收标准

- [ ] 预测 API 响应时间 < 100ms（P95）
- [ ] 资源预测准确率 >= 70%（用户实际访问与预加载匹配）
- [ ] 客户端缓存命中率 >= 60%
- [ ] 预加载不影响主线程帧率（FPS >= 55）
- [ ] 低速网络下预加载暂停或降级
- [ ] WiFi 下可预加载 >= 30 个资源
- [ ] 缓存自动清理机制正常工作
- [ ] 网络状态切换响应时间 < 1s
- [ ] 资源加载失败自动重试
- [ ] 支持 3 种以上资源类型预加载（model, texture, audio）

## 影响范围

### 新增文件
- `backend/services/prediction/` - 预测服务
- `backend/services/prediction/resource_predictor.go`
- `backend/services/prediction/behavior_model.go`
- `backend/services/prediction/handler.go`
- `game-client/src/core/preload/PreloadManager.ts`
- `game-client/src/core/preload/NetworkAwareLoader.ts`
- `game-client/src/core/preload/ResourceCache.ts`

### 修改文件
- `game-client/src/core/LocationTracker.ts` - 添加轨迹记录
- `backend/gateway/routes.go` - 添加预测 API 路由
- `infrastructure/k8s/prediction-service.yaml` - 部署配置

## 参考

- [Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation)
- [Service Worker Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
- [Cache-Control Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)
- [Resource Hints](https://www.w3.org/TR/resource-hints/)
- [Prefetch, Preload, Preconnect](https://web.dev/preload-prefetch-and-priorities/)
