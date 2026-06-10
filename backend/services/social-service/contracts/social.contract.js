'use strict';
/**
 * Social Service Contract - 社交服务 API 契约
 */

const Joi = require('joi');
const { ContractSchema } = require('../../../shared/contract/ContractSchema');

const socialContract = new ContractSchema('social-service', '1.0.0');

// ============================================================
// 定义通用 Schema
// ============================================================

// 好友 Schema
socialContract.defineSchema('Friend', Joi.object({
  id: Joi.string().uuid().required(),
  username: Joi.string().required(),
  level: Joi.number().integer().required(),
  friendshipLevel: Joi.number().integer().min(1).max(5).required(),
  friendshipPoints: Joi.number().integer().required(),
  createdAt: Joi.date().iso().required()
}).unknown(true));

// 好友请求 Schema
socialContract.defineSchema('FriendRequest', Joi.object({
  id: Joi.string().uuid().required(),
  fromUserId: Joi.string().uuid().required(),
  fromUsername: Joi.string().required(),
  status: Joi.string().valid('pending', 'accepted', 'rejected').required(),
  createdAt: Joi.date().iso().required()
}).unknown(true));

// 礼物 Schema
socialContract.defineSchema('Gift', Joi.object({
  id: Joi.string().uuid().required(),
  fromUserId: Joi.string().uuid().required(),
  fromUsername: Joi.string().required(),
  items: Joi.array().items(Joi.object({
    type: Joi.string().required(),
    quantity: Joi.number().integer().required()
  })).required(),
  opened: Joi.boolean().required(),
  createdAt: Joi.date().iso().required()
}).unknown(true));

// ============================================================
// 定义端点契约
// ============================================================

// GET /api/friends - 获取好友列表
socialContract.defineEndpoint({
  method: 'GET',
  path: '/api/friends',
  description: 'Get user\'s friends list',
  response: Joi.object({
    friends: Joi.array().items(socialContract.getSchema('Friend')),
    total: Joi.number().integer().required()
  }),
  expectedStatus: 200
});

// POST /api/friends/request - 发送好友请求
socialContract.defineEndpoint({
  method: 'POST',
  path: '/api/friends/request',
  description: 'Send friend request',
  request: Joi.object({
    toUserId: Joi.string().uuid().required()
  }),
  response: Joi.object({
    requestId: Joi.string().uuid().required(),
    message: Joi.string().required()
  }),
  expectedStatus: 201
});

// GET /api/friends/requests - 获取好友请求列表
socialContract.defineEndpoint({
  method: 'GET',
  path: '/api/friends/requests',
  description: 'Get pending friend requests',
  response: Joi.object({
    requests: Joi.array().items(socialContract.getSchema('FriendRequest')),
    total: Joi.number().integer().required()
  }),
  expectedStatus: 200
});

// POST /api/friends/requests/:id/accept - 接受好友请求
socialContract.defineEndpoint({
  method: 'POST',
  path: '/api/friends/requests/:id/accept',
  description: 'Accept friend request',
  response: Joi.object({
    friend: socialContract.getSchema('Friend'),
    message: Joi.string().required()
  }),
  expectedStatus: 200
});

// POST /api/friends/requests/:id/reject - 拒绝好友请求
socialContract.defineEndpoint({
  method: 'POST',
  path: '/api/friends/requests/:id/reject',
  description: 'Reject friend request',
  response: Joi.object({
    message: Joi.string().required()
  }),
  expectedStatus: 200
});

// DELETE /api/friends/:id - 删除好友
socialContract.defineEndpoint({
  method: 'DELETE',
  path: '/api/friends/:id',
  description: 'Remove a friend',
  response: Joi.object({
    message: Joi.string().required()
  }),
  expectedStatus: 200
});

// GET /api/gifts - 获取礼物列表
socialContract.defineEndpoint({
  method: 'GET',
  path: '/api/gifts',
  description: 'Get user\'s gifts',
  response: Joi.object({
    gifts: Joi.array().items(socialContract.getSchema('Gift')),
    total: Joi.number().integer().required()
  }),
  expectedStatus: 200
});

// POST /api/gifts/:id/open - 打开礼物
socialContract.defineEndpoint({
  method: 'POST',
  path: '/api/gifts/:id/open',
  description: 'Open a gift',
  response: Joi.object({
    items: Joi.array().items(Joi.object({
      type: Joi.string().required(),
      quantity: Joi.number().integer().required()
    })).required()
  }),
  expectedStatus: 200
});

module.exports = socialContract;
