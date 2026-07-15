/**
 * MemoryScanner - 游戏客户端内存扫描器
 * 
 * 功能：
 * - 定期扫描关键游戏数据结构
 * - 检测非法内存修改
 * - 实现防篡改校验
 * - 收集并上报异常数据
 * 
 * @module game-client/security/MemoryScanner
 */

'use strict';

class MemoryScanner {
  constructor(options = {}) {
    // 扫描配置
    this.scanInterval = options.scanInterval || 3000; // 3秒
    this.deepScanInterval = options.deepScanInterval || 30000; // 30秒
    this.maxViolations = options.maxViolations || 5; // 最大违规次数
    this.enabled = options.enabled !== false;
    
    // 扫描目标
    this.scanTargets = new Map();
    
    // 扫描历史
    this.scanHistory = [];
    this.maxHistorySize = 100;
    
    // 状态
    this.isScanning = false;
    this.lastScanTime = 0;
    this.lastDeepScanTime = 0;
    this.violationCount = 0;
    
    // 定时器
    this.scanTimer = null;
    this.deepScanTimer = null;
    
    // 回调
    this.onViolation = options.onViolation || null;
    this.onScanComplete = options.onScanComplete || null;
    
    // 校验规则
    this.rules = {
      // 位置数据校验
      position: {
        minLat: -90,
        maxLat: 90,
        minLng: -180,
        maxLng: 180,
        maxSpeed: 200, // km/h (正常移动速度上限)
      },
      // 精灵属性校验
      pokemon: {
        minLevel: 1,
        maxLevel: 100,
        minCp: 10,
        maxCp: 5000,
        validTypes: [], // 从配置加载
      },
      // 战斗数据校验
      battle: {
        maxDamage: 10000,
        minHp: 0,
        maxHp: 1000,
      }
    };
    
    // 统计
    this.stats = {
      totalScans: 0,
      quickScans: 0,
      deepScans: 0,
      violations: 0,
      averageScanTime: 0
    };
  }

  /**
   * 注册扫描目标
   * @param {string} name - 目标名称
   * @param {Object} config - 扫描配置
   */
  registerTarget(name, config) {
    const target = {
      name,
      type: config.type || 'object',
      getter: config.getter, // 获取数据的函数
      validator: config.validator, // 自定义验证器
      checksum: config.checksum, // 校验和生成器
      lastChecksum: null,
      lastValue: null,
      scanCount: 0,
      violationCount: 0,
      critical: config.critical || false,
      enabled: config.enabled !== false
    };

    this.scanTargets.set(name, target);
    
    console.log(`[MemoryScanner] Registered scan target: ${name}`, {
      type: target.type,
      critical: target.critical
    });

    return target;
  }

  /**
   * 注销扫描目标
   */
  unregisterTarget(name) {
    if (this.scanTargets.has(name)) {
      this.scanTargets.delete(name);
      console.log(`[MemoryScanner] Unregistered target: ${name}`);
    }
  }

  /**
   * 执行快速扫描
   */
  quickScan() {
    if (this.isScanning || !this.enabled) return null;

    this.isScanning = true;
    const startTime = performance.now();
    const results = [];
    const violations = [];

    for (const [name, target] of this.scanTargets) {
      if (!target.enabled) continue;

      try {
        // 获取当前值
        const currentValue = target.getter ? target.getter() : null;
        
        if (currentValue === null || currentValue === undefined) {
          continue;
        }

        // 计算校验和
        const currentChecksum = this.computeChecksum(currentValue, target.type);
        
        // 检查校验和变化
        const checksumChanged = target.lastChecksum !== null && 
                                 target.lastChecksum !== currentChecksum;
        
        // 验证数据有效性
        const validationResult = this.validateValue(name, currentValue, target);
        
        const result = {
          target: name,
          type: target.type,
          checksum: currentChecksum,
          checksumChanged,
          valid: validationResult.valid,
          errors: validationResult.errors || [],
          scanTime: performance.now() - startTime
        };

        results.push(result);
        target.scanCount++;

        // 检测违规
        if (checksumChanged || !validationResult.valid) {
          const violation = {
            target: name,
            type: target.type,
            previousChecksum: target.lastChecksum,
            currentChecksum,
            validationErrors: validationResult.errors,
            critical: target.critical,
            timestamp: Date.now()
          };

          violations.push(violation);
          target.violationCount++;
          this.violationCount++;
          this.stats.violations++;

          if (target.onViolation) {
            target.onViolation(violation);
          }
        }

        // 更新状态
        target.lastChecksum = currentChecksum;
        target.lastValue = currentValue;
      } catch (error) {
        console.error(`[MemoryScanner] Error scanning ${name}:`, error);
      }
    }

    this.isScanning = false;
    this.lastScanTime = Date.now();
    this.stats.quickScans++;
    this.stats.totalScans++;

    const scanDuration = performance.now() - startTime;
    this.updateAverageScanTime(scanDuration);

    const report = {
      type: 'quick',
      timestamp: Date.now(),
      duration: scanDuration,
      targetsScanned: results.length,
      violations: violations.length,
      results,
      violationsDetails: violations
    };

    this.addToHistory(report);

    if (violations.length > 0 && this.onViolation) {
      this.onViolation(violations);
    }

    if (this.onScanComplete) {
      this.onScanComplete(report);
    }

    return report;
  }

