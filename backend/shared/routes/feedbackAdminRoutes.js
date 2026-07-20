/**
 * 反馈分析服务（管理员后台）
 * REQ-00339: 玩家反馈收集与智能分析系统
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const auth = require('../auth');
const adminAuth = require('../middleware/adminAuth');

/**
 * 获取反馈统计概览
 * GET /api/admin/feedback/stats
 */
router.get('/stats', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    // 总体统计
    const statsResult = await db.query(`SELECT * FROM v_feedback_stats`);
    
    // 按类型统计
    const byTypeResult = await db.query(`
      SELECT feedback_type, COUNT(*) as count
      FROM player_feedbacks
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY feedback_type
    `);

    // 按分类统计
    const byCategoryResult = await db.query(`
      SELECT category, COUNT(*) as count
      FROM player_feedbacks
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY category
      ORDER BY count DESC
    `);

    // 按情感统计
    const bySentimentResult = await db.query(`
      SELECT sentiment, COUNT(*) as count
      FROM player_feedbacks
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY sentiment
    `);

    // 趋势数据（最近7天）
    const trendResult = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved
      FROM player_feedbacks
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json({
      success: true,
      data: {
        overview: statsResult.rows[0],
        by_type: byTypeResult.rows,
        by_category: byCategoryResult.rows,
        by_sentiment: bySentimentResult.rows,
        trend: trendResult.rows
      }
    });
  } catch (error) {
    logger.error('Get feedback stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

/**
 * 获取反馈列表（分页、筛选）
 * GET /api/admin/feedback/list
 */
router.get('/list', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    const {
      status,
      type,
      category,
      priority,
      sentiment,
      search,
      start_date,
      end_date,
      sort = 'created_at',
      order = 'DESC',
      limit = 20,
      offset = 0
    } = req.query;

    let query = `
      SELECT f.*, u.username, u.email,
             assigned.username as assigned_username
      FROM player_feedbacks f
      JOIN users u ON f.user_id = u.id
      LEFT JOIN users assigned ON f.assigned_to = assigned.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // 筛选条件
    if (status) {
      query += ` AND f.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (type) {
      query += ` AND f.feedback_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (category) {
      query += ` AND f.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (priority) {
      query += ` AND f.priority = $${paramIndex}`;
      params.push(priority);
      paramIndex++;
    }

    if (sentiment) {
      query += ` AND f.sentiment = $${paramIndex}`;
      params.push(sentiment);
      paramIndex++;
    }

    if (search) {
      query += ` AND (f.title ILIKE $${paramIndex} OR f.content ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (start_date) {
      query += ` AND f.created_at >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND f.created_at <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    // 排序
    const allowedSorts = ['created_at', 'priority', 'status', 'sentiment_score'];
    const sortField = allowedSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY f.${sortField} ${sortOrder}`;

    // 分页
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // 获取总数
    let countQuery = `
      SELECT COUNT(*) as total
      FROM player_feedbacks f
      WHERE 1=1
    `;
    const countParams = params.slice(0, paramIndex - 1);
    
    if (countParams.length > 0) {
      countQuery += query.split('WHERE 1=1')[1].split('ORDER BY')[0];
    }

    const countResult = await db.query(countQuery, countParams);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error('Get feedback list error:', error);
    res.status(500).json({ success: false, error: 'Failed to get feedback list' });
  }
});

/**
 * 更新反馈状态
 * PATCH /api/admin/feedback/:id/status
 */
router.patch('/:id/status', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assigned_to, resolution } = req.body;
    const adminId = req.user.id;

    // 验证状态
    const validStatuses = ['pending', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }

    // 获取当前状态
    const currentResult = await db.query(`
      SELECT status, assigned_to FROM player_feedbacks WHERE id = $1
    `, [id]);

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Feedback not found' });
    }

    const currentStatus = currentResult.rows[0].status;

    // 更新反馈
    const updateFields = ['status = $1', 'updated_at = NOW()'];
    const params = [status, id];
    let paramIndex = 3;

    if (assigned_to !== undefined) {
      updateFields.push(`assigned_to = $${paramIndex}`);
      params.push(assigned_to);
      paramIndex++;
    }

    if (status === 'resolved' && resolution) {
      updateFields.push(`resolution = $${paramIndex}`);
      params.push(resolution);
      paramIndex++;
      updateFields.push(`resolved_at = NOW()`);
    }

    await db.query(`
      UPDATE player_feedbacks
      SET ${updateFields.join(', ')}
      WHERE id = $2
    `, params);

    // 记录工作流日志
    await db.query(`
      INSERT INTO feedback_workflow_logs 
      (feedback_id, action, from_status, to_status, operator_id, comment)
      VALUES ($1, 'status_change', $2, $3, $4, $5)
    `, [id, currentStatus, status, adminId, resolution || null]);

    // 如果已解决，通知用户
    if (status === 'resolved') {
      await notifyUserFeedbackResolved(id);
    }

    res.json({
      success: true,
      message: 'Status updated successfully'
    });
  } catch (error) {
    logger.error('Update feedback status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

/**
 * 批量更新状态
 * POST /api/admin/feedback/batch-update
 */
router.post('/batch-update', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    const { ids, status, assigned_to } = req.body;
    const adminId = req.user.id;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid ids' });
    }

    // 更新
    const result = await db.query(`
      UPDATE player_feedbacks
      SET status = $1, 
          assigned_to = COALESCE($2, assigned_to),
          updated_at = NOW()
      WHERE id = ANY($3)
      RETURNING id
    `, [status, assigned_to || null, ids]);

    // 记录日志
    for (const row of result.rows) {
      await db.query(`
        INSERT INTO feedback_workflow_logs 
        (feedback_id, action, from_status, to_status, operator_id)
        VALUES ($1, 'batch_update', NULL, $2, $3)
      `, [row.id, status, adminId]);
    }

    res.json({
      success: true,
      message: `Updated ${result.rows.length} feedbacks`
    });
  } catch (error) {
    logger.error('Batch update error:', error);
    res.status(500).json({ success: false, error: 'Failed to batch update' });
  }
});

/**
 * 获取高频问题
 * GET /api/admin/feedback/top-issues
 */
router.get('/top-issues', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    const { days = 7, limit = 10 } = req.query;

    const result = await db.query(`
      SELECT 
        COALESCE(title, LEFT(content, 50)) as issue,
        category,
        feedback_type,
        sentiment,
        status,
        COUNT(*) as occurrence_count,
        ARRAY_AGG(DISTINCT id) as feedback_ids
      FROM player_feedbacks
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY COALESCE(title, LEFT(content, 50)), category, feedback_type, sentiment, status
      HAVING COUNT(*) >= 2
      ORDER BY occurrence_count DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('Get top issues error:', error);
    res.status(500).json({ success: false, error: 'Failed to get top issues' });
  }
});

/**
 * 导出反馈数据
 * GET /api/admin/feedback/export
 */
router.get('/export', auth.authenticate, adminAuth.requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date, format = 'json' } = req.query;

    const result = await db.query(`
      SELECT f.*, u.username, u.email
      FROM player_feedbacks f
      JOIN users u ON f.user_id = u.id
      WHERE f.created_at >= $1 AND f.created_at <= $2
      ORDER BY f.created_at DESC
    `, [start_date || '1970-01-01', end_date || '2100-01-01']);

    if (format === 'csv') {
      // 简单 CSV 导出
      const headers = ['ID', 'User', 'Type', 'Category', 'Title', 'Content', 'Status', 'Priority', 'Created'];
      const rows = result.rows.map(r => [
        r.id,
        r.username,
        r.feedback_type,
        r.category,
        r.title || '',
        r.content.replace(/"/g, '""'),
        r.status,
        r.priority,
        r.created_at
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=feedbacks.csv');
      res.send(csv);
    } else {
      res.json({
        success: true,
        data: result.rows
      });
    }
  } catch (error) {
    logger.error('Export feedback error:', error);
    res.status(500).json({ success: false, error: 'Failed to export' });
  }
});

/**
 * 通知用户反馈已解决
 */
async function notifyUserFeedbackResolved(feedbackId) {
  try {
    const result = await db.query(`
      SELECT f.id, f.title, f.resolution, u.id as user_id, u.email
      FROM player_feedbacks f
      JOIN users u ON f.user_id = u.id
      WHERE f.id = $1
    `, [feedbackId]);

    if (result.rows.length > 0) {
      const feedback = result.rows[0];
      // 可以在这里发送推送通知或邮件
      logger.info(`Notifying user ${feedback.user_id} about resolved feedback #${feedbackId}`);
    }
  } catch (error) {
    logger.error('Notify user error:', error);
  }
}

module.exports = router;
