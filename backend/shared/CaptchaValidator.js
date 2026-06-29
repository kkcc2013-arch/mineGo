'use strict';

const crypto = require('crypto');

/**
 * CAPTCHA 验证器
 * 验证答案正确性并分析行为轨迹检测机器人
 */

class CaptchaValidator {
  constructor(config = {}) {
    this.config = {
      minResponseTime: { low: 1000, medium: 2000, high: 3000 },
      trajectoryMinPoints: 10,
      trajectoryJitterThreshold: 0.5,
      trajectorySpeedVarianceThreshold: 0.1,
      deviceFingerprintTolerance: 0.8,
      ...config
    };
  }

  /**
   * 验证答案
   * @param {Object} session - 验证会话
   * @param {Object} answer - 用户答案
   * @param {Object} clientData - 客户端数据
   * @returns {Object} 验证结果
   */
  validate(session, answer, clientData = {}) {
    const result = {
      valid: false,
      errors: [],
      warnings: [],
      analysis: {}
    };

    // 1. 检查会话状态
    if (session.status !== 'pending') {
      result.errors.push('session_already_completed');
      return result;
    }

    // 2. 检查过期时间
    if (new Date() > new Date(session.expires_at)) {
      result.errors.push('session_expired');
      return result;
    }

    // 3. 检查尝试次数
    if (session.attempt_count >= session.max_attempts) {
      result.errors.push('max_attempts_exceeded');
      return result;
    }

    // 4. 验证答案正确性
    const answerValidation = this._validateAnswer(session, answer);
    if (!answerValidation.correct) {
      result.errors.push('incorrect_answer');
      result.analysis.answerValidation = answerValidation;
      return result;
    }

    // 5. 行为分析（防机器人）
    const behaviorAnalysis = this._analyzeBehavior(session, clientData);
    result.analysis.behavior = behaviorAnalysis;

    if (behaviorAnalysis.botProbability > 0.7) {
      result.warnings.push('suspicious_behavior_detected');
      result.analysis.botProbability = behaviorAnalysis.botProbability;
    }

    // 6. 设备指纹校验
    if (clientData.deviceFingerprint && session.device_fingerprint) {
      const fingerprintMatch = this._checkDeviceFingerprint(
        clientData.deviceFingerprint,
        session.device_fingerprint
      );
      result.analysis.deviceMatch = fingerprintMatch;
      
      if (!fingerprintMatch) {
        result.warnings.push('device_fingerprint_changed');
      }
    }

    // 综合判定
    result.valid = answerValidation.correct && 
                   behaviorAnalysis.botProbability < 0.9;

    return result;
  }

  /**
   * 验证答案正确性
   */
  _validateAnswer(session, answer) {
    const result = {
      correct: false,
      type: session.session_type
    };

    switch (session.session_type) {
      case 'slide':
        result.correct = this._validateSlideAnswer(session, answer);
        break;
      case 'click':
        result.correct = this._validateClickAnswer(session, answer);
        break;
      case 'calculate':
        result.correct = this._validateCalculateAnswer(session, answer);
        break;
      default:
        result.correct = false;
    }

    return result;
  }

  /**
   * 验证滑动答案
   */
  _validateSlideAnswer(session, answer) {
    if (!answer.pieces || !Array.isArray(answer.pieces)) {
      return false;
    }

    // 检查拼图是否完成
    const gridSize = session.challenge_data.gridSize;
    for (let i = 0; i < answer.pieces.length; i++) {
      const piece = answer.pieces[i];
      if (piece.correctPosition !== i) {
        return false;
      }
    }

    // 验证哈希
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(answer.pieces.map(p => p.correctPosition)))
      .digest('hex');

