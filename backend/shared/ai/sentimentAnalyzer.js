/**
 * 情感分析器
 * 用于分析玩家反馈文本的情感倾向
 */

const logger = require('../logger');

class SentimentAnalyzer {
  constructor() {
    // 积极词汇
    this.positiveWords = new Set([
      '好', '棒', '赞', '喜欢', '爱', '开心', '高兴', '满意', '优秀', '完美',
      '精彩', '有趣', '方便', '流畅', '快速', '漂亮', '帅气', '酷', '厉害',
      'good', 'great', 'awesome', 'excellent', 'perfect', 'love', 'nice', 'cool',
      '感谢', '谢谢', '支持', '推荐', '期待', '希望', '喜欢', '有趣', '好玩'
    ]);

    // 消极词汇
    this.negativeWords = new Set([
      '差', '烂', '垃圾', '恶心', '讨厌', '愤怒', '失望', '糟糕', '崩溃',
      '卡', '慢', '闪退', '掉线', 'bug', '问题', '错误', '失败', '坑',
      'bad', 'terrible', 'awful', 'hate', 'bug', 'issue', 'problem', 'fail',
      '垃圾游戏', '氪金', '逼氪', '骗氪', '坑钱', '没法玩', '没法打',
      '不公平', '不平衡', '太弱', '太强', '无聊', '没意思', '骗人', '骗子'
    ]);

    // 程度副词
    this.intensifiers = {
      '非常': 1.5,
      '极其': 1.8,
      '特别': 1.4,
      '超级': 1.6,
      '很': 1.3,
      '相当': 1.2,
      '太': 1.4,
      '真': 1.3,
      'really': 1.4,
      'very': 1.5,
      'so': 1.3,
      'extremely': 1.8
    };

    // 否定词
    this.negators = new Set([
      '不', '没', '无', '非', '别', '莫', '未', 'not', 'no', "don't", "didn't"
    ]);

    // 标点权重
    this.punctuationWeights = {
      '!': 1.1,
      '！': 1.1,
      '。': 1.0,
      '?': 0.9,
      '？': 0.9
    };
  }

  /**
   * 分析文本情感
   * @param {string} text - 待分析文本
   * @returns {Object} 分析结果
   */
  async analyze(text) {
    try {
      if (!text || typeof text !== 'string') {
        return this.getNeutralResult();
      }

      // 预处理
      const processedText = this.preprocess(text);

      // 词汇情感评分
      const lexiconResult = this.lexiconAnalysis(processedText);

      // 规则评分（特定模式）
      const ruleResult = this.ruleBasedAnalysis(text);

      // 综合评分
      const finalScore = (
        lexiconResult.score * 0.5 +
        ruleResult.score * 0.3 +
        this.patternScore(text) * 0.2
      );

      // 确定标签
      const label = this.scoreToLabel(finalScore);

      return {
        label,
        score: Math.abs(finalScore),
        confidence: this.calculateConfidence(lexiconResult, ruleResult),
        details: {
          positive_count: lexiconResult.positiveCount,
          negative_count: lexiconResult.negativeCount,
          keywords: lexiconResult.keywords.slice(0, 5),
          patterns: ruleResult.patterns
        }
      };
    } catch (error) {
      logger.error('Sentiment analysis error:', error);
      return this.getNeutralResult();
    }
  }

  /**
   * 词典分析法
   */
  lexiconAnalysis(text) {
    let score = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    const keywords = [];
    let negate = false;

    const words = this.tokenize(text);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      let wordScore = 0;

      // 检查否定词
      if (this.negators.has(word)) {
        negate = !negate;
        continue;
      }

      // 检查程度副词
      let multiplier = 1;
      if (i > 0 && this.intensifiers[words[i - 1]]) {
        multiplier = this.intensifiers[words[i - 1]];
      }

      // 计算情感分数
      if (this.positiveWords.has(word)) {
        wordScore = (negate ? -1 : 1) * multiplier;
        positiveCount++;
        keywords.push(word);
      } else if (this.negativeWords.has(word)) {
        wordScore = (negate ? 1 : -1) * multiplier;
        negativeCount++;
        keywords.push(word);
      }

      score += wordScore;
      negate = false; // 重置否定状态
    }

