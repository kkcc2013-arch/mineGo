# REQ-00339: 玩家反馈收集与智能分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00339 |
| 标题 | 玩家反馈收集与智能分析系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | user-service、pokemon-service、gateway、game-client、admin-dashboard、backend/shared、backend/jobs |
| 创建时间 | 2026-06-26 10:00 UTC |

## 需求描述

建立一个完整的玩家反馈收集与分析系统，使玩家能够便捷地提交游戏体验反馈、Bug 报告和功能建议，同时为运营和开发团队提供智能化的反馈分析工具，包括自动分类、情感分析、趋势识别等功能，帮助团队快速响应玩家需求并持续优化游戏体验。

### 核心功能

1. **多渠道反馈收集**
   - 游戏内反馈入口（主菜单、设置页面）
   - 快捷反馈按钮（战斗后、捕捉后）
   - 问题类型分类（Bug、建议、投诉、其他）
   - 标签选择系统（性能、平衡性、UI、玩法等）

2. **智能反馈分析**
   - 自动文本分类（机器学习模型）
   - 情感分析与情绪识别
   - 关键词提取与主题聚类
   - 重复问题检测与合并

3. **反馈处理工作流**
   - 工单创建与分配
   - 状态追踪（待处理、处理中、已解决、已关闭）
   - 优先级自动评估
   - 负责人自动分配

4. **数据可视化与洞察**
   - 反馈趋势图表
   - 高频问题排行
   - 玩家满意度趋势
   - 问题分类分布

## 技术方案

### 1. 数据库设计

#### 反馈表结构

```sql
-- 反馈主表
CREATE TABLE player_feedbacks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    feedback_type VARCHAR(20) NOT NULL, -- 'bug', 'suggestion', 'complaint', 'other'
    title VARCHAR(200),
    content TEXT NOT NULL,
    category VARCHAR(50), -- 'performance', 'balance', 'ui', 'gameplay', 'other'
    tags TEXT[], -- ['lag', 'battle', 'ui']
    priority VARCHAR(10) DEFAULT 'normal', -- 'low', 'normal', 'high', 'critical'
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'in_progress', 'resolved', 'closed'
    sentiment VARCHAR(20), -- 'positive', 'neutral', 'negative', 'very_negative'
    sentiment_score DECIMAL(3,2),
    
    -- 关联数据
    pokemon_id INTEGER,
    battle_id INTEGER,
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    
    -- 设备信息
    device_info JSONB,
    app_version VARCHAR(20),
    os_version VARCHAR(20),
    
    -- 附件
    attachments JSONB, -- [{type: 'screenshot', url: '...'}, ...]
    
    -- 处理信息
    assigned_to INTEGER REFERENCES users(id),
    resolved_at TIMESTAMP,
    resolution TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 反馈标签表
CREATE TABLE feedback_tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    category VARCHAR(50),
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 反馈分析结果表
CREATE TABLE feedback_analysis (
    id SERIAL PRIMARY KEY,
    feedback_id INTEGER REFERENCES player_feedbacks(id),
    analysis_type VARCHAR(50), -- 'sentiment', 'category', 'duplicate_check'
    result JSONB,
    confidence DECIMAL(5,4),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_feedbacks_user ON player_feedbacks(user_id);
CREATE INDEX idx_feedbacks_status ON player_feedbacks(status);
CREATE INDEX idx_feedbacks_type ON player_feedbacks(feedback_type);
CREATE INDEX idx_feedbacks_created ON player_feedbacks(created_at DESC);
CREATE INDEX idx_feedbacks_sentiment ON player_feedbacks(sentiment);
CREATE INDEX idx_feedbacks_tags ON player_feedbacks USING GIN(tags);
```

### 2. 后端服务实现

#### user-service 反馈路由

