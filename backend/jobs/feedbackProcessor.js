/**
 * 反馈处理 Worker
 * REQ-00339: 玩家反馈收集与智能分析系统
 * 异步处理反馈相关的后台任务
 */

const db = require('../shared/db');
const logger = require('../shared/logger');
const Kafka = require('kafkajs').Kafka;

class FeedbackProcessor {
  constructor() {
    this.kafka = null;
    this.producer = null;
    this.consumer = null;
    this.isRunning = false;
  }

  /**
   * 初始化 Kafka 连接
   */
  async init() {
    try {
      if (process.env.KAFKA_BROKERS) {
        this.kafka = new Kafka({
          brokers: process.env.KAFKA_BROKERS.split(','),
          clientId: 'feedback-processor'
        });

        this.producer = this.kafka.producer();
        this.consumer = this.kafka.consumer({ groupId: 'feedback-processor-group' });

        await this.producer.connect();
        await this.consumer.connect();
        
        logger.info('Feedback processor Kafka connected');
      }
    } catch (error) {
      logger.warn('Kafka not available, using local queue:', error.message);
    }
  }

  /**
   * 启动处理器
   */
  async start() {
    await this.init();

    if (this.consumer) {
      try {
        await this.consumer.subscribe({ 
          topic: 'feedback-processing', 
          fromBeginning: false 
        });

        await this.consumer.run({
          eachMessage: async ({ message }) => {
            try {
              const data = JSON.parse(message.value.toString());
              await this.processFeedback(data.feedback_id);
            } catch (error) {
              logger.error('Process message error:', error);
            }
          }
        });

        this.isRunning = true;
        logger.info('Feedback processor started');
      } catch (error) {
        logger.error('Start consumer error:', error);
      }
    } else {
      // 没有 Kafka 时使用定时轮询
      this.startPolling();
    }
  }

  /**
   * 轮询模式
   */
  startPolling() {
    this.isRunning = true;
    
    const poll = async () => {
      if (!this.isRunning) return;

      try {
        // 处理待处理的反馈
        await this.processPendingFeedbacks();
      } catch (error) {
        logger.error('Poll error:', error);
      }

      // 每5分钟执行一次
      setTimeout(poll, 5 * 60 * 1000);
    };

    poll();
    logger.info('Feedback processor started in polling mode');
  }

  /**
   * 处理单个反馈
   */
  async processFeedback(feedbackId) {
    try {
      logger.info(`Processing feedback #${feedbackId}`);

      // 获取反馈详情
      const result = await db.query(`
        SELECT f.*, u.email, u.language
        FROM player_feedbacks f
        JOIN users u ON f.user_id = u.id
        WHERE f.id = $1
      `, [feedbackId]);

      const feedback = result.rows[0];
      if (!feedback) {
        logger.warn(`Feedback #${feedbackId} not found`);
        return;
      }

      // 自动分配处理人
      await this.autoAssign(feedback);

      // 紧急反馈立即通知
      if (feedback.priority === 'critical') {
        await this.notifyUrgentFeedback(feedback);
      }

      // 更新标签使用统计
      await this.updateTagStats(feedback.tags);

      logger.info(`Feedback #${feedbackId} processed`);
    } catch (error) {
      logger.error(`Process feedback #${feedbackId} error:`, error);
    }
  }

  /**
   * 处理待处理的反馈
   */
  async processPendingFeedbacks() {
    try {
      // 获取最近创建的待处理反馈
      const result = await db.query(`
        SELECT id FROM player_feedbacks
        WHERE status = 'pending'
          AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at ASC
        LIMIT 100
      `);

      for (const row of result.rows) {
        await this.processFeedback(row.id);
      }
    } catch (error) {
      logger.error('Process pending feedbacks error:', error);
    }
  }

