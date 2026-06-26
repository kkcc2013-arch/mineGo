/**
 * 反馈控制器
 * REQ-00339: 玩家反馈收集与智能分析系统
 */

const db = require('../../../shared/db');
const logger = require('../../../shared/logger');
const sentimentAnalyzer = require('../../../shared/ai/sentimentAnalyzer');
const feedbackClassifier = require('../../../shared/ai/feedbackClassifier');
const duplicateDetector = require('../../../shared/ai/duplicateDetector');
const notificationService = require('../../../shared/services/notificationService');

class FeedbackController {
  /**
   * 提交反馈
   */
  async submitFeedback(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false,
          errors: errors.array() 
        });
      }

      const userId = req.user.id;
      const { 
        feedback_type, 
        title, 
        content, 
        category, 
        tags, 
        attachments,
        pokemon_id,
        battle_id,
        location_lat,
        location_lng
      } = req.body;

      // 收集设备信息
      const deviceInfo = {
        platform: req.headers['x-platform'] || 'unknown',
        app_version: req.headers['x-app-version'] || '',
        os_version: req.headers['x-os-version'] || '',
        device_model: req.headers['x-device-model'] || ''
      };

      // 并行执行 AI 分析
      const [sentimentResult, classification, duplicateCheck] = await Promise.all([
        sentimentAnalyzer.analyze(content),
        feedbackClassifier.classify(content, feedback_type),
        duplicateDetector.check(content, feedback_type)
      ]);

      // 确定最终分类
      const finalCategory = category || classification.category;
      
      // 计算优先级
      const priority = this.calculatePriority(
        sentimentResult, 
        feedback_type, 
        classification.suggested_priority
      );

      // 创建反馈
      const result = await db.query(`
        INSERT INTO player_feedbacks (
          user_id, feedback_type, title, content, category, tags,
          priority, sentiment, sentiment_score, device_info,
          app_version, os_version, attachments, pokemon_id, battle_id,
          location_lat, location_lng
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *
      `, [
        userId, 
        feedback_type, 
        title || null, 
        content, 
        finalCategory, 
        tags || [],
        priority,
        sentimentResult.label,
        sentimentResult.score,
        JSON.stringify(deviceInfo),
        deviceInfo.app_version,
        deviceInfo.os_version,
        JSON.stringify(attachments || []),
        pokemon_id || null,
        battle_id || null,
        location_lat || null,
        location_lng || null
      ]);

      const feedback = result.rows[0];

      // 记录分析结果
      await db.query(`
        INSERT INTO feedback_analysis (feedback_id, analysis_type, result, confidence)
        VALUES 
          ($1, 'sentiment', $2, $3),
          ($1, 'classification', $4, $5)
      `, [
        feedback.id,
        JSON.stringify(sentimentResult),
        sentimentResult.confidence,
        JSON.stringify(classification),
        classification.confidence
      ]);

      // 如果检测到重复，记录关联
      if (duplicateCheck.isDuplicate) {
        await db.query(`
          INSERT INTO feedback_analysis (feedback_id, analysis_type, result, confidence)
          VALUES ($1, 'duplicate_check', $2, $3)
        `, [feedback.id, JSON.stringify(duplicateCheck), duplicateCheck.confidence]);
      }

      // 记录工作流日志
      await this.logWorkflow(feedback.id, 'created', null, 'pending', userId);

      // 触发通知
      this.notifyFeedback(feedback).catch(err => 
        logger.error('Feedback notification error:', err)
      );

      logger.info(`Feedback submitted: #${feedback.id} by user ${userId}`);

      res.status(201).json({
        success: true,
        data: {
          feedback_id: feedback.id,
          status: feedback.status,
          category: finalCategory,
          sentiment: sentimentResult.label,
          priority,
          is_duplicate: duplicateCheck.isDuplicate,
          created_at: feedback.created_at
        }
      });
    } catch (error) {
      logger.error('Submit feedback error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to submit feedback' 
      });
    }
  }

  /**
   * 计算优先级
   */
  calculatePriority(sentimentResult, feedbackType, suggestedPriority) {
    // 极端负面 + Bug = critical
    if (feedbackType === 'bug' && sentimentResult.label === 'very_negative') {
      return 'critical';
    }
    // 高负面 + Bug = high
    if (feedbackType === 'bug' && sentimentResult.label === 'negative') {
      return 'high';
    }
    // 投诉 + 高负面 = high
    if (feedbackType === 'complaint' && 
        (sentimentResult.label === 'very_negative' || sentimentResult.label === 'negative')) {
      return 'high';
    }
    // 支付问题
    if (suggestedPriority === 'high') {
      return 'high';
    }
    return suggestedPriority || 'normal';
  }

  /**
   * 获取用户反馈历史
   */
  async getUserFeedbacks(req, res) {
    try {
      const userId = req.user.id;
      const { status, type, limit = 20, offset = 0 } = req.query;

      let query = `
        SELECT id, feedback_type, title, content, category, status, priority,
               sentiment, created_at, updated_at, resolved_at
        FROM player_feedbacks
        WHERE user_id = $1
      `;
      const params = [userId];
      let paramIndex = 2;

      if (status) {
        query += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (type) {
        query += ` AND feedback_type = $${paramIndex}`;
        params.push(type);
        paramIndex++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await db.query(query, params);

      // 获取总数
      const countResult = await db.query(`
        SELECT COUNT(*) as total
        FROM player_feedbacks
        WHERE user_id = $1
      `, [userId]);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          limit,
          offset
        }
      });
    } catch (error) {
      logger.error('Get user feedbacks error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to get feedbacks' 
      });
    }
  }

  /**
   * 获取反馈详情
   */
  async getFeedbackDetail(req, res) {
    try {
      const userId = req.user.id;
      const feedbackId = req.params.id;

      const result = await db.query(`
        SELECT f.*, 
               json_agg(
                 json_build_object(
                   'type', fa.analysis_type, 
                   'result', fa.result, 
                   'confidence', fa.confidence
                 )
               ) FILTER (WHERE fa.id IS NOT NULL) as analyses
        FROM player_feedbacks f
        LEFT JOIN feedback_analysis fa ON fa.feedback_id = f.id
        WHERE f.id = $1 AND f.user_id = $2
        GROUP BY f.id
      `, [feedbackId, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'Feedback not found' 
        });
      }

      // 获取相似反馈
      const similarFeedbacks = await duplicateDetector.findSimilar(feedbackId, 3);

      res.json({
        success: true,
        data: {
          ...result.rows[0],
          similar_feedbacks: similarFeedbacks
        }
      });
    } catch (error) {
      logger.error('Get feedback detail error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to get feedback detail' 
      });
    }
  }

  /**
   * 更新反馈
   */
  async updateFeedback(req, res) {
    try {
      const userId = req.user.id;
      const feedbackId = req.params.id;
      const { content, tags, attachments } = req.body;

      // 检查反馈是否存在且属于当前用户
      const checkResult = await db.query(`
        SELECT id, status FROM player_feedbacks
        WHERE id = $1 AND user_id = $2
      `, [feedbackId, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'Feedback not found' 
        });
      }

      // 只允许更新待处理状态的反馈
      if (checkResult.rows[0].status !== 'pending') {
        return res.status(400).json({ 
          success: false,
          error: 'Cannot update feedback that is already being processed' 
        });
      }

      // 更新
      const updateFields = [];
      const params = [feedbackId];
      let paramIndex = 2;

      if (content) {
        updateFields.push(`content = $${paramIndex}`);
        params.push(content);
        paramIndex++;
      }

      if (tags) {
        updateFields.push(`tags = $${paramIndex}`);
        params.push(tags);
        paramIndex++;
      }

      if (attachments) {
        updateFields.push(`attachments = $${paramIndex}`);
        params.push(JSON.stringify(attachments));
        paramIndex++;
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ 
          success: false,
          error: 'No fields to update' 
        });
      }

      const result = await db.query(`
        UPDATE player_feedbacks
        SET ${updateFields.join(', ')}
        WHERE id = $1
        RETURNING *
      `, params);

      // 记录日志
      await this.logWorkflow(feedbackId, 'updated', 'pending', 'pending', userId);

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      logger.error('Update feedback error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to update feedback' 
      });
    }
  }

  /**
   * 取消反馈
   */
  async cancelFeedback(req, res) {
    try {
      const userId = req.user.id;
      const feedbackId = req.params.id;

      // 检查反馈
      const checkResult = await db.query(`
        SELECT id, status FROM player_feedbacks
        WHERE id = $1 AND user_id = $2
      `, [feedbackId, userId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'Feedback not found' 
        });
      }

      // 只允许取消待处理的反馈
      if (checkResult.rows[0].status !== 'pending') {
        return res.status(400).json({ 
          success: false,
          error: 'Cannot cancel feedback that is already being processed' 
        });
      }

      // 删除反馈
      await db.query(`
        DELETE FROM player_feedbacks WHERE id = $1
      `, [feedbackId]);

      res.json({
        success: true,
        message: 'Feedback cancelled successfully'
      });
    } catch (error) {
      logger.error('Cancel feedback error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to cancel feedback' 
      });
    }
  }

  /**
   * 获取反馈标签列表
   */
  async getFeedbackTags(req, res) {
    try {
      const result = await db.query(`
        SELECT name, category, usage_count
        FROM feedback_tags
        WHERE is_active = true
        ORDER BY usage_count DESC, name ASC
      `);

      // 按类别分组
      const tagsByCategory = {};
      for (const row of result.rows) {
        if (!tagsByCategory[row.category]) {
          tagsByCategory[row.category] = [];
        }
        tagsByCategory[row.category].push(row.name);
      }

      res.json({
        success: true,
        data: result.rows.map(r => r.name),
        by_category: tagsByCategory
      });
    } catch (error) {
      logger.error('Get feedback tags error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to get tags' 
      });
    }
  }

  /**
   * 获取FAQ
   */
  async getFAQ(req, res) {
    try {
      const { category, keyword } = req.query;

      let query = `
        SELECT id, question, answer, category, keywords, view_count, helpful_count
        FROM feedback_faq
        WHERE is_active = true
      `;
      const params = [];

      if (category) {
        query += ` AND category = $1`;
        params.push(category);
      }

      if (keyword) {
        query += ` AND (question ILIKE $${params.length + 1} OR answer ILIKE $${params.length + 1})`;
        params.push(`%${keyword}%`);
      }

      query += ` ORDER BY view_count DESC, helpful_count DESC LIMIT 20`;

      const result = await db.query(query, params);

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      logger.error('Get FAQ error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to get FAQ' 
      });
    }
  }

  /**
   * 标记FAQ有帮助
   */
  async markFAQHelpful(req, res) {
    try {
      const faqId = req.params.id;

      await db.query(`
        UPDATE feedback_faq
        SET helpful_count = helpful_count + 1
        WHERE id = $1
      `, [faqId]);

      res.json({
        success: true,
        message: 'Thank you for your feedback'
      });
    } catch (error) {
      logger.error('Mark FAQ helpful error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to mark FAQ' 
      });
    }
  }

  /**
   * 获取用户反馈统计
   */
  async getUserStats(req, res) {
    try {
      const userId = req.user.id;

      const result = await db.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
          COUNT(*) FILTER (WHERE status = 'closed') as closed,
          COUNT(*) FILTER (WHERE feedback_type = 'bug') as bugs,
          COUNT(*) FILTER (WHERE feedback_type = 'suggestion') as suggestions,
          COUNT(*) FILTER (WHERE feedback_type = 'complaint') as complaints
        FROM player_feedbacks
        WHERE user_id = $1
      `, [userId]);

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      logger.error('Get user stats error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to get stats' 
      });
    }
  }

  /**
   * 记录工作流日志
   */
  async logWorkflow(feedbackId, action, fromStatus, toStatus, operatorId, comment = null) {
    try {
      await db.query(`
        INSERT INTO feedback_workflow_logs 
        (feedback_id, action, from_status, to_status, operator_id, comment)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [feedbackId, action, fromStatus, toStatus, operatorId, comment]);
    } catch (error) {
      logger.error('Log workflow error:', error);
    }
  }

  /**
   * 发送通知
   */
  async notifyFeedback(feedback) {
    // 紧急反馈立即通知
    if (feedback.priority === 'critical') {
      await notificationService.sendAlert({
        type: 'urgent_feedback',
        data: feedback
      });
    }
  }
}

module.exports = new FeedbackController();
