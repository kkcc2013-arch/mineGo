/**
 * REQ-00485: 敏感数据脱敏引擎
 * 根据数据类型和用户角色自动脱敏敏感字段
 */

class DataMaskingEngine {
  constructor() {
    // 脱敏规则定义
    this.maskingRules = {
      // 用户数据
      user: {
        email: { type: 'email', partial: true },
        phone: { type: 'phone', showLast: 4 },
        real_name: { type: 'name', showFirst: 1 },
        id_number: { type: 'full' },
        password_hash: { type: 'full' },
        two_factor_secret: { type: 'full' },
        device_id: { type: 'device', showLast: 8 }
      },
      // 支付数据
      payment: {
        card_number: { type: 'card', showLast: 4 },
        card_holder: { type: 'name', showFirst: 1 },
        cvv: { type: 'full' },
        billing_address: { type: 'address', partial: true }
      },
      // 位置数据
      location: {
        exact_gps: { type: 'gps', precision: 0.001 },  // 精度降低到100米
        ip_address: { type: 'ip', partial: true },
        latitude: { type: 'gps', precision: 0.001 },
        longitude: { type: 'gps', precision: 0.001 }
      },
      // 社交数据
      social: {
        friend_ids: { type: 'list', maxShow: 10 },
        messages: { type: 'content', maxLength: 100 }
      }
    };
    
    // 角色权限配置
    this.rolePermissions = {
      user: ['user.email', 'user.real_name'],
      admin: ['user.email', 'user.phone', 'user.real_name', 'location.ip_address'],
      data_protection_officer: ['*'],  // 完全访问
      auditor: []  // 全部脱敏
    };
  }

  /**
   * 脱敏数据
   * @param {string} dataType - 数据类型（user/payment/location等）
   * @param {object} data - 原始数据
   * @param {string} requesterRole - 请求者角色
   * @returns {object} 脱敏后的数据
   */
  mask(dataType, data, requesterRole) {
    if (!data) return data;
    
    const rules = this.maskingRules[dataType];
    if (!rules) return data;
    
    const permissions = this.rolePermissions[requesterRole] || [];
    const maskedData = { ...data };
    
    for (const [field, rule] of Object.entries(rules)) {
      if (!maskedData[field]) continue;
      
      // 检查是否有权限访问该字段
      const fieldPath = `${dataType}.${field}`;
      const hasPermission = permissions.includes('*') || permissions.includes(fieldPath);
      
      if (!hasPermission) {
        maskedData[field] = this._applyMasking(maskedData[field], rule);
      }
    }
    
    return maskedData;
  }

  /**
   * 应用脱敏规则
   */
  _applyMasking(value, rule) {
    switch (rule.type) {
      case 'email':
        return this._maskEmail(value, rule.partial);
      
      case 'phone':
        return this._maskPhone(value, rule.showLast);
      
      case 'name':
        return this._maskName(value, rule.showFirst);
      
      case 'card':
        return this._maskCardNumber(value, rule.showLast);
      
      case 'gps':
        return this._maskGPS(value, rule.precision);
      
      case 'ip':
        return this._maskIP(value, rule.partial);
      
      case 'device':
        return this._maskDeviceId(value, rule.showLast);
      
      case 'full':
        return '***';
      
      case 'list':
        return this._maskList(value, rule.maxShow);
      
      case 'content':
        return this._maskContent(value, rule.maxLength);
      
      case 'address':
        return this._maskAddress(value, rule.partial);
      
      default:
        return '***';
    }
  }

  /**
   * 脱敏邮箱
   */
  _maskEmail(email, partial) {
    if (!email) return email;
    if (!partial) return '***@***.***';
    
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    
    const maskedLocal = local[0] + '***' + (local.slice(-1) || '');
    return `${maskedLocal}@${domain}`;
  }

  /**
   * 脱敏电话
   */
  _maskPhone(phone, showLast) {
    if (!phone) return phone;
    
    const cleaned = String(phone).replace(/\D/g, '');
    const visible = cleaned.slice(-showLast);
    
    return '*'.repeat(cleaned.length - showLast) + visible;
  }

  /**
   * 脱敏姓名
   */
  _maskName(name, showFirst) {
    if (!name) return name;
    
    return name[0] + '***';
  }

  /**
   * 脱敏卡号
   */
  _maskCardNumber(number, showLast) {
    if (!number) return number;
    
    const cleaned = String(number).replace(/\D/g, '');
    const visible = cleaned.slice(-showLast);
    
    return '*'.repeat(cleaned.length - showLast) + visible;
  }