    return hash === session.expected_answer.answerHash;
  }

  /**
   * 验证点击答案
   */
  _validateClickAnswer(session, answer) {
    if (!answer.clickedPositions || !Array.isArray(answer.clickedPositions)) {
      return false;
    }

    // 检查点击数量
    if (answer.clickedPositions.length !== session.challenge_data.targetChars.length) {
      return false;
    }

    // 检查是否按顺序点击
    if (session.challenge_data.sequence) {
      const grid = session.challenge_data.grid;
      const targetChars = session.challenge_data.targetChars;
      
      for (let i = 0; i < targetChars.length; i++) {
        const pos = answer.clickedPositions[i];
        if (grid[pos] !== targetChars[i]) {
          return false;
        }
      }
    } else {
      // 不需要按顺序，但必须全部选中
      const grid = session.challenge_data.grid;
      const targetChars = session.challenge_data.targetChars;
      const clickedChars = answer.clickedPositions.map(pos => grid[pos]);
      
      if (clickedChars.length !== targetChars.length) {
        return false;
      }
      
      // 检查是否包含所有目标字符
      for (const char of targetChars) {
        if (!clickedChars.includes(char)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 验证计算答案
   */
  _validateCalculateAnswer(session, answer) {
    if (!answer.selectedOption) {
      return false;
    }

    // 检查选项索引
    const selectedIndex = parseInt(answer.selectedOption, 10);
    if (selectedIndex < 0 || selectedIndex >= session.challenge_data.options.length) {
      return false;
    }

    // 验证是否为正确答案
    return selectedIndex === session.expected_answer.correctOptionIndex;
  }

  /**
   * 分析行为（防机器人检测）
   */
  _analyzeBehavior(session, clientData) {
    const analysis = {
      botProbability: 0,
      timeAnalysis: null,
      trajectoryAnalysis: null,
      deviceAnalysis: null
    };

    // 1. 时间分析
    if (clientData.responseTimeMs) {
      analysis.timeAnalysis = this._analyzeResponseTime(
        clientData.responseTimeMs,
        session.difficulty
      );
      
      if (analysis.timeAnalysis.tooFast) {
        analysis.botProbability += 0.3;
      }
      
      if (analysis.timeAnalysis.tooSlow) {
        analysis.botProbability += 0.1; // 可能是脚本等待后提交
      }
    }

    // 2. 轨迹分析（滑动验证）
    if (clientData.trajectory && session.session_type === 'slide') {
      analysis.trajectoryAnalysis = this._analyzeTrajectory(clientData.trajectory);
      
      if (analysis.trajectoryAnalysis.isSmooth) {
        analysis.botProbability += 0.4;
      }
      
      if (analysis.trajectoryAnalysis.isLinear) {
        analysis.botProbability += 0.2;
      }
    }

    // 3. 设备分析
    if (clientData.deviceInfo) {
      analysis.deviceAnalysis = this._analyzeDevice(clientData.deviceInfo);
      
      if (analysis.deviceAnalysis.isEmulator) {
        analysis.botProbability += 0.5;
      }
    }

    // 限制概率上限
    analysis.botProbability = Math.min(analysis.botProbability, 1.0);

    return analysis;
  }

  /**
   * 分析响应时间
   */
  _analyzeResponseTime(responseTimeMs, difficulty) {
    const minTime = this.config.minResponseTime[difficulty] || 2000;
    
    return {
      responseTimeMs,
      tooFast: responseTimeMs < minTime,
      tooSlow: responseTimeMs > 60000, // 超过1分钟视为异常
      minExpected: minTime,
      normalRange: [minTime, 30000]
    };
  }

  /**
   * 分析轨迹（判断是否为人类）
   */
  _analyzeTrajectory(trajectory) {
    if (!trajectory || trajectory.length < this.config.trajectoryMinPoints) {
      return {
        isSmooth: true,
        isLinear: true,
        variance: 0,
        reason: 'insufficient_data'
      };
    }

    // 计算速度变化
    const speeds = [];
    for (let i = 1; i < trajectory.length; i++) {
      const dx = trajectory[i].x - trajectory[i-1].x;
      const dy = trajectory[i].y - trajectory[i-1].y;
      const dt = trajectory[i].t - trajectory[i-1].t;
      
      if (dt > 0) {
        const speed = Math.sqrt(dx*dx + dy*dy) / dt;
        speeds.push(speed);
      }
    }

    // 计算速度方差（人类特征：不均匀）
    const speedVariance = this._calculateVariance(speeds);

    // 计算抖动（人类特征：有微小抖动）
    const jitter = this._calculateJitter(trajectory);

    // 计算轨迹直线度（脚本特征：过于直线）
    const linearity = this._calculateLinearity(trajectory);

    // 判断是否为机器人
    const isSmooth = speedVariance < this.config.trajectorySpeedVarianceThreshold;
    const isLinear = linearity > 0.95;

    return {
      isSmooth,
      isLinear,
      speedVariance,
      jitter,
      linearity,
      dataPoints: trajectory.length,
      reason: isSmooth || isLinear ? 'possible_script' : 'human_like'
    };
  }

  /**
   * 分析设备信息
   */
  _analyzeDevice(deviceInfo) {
    const suspiciousIndicators = {
      isEmulator: false,
      isRooted: false,
      hasAutomationTools: false
    };

    // 检查模拟器特征
    const emulatorPatterns = [
      'generic',
      'emulator',
      'sdk',
      'x86',
      'vbox',
      'qemu'
    ];

    if (deviceInfo.userAgent) {
      const ua = deviceInfo.userAgent.toLowerCase();
      suspiciousIndicators.isEmulator = emulatorPatterns.some(p => ua.includes(p));
    }

    // 检查自动化工具
    const automationPatterns = [
      'selenium',
      'webdriver',
      'phantom',
      'headless',
      'automation',
      'puppeteer'
    ];

    if (deviceInfo.webdriver || deviceInfo.automation) {
      suspiciousIndicators.hasAutomationTools = true;
    }

    if (deviceInfo.userAgent) {
      const ua = deviceInfo.userAgent.toLowerCase();
      suspiciousIndicators.hasAutomationTools = automationPatterns.some(p => ua.includes(p));
    }

    return suspiciousIndicators;
  }

  /**
   * 检查设备指纹一致性
   */
  _checkDeviceFingerprint(currentFingerprint, sessionFingerprint) {
    if (!currentFingerprint || !sessionFingerprint) {
      return true; // 没有数据则跳过检查
    }

    // 使用 DeviceFingerprint 的相似度计算
    const DeviceFingerprint = require('./DeviceFingerprint');
    const df = new DeviceFingerprint();
    
    const similarity = df.calculateSimilarity(currentFingerprint, sessionFingerprint);
    return similarity >= this.config.deviceFingerprintTolerance;
  }

  /**
   * 计算方差
   */
  _calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.map(v => (v - mean) * (v - mean));
    return squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * 计算抖动
   */
  _calculateJitter(trajectory) {
    let jitterSum = 0;
    
    for (let i = 2; i < trajectory.length; i++) {
      const dx = trajectory[i].x - trajectory[i-1].x;
      const dy = trajectory[i].y - trajectory[i-1].y;
      const prevDx = trajectory[i-1].x - trajectory[i-2].x;
      const prevDy = trajectory[i-1].y - trajectory[i-2].y;
      
      // 计算方向变化
      const angleChange = Math.abs(
        Math.atan2(dy, dx) - Math.atan2(prevDy, prevDx)
      );
      jitterSum += angleChange;
    }
    
    return jitterSum / (trajectory.length - 2);
  }

  /**
   * 计算轨迹直线度
   */
  _calculateLinearity(trajectory) {
    if (trajectory.length < 3) return 1;

    // 计算起点到终点的直线
    const start = trajectory[0];
    const end = trajectory[trajectory.length - 1];
    
    // 计算点到直线的平均偏差
    let totalDeviation = 0;
    
    for (const point of trajectory) {
      // 点到直线的距离公式
      const numerator = Math.abs(
        (end.y - start.y) * point.x - 
        (end.x - start.x) * point.y + 
        end.x * start.y - 
        end.y * start.x
      );
      
      const denominator = Math.sqrt(
        (end.y - start.y) ** 2 + (end.x - start.x) ** 2
      );
      
      if (denominator > 0) {
        totalDeviation += numerator / denominator;
      }
    }
    
    const avgDeviation = totalDeviation / trajectory.length;
    
    // 直线度：偏差越小越接近直线
    const linearity = Math.max(0, 1 - avgDeviation / 100);
    
    return linearity;
  }
}

module.exports = CaptchaValidator;