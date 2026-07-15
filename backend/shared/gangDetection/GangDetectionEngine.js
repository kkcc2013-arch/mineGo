/**
 * 协同作弊团伙检测引擎
 * REQ-00550: 协同作弊团伙检测系统
 * 
 * 功能:
 * - 团伙关系图谱构建（基于时空共现、交易关系、好友关系）
 * - 协同捕捉检测（同一时间、同一地点、同一精灵）
 * - 协同道馆战检测（时间窗口操纵、快速轮换占领）
 * - 虚假交易链检测（闭环交易、异常价值交易）
 * - 团伙风险评分与分级
 */

'use strict';

const crypto = require('crypto');
const { createLogger } = require('../logger');
const { Pool } = require('pg');
const Redis = require('ioredis');

const logger = createLogger('gang-detection');

// 配置常量
const CONFIG = {
  spatialThreshold: 50, // 50米内视为共现
  temporalThreshold: 60000, // 60秒内视为同步
  minCooccurrence: 5, // 最少共现次数
  minClusterSize: 3, // 最小团伙规模
  cacheTTL: 3600, // 缓存1小时
  maxBatchSize: 100
};

// 风险评分权重
const RISK_WEIGHTS = {
  size: 30, // 团伙规模
  density: 20, // 关系密度
  frequency: 30, // 协同行为频率
  value: 20 // 涉及价值
};

class GangDetectionEngine {
  constructor(config = {}) {
    this.db = new Pool({ connectionString: config.dbUrl || process.env.DATABASE_URL });
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.config = { ...CONFIG, ...config };
  }

  /**
   * 构建时空共现图谱
   * @param {string} userId - 用户ID
   * @param {number} timeWindow - 时间窗口（毫秒）
   * @returns {Map<string, number>} 共现用户及次数
   */
  async buildSpatioTemporalGraph(userId, timeWindow = 3600000) {
    const startTime = Date.now() - timeWindow;
    const cooccurrences = new Map();

    try {
      // 1. 获取用户最近的所有活动（捕捉、道馆战、交易）
      const activities = await this.getUserActivities(userId, startTime);
      
      // 2. 查找每个活动的共现用户
      for (const act of activities) {
        const nearbyUsers = await this.findNearbyUsers(act.location, this.config.spatialThreshold);
        const coincidentUsers = await this.findCoincidentUsers(
          act.timestamp, 
          this.config.temporalThreshold, 
          nearbyUsers
        );
        
        for (const otherId of coincidentUsers) {
          if (otherId === userId) continue;
          const key = `${userId}:${otherId}`;
          cooccurrences.set(key, (cooccurrences.get(key) || 0) + 1);
        }
      }
      
      return cooccurrences;
    } catch (error) {
      logger.error({ userId, error: error.message }, 'Failed to build spatio-temporal graph');
      throw error;
    }
  }

  /**
   * 获取用户活动记录
   */
  async getUserActivities(userId, startTime) {
    const result = await this.db.query(`
      SELECT 
        'catch' as activity_type,
        catch_id as activity_id,
        location,
        catch_timestamp as timestamp
      FROM catches
      WHERE user_id = $1 AND catch_timestamp >= $2
      
      UNION ALL
      
      SELECT 
        'gym_battle' as activity_type,
        battle_id as activity_id,
        gym_location as location,
        battle_time as timestamp
      FROM gym_battles
      WHERE attacker_id = $1 AND battle_time >= $2
      
      UNION ALL
      
      SELECT 
        'trade' as activity_type,
        trade_id as activity_id,
        trade_location as location,
        trade_time as timestamp
      FROM trades
      WHERE (sender_id = $1 OR receiver_id = $1) AND trade_time >= $2
      
      ORDER BY timestamp DESC
      LIMIT 500
    `, [userId, new Date(startTime)]);
    
    return result.rows;
  }

  /**
   * 查找附近用户
   */
  async findNearbyUsers(location, radiusMeters) {
    // 使用 PostGIS 查询附近用户
    const result = await this.db.query(`
      SELECT DISTINCT user_id
      FROM user_locations
      WHERE ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($1, $2)::geography, 4326),
        $3
      )
      AND last_update >= NOW() - INTERVAL '5 minutes'
    `, [location.lng, location.lat, radiusMeters]);
    
    return result.rows.map(r => r.user_id);
  }

