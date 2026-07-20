/**
 * Gateway 验证中间件集成示例
 * 展示如何使用 requestValidator 和 injectionDetector
 */

'use strict';

const express = require('express');
const { validateRequest, body, query, headers } = require('../../shared/requestValidator');
const { injectionProtectionMiddleware } = require('../../shared/injectionDetector');

const router = express.Router();

// 全局注入防护中间件（放在路由之前）
const injectionGuard = injectionProtectionMiddleware({
  enableLogging: true,
  blockLevel: 'high' // 只阻断高危攻击
});

/**
 * 示例 1：用户注册接口验证
 * POST /api/v2/auth/register
 * 
 * 验证规则：
 * - username: 必填，3-20字符，字母数字下划线
 * - email: 必填，有效邮箱格式
 * - password: 必填，至少8字符
 * - phone: 可选，有效手机号
 */
router.post('/register',
  injectionGuard,
  validateRequest({
    body: {
      username: {
        type: 'string',
        required: true,
        minLength: 3,
        maxLength: 20,
        pattern: /^[a-zA-Z0-9_]+$/,
      },
      email: {
        type: 'string',
        required: true,
        format: 'email'
      },
      password: {
        type: 'string',
        required: true,
        minLength: 8,
        maxLength: 128
      },
      phone: {
        type: 'string',
        format: 'phone'
      }
    },
    headers: {
      'x-device-id': {
        type: 'string',
        required: true,
        minLength: 16,
        maxLength: 64
      }
    }
  }),
  async (req, res, next) => {
    // 验证通过，处理注册逻辑
    const { username, email, password, phone } = req.body;
    
    res.json({
      success: true,
      message: 'User registered successfully',
      data: { username, email }
    });
  }
);

/**
 * 示例 2：精灵捕捉接口验证
 * POST /api/v2/pokemon/catch
 * 
 * 验证规则：
 * - pokemonId: 必填，24位ObjectId
 * - latitude: 必填，-90 到 90
 * - longitude: 必填，-180 到 180
 * - ballType: 必填，枚举值
 * - items: 可选，数组最多10项
 */
router.post('/pokemon/catch',
  injectionGuard,
  validateRequest({
    body: {
      pokemonId: {
        type: 'string',
        required: true,
        format: 'objectId'
      },
      latitude: {
        type: 'number',
        required: true,
        min: -90,
        max: 90
      },
      longitude: {
        type: 'number',
        required: true,
        min: -180,
        max: 180
      },
      ballType: {
        type: 'string',
        required: true,
        enum: ['poke', 'great', 'ultra', 'master']
      },
      items: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string' }
      }
    },
    headers: {
      'x-request-id': { type: 'string', required: true }
    }
  }),
  async (req, res, next) => {
    // 捕捉逻辑
    const { pokemonId, latitude, longitude, ballType, items } = req.body;
    
    res.json({
      success: true,
      data: { captured: true, pokemonId }
    });
  }
);

/**
 * 示例 3：使用链式 API 定义验证规则
 * GET /api/v2/pokemon/search
 */
router.get('/pokemon/search',
  injectionGuard,
  validateRequest({
    query: query()
      .field('term').isString().minLength(1).maxLength(50).optional()
      .field('types').isString().maxLength(100).optional()
      .field('minCp').isInt({ min: 0, max: 5000 }).optional()
      .field('maxCp').isInt({ min: 0, max: 5000 }).optional()
      .field('page').isInt({ min: 1 }).default(1)
      .field('limit').isInt({ min: 1, max: 100 }).default(20)
      .field('sort').isString().optional()
      .build(),
    headers: headers()
      .field('x-request-id').isString().required()
      .build()
  }),
  async (req, res, next) => {
    const { term, types, minCp, maxCp, page, limit, sort } = req.query;
    
    res.json({
      success: true,
      data: [],
      meta: { page, limit }
    });
  }
);

/**
 * 示例 4：Gym 战斗接口验证（复杂数据结构）
 * POST /api/v2/gym/battle
 */
router.post('/gym/battle',
  injectionGuard,
  validateRequest({
    body: {
      gymId: {
        type: 'string',
        required: true,
        format: 'objectId'
      },
      team: {
        type: 'array',
        required: true,
        minItems: 1,
        maxItems: 6,
        items: { type: 'string' } // 精灵ID数组
      },
      strategy: {
        type: 'string',
        enum: ['aggressive', 'defensive', 'balanced'],
        required: false
      }
    },
    headers: {
      'x-request-id': { type: 'string', required: true },
      'x-user-id': { type: 'string', required: true }
    }
  }),
  async (req, res, next) => {
    const { gymId, team, strategy } = req.body;
    
    res.json({
      success: true,
      data: { battleId: 'battle-123', result: 'won' }
    });
  }
);

/**
 * 示例 5：支付接口验证（自定义验证）
 * POST /api/v2/payment/purchase
 */
router.post('/payment/purchase',
  injectionGuard,
  validateRequest({
    body: {
      productId: {
        type: 'string',
        required: true,
        format: 'objectId'
      },
      quantity: {
        type: 'integer',
        required: true,
        min: 1,
        max: 99
      },
      paymentMethod: {
        type: 'string',
        required: true,
        enum: ['alipay', 'wechat', 'credit_card', 'coins']
      },
      couponCode: {
        type: 'string',
        maxLength: 50,
        validate: (value) => {
          // 自定义验证：优惠券码格式
          if (!value) return true; // 可选字段
          return /^[A-Z0-9]{6,12}$/i.test(value);
        },
        customMessage: 'Invalid coupon code format'
      }
    },
    headers: {
      'x-request-id': { type: 'string', required: true },
      'x-user-id': { type: 'string', required: true },
      'x-device-id': { type: 'string', required: true }
    }
  }),
  async (req, res, next) => {
    const { productId, quantity, paymentMethod, couponCode } = req.body;
    
    res.json({
      success: true,
      data: { orderId: 'order-123', amount: 9.99 }
    });
  }
);

/**
 * 示例 6：批量路由验证规则应用
 */
const userValidationRules = {
  'PUT /profile': {
    body: {
      nickname: { type: 'string', minLength: 2, maxLength: 30 },
      avatar: { type: 'string', format: 'url' },
      bio: { type: 'string', maxLength: 500 }
    }
  },
  'POST /settings': {
    body: {
      language: { type: 'string', enum: ['zh', 'en', 'ja', 'ko'] },
      notifications: { type: 'boolean' },
      soundEffects: { type: 'boolean' }
    }
  }
};

// 应用批量验证规则
function applyValidationToRoutes(router, rules) {
  for (const [route, schema] of Object.entries(rules)) {
    const [method, path] = route.split(' ');
    const middleware = validateRequest(schema);
    
    router[method.toLowerCase()](path, injectionGuard, middleware);
  }
}

module.exports = {
  router,
  injectionGuard,
  applyValidationToRoutes
};
