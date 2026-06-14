/**
 * REQ-00089: 数据跨境传输合规单元测试
 */

const { describe, it, before, after, beforeEach, expect } = require('node:test');
const assert = require('node:test/assert');
const { DataTransferComplianceService, DataRegions, LegalBasis, TransferStatus } = require('../../services/user-service/src/services/dataTransferComplianceService');

// Mock 数据库
const createMockDb = () => ({
  query: async (sql, params) => {
    // 区域配置查询
    if (sql.includes('FROM data_regions WHERE region_code')) {
      return { rows: [{ region_code: params[0], is_active: true }] };
    }
    // 用户区域查询
    if (sql.includes('FROM user_data_regions')) {
      return { rows: [] };
    }
    // 插入用户区域
    if (sql.includes('INSERT INTO user_data_regions')) {
      return { 
        rows: [{ 
          user_id: params[0], 
          region_code: params[1], 
          assignment_reason: params[2],
          assigned_at: new Date()
        }] 
      };
    }
    // 插入传输请求
    if (sql.includes('INSERT INTO data_transfer_requests')) {
      return { 
        rows: [{ 
          id: 1,
          request_id: 'DTR-20260614-000001',
          requester_id: params[0],
          source_region: params[1],
          target_region: params[2],
          status: 'pending'
        }] 
      };
    }
    // SCC 查询
    if (sql.includes('FROM standard_contractual_clauses')) {
      return { rows: [{ scc_code: 'SCC-EU-2021' }] };
    }
    // 统计查询
    if (sql.includes('SELECT COUNT(*)')) {
      return { rows: [{ count: '0' }] };
    }
    // 传输请求查询
    if (sql.includes('FROM data_transfer_requests WHERE id')) {
      return { rows: [{ id: params[0], status: 'pending', source_region: 'EU', target_region: 'US', data_types: ['personal'], data_subjects_affected: 100 }] };
    }
    // 更新传输请求
    if (sql.includes('UPDATE data_transfer_requests')) {
      return { rows: [{ id: params[3], request_id: 'DTR-20260614-000001', status: params[0] }] };
    }
    // 插入传输日志
    if (sql.includes('INSERT INTO data_transfer_logs')) {
      return { rows: [{ id: 1 }] };
    }
    // 插入影响评估
    if (sql.includes('INSERT INTO transfer_impact_assessments')) {
      return { rows: [{ assessment_id: 'TIA-20260614-000001', risk_level: 'medium', recommendation: 'approve' }] };
    }
    return { rows: [] };
  }
});

