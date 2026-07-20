/**
 * REQ-00614: 战斗业务告警规则配置
 * 创建时间: 2026-07-20 19:00
 * 
 * 定义战斗相关的业务告警规则
 */

module.exports = [
  // ==================== 技能执行告警 ====================
  {
    id: 'battle_skill_error_high',
    name: '技能执行错误率过高',
    description: '当技能执行错误率超过阈值时触发告警',
    severity: 'warning',
    condition: {
      metric: 'rate(skill_execution_error_total[5m])',
      threshold: 5,  // 每分钟 5 次
      comparison: 'gt',
      for: '2m'
    },
    labels: {
      category: 'battle',
      component: 'skill_execution'
    },
    annotations: {
      summary: '技能 {{skill_name}} 执行错误次数过高',
      description: '在过去 5 分钟内，技能 {{skill_name}}({{skill_id}}) 的执行错误次数达到 {{value}} 次/分钟',
      runbook_url: 'https://wiki.minego.io/runbooks/battle-skill-error'
    },
    channels: ['webhook', 'slack', 'log'],
    autoAction: {
      type: 'log_to_slack',
      channel: '#alerts-battle'
    }
  },
  {
    id: 'skill_execution_timeout',
    name: '技能执行超时',
    description: '当技能执行耗时超过阈值时触发告警',
    severity: 'warning',
    condition: {
      metric: 'histogram_quantile(0.95, rate(skill_execution_duration_seconds_bucket[5m]))',
      threshold: 1,  // 1 秒
      comparison: 'gt',
      for: '3m'
    },
    labels: {
      category: 'battle',
      component: 'skill_execution',
      type: 'timeout'
    },
    annotations: {
      summary: '技能执行耗时过长',
      description: 'P95 技能执行耗时达到 {{value}}s，超过阈值 1s',
      runbook_url: 'https://wiki.minego.io/runbooks/skill-timeout'
    },
    channels: ['webhook', 'log']
  },

  // ==================== 战斗结算告警 ====================
  {
    id: 'battle_settlement_timeout',
    name: '战斗结算超时率过高',
    description: '当战斗结算超时率超过阈值时触发告警',
    severity: 'critical',
    condition: {
      metric: 'sum(rate(battle_settlement_timeout_total[5m])) / sum(rate(battle_total_count[5m]))',
      threshold: 0.01,  // 1%
      comparison: 'gt',
      for: '2m'
    },
    labels: {
      category: 'battle',
      component: 'settlement',
      priority: 'P0'
    },
    annotations: {
      summary: '战斗结算超时率异常',
      description: '战斗结算超时率达到 {{value}}，超过 1% 阈值，可能影响用户体验',
      runbook_url: 'https://wiki.minego.io/runbooks/battle-settlement-timeout'
    },
    channels: ['webhook', 'slack', 'log'],
    autoAction: {
      type: 'create_incident',
      severity: 'P1'
    }
  },
  {
    id: 'battle_settlement_error',
    name: '战斗结算错误率过高',
    description: '当战斗结算错误率超过阈值时触发告警',
    severity: 'critical',
    condition: {
      metric: 'sum(rate(battle_settlement_error_total[5m])) / sum(rate(battle_total_count[5m]))',
      threshold: 0.02,  // 2%
      comparison: 'gt',
      for: '2m'
    },
    labels: {
      category: 'battle',
      component: 'settlement',
      priority: 'P0'
    },
    annotations: {
      summary: '战斗结算错误率异常',
      description: '战斗结算错误率达到 {{value}}，超过 2% 阈值',
      runbook_url: 'https://wiki.minego.io/runbooks/battle-settlement-error'
    },
    channels: ['webhook', 'slack', 'log'],
    autoAction: {
      type: 'notify_ops',
      escalation: 'immediate'
    }
  },
  {
    id: 'battle_settlement_duration',
    name: '战斗结算耗时过长',
    description: '当战斗结算耗时过长时触发告警',
    severity: 'warning',
    condition: {
      metric: 'histogram_quantile(0.95, rate(battle_settlement_duration_seconds_bucket[5m]))',
      threshold: 10,  // 10 秒
      comparison: 'gt',
      for: '3m'
    },
    labels: {
      category: 'battle',
      component: 'settlement',
      type: 'latency'
    },
    annotations: {
      summary: '战斗结算耗时过长',
      description: 'P95 战斗结算耗时达到 {{value}}s，超过阈值 10s',
      runbook_url: 'https://wiki.minego.io/runbooks/battle-settlement-latency'
    },
    channels: ['webhook', 'log']
  },

  // ==================== 伤害数值告警 ====================
  {
    id: 'damage_deviation_high',
    name: '伤害数值偏移异常',
    description: '当实际伤害与预期伤害偏差过大时触发告警',
    severity: 'warning',
    condition: {
      metric: 'avg(battle_damage_deviation_ratio)',
      threshold: 0.3,  // 30%
      comparison: 'gt',
      for: '5m'
    },
    labels: {
      category: 'battle',
      component: 'damage_calculation',
      type: 'data_quality'
    },
    annotations: {
      summary: '伤害数值计算偏差过大',
      description: '伤害数值偏移率达到 {{value}}，超过 30% 阈值，可能存在计算逻辑问题',
      runbook_url: 'https://wiki.minego.io/runbooks/damage-deviation'
    },
    channels: ['webhook', 'log']
  },
  {
    id: 'critical_hit_rate_abnormal',
    name: '暴击率异常',
    description: '当暴击率异常偏离正常值时触发告警',
    severity: 'info',
    condition: {
      expr: 'avg(battle_critical_hit_rate) < 0.01 OR avg(battle_critical_hit_rate) > 0.25',
      for: '10m'
    },
    labels: {
      category: 'battle',
      component: 'damage_calculation',
      type: 'data_quality'
    },
    annotations: {
      summary: '暴击率偏离正常范围',
      description: '当前暴击率为 {{value}}，正常范围应在 1%-25% 之间',
      runbook_url: 'https://wiki.minego.io/runbooks/critical-hit-rate'
    },
    channels: ['log']
  },

  // ==================== 战斗胜负告警 ====================
  {
    id: 'win_rate_abnormal',
    name: '战斗胜率异常',
    description: '当某类型战斗的胜率异常时触发告警',
    severity: 'warning',
    condition: {
      metric: 'battle_win_rate_ratio',
      threshold_low: 0.2,  // 低于 20%
      threshold_high: 0.9, // 或高于 90%
      comparison: 'outside_range',
      for: '30m'
    },
    labels: {
      category: 'battle',
      component: 'game_balance',
      type: 'anomaly'
    },
    annotations: {
      summary: '{{battle_type}} 战斗胜率异常',
      description: '{{battle_type}} 战斗（{{player_level_range}}）的胜率为 {{value}}，可能存在平衡性问题',
      runbook_url: 'https://wiki.minego.io/runbooks/win-rate-abnormal'
    },
    channels: ['webhook', 'log']
  },

  // ==================== 属性克制告警 ====================
  {
    id: 'type_effectiveness_abnormal',
    name: '属性克制异常',
    description: '当属性克制触发率异常时触发告警',
    severity: 'info',
    condition: {
      expr: 'count(battle_type_effectiveness_rate{effectiveness_level="no_effect"} > 0.5) > 0',
      for: '15m'
    },
    labels: {
      category: 'battle',
      component: 'type_effectiveness',
      type: 'data_quality'
    },
    annotations: {
      summary: '属性克制触发异常',
      description: '检测到"无效"属性克制的触发率过高，可能存在数据错误',
      runbook_url: 'https://wiki.minego.io/runbooks/type-effectiveness'
    },
    channels: ['log']
  }
];