```javascript
// backend/services/user-service/routes/feedback.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const auth = require('../../shared/middleware/auth');
const rateLimit = require('../../shared/middleware/rateLimit');
const FeedbackController = require('../controllers/FeedbackController');

// 提交反馈
router.post('/',
  auth.authenticate,
  rateLimit.feedbackSubmit,
  [
    body('feedback_type').isIn(['bug', 'suggestion', 'complaint', 'other']),
    body('content').isLength({ min: 10, max: 2000 }),
    body('title').optional().isLength({ max: 200 }),
    body('category').optional().isLength({ max: 50 }),
    body('tags').optional().isArray({ max: 5 }),
    body('attachments').optional().isArray({ max: 3 })
  ],
  FeedbackController.submitFeedback
);

// 获取用户反馈历史
router.get('/my-feedbacks',
  auth.authenticate,
  FeedbackController.getUserFeedbacks
);

// 获取反馈详情
router.get('/:id',
  auth.authenticate,
  FeedbackController.getFeedbackDetail
);

// 更新反馈（补充信息）
router.patch('/:id',
  auth.authenticate,
  FeedbackController.updateFeedback
);

// 取消反馈
router.delete('/:id',
  auth.authenticate,
  FeedbackController.cancelFeedback
);

// 获取反馈标签列表
router.get('/tags/list',
  auth.optionalAuth,
  FeedbackController.getFeedbackTags
);

// 获取常见问题FAQ
router.get('/faq/list',
  FeedbackController.getFAQ
);

module.exports = router;
```

#### 反馈控制器

```javascript
// backend/services/user-service/controllers/FeedbackController.js
const db = require('../../../shared/database');
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
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.id;
      const { feedback_type, title, content, category, tags, attachments, pokemon_id, battle_id } = req.body;

      // 收集设备信息
      const deviceInfo = {
        platform: req.headers['x-platform'],
        app_version: req.headers['x-app-version'],
        os_version: req.headers['x-os-version'],
        device_model: req.headers['x-device-model']
      };

      // 情感分析
      const sentimentResult = await sentimentAnalyzer.analyze(content);
      
      // 自动分类（如果未提供）
      let finalCategory = category;
      if (!finalCategory) {
        const classification = await feedbackClassifier.classify(content);
        finalCategory = classification.category;
      }

      // 重复问题检测
      const duplicateCheck = await duplicateDetector.check(content, feedback_type);

      // 创建反馈
      const result = await db.query(`
        INSERT INTO player_feedbacks (
          user_id, feedback_type, title, content, category, tags,
          priority, sentiment, sentiment_score, device_info,
          app_version, os_version, attachments, pokemon_id, battle_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `, [
        userId, feedback_type, title, content, finalCategory, tags || [],
        this.calculatePriority(sentimentResult, feedback_type),
        sentimentResult.label,
        sentimentResult.score,
        JSON.stringify(deviceInfo),
        deviceInfo.app_version,
        deviceInfo.os_version,
        JSON.stringify(attachments || []),
        pokemon_id,
        battle_id
      ]);

      const feedback = result.rows[0];

      // 如果检测到重复，记录关联
      if (duplicateCheck.isDuplicate) {
        await db.query(`
          INSERT INTO feedback_analysis (feedback_id, analysis_type, result, confidence)
          VALUES ($1, 'duplicate_check', $2, $3)
        `, [feedback.id, JSON.stringify(duplicateCheck), duplicateCheck.confidence]);
      }

      // 触发异步处理任务
      await this.queueFeedbackProcessing(feedback.id);

      // 通知用户
      await notificationService.sendFeedbackReceived(userId, feedback.id);

      res.status(201).json({
        success: true,
        data: {
          feedback_id: feedback.id,
          status: feedback.status,
          sentiment: sentimentResult.label,
          is_duplicate: duplicateCheck.isDuplicate
        }
      });
    } catch (error) {
      console.error('Submit feedback error:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }

  /**
   * 计算优先级
   */
  calculatePriority(sentimentResult, feedbackType) {
    if (feedbackType === 'bug' && sentimentResult.label === 'very_negative') {
      return 'critical';
    }
    if (feedbackType === 'complaint' && sentimentResult.score > 0.8) {
      return 'high';
    }
    if (feedbackType === 'bug') {
      return 'high';
    }
    if (feedbackType === 'complaint') {
      return 'normal';
    }
    return 'low';
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

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error) {
      console.error('Get user feedbacks error:', error);
      res.status(500).json({ error: 'Failed to get feedbacks' });
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
        SELECT f.*, u.username,
               json_agg(json_build_object('type', fa.analysis_type, 'result', fa.result, 'confidence', fa.confidence)) as analyses
        FROM player_feedbacks f
        LEFT JOIN users u ON f.assigned_to = u.id
        LEFT JOIN feedback_analysis fa ON fa.feedback_id = f.id
        WHERE f.id = $1 AND f.user_id = $2
        GROUP BY f.id, u.username
      `, [feedbackId, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Feedback not found' });
      }

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Get feedback detail error:', error);
      res.status(500).json({ error: 'Failed to get feedback detail' });
    }
  }

  /**
   * 队列反馈处理任务
   */
  async queueFeedbackProcessing(feedbackId) {
    // 发送到 Kafka 或任务队列进行异步处理
    const { Kafka } = require('kafkajs');
    const kafka = new Kafka({ brokers: process.env.KAFKA_BROKERS.split(',') });
    const producer = kafka.producer();
    
    await producer.connect();
    await producer.send({
      topic: 'feedback-processing',
      messages: [{
        key: feedbackId.toString(),
        value: JSON.stringify({
          feedback_id: feedbackId,
          timestamp: Date.now()
        })
      }]
    });
    await producer.disconnect();
  }
}

