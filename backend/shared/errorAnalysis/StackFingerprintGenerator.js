/**
 * StackFingerprintGenerator - 错误堆栈指纹生成器
 * 
 * 功能：
 * - 解析错误堆栈，提取关键帧
 * - 生成唯一指纹（去除动态部分）
 * - 计算堆栈相似度
 * 
 * @module backend/shared/errorAnalysis/StackFingerprintGenerator
 */

'use strict';

const crypto = require('crypto');

// 默认忽略的堆栈帧模式（库文件、内部模块）
const DEFAULT_IGNORE_PATTERNS = [
  /node_modules/,
  /internal\/process/,
  /internal\/timers/,
  /\.next\//,
  /dist\//,
  /build\//,
  /__test__/,
  /coverage\//,
  /node:internal/,
  /timers\.js/,
  /task_queues\.js/
];

// 动态值模式（需要替换为占位符）
const DYNAMIC_PATTERNS = [
  { pattern: /0x[0-9a-f]+/gi, replacement: '0xADDR' },  // 内存地址
  { pattern: /\d{13,}/g, replacement: 'TIMESTAMP' },  // 时间戳
  { pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, replacement: 'UUID' },  // UUID
  { pattern: /:\d+(?=\)|:)/g, replacement: ':LINE' },  // 行号
];

class StackFingerprintGenerator {
  /**
   * 构造函数
   * @param {Object} config - 配置选项
   * @param {number} config.maxFrames - 最大分析帧数
   * @param {number} config.minFrames - 最小关键帧数
   * @param {RegExp[]} config.ignorePatterns - 忽略模式
   */
  constructor(config = {}) {
    this.maxFrames = config.maxFrames || 10;
    this.minFrames = config.minFrames || 3;
    this.ignorePatterns = config.ignorePatterns || DEFAULT_IGNORE_PATTERNS;
    this.dynamicPatterns = DYNAMIC_PATTERNS;
  }

  /**
   * 生成错误指纹
   * @param {Error|string} error - 错误对象或堆栈字符串
   * @returns {Object} 指纹对象
   */
  generate(error) {
    const errorObj = this._normalizeError(error);
    const stack = errorObj.stack || '';
    const frames = this._parseStack(stack);
    const keyFrames = this._extractKeyFrames(frames);
    const normalizedMessage = this._normalizeMessage(errorObj.message);

    return {
      fingerprint: this._hashFrames(keyFrames),
      keyFrames: keyFrames,
      messagePattern: normalizedMessage,
      errorName: errorObj.name,
      errorCode: errorObj.code || null,
      frameCount: frames.length,
      keyFrameCount: keyFrames.length,
      fullStack: stack.substring(0, 2000) // 截断防止过大
    };
  }

  /**
   * 标准化错误对象
   * @private
   */
  _normalizeError(error) {
    if (typeof error === 'string') {
      return {
        name: 'Error',
        message: error,
        stack: error,
        code: null
      };
    }

    return {
      name: error.name || 'Error',
      message: error.message || '',
      stack: error.stack || '',
      code: error.code || null
    };
  }

  /**
   * 解析堆栈字符串
   * @private
   * @param {string} stack - 堆栈字符串
   * @returns {Array} 帧数组
   */
  _parseStack(stack) {
    if (!stack) return [];

    const frames = [];
    const lines = stack.split('\n');

    for (const line of lines) {
      const frame = this._parseStackFrame(line);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  }

  /**
   * 解析单行堆栈帧
   * @private
   * @param {string} line - 堆栈行
   * @returns {Object|null} 帧对象
   */
  _parseStackFrame(line) {
    // Node.js 格式: "    at functionName (file:line:col)"
    // 或: "    at file:line:col"
    const nodeMatch = line.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/);
    if (nodeMatch) {
      return {
        function: this._normalizeFunctionName(nodeMatch[1]),
        file: this._normalizeFileName(nodeMatch[2]),
        line: parseInt(nodeMatch[3], 10),
        column: parseInt(nodeMatch[4], 10),
        raw: line.trim()
      };
    }

    // 简化格式: "    at file:line:col"
    const simpleMatch = line.match(/^\s*at\s+(.+):(\d+):(\d+)$/);
    if (simpleMatch) {
      return {
        function: '<anonymous>',
        file: this._normalizeFileName(simpleMatch[1]),
        line: parseInt(simpleMatch[2], 10),
        column: parseInt(simpleMatch[3], 10),
        raw: line.trim()
      };
    }

    return null;
  }