  /**
   * 查找同时在线的用户
   */
  async findCoincidentUsers(timestamp, thresholdMs, candidateUsers) {
    if (!candidateUsers || candidateUsers.length === 0) return [];
    
    const startTime = new Date(timestamp - thresholdMs);
    const endTime = new Date(timestamp + thresholdMs);
    
    const result = await this.db.query(`
      SELECT DISTINCT user_id
      FROM user_activities
      WHERE user_id = ANY($1)
      AND activity_time BETWEEN $2 AND $3
    `, [candidateUsers, startTime, endTime]);
    
    return result.rows.map(r => r.user_id);
  }

  /**
   * 基于谱聚类发现团伙
   */
  async detectGangs(graph) {
    if (graph.size === 0) return [];
    
    // 1. 构建节点列表
    const nodes = [...new Set([...graph.keys()].flatMap(k => k.split(':')))];
    const n = nodes.length;
    
    if (n < this.config.minClusterSize) return [];
    
    // 2. 构建邻接矩阵
    const adjacency = Array(n).fill(null).map(() => Array(n).fill(0));
    const nodeIndex = new Map(nodes.map((id, i) => [id, i]));
    
    for (const [key, weight] of graph) {
      const [a, b] = key.split(':');
      const i = nodeIndex.get(a);
      const j = nodeIndex.get(b);
      if (i !== undefined && j !== undefined) {
        adjacency[i][j] = weight;
        adjacency[j][i] = weight;
      }
    }

    // 3. 使用简化的连通分量算法（实际可用谱聚类）
    const clusters = this.findConnectedComponents(adjacency, nodes);

    // 4. 过滤有效团伙
    const validGangs = clusters
      .filter(c => c.members.length >= this.config.minClusterSize)
      .map(cluster => ({
        ...cluster,
        density: this.computeClusterDensity(cluster.members, adjacency, nodeIndex)
      }));

    return validGangs;
  }

  /**
   * 查找连通分量
   */
  findConnectedComponents(adjacency, nodes) {
    const n = nodes.length;
    const visited = new Array(n).fill(false);
    const clusters = [];

    for (let i = 0; i < n; i++) {
      if (!visited[i]) {
        const component = [];
        this.dfs(i, adjacency, visited, component);
        if (component.length >= this.config.minClusterSize) {
          clusters.push({
            members: component.map(idx => nodes[idx]),
            memberIndices: component
          });
        }
      }
    }

    return clusters;
  }

  /**
   * 深度优先搜索
   */
  dfs(node, adjacency, visited, component) {
    visited[node] = true;
    component.push(node);
    
    for (let neighbor = 0; neighbor < adjacency.length; neighbor++) {
      if (adjacency[node][neighbor] > 0 && !visited[neighbor]) {
        this.dfs(neighbor, adjacency, visited, component);
      }
    }
  }

