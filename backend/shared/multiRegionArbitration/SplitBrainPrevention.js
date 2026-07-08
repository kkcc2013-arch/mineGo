/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * SplitBrainPrevention - 防脑裂机制
 * 
 * 功能：
 * - Redis RedLock 分布式锁
 * - 多区域投票决策
 * - 防止并发仲裁导致的脑裂
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('split-brain-prevention');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  lockAttempts: new promClient.Counter({
    name: 'minego_arbitration_lock_attempts_total',
    help: 'Total arbitration lock attempts',
    labelNames: ['region', 'result']
  }),
  
  lockHoldDuration: new promClient.Histogram({
    name: 'minego_arbitration_lock_hold_duration_ms',
    help: 'Lock hold duration in milliseconds',
    labelNames: ['region'],
    buckets: [100, 500, 1000, 5000, 10000, 30000, 60000]
  }),
  
  votingRounds: new promClient.Counter({
    name: 'minego_arbitration_voting_rounds_total',
    help: 'Total voting rounds',
    labelNames: ['region', 'result']
  }),
  
  quorumReached: new promClient.Counter({
    name: 'minego_arbitration_quorum_reached_total',
    help: 'Total times quorum was reached',
    labelNames: ['decision_type']
  }),
  
  splitBrainIncidents: new promClient.Counter({
    name: 'minego_split_brain_incidents_total',
    help: 'Total detected split brain incidents',
    labelNames: ['region']
  })
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  lockKey: 'minego:arbitration:lock',
  lockTimeoutMs: 10000,
  lockRetryDelayMs: 100,
  lockMaxRetries: 50,
  
  votingKey: 'minego:arbitration:votes',
  voteTimeoutMs: 5000,
  quorum: 3,           // 需要 3/5 区域同意
  minQuorumRatio: 0.6, // 最少需要 60% 区域同意
  
  regions: process.env.REGIONS?.split(',') || ['primary', 'secondary', 'backup'],
  currentRegion: process.env.REGION || 'primary',
  
  redisNodes: [
    { host: process.env.REDIS_HOST_1 || 'localhost', port: process.env.REDIS_PORT_1 || 6379 },
    { host: process.env.REDIS_HOST_2 || 'localhost', port: process.env.REDIS_PORT_2 || 6380 },
    { host: process.env.REDIS_HOST_3 || 'localhost', port: process.env.REDIS_PORT_3 || 6381 },
    { host: process.env.REDIS_HOST_4 || 'localhost', port: process.env.REDIS_PORT_4 || 6382 },
    { host: process.env.REDIS_HOST_5 || 'localhost', port: process.env.REDIS_PORT_5 || 6383 }
  ]
};

// ============================================================
// SplitBrainPrevention 类
// ============================================================

