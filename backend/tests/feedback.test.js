/**
 * 反馈系统单元测试
 * REQ-00339: 玩家反馈收集与智能分析系统
 */

const { expect } = require('chai');
const sinon = require('sinon');

// 模拟数据库
const mockDb = {
  query: sinon.stub()
};

// 模拟用户认证
const mockAuth = {
  authenticate: (req, res, next) => {
    req.user = { id: 1, role: 'user' };
    next();
  }
};

describe('Feedback System', () => {
  beforeEach(() => {
    sinon.reset();
  });

  describe('SentimentAnalyzer', () => {
    const sentimentAnalyzer = require('../shared/ai/sentimentAnalyzer');

    it('should analyze positive sentiment', async () => {
      const result = await sentimentAnalyzer.analyze('这个游戏真的太棒了！我非常喜欢！');
      
      expect(result).to.have.property('label');
      expect(result).to.have.property('score');
      expect(result).to.have.property('confidence');
      expect(['positive', 'very_positive']).to.include(result.label);
    });

    it('should analyze negative sentiment', async () => {
      const result = await sentimentAnalyzer.analyze('垃圾游戏，垃圾开发商，坑钱！');
      
      expect(result).to.have.property('label');
      expect(['negative', 'very_negative']).to.include(result.label);
    });

    it('should analyze neutral sentiment', async () => {
      const result = await sentimentAnalyzer.analyze('请问这个功能怎么用？');
      
      expect(result).to.have.property('label');
      expect(result.label).to.equal('neutral');
    });

    it('should handle empty text', async () => {
      const result = await sentimentAnalyzer.analyze('');
      
      expect(result.label).to.equal('neutral');
      expect(result.confidence).to.be.at.least(0);
    });

    it('should extract keywords', async () => {
      const result = await sentimentAnalyzer.analyze('游戏很卡顿，经常闪退，体验很差');
      
      expect(result.details.keywords).to.be.an('array');
      expect(result.details.keywords.length).to.be.at.least(1);
    });
  });

  describe('FeedbackClassifier', () => {
    const feedbackClassifier = require('../shared/ai/feedbackClassifier');

    it('should classify performance issue', async () => {
      const result = await feedbackClassifier.classify(
        '游戏非常卡顿，经常闪退，加载太慢了',
        'bug'
      );
      
      expect(result.category).to.equal('performance');
      expect(result).to.have.property('confidence');
      expect(result).to.have.property('categoryName');
    });

    it('should classify payment issue', async () => {
      const result = await feedbackClassifier.classify(
        '充值后未到账，支付成功但没有收到钻石',
        'complaint'
      );
      
      expect(result.category).to.equal('payment');
    });

    it('should classify gameplay issue', async () => {
      const result = await feedbackClassifier.classify(
        '技能伤害太低了，战斗不平衡',
        'suggestion'
      );
      
      expect(['gameplay', 'balance']).to.include(result.category);
    });

    it('should suggest appropriate priority', async () => {
      const result = await feedbackClassifier.classify(
        '游戏闪退无法启动',
        'bug'
      );
      
      expect(result).to.have.property('suggested_priority');
      expect(['normal', 'high', 'critical']).to.include(result.suggested_priority);
    });
  });

  describe('DuplicateDetector', () => {
    it('should detect duplicate feedbacks', async () => {
      const duplicateDetector = require('../shared/ai/duplicateDetector');
      
      mockDb.query.resolves({
        rows: [
          { id: 1, title: '游戏卡顿', content: '游戏非常卡顿，玩不了', status: 'pending' }
        ]
      });

      const result = await duplicateDetector.check(
        '游戏很卡，玩不了',
        'bug'
      );
      
      expect(result).to.have.property('isDuplicate');
      expect(result).to.have.property('confidence');
      expect(result.similar_feedbacks).to.be.an('array');
    });

    it('should calculate text similarity correctly', () => {
      const duplicateDetector = require('../shared/ai/duplicateDetector');
      
      const sim1 = duplicateDetector.calculateSimilarity(
        '游戏卡顿闪退',
        '游戏闪退卡顿'
      );
      
      expect(sim1).to.be.at.least(0.5);
      
      const sim2 = duplicateDetector.calculateSimilarity(
        '游戏卡顿',
        '我想充值'
      );
      
      expect(sim2).to.be.lessThan(0.5);
    });
  });

  describe('TextSimilarity', () => {
    const { similarity, cosineSimilarity, jaccardSimilarity } = require('../shared/ai/textSimilarity');

    it('should calculate cosine similarity', () => {
      const sim = cosineSimilarity(
        '游戏卡顿闪退',
        '游戏闪退卡顿'
      );
      
      expect(sim).to.be.at.least(0.8);
    });

    it('should calculate jaccard similarity', () => {
      const sim = jaccardSimilarity(
        '卡顿闪退',
        '闪退卡顿'
      );
      
      expect(sim).to.equal(1);
    });

    it('should handle empty strings', () => {
      const sim = similarity('', 'test');
      expect(sim).to.equal(0);
    });
  });

  describe('FeedbackController', () => {
    const FeedbackController = require('../services/user-service/controllers/FeedbackController');

    it('should submit feedback successfully', async () => {
      const mockReq = {
        user: { id: 1 },
        body: {
          feedback_type: 'bug',
          title: '测试反馈',
          content: '这是一个测试反馈内容，用于测试反馈系统的提交功能',
          category: 'performance',
          tags: ['卡顿']
        },
        headers: {
          'x-platform': 'ios',
          'x-app-version': '1.0.0'
        }
      };

      const mockRes = {
        status: sinon.stub().returnsThis(),
        json: sinon.stub()
      };

      mockDb.query.onFirstCall().resolves({
        rows: [{
          id: 1,
          status: 'pending',
          category: 'performance',
          created_at: new Date()
        }]
      });

      mockDb.query.onSecondCall().resolves({ rows: [] });
      mockDb.query.onThirdCall().resolves({ rows: [] });

      await FeedbackController.submitFeedback(mockReq, mockRes);

      expect(mockRes.status.calledWith(201)).to.be.true;
      expect(mockRes.json.calledOnce).to.be.true;
    });

    it('should get user feedbacks', async () => {
      const mockReq = {
        user: { id: 1 },
        query: { limit: 20, offset: 0 }
      };

      const mockRes = {
        json: sinon.stub()
      };

      mockDb.query.onFirstCall().resolves({
        rows: [{ id: 1, title: 'Test' }]
      });

      mockDb.query.onSecondCall().resolves({
        rows: [{ total: '1' }]
      });

      await FeedbackController.getUserFeedbacks(mockReq, mockRes);

      expect(mockRes.json.calledOnce).to.be.true;
      const response = mockRes.json.firstCall.args[0];
      expect(response.success).to.be.true;
      expect(response.data).to.be.an('array');
    });

    it('should calculate priority correctly', () => {
      const controller = FeedbackController;

      // Bug + very_negative = critical
      const priority1 = controller.calculatePriority(
        { label: 'very_negative' },
        'bug',
        'high'
      );
      expect(priority1).to.equal('critical');

      // Complaint + negative = high
      const priority2 = controller.calculatePriority(
        { label: 'negative' },
        'complaint',
        'normal'
      );
      expect(priority2).to.equal('high');

      // Normal case
      const priority3 = controller.calculatePriority(
        { label: 'neutral' },
        'suggestion',
        'normal'
      );
      expect(priority3).to.equal('normal');
    });
  });
});

describe('Feedback Admin API', () => {
  describe('Stats Endpoint', () => {
    it('should return feedback statistics', async () => {
      mockDb.query.resolves({
        rows: [{
          total_count: 100,
          pending_count: 20,
          resolved_count: 60
        }]
      });

      // 测试统计 API
    });
  });

  describe('Batch Update', () => {
    it('should update multiple feedbacks', async () => {
      mockDb.query.resolves({
        rows: [{ id: 1 }, { id: 2 }]
      });

      // 测试批量更新
    });
  });
});