  /**
   * 标准化函数名
   * @private
   */
  _normalizeFunctionName(name) {
    // 移除匿名函数标记
    if (name.includes('<anonymous>') || name.includes('<anonymous>')) {
      return '<anonymous>';
    }
    return name;
  }

  /**
   * 标准化文件名
   * @private
   */
  _normalizeFileName(file) {
    // 移除项目根路径
    let normalized = file.replace(/^.+\/backend\//, 'backend/');
    normalized = normalized.replace(/^.+\/frontend\//, 'frontend/');
    return normalized;
  }

  /**
   * 提取关键帧（忽略库文件）
   * @private
   * @param {Array} frames - 所有帧
   * @returns {Array} 关键帧
   */
  _extractKeyFrames(frames) {
    const keyFrames = [];

    for (const frame of frames) {
      // 检查是否应该忽略
      const shouldIgnore = this.ignorePatterns.some(pattern => 
        pattern.test(frame.file) || pattern.test(frame.function)
      );

      if (!shouldIgnore) {
        keyFrames.push({
          function: frame.function,
          file: frame.file,
          // 不包含行号（因为行号会变化）
        });

        // 达到最大关键帧数
        if (keyFrames.length >= this.maxFrames) {
          break;
        }
      }
    }

    return keyFrames;
  }

  /**
   * 标准化错误消息（移除动态部分）
   * @private
   * @param {string} message - 错误消息
   * @returns {string} 标准化后的消息
   */
  _normalizeMessage(message) {
    if (!message) return '';

    let normalized = message;

    // 应用动态值替换模式
    for (const { pattern, replacement } of this.dynamicPatterns) {
      normalized = normalized.replace(pattern, replacement);
    }

    // 限制长度
    return normalized.substring(0, 200);
  }

  /**
   * 计算关键帧的哈希值
   * @private
   * @param {Array} keyFrames - 关键帧
   * @returns {string} 哈希值
   */
  _hashFrames(keyFrames) {
    if (keyFrames.length === 0) {
      return crypto.createHash('sha256').update('empty').digest('hex').substring(0, 16);
    }

    // 构建规范化字符串
    const normalized = keyFrames
      .map(f => `${f.function}@${f.file}`)
      .join('|');

    return crypto.createHash('sha256')
      .update(normalized)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 计算两个指纹的相似度
   * @param {Object} fp1 - 指纹1
   * @param {Object} fp2 - 指纹2
   * @returns {number} 相似度 [0-1]
   */
  similarity(fp1, fp2) {
    // 快速检查：完全相同
    if (fp1.fingerprint === fp2.fingerprint) {
      return 1.0;
    }

    // 检查错误名称和消息模式
    if (fp1.errorName !== fp2.errorName) {
      return 0.0;
    }

    // 计算关键帧相似度
    const frameSimilarity = this._calculateFrameSimilarity(fp1.keyFrames, fp2.keyFrames);
    
    // 计算消息相似度
    const messageSimilarity = this._calculateMessageSimilarity(fp1.messagePattern, fp2.messagePattern);

    // 综合相似度（帧权重 70%，消息权重 30%）
    return 0.7 * frameSimilarity + 0.3 * messageSimilarity;
  }

  /**
   * 计算帧相似度
   * @private
   */
  _calculateFrameSimilarity(frames1, frames2) {
    if (frames1.length === 0 && frames2.length === 0) return 1.0;
    if (frames1.length === 0 || frames2.length === 0) return 0.0;

    // 计算公共帧比例
    const set1 = new Set(frames1.map(f => `${f.function}@${f.file}`));
    const set2 = new Set(frames2.map(f => `${f.function}@${f.file}`));

    let intersection = 0;
    for (const frame of set1) {
      if (set2.has(frame)) {
        intersection++;
      }
    }

    const union = Math.max(set1.size, set2.size);
    return intersection / union;
  }

  /**
   * 计算消息相似度
   * @private
   */
  _calculateMessageSimilarity(msg1, msg2) {
    if (!msg1 && !msg2) return 1.0;
    if (!msg1 || !msg2) return 0.0;

    // 简单的 Jaccard 相似度（基于字符集合）
    const set1 = new Set(msg1.split(''));
    const set2 = new Set(msg2.split(''));

    let intersection = 0;
    for (const char of set1) {
      if (set2.has(char)) {
        intersection++;
      }
    }

    const union = set1.size + set2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 批量生成指纹
   * @param {Array<Error>} errors - 错误数组
   * @returns {Array<Object>} 指纹数组
   */
  generateBatch(errors) {
    return errors.map(error => this.generate(error));
  }
}

module.exports = StackFingerprintGenerator;
