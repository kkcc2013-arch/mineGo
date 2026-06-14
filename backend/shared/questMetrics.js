// backend/shared/questMetrics.js - 任务系统 Prometheus 指标
'use strict';

const client = require('prom-client');

// 任务生成计数器
const questGenerated = new client.Counter({
  name: 'quest_generated_total',
  help: 'Total number of quests generated',
  labelNames: ['type', 'pool'],
});

// 任务完成计数器
const questCompleted = new client.Counter({
  name: 'quest_completed_total',
  help: 'Total number of quests completed',
  labelNames: ['type', 'difficulty', 'pool'],
});

// 任务奖励领取计数器
const questClaimed = new client.Counter({
  name: 'quest_claimed_total',
  help: 'Total number of quest rewards claimed',
  labelNames: ['type'],
});

// 任务进度更新延迟
const questProgressLatency = new client.Histogram({
  name: 'quest_progress_update_latency_seconds',
  help: 'Quest progress update latency',
  buckets: [0.01, 0.05, 0.1, 0.5, 1.0],
});

// 活跃连击数
const activeStreakGauge = new client.Gauge({
  name: 'quest_active_streak',
  help: 'Current active streak count',
  labelNames: ['user_id'],
});

// 任务完成率
const questCompletionRate = new client.Gauge({
  name: 'quest_completion_rate',
  help: 'Quest completion rate by type',
  labelNames: ['type'],
});

// 连击倍率分布
const streakMultiplierDistribution = new client.Histogram({
  name: 'streak_multiplier_distribution',
  help: 'Distribution of streak multipliers',
  buckets: [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5],
});

// 每日任务生成错误
const questGenerationErrors = new client.Counter({
  name: 'quest_generation_errors_total',
  help: 'Total number of quest generation errors',
  labelNames: ['type'],
});

// 奖励发放统计
const rewardsGranted = new client.Counter({
  name: 'quest_rewards_granted_total',
  help: 'Total rewards granted from quests',
  labelNames: ['reward_type'],
});

/**
 * 记录任务生成
 */
function recordQuestGenerated(type, pool) {
  questGenerated.inc({ type, pool });
}

/**
 * 记录任务完成
 */
function recordQuestCompleted(type, difficulty, pool) {
  questCompleted.inc({ type, difficulty, pool });
}

/**
 * 记录奖励领取
 */
function recordQuestClaimed(type) {
  questClaimed.inc({ type });
}

/**
 * 记录进度更新延迟
 */
function recordProgressLatency(duration) {
  questProgressLatency.observe(duration);
}

/**
 * 更新活跃连击
 */
function updateActiveStreak(userId, streak) {
  activeStreakGauge.set({ user_id: userId }, streak);
}

/**
 * 更新任务完成率
 */
function updateCompletionRate(type, rate) {
  questCompletionRate.set({ type }, rate);
}

/**
 * 记录连击倍率
 */
function recordStreakMultiplier(multiplier) {
  streakMultiplierDistribution.observe(multiplier);
}

/**
 * 记录生成错误
 */
function recordGenerationError(type) {
  questGenerationErrors.inc({ type });
}

/**
 * 记录奖励发放
 */
function recordRewardsGranted(rewardType) {
  rewardsGranted.inc({ reward_type: rewardType });
}

module.exports = {
  // 指标实例
  questGenerated,
  questCompleted,
  questClaimed,
  questProgressLatency,
  activeStreakGauge,
  questCompletionRate,
  streakMultiplierDistribution,
  questGenerationErrors,
  rewardsGranted,
  
  // 辅助函数
  recordQuestGenerated,
  recordQuestCompleted,
  recordQuestClaimed,
  recordProgressLatency,
  updateActiveStreak,
  updateCompletionRate,
  recordStreakMultiplier,
  recordGenerationError,
  recordRewardsGranted,
};