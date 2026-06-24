'use strict';
/**
 * 常用验证规则库
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 * 
 * 提供常用的 Zod Schema，覆盖 90% 以上的验证场景
 */

const { z } = require('zod');

// ===== 基础类型验证 =====

/**
 * ObjectId 验证（24位十六进制字符串）
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, {
  message: '无效的 ObjectId 格式'
});

/**
 * MongoDB ObjectId 可选验证
 */
const objectIdOptionalSchema = objectIdSchema.optional();

/**
 * UUID v4 验证
 */
const uuidSchema = z.string().uuid({
  message: '无效的 UUID 格式'
});

/**
 * 带前缀的 ID 验证（如 pokemon_xxx, user_xxx）
 * @param {string} prefix - ID 前缀
 */
function prefixedIdSchema(prefix) {
  return z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+$`), {
    message: `无效的 ${prefix} ID 格式`
  });
}

/**
 * 精灵 ID 验证
 */
const pokemonIdSchema = prefixedIdSchema('pokemon');

/**
 * 用户 ID 验证
 */
const userIdSchema = prefixedIdSchema('user');

/**
 * 道馆 ID 验证
 */
const gymIdSchema = prefixedIdSchema('gym');

/**
 * 物品 ID 验证
 */
const itemIdSchema = prefixedIdSchema('item');

// ===== 地理位置验证 =====

/**
 * 经度验证（-180 ~ 180）
 */
const longitudeSchema = z.number({
  required_error: '经度必填',
  invalid_type_error: '经度必须是数字'
}).min(-180, { message: '经度最小值为 -180' }).max(180, { message: '经度最大值为 180' });

/**
 * 纬度验证（-90 ~ 90）
 */
const latitudeSchema = z.number({
  required_error: '纬度必填',
  invalid_type_error: '纬度必须是数字'
}).min(-90, { message: '纬度最小值为 -90' }).max(90, { message: '纬度最大值为 90' });

/**
 * 坐标验证
 */
const coordinateSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema
}, {
  required_error: '坐标必填',
  invalid_type_error: '坐标格式无效'
});

/**
 * 可选坐标验证
 */
const coordinateOptionalSchema = coordinateSchema.optional();

/**
 * GeoJSON Point 格式
 */
const geoPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([longitudeSchema, latitudeSchema])
});

// ===== 分页参数验证 =====

/**
 * 偏移分页参数验证
 */
const paginationSchema = z.object({
  page: z.coerce.number({
    invalid_type_error: '页码必须是数字'
  }).int({ message: '页码必须是整数' }).positive({ message: '页码必须是正整数' }).default(1),
  
  pageSize: z.coerce.number({
    invalid_type_error: '每页数量必须是数字'
  }).int({ message: '每页数量必须是整数' }).min(1, { message: '每页最少 1 条' }).max(100, { message: '每页最多 100 条' }).default(20),
  
  sortBy: z.string().max(50, { message: '排序字段名过长' }).optional(),
  
  sortOrder: z.enum(['asc', 'desc'], {
    errorMap: () => ({ message: '排序方向必须是 asc 或 desc' })
  }).default('desc')
});

/**
 * 游标分页参数验证
 */
const cursorPaginationSchema = z.object({
  cursor: z.string().max(200, { message: '游标过长' }).optional(),
  
  limit: z.coerce.number({
    invalid_type_error: 'limit 必须是数字'
  }).int({ message: 'limit 必须是整数' }).min(1, { message: 'limit 最小为 1' }).max(100, { message: 'limit 最大为 100' }).default(20)
});

/**
 * 搜索分页参数（包含搜索关键词）
 */
const searchPaginationSchema = paginationSchema.extend({
  keyword: z.string().max(100, { message: '搜索关键词过长' }).optional()
});

// ===== 时间验证 =====

/**
 * ISO 日期时间验证
 */
const datetimeSchema = z.string().datetime({
  message: '日期时间格式无效，应为 ISO 8601 格式'
});

/**
 * 时间戳验证（毫秒）
 */
const timestampSchema = z.number().int().positive();

/**
 * 时间范围验证
 */
const timeRangeSchema = z.object({
  startTime: z.union([
    z.string().datetime(),
    z.coerce.date()
  ]),
  endTime: z.union([
    z.string().datetime(),
    z.coerce.date()
  ])
}).refine(data => {
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);
  return end > start;
}, {
  message: '结束时间必须晚于开始时间',
  path: ['endTime']
});

/**
 * 最近时间范围验证（限制最近多少天内）
 * @param {number} days - 最大天数
 */
function recentTimeRangeSchema(days) {
  return timeRangeSchema.refine(data => {
    const start = new Date(data.startTime);
    const now = new Date();
    const maxPast = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return start >= maxPast;
  }, {
    message: `开始时间不能早于 ${days} 天前`
  });
}

// ===== 用户相关验证 =====

/**
 * 用户名验证（字母开头，允许字母数字下划线，4-20 字符）
 */
const usernameSchema = z.string()
  .min(4, { message: '用户名至少 4 个字符' })
  .max(20, { message: '用户名最多 20 个字符' })
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message: '用户名必须以字母开头，只能包含字母、数字和下划线'
  });

/**
 * 昵称验证（允许中文、英文、数字，2-20 字符）
 */
const nicknameSchema = z.string()
  .min(2, { message: '昵称至少 2 个字符' })
  .max(20, { message: '昵称最多 20 个字符' })
  .regex(/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/, {
    message: '昵称只能包含中文、英文、数字和下划线'
  });

/**
 * 邮箱验证
 */
const emailSchema = z.string()
  .email({ message: '邮箱格式无效' })
  .max(100, { message: '邮箱过长' });

/**
 * 手机号验证（中国大陆）
 */
const phoneSchema = z.string()
  .regex(/^1[3-9]\d{9}$/, {
    message: '手机号格式无效'
  });

/**
 * 密码验证（至少 8 位，包含大小写字母和数字）
 */
const passwordSchema = z.string()
  .min(8, { message: '密码至少 8 个字符' })
  .max(50, { message: '密码最多 50 个字符' })
  .regex(/[a-z]/, { message: '密码必须包含小写字母' })
  .regex(/[A-Z]/, { message: '密码必须包含大写字母' })
  .regex(/[0-9]/, { message: '密码必须包含数字' });

/**
 * 简单密码验证（仅长度）
 */
const simplePasswordSchema = z.string()
  .min(6, { message: '密码至少 6 个字符' })
  .max(50, { message: '密码最多 50 个字符' });

/**
 * 年龄验证
 */
const ageSchema = z.number()
  .int({ message: '年龄必须是整数' })
  .min(1, { message: '年龄最小为 1 岁' })
  .max(150, { message: '年龄最大为 150 岁' });

/**
 * 性别验证
 */
const genderSchema = z.enum(['male', 'female', 'other'], {
  errorMap: () => ({ message: '性别必须是 male、female 或 other' })
});

// ===== 精灵相关验证 =====

/**
 * 精灵种类 ID 验证
 */
const speciesIdSchema = z.string().min(1, { message: '精灵种类 ID 必填' });

/**
 * 精灵等级验证
 */
const levelSchema = z.number()
  .int({ message: '等级必须是整数' })
  .min(1, { message: '等级最小为 1' })
  .max(100, { message: '等级最大为 100' });

/**
 * 精灵 CP 验证
 */
const cpSchema = z.number()
  .int({ message: 'CP 必须是整数' })
  .min(10, { message: 'CP 最小为 10' })
  .max(10000, { message: 'CP 最大为 10000' });

/**
 * 精灵 HP 验证
 */
const hpSchema = z.number()
  .int({ message: 'HP 必须是整数' })
  .min(1, { message: 'HP 最小为 1' })
  .max(1000, { message: 'HP 最大为 1000' });

/**
 * 精灵类型验证
 */
const pokemonTypeSchema = z.enum([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice',
  'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug',
  'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'
], {
  errorMap: () => ({ message: '无效的精灵类型' })
});

/**
 * 稀有度验证
 */
const raritySchema = z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary'], {
  errorMap: () => ({ message: '无效的稀有度' })
});

/**
 * 创建精灵验证 Schema
 */
const createPokemonSchema = z.object({
  speciesId: speciesIdSchema,
  nickname: z.string().max(20, { message: '昵称最多 20 个字符' }).optional(),
  level: levelSchema.default(1),
  coordinates: coordinateSchema.optional()
});

/**
 * 更新精灵验证 Schema
 */
const updatePokemonSchema = z.object({
  nickname: z.string().min(1, { message: '昵称不能为空' }).max(20, { message: '昵称最多 20 个字符' }).optional(),
  isFavorite: z.boolean().optional()
}).partial();

// ===== 道馆相关验证 =====

/**
 * 道馆名称验证
 */
const gymNameSchema = z.string()
  .min(2, { message: '道馆名称至少 2 个字符' })
  .max(50, { message: '道馆名称最多 50 个字符' });

/**
 * 道馆等级验证
 */
const gymLevelSchema = z.number()
  .int({ message: '道馆等级必须是整数' })
  .min(1, { message: '道馆等级最小为 1' })
  .max(10, { message: '道馆等级最大为 10' });

/**
 * 道馆声望验证
 */
const gymPrestigeSchema = z.number()
  .int({ message: '声望必须是整数' })
  .min(0, { message: '声望最小为 0' })
  .max(50000, { message: '声望最大为 50000' });

// ===== 物品相关验证 =====

/**
 * 物品数量验证
 */
const itemCountSchema = z.number()
  .int({ message: '数量必须是整数' })
  .min(1, { message: '数量最小为 1' })
  .max(999, { message: '数量最大为 999' });

/**
 * 物品类型验证
 */
const itemTypeSchema = z.enum([
  'pokeball', 'greatball', 'ultraball', 'masterball',
  'potion', 'superpotion', 'hyperpotion', 'maxpotion',
  'revive', 'maxrevive', 'berry', 'incense', 'lure'
], {
  errorMap: () => ({ message: '无效的物品类型' })
});

// ===== 支付相关验证 =====

/**
 * 金额验证（分为单位）
 */
const amountSchema = z.number()
  .int({ message: '金额必须是整数（分）' })
  .positive({ message: '金额必须大于 0' })
  .max(100000000, { message: '金额超出限制' }); // 100 万元

/**
 * 货币类型验证
 */
const currencySchema = z.enum(['CNY', 'USD', 'EUR', 'JPY', 'GBP'], {
  errorMap: () => ({ message: '无效的货币类型' })
});

/**
 * 支付方式验证
 */
const paymentMethodSchema = z.enum(['alipay', 'wechat', 'apple', 'google', 'card'], {
  errorMap: () => ({ message: '无效的支付方式' })
});

/**
 * 订单 ID 验证
 */
const orderIdSchema = z.string().regex(/^order_[a-z0-9]+$/, {
  message: '无效的订单 ID 格式'
});

// ===== 社交相关验证 =====

/**
 * 好友请求状态验证
 */
const friendStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'blocked'], {
  errorMap: () => ({ message: '无效的好友状态' })
});

/**
 * 消息内容验证
 */
const messageContentSchema = z.string()
  .min(1, { message: '消息内容不能为空' })
  .max(500, { message: '消息内容最多 500 个字符' });

/**
 * 公会名称验证
 */
const guildNameSchema = z.string()
  .min(2, { message: '公会名称至少 2 个字符' })
  .max(30, { message: '公会名称最多 30 个字符' });

/**
 * 公会描述验证
 */
const guildDescriptionSchema = z.string()
  .max(500, { message: '公会描述最多 500 个字符' })
  .optional();

// ===== 通用工具函数 =====

/**
 * 创建带自定义错误消息的 Schema
 * @param {z.ZodSchema} schema - 原始 Schema
 * @param {string} customMessage - 自定义错误消息
 */
function withCustomMessage(schema, customMessage) {
  return schema.refine(() => true, { message: customMessage });
}

/**
 * 创建可选但非空 Schema
 * @param {z.ZodSchema} schema - 原始 Schema
 */
function optionalButNotEmpty(schema) {
  return schema.optional().refine(
    (val) => val === undefined || (typeof val === 'string' ? val.trim() !== '' : true),
    { message: '值不能为空字符串' }
  );
}

/**
 * 创建枚举 Schema（带友好错误消息）
 * @param {string[]} values - 枚举值列表
 * @param {string} [description] - 字段描述
 */
function friendlyEnumSchema(values, description = '值') {
  return z.enum(values, {
    errorMap: () => ({ 
      message: `${description}必须是以下值之一：${values.join(', ')}` 
    })
  });
}

/**
 * 批量 ID 验证 Schema
 * @param {z.ZodSchema} idSchema - 单个 ID 的 Schema
 * @param {number} [maxCount=100] - 最大数量
 */
function batchIdsSchema(idSchema, maxCount = 100) {
  return z.array(idSchema)
    .min(1, { message: '至少需要 1 个 ID' })
    .max(maxCount, { message: `最多 ${maxCount} 个 ID` });
}

/**
 * 条件 Schema（根据另一个字段决定验证规则）
 * @param {string} field - 条件字段名
 * @param {*} value - 条件值
 * @param {z.ZodSchema} schema - 满足条件时的 Schema
 */
function conditionalSchema(field, value, schema) {
  return z.union([
    z.object({
      [field]: z.literal(value),
    }).and(schema),
    z.object({
      [field]: z.any().refine(v => v !== value),
    })
  ]);
}

module.exports = {
  // 基础类型
  objectIdSchema,
  objectIdOptionalSchema,
  uuidSchema,
  prefixedIdSchema,
  pokemonIdSchema,
  userIdSchema,
  gymIdSchema,
  itemIdSchema,
  
  // 地理位置
  longitudeSchema,
  latitudeSchema,
  coordinateSchema,
  coordinateOptionalSchema,
  geoPointSchema,
  
  // 分页
  paginationSchema,
  cursorPaginationSchema,
  searchPaginationSchema,
  
  // 时间
  datetimeSchema,
  timestampSchema,
  timeRangeSchema,
  recentTimeRangeSchema,
  
  // 用户
  usernameSchema,
  nicknameSchema,
  emailSchema,
  phoneSchema,
  passwordSchema,
  simplePasswordSchema,
  ageSchema,
  genderSchema,
  
  // 精灵
  speciesIdSchema,
  levelSchema,
  cpSchema,
  hpSchema,
  pokemonTypeSchema,
  raritySchema,
  createPokemonSchema,
  updatePokemonSchema,
  
  // 道馆
  gymNameSchema,
  gymLevelSchema,
  gymPrestigeSchema,
  
  // 物品
  itemCountSchema,
  itemTypeSchema,
  
  // 支付
  amountSchema,
  currencySchema,
  paymentMethodSchema,
  orderIdSchema,
  
  // 社交
  friendStatusSchema,
  messageContentSchema,
  guildNameSchema,
  guildDescriptionSchema,
  
  // 工具函数
  withCustomMessage,
  optionalButNotEmpty,
  friendlyEnumSchema,
  batchIdsSchema,
  conditionalSchema
};