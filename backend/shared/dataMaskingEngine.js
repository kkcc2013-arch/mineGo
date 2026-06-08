/**
 * REQ-00038: 数据脱敏规则引擎
 * 支持多种数据类型的自动脱敏处理
 */

'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('data-masking');

// ============================================================
// 脱敏规则定义
// ============================================================

const MASKING_RULES = {
  // 邮箱：保留前 3 个字符
  'email': {
    type: 'partial',
    pattern: 'keep_prefix',
    visibleChars: 3,
    description: 'exa***@example.com',
  },
  
  // 手机号：保留后 4 位
  'phone': {
    type: 'partial',
    pattern: 'keep_suffix',
    visibleChars: 4,
    description: '+861****5678',
  },
  
  // 银行卡：保留后 4 位
  'card_number': {
    type: 'partial',
    pattern: 'keep_last4',
    visibleChars: 4,
    description: '************3456',
  },
  
  // CVV：完全移除
  'cvv': {
    type: 'remove',
    description: '完全移除',
  },
  
  // IP 地址：隐藏最后一段
  'ip_address': {
    type: 'partial',
    pattern: 'mask_last_octet',
    description: '192.168.1.***',
  },
  
  // 位置：模糊化到小数点后 2 位
  'location': {
    type: 'fuzzy',
    precision: 2,
    description: '31.2304, 121.4737 → 31.23, 121.47',
  },
  
  // 身份证：保留前 4 位和后 4 位
  'id_card': {
    type: 'partial',
    pattern: 'keep_prefix_suffix',
    prefixChars: 4,
    suffixChars: 4,
    description: '3101********1234',
  },
  
  // 真实姓名：保留第一个字
  'real_name': {
    type: 'partial',
    pattern: 'keep_first',
    visibleChars: 1,
    description: '张**',
  },
  
  // 地址：只保留省市
  'address': {
    type: 'partial',
    pattern: 'keep_province_city',
    description: '上海市浦东新区*** → 上海市浦东新区',
  },
  
  // 生日：只保留年月
  'birthday': {
    type: 'partial',
    pattern: 'keep_year_month',
    description: '1990-01-15 → 1990-01-**',
  },
  
  // 密码：完全移除
  'password': {
    type: 'remove',
    description: '完全移除',
  },
  
  // 支付令牌：完全移除
  'payment_token': {
    type: 'remove',
    description: '完全移除',
  },
  
  // 设备 ID：部分脱敏
  'device_id': {
    type: 'partial',
    pattern: 'keep_prefix',
    visibleChars: 8,
    description: 'abc12345***',
  },
  
  // IV 值（精灵个体值）：部分脱敏
  'iv_values': {
    type: 'partial',
    pattern: 'range',
    description: '15 → 14-16',
  },
  
  // 默认规则
  'default': {
    type: 'partial',
    pattern: 'keep_prefix',
    visibleChars: 2,
    description: '默认脱敏规则',
  },
};

// ============================================================
// 脱敏处理函数
// ============================================================

/**
 * 邮箱脱敏
 */
function maskEmail(email, options = {}) {
  if (!email || typeof email !== 'string') return email;
  
  const visibleChars = options.visibleChars || 3;
  const atIndex = email.indexOf('@');
  
  if (atIndex <= 0) return email;
  
  const prefix = email.substring(0, Math.min(visibleChars, atIndex));
  const suffix = email.substring(atIndex);
  
  return `${prefix}***${suffix}`;
}

/**
 * 手机号脱敏
 */
function maskPhone(phone, options = {}) {
  if (!phone || typeof phone !== 'string') return phone;
  
  const visibleChars = options.visibleChars || 4;
  const digits = phone.replace(/\D/g, '');
  
  if (digits.length < visibleChars) return phone;
  
  const suffix = digits.slice(-visibleChars);
  const prefix = phone.replace(/\d/g, '*').slice(0, -visibleChars);
  
  // 保留原始格式，只替换数字
  let result = '';
  let suffixIndex = 0;
  
  for (let i = 0; i < phone.length; i++) {
    if (/\d/.test(phone[i])) {
      if (i >= phone.replace(/\D/g, '').length - visibleChars) {
        result += suffix[suffixIndex++];
      } else {
        result += '*';
      }
    } else {
      result += phone[i];
    }
  }
  
  return result;
}

/**
 * 银行卡号脱敏
 */
