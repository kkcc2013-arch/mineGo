'use strict';
/**
 * Pokemon Service Contract - 精灵服务 API 契约
 */

const Joi = require('joi');
const { ContractSchema } = require('../../../shared/contract/ContractSchema');

const pokemonContract = new ContractSchema('pokemon-service', '1.0.0');

// ============================================================
// 定义通用 Schema
// ============================================================

// 精灵基础 Schema
pokemonContract.defineSchema('Pokemon', Joi.object({
  id: Joi.string().uuid().required(),
  speciesId: Joi.number().integer().min(1).required(),
  name: Joi.string().required(),
  level: Joi.number().integer().min(1).max(100).required(),
  experience: Joi.number().integer().min(0).required(),
  hp: Joi.number().integer().min(0).required(),
  maxHp: Joi.number().integer().min(1).required(),
  attack: Joi.number().integer().min(0).required(),
  defense: Joi.number().integer().min(0).required(),
  types: Joi.array().items(Joi.string()).required(),
  ownerId: Joi.string().uuid().allow(null).required(),
  createdAt: Joi.date().iso().required()
}).unknown(true));

// 精灵列表项 Schema
pokemonContract.defineSchema('PokemonListItem', Joi.object({
  id: Joi.string().uuid().required(),
  speciesId: Joi.number().integer().required(),
  name: Joi.string().required(),
  level: Joi.number().integer().required(),
  cp: Joi.number().integer().required(),
  types: Joi.array().items(Joi.string()).required()
}).unknown(true));

// ============================================================
// 定义端点契约
// ============================================================

// GET /api/pokemon - 获取精灵列表
pokemonContract.defineEndpoint({
  method: 'GET',
  path: '/api/pokemon',
  description: 'Get user\'s pokemon list',
  response: Joi.object({
    pokemon: Joi.array().items(pokemonContract.getSchema('PokemonListItem')),
    total: Joi.number().integer().required(),
    page: Joi.number().integer().required(),
    pageSize: Joi.number().integer().required()
  }),
  expectedStatus: 200
});

// GET /api/pokemon/:id - 获取精灵详情
pokemonContract.defineEndpoint({
  method: 'GET',
  path: '/api/pokemon/:id',
  description: 'Get pokemon details by ID',
  response: pokemonContract.getSchema('Pokemon'),
  expectedStatus: 200
});

// POST /api/pokemon/:id/power-up - 强化精灵
pokemonContract.defineEndpoint({
  method: 'POST',
  path: '/api/pokemon/:id/power-up',
  description: 'Power up a pokemon',
  response: Joi.object({
    pokemon: pokemonContract.getSchema('Pokemon'),
    cost: Joi.object({
      stardust: Joi.number().integer().required(),
      candy: Joi.number().integer().required()
    }).required()
  }),
  expectedStatus: 200
});

// POST /api/pokemon/:id/evolve - 进化精灵
pokemonContract.defineEndpoint({
  method: 'POST',
  path: '/api/pokemon/:id/evolve',
  description: 'Evolve a pokemon',
  response: Joi.object({
    oldPokemon: pokemonContract.getSchema('Pokemon').required(),
    newPokemon: pokemonContract.getSchema('Pokemon').required(),
    cost: Joi.object({
      candy: Joi.number().integer().required()
    }).required()
  }),
  expectedStatus: 200
});

// PUT /api/pokemon/:id/favorite - 设置为喜爱
pokemonContract.defineEndpoint({
  method: 'PUT',
  path: '/api/pokemon/:id/favorite',
  description: 'Mark pokemon as favorite',
  request: Joi.object({
    favorite: Joi.boolean().required()
  }),
  response: Joi.object({
    pokemon: pokemonContract.getSchema('Pokemon')
  }),
  expectedStatus: 200
});

// POST /api/pokemon/:id/transfer - 转移精灵
pokemonContract.defineEndpoint({
  method: 'POST',
  path: '/api/pokemon/:id/transfer',
  description: 'Transfer pokemon to professor',
  response: Joi.object({
    success: Joi.boolean().required(),
    candyAwarded: Joi.number().integer().required()
  }),
  expectedStatus: 200
});

module.exports = pokemonContract;
