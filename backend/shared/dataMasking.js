/**
 * REQ-00016: 数据脱敏模块
 * 用于日志、导出等场景的敏感数据脱敏
 */

const DataMasking = {
  /**
   * 邮箱脱敏
   * @param {string} email - 邮箱地址
   * @returns {string} 脱敏后的邮箱
   * @example
   * maskEmail('user@example.com') => 'u***@example.com'
   */
  email(email) {
    if (!email || typeof email !== 'string') return email;
    const [local, domain] = email.split('@');
    if (!domain) return email;
    if (local.length <= 1) return `${local[0]}***@${domain}`;
    return `${local[0]}***@${domain}`;
  },

  /**
   * 手机号脱敏
   * @param {string} phone - 手机号
   * @returns {string} 脱敏后的手机号
   * @example
   * maskPhone('13812345678') => '138****5678'
   */
  phone(phone) {
    if (!phone || typeof phone !== 'string') return phone;
    return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  },

  /**
   * 支付方式脱敏
   * @param {string} method - 支付方式（卡号等）
   * @returns {string} 脱敏后的支付方式
   * @example
   * maskPaymentMethod('1234567890123456') => '****3456'
   */
  paymentMethod(method) {
    if (!method || typeof method !== 'string') return method;
    if (method.length <= 4) return '****';
    return `****${method.slice(-4)}`;
  },

  /**
   * GPS 位置模糊化（降低精度）
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @param {number} precision - 小数位数（默认 3，约 100 米精度）
   * @returns {{lat: number, lng: number}} 模糊化后的位置
   */
  location(lat, lng, precision = 3) {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { lat, lng };
    }
    const factor = Math.pow(10, precision);
    return {
      lat: Math.round(lat * factor) / factor,
      lng: Math.round(lng * factor) / factor
    };
  },

  /**
   * 用户名脱敏
   * @param {string} username - 用户名
   * @returns {string} 脱敏后的用户名
   * @example
   * maskUsername('john_doe') => 'joh***'
   */
  username(username) {
    if (!username || typeof username !== 'string') return username;
    if (username.length <= 3) return `${username[0]}***`;
    return `${username.slice(0, 3)}***`;
  },

  /**
   * IP 地址脱敏
   * @param {string} ip - IP 地址
   * @returns {string} 脱敏后的 IP
   * @example
   * maskIP('192.168.1.100') => '192.168.*.*'
   */
  ip(ip) {
    if (!ip || typeof ip !== 'string') return ip;
    // IPv4
    if (ip.includes('.')) {
      const parts = ip.split('.');
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.*.*`;
      }
    }
    // IPv6 - 保留前两段
    if (ip.includes(':')) {
      const parts = ip.split(':');
      if (parts.length >= 2) {
        return `${parts[0]}:${parts[1]}:****`;
      }
    }
    return ip;
  },

  /**
   * 通用字符串脱敏
   * @param {string} str - 字符串
   * @param {number} visibleChars - 可见字符数（前后各保留）
   * @returns {string} 脱敏后的字符串
   */
  string(str, visibleChars = 2) {
    if (!str || typeof str !== 'string') return str;
    if (str.length <= visibleChars * 2) return '****';
    return `${str.slice(0, visibleChars)}****${str.slice(-visibleChars)}`;
  },

  /**
   * 对象字段脱敏
   * @param {object} obj - 对象
   * @param {object} rules - 脱敏规则 { field: 'email' | 'phone' | 'ip' | ... }
   * @returns {object} 脱敏后的对象
   */
  object(obj, rules) {
    if (!obj || typeof obj !== 'object') return obj;
    
    const result = { ...obj };
    
    for (const [field, type] of Object.entries(rules)) {
      if (result[field] !== undefined) {
        switch (type) {
          case 'email':
            result[field] = this.email(result[field]);
            break;
          case 'phone':
            result[field] = this.phone(result[field]);
            break;
          case 'paymentMethod':
            result[field] = this.paymentMethod(result[field]);
            break;
          case 'username':
            result[field] = this.username(result[field]);
            break;
          case 'ip':
            result[field] = this.ip(result[field]);
            break;
          default:
            result[field] = this.string(result[field]);
        }
      }
    }
    
    return result;
  },

  /**
   * 身份证号脱敏
   * @param {string} idCard - 身份证号
   * @returns {string} 脱敏后的身份证号
   * @example
   * maskIdCard('310101199001011234') => '3101********1234'
   */
  idCard(idCard) {
    if (!idCard || typeof idCard !== 'string') return idCard;
    if (idCard.length < 8) return '****';
    const prefixLen = 4;
    const suffixLen = 4;
    const maskedLen = idCard.length - prefixLen - suffixLen;
    return `${idCard.slice(0, prefixLen)}${'*'.repeat(maskedLen)}${idCard.slice(-suffixLen)}`;
  },

  /**
   * 银行卡号脱敏
   * @param {string} cardNumber - 银行卡号
   * @returns {string} 脱敏后的银行卡号
   * @example
   * maskBankCard('6222021234567890123') => '6222 **** **** 0123'
   */
  bankCard(cardNumber) {
    if (!cardNumber || typeof cardNumber !== 'string') return cardNumber;
    if (cardNumber.length <= 8) return '****';
    return `${cardNumber.slice(0, 4)} **** **** ${cardNumber.slice(-4)}`;
  },

  /**
   * 经纬度模糊化
   * @param {number} coordinate - 经纬度值
   * @param {number} precision - 保留小数位数（默认 2，约 1km 精度）
   * @returns {number} 模糊化后的值
   */
  coordinate(coordinate, precision = 2) {
    if (typeof coordinate !== 'number') return coordinate;
    const factor = Math.pow(10, precision);
    return Math.round(coordinate * factor) / factor;
  },

  /**
   * 日期脱敏（保留年月，隐藏日）
   * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)
   * @returns {string} 脱敏后的日期
   * @example
   * maskDate('1990-01-01') => '1990-01-**'
   */
  date(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    if (!dateStr.includes('-')) return dateStr;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[0]}-${parts[1]}-**`;
    }
    return dateStr;
  },

  /**
   * 姓名脱敏
   * @param {string} name - 姓名
   * @returns {string} 脱敏后的姓名
   * @example
   * maskName('张三丰') => '张**'
   * maskName('John Doe') => 'Joh***'
   */
  name(name) {
    if (!name || typeof name !== 'string') return name;
    if (name.length <= 1) return '*';
    // 中文名
    if (/[\u4e00-\u9fa5]/.test(name)) {
      return name[0] + '*'.repeat(name.length - 1);
    }
    // 英文名
    return name.slice(0, 3) + '***';
  },

  /**
   * URL 脱敏（隐藏查询参数中的敏感信息）
   * @param {string} url - URL
   * @returns {string} 脱敏后的 URL
   */
  url(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      const urlObj = new URL(url);
      // 移除敏感查询参数
      const sensitiveParams = ['token', 'key', 'secret', 'password', 'session'];
      sensitiveParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
          urlObj.searchParams.set(param, '***REDACTED***');
        }
      });
      return urlObj.toString();
    } catch {
      return url;
    }
  },

  /**
   * JSON 字符串中的敏感字段脱敏
   * @param {string} jsonStr - JSON 字符串
   * @param {string[]} sensitiveKeys - 敏感字段名列表
   * @returns {string} 脱敏后的 JSON 字符串
   */
  jsonString(jsonStr, sensitiveKeys = ['password', 'token', 'secret', 'key']) {
    if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;
    let result = jsonStr;
    sensitiveKeys.forEach(key => {
      const regex = new RegExp(`"${key}"\\s*:\\s*"[^"]*"`, 'gi');
      result = result.replace(regex, `"${key}":"***REDACTED***"`);
    });
    return result;
  },

  /**
   * 批量脱敏用户数据
   * @param {object} userData - 用户数据
   * @returns {object} 脱敏后的用户数据
   */
  maskUserData(userData) {
    return this.object(userData, {
      email: 'email',
      phone: 'phone',
      username: 'username',
      ip_address: 'ip',
      payment_method: 'paymentMethod',
      real_name: 'name',
      id_card: 'idCard',
      address: 'string',
    });
  }
};

module.exports = DataMasking;