function maskCardNumber(cardNumber, options = {}) {
  if (!cardNumber || typeof cardNumber !== 'string') return cardNumber;
  
  const visibleChars = options.visibleChars || 4;
  const digits = cardNumber.replace(/\D/g, '');
  
  if (digits.length < visibleChars) return cardNumber;
  
  const lastDigits = digits.slice(-visibleChars);
  const masked = '*'.repeat(digits.length - visibleChars);
  
  return masked + lastDigits;
}

/**
 * IP 地址脱敏
 */
function maskIpAddress(ip, options = {}) {
  if (!ip || typeof ip !== 'string') return ip;
  
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  
  parts[3] = '***';
  return parts.join('.');
}

/**
 * 位置坐标模糊化
 */
function maskLocation(location, options = {}) {
  if (!location) return location;
  
  const precision = options.precision || 2;
  
  // 处理对象格式 {lat, lng}
  if (typeof location === 'object') {
    return {
      lat: location.lat ? parseFloat(location.lat.toFixed(precision)) : location.lat,
      lng: location.lng ? parseFloat(location.lng.toFixed(precision)) : location.lng,
    };
  }
  
  // 处理字符串格式 "lat,lng"
  if (typeof location === 'string') {
    const [lat, lng] = location.split(',').map(s => s.trim());
    if (lat && lng) {
      return `${parseFloat(lat).toFixed(precision)}, ${parseFloat(lng).toFixed(precision)}`;
    }
  }
  
  return location;
}

/**
 * 身份证号脱敏
 */
function maskIdCard(idCard, options = {}) {
  if (!idCard || typeof idCard !== 'string') return idCard;
  
  const prefixChars = options.prefixChars || 4;
  const suffixChars = options.suffixChars || 4;
  
  if (idCard.length < prefixChars + suffixChars) return idCard;
  
  const prefix = idCard.substring(0, prefixChars);
  const suffix = idCard.substring(idCard.length - suffixChars);
  const masked = '*'.repeat(idCard.length - prefixChars - suffixChars);
  
  return prefix + masked + suffix;
}

/**
 * 姓名脱敏
 */
function maskName(name, options = {}) {
  if (!name || typeof name !== 'string') return name;
  
  const visibleChars = options.visibleChars || 1;
  const prefix = name.substring(0, visibleChars);
  const masked = '*'.repeat(name.length - visibleChars);
  
  return prefix + masked;
}

/**
 * 地址脱敏
 */
function maskAddress(address, options = {}) {
  if (!address || typeof address !== 'string') return address;
  
  // 简单处理：保留省市区，移除详细地址
  const parts = address.split(/[市区县]/);
  if (parts.length >= 2) {
    return parts[0] + (address.includes('市') ? '市' : '') + 
           (parts[1] ? (address.includes('区') ? '区' : '') : '');
  }
  
  // 无法解析时，只保留前 20 个字符
  return address.length > 20 ? address.substring(0, 20) + '...' : address;
}

/**
 * 生日脱敏
 */