module.exports = new FeedbackController();
```

### 3. AI 智能分析模块

#### 情感分析器

```javascript
// backend/shared/ai/sentimentAnalyzer.js
class SentimentAnalyzer {
  constructor() {
    this.model = this.loadModel();
    this.positiveWords = this.loadDictionary('positive');
    this.negativeWords = this.loadDictionary('negative');
    this.intensifiers = ['非常', '极其', '特别', '超级', '很', '相当'];
    this.negators = ['不', '没', '无', '非'];
  }

  /**
   * 分析文本情感
   */
  async analyze(text) {
    // 1. 预处理文本
    const processedText = this.preprocess(text);
    
    // 2. 词汇情感评分
    const lexiconScore = this.lexiconAnalysis(processedText);
    
    // 3. 机器学习模型预测
    const mlScore = await this.mlPrediction(processedText);
    
    // 4. 综合评分
    const finalScore = (lexiconScore * 0.4 + mlScore * 0.6);
    
    // 5. 确定情感标签
    const label = this.scoreToLabel(finalScore);
    
    return {
      label,
      score: Math.abs(finalScore),
      details: {
        lexicon_score: lexiconScore,
        ml_score: mlScore,
        keywords: this.extractKeywords(processedText)
      }
    };
  }

  /**
   * 词典分析法
   */
  lexiconAnalysis(text) {
    let score = 0;
    let negate = false;
    
    const words = text.split(/\s+/);
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      
      // 检查否定词
      if (this.negators.includes(word)) {
        negate = !negate;
        continue;
      }
      
      // 检查程度副词
      let multiplier = 1;
      if (i > 0 && this.intensifiers.includes(words[i - 1])) {
        multiplier = 1.5;
      }
      
      // 计算情感分数
      if (this.positiveWords.has(word)) {
        score += (negate ? -1 : 1) * multiplier;
      } else if (this.negativeWords.has(word)) {
        score += (negate ? 1 : -1) * multiplier;
      }
    }
    