describe('DataTransferComplianceService', () => {
  let service;
  let mockDb;

  before(() => {
    mockDb = createMockDb();
    service = new DataTransferComplianceService(mockDb);
  });

  describe('detectUserRegion', () => {
    it('should return EU region for EU country code', async () => {
      const result = await service.detectUserRegion(null, 'DE');
      assert.strictEqual(result.region, 'EU');
      assert.strictEqual(result.reason, 'country_match');
      assert.ok(result.laws.includes('GDPR'));
    });

    it('should return CN region for China', async () => {
      const result = await service.detectUserRegion(null, 'CN');
      assert.strictEqual(result.region, 'CN');
      assert.ok(result.laws.includes('PIPL'));
    });

    it('should return ROW for unknown country', async () => {
      const result = await service.detectUserRegion(null, 'XX');
      assert.strictEqual(result.region, 'ROW');
      assert.strictEqual(result.reason, 'default');
    });

    it('should return ROW when no country code provided', async () => {
      const result = await service.detectUserRegion('192.168.1.1', null);
      assert.strictEqual(result.region, 'ROW');
    });
  });

  describe('assignUserRegion', () => {
    it('should assign region to user', async () => {
      const result = await service.assignUserRegion(1, 'EU', { reason: 'ip_detection' });
      assert.strictEqual(result.user_id, 1);
      assert.strictEqual(result.region_code, 'EU');
    });

    it('should throw error for invalid region', async () => {
      const mockDbInvalid = createMockDb();
      mockDbInvalid.query = async () => ({ rows: [] });
      const invalidService = new DataTransferComplianceService(mockDbInvalid);
      
      try {
        await invalidService.assignUserRegion(1, 'INVALID_REGION', {});
        assert.fail('Should have thrown error');
      } catch (err) {
        assert.ok(err.message.includes('Invalid'));
      }
    });
  });

  describe('createTransferRequest', () => {
    it('should create transfer request', async () => {
      const request = await service.createTransferRequest({
        requesterId: 1,
        sourceRegion: 'EU',
        targetRegion: 'US',
        dataTypes: ['personal', 'location'],
        legalBasis: LegalBasis.CONSENT,
        purpose: 'Service provision'
      });
      
      assert.strictEqual(request.requester_id, 1);
      assert.strictEqual(request.source_region, 'EU');
      assert.strictEqual(request.target_region, 'US');
      assert.strictEqual(request.status, 'pending');
    });

    it('should throw error when source equals target', async () => {
      try {
        await service.createTransferRequest({
          requesterId: 1,
          sourceRegion: 'EU',
          targetRegion: 'EU',
          dataTypes: ['personal'],
          legalBasis: LegalBasis.CONSENT,
          purpose: 'Test'
        });
        assert.fail('Should have thrown error');
      } catch (err) {
        assert.ok(err.message.includes('must be different'));
      }
    });

    it('should throw error for invalid legal basis', async () => {
      try {
        await service.createTransferRequest({
          requesterId: 1,
          sourceRegion: 'EU',
          targetRegion: 'US',
          dataTypes: ['personal'],
          legalBasis: 'invalid_basis',
          purpose: 'Test'
        });
        assert.fail('Should have thrown error');
      } catch (err) {
        assert.ok(err.message.includes('Invalid legal basis'));
      }
    });
  });

  describe('approveTransferRequest', () => {
    it('should approve pending request', async () => {
      const result = await service.approveTransferRequest(1, 2, TransferStatus.APPROVED, null);
      assert.strictEqual(result.status, TransferStatus.APPROVED);
    });

    it('should reject request with reason', async () => {
      const result = await service.approveTransferRequest(1, 2, TransferStatus.REJECTED, 'High risk');
      assert.strictEqual(result.status, TransferStatus.REJECTED);
    });
  });

  describe('logTransfer', () => {
    it('should log data transfer', async () => {
      const log = await service.logTransfer({
        userId: 1,
        sourceRegion: 'EU',
        targetRegion: 'US',
        dataType: 'personal',
        legalBasis: LegalBasis.CONSENT,
        purpose: 'Sync'
      });
      
      assert.strictEqual(log.id, 1);
    });
  });

  describe('generateImpactAssessment', () => {
    it('should generate impact assessment', async () => {
      const assessment = await service.generateImpactAssessment(1);
      assert.ok(assessment.assessment_id);
      assert.ok(['low', 'medium', 'high', 'very_high'].includes(assessment.risk_level));
      assert.ok(['approve', 'approve_with_conditions', 'reject'].includes(assessment.recommendation));
    });
  });

  describe('checkSCCRequirement', () => {
    it('should require SCC for EU to US transfer', async () => {
      const required = await service.checkSCCRequirement('EU', 'US');
      assert.strictEqual(required, true);
    });

    it('should require SCC for CN transfer', async () => {
      const required = await service.checkSCCRequirement('CN', 'US');
      assert.strictEqual(required, true);
    });

    it('should not require SCC for EU to EU transfer', async () => {
      const required = await service.checkSCCRequirement('EU', 'EU');
      assert.strictEqual(required, false);
    });
  });

  describe('identifyLegalGaps', () => {
    it('should identify GDPR gaps when transferring from EU', () => {
      const gaps = service.identifyLegalGaps(['GDPR'], ['CCPA']);
      assert.ok(gaps.some(g => g.includes('GDPR')));
      assert.ok(gaps.some(g => g.includes('contractual clauses')));
    });

    it('should identify PIPL gaps when transferring from CN', () => {
      const gaps = service.identifyLegalGaps(['PIPL'], []);
      assert.ok(gaps.some(g => g.includes('Security assessment') || g.includes('CAC')));
    });

    it('should return empty array for compatible laws', () => {
      const gaps = service.identifyLegalGaps([], []);
      assert.strictEqual(gaps.length, 0);
    });
  });

  describe('assessRiskLevel', () => {
    it('should return low risk for minimal data', () => {
      const request = {
        data_types: ['personal'],
        data_subjects_affected: 10,
        target_region: 'US'
      };
      const risk = service.assessRiskLevel(request, []);
      assert.strictEqual(risk, 'low');
    });

    it('should return higher risk for sensitive data', () => {
      const request = {
        data_types: ['payment', 'health'],
        data_subjects_affected: 15000,
        target_region: 'RU'
      };
      const risk = service.assessRiskLevel(request, ['gap1', 'gap2', 'gap3']);
      assert.ok(['high', 'very_high'].includes(risk));
    });
  });

  describe('generateRecommendation', () => {
    it('should recommend reject for very high risk', () => {
      const rec = service.generateRecommendation('very_high', []);
      assert.strictEqual(rec, 'reject');
    });

    it('should recommend approve with conditions for high risk', () => {
      const rec = service.generateRecommendation('high', []);
      assert.strictEqual(rec, 'approve_with_conditions');
    });

    it('should recommend approve for low/medium risk', () => {
      assert.strictEqual(service.generateRecommendation('low', []), 'approve');
      assert.strictEqual(service.generateRecommendation('medium', []), 'approve');
    });
  });
});

describe('DataRegions Configuration', () => {
  it('should have EU region configured', () => {
    assert.ok(DataRegions.EU);
    assert.ok(DataRegions.EU.countries.length > 0);
    assert.ok(DataRegions.EU.laws.includes('GDPR'));
  });

  it('should have CN region configured', () => {
    assert.ok(DataRegions.CN);
    assert.ok(DataRegions.CN.laws.includes('PIPL'));
  });

  it('should have ROW as fallback', () => {
    assert.ok(DataRegions.ROW);
    assert.ok(DataRegions.ROW.countries.includes('*'));
  });
});

describe('LegalBasis Constants', () => {
  it('should have all required legal basis types', () => {
    assert.ok(LegalBasis.CONSENT);
    assert.ok(LegalBasis.CONTRACT);
    assert.ok(LegalBasis.LEGITIMATE_INTEREST);
    assert.ok(LegalBasis.PUBLIC_INTEREST);
    assert.ok(LegalBasis.VITAL_INTEREST);
    assert.ok(LegalBasis.LEGAL_OBLIGATION);
  });
});

describe('TransferStatus Constants', () => {
  it('should have all required statuses', () => {
    assert.ok(TransferStatus.PENDING);
    assert.ok(TransferStatus.APPROVED);
    assert.ok(TransferStatus.REJECTED);
    assert.ok(TransferStatus.EXECUTED);
    assert.ok(TransferStatus.CANCELLED);
  });
});
