/**
 * 重复问题检测器
 * 检测玩家反馈中的重复问题
 */

const db = require('../db');
const logger = require('../logger');

class DuplicateDetector {
  constructor() {
    this.similarityThreshold = 0.75;
    this.minWordLength = 2;
  }

  /**
   * 检测重复反馈
   * @param {string} text - 反馈文本
   * @param {string} feedbackType - 反馈类型
   * @returns {Object} 检测结果
   */
  async check(text, feedbackType) {
    try {
      // 查找同类型的近期反馈
      const result = await db.query(`
        SELECT id, title, content, status, created_at, sentiment
        FROM player_feedbacks
        WHERE feedback_type = $1
          AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
        LIMIT 100
      `, [feedbackType]);

      const candidates = result.rows;
      
      if (candidates.length === 0) {
        return {
          isDuplicate: false,
          duplicate_of: null,
          confidence: 0,
          similar_feedbacks: []
        };
      }

      // 计算相似度
      const similarities = [];
      
      for (const candidate of candidates) {
        const combinedText = `${candidate.title || ''} ${candidate.content}`;
        const sim = this.calculateSimilarity(text, combinedText);
        
        if (sim > 0.5) {
          similarities.push({
            id: candidate.id,
            similarity: sim,
            status: candidate.status,
            created_at: candidate.created_at,
            sentiment: candidate.sentiment
          });
        }
      }

      // 排序并找出最相似的
      similarities.sort((a, b) => b.similarity - a.similarity);

      const topMatch = similarities[0];
      const isDuplicate = topMatch && topMatch.similarity >= this.similarityThreshold;

      return {
        isDuplicate,
        duplicate_of: isDuplicate ? topMatch.id : null,
        confidence: topMatch?.similarity || 0,
        similar_feedbacks: similarities.slice(0, 5)
      };
    } catch (error) {
      logger.error('Duplicate detection error:', error);
      return {
        isDuplicate: false,
        duplicate_of: null,
        confidence: 0,
        similar_feedbacks: []
      };
    }
  }

  /**
   * 计算文本相似度 (余弦相似度)
   */
  calculateSimilarity(text1, text2) {
    const tokens1 = this.tokenize(text1);
    const tokens2 = this.tokenize(text2);

    if (tokens1.length === 0 || tokens2.length === 0) {
      return 0;
    }

    // 构建词频向量
    const allTokens = new Set([...tokens1, ...tokens2]);
    const vector1 = [];
    const vector2 = [];

    for (const token of allTokens) {
      vector1.push(tokens1.filter(t => t === token).length);
      vector2.push(tokens2.filter(t => t === token).length);
    }

    // 计算余弦相似度
    const dotProduct = vector1.reduce((sum, v, i) => sum + v * vector2[i], 0);
    const magnitude1 = Math.sqrt(vector1.reduce((sum, v) => sum + v * v, 0));
    const magnitude2 = Math.sqrt(vector2.reduce((sum, v) => sum + v * v, 0));

    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    return dotProduct / (magnitude1 * magnitude2);
  }

  /**
   * 分词
   */
  tokenize(text) {
    if (!text) return [];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= this.minWordLength);
  }

  /**
   * 查找相似反馈
   */
  async findSimilar(feedbackId, limit = 5) {
    try {
      // 获取当前反馈
      const currentResult = await db.query(`
        SELECT title, content, feedback_type
        FROM player_feedbacks
        WHERE id = $1
      `, [feedbackId]);

      if (currentResult.rows.length === 0) {
        return [];
      }

      const current = currentResult.rows[0];
      const currentText = `${current.title || ''} ${current.content}`;

      // 查找相似反馈
      const result = await db.query(`
        SELECT id, title, content, status, created_at
        FROM player_feedbacks
        WHERE feedback_type = $1
          AND id != $2
          AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
        LIMIT 50
      `, [current.feedback_type, feedbackId]);

      const similarities = [];
      
      for (const row of result.rows) {
        const text = `${row.title || ''} ${row.content}`;
        const sim = this.calculateSimilarity(currentText, text);
        
        if (sim > 0.5) {
          similarities.push({
            id: row.id,
            title: row.title,
            similarity: sim,
            status: row.status,
            created_at: row.created_at
          });
        }
      }

      return similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } catch (error) {
      logger.error('Find similar feedbacks error:', error);
      return [];
    }
  }

  /**
   * 合并重复反馈
   */
  async mergeDuplicates(sourceId, targetId) {
    try {
      await db.query('BEGIN');

      // 更新源反馈状态为已合并
      await db.query(`
        UPDATE player_feedbacks
        SET status = 'closed',
            resolution = '已合并到 #' || $1,
            updated_at = NOW()
        WHERE id = $2
      `, [targetId, sourceId]);

      // 记录分析结果
      await db.query(`
        INSERT INTO feedback_analysis (feedback_id, analysis_type, result, confidence)
        VALUES ($1, 'duplicate_merge', $2, 1.0)
      `, [sourceId, JSON.stringify({ merged_into: targetId })]);

      await db.query('COMMIT');

      logger.info(`Merged feedback ${sourceId} into ${targetId}`);
      return true;
    } catch (error) {
      await db.query('ROLLBACK');
      logger.error('Merge duplicates error:', error);
      return false;
    }
  }

  /**
   * 批量检测重复
   */
  async batchCheck(items) {
    return Promise.all(
      items.map(item => this.check(item.text, item.type))
    );
  }
}

module.exports = new DuplicateDetector();
