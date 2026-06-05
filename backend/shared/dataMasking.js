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
      payment_method: 'paymentMethod'
    });
  }
};

module.exports = DataMasking;
