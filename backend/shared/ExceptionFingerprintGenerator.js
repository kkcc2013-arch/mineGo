/**
 * REQ-00555: 异常指纹生成器
 * 用于从异常日志中提取特征并生成唯一指纹，支持相似异常聚类
 */

const crypto = require('crypto');

class ExceptionFingerprintGenerator {
  constructor(config = {}) {
    this.stackTraceDepth = config.stackTraceDepth || 5;
    this.minMessageLength = config.minMessageLength || 10;
    this.normalizePatterns = [
      /0x[0-9a-fA-F]+/g,                    // 内存地址
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,  // IP 地址
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, // UUID
      /\b\d{13,}\b/g,                       // 时间戳
      /at .+ \(.+:\d+:\d+\)/g,              // 文件位置（保留文件名）
      /\\/tmp\\/[^/]+/g,                    // 临时文件路径
      /\\/var\\/[^/]+/g,                    // 系统路径
      /users\\/[^/]+/gi,                    // 用户路径
    ];
  }

  /**
   * 为异常生成指纹
   * @param {Object} logEntry - 日志条目
   * @returns {Object} 指纹对象
   */
  generateFingerprint(logEntry) {
    const { level, message, stack, service, error } = logEntry;
    
    // 提取异常类型
    const exceptionType = this._extractExceptionType(error?.name || message);
    
    // 提取错误消息特征
    const normalizedMessage = this._normalizeMessage(error?.message || message);
    
    // 提取堆栈特征
    const stackSignature = this._extractStackSignature(stack || error?.stack);
    
    // 提取代码位置特征
    const codeLocations = this._extractCodeLocations(stack || error?.stack);
    
    // 生成指纹 ID
    const fingerprintInput = [
      exceptionType,
      normalizedMessage.substring(0, 100),  // 取消息前100字符
      stackSignature,
      codeLocations.slice(0, 3).join('|')   // 取前3个代码位置
    ].filter(Boolean).join(':');
    
    const fingerprintId = this._hash(fingerprintInput);
    
    return {
      fingerprintId,
      exceptionType,
      normalizedMessage,
      stackSignature,
      codeLocations,
      service: service || 'unknown',
      metadata: {
        originalLevel: level,
        createdAt: new Date().toISOString()
      }
    };
  }

  /**
   * 计算两个指纹的相似度
   * @param {Object} fp1 - 指纹1
   * @param {Object} fp2 - 指纹2
   * @returns {number} 相似度分数 (0-1)
   */
  calculateSimilarity(fp1, fp2) {
    let score = 0;
    let maxScore = 0;
    
    // 异常类型完全匹配（权重40%）
    maxScore += 40;
    if (fp1.exceptionType && fp1.exceptionType === fp2.exceptionType) {
      score += 40;
    }
    
    // 堆栈签名相似度（权重30%）
    maxScore += 30;
    if (fp1.stackSignature && fp2.stackSignature) {
      const stackSim = this._calculateStringSimilarity(fp1.stackSignature, fp2.stackSignature);
      score += 30 * stackSim;
    }
    
    // 消息相似度（权重20%）
    maxScore += 20;
    if (fp1.normalizedMessage && fp2.normalizedMessage) {
      const msgSim = this._calculateStringSimilarity(fp1.normalizedMessage, fp2.normalizedMessage);
      score += 20 * msgSim;
    }
    
    // 代码位置匹配（权重10%）
    maxScore += 10;
    if (fp1.codeLocations?.length && fp2.codeLocations?.length) {
      const matchingLocations = fp1.codeLocations.filter(loc => 
        fp2.codeLocations.includes(loc)
      ).length;
      score += 10 * (matchingLocations / Math.min(fp1.codeLocations.length, fp2.codeLocations.length));
    }
    
    return score / maxScore;
  }