    // 归一化到 [-1, 1]
    return Math.max(-1, Math.min(1, score / 10));
  }

  /**
   * 机器学习预测（调用预训练模型）
   */
  async mlPrediction(text) {
    try {
      // 调用 TensorFlow.js 或外部 NLP 服务
      const response = await fetch(process.env.NLP_SERVICE_URL + '/sentiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      
      const result = await response.json();
      return result.score;
    } catch (error) {
      console.error('ML prediction error:', error);
      return 0; // 回退到中性
    }
  }

  /**
   * 分数转换为标签
   */
  scoreToLabel(score) {
    if (score >= 0.6) return 'very_positive';
    if (score >= 0.2) return 'positive';
    if (score >= -0.2) return 'neutral';
    if (score >= -0.6) return 'negative';
    return 'very_negative';
  }

  /**
   * 提取关键词
   */
  extractKeywords(text) {
    // 简单的关键词提取（实际可使用 TF-IDF 或其他算法）
    const keywords = [];
    const words = text.split(/\s+/);
    
    for (const word of words) {
      if (this.positiveWords.has(word) || this.negativeWords.has(word)) {
        keywords.push(word);
      }
    }
    
    return [...new Set(keywords)].slice(0, 5);
  }

  /**
   * 文本预处理
   */
  preprocess(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ') // 保留中文和英文
      .replace(/\s+/g, ' ')
      .trim();
  }

  loadDictionary(type) {
    // 从文件或数据库加载词典
    const path = require('path');
    const fs = require('fs');
    
    try {
      const dictPath = path.join(__dirname, 'dictionaries', `${type}_words.txt`);
      const words = fs.readFileSync(dictPath, 'utf-8').split('\n');
      return new Set(words.map(w => w.trim()).filter(w => w));
    } catch (error) {
      console.error(`Load ${type} dictionary error:`, error);
      return new Set();
    }
  }

  loadModel() {
    // 加载预训练的情感分析模型
    // 实际项目中可以加载 TensorFlow.js 模型或其他 ML 模型
    return null;
  }
}

module.exports = new SentimentAnalyzer();
```

#### 反馈分类器

```javascript
// backend/shared/ai/feedbackClassifier.js
class FeedbackClassifier {
  constructor() {
    this.categories = {
      performance: {
        keywords: ['卡顿', '慢', '延迟', 'lag', 'slow', '卡', '掉帧', '闪退', '崩溃'],
        weight: 1.0
      },
      balance: {
        keywords: ['太强', '太弱', '不平衡', 'imba', 'nerf', 'buff', '削弱', '加强'],
        weight: 0.9
      },
      ui: {
        keywords: ['界面', 'UI', '按钮', '显示', '布局', '字体', '颜色'],
        weight: 0.8
      },
      gameplay: {
        keywords: ['玩法', '机制', '规则', '战斗', '捕捉', '进化', '技能'],
        weight: 0.9
      },
      social: {
        keywords: ['好友', '公会', '聊天', '社交', '交易', '组队'],
        weight: 0.85
      },
      payment: {
        keywords: ['支付', '充值', '购买', '货币', '价格', '退款'],
        weight: 0.95
      },
      other: {
        keywords: [],
        weight: 0.5
      }
    };
  }

  /**
   * 分类反馈
   */
  async classify(text) {
    const scores = {};
    const textLower = text.toLowerCase();
    
    for (const [category, config] of Object.entries(this.categories)) {
      let score = 0;
      
      for (const keyword of config.keywords) {
        const regex = new RegExp(keyword, 'gi');
        const matches = textLower.match(regex);
        if (matches) {
          score += matches.length * config.weight;
        }
      }
      
      scores[category] = score;
    }
    
    // 找出最高分类
    let maxCategory = 'other';
    let maxScore = 0;
    
    for (const [category, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxCategory = category;
      }
    }
    
    // 计算置信度
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    const confidence = totalScore > 0 ? maxScore / totalScore : 0;
    
    return {
      category: maxCategory,
      confidence,
      all_scores: scores
    };
  }
}

module.exports = new FeedbackClassifier();
```

#### 重复问题检测器

```javascript
// backend/shared/ai/duplicateDetector.js
const { similarity } = require('./textSimilarity');

class DuplicateDetector {
  constructor() {
    this.similarityThreshold = 0.75;
  }

