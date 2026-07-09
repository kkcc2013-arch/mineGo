/**
 * CaptureValidator - 捕捉请求验证服务
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 * 
 * 功能：
 * - 位置合理性验证
 * - 设备指纹验证
 * - 传感器数据验证
 * - 捕捉窗口验证
 * - 客户端安全检测验证
 */

const db = require('../../shared/db');
const logger = require('../../shared/logger');
const metrics = require('../../shared/metrics');
const SensorValidator = require('../src/sensorValidator');
const CaptureBehaviorAnalyzer = require('../../analysis/src/captureBehaviorAnalyzer');

class CaptureValidator {
  constructor() {
    this.sensorValidator = new SensorValidator();
    this.behaviorAnalyzer = new CaptureBehaviorAnalyzer();
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initMetrics() {
    return {
      validationsTotal: metrics.registerCounter(
        'capture_validation_total',
        'Total capture validations',
        ['result', 'action']
      ),
      validationsBlocked: metrics.registerCounter(
        'capture_validation_blocked_total',
        'Total blocked capture attempts',
        ['reason']
      ),
      validationDuration: metrics.registerHistogram(
        'capture_validation_duration_seconds',
        'Capture validation duration',
        { buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1] }
      )
    };
  }

  /**
   * 验证捕捉请求
   */
  async validateCaptureRequest(userId, requestData) {
    const startTime = Date.now();
    const validations = {
      location: null,
      device: null,
      sensors: null,
      window: null,
      clientChecks: null
    };

    try {
      // 1. 位置合理性验证
      validations.location = await this._validateLocation(
        userId,
        requestData.location,
        requestData.timestamp
      );

      // 2. 设备指纹验证
      validations.device = await this._validateDevice(
        userId,
        requestData.deviceFingerprint
      );

      // 3. 传感器数据验证
      if (requestData.sensorData) {
        validations.sensors = await this.sensorValidator.validate(requestData.sensorData);
      }

      // 4. 捕捉窗口验证
      validations.window = await this._validateCaptureWindow(
        userId,
        requestData.pokemonId,
        requestData.captureSessionId
      );

      // 5. 客户端检测结果验证
      validations.clientChecks = await this._validateClientChecks(
        requestData.clientSecurityChecks
      );

      // 计算整体结果
      const overallValid = Object.values(validations)
        .filter(v => v !== null)
        .every(v => v.valid !== false);

      const riskLevel = this._calculateOverallRisk(validations);
      const action = this._determineAction(riskLevel);

      // 记录指标
      this.metrics.validationsTotal.inc({
        result: overallValid ? 'valid' : 'invalid',
        action: action.type
      });

      if (!overallValid || action.type === 'reject') {
        this.metrics.validationsBlocked.inc({ reason: action.reason });
      }

      // 记录验证结果
      await this._recordValidation(userId, requestData, {
        overallValid,
        riskLevel,
        action,
        validations
      });

      logger.info('Capture request validated', {
        userId,
        pokemonId: requestData.pokemonId,
        overallValid,
        riskLevel,
        action: action.type
      });

      return {
        valid: overallValid,
        riskLevel,
        validations,
        action
      };
    } catch (error) {
      logger.error('Failed to validate capture request', {
        userId,
        error: error.message
      });

      return {
        valid: false,
        riskLevel: 'high',
        action: { type: 'reject', reason: 'validation_error' },
        error: error.message
      };
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.validationDuration.observe(duration);
    }
  }

  /**
   * 验证位置合理性
   */
  async _validateLocation(userId, location, timestamp) {
    const anomalies = [];

    try {
      // 1. 检查精灵当前位置
      const pokemonLocation = await this._getPokemonLocation(location.pokemonId);
      if (pokemonLocation) {
        const distance = this._calculateDistance(
          location.latitude, location.longitude,
          pokemonLocation.latitude, pokemonLocation.longitude
        );

        // 捕捉范围应在精灵周围 100 米内
        if (distance > 0.1) {
          anomalies.push({
            type: 'outside_capture_range',
            distance: distance.toFixed(3),
            threshold: 0.1
          });
        }
      }

      // 2. 检查用户最近位置（防止瞬移）
      const recentLocation = await this._getUserRecentLocation(userId);
      if (recentLocation) {
        const distance = this._calculateDistance(
          location.latitude, location.longitude,
          recentLocation.latitude, recentLocation.longitude
        );
        const timeDiff = (new Date(timestamp) - new Date(recentLocation.timestamp)) / 1000;

        if (timeDiff > 0) {
          const speed = (distance / timeDiff) * 3600; // km/h

          // 速度超过 200 km/h 视为异常
          if (speed > 200) {
            anomalies.push({
              type: 'impossible_travel',
              speed: speed.toFixed(2),
              distance: distance.toFixed(3),
              timeDiff: timeDiff.toFixed(1)
            });
          }
        }
      }

      // 3. 检查位置精度（GPS 精度应小于 50 米）
      if (location.accuracy && location.accuracy > 50) {
        anomalies.push({
          type: 'low_accuracy',
          accuracy: location.accuracy,
          threshold: 50
        });
      }

      // 4. 检查 Mock Location 标记
      if (location.isMockLocation) {
        anomalies.push({
          type: 'mock_location',
          severity: 'critical'
        });
      }

      const valid = anomalies.length === 0;

      return {
        valid,
        anomalies,
        confidence: valid ? 1.0 : Math.max(0, 1 - anomalies.length * 0.2)
      };
    } catch (error) {
      logger.error('Failed to validate location', { userId, error });
      return { valid: true, anomalies: [], confidence: 0.5 }; // 默认通过
    }
  }

