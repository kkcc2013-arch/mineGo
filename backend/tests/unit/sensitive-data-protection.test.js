/**
 * REQ-00038: API 敏感数据泄露防护与审计日志加密存储
 * 单元测试
 */

const { describe, it, expect, beforeEach } = require('@jest/globals');
const {
  filterResponseData,
  detectSensitiveFields,
  getFieldSensitivity,
  getRolePermissions,
  SENSITIVITY_LEVELS,
  ROLE_PERMISSIONS,
} = require('../../shared/responseFilter');

const DataMasking = require('../../shared/dataMasking');

const {
  checkSensitiveDataAccess,
  getSensitiveFields,
  SENSITIVE_ACCESS_RULES,
} = require('../../shared/sensitiveDataAudit');

// ============================================================
// 1. 响应字段过滤测试
// ============================================================

describe('响应字段过滤', () => {
  describe('字段敏感度识别', () => {
    it('应该正确识别 P0 字段', () => {
      expect(getFieldSensitivity('password')).toBe('P0');
      expect(getFieldSensitivity('password_hash')).toBe('P0');
      expect(getFieldSensitivity('card_number')).toBe('P0');
      expect(getFieldSensitivity('cvv')).toBe('P0');
    });

    it('应该正确识别 P1 字段', () => {
      expect(getFieldSensitivity('email')).toBe('P1');
      expect(getFieldSensitivity('phone')).toBe('P1');
      expect(getFieldSensitivity('real_name')).toBe('P1');
      expect(getFieldSensitivity('address')).toBe('P1');
    });

    it('应该正确识别 P2 字段', () => {
      expect(getFieldSensitivity('location_history')).toBe('P2');
      expect(getFieldSensitivity('device_id')).toBe('P2');
    });

    it('应该正确识别 P3 字段', () => {
      expect(getFieldSensitivity('username')).toBe('P3');
      expect(getFieldSensitivity('user_id')).toBe('P3');
    });

    it('未知字段应返回 null', () => {
      expect(getFieldSensitivity('unknown_field')).toBeNull();
    });
  });

  describe('角色权限获取', () => {
    it('user 角色权限', () => {
      const permissions = getRolePermissions('user');
      expect(permissions.allowedLevels).toEqual(['P3']);
      expect(permissions.partialLevels).toEqual(['P2']);
    });

    it('premium 角色权限', () => {
      const permissions = getRolePermissions('premium');
      expect(permissions.allowedLevels).toContain('P3');
      expect(permissions.allowedLevels).toContain('P2');
      expect(permissions.partialLevels).toEqual(['P1']);
    });

    it('admin 角色权限', () => {
      const permissions = getRolePermissions('admin');
      expect(permissions.allowedLevels).toContain('P1');
      expect(permissions.allowedLevels).toContain('P2');
      expect(permissions.allowedLevels).toContain('P3');
    });

    it('system 角色权限', () => {
      const permissions = getRolePermissions('system');
      expect(permissions.allowedLevels).toContain('P0');
      expect(permissions.allowedLevels).toContain('P1');
      expect(permissions.allowedLevels).toContain('P2');
      expect(permissions.allowedLevels).toContain('P3');
    });
  });

  describe('响应数据过滤', () => {
    it('应该过滤 P0 字段', () => {
      const data = {
        username: 'testuser',
        password: 'secret123',
        email: 'test@example.com',
      };
      const filtered = filterResponseData(data, 'user');
      expect(filtered.username).toBe('testuser');
      expect(filtered).not.toHaveProperty('password');
      expect(filtered).not.toHaveProperty('email');
    });

    it('应该脱敏 P1 字段（premium 角色）', () => {
      const data = {
        username: 'testuser',
        email: 'test@example.com',
        phone: '13812345678',
      };
      const filtered = filterResponseData(data, 'premium');
      expect(filtered).toHaveProperty('email');
      expect(filtered.email).toContain('***');
    });

    it('应该过滤嵌套对象中的敏感字段', () => {
      const data = {
        user: {
          username: 'testuser',
          password: 'secret123',
          email: 'test@example.com',
        },
        pokemon: {
          name: 'Pikachu',
          device_id: 'device-123', // P2 字段
        },
      };
      const filtered = filterResponseData(data, 'user');
      expect(filtered.user).not.toHaveProperty('password');
      expect(filtered.pokemon).toHaveProperty('device_id'); // P2 在 partialLevels 中，应该被脱敏但保留
    });

    it('应该处理数组', () => {
      const data = [
        { username: 'user1', email: 'user1@example.com' },
        { username: 'user2', email: 'user2@example.com' },
      ];
      const filtered = filterResponseData(data, 'user');
      expect(filtered).toHaveLength(2);
      expect(filtered[0]).not.toHaveProperty('email');
    });
  });

  describe('敏感字段检测', () => {
    it('应该检测出敏感字段', () => {
      const data = {
        email: 'test@example.com',
        phone: '13812345678',
        username: 'testuser',
      };
      const fields = detectSensitiveFields(data);
      expect(fields).toContain('email');
      expect(fields).toContain('phone');
      // username 是 P3 级别，也算敏感字段，但敏感度较低
      expect(fields).toContain('username');
    });
  });
});

// ============================================================
// 2. 数据脱敏测试
// ============================================================