  /**
   * 检测重复反馈
   */
  async check(text, feedbackType) {
    const db = require('../../shared/database');
    
    // 查找同类型的近期反馈
    const result = await db.query(`
      SELECT id, title, content, created_at
      FROM player_feedbacks
      WHERE feedback_type = $1
        AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 100
    `, [feedbackType]);
    
    const candidates = result.rows;
    let maxSimilarity = 0;
    let duplicateOf = null;
    
    for (const candidate of candidates) {
      const combinedText = `${candidate.title || ''} ${candidate.content}`;
      const sim = similarity(text, combinedText);
      
      if (sim > maxSimilarity && sim >= this.similarityThreshold) {
        maxSimilarity = sim;
        duplicateOf = candidate.id;
      }
    }
    
    return {
      isDuplicate: maxSimilarity >= this.similarityThreshold,
      duplicate_of: duplicateOf,
      confidence: maxSimilarity
    };
  }
}

module.exports = new DuplicateDetector();
```

### 4. 前端游戏客户端实现

#### 反馈组件

```javascript
// frontend/game-client/src/components/FeedbackModal.js
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { submitFeedback, fetchFeedbackTags } from '../store/actions/feedbackActions';

const FEEDBACK_TYPES = [
  { value: 'bug', label: 'Bug 报告', icon: '🐛' },
  { value: 'suggestion', label: '功能建议', icon: '💡' },
  { value: 'complaint', label: '投诉', icon: '😠' },
  { value: 'other', label: '其他', icon: '📝' }
];