    // 归一化到 [-1, 1]
    const normalizedScore = Math.max(-1, Math.min(1, score / 10));

    return {
      score: normalizedScore,
      positiveCount,
      negativeCount,
      keywords: [...new Set(keywords)]
    };
  }

  /**
   * 规则分析
   */
  ruleBasedAnalysis(text) {
    let score = 0;
    const patterns = [];

    // 检查特定模式
    const patterns_config = [
      { regex: /(垃圾|骗子|坑钱|骗氪)/gi, score: -0.8, name: '强烈负面' },
      { regex: /(卡顿|闪退|掉线|bug)/gi, score: -0.3, name: '技术问题' },
      { regex: /(喜欢|支持|感谢|赞)/gi, score: 0.5, name: '正面表达' },
      { regex: /(希望|建议|请)/gi, score: 0.1, name: '建设性' },
      { regex: /(！{2,}|!{2,})/g, score: 0.2, name: '强调语气' },
      { regex: /(？{2,}|\?{2,})/g, score: -0.1, name: '疑问语气' }
    ];

    for (const pattern of patterns_config) {
      const matches = text.match(pattern.regex);
      if (matches) {
        score += pattern.score * Math.min(matches.length, 3);
        patterns.push({
          name: pattern.name,
          count: matches.length
        });
      }
    }

    return {
      score: Math.max(-1, Math.min(1, score)),
      patterns
    };
  }

  /**
   * 模式评分
   */
  patternScore(text) {
    let score = 0;

    // 检查感叹号数量
    const exclamationCount = (text.match(/[!！]/g) || []).length;
    if (exclamationCount > 3) {
      score += 0.2;
    }

    // 检查大写字母比例（英文）
    const upperCaseRatio = (text.match(/[A-Z]/g) || []).length / (text.match(/[a-zA-Z]/g) || []).length || 0;
    if (upperCaseRatio > 0.5) {
      score += 0.1;
    }

    // 检查问号
    const questionCount = (text.match(/[?？]/g) || []).length;
    if (questionCount > 2) {
      score -= 0.1;
    }

    return Math.max(-0.5, Math.min(0.5, score));
  }

  /**
   * 计算置信度
   */
  calculateConfidence(lexiconResult, ruleResult) {
    const totalWords = lexiconResult.positiveCount + lexiconResult.negativeCount;
    if (totalWords === 0) return 0.3;
    
    // 有明确情感词汇的置信度更高
    const vocabularyConfidence = Math.min(0.9, 0.4 + totalWords * 0.1);
    
    // 规则匹配增加置信度
    const ruleBonus = ruleResult.patterns.length * 0.05;
    
    return Math.min(0.95, vocabularyConfidence + ruleBonus);
  }

  /**
   * 分数转标签
   */
  scoreToLabel(score) {
    if (score >= 0.6) return 'very_positive';
    if (score >= 0.2) return 'positive';
    if (score >= -0.2) return 'neutral';
    if (score >= -0.6) return 'negative';
    return 'very_negative';
  }

  /**
   * 文本预处理
   */
  preprocess(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5!！?？.。]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 分词
   */
  tokenize(text) {
    // 简单分词：中文字符单独分，英文单词
    const tokens = [];
    let englishWord = '';

    for (const char of text) {
      if (/[\u4e00-\u9fa5]/.test(char)) {
        // 中文字符
        if (englishWord) {
          tokens.push(englishWord);
          englishWord = '';
        }
        tokens.push(char);
      } else if (/[a-zA-Z0-9]/.test(char)) {
        englishWord += char;
      } else if (englishWord) {
        tokens.push(englishWord);
        englishWord = '';
      }
    }

    if (englishWord) {
      tokens.push(englishWord);
    }

    return tokens.filter(t => t.length > 0);
  }

  /**
   * 获取中性结果
   */
  getNeutralResult() {
    return {
      label: 'neutral',
      score: 0,
      confidence: 0.5,
      details: {
        positive_count: 0,
        negative_count: 0,
        keywords: [],
        patterns: []
      }
    };
  }

  /**
   * 批量分析
   */
  async batchAnalyze(texts) {
    return Promise.all(texts.map(text => this.analyze(text)));
  }
}

module.exports = new SentimentAnalyzer();