  /**
   * 验证设备指纹
   */
  async _validateDevice(userId, fingerprint) {
    const anomalies = [];

    try {
      if (!fingerprint) {
        anomalies.push({ type: 'missing_fingerprint' });
        return { valid: false, anomalies };
      }

      // 1. 检查设备是否已注册
      const registered = await this._isDeviceRegistered(userId, fingerprint.deviceId);
      if (!registered) {
        anomalies.push({ type: 'unregistered_device' });
      }

      // 2. 检查模拟器标记
      if (fingerprint.emulatorDetected) {
        anomalies.push({ type: 'emulator_detected', severity: 'high' });
      }

      // 3. 检查 Root 标记
      if (fingerprint.rootDetected) {
        anomalies.push({ type: 'root_detected', severity: 'medium' });
      }

      // 4. 检查注入框架标记
      if (fingerprint.fridaDetected || fingerprint.xposedDetected) {
        anomalies.push({ type: 'injection_framework', severity: 'critical' });
      }

      // 5. 检查设备信息完整性
      const requiredFields = ['deviceId', 'platform', 'osVersion', 'model'];
      const missingFields = requiredFields.filter(f => !fingerprint[f]);
      if (missingFields.length > 0) {
        anomalies.push({ type: 'incomplete_device_info', missing: missingFields });
      }

      // 6. 检查指纹一致性
      const consistency = await this._checkFingerprintConsistency(userId, fingerprint);
      if (!consistency.match) {
        anomalies.push({ type: 'fingerprint_mismatch', changes: consistency.changes });
      }

      const valid = anomalies.filter(a => a.severity !== 'critical').length === 0;

      return {
        valid,
        anomalies,
        trustScore: fingerprint.trustScore || (valid ? 100 : 50)
      };
    } catch (error) {
      logger.error('Failed to validate device', { userId, error });
      return { valid: true, anomalies: [], trustScore: 50 };
    }
  }

  /**
   * 验证捕捉窗口
   */
  async _validateCaptureWindow(userId, pokemonId, sessionId) {
    const anomalies = [];

    try {
      // 1. 检查捕捉会话是否存在
      const session = await this._getCaptureSession(sessionId);
      if (!session) {
        anomalies.push({ type: 'invalid_session', sessionId });
        return { valid: false, anomalies };
      }

      // 2. 检查会话是否过期
      const sessionAge = Date.now() - new Date(session.createdAt).getTime();
      if (sessionAge > 60000) { // 超过 1 分钟
        anomalies.push({ type: 'expired_session', age: sessionAge });
      }

      // 3. 检查精灵是否在捕捉窗口内
      if (session.pokemonId !== pokemonId) {
        anomalies.push({ type: 'pokemon_mismatch', expected: session.pokemonId, actual: pokemonId });
      }

      // 4. 检查用户是否已尝试捕捉
      if (session.userId !== userId) {
        anomalies.push({ type: 'user_mismatch', expected: session.userId, actual: userId });
      }

      // 5. 检查捕捉次数限制
      const attemptCount = await this._getCaptureAttemptCount(userId, pokemonId, sessionId);
      if (attemptCount >= 3) {
        anomalies.push({ type: 'exceed_attempt_limit', count: attemptCount });
      }

      const valid = anomalies.length === 0;

      return {
        valid,
        anomalies,
        sessionAge,
        attemptCount
      };
    } catch (error) {
      logger.error('Failed to validate capture window', { userId, error });
      return { valid: true, anomalies: [] };
    }
  }

  /**
   * 验证客户端检测结果
   */
  async _validateClientChecks(clientChecks) {
    const anomalies = [];

    try {
      if (!clientChecks) {
        anomalies.push({ type: 'missing_client_checks' });
        return { valid: false, anomalies };
      }

      // 1. 检查 Mock Location
      if (clientChecks.mockLocationEnabled) {
        anomalies.push({ type: 'mock_location_enabled', severity: 'critical' });
      }

      // 2. 检查模拟器
      if (clientChecks.emulatorDetected) {
        anomalies.push({ type: 'emulator_detected_client', severity: 'high' });
      }

      // 3. 检查 Root
      if (clientChecks.rootDetected) {
        anomalies.push({ type: 'root_detected_client', severity: 'medium' });
      }

      // 4. 检查注入工具
      if (clientChecks.fridaDetected || clientChecks.xposedDetected) {
        anomalies.push({ type: 'injection_detected_client', severity: 'critical' });
      }

      // 5. 检查安全完整性
      if (!clientChecks.securityIntegrityValid) {
        anomalies.push({ type: 'security_integrity_violation', severity: 'high' });
      }

      const valid = anomalies.filter(a => a.severity !== 'critical').length === 0;

      return {
        valid,
        anomalies,
        checkTimestamp: clientChecks.timestamp
      };
    } catch (error) {
      logger.error('Failed to validate client checks', { error });
      return { valid: false, anomalies: [{ type: 'validation_error' }] };
    }
  }