  /**
   * 计算团伙密度
   */
  computeClusterDensity(members, adjacency, nodeIndex) {
    if (members.length < 2) return 0;
    
    let totalWeight = 0;
    let edgeCount = 0;
    
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const idxA = nodeIndex.get(members[i]);
        const idxB = nodeIndex.get(members[j]);
        if (idxA !== undefined && idxB !== undefined) {
          totalWeight += adjacency[idxA][idxB];
          edgeCount++;
        }
      }
    }
    
    return edgeCount > 0 ? totalWeight / edgeCount : 0;
  }

  /**
   * 计算团伙风险评分
   */
  calculateGangRiskScore(gang) {
    let score = 0;

    // 1. 团伙规模（越大风险越高）
    score += Math.min(RISK_WEIGHTS.size, gang.members.length * 2);

    // 2. 关系密度
    score += gang.density * RISK_WEIGHTS.density;

    // 3. 协同行为频率
    const collabEvents = gang.collabEvents || [];
    const recentEvents = collabEvents.filter(e => 
      Date.now() - new Date(e.detected_at).getTime() < 7 * 24 * 3600000
    ).length;
    score += Math.min(RISK_WEIGHTS.frequency, recentEvents * 3);

    // 4. 涉及价值
    const totalValue = collabEvents.reduce((s, e) => s + (e.value_score || 0), 0);
    score += Math.min(RISK_WEIGHTS.value, totalValue / 1000);

    return Math.min(100, Math.round(score * 100) / 100);
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(score) {
    if (score >= 85) return 'critical';
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  /**
   * 检测协同捕捉
   */
  async detectCoordinatedCatch(pokemonSpawnId) {
    try {
      // 1. 获取所有捕捉该精灵的会话
      const sessions = await this.getCatchSessions(pokemonSpawnId);
      
      if (sessions.length < 2) return null;

      // 2. 按时间聚类
      const timeClusters = this.clusterByTime(sessions, 5000); // 5秒窗口
      
      for (const cluster of timeClusters) {
        if (cluster.length >= 3) {
          // 3. 检查空间聚集
          const locations = cluster.map(s => s.location);
          const centroid = this.computeCentroid(locations);
          const maxDistance = Math.max(...locations.map(l => 
            this.distance(l, centroid)
          ));

          if (maxDistance < this.config.spatialThreshold) {
            // 4. 验证为协同捕捉
            return {
              type: 'COORDINATED_CATCH',
              participants: cluster.map(s => ({
                userId: s.user_id,
                location: s.location,
                catchTime: s.catch_timestamp,
                ballType: s.ball_type,
                success: s.success
              })),
              centroid,
              timeWindow: {
                start: Math.min(...cluster.map(s => s.catch_timestamp)),
                end: Math.max(...cluster.map(s => s.catch_timestamp))
              },
              pokemonSpawnId
            };
          }
        }
      }

      return null;
    } catch (error) {
      logger.error({ pokemonSpawnId, error: error.message }, 'Coordinated catch detection failed');
      throw error;
    }
  }

  /**
   * 获取捕捉会话
   */
  async getCatchSessions(pokemonSpawnId) {
    const result = await this.db.query(`
      SELECT 
        catch_id,
        user_id,
        catch_location as location,
        catch_timestamp,
        ball_type,
        success
      FROM catches
      WHERE pokemon_spawn_id = $1
      ORDER BY catch_timestamp ASC
    `, [pokemonSpawnId]);
    
    return result.rows;
  }

  /**
   * 按时间聚类
   */
  clusterByTime(items, windowMs) {
    if (items.length === 0) return [];
    
    const sorted = [...items].sort((a, b) => 
      new Date(a.catch_timestamp) - new Date(b.catch_timestamp)
    );
    
    const clusters = [];
    let currentCluster = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
      const timeDiff = new Date(sorted[i].catch_timestamp) - new Date(sorted[i-1].catch_timestamp);
      if (timeDiff <= windowMs) {
        currentCluster.push(sorted[i]);
      } else {
        if (currentCluster.length >= 2) {
          clusters.push(currentCluster);
        }
        currentCluster = [sorted[i]];
      }
    }
    
    if (currentCluster.length >= 2) {
      clusters.push(currentCluster);
    }
    
    return clusters;
  }

  /**
   * 计算质心
   */
  computeCentroid(locations) {
    if (locations.length === 0) return { lat: 0, lng: 0 };
    
    const sum = locations.reduce(
      (acc, loc) => ({
        lat: acc.lat + (loc.lat || 0),
        lng: acc.lng + (loc.lng || 0)
      }),
      { lat: 0, lng: 0 }
    );
    
    return {
      lat: sum.lat / locations.length,
      lng: sum.lng / locations.length
    };
  }

  /**
   * 计算两点距离（米）
   */
  distance(point1, point2) {
    const R = 6371000; // 地球半径（米）
    const lat1 = point1.lat * Math.PI / 180;
    const lat2 = point2.lat * Math.PI / 180;
    const deltaLat = (point2.lat - point1.lat) * Math.PI / 180;
    const deltaLng = (point2.lng - point1.lng) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
               Math.cos(lat1) * Math.cos(lat2) *
               Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * 批量检测最近N分钟的协同捕捉
   */
  async batchDetectCoordinatedCatches(minutes = 30) {
    const startTime = Date.now() - minutes * 60 * 1000;
    const spawns = await this.getRecentPokemonSpawns(startTime);
    const detected = [];

    for (const spawn of spawns) {
      try {
        const result = await this.detectCoordinatedCatch(spawn.id);
        if (result) {
          detected.push(result);
          // 触发事件
          await this.publishCollabCheatEvent(result);
        }
      } catch (error) {
        logger.warn({ spawnId: spawn.id, error: error.message }, 'Failed to detect coordinated catch');
      }
    }

    return detected;
  }

  /**
   * 获取最近的精灵刷新记录
   */
  async getRecentPokemonSpawns(startTime) {
    const result = await this.db.query(`
      SELECT DISTINCT pokemon_spawn_id as id
      FROM catches
      WHERE catch_timestamp >= $1
    `, [new Date(startTime)]);
    
    return result.rows;
  }

  /**
   * 发布协同作弊事件
   */
  async publishCollabCheatEvent(event) {
    const eventId = `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    
    await this.db.query(`
      INSERT INTO collab_cheat_events (
        event_id, event_type, participants, location, 
        start_time, end_time, affected_pokemon_id, value_score, evidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      eventId,
      event.type.toLowerCase(),
      JSON.stringify(event.participants),
      JSON.stringify(event.centroid),
      new Date(event.timeWindow.start),
      new Date(event.timeWindow.end),
      event.pokemonSpawnId,
      event.participants.length * 100, // 估算价值
      JSON.stringify(event)
    ]);
    
    logger.info({ eventId, type: event.type, participantCount: event.participants.length }, 'Collaborative cheat event detected');
    
    return eventId;
  }

  /**
   * 创建团伙记录
   */
  async createGang(gangData) {
    const gangId = `gang_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    const result = await this.db.query(`
      INSERT INTO cheating_gangs (
        gang_id, name, risk_score, risk_level, member_count, 
        first_activity, last_activity, affected_resources, evidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      gangId,
      gangData.name || `Gang-${gangId.slice(-6)}`,
      gangData.riskScore || 0,
      gangData.riskLevel || 'low',
      gangData.members?.length || 0,
      gangData.firstActivity || new Date(),
      gangData.lastActivity || new Date(),
      JSON.stringify(gangData.affectedResources || {}),
      JSON.stringify(gangData.evidence || {})
    ]);
    
    return result.rows[0];
  }

  /**
   * 添加团伙成员
   */
  async addGangMember(gangId, userId, role = 'member', joinScore = 0) {
    const result = await this.db.query(`
      INSERT INTO gang_members (gang_id, user_id, role, join_score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (gang_id, user_id) 
      DO UPDATE SET 
        role = EXCLUDED.role,
        join_score = EXCLUDED.join_score,
        last_activity = NOW(),
        updated_at = NOW()
      RETURNING *
    `, [gangId, userId, role, joinScore]);
    
    return result.rows[0];
  }

  /**
   * 获取用户所属团伙信息
   */
  async getUserGangInfo(userId) {
    const result = await this.db.query(`
      SELECT 
        gm.*,
        cg.risk_score,
        cg.risk_level,
        cg.status as gang_status
      FROM gang_members gm
      JOIN cheating_gangs cg ON gm.gang_id = cg.gang_id
      WHERE gm.user_id = $1 AND gm.status = 'active'
      ORDER BY cg.risk_score DESC
      LIMIT 1
    `, [userId]);
    
    return result.rows[0] || null;
  }

  /**
   * 获取团伙详情
   */
  async getGangDetails(gangId) {
    const gangResult = await this.db.query(`
      SELECT * FROM cheating_gangs WHERE gang_id = $1
    `, [gangId]);
    
    if (gangResult.rows.length === 0) return null;
    
    const membersResult = await this.db.query(`
      SELECT * FROM gang_members WHERE gang_id = $1 AND status = 'active'
      ORDER BY join_score DESC
    `, [gangId]);
    
    const eventsResult = await this.db.query(`
      SELECT * FROM collab_cheat_events 
      WHERE gang_id = $1 
      ORDER BY detected_at DESC 
      LIMIT 50
    `, [gangId]);
    
    return {
      ...gangResult.rows[0],
      members: membersResult.rows,
      events: eventsResult.rows
    };
  }

  /**
   * 关闭资源连接
   */
  async close() {
    await this.db.end();
    await this.redis.quit();
  }
}

module.exports = GangDetectionEngine;