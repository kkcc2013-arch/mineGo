/**
 * 团伙检测 API 路由
 * REQ-00550: 协同作弊团伙检测系统
 */

'use strict';

const express = require('express');
const router = express.Router();
const { GangDetectionEngine, GangActionEngine } = require('../../shared/gangDetection');

const detectionEngine = new GangDetectionEngine();
const actionEngine = new GangActionEngine();

/**
 * POST /api/v1/gang/analyze
 * 分析用户是否属于作弊团伙
 */
router.post('/analyze', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    // 构建时空共现图谱
    const graph = await detectionEngine.buildSpatioTemporalGraph(userId);
    
    // 检测团伙
    const gangs = await detectionEngine.detectGangs(graph);
    
    // 获取用户团伙信息
    const gangInfo = await detectionEngine.getUserGangInfo(userId);

    res.json({
      success: true,
      data: {
        userId,
        cooccurrences: Object.fromEntries(graph),
        detectedGangs: gangs.map(g => ({
          members: g.members,
          density: g.density,
          riskScore: detectionEngine.calculateGangRiskScore(g)
        })),
        gangMembership: gangInfo
      }
    });
  } catch (error) {
    console.error('Gang analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/gang/:gangId
 * 获取团伙详情
 */
router.get('/:gangId', async (req, res) => {
  try {
    const { gangId } = req.params;
    
    const details = await detectionEngine.getGangDetails(gangId);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Gang not found'
      });
    }

    res.json({
      success: true,
      data: details
    });
  } catch (error) {
    console.error('Get gang details error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/gang/:gangId/members
 * 获取团伙成员列表
 */
router.get('/:gangId/members', async (req, res) => {
  try {
    const { gangId } = req.params;
    const details = await detectionEngine.getGangDetails(gangId);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Gang not found'
      });
    }

    res.json({
      success: true,
      data: {
        members: details.members || []
      }
    });
  } catch (error) {
    console.error('Get gang members error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/gang/:gangId/events
 * 获取团伙作弊事件
 */
router.get('/:gangId/events', async (req, res) => {
  try {
    const { gangId } = req.params;
    const details = await detectionEngine.getGangDetails(gangId);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Gang not found'
      });
    }

    res.json({
      success: true,
      data: {
        events: details.events || []
      }
    });
  } catch (error) {
    console.error('Get gang events error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/v1/gang/:gangId/action
 * 对团伙执行处置（需 admin 权限）
 */
router.post('/:gangId/action', async (req, res) => {
  try {
    // TODO: 添加 admin 权限验证
    const { gangId } = req.params;
    const { action, reason } = req.body;
    
    if (!['monitor', 'restrict', 'restrict_hard', 'ban'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be one of: monitor, restrict, restrict_hard, ban'
      });
    }

    const details = await detectionEngine.getGangDetails(gangId);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Gang not found'
      });
    }

    const result = await actionEngine.executeAction(details, action);

    res.json({
      success: result.success,
      data: {
        gangId,
        action,
        results: result.results || [],
        latencyMs: result.latencyMs
      }
    });
  } catch (error) {
    console.error('Execute gang action error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/gang/stats
 * 获取团伙统计数据（需 admin 权限）
 */
router.get('/stats', async (req, res) => {
  try {
    // TODO: 添加 admin 权限验证
    const result = await detectionEngine.db.query(`
      SELECT 
        COUNT(*) as total_gangs,
        COUNT(*) FILTER (WHERE status = 'active') as active_gangs,
        COUNT(*) FILTER (WHERE risk_level = 'critical') as critical_gangs,
        COUNT(*) FILTER (WHERE risk_level = 'high') as high_risk_gangs,
        AVG(risk_score) as avg_risk_score
      FROM cheating_gangs
    `);

    const topGangsResult = await detectionEngine.db.query(`
      SELECT gang_id, name, risk_score, risk_level, member_count
      FROM cheating_gangs
      WHERE status = 'active'
      ORDER BY risk_score DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        topGangs: topGangsResult.rows
      }
    });
  } catch (error) {
    console.error('Get gang stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;