  /**
   * 计算整体风险等级
   */
  _calculateOverallRisk(validations) {
    let maxRisk = 'low';

    for (const [key, validation] of Object.entries(validations)) {
      if (!validation) continue;

      // 检查是否有严重异常
      if (validation.anomalies) {
        const hasCritical = validation.anomalies.some(a => a.severity === 'critical');
        const hasHigh = validation.anomalies.some(a => a.severity === 'high');

        if (hasCritical) return 'critical';
        if (hasHigh) maxRisk = 'high';
      }

      // 如果验证失败，至少是中等风险
      if (!validation.valid && maxRisk === 'low') {
        maxRisk = 'medium';
      }
    }

    return maxRisk;
  }

  /**
   * 确定响应动作
   */
  _determineAction(riskLevel) {
    switch (riskLevel) {
      case 'critical':
        return {
          type: 'reject',
          reason: 'security_violation',
          log: true,
          notifyAdmin: true
        };
      case 'high':
        return {
          type: 'flag',
          reason: 'suspicious_activity',
          review: true,
          log: true
        };
      case 'medium':
        return {
          type: 'monitor',
          reason: 'anomaly_detected',
          track: true,
          enhancedValidation: true
        };
      case 'low':
      default:
        return {
          type: 'allow',
          reason: 'normal'
        };
    }
  }

  /**
   * 记录验证结果
   */
  async _recordValidation(userId, requestData, result) {
    try {
      await db.query(`
        INSERT INTO capture_validations (
          user_id, pokemon_id, capture_session_id,
          validation_result, risk_level, action_taken,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      `, [
        userId,
        requestData.pokemonId,
        requestData.captureSessionId,
        JSON.stringify(result.validations),
        result.riskLevel,
        result.action.type
      ]);
    } catch (error) {
      logger.error('Failed to record validation', { userId, error });
    }
  }

  // ========== 辅助方法 ==========

  /**
   * 获取精灵当前位置
   */
  async _getPokemonLocation(pokemonId) {
    try {
      const { rows } = await db.query(`
        SELECT latitude, longitude
        FROM pokemon_spawn_points
        WHERE pokemon_id = $1
          AND is_active = true
          AND expires_at > NOW()
        LIMIT 1
      `, [pokemonId]);

      return rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 获取用户最近位置
   */
  async _getUserRecentLocation(userId) {
    try {
      const { rows } = await db.query(`
        SELECT latitude, longitude, created_at as timestamp
        FROM user_activities
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);

      return rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 检查设备是否已注册
   */
  async _isDeviceRegistered(userId, deviceId) {
    try {
      const { rows } = await db.query(`
        SELECT id FROM device_fingerprints
        WHERE user_id = $1 AND device_id = $2
        LIMIT 1
      `, [userId, deviceId]);

      return rows.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * 检查指纹一致性
   */
  async _checkFingerprintConsistency(userId, fingerprint) {
    try {
      const { rows } = await db.query(`
        SELECT device_info
        FROM device_fingerprints
        WHERE user_id = $1 AND device_id = $2
        ORDER BY last_seen DESC
        LIMIT 1
      `, [userId, fingerprint.deviceId]);

      if (!rows[0]) {
        return { match: true, changes: [] };
      }

      const stored = rows[0].device_info;
      const changes = [];

      // 检查关键字段变化
      const fields = ['platform', 'model', 'osVersion'];
      fields.forEach(field => {
        if (stored[field] !== fingerprint[field]) {
          changes.push({ field, old: stored[field], new: fingerprint[field] });
        }
      });

      return { match: changes.length === 0, changes };
    } catch (error) {
      return { match: true, changes: [] };
    }
  }

  /**
   * 获取捕捉会话
   */
  async _getCaptureSession(sessionId) {
    try {
      const { rows } = await db.query(`
        SELECT * FROM capture_sessions
        WHERE session_id = $1
        LIMIT 1
      `, [sessionId]);

      return rows[0] || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 获取捕捉尝试次数
   */
  async _getCaptureAttemptCount(userId, pokemonId, sessionId) {
    try {
      const { rows } = await db.query(`
        SELECT COUNT(*) as count
        FROM capture_attempts
        WHERE user_id = $1
          AND pokemon_id = $2
          AND session_id = $3
      `, [userId, pokemonId, sessionId]);

      return parseInt(rows[0]?.count || 0);
    } catch (error) {
      return 0;
    }
  }

  /**
   * 计算两点间距离（Haversine 公式）
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（km）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}

module.exports = CaptureValidator;