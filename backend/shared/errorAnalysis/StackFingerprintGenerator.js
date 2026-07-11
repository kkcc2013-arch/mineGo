/**
 * 错误堆栈指纹生成器
 * 
 * 功能：
 * - 解析错误堆栈，提取关键帧
 * - 生成唯一指纹（去除动态部分）
 * - 计算堆栈相似度
 * 
 * @module StackFingerprintGenerator
 */

const crypto = require('crypto');

class StackFingerprintGenerator {
  constructor(config = {}) {
    this.maxFrames = config.maxFrames || 10;
    this.minFrames = config.minFrames || 3;
    this.ignorePatterns = config.ignorePatterns || [
      /node_modules/,
      /internal\/process/,
      /\.next\//,
      /dist\//,
      /webpack/,
      /__tests__/
    ];
    this.normalizePatterns = config.normalizePatterns || [
      { pattern: /:(\d+):(\d+)/, replacement: ':LINE:COLUMN' },
      { pattern: /\/Users\/[^\/]+/, replacement: '/USER' },
      { pattern: /\/home\/[^\/]+/, replacement: '/USER' },
      { pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, replacement: 'TIMESTAMP' }
    ];
  }

  /**
   * 生成错误指纹
   * @param {Error} error - 错误对象
   * @returns {Object} 指纹对象
   */
  generate(error) {
    const stack = error.stack || '';
    const frames = this._parseStack(stack);
    const keyFrames = this._extractKeyFrames(frames);
    
    return {
      fingerprint: this._hashFrames(keyFrames),
      keyFrames: keyFrames.map(f => ({
        file: f.file,
        function: f.function,
        line: f.line
      })),
      messagePattern: this._normalizeMessage(error.message),
      errorName: error.name || 'Error',
      frameCount: frames.length,
      keyFrameCount: keyFrames.length,
      rawStack: stack
    };
  }

  /**
   * 解析错误堆栈
   * @param {string} stack - 堆栈字符串
   * @returns {Array} 堆栈帧数组
   */
  _parseStack(stack) {
    if (!stack) return [];
    
    const lines = stack.split('\n');
    const frames = [];
    
    for (const line of lines) {
      const frame = this._parseFrame(line);
      if (frame) {
        frames.push(frame);
      }
    }
    
    return frames;
  }

  /**
   * 解析单个堆栈帧
   * @param {string} line - 堆栈行
   * @returns {Object|null} 堆栈帧对象
   */
  _parseFrame(line) {
    // Node.js 格式: "    at functionName (file.js:123:45)"
    // 或: "    at file.js:123:45"
    const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
                  line.match(/at\s+(.+?):(\d+):(\d+)/);
    
    if (!match) return null;
    
    let funcName, filePath, lineNum, colNum;
    
    if (match.length === 5) {
      funcName = match[1];
      filePath = match[2];
      lineNum = parseInt(match[3], 10);
      colNum = parseInt(match[4], 10);
    } else if (match.length === 4) {
      funcName = 'anonymous';
      filePath = match[1];
      lineNum = parseInt(match[2], 10);
      colNum = parseInt(match[3], 10);
    } else {
      return null;
    }
    
    return {
      raw: line.trim(),
      function: funcName,
      file: filePath,
      line: lineNum,
      column: colNum
    };
  }

  /**
   * 提取关键帧（排除 node_modules 等）
   * @param {Array} frames - 堆栈帧数组
   * @returns {Array} 关键帧数组
   */
  _extractKeyFrames(frames) {
    const keyFrames = frames.filter(frame => {
      // 检查是否匹配忽略模式
      for (const pattern of this.ignorePatterns) {
        if (pattern.test(frame.file) || pattern.test(frame.function)) {
          return false;
        }
      }
      return true;
    });
    
    // 限制帧数
    return keyFrames.slice(0, this.maxFrames);
  }