const FeedbackModal = ({ visible, onClose, context = {} }) => {
  const dispatch = useDispatch();
  const tags = useSelector(state => state.feedback.tags);
  const submitting = useSelector(state => state.feedback.submitting);
  
  const [feedbackType, setFeedbackType] = useState('bug');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selectedTags, setSelectedTags] = useState([]);
  const [attachments, setAttachments] = useState([]);
  
  React.useEffect(() => {
    dispatch(fetchFeedbackTags());
  }, [dispatch]);
  
  const handleSubmit = async () => {
    if (!content.trim()) {
      alert('请输入反馈内容');
      return;
    }
    
    const feedbackData = {
      feedback_type: feedbackType,
      title: title.trim(),
      content: content.trim(),
      tags: selectedTags,
      attachments,
      ...context // 可能包含 pokemon_id, battle_id 等
    };
    
    try {
      await dispatch(submitFeedback(feedbackData));
      alert('感谢您的反馈！我们会认真处理。');
      onClose();
    } catch (error) {
      alert('提交失败，请稍后重试');
    }
  };
  
  const toggleTag = (tag) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter(t => t !== tag));
    } else if (selectedTags.length < 5) {
      setSelectedTags([...selectedTags, tag]);
    }
  };
  
  const addScreenshot = async () => {
    // 实现截图上传
    // const screenshot = await captureScreen();
    // setAttachments([...attachments, { type: 'screenshot', url: screenshot }]);
  };
  
  if (!visible) return null;
  
  return (
    <View style={styles.overlay}>
      <View style={styles.modal}>
        <View style={styles.header}>
          <Text style={styles.title}>提交反馈</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.closeButton}>✕</Text>
          </TouchableOpacity>
        </View>
        
        <ScrollView style={styles.content}>
          {/* 反馈类型选择 */}
          <View style={styles.typeContainer}>
            {FEEDBACK_TYPES.map(type => (
              <TouchableOpacity
                key={type.value}
                style={[
                  styles.typeButton,
                  feedbackType === type.value && styles.typeButtonActive
                ]}
                onPress={() => setFeedbackType(type.value)}
              >
                <Text style={styles.typeIcon}>{type.icon}</Text>
                <Text style={styles.typeLabel}>{type.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          
          {/* 标题 */}
          <TextInput
            style={styles.titleInput}
            placeholder="标题（可选）"
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />
          
          {/* 内容 */}
          <TextInput
            style={styles.contentInput}
            placeholder="请详细描述您遇到的问题或建议..."
            value={content}
            onChangeText={setContent}
            multiline
            maxLength={2000}
          />
          
          {/* 标签选择 */}
          <View style={styles.tagsContainer}>
            <Text style={styles.sectionTitle}>标签（最多选择5个）</Text>
            <View style={styles.tagsList}>
              {tags.map(tag => (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.tagButton,
                    selectedTags.includes(tag) && styles.tagButtonActive
                  ]}
                  onPress={() => toggleTag(tag)}
                >
                  <Text style={styles.tagText}>{tag}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          
          {/* 附件 */}
          <View style={styles.attachmentsContainer}>
            <Text style={styles.sectionTitle}>附件（最多3张截图）</Text>
            <View style={styles.attachmentsList}>
              {attachments.map((att, index) => (
                <View key={index} style={styles.attachmentPreview}>
                  <Image source={{ uri: att.url }} style={styles.attachmentImage} />
                  <TouchableOpacity
                    style={styles.removeAttachment}
                    onPress={() => setAttachments(attachments.filter((_, i) => i !== index))}
                  >
                    <Text>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
              {attachments.length < 3 && (
                <TouchableOpacity style={styles.addAttachment} onPress={addScreenshot}>
                  <Text style={styles.addAttachmentText}>+</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </ScrollView>
        
        {/* 提交按钮 */}
        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          <Text style={styles.submitButtonText}>
            {submitting ? '提交中...' : '提交反馈'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000
  },
  modal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '90%',
    maxHeight: '80%',
    overflow: 'hidden'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0'
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold'
  },
  closeButton: {
    fontSize: 24,
    color: '#666'
  },
  content: {
    padding: 16,
    maxHeight: 400
  },
  typeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16
  },
  typeButton: {
    flex: 1,
    alignItems: 'center',
    padding: 12,
    marginHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#f5f5f5'
  },
  typeButtonActive: {
    backgroundColor: '#4CAF50'
  },
  typeIcon: {
    fontSize: 24,
    marginBottom: 4
  },
  typeLabel: {
    fontSize: 12,
    color: '#666'
  },
  titleInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16
  },
  contentInput: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    padding: 12,
    minHeight: 120,
    fontSize: 16,
    textAlignVertical: 'top'
  },
  tagsContainer: {
    marginTop: 16
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    color: '#666'
  },
  tagsList: {
    flexDirection: 'row',
    flexWrap: 'wrap'
  },
  tagButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f0f0f0',
    marginRight: 8,
    marginBottom: 8
  },
  tagButtonActive: {
    backgroundColor: '#4CAF50'
  },
  tagText: {
    fontSize: 12
  },
  attachmentsContainer: {
    marginTop: 16
  },
  attachmentsList: {
    flexDirection: 'row'
  },
  attachmentPreview: {
    width: 80,
    height: 80,
    marginRight: 8,
    borderRadius: 8,
    overflow: 'hidden'
  },
  attachmentImage: {
    width: '100%',
    height: '100%'
  },
  removeAttachment: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addAttachment: {
    width: 80,
    height: 80,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addAttachmentText: {
    fontSize: 32,
    color: '#999'
  },
  submitButton: {
    backgroundColor: '#4CAF50',
    padding: 16,
    alignItems: 'center'
  },
  submitButtonDisabled: {
    backgroundColor: '#ccc'
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  }
});

export default FeedbackModal;
```

### 5. Admin Dashboard 分析仪表板

#### 反馈分析组件

```javascript
// admin-dashboard/src/components/FeedbackDashboard.jsx
import React, { useState, useEffect } from 'react';
import { Line, Pie, Bar } from 'react-chartjs-2';
import { fetchFeedbackStats } from '../api/feedback';

const FeedbackDashboard = () => {
  const [stats, setStats] = useState(null);
  const [dateRange, setDateRange] = useState('7d');
  
  useEffect(() => {
    loadStats();
  }, [dateRange]);
  
  const loadStats = async () => {
    const data = await fetchFeedbackStats(dateRange);
    setStats(data);
  };
  
  if (!stats) return <div>Loading...</div>;
  
  const trendChartData = {
    labels: stats.trend.map(d => d.date),
    datasets: [{
      label: '反馈数量',
      data: stats.trend.map(d => d.count),
      borderColor: '#4CAF50',
      tension: 0.4
    }]
  };
  
  const categoryChartData = {
    labels: Object.keys(stats.by_category),
    datasets: [{
      data: Object.values(stats.by_category),
      backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF']
    }]
  };
  
  const sentimentChartData = {
    labels: ['正面', '中性', '负面', '极负面'],
    datasets: [{
      label: '情感分布',
      data: [
        stats.by_sentiment.positive || 0,
        stats.by_sentiment.neutral || 0,
        stats.by_sentiment.negative || 0,
        stats.by_sentiment.very_negative || 0
      ],
      backgroundColor: ['#4CAF50', '#9E9E9E', '#FF9800', '#F44336']
    }]
  };
  
  return (
    <div className="feedback-dashboard">
      <h1>反馈分析仪表板</h1>
      
      {/* 统计卡片 */}
      <div className="stats-cards">
        <div className="stat-card">
          <h3>总反馈数</h3>
          <div className="stat-value">{stats.total}</div>
          <div className="stat-change">+{stats.new_today} 今日新增</div>
        </div>
        
        <div className="stat-card">
          <h3>待处理</h3>
          <div className="stat-value text-warning">{stats.pending}</div>
          <div className="stat-change">{stats.pending_critical} 个紧急</div>
        </div>
        
        <div className="stat-card">
          <h3>平均处理时间</h3>
          <div className="stat-value">{stats.avg_resolution_time}h</div>
          <div className="stat-change">目标: 24h</div>
        </div>
        
        <div className="stat-card">
          <h3>玩家满意度</h3>
          <div className="stat-value text-success">{stats.satisfaction_rate}%</div>
          <div className="stat-change">↑ 5% 较上周</div>
        </div>
      </div>
      
      {/* 图表 */}
      <div className="charts-grid">
        <div className="chart-card">
          <h3>反馈趋势</h3>
          <Line data={trendChartData} />
        </div>
        
        <div className="chart-card">
          <h3>分类分布</h3>
          <Pie data={categoryChartData} />
        </div>
        
        <div className="chart-card">
          <h3>情感分析</h3>
          <Bar data={sentimentChartData} />
        </div>
      </div>
      
      {/* 高频问题 */}
      <div className="top-issues">
        <h3>高频问题 TOP 10</h3>
        <table>
          <thead>
            <tr>
              <th>问题</th>
              <th>类别</th>
              <th>出现次数</th>
              <th>情感</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {stats.top_issues.map((issue, index) => (
              <tr key={index}>
                <td>{issue.title}</td>
                <td><span className={`category-tag ${issue.category}`}>{issue.category}</span></td>
                <td>{issue.count}</td>
                <td><span className={`sentiment-tag ${issue.sentiment}`}>{issue.sentiment}</span></td>
                <td><span className={`status-tag ${issue.status}`}>{issue.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default FeedbackDashboard;
```

### 6. 后台处理任务

#### 反馈处理 Worker

```javascript
// backend/jobs/feedbackProcessor.js
const { Kafka } = require('kafkajs');
const db = require('../shared/database');
const notificationService = require('../shared/services/notificationService');

class FeedbackProcessor {
  constructor() {
    this.kafka = new Kafka({ brokers: process.env.KAFKA_BROKERS.split(',') });
    this.consumer = this.kafka.consumer({ groupId: 'feedback-processor' });
  }

  async start() {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'feedback-processing', fromBeginning: false });
    
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const data = JSON.parse(message.value.toString());
        await this.processFeedback(data.feedback_id);
      }
    });
  }

  async processFeedback(feedbackId) {
    try {
      // 1. 获取反馈详情
      const result = await db.query(`
        SELECT f.*, u.email, u.language
        FROM player_feedbacks f
        JOIN users u ON f.user_id = u.id
        WHERE f.id = $1
      `, [feedbackId]);
      
      const feedback = result.rows[0];
      if (!feedback) return;
      
      // 2. 自动分配处理人（基于类别）
      await this.autoAssign(feedback);
      
      // 3. 紧急反馈立即通知
      if (feedback.priority === 'critical') {
        await this.notifyUrgentFeedback(feedback);
      }
      
      // 4. 更新标签使用统计
      await this.updateTagStats(feedback.tags);
      
      // 5. 检查是否需要FAQ更新
      if (feedback.status === 'resolved') {
        await this.checkFAQUpdate(feedback);
      }
      
    } catch (error) {
      console.error('Process feedback error:', error);
    }
  }

  async autoAssign(feedback) {
    // 根据反馈类别自动分配给对应的团队成员
    const categoryAssignments = {
      performance: 'performance-team@minego.com',
      balance: 'game-design@minego.com',
      ui: 'ui-team@minego.com',
      gameplay: 'gameplay-team@minego.com',
      social: 'social-team@minego.com',
      payment: 'payment-support@minego.com'
    };
    
    const assignee = categoryAssignments[feedback.category];
    
    if (assignee && feedback.priority !== 'low') {
      await db.query(`
        UPDATE player_feedbacks
        SET assigned_to = (SELECT id FROM users WHERE email = $1 LIMIT 1)
        WHERE id = $2
      `, [assignee, feedback.id]);
      
      // 发送邮件通知
      await notificationService.sendEmail(assignee, {
        subject: `新反馈待处理 #${feedback.id}`,
        template: 'feedback-assignment',
        data: { feedback }
      });
    }
  }

  async notifyUrgentFeedback(feedback) {
    // 发送 Slack 通知
    await notificationService.sendSlackAlert({
      channel: '#urgent-feedback',
      text: `🚨 紧急反馈 #${feedback.id}\n类型: ${feedback.feedback_type}\n类别: ${feedback.category}\n内容: ${feedback.content.substring(0, 200)}`
    });
    
    // 发送短信给值班人员
    await notificationService.sendSMS(process.env.ON_CALL_PHONE, 
      `紧急反馈 #${feedback.id} 需要立即处理`
    );
  }

  async updateTagStats(tags) {
    if (!tags || tags.length === 0) return;
    
    await db.query(`
      UPDATE feedback_tags
      SET usage_count = usage_count + 1
      WHERE name = ANY($1)
    `, [tags]);
  }

  async checkFAQUpdate(feedback) {
    // 检查是否应该添加到 FAQ
    const duplicateCount = await db.query(`
      SELECT COUNT(*) 
      FROM feedback_analysis
      WHERE analysis_type = 'duplicate_check'
        AND result->>'duplicate_of' = $1
    `, [feedback.id]);
    
    if (duplicateCount.rows[0].count >= 10) {
      // 建议 FAQ 更新
      await notificationService.sendEmail('docs@minego.com', {
        subject: 'FAQ 更新建议',
        template: 'faq-update-suggestion',
        data: { feedback, duplicateCount: duplicateCount.rows[0].count }
      });
    }
  }
}

// 启动处理器
const processor = new FeedbackProcessor();
processor.start().catch(console.error);
```

## 验收标准

- [ ] 玩家可以在游戏内通过多个入口提交反馈
- [ ] 反馈自动进行情感分析和分类
- [ ] 系统能够检测重复反馈并合并
- [ ] 紧急反馈（critical）能触发即时通知
- [ ] Admin Dashboard 显示反馈趋势和分析图表
- [ ] 反馈处理工作流完整（创建、分配、处理、关闭）
- [ ] 高频问题自动识别并建议 FAQ 更新
- [ ] 反馈数据支持多维度筛选和查询
- [ ] 用户可以查看自己的反馈历史和状态
- [ ] 系统支持至少 5 种语言的反馈分析

## 影响范围

- **数据库**：新增 player_feedbacks、feedback_tags、feedback_analysis 表
- **user-service**：新增反馈相关 API 路由和控制器
- **game-client**：新增反馈组件和状态管理
- **admin-dashboard**：新增反馈分析仪表板
- **backend/shared**：新增 AI 分析模块（情感分析、分类器、重复检测）
- **backend/jobs**：新增反馈处理 Worker

## 参考

- [Sentiment Analysis Best Practices](https://example.com/sentiment-analysis)
- [User Feedback Management Systems](https://example.com/feedback-systems)
- [Text Classification with Machine Learning](https://example.com/text-classification)