  /**
   * 自动分配处理人
   */
  async autoAssign(feedback) {
    try {
      // 根据反馈类别自动分配给对应的团队成员
      const categoryAssignments = {
        performance: 'performance-team',
        balance: 'game-design-team',
        ui: 'ui-team',
        gameplay: 'gameplay-team',
        social: 'social-team',
        payment: 'payment-support-team',
        account: 'account-support-team'
      };

      const teamKey = categoryAssignments[feedback.category];
      
      if (!teamKey) return;

      // 查找该团队的成员
      const teamResult = await db.query(`
        SELECT u.id
        FROM users u
        JOIN user_roles ur ON u.id = ur.user_id
        JOIN roles r ON ur.role_id = r.id
        WHERE r.name = $1
          AND u.is_active = true
        ORDER BY RANDOM()
        LIMIT 1
      `, [teamKey]);

      if (teamResult.rows.length > 0) {
        const assigneeId = teamResult.rows[0].id;

        await db.query(`
          UPDATE player_feedbacks
          SET assigned_to = $1,
              status = 'in_progress',
              updated_at = NOW()
          WHERE id = $2 AND status = 'pending'
        `, [assigneeId, feedback.id]);

        // 记录日志
        await db.query(`
          INSERT INTO feedback_workflow_logs 
          (feedback_id, action, from_status, to_status, operator_id, comment)
          VALUES ($1, 'auto_assign', 'pending', 'in_progress', NULL, $2)
        `, [feedback.id, `Auto assigned to team member`]);

        logger.info(`Feedback #${feedback.id} auto-assigned to user ${assigneeId}`);
      }
    } catch (error) {
      logger.error('Auto assign error:', error);
    }
  }

  /**
   * 通知紧急反馈
   */
  async notifyUrgentFeedback(feedback) {
    try {
      logger.warn(`URGENT FEEDBACK #${feedback.id}: ${feedback.title || feedback.content.substring(0, 100)}`);

      // 可以在这里集成 Slack、邮件、短信等通知
      // 示例：发送 Slack 通知
      if (process.env.SLACK_WEBHOOK_URL) {
        const fetch = require('node-fetch');
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🚨 紧急反馈 #${feedback.id}`,
            attachments: [{
              color: 'danger',
              fields: [
                { title: '类型', value: feedback.feedback_type, short: true },
                { title: '分类', value: feedback.category, short: true },
                { title: '内容', value: feedback.content.substring(0, 300), short: false }
              ]
            }]
          })
        });
      }
    } catch (error) {
      logger.error('Notify urgent feedback error:', error);
    }
  }

  /**
   * 更新标签统计
   */
  async updateTagStats(tags) {
    if (!tags || tags.length === 0) return;

    try {
      await db.query(`
        UPDATE feedback_tags
        SET usage_count = usage_count + 1
        WHERE name = ANY($1)
      `, [tags]);
    } catch (error) {
      logger.error('Update tag stats error:', error);
    }
  }

  /**
   * 发送反馈处理任务
   */
  async queueFeedbackProcessing(feedbackId) {
    try {
      if (this.producer) {
        await this.producer.send({
          topic: 'feedback-processing',
          messages: [{
            key: feedbackId.toString(),
            value: JSON.stringify({
              feedback_id: feedbackId,
              timestamp: Date.now()
            })
          }]
        });
      } else {
        // 直接处理
        await this.processFeedback(feedbackId);
      }
    } catch (error) {
      logger.error('Queue feedback processing error:', error);
      // 回退到直接处理
      await this.processFeedback(feedbackId);
    }
  }

  /**
   * 生成日报
   */
  async generateDailyReport() {
    try {
      const result = await db.query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE feedback_type = 'bug') as bugs,
          COUNT(*) FILTER (WHERE feedback_type = 'suggestion') as suggestions,
          COUNT(*) FILTER (WHERE feedback_type = 'complaint') as complaints,
          COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours
        FROM player_feedbacks
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY DATE(created_at)
      `);

      if (result.rows.length > 0) {
        const stats = result.rows[0];
        logger.info('Daily Feedback Report:', stats);
        
        // 可以发送邮件或推送通知
        return stats;
      }

      return null;
    } catch (error) {
      logger.error('Generate daily report error:', error);
      return null;
    }
  }

  /**
   * 停止处理器
   */
  async stop() {
    this.isRunning = false;

    if (this.consumer) {
      await this.consumer.disconnect();
    }

    if (this.producer) {
      await this.producer.disconnect();
    }

    logger.info('Feedback processor stopped');
  }
}

// 单例
const feedbackProcessor = new FeedbackProcessor();

module.exports = feedbackProcessor;