function maskBirthday(birthday, options = {}) {
  if (!birthday) return birthday;
  
  // ISO 格式
  if (typeof birthday === 'string') {
    const match = birthday.match(/^(\d{4}-\d{2})-\d{2}/);
    if (match) {
      return `${match[1]}-**`;
    }
  }
  
  // Date 对象
  if (birthday instanceof Date) {
    const year = birthday.getFullYear();
    const month = String(birthday.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-**`;
  }
  
  return birthday;
}

/**
 * IV 值范围模糊化
 */
function maskIvValue(value, options = {}) {
  if (typeof value !== 'number') return value;
  
  // 将精确值转换为范围（±1）
  const min = Math.max(0, value - 1);
  const max = Math.min(15, value + 1);
  
  return `${min}-${max}`;
}

/**
 * 通用部分脱敏
 */
function maskPartial(value, options = {}) {
  if (!value || typeof value !== 'string') return value;
  
  const pattern = options.pattern || 'keep_prefix';
  const visibleChars = options.visibleChars || 2;
  
  switch (pattern) {
    case 'keep_prefix':
      const prefix = value.substring(0, Math.min(visibleChars, value.length));
      return prefix + '*'.repeat(value.length - visibleChars);
    
    case 'keep_suffix':
      const suffix = value.substring(Math.max(0, value.length - visibleChars));
      return '*'.repeat(value.length - visibleChars) + suffix;
    
    case 'keep_first_last':
      const first = value.substring(0, Math.min(visibleChars, value.length));
      const last = value.substring(Math.max(0, value.length - visibleChars));
      const middle = '*'.repeat(Math.max(0, value.length - visibleChars * 2));
      return first + middle + last;
    
    default:
      return '*'.repeat(value.length);
  }
}

// ============================================================
// 主入口函数
// ============================================================

/**
 * 对数据进行脱敏处理
 * @param {string} fieldName - 字段名
 * @param {*} value - 字段值
 * @param {Object} options - 可选的自定义选项
 * @returns {*} 脱敏后的值
 */
function maskData(fieldName, value, options = {}) {
  // 空值直接返回
  if (value === null || value === undefined) {
    return value;
  }
  
  // 获取脱敏规则
  const rule = MASKING_RULES[fieldName] || MASKING_RULES['default'];
  const mergedOptions = { ...rule, ...options };
  
  // 完全移除
  if (rule.type === 'remove') {
    return undefined;
  }
  
  // 根据字段名选择脱敏方法
  switch (fieldName) {
    case 'email':
      return maskEmail(value, mergedOptions);
    
    case 'phone':
      return maskPhone(value, mergedOptions);
    
    case 'card_number':
      return maskCardNumber(value, mergedOptions);
    
    case 'cvv':
      return undefined;
    
    case 'ip_address':
      return maskIpAddress(value, mergedOptions);
    
    case 'location':
    case 'last_location':
    case 'location_history':
      return maskLocation(value, mergedOptions);
    
    case 'id_card':
      return maskIdCard(value, mergedOptions);
    
    case 'real_name':
    case 'full_name':
      return maskName(value, mergedOptions);
    
    case 'address':
    case 'billing_address':
    case 'shipping_address':
      return maskAddress(value, mergedOptions);
    
    case 'birthday':
      return maskBirthday(value, mergedOptions);
    
    case 'password':
    case 'payment_token':
      return undefined;
    
    case 'device_id':
      return maskPartial(value, { visibleChars: 8, ...mergedOptions });
    
    case 'iv_values':
      return maskIvValue(value, mergedOptions);
    
    default:
      // 使用通用脱敏
      if (rule.type === 'partial') {
        return maskPartial(value, mergedOptions);
      }
      
      return value;
  }
}

/**
 * 批量脱敏对象中的多个字段
 * @param {Object} obj - 要处理的对象
 * @param {Array<string>} fields - 要脱敏的字段列表
 * @returns {Object} 脱敏后的对象
 */
function maskObject(obj, fields) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  const result = { ...obj };
  
  for (const field of fields) {
    if (result[field] !== undefined) {
      result[field] = maskData(field, result[field]);
    }
  }
  
  return result;
}

/**
 * 注册自定义脱敏规则
 * @param {string} fieldName - 字段名
 * @param {Object} rule - 脱敏规则
 */
function registerMaskingRule(fieldName, rule) {
  MASKING_RULES[fieldName] = {
    ...MASKING_RULES['default'],
    ...rule,
  };
  
  logger.info({ fieldName, rule }, 'Registered custom masking rule');
}

/**
 * 获取所有脱敏规则
 */
function getMaskingRules() {
  return { ...MASKING_RULES };
}

/**
 * 验证脱敏是否正确（用于测试）
 */
function verifyMasking(fieldName, originalValue, maskedValue) {
  const rule = MASKING_RULES[fieldName];
  
  if (!rule) {
    return { valid: false, reason: 'No rule defined for field' };
  }
  
  if (rule.type === 'remove') {
    return {
      valid: maskedValue === undefined,
      reason: maskedValue === undefined ? 'Correctly removed' : 'Should be removed',
    };
  }
  
  // 检查是否包含原始值的部分内容
  const hasOriginalContent = String(maskedValue).includes(String(originalValue).substring(0, 2));
  
  return {
    valid: hasOriginalContent && maskedValue !== originalValue,
    reason: 'Masking applied correctly',
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  maskData,
  maskObject,
  registerMaskingRule,
  getMaskingRules,
  verifyMasking,
  // 导出具体函数供特殊场景使用
  maskEmail,
  maskPhone,
  maskCardNumber,
  maskIpAddress,
  maskLocation,
  maskIdCard,
  maskName,
  maskAddress,
  maskBirthday,
  maskIvValue,
  maskPartial,
  MASKING_RULES,
};