  /**
   * 脱敏GPS坐标
   */
  _maskGPS(coords, precision) {
    if (!coords) return coords;
    
    // 降低GPS精度，防止精确定位
    if (typeof coords === 'object') {
      const result = {};
      
      if (coords.lat !== undefined) {
        result.lat = Math.round(coords.lat / precision) * precision;
      }
      
      if (coords.lng !== undefined) {
        result.lng = Math.round(coords.lng / precision) * precision;
      }
      
      if (coords.latitude !== undefined) {
        result.latitude = Math.round(coords.latitude / precision) * precision;
      }
      
      if (coords.longitude !== undefined) {
        result.longitude = Math.round(coords.longitude / precision) * precision;
      }
      
      return { ...coords, ...result };
    }
    
    // 单个数值
    if (typeof coords === 'number') {
      return Math.round(coords / precision) * precision;
    }
    
    return coords;
  }

  /**
   * 脱敏IP地址
   */
  _maskIP(ip, partial) {
    if (!ip) return ip;
    
    const parts = String(ip).split('.');
    if (parts.length === 4) {
      if (partial) {
        return `${parts[0]}.${parts[1]}.***.***`;
      }
      return '***.***.***.***';
    }
    
    // IPv6 处理
    if (ip.includes(':')) {
      const v6Parts = ip.split(':');
      return v6Parts.slice(0, 2).join(':') + '::****';
    }
    
    return '***.***.***.***';
  }

  /**
   * 脱敏设备ID
   */
  _maskDeviceId(deviceId, showLast) {
    if (!deviceId) return deviceId;
    
    const str = String(deviceId);
    const visible = str.slice(-showLast);
    
    return '*'.repeat(str.length - showLast) + visible;
  }

  /**
   * 脱敏列表
   */
  _maskList(list, maxShow) {
    if (!Array.isArray(list)) return list;
    if (list.length <= maxShow) return list;
    
    return {
      items: list.slice(0, maxShow),
      total: list.length,
      truncated: true,
      note: `仅显示前${maxShow}项`
    };
  }

  /**
   * 脱敏内容
   */
  _maskContent(content, maxLength) {
    if (!content) return content;
    
    const str = String(content);
    if (str.length <= maxLength) return str;
    
    return str.slice(0, maxLength) + '...';
  }

  /**
   * 脱敏地址
   */
  _maskAddress(address, partial) {
    if (!address) return address;
    
    if (!partial) return '***';
    
    // 部分脱敏：保留城市，隐藏详细地址
    const str = String(address);
    const parts = str.split(/[,\s]+/);
    
    if (parts.length > 2) {
      return parts.slice(0, 2).join(', ') + ', ***';
    }
    
    return '***';
  }

  /**
   * 批量脱敏
   */
  maskBatch(dataType, dataArray, requesterRole) {
    if (!Array.isArray(dataArray)) return dataArray;
    
    return dataArray.map(data => this.mask(dataType, data, requesterRole));
  }

  /**
   * 脱敏完整导出数据
   * @param {object} exportData - 导出数据对象
   * @param {string} requesterRole - 请求者角色
   */
  maskExportData(exportData, requesterRole) {
    const maskedData = { ...exportData };
    
    // 脱敏用户数据
    if (maskedData.user) {
      maskedData.user = this.mask('user', maskedData.user, requesterRole);
    }
    
    // 脱敏支付数据
    if (maskedData.payments) {
      maskedData.payments = this.maskBatch('payment', maskedData.payments, requesterRole);
    }
    
    // 脱敏位置数据
    if (maskedData.catches) {
      maskedData.catches = maskedData.catches.map(catch_ => ({
        ...catch_,
        location: this.mask('location', catch_.location, requesterRole)
      }));
    }
    
    // 脱敏社交数据
    if (maskedData.social) {
      maskedData.social = this.mask('social', maskedData.social, requesterRole);
    }
    
    // 添加脱敏标记
    maskedData._masked = true;
    maskedData._maskedAt = new Date().toISOString();
    maskedData._maskedForRole = requesterRole;
    
    return maskedData;
  }

  /**
   * 获取脱敏规则说明
   */
  getMaskingRulesDescription() {
    return {
      user: {
        email: '部分脱敏：a***b@example.com',
        phone: '显示后4位：*******1234',
        real_name: '仅显示首字：张***',
        id_number: '完全脱敏：***',
        password_hash: '完全脱敏：***',
        device_id: '显示后8位：********ABC12345'
      },
      payment: {
        card_number: '显示后4位：************1234',
        cvv: '完全脱敏：***'
      },
      location: {
        exact_gps: '精度降至100米',
        ip_address: '部分脱敏：192.168.***.***'
      }
    };
  }
}

module.exports = DataMaskingEngine;