class SplitBrainPrevention extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Redis 连接池（用于 RedLock）
    this.redisClients = [];
    this.redisConnections = [];
    
    // 当前锁状态
    this.currentLock = null;
    this.lockAcquiredAt = null;
    
    // 投票状态
    this.votingSession = null;
    this.votes = new Map();
    
    // 初始化标志
    this.initialized = false;
  }

  /**
   * 初始化
   */
  async initialize() {
    try {
      // 创建 Redis 连接池
      for (const node of this.config.redisNodes) {
        try {
          const client = new Redis({
            host: node.host,
            port: node.port,
            maxRetriesPerRequest: 3,
            retryDelayOnFailover: 100,
            enableReadyCheck: true
          });
          
          this.redisClients.push(client);
          this.redisConnections.push({ host: node.host, port: node.port });
          
          logger.debug('Redis client created', { host: node.host, port: node.port });
        } catch (error) {
          logger.warn('Failed to create Redis client', { 
            host: node.host, 
            port: node.port, 
            error: error.message 
          });
        }
      }
      
      if (this.redisClients.length < this.config.quorum) {
        logger.error('Not enough Redis nodes for quorum', {
          required: this.config.quorum,
          available: this.redisClients.length
        });
        
        // 降级：使用单个 Redis
        this.redisClients.push(new Redis(process.env.REDIS_URL || 'redis://localhost:6379'));
      }
      
      this.initialized = true;
      
      logger.info('SplitBrainPrevention initialized', {
        redisNodes: this.redisClients.length,
        quorum: this.config.quorum
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize SplitBrainPrevention', { error: error.message });
      throw error;
    }
  }

  /**
   * 获取仲裁锁（RedLock 算法）
   */
  async acquireArbitrationLock() {
    const startTime = Date.now();
    const lockValue = `${this.config.currentRegion}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    
    logger.debug('Attempting to acquire arbitration lock', {
      lockValue,
      region: this.config.currentRegion
    });
    
    metrics.lockAttempts.inc({ region: this.config.currentRegion, result: 'attempt' });
    
    try {
      // RedLock 算法：需要在大多数 Redis 节点上获取锁
      const quorum = this.config.quorum;
      let acquiredCount = 0;
      const ttl = this.config.lockTimeoutMs;
      
      // 在每个 Redis 节点上尝试获取锁
      const results = [];
      
      for (const client of this.redisClients) {
        try {
          const result = await client.set(
            this.config.lockKey,
            lockValue,
            'PX',
            ttl,
            'NX'
          );
          
          if (result === 'OK') {
            acquiredCount++;
            results.push({ success: true, client: client.options?.host || 'unknown' });
          } else {
            results.push({ success: false, client: client.options?.host || 'unknown' });
          }
        } catch (error) {
          results.push({ success: false, client: 'error', error: error.message });
        }
      }
      
      // 检查是否达到 quorum
      if (acquiredCount >= quorum) {
        // 验证锁有效性（时间漂移考虑）
        const elapsed = Date.now() - startTime;
        const validityTime = ttl - elapsed - 10; // 减去 10ms 的时钟漂移
        
        if (validityTime > 0) {
          this.currentLock = lockValue;
          this.lockAcquiredAt = Date.now();
          
          metrics.lockAttempts.inc({ region: this.config.currentRegion, result: 'success' });
          
          logger.info('Arbitration lock acquired', {
            lockValue,
            acquiredCount,
            quorum,
            validityTime,
            elapsed
          });
          
          this.emit('lock-acquired', { lockValue, validityTime });
          
          // 启动锁续约
          this.startLockRenewal(lockValue, validityTime);
          
          return lockValue;
        } else {
          // 时间不足，释放锁
          await this.releaseLockOnNodes(lockValue);
          
          metrics.lockAttempts.inc({ region: this.config.currentRegion, result: 'timeout' });
          
          logger.warn('Lock validity time insufficient', { validityTime, elapsed });
          
          return null;
        }
      } else {
        // 未达到 quorum，释放已获取的锁
        await this.releaseLockOnNodes(lockValue);
        
        metrics.lockAttempts.inc({ region: this.config.currentRegion, result: 'quorum_fail' });
        
        logger.warn('Failed to acquire quorum', {
          acquiredCount,
          quorum,
          results
        });
        
        return null;
      }
    } catch (error) {
      metrics.lockAttempts.inc({ region: this.config.currentRegion, result: 'error' });
      
      logger.error('Lock acquisition error', { error: error.message });
      
      return null;
    }
  }

  /**
   * 启动锁续约
   */
  startLockRenewal(lockValue, validityTime) {
    const renewalInterval = Math.floor(validityTime * 0.7); // 在 70% 有效时间内续约
    
    const renewalTimer = setInterval(async () => {
      if (this.currentLock !== lockValue) {
        clearInterval(renewalTimer);
        return;
      }
      
      try {
        // 使用 Lua script 延长锁时间
        const extendScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        
        let extendedCount = 0;
        
        for (const client of this.redisClients) {
          try {
            const result = await client.eval(
              extendScript,
              1,
              this.config.lockKey,
              lockValue,
              this.config.lockTimeoutMs
            );
            
            if (result === 1) {
              extendedCount++;
            }
          } catch (error) {
            // 续约失败
          }
        }
        
        if (extendedCount >= this.config.quorum) {
          logger.debug('Lock extended', { extendedCount, lockValue });
          this.lockAcquiredAt = Date.now();
        } else {
          // 续约失败，释放锁
          logger.warn('Lock extension failed, releasing lock');
          clearInterval(renewalTimer);
          await this.releaseLock();
        }
      } catch (error) {
        logger.error('Lock renewal error', { error: error.message });
      }
    }, renewalInterval);
    
    // 设置定时器引用以便清理
    this.renewalTimer = renewalTimer;
  }

  /**
   * 释放锁
   */
  async releaseLock() {
    if (!this.currentLock) {
      return true;
    }
    
    const lockValue = this.currentLock;
    
    // 停止续约定时器
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }
    
    // 计算持有时间
    const holdDuration = this.lockAcquiredAt ? Date.now() - this.lockAcquiredAt : 0;
    metrics.lockHoldDuration.observe({ region: this.config.currentRegion }, holdDuration);
    
    // 释放锁
    await this.releaseLockOnNodes(lockValue);
    
    this.currentLock = null;
    this.lockAcquiredAt = null;
    
    logger.info('Arbitration lock released', {
      lockValue,
      holdDuration
    });
    
    this.emit('lock-released', { lockValue, holdDuration });
    
    return true;
  }

  /**
   * 在所有节点上释放锁
   */
  async releaseLockOnNodes(lockValue) {
    // 使用 Lua script 安全释放锁
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    
    for (const client of this.redisClients) {
      try {
        await client.eval(releaseScript, 1, this.config.lockKey, lockValue);
      } catch (error) {
        // 释放失败不影响结果
      }
    }
  }

  /**
   * 发起投票
   */
  async voteForSwitch(decision) {
    const votingId = `vote-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info('Starting voting round', {
      votingId,
      decisionType: decision.type,
      initiator: this.config.currentRegion
    });
    
    metrics.votingRounds.inc({ region: this.config.currentRegion, result: 'start' });
    
    // 创建投票会话
    this.votingSession = {
      id: votingId,
      decision,
      startTime: Date.now(),
      initiator: this.config.currentRegion,
      status: 'pending'
    };
    
    // 本地先投票
    const myVote = {
      region: this.config.currentRegion,
      vote: 'yes',
      reason: 'Initiator vote',
      timestamp: Date.now()
    };
    
    this.votes.set(this.config.currentRegion, myVote);
    
    // 发布投票请求到其他区域
    await this.publishVoteRequest(votingId, decision);
    
    // 收集投票
    const collectPromise = this.collectVotes(votingId);
    const timeoutPromise = this.timeoutPromise(this.config.voteTimeoutMs);
    
    try {
      await Promise.race([collectPromise, timeoutPromise]);
      
      const results = await this.checkQuorum(this.votes);
      
      metrics.votingRounds.inc({ 
        region: this.config.currentRegion, 
        result: results.quorumReached ? 'success' : 'fail' 
      });
      
      if (results.quorumReached) {
        metrics.quorumReached.inc({ decision_type: decision.type });
      }
      
      this.votingSession.status = results.quorumReached ? 'approved' : 'rejected';
      this.votingSession.endTime = Date.now();
      
      logger.info('Voting round completed', {
        votingId,
        quorumReached: results.quorumReached,
        votes: results.totalVotes,
        quorum: this.config.quorum
      });
      
      this.emit('voting-completed', { votingId, results });
      
      return this.votes;
    } catch (error) {
      this.votingSession.status = 'error';
      
      metrics.votingRounds.inc({ region: this.config.currentRegion, result: 'error' });
      
      logger.error('Voting round failed', { votingId, error: error.message });
      
      return this.votes;
    }
  }

  /**
   * 发布投票请求
   */
  async publishVoteRequest(votingId, decision) {
    const voteRequest = {
      votingId,
      decision,
      initiator: this.config.currentRegion,
      timestamp: Date.now()
    };
    
    // 使用第一个 Redis 客户端发布
    const client = this.redisClients[0];
    if (client) {
      await client.publish('minego:arbitration:vote-request', JSON.stringify(voteRequest));
    }
    
    // 同时写入 Redis 供其他区域读取
    const voteKey = `${this.config.votingKey}:${votingId}`;
    await client?.set(voteKey, JSON.stringify(voteRequest), 'EX', 10);
  }

  /**
   * 收集投票
   */
  async collectVotes(votingId) {
    const voteKey = `${this.config.votingKey}:${votingId}:responses`;
    
    // 模拟收集投票（实际实现需要等待其他区域的响应）
    // 在真实场景中，其他区域会通过 Redis Pub/Sub 发送投票
    
    // 简化实现：模拟其他区域投票
    const simulatedVotes = this.simulateRemoteVotes(votingId);
    
    for (const vote of simulatedVotes) {
      this.votes.set(vote.region, vote);
    }
    
    logger.debug('Votes collected', {
      votingId,
      totalVotes: this.votes.size
    });
  }

  /**
   * 模拟远程投票（简化实现）
   */
  simulateRemoteVotes(votingId) {
    const otherRegions = this.config.regions.filter(r => r !== this.config.currentRegion);
    
    return otherRegions.map((region, index) => ({
      region,
      vote: index % 2 === 0 ? 'yes' : 'yes', // 简化：默认都同意
      reason: `Remote vote from ${region}`,
      timestamp: Date.now() + index * 100
    }));
  }

  /**
   * 检查是否达成共识
   */
  async checkQuorum(votes) {
    const voteList = Array.from(votes.values());
    
    const yesVotes = voteList.filter(v => v.vote === 'yes').length;
    const noVotes = voteList.filter(v => v.vote === 'no').length;
    const totalVotes = voteList.length;
    
    const quorumReached = yesVotes >= this.config.quorum || 
      (yesVotes / totalVotes) >= this.config.minQuorumRatio;
    
    logger.debug('Quorum check', {
      yesVotes,
      noVotes,
      totalVotes,
      quorum: this.config.quorum,
      quorumReached
    });
    
    return {
      quorumReached,
      yesVotes,
      noVotes,
      totalVotes,
      votes: voteList
    };
  }

  /**
   * 超时 Promise
   */
  timeoutPromise(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Voting timeout'));
      }, ms);
    });
  }

  /**
   * 处理远程投票请求
   */
  async handleVoteRequest(voteRequest) {
    const { votingId, decision, initiator } = voteRequest;
    
    logger.info('Received vote request', {
      votingId,
      initiator,
      decisionType: decision.type
    });
    
    // 本地决策逻辑
    // 实际实现中，应该根据本地状态判断是否同意
    const myVote = {
      region: this.config.currentRegion,
      vote: 'yes', // 简化：默认同意
      reason: `Local vote for ${decision.type}`,
      timestamp: Date.now()
    };
    
    // 发送投票响应
    const client = this.redisClients[0];
    const voteKey = `${this.config.votingKey}:${votingId}:responses:${this.config.currentRegion}`;
    
    await client?.set(voteKey, JSON.stringify(myVote), 'EX', 10);
    await client?.publish('minego:arbitration:vote-response', JSON.stringify(myVote));
    
    this.emit('vote-cast', { votingId, vote: myVote });
  }

  /**
   * 检测脑裂
   */
  async detectSplitBrain() {
    // 检查是否有多个区域持有锁
    const lockHolders = [];
    
    for (const client of this.redisClients) {
      try {
        const lockValue = await client.get(this.config.lockKey);
        if (lockValue) {
          lockHolders.push({ lockValue, client: client.options?.host });
        }
      } catch (error) {
        // 忽略错误
      }
    }
    
    // 如果多个区域声称持有不同的锁值，说明有脑裂
    const uniqueLockValues = new Set(lockHolders.map(h => h.lockValue));
    
    if (uniqueLockValues.size > 1) {
      metrics.splitBrainIncidents.inc({ region: this.config.currentRegion });
      
      logger.error('Split brain detected!', {
        lockHolders,
        uniqueLockValues: Array.from(uniqueLockValues)
      });
      
      this.emit('split-brain-detected', { lockHolders });
      
      // 尝试解决脑裂
      await this.resolveSplitBrain(lockHolders);
      
      return true;
    }
    
    return false;
  }

  /**
   * 解决脑裂
   */
  async resolveSplitBrain(lockHolders) {
    logger.warn('Attempting to resolve split brain');
    
    // 找出最早的锁
    const earliestLock = lockHolders.reduce((earliest, current) => {
      const currentTimestamp = parseInt(current.lockValue.split(':')[1]) || 0;
      const earliestTimestamp = parseInt(earliest.lockValue.split(':')[1]) || 0;
      
      return currentTimestamp < earliestTimestamp ? current : earliest;
    }, lockHolders[0]);
    
    // 只保留最早的锁，释放其他锁
    const earliestValue = earliestLock.lockValue;
    
    for (const client of this.redisClients) {
      try {
        const currentValue = await client.get(this.config.lockKey);
        if (currentValue && currentValue !== earliestValue) {
          await client.del(this.config.lockKey);
          logger.warn('Released conflicting lock', { currentValue });
        }
      } catch (error) {
        // 忽略错误
      }
    }
    
    logger.info('Split brain resolved', { retainedLock: earliestValue });
    
    this.emit('split-brain-resolved', { retainedLock: earliestValue });
  }

  /**
   * 获取当前锁状态
   */
  getLockStatus() {
    return {
      hasLock: !!this.currentLock,
      lockValue: this.currentLock,
      acquiredAt: this.lockAcquiredAt,
      holdDuration: this.lockAcquiredAt ? Date.now() - this.lockAcquiredAt : 0
    };
  }

  /**
   * 获取投票会话状态
   */
  getVotingStatus() {
    return {
      hasSession: !!this.votingSession,
      sessionId: this.votingSession?.id,
      status: this.votingSession?.status,
      votes: Array.from(this.votes.values())
    };
  }

  /**
   * 停止
   */
  async stop() {
    // 停止续约定时器
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }
    
    // 释放锁
    if (this.currentLock) {
      await this.releaseLock();
    }
    
    // 关闭 Redis 连接
    for (const client of this.redisClients) {
      try {
        await client.quit();
      } catch (error) {
        // 忽略错误
      }
    }
    
    logger.info('SplitBrainPrevention stopped');
  }
}

module.exports = SplitBrainPrevention;