  /**
   * 执行深度扫描
   */
  deepScan() {
    if (this.isScanning || !this.enabled) return null;

    console.log('[MemoryScanner] Starting deep scan...');
    
    this.isScanning = true;
    const startTime = performance.now();
    const results = [];
    const violations = [];

    for (const [name, target] of this.scanTargets) {
      if (!target.enabled) continue;

      try {
        const currentValue = target.getter ? target.getter() : null;
        
        if (currentValue === null) continue;

        // 深度验证
        const deepValidation = this.deepValidate(name, currentValue, target);
        
        // 检查数据完整性
        const integrityCheck = this.checkDataIntegrity(currentValue, target.type);
        
        // 检查时间一致性
        const timeConsistency = this.checkTimeConsistency(name, currentValue);

        const result = {
          target: name,
          type: target.type,
          deepValidation: deepValidation.valid,
          integrityCheck: integrityCheck.valid,
          timeConsistency: timeConsistency.valid,
          errors: [
            ...deepValidation.errors,
            ...integrityCheck.errors,
            ...timeConsistency.errors
          ],
          scanTime: performance.now() - startTime
        };

        results.push(result);

        if (!deepValidation.valid || !integrityCheck.valid || !timeConsistency.valid) {
          const violation = {
            target: name,
            type: 'DEEP_SCAN',
            deepValidation,
            integrityCheck,
            timeConsistency,
            critical: target.critical,
            timestamp: Date.now()
          };

          violations.push(violation);
          target.violationCount++;
          this.violationCount++;
          this.stats.violations++;
        }
      } catch (error) {
        console.error(`[MemoryScanner] Deep scan error for ${name}:`, error);
      }
    }

    this.isScanning = false;
    this.lastDeepScanTime = Date.now();
    this.stats.deepScans++;
    this.stats.totalScans++;

    const scanDuration = performance.now() - startTime;
    this.updateAverageScanTime(scanDuration);

    const report = {
      type: 'deep',
      timestamp: Date.now(),
      duration: scanDuration,
      targetsScanned: results.length,
      violations: violations.length,
      results,
      violationsDetails: violations
    };

    this.addToHistory(report);

    console.log(`[MemoryScanner] Deep scan complete. Duration: ${scanDuration.toFixed(2)}ms, Violations: ${violations.length}`);

    if (violations.length > 0 && this.onViolation) {
      this.onViolation(violations);
    }

    if (this.onScanComplete) {
      this.onScanComplete(report);
    }

    return report;
  }

