'use strict';
/**
 * User Service Contract - 用户服务 API 契约
 */

const Joi = require('joi');
const { ContractSchema } = require('../../../shared/contract/ContractSchema');

const userContract = new ContractSchema('user-service', '1.0.0');

// ============================================================
// 定义通用 Schema
// ============================================================
userContract.defineSchema('UserId', Joi.string().uuid());

userContract.defineSchema('Email', Joi.string().email());

userContract.defineSchema('Username', Joi.string().min(3).max(30).alphanum());

// 用户基础 Schema
userContract.defineSchema('User', Joi.object({
  id: Joi.string().uuid().required(),
  username: Joi.string().min(3).max(30).alphanum().required(),
  email: Joi.string().email().required(),
  level: Joi.number().integer().min(1).max(100).required(),
  experience: Joi.number().integer().min(0).required(),
  coins: Joi.number().integer().min(0).required(),
  createdAt: Joi.date().iso().required(),
  updatedAt: Joi.date().iso().required()
}).unknown(true));

// 用户公开信息 Schema
userContract.defineSchema('UserPublic', Joi.object({
  id: Joi.string().uuid().required(),
  username: Joi.string().required(),
  level: Joi.number().integer().required()
}).unknown(true));

// ============================================================
// 定义端点契约
// ============================================================

// POST /api/users/register - 用户注册
userContract.defineEndpoint({
  method: 'POST',
  path: '/api/users/register',
  description: 'Register a new user',
  request: Joi.object({
    username: Joi.string().min(3).max(30).alphanum().required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required()
  }),
  response: Joi.object({
    user: userContract.getSchema('User'),
    token: Joi.string().required()
  }),
  expectedStatus: 201
});

// POST /api/users/login - 用户登录
userContract.defineEndpoint({
  method: 'POST',
  path: '/api/users/login',
  description: 'User login',
  request: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  }),
  response: Joi.object({
    user: userContract.getSchema('User'),
    token: Joi.string().required()
  }),
  expectedStatus: 200
});

// GET /api/users/me - 获取当前用户信息
userContract.defineEndpoint({
  method: 'GET',
  path: '/api/users/me',
  description: 'Get current user info',
  response: userContract.getSchema('User'),
  expectedStatus: 200
});

// GET /api/users/:id - 获取用户公开信息
userContract.defineEndpoint({
  method: 'GET',
  path: '/api/users/:id',
  description: 'Get user public info by ID',
  response: userContract.getSchema('UserPublic'),
  expectedStatus: 200
});

// PUT /api/users/me - 更新用户信息
userContract.defineEndpoint({
  method: 'PUT',
  path: '/api/users/me',
  description: 'Update current user info',
  request: Joi.object({
    username: Joi.string().min(3).max(30).alphanum().optional(),
    email: Joi.string().email().optional()
  }).min(1),
  response: userContract.getSchema('User'),
  expectedStatus: 200
});

// DELETE /api/users/me - 删除用户账户
userContract.defineEndpoint({
  method: 'DELETE',
  path: '/api/users/me',
  description: 'Delete current user account',
  response: Joi.object({
    message: Joi.string().required()
  }),
  expectedStatus: 200
});

// POST /api/users/logout - 用户登出
userContract.defineEndpoint({
  method: 'POST',
  path: '/api/users/logout',
  description: 'User logout',
  response: Joi.object({
    message: Joi.string().required()
  }),
  expectedStatus: 200
});

module.exports = userContract;
