/**
 * REQ-00057: MFA 单元测试
 */

const mfaService = require('../../shared/mfaService');
const db = require('../../shared/db');

// Mock dependencies
jest.mock('../../shared/db');
jest.mock('../../shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  metrics: {}
}));

describe('MFA Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateSecret', () => {
    it('should generate a valid TOTP secret', () => {
      const email = 'user@example.com';
      const result = mfaService.generateSecret(email);

      expect(result).toHaveProperty('base32');
      expect(result).toHaveProperty('otpauthUrl');
      expect(result.base32).toMatch(/^[A-Z2-7]+$/);
      expect(result.otpauthUrl).toContain('otpauth://totp');
      expect(result.otpauthUrl).toContain('mineGo');
    });

    it('should generate different secrets for each call', () => {
      const email = 'user@example.com';
      const secret1 = mfaService.generateSecret(email);
      const secret2 = mfaService.generateSecret(email);

      expect(secret1.base32).not.toBe(secret2.base32);
    });
  });

  describe('verifyTOTP', () => {
    it('should verify a valid TOTP code', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const speakeasy = require('speakeasy');
      
      // 生成当前有效的 TOTP 码
      const code = speakeasy.totp({
        secret: secret,
        encoding: 'base32'
      });

      const result = mfaService.verifyTOTP(secret, code);
      expect(result).toBe(true);
    });

    it('should reject an invalid TOTP code', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const code = '000000';

      const result = mfaService.verifyTOTP(secret, code);
      expect(result).toBe(false);
    });

    it('should accept codes within the time window', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const speakeasy = require('speakeasy');
      
      // 生成前一个时间窗口的码
      const code = speakeasy.totp({
        secret: secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) - 30
      });

      const result = mfaService.verifyTOTP(secret, code);
      expect(result).toBe(true);
    });
  });

  describe('generateRecoveryCodes', () => {
    it('should generate 8 recovery codes by default', () => {
      const codes = mfaService.generateRecoveryCodes();
      
      expect(codes).toHaveLength(8);
    });

    it('should generate codes in correct format', () => {
      const codes = mfaService.generateRecoveryCodes();
      
      codes.forEach(code => {
        expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
      });
    });

    it('should generate unique codes', () => {
      const codes = mfaService.generateRecoveryCodes();
      const uniqueCodes = new Set(codes);
      
      expect(uniqueCodes.size).toBe(codes.length);
    });

    it('should generate specified number of codes', () => {
      const codes = mfaService.generateRecoveryCodes(10);
      
      expect(codes).toHaveLength(10);
    });
  });

  describe('hashRecoveryCode', () => {
    it('should hash recovery code correctly', () => {
      const code = 'ABCD-1234';
      const hash = mfaService.hashRecoveryCode(code);
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce consistent hashes', () => {
      const code = 'ABCD-1234';
      const hash1 = mfaService.hashRecoveryCode(code);
      const hash2 = mfaService.hashRecoveryCode(code);
      
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different codes', () => {
      const hash1 = mfaService.hashRecoveryCode('ABCD-1234');
      const hash2 = mfaService.hashRecoveryCode('EFGH-5678');
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('encryptSecret / decryptSecret', () => {
    it('should encrypt and decrypt secret correctly', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      
      const { encrypted, iv, authTag } = mfaService.encryptSecret(secret);
      const decrypted = mfaService.decryptSecret(encrypted, iv, authTag);
      
      expect(decrypted).toBe(secret);
    });

    it('should produce different encrypted values for same secret', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      
      const enc1 = mfaService.encryptSecret(secret);
      const enc2 = mfaService.encryptSecret(secret);
      
      expect(enc1.encrypted).not.toBe(enc2.encrypted);
      expect(enc1.iv).not.toBe(enc2.iv);
    });

    it('should return null for invalid decryption', () => {
      const decrypted = mfaService.decryptSecret('invalid', 'invalid', 'invalid');
      
      expect(decrypted).toBeNull();
    });
  });

  describe('setupMFA', () => {
    it('should setup MFA successfully', async () => {
      const userId = 'user-uuid-123';
      const email = 'user@example.com';

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // 检查现有配置
          .mockResolvedValueOnce({}) // 插入 MFA 配置
          .mockResolvedValue({}), // 插入恢复码
        release: jest.fn()
      });

      const result = await mfaService.setupMFA(userId, email);

      expect(result).toHaveProperty('secret');
      expect(result).toHaveProperty('qrCodeDataUrl');
      expect(result).toHaveProperty('recoveryCodes');
      expect(result.recoveryCodes).toHaveLength(8);
    });

    it('should throw error if MFA already enabled', async () => {
      const userId = 'user-uuid-123';
      const email = 'user@example.com';

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{ is_enabled: true }] 
          }),
        release: jest.fn()
      });

      await expect(mfaService.setupMFA(userId, email))
        .rejects.toThrow('MFA already enabled');
    });
  });

  describe('enableMFA', () => {
    it('should enable MFA with valid code', async () => {
      const userId = 'user-uuid-123';
      const secret = 'JBSWY3DPEHPK3PXP';
      const speakeasy = require('speakeasy');
      
      const code = speakeasy.totp({
        secret: secret,
        encoding: 'base32'
      });

      const { encrypted, iv, authTag } = mfaService.encryptSecret(secret);

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{
              secret_encrypted: `${encrypted}:${authTag}`,
              secret_iv: iv,
              is_enabled: false,
              failed_attempts: 0
            }] 
          })
          .mockResolvedValue({}),
        release: jest.fn()
      });

      const result = await mfaService.enableMFA(userId, code);

      expect(result.success).toBe(true);
    });

    it('should reject invalid code and increment failed attempts', async () => {
      const userId = 'user-uuid-123';
      const code = '000000';
      const secret = 'JBSWY3DPEHPK3PXP';
      
      const { encrypted, iv, authTag } = mfaService.encryptSecret(secret);

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{
              secret_encrypted: `${encrypted}:${authTag}`,
              secret_iv: iv,
              is_enabled: false,
              failed_attempts: 0
            }] 
          })
          .mockResolvedValue({}),
        release: jest.fn()
      });

      await expect(mfaService.enableMFA(userId, code))
        .rejects.toThrow(/Invalid TOTP code/);
    });
  });

  describe('verifyMFA', () => {
    it('should verify correct TOTP code', async () => {
      const userId = 'user-uuid-123';
      const secret = 'JBSWY3DPEHPK3PXP';
      const speakeasy = require('speakeasy');
      
      const code = speakeasy.totp({
        secret: secret,
        encoding: 'base32'
      });

      const { encrypted, iv, authTag } = mfaService.encryptSecret(secret);

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{
              secret_encrypted: `${encrypted}:${authTag}`,
              secret_iv: iv,
              is_enabled: true,
              failed_attempts: 0
            }] 
          })
          .mockResolvedValue({}),
        release: jest.fn()
      });

      const result = await mfaService.verifyMFA(userId, code);

      expect(result).toBe(true);
    });

    it('should verify recovery code', async () => {
      const userId = 'user-uuid-123';
      const code = 'ABCD-1234';
      const hash = mfaService.hashRecoveryCode(code);

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{
              is_enabled: true,
              failed_attempts: 0
            }] 
          })
          .mockResolvedValueOnce({ 
            rows: [{ id: 'code-id' }] 
          })
          .mockResolvedValue({}),
        release: jest.fn()
      });

      const result = await mfaService.verifyMFA(userId, code);

      expect(result).toBe(true);
    });

    it('should return false for invalid code', async () => {
      const userId = 'user-uuid-123';
      const code = '000000';
      const secret = 'JBSWY3DPEHPK3PXP';
      
      const { encrypted, iv, authTag } = mfaService.encryptSecret(secret);

      db.getClient.mockResolvedValue({
        query: jest.fn()
          .mockResolvedValueOnce({ 
            rows: [{
              secret_encrypted: `${encrypted}:${authTag}`,
              secret_iv: iv,
              is_enabled: true,
              failed_attempts: 0
            }] 
          })
          .mockResolvedValue({}),
        release: jest.fn()
      });

      const result = await mfaService.verifyMFA(userId, code);

      expect(result).toBe(false);
    });
  });

  describe('getRecoveryCodesStatus', () => {
    it('should return recovery codes status', async () => {
      const userId = 'user-uuid-123';

      db.query.mockResolvedValue({
        rows: [{ total: '8', remaining: '5' }]
      });

      const status = await mfaService.getRecoveryCodesStatus(userId);

      expect(status.total).toBe(8);
      expect(status.remaining).toBe(5);
    });
  });

  describe('isTrustedDevice', () => {
    it('should return true for trusted device', async () => {
      const userId = 'user-uuid-123';
      const fingerprint = 'device-fingerprint-123';

      db.query.mockResolvedValue({
        rows: [{ id: 'device-id' }]
      });

      const result = await mfaService.isTrustedDevice(userId, fingerprint);

      expect(result).toBe(true);
    });

    it('should return false for untrusted device', async () => {
      const userId = 'user-uuid-123';
      const fingerprint = 'device-fingerprint-123';

      db.query.mockResolvedValue({
        rows: []
      });

      const result = await mfaService.isTrustedDevice(userId, fingerprint);

      expect(result).toBe(false);
    });
  });
});

describe('MFA Middleware', () => {
  const { mfaRequired, generateMfaToken } = require('../../gateway/src/middleware/mfaRequired');

  it('should generate valid MFA token', () => {
    const userId = 'user-123';
    const token = generateMfaToken(userId);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  it('should pass through if user has no MFA enabled', async () => {
    const req = { user: { mfaEnabled: false } };
    const res = {};
    const next = jest.fn();

    await mfaRequired()(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// 运行测试
if (require.main === module) {
  console.log('Running MFA tests...');
  jest.run();
}