  /**
   * 提取异常类型
   */
  _extractExceptionType(message) {
    // 常见异常类型匹配
    const exceptionPatterns = [
      /^(\w+Exception):/i,
      /^(\w+Error):/i,
      /^(\w+Fault):/i,
      /Error:\s*(\w+)/,
      /Exception:\s*(\w+)/,
    ];
    
    for (const pattern of exceptionPatterns) {
      const match = message?.match(pattern);
      if (match) {
        return match[1] || 'Unknown';
      }
    }
    
    // 尝试从消息开头提取
    const firstWord = message?.split(/[\s:]/)[0];
    if (firstWord && firstWord.length > 3) {
      return firstWord;
    }
    
    return 'UnknownException';
  }

  /**
   * 归一化消息（去除动态内容）
   */
  _normalizeMessage(message) {
    if (!message) return '';
    
    let normalized = String(message);
    
    // 应用归一化模式
    for (const pattern of this.normalizePatterns) {
      normalized = normalized.replace(pattern, '{{DYNAMIC}}');
    }
    
    // 去除多余空格
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    return normalized;
  }

  /**
   * 提取堆栈签名
   */
  _extractStackSignature(stack) {
    if (!stack) return '';
    
    const lines = String(stack).split('\n');
    const relevantLines = lines
      .filter(line => line.trim().match(/^\s*at\s+/))
      .slice(0, this.stackTraceDepth);
    
    // 提取函数名和文件名（去除行号）
    const signature = relevantLines.map(line => {
      const match = line.match(/at\s+(.+?)\s*\(/);
      if (match) {
        let func = match[1];
        // 去除匿名函数索引
        func = func.replace(/\.\d+$/, '');
        return func;
      }
      return '';
    }).filter(Boolean).join('|');
    
    return signature;
  }

  /**
   * 提取代码位置
   */
  _extractCodeLocations(stack) {
    if (!stack) return [];
    
    const lines = String(stack).split('\n');
    const locations = [];
    
    for (const line of lines) {
      // 匹配文件位置格式: at ... (file:line:col) 或 at ... (file:line)
      const match = line.match(/\((.+?):\d+(?::\d+)?\)/);
      if (match) {
        // 提取文件路径（去除行号列号）
        const filePath = match[1].split('/').pop();  // 只保留文件名
        locations.push(filePath);
      }
    }
    
    return [...new Set(locations)];  // 去重
  }

  /**
   * 计算字符串相似度（Levenshtein Distance）
   */
  _calculateStringSimilarity(s1, s2) {
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);
    
    if (maxLen === 0) return 1;
    
    // 使用动态规划计算编辑距离
    const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) dp[i][0] = i;
    for (let j = 0; j <= len2; j++) dp[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    
    const distance = dp[len1][len2];
    return 1 - distance / maxLen;
  }

  /**
   * 生成哈希值
   */
  _hash(input) {
    return crypto
      .createHash('sha256')
      .update(input)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 批量生成指纹
   */
  generateBatchFingerprints(logEntries) {
    return logEntries.map(entry => ({
      originalLog: entry,
      fingerprint: this.generateFingerprint(entry)
    }));
  }

  /**
   * 聚类相似异常
   */
  clusterExceptions(fingerprints, threshold = 0.85) {
    const clusters = new Map();
    const assigned = new Set();
    
    for (const fp of fingerprints) {
      if (assigned.has(fp.fingerprintId)) continue;
      
      const cluster = {
        representative: fp,
        members: [fp],
        fingerprintId: fp.fingerprintId
      };
      
      // 查找相似指纹
      for (const other of fingerprints) {
        if (assigned.has(other.fingerprintId)) continue;
        if (other.fingerprintId === fp.fingerprintId) continue;
        
        const similarity = this.calculateSimilarity(fp, other);
        if (similarity >= threshold) {
          cluster.members.push(other);
          assigned.add(other.fingerprintId);
        }
      }
      
      clusters.set(fp.fingerprintId, cluster);
      assigned.add(fp.fingerprintId);
    }
    
    return Array.from(clusters.values());
  }
}

module.exports = ExceptionFingerprintGenerator;