  /**
   * 对关键帧进行哈希
   * @param {Array} keyFrames - 关键帧数组
   * @returns {string} 哈希值
   */
  _hashFrames(keyFrames) {
    const normalizedFrames = keyFrames.map(frame => {
      // 标准化文件路径和函数名
      let normalizedFile = this._normalizePath(frame.file);
      let normalizedFunc = this._normalizeFunction(frame.function);
      
      return `${normalizedFunc}@${normalizedFile}`;
    });
    
    const fingerprintString = normalizedFrames.join('|');
    return crypto.createHash('sha256')
      .update(fingerprintString)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 标准化路径
   * @param {string} path - 原始路径
   * @returns {string} 标准化路径
   */
  _normalizePath(path) {
    let normalized = path;
    
    for (const { pattern, replacement } of this.normalizePatterns) {
      normalized = normalized.replace(pattern, replacement);
    }
    
    // 提取相对路径（从项目根目录开始）
    const relativeMatch = normalized.match(/(?:backend|frontend|services)\/(.+)/);
    if (relativeMatch) {
      return relativeMatch[1];
    }
    
    return normalized;
  }

  /**
   * 标准化函数名
   * @param {string} funcName - 原始函数名
   * @returns {string} 标准化函数名
   */
  _normalizeFunction(funcName) {
    // 移除匿名函数的数字标识
    return funcName.replace(/\.\d+/, '');
  }

  /**
   * 标准化错误消息
   * @param {string} message - 原始消息
   * @returns {string} 标准化消息模式
   */
  _normalizeMessage(message) {
    if (!message) return '';
    
    let normalized = message;
    
    // 移除具体数值、ID等动态内容
    const dynamicPatterns = [
      { pattern: /\d+/, replacement: 'NUM' },
      { pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i, replacement: 'UUID' },
      { pattern: /[a-f0-9]{32,64}/i, replacement: 'HASH' },
      { pattern: /"[^"]*"/, replacement: '"STRING"' },
      { pattern: /'[^']*'/, replacement: "'STRING'" },
      { pattern: /undefined|null/, replacement: 'NULLISH' },
      { pattern: /cannot read property '[^']+' of/, replacement: 'cannot read property of' },
      { pattern: /connection refused/i, replacement: 'connection refused' },
      { pattern: /timeout/i, replacement: 'timeout' }
    ];
    
    for (const { pattern, replacement } of dynamicPatterns) {
      normalized = normalized.replace(pattern, replacement);
    }
    
    return normalized.toLowerCase().trim();
  }

  /**
   * 计算两个错误的相似度
   * @param {Object} fp1 - 指纹1
   * @param {Object} fp2 - 指纹2
   * @returns {number} 相似度 [0-1]
   */
  similarity(fp1, fp2) {
    // 1. 指纹完全匹配
    if (fp1.fingerprint === fp2.fingerprint) {
      return 1.0;
    }
    
    // 2. 错误类型相同
    if (fp1.errorName !== fp2.errorName) {
      return 0.0;
    }
    
    // 3. 消息模式相似度
    const messageSimilarity = this._calculateStringSimilarity(
      fp1.messagePattern,
      fp2.messagePattern
    );
    
    // 4. 关键帧相似度
    const frameSimilarity = this._calculateFrameSimilarity(fp1.keyFrames, fp2.keyFrames);
    
    // 综合相似度计算
    const weights = {
      fingerprint: 0.4,
      message: 0.3,
      frames: 0.3
    };
    
    const fingerprintMatch = fp1.fingerprint === fp2.fingerprint ? 1 : 0;
    
    return (
      weights.fingerprint * fingerprintMatch +
      weights.message * messageSimilarity +
      weights.frames * frameSimilarity
    );
  }

  /**
   * 计算字符串相似度（基于编辑距离）
   * @param {string} str1 - 字符串1
   * @param {string} str2 - 字符串2
   * @returns {number} 相似度
   */
  _calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    
    const maxLen = Math.max(str1.length, str2.length);
    const minLen = Math.min(str1.length, str2.length);
    
    if (maxLen === 0) return 1;
    
    // 简化的相似度计算
    const editDistance = this._editDistance(str1, str2);
    return 1 - editDistance / maxLen;
  }

  /**
   * 计算编辑距离
   * @param {string} str1 - 字符串1
   * @param {string} str2 - 字符串2
   * @returns {number} 编辑距离
   */
  _editDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + 1
          );
        }
      }
    }
    
    return dp[m][n];
  }

  /**
   * 计算关键帧相似度
   * @param {Array} frames1 - 关键帧1
   * @param {Array} frames2 - 关键帧2
   * @returns {number} 相似度
   */
  _calculateFrameSimilarity(frames1, frames2) {
    if (!frames1.length || !frames2.length) return 0;
    if (frames1.length === 0 && frames2.length === 0) return 1;
    
    // 计算公共帧数
    let matchCount = 0;
    const maxLen = Math.max(frames1.length, frames2.length);
    
    for (const f1 of frames1) {
      for (const f2 of frames2) {
        if (f1.file === f2.file && f1.function === f2.function) {
          matchCount++;
          break;
        }
      }
    }
    
    return matchCount / maxLen;
  }

  /**
   * 从错误事件生成指纹
   * @param {Object} errorEvent - 错误事件
   * @returns {Object} 指纹对象
   */
  generateFromEvent(errorEvent) {
    const error = {
      name: errorEvent.errorName || errorEvent.name,
      message: errorEvent.message,
      stack: errorEvent.stackTrace || errorEvent.stack
    };
    
    return this.generate(error);
  }
}

module.exports = StackFingerprintGenerator;