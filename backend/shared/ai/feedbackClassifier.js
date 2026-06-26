/**
 * 反馈分类器
 * 自动对玩家反馈进行分类
 */

const logger = require('../logger');

class FeedbackClassifier {
  constructor() {
    // 分类规则配置
    this.categories = {
      performance: {
        name: '性能问题',
        keywords: ['卡顿', '慢', '延迟', 'lag', 'slow', '卡', '掉帧', '闪退', '崩溃', '加载', '黑屏', '白屏', '发热', '耗电'],
        weight: 1.0,
        priority: 'high'
      },
      balance: {
        name: '平衡性问题',
        keywords: ['太强', '太弱', '不平衡', 'imba', 'nerf', 'buff', '削弱', '加强', '不公平', '氪金', '逼氪', '数值'],
        weight: 0.9,
        priority: 'normal'
      },
      ui: {
        name: '界面问题',
        keywords: ['界面', 'UI', '按钮', '显示', '布局', '字体', '颜色', '图标', '菜单', '操作', '点击'],
        weight: 0.8,
        priority: 'normal'
      },
      gameplay: {
        name: '玩法问题',
        keywords: ['玩法', '机制', '规则', '战斗', '捕捉', '进化', '技能', '精灵', '道具', '任务', '副本', '道馆'],
        weight: 0.9,
        priority: 'normal'
      },
      social: {
        name: '社交问题',
        keywords: ['好友', '公会', '聊天', '社交', '交易', '组队', '私信', '屏蔽', '举报'],
        weight: 0.85,
        priority: 'normal'
      },
      payment: {
        name: '支付问题',
        keywords: ['支付', '充值', '购买', '货币', '价格', '退款', '订单', '未到账', '扣款', '优惠'],
        weight: 0.95,
        priority: 'high'
      },
      account: {
        name: '账号问题',
        keywords: ['账号', '登录', '密码', '封号', '找回', '绑定', '解绑', '验证', '安全'],
        weight: 0.9,
        priority: 'high'
      },
      other: {
        name: '其他',
        keywords: [],
        weight: 0.5,
        priority: 'low'
      }
    };

    // 反馈类型权重
    this.typeWeights = {
      bug: { performance: 1.5, gameplay: 1.3, ui: 1.2 },
      suggestion: { gameplay: 1.5, ui: 1.3, balance: 1.3 },
      complaint: { balance: 1.5, payment: 1.5, social: 1.2 },
      other: {}
    };
  }

  /**
   * 分类反馈
   * @param {string} text - 反馈文本
   * @param {string} feedbackType - 反馈类型
   * @returns {Object} 分类结果
   */
  async classify(text, feedbackType = 'other') {
    try {
      if (!text || typeof text !== 'string') {
        return this.getDefaultResult();
      }

      const textLower = text.toLowerCase();
      const scores = {};

      // 计算每个类别的得分
      for (const [categoryKey, category] of Object.entries(this.categories)) {
        scores[categoryKey] = this.calculateCategoryScore(
          textLower,
          category,
          feedbackType
        );
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

      // 建议优先级
      const suggestedPriority = this.suggestPriority(
        maxCategory,
        feedbackType,
        confidence
      );

      return {
        category: maxCategory,
        categoryName: this.categories[maxCategory].name,
        confidence: Math.round(confidence * 100) / 100,
        suggested_priority: suggestedPriority,
        all_scores: this.normalizeScores(scores)
      };
    } catch (error) {
      logger.error('Feedback classification error:', error);
      return this.getDefaultResult();
    }
  }

  /**
   * 计算类别得分
   */
  calculateCategoryScore(text, category, feedbackType) {
    let score = 0;

    // 关键词匹配
    for (const keyword of category.keywords) {
      const regex = new RegExp(keyword.toLowerCase(), 'gi');
      const matches = text.match(regex);
      if (matches) {
        score += matches.length * category.weight;
      }
    }

    // 应用反馈类型权重
    const typeWeight = this.typeWeights[feedbackType]?.[category.name] || 1;
    score *= typeWeight;

    return score;
  }

  /**
   * 归一化得分
   */
  normalizeScores(scores) {
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (total === 0) return scores;

    const normalized = {};
    for (const [key, value] of Object.entries(scores)) {
      normalized[key] = Math.round((value / total) * 100) / 100;
    }
    return normalized;
  }

  /**
   * 建议优先级
   */
  suggestPriority(category, feedbackType, confidence) {
    // 获取类别默认优先级
    let priority = this.categories[category]?.priority || 'normal';

    // 根据反馈类型调整
    if (feedbackType === 'bug') {
      priority = this.upgradePriority(priority);
    } else if (feedbackType === 'complaint' && confidence > 0.7) {
      priority = this.upgradePriority(priority);
    }

    return priority;
  }

  /**
   * 提升优先级
   */
  upgradePriority(current) {
    const levels = ['low', 'normal', 'high', 'critical'];
    const index = levels.indexOf(current);
    return levels[Math.min(index + 1, levels.length - 1)];
  }

  /**
   * 获取默认结果
   */
  getDefaultResult() {
    return {
      category: 'other',
      categoryName: '其他',
      confidence: 0.5,
      suggested_priority: 'normal',
      all_scores: {}
    };
  }

  /**
   * 获取所有分类
   */
  getCategories() {
    const result = {};
    for (const [key, value] of Object.entries(this.categories)) {
      result[key] = {
        name: value.name,
        priority: value.priority
      };
    }
    return result;
  }

  /**
   * 批量分类
   */
  async batchClassify(items) {
    return Promise.all(
      items.map(item => this.classify(item.text, item.type))
    );
  }
}

module.exports = new FeedbackClassifier();
