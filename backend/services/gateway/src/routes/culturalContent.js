// backend/services/gateway/src/routes/culturalContent.js
// REQ-00495: 文化内容本地化与合规 API
'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth, AppError, successResp, errorResp } = require('../../../shared/auth');
const { query } = require('../../../shared/db');
const { getCulturalContentFilter } = require('../../../shared/CulturalContentFilter');
const { getComplianceRuleEngine } = require('../../../shared/ComplianceRuleEngine');
const { getCulturalContentModerator } = require('../../../shared/CulturalContentModerator');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('gateway:cultural');
const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────
const FilterRequestSchema = z.object({
  entities: z.array(z.object({
    type: z.enum(['pokemon', 'item', 'skill', 'activity']),
    id: z.number().int(),
    name: z.string(),
    description: z.string().optional(),
    image_url: z.string().optional()
  })),
  regionCode: z.string().length(2),
  userAge: z.number().int().min(0).max(150).optional(),
  language: z.string().default('en')
});

const ModerationRequestSchema = z.object({
  content: z.string().min(1).max(500),
  contentType: z.enum(['nickname', 'guild_name', 'message']).default('message'),
  language: z.string().default('zh'),
  regionCode: z.string().length(2).optional()
});

const ComplianceCheckSchema = z.object({
  regionCode: z.string().length(2),
  userAge: z.number().int().min(0).max(150).optional(),
  paymentAmount: z.number().positive().optional()
});

// ── POST /api/v2/cultural/filter ───────────────────────────────
// 过滤实体列表（文化敏感内容）
router.post('/filter', async (req, res, next) => {
  try {
    const { entities, regionCode, userAge, language } = FilterRequestSchema.parse(req.body);
    
    const filter = getCulturalContentFilter();
    const filteredEntities = await filter.filterEntities(entities, regionCode, userAge, language);
    
    logger.info({
      regionCode,
      inputCount: entities.length,
      outputCount: filteredEntities.length,
      userAge
    }, 'Cultural filtering completed');
    
    res.json(successResp({
      regionCode,
      language,
      filtered: entities.length - filteredEntities.length,
      modified: filteredEntities.filter(e => e.localized || e.cultural_warning).length,
      entities: filteredEntities
    }, '内容过滤完成'));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(errorResp(1001, '请求参数错误', err.errors));
    }
    next(err);
  }
});