describe('数据脱敏', () => {
  describe('邮箱脱敏', () => {
    it('应该脱敏邮箱地址', () => {
      const masked = DataMasking.email('test@example.com');
      expect(masked).toContain('***');
      expect(masked).toContain('@example.com');
    });
  });

  describe('手机号脱敏', () => {
    it('应该脱敏手机号', () => {
      const masked = DataMasking.phone('13812345678');
      expect(masked).toBe('138****5678');
    });
  });

  describe('IP 地址脱敏', () => {
    it('应该脱敏 IPv4 地址', () => {
      const masked = DataMasking.ip('192.168.1.100');
      expect(masked).toBe('192.168.*.*');
    });

    it('应该脱敏 IPv6 地址', () => {
      const masked = DataMasking.ip('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(masked).toContain('****');
    });
  });

  describe('银行卡号脱敏', () => {
    it('应该脱敏银行卡号', () => {
      const masked = DataMasking.bankCard('6222021234567890123');
      expect(masked).toContain('6222');
      expect(masked).toContain('0123');
      expect(masked).toContain('****');
    });
  });

  describe('身份证号脱敏', () => {
    it('应该脱敏身份证号', () => {
      const masked = DataMasking.idCard('310101199001011234');
      expect(masked).toContain('3101');
      expect(masked).toContain('1234');
      expect(masked).toContain('*');
    });
  });

  describe('经纬度模糊化', () => {
    it('应该模糊化经纬度', () => {
      const masked = DataMasking.coordinate(31.230416, 2);
      expect(masked).toBe(31.23);
    });
  });

  describe('日期脱敏', () => {
    it('应该脱敏日期', () => {
      const masked = DataMasking.date('1990-01-01');
      expect(masked).toBe('1990-01-**');
    });
  });

  describe('姓名脱敏', () => {
    it('应该脱敏中文姓名', () => {
      const masked = DataMasking.name('张三丰');
      expect(masked).toBe('张**');
    });

    it('应该脱敏英文姓名', () => {
      const masked = DataMasking.name('John Doe');
      expect(masked).toContain('Joh');
      expect(masked).toContain('***');
    });
  });

  describe('URL 脱敏', () => {
    it('应该脱敏 URL 中的敏感参数', () => {
      const masked = DataMasking.url('https://example.com/api?token=secret123&key=abc');
      expect(masked).toContain('***REDACTED***');
      expect(masked).not.toContain('secret123');
    });
  });

  describe('JSON 字符串脱敏', () => {
    it('应该脱敏 JSON 字符串中的敏感字段', () => {
      const jsonStr = '{"username":"test","password":"secret123","token":"abc123"}';
      const masked = DataMasking.jsonString(jsonStr);
      expect(masked).toContain('***REDACTED***');
      expect(masked).not.toContain('secret123');
    });
  });

  describe('对象批量脱敏', () => {
    it('应该批量脱敏用户数据', () => {
      const user = {
        email: 'test@example.com',
        phone: '13812345678',
        username: 'testuser',
        ip_address: '192.168.1.100',
      };
      const masked = DataMasking.maskUserData(user);
      expect(masked.email).toContain('***');
      expect(masked.phone).toContain('****');
      // username 会被脱敏为 tes***
      expect(masked.username).toContain('tes');
      expect(masked.ip_address).toContain('*');
    });
  });
});

// ============================================================
// 3. 敏感数据访问审计测试
// ============================================================

describe('敏感数据访问审计', () => {
  describe('访问权限检查', () => {
    it('需要 MFA 但未提供时应拒绝', () => {
      const result = checkSensitiveDataAccess({
        resourceType: 'user',
        field: 'id_card',
        hasMFA: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('MFA');
    });

    it('MFA 通过后应允许访问', () => {
      const result = checkSensitiveDataAccess({
        resourceType: 'user',
        field: 'id_card',
        hasMFA: true,
        accessReason: '审核用户身份',
      });
      expect(result.allowed).toBe(true);
    });

    it('需要原因但未提供时应拒绝', () => {
      const result = checkSensitiveDataAccess({
        resourceType: 'user',
        field: 'email',
        hasMFA: false,
        accessReason: null,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('原因');
    });

    it('提供原因后应允许访问', () => {
      const result = checkSensitiveDataAccess({
        resourceType: 'user',
        field: 'email',
        hasMFA: false,
        accessReason: '用户查询个人信息',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('敏感字段列表', () => {
    it('应该返回用户资源的敏感字段', () => {
      const fields = getSensitiveFields('user');
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.some(f => f.field === 'email')).toBe(true);
      expect(fields.some(f => f.field === 'phone')).toBe(true);
    });

    it('应该返回支付资源的敏感字段', () => {
      const fields = getSensitiveFields('payment');
      expect(fields.some(f => f.field === 'card_number')).toBe(true);
    });
  });

  describe('访问规则定义', () => {
    it('应该正确定义用户邮箱规则', () => {
      expect(SENSITIVE_ACCESS_RULES['user.email'].sensitivity).toBe('P1');
      expect(SENSITIVE_ACCESS_RULES['user.email'].mfaRequired).toBe(false);
      expect(SENSITIVE_ACCESS_RULES['user.email'].requireReason).toBe(true);
    });

    it('应该正确定义支付卡号规则', () => {
      expect(SENSITIVE_ACCESS_RULES['payment.card_number'].sensitivity).toBe('P0');
      expect(SENSITIVE_ACCESS_RULES['payment.card_number'].mfaRequired).toBe(true);
      expect(SENSITIVE_ACCESS_RULES['payment.card_number'].requireReason).toBe(true);
    });

    it('应该正确定义用户身份证规则', () => {
      expect(SENSITIVE_ACCESS_RULES['user.id_card'].mfaRequired).toBe(true);
    });
  });
});
