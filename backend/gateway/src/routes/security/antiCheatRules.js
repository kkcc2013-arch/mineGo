/**
 * 反作弊规则管理 API 路由
 * REQ-00608
 */

module.exports = {
  name: 'anti-cheat-rules',
  routes: [
    // 获取所有规则
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules',
      handler: 'security/antiCheatRules.list',
      auth: true,
      roles: ['admin', 'security_analyst'],
      validate: {
        query: {
          category: { type: 'string', required: false },
          status: { type: 'string', required: false },
          page: { type: 'number', required: false },
          limit: { type: 'number', required: false }
        }
      }
    },

    // 创建新规则
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules',
      handler: 'security/antiCheatRules.create',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          rule_id: { type: 'string', required: true, min: 1, max: 50 },
          rule_name: { type: 'string', required: true, min: 1, max: 200 },
          category: { type: 'string', required: true },
          description: { type: 'string', required: false },
          config: { type: 'object', required: true },
          priority: { type: 'number', required: false }
        }
      }
    },

    // 更新规则
    {
      method: 'PATCH',
      path: '/api/admin/anti-cheat/rules/:ruleId',
      handler: 'security/antiCheatRules.update',
      auth: true,
      roles: ['admin']
    },

    // 获取规则详情
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId',
      handler: 'security/antiCheatRules.get',
      auth: true,
      roles: ['admin', 'security_analyst']
    },

    // 创建灰度发布
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout',
      handler: 'security/antiCheatRules.createRollout',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          strategy: { type: 'string', required: true }, // gradual/instant
          initialPercentage: { type: 'number', required: false, min: 0, max: 100 },
          incrementStep: { type: 'number', required: false, min: 1, max: 50 },
          intervalMinutes: { type: 'number', required: false, min: 1 },
          autoRollback: { type: 'boolean', required: false },
          rollbackThreshold: { type: 'number', required: false, min: 0, max: 1 }
        }
      }
    },

    // 推进灰度
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout/advance',
      handler: 'security/antiCheatRules.advanceRollout',
      auth: true,
      roles: ['admin']
    },

    // 回滚灰度
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/rollout/rollback',
      handler: 'security/antiCheatRules.rollbackRollout',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          reason: { type: 'string', required: true, min: 10 }
        }
      }
    },

    // 创建 A/B 测试
    {
      method: 'POST',
      path: '/api/admin/anti-cheat/rules/:ruleId/ab-test',
      handler: 'security/antiCheatRules.createABTest',
      auth: true,
      roles: ['admin'],
      validate: {
        body: {
          variants: { 
            type: 'array', 
            required: true,
            min: 2,
            items: {
              id: 'string',
              config: 'object',
              percentage: 'number'
            }
          }
        }
      }
    },

    // 获取 A/B 测试结果
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId/ab-test/results',
      handler: 'security/antiCheatRules.getABTestResults',
      auth: true,
      roles: ['admin', 'security_analyst'],
      validate: {
        query: {
          testId: { type: 'string', required: true }
        }
      }
    },

    // 获取规则统计
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId/stats',
      handler: 'security/antiCheatRules.getStats',
      auth: true,
      roles: ['admin', 'security_analyst']
    },

    // 获取规则变更历史
    {
      method: 'GET',
      path: '/api/admin/anti-cheat/rules/:ruleId/history',
      handler: 'security/antiCheatRules.getHistory',
      auth: true,
      roles: ['admin', 'security_analyst']
    }
  ]
};