// ── GET /api/v2/cultural/check-entity ───────────────────────────
// 检查单个实体是否受地区限制
router.get('/check-entity', async (req, res, next) => {
  try {
    const { entityType, entityId, regionCode } = req.query;
    
    if (!entityType || !entityId || !regionCode) {
      throw new AppError(1001, '缺少必要参数', 400);
    }
    
    const filter = getCulturalContentFilter();
    const restriction = await filter.checkEntityRestriction(entityType, parseInt(entityId), regionCode);
    
    res.json(successResp({
      entityType,
      entityId: parseInt(entityId),
      regionCode,
      restriction
    }));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/v2/cultural/activity-status ────────────────────────
// 检查活动是否在地区启用
router.get('/activity-status', async (req, res, next) => {
  try {
    const { activityId, regionCode } = req.query;
    
    if (!activityId || !regionCode) {
      throw new AppError(1001, '缺少必要参数', 400);
    }
    
    const filter = getCulturalContentFilter();
    const enabled = await filter.isActivityEnabled(parseInt(activityId), regionCode);
    
    res.json(successResp({
      activityId: parseInt(activityId),
      regionCode,
      enabled
    }));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v2/cultural/moderate ───────────────────────────────
// 审核用户生成内容
router.post('/moderate', async (req, res, next) => {
  try {
    const { content, contentType, language, regionCode } = ModerationRequestSchema.parse(req.body);
    
    const moderator = getCulturalContentModerator();
    const result = await moderator.moderateUserContent(
      content,
      language,
      regionCode || 'CN',
      contentType
    );
    
    logger.info({
      contentType,
      language,
      regionCode,
      action: result.action,
      severity: result.severity
    }, 'Content moderation completed');
    
    res.json(successResp({
      passed: result.passed,
      action: result.action,
      originalContent: result.originalContent,
      filteredContent: result.filteredContent,
      detectedViolations: result.detected,
      severity: result.severity,
      warning: result.warning
    }, result.passed ? '内容审核通过' : '内容审核失败'));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(errorResp(1001, '请求参数错误', err.errors));
    }
    next(err);
  }
});

// ── POST /api/v2/compliance/check ───────────────────────────────
// 综合规规检查
router.post('/compliance/check', requireAuth, async (req, res, next) => {
  try {
    const { regionCode, userAge, paymentAmount } = ComplianceCheckSchema.parse(req.body);
    const userId = req.user.sub;
    
    const engine = getComplianceRuleEngine();
    const result = await engine.comprehensiveCheck(userId, regionCode, { userAge, paymentAmount });
    
    logger.info({
      userId,
      regionCode,
      compliant: result.compliant,
      failedChecks: result.failedChecks
    }, 'Compliance check completed');
    
    res.json(successResp(result, result.compliant ? '合规检查通过' : '合规检查失败'));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json(errorResp(1001, '请求参数错误', err.errors));
    }
    next(err);
  }
});

// ── GET /api/v2/compliance/payment-limit ────────────────────────
// 检查支付限制
router.get('/compliance/payment-limit', requireAuth, async (req, res, next) => {
  try {
    const { regionCode, amount, userAge } = req.query;
    const userId = req.user.sub;
    
    if (!regionCode || !amount) {
      throw new AppError(1001, '缺少必要参数', 400);
    }
    
    const engine = getComplianceRuleEngine();
    const result = await engine.checkPaymentLimit(
      userId,
      regionCode,
      parseFloat(amount),
      userAge ? parseInt(userAge) : null
    );
    
    res.json(successResp({
      allowed: result.allowed,
      reason: result.reason,
      maxAmount: result.maxAmount,
      remaining: result.remaining,
      message: result.message
    }));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/v2/compliance/playtime-limit ───────────────────────
// 检查游玩时间限制
router.get('/compliance/playtime-limit', requireAuth, async (req, res, next) => {
  try {
    const { regionCode, userAge } = req.query;
    const userId = req.user.sub;
    
    if (!regionCode) {
      throw new AppError(1001, '缺少地区参数', 400);
    }
    
    const engine = getComplianceRuleEngine();
    const result = await engine.checkPlaytimeLimit(
      userId,
      regionCode,
      userAge ? parseInt(userAge) : null
    );
    
    res.json(successResp({
      allowed: result.allowed,
      reason: result.reason,
      limitHours: result.limitHours,
      hoursPlayed: result.hoursPlayed,
      remainingHours: result.remainingHours,
      message: result.message
    }));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/v2/compliance/region-summary ───────────────────────
// 获取地区合规规则汇总
router.get('/compliance/region-summary', async (req, res, next) => {
  try {
    const { regionCode } = req.query;
    
    if (!regionCode) {
      throw new AppError(1001, '缺少地区参数', 400);
    }
    
    const engine = getComplianceRuleEngine();
    const summary = await engine.getRegionComplianceSummary(regionCode);
    
    res.json(successResp(summary));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/cultural/rules ───────────────────────────────
// 创建文化内容规则（管理员）
router.post('/admin/rules', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (!req.user.role || req.user.role !== 'admin') {
      throw new AppError(1003, '无管理员权限', 403);
    }
    
    const {
      entityType,
      entityId,
      contentField,
      sensitivityLevel,
      culturalContext,
      affectedRegions,
      restrictionType,
      alternativeContent
    } = req.body;
    
    const { rows: [rule] } = await query(`
      INSERT INTO cultural_content_rules (
        entity_type, entity_id, content_field, sensitivity_level,
        cultural_context, affected_regions, restriction_type, alternative_content
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
      RETURNING *
    `, [
      entityType,
      entityId,
      contentField,
      sensitivityLevel,
      culturalContext,
      JSON.stringify(affectedRegions),
      restrictionType,
      alternativeContent ? JSON.stringify(alternativeContent) : null
    ]);
    
    // 清除缓存
    const filter = getCulturalContentFilter();
    filter.clearCache();
    
    logger.info({
      adminId: req.user.sub,
      ruleId: rule.id,
      entityType,
      entityId
    }, 'Cultural rule created');
    
    res.json(successResp(rule, '文化规则创建成功'));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/cultural/restricted-entity ────────────────────
// 创建地区限制实体（管理员）
router.post('/admin/restricted-entity', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (!req.user.role || req.user.role !== 'admin') {
      throw new AppError(1003, '无管理员权限', 403);
    }
    
    const {
      entityType,
      entityId,
      regionCode,
      restrictionLevel,
      reason,
      alternativeContent,
      effectiveFrom,
      effectiveUntil
    } = req.body;
    
    const { rows: [entity] } = await query(`
      INSERT INTO region_restricted_entities (
        entity_type, entity_id, region_code, restriction_level,
        reason, alternative_content, effective_from, effective_until
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      ON CONFLICT (entity_type, entity_id, region_code) 
      DO UPDATE SET
        restriction_level = $4,
        reason = $5,
        alternative_content = $6::jsonb,
        effective_from = $7,
        effective_until = $8,
        updated_at = NOW()
      RETURNING *
    `, [
      entityType,
      entityId,
      regionCode,
      restrictionLevel,
      reason,
      alternativeContent ? JSON.stringify(alternativeContent) : null,
      effectiveFrom,
      effectiveUntil
    ]);
    
    // 清除缓存
    const filter = getCulturalContentFilter();
    filter.clearCache();
    
    logger.info({
      adminId: req.user.sub,
      entityId: entity.id,
      entityType,
      entityId,
      regionCode
    }, 'Restricted entity created/updated');
    
    res.json(successResp(entity, '地区限制实体创建/更新成功'));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/compliance/rules ───────────────────────────────
// 创建合规规则（管理员）
router.post('/admin/compliance/rules', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (!req.user.role || req.user.role !== 'admin') {
      throw new AppError(1003, '无管理员权限', 403);
    }
    
    const {
      regionCode,
      ruleType,
      ruleConfig,
      effectiveFrom,
      isActive
    } = req.body;
    
    const { rows: [rule] } = await query(`
      INSERT INTO compliance_rules (
        region_code, rule_type, rule_config, effective_from, is_active
      ) VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (region_code, rule_type)
      DO UPDATE SET
        rule_config = $3::jsonb,
        effective_from = $4,
        is_active = $5,
        updated_at = NOW()
      RETURNING *
    `, [
      regionCode,
      ruleType,
      JSON.stringify(ruleConfig),
      effectiveFrom,
      isActive ?? true
    ]);
    
    // 清除缓存
    const engine = getComplianceRuleEngine();
    engine.clearCache();
    
    logger.info({
      adminId: req.user.sub,
      regionCode,
      ruleType
    }, 'Compliance rule created/updated');
    
    res.json(successResp(rule, '合规规则创建/更新成功'));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/cultural/moderation-stats ───────────────────────
// 获取审核统计（管理员）
router.get('/admin/moderation-stats', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (!req.user.role || req.user.role !== 'admin') {
      throw new AppError(1003, '无管理员权限', 403);
    }
    
    const { days } = req.query;
    const moderator = getCulturalContentModerator();
    const stats = await moderator.getModerationStats(parseInt(days) || 7);
    
    res.json(successResp({
      period: `${days || 7} days`,
      stats
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;