  /**
   * 计算校验和
   */
  computeChecksum(value, type) {
    try {
      let normalized;
      
      switch (type) {
        case 'position':
          // 位置数据：精度到小数点后6位
          normalized = {
            lat: Math.round(value.lat * 1e6),
            lng: Math.round(value.lng * 1e6),
            alt: Math.round(value.alt || 0)
          };
          break;
        case 'pokemon':
          // 精灵数据：只校验关键字段
          normalized = {
            id: value.id,
            level: value.level,
            cp: value.cp,
            hp: value.hp
          };
          break;
        default:
          normalized = value;
      }

      const str = JSON.stringify(normalized);
      
      // 简单哈希
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }

      return Math.abs(hash).toString(16).padStart(8, '0');
    } catch (error) {
      return 'ERROR';
    }
  }

  /**
   * 验证值
   */
  validateValue(targetName, value, targetConfig) {
    const errors = [];

    // 使用自定义验证器
    if (targetConfig.validator) {
      const customResult = targetConfig.validator(value);
      if (!customResult.valid) {
        errors.push(...customResult.errors);
      }
    }

    // 根据类型进行默认验证
    switch (targetConfig.type) {
      case 'position':
        const posResult = this.validatePosition(value);
        if (!posResult.valid) {
          errors.push(...posResult.errors);
        }
        break;
      case 'pokemon':
        const pokemonResult = this.validatePokemon(value);
        if (!pokemonResult.valid) {
          errors.push(...pokemonResult.errors);
        }
        break;
      case 'battle':
        const battleResult = this.validateBattle(value);
        if (!battleResult.valid) {
          errors.push(...battleResult.errors);
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 验证位置数据
   */
  validatePosition(position) {
    const errors = [];
    const rules = this.rules.position;

    if (position.lat < rules.minLat || position.lat > rules.maxLat) {
      errors.push(`Invalid latitude: ${position.lat}`);
    }

    if (position.lng < rules.minLng || position.lng > rules.maxLng) {
      errors.push(`Invalid longitude: ${position.lng}`);
    }

    // 检查移动速度（如果有上一个位置）
    // TODO: 实现速度检测

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 验证精灵数据
   */
  validatePokemon(pokemon) {
    const errors = [];
    const rules = this.rules.pokemon;

    if (pokemon.level < rules.minLevel || pokemon.level > rules.maxLevel) {
      errors.push(`Invalid level: ${pokemon.level}`);
    }

    if (pokemon.cp < rules.minCp || pokemon.cp > rules.maxCp) {
      errors.push(`Invalid CP: ${pokemon.cp}`);
    }

    if (pokemon.hp < rules.minHp || pokemon.hp > pokemon.maxHp) {
      errors.push(`Invalid HP: ${pokemon.hp}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 验证战斗数据
   */
  validateBattle(battle) {
    const errors = [];
    const rules = this.rules.battle;

    if (battle.damage > rules.maxDamage) {
      errors.push(`Abnormal damage: ${battle.damage}`);
    }

    if (battle.hp < rules.minHp) {
      errors.push(`Invalid HP: ${battle.hp}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 深度验证
   */
  deepValidate(targetName, value, targetConfig) {
    const errors = [];

    // 检查对象完整性
    if (typeof value !== 'object' || value === null) {
      errors.push('Value is not an object');
      return { valid: false, errors };
    }

    // 检查原型链
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
      // 正常
    } else {
      // 检查是否被篡改
      const protoStr = proto.toString();
      if (protoStr.includes('Proxy') || protoStr.includes('Modified')) {
        errors.push('Prototype chain appears modified');
      }
    }

    // 检查属性描述符
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && descriptor.get) {
        // Getter 可能被劫持
        errors.push(`Property ${key} has getter which may be hijacked`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 检查数据完整性
   */
  checkDataIntegrity(value, type) {
    const errors = [];

    // 检查是否有意外的属性
    const expectedProps = {
      position: ['lat', 'lng', 'alt', 'accuracy'],
      pokemon: ['id', 'level', 'cp', 'hp', 'maxHp'],
      battle: ['sessionId', 'hp', 'energy', 'damage']
    };

    if (expectedProps[type]) {
      const actualProps = Object.keys(value);
      const unexpected = actualProps.filter(p => !expectedProps[type].includes(p));
      
      if (unexpected.length > 0) {
        errors.push(`Unexpected properties: ${unexpected.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 检查时间一致性
   */
  checkTimeConsistency(targetName, value) {
    const errors = [];

    // 检查时间戳是否合理
    if (value.timestamp) {
      const now = Date.now();
      const diff = Math.abs(now - value.timestamp);
      
      // 时间戳不能偏离当前时间太多
      if (diff > 60000) { // 60秒
        errors.push(`Timestamp drift detected: ${diff}ms`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 更新平均扫描时间
   */
  updateAverageScanTime(duration) {
    const prevAvg = this.stats.averageScanTime;
    const count = this.stats.totalScans;
    
    this.stats.averageScanTime = (prevAvg * (count - 1) + duration) / count;
  }

  /**
   * 添加到历史记录
   */
  addToHistory(report) {
    this.scanHistory.push(report);
    
    if (this.scanHistory.length > this.maxHistorySize) {
      this.scanHistory.shift();
    }
  }

  /**
   * 启动扫描
   */
  start() {
    if (this.scanTimer) {
      console.warn('[MemoryScanner] Already running');
      return;
    }

    this.enabled = true;

    // 启动快速扫描
    this.scanTimer = setInterval(() => {
      this.quickScan();
    }, this.scanInterval);

    // 启动深度扫描
    this.deepScanTimer = setInterval(() => {
      this.deepScan();
    }, this.deepScanInterval);

    console.log(`[MemoryScanner] Started. Quick scan: ${this.scanInterval}ms, Deep scan: ${this.deepScanInterval}ms`);
  }

  /**
   * 停止扫描
   */
  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    if (this.deepScanTimer) {
      clearInterval(this.deepScanTimer);
      this.deepScanTimer = null;
    }

    this.enabled = false;
    console.log('[MemoryScanner] Stopped');
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isScanning: this.isScanning,
      lastScanTime: this.lastScanTime,
      lastDeepScanTime: this.lastDeepScanTime,
      targetsCount: this.scanTargets.size,
      violationCount: this.violationCount,
      stats: { ...this.stats },
      targets: Array.from(this.scanTargets.entries()).map(([name, target]) => ({
        name,
        type: target.type,
        scanCount: target.scanCount,
        violationCount: target.violationCount,
        critical: target.critical
      }))
    };
  }

  /**
   * 获取扫描历史
   */
  getHistory(limit = 10) {
    return this.scanHistory.slice(-limit);
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      totalScans: 0,
      quickScans: 0,
      deepScans: 0,
      violations: 0,
      averageScanTime: 0
    };
    this.violationCount = 0;
    this.scanHistory = [];
  }
}

// 导出单例
let instance = null;

function getMemoryScanner(options = {}) {
  if (!instance) {
    instance = new MemoryScanner(options);
  }
  return instance;
}

module.exports = {
  MemoryScanner,
  getMemoryScanner
};