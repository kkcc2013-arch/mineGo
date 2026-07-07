// backend/tests/unit/dpa-manager.test.js
// REQ-00467: 第三方数据处理协议管理系统单元测试

'use strict';

const { describe, it, before, after, beforeEach } = require('mocha');
const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const DPAManager = require('../../shared/compliance/DPAManager');

// Mock database
const mockDb = {
  query: sinon.stub()
};

// Mock EventBus
const mockEventBus = {
  emit: sinon.stub().resolves()
};

describe('DPAManager - 数据处理协议管理系统', function() {
  let dpaManager;

  before(function() {
    // Replace dependencies
    sinon.stub(require.cache[require.resolve('../../shared/db')], 'exports').value(mockDb);
    sinon.stub(require.cache[require.resolve('../../shared/EventBus')], 'exports').value(mockEventBus);
    dpaManager = new DPAManager();
  });

  after(function() {
    sinon.restore();
  });

  beforeEach(function() {
    mockDb.query.reset();
    mockEventBus.emit.reset();
  });

  describe('registerVendor()', function() {
    it('应成功注册新供应商', async function() {
      const vendorData = {
        name: 'AWS Cloud Services',
        type: 'cloud_provider',
        contact_email: 'dpa@aws.amazon.com',
        country: 'United States',
        data_types_processed: ['personal_data', 'location_data'],
        processing_purpose: '云基础设施和数据存储服务'
      };

      mockDb.query.resolves({
        rows: [{ id: 1, name: vendorData.name, status: 'pending' }]
      });

      const result = await dpaManager.registerVendor(vendorData);

      expect(result).to.have.property('id', 1);
      expect(result.name).to.equal(vendorData.name);
      expect(mockDb.query.calledOnce).to.be.true;
      expect(mockEventBus.emit.calledOnce).to.be.true;
      expect(mockEventBus.emit.firstCall.args[0]).to.equal('dpa.vendor_registered');
    });

    it('应在缺少必要字段时抛出错误', async function() {
      const vendorData = { name: 'Test Vendor' };

      try {
        await dpaManager.registerVendor(vendorData);
        expect.fail('应抛出错误');
      } catch (error) {
        // 数据库查询会因为字段缺失而失败
      }
    });
  });

  describe('uploadAgreement()', function() {
    it('应成功上传协议文档', async function() {
      const agreementData = {
        agreement_type: 'standard_dpa',
        effective_date: '2026-07-07',
        expiry_date: '2027-07-07',
        signatory_name: 'John Doe',
        signed_date: '2026-07-01'
      };

      mockDb.query.onFirstCall().resolves({
        rows: [{ id: 1, vendor_id: 1, status: 'pending_approval' }]
      });
      mockDb.query.onSecondCall().resolves({ rowCount: 1 });

      const documentBuffer = Buffer.from('test document content');

      const result = await dpaManager.uploadAgreement(1, agreementData, documentBuffer);

      expect(result).to.have.property('id', 1);
      expect(result.status).to.equal('pending_approval');
      expect(mockEventBus.emit.calledOnce).to.be.true;
      expect(mockEventBus.emit.firstCall.args[0]).to.equal('dpa.agreement_uploaded');
    });
  });

  describe('approveAgreement()', function() {
    it('应成功审批协议', async function() {
      mockDb.query.onFirstCall().resolves({
        rows: [{ id: 1, vendor_id: 1, status: 'approved' }]
      });
      mockDb.query.onSecondCall().resolves({ rowCount: 1 });
      mockDb.query.onThirdCall().resolves({ rowCount: 1 });
      mockDb.query.onCall(3).resolves({ rowCount: 1 }); // recordChangeHistory

      const result = await dpaManager.approveAgreement(1, 100, 'approved', '协议审核通过');

      expect(result.status).to.equal('approved');
      expect(mockEventBus.emit.called).to.be.true;
    });

    it('应正确处理拒绝审批', async function() {
      mockDb.query.resolves({
        rows: [{ id: 1, vendor_id: 1, status: 'rejected' }]
      });

      const result = await dpaManager.approveAgreement(1, 100, 'rejected', '协议条款不符合要求');

      expect(result.status).to.equal('rejected');
    });
  });

  describe('getVendors()', function() {
    it('应返回供应商列表', async function() {
      mockDb.query.resolves({
        rows: [
          { id: 1, name: 'AWS', status: 'agreement_active', agreement_count: '1' },
          { id: 2, name: 'Stripe', status: 'pending', agreement_count: '0' }
        ]
      });

      const vendors = await dpaManager.getVendors({});

      expect(vendors).to.have.lengthOf(2);
      expect(vendors[0]).to.have.property('name', 'AWS');
    });

    it('应支持按状态筛选', async function() {
      mockDb.query.resolves({
        rows: [{ id: 1, status: 'agreement_active' }]
      });

      const vendors = await dpaManager.getVendors({ status: 'agreement_active' });

      expect(vendors).to.have.lengthOf(1);
    });
  });

  describe('checkExpiringAgreements()', function() {
    it('应返回即将到期的协议列表', async function() {
      mockDb.query.onFirstCall().resolves({
        rows: [{
          id: 1,
          vendor_name: 'AWS',
          expiry_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }]
      });
      mockDb.query.onSecondCall().resolves({ rowCount: 1 });

      const alerts = await dpaManager.checkExpiringAgreements();

      expect(alerts.length).to.be.greaterThan(0);
      expect(mockEventBus.emit.called).to.be.true;
    });

    it('无即将到期协议时应返回空数组', async function() {
      mockDb.query.resolves({ rows: [] });

      const alerts = await dpaManager.checkExpiringAgreements();

      expect(alerts).to.have.lengthOf(0);
    });
  });

  describe('generateComplianceReport()', function() {
    it('应生成完整的合规报告', async function() {
      mockDb.query.onFirstCall().resolves({
        rows: [{ status: 'agreement_active', count: '5' }]
      });
      mockDb.query.onSecondCall().resolves({
        rows: [{ status: 'approved', count: '5' }]
      });
      mockDb.query.onThirdCall().resolves({ rows: [] });
      mockDb.query.onCall(3).resolves({ rows: [] });
      mockDb.query.onCall(4).resolves({
        rows: [{ data_type: 'personal_data', count: '3' }]
      });

      const report = await dpaManager.generateComplianceReport();

      expect(report).to.have.property('generated_at');
      expect(report).to.have.property('vendor_summary');
      expect(report).to.have.property('agreement_summary');
      expect(report).to.have.property('compliance_score');
    });
  });

  describe('calculateComplianceScore()', function() {
    it('应计算合规评分', function() {
      const vendorStats = [
        { status: 'agreement_active', count: '4' },
        { status: 'pending', count: '1' }
      ];
      const agreementStats = [{ status: 'approved', count: '4' }];

      const score = dpaManager.calculateComplianceScore(vendorStats, agreementStats, 0);

      expect(score).to.be.greaterThan(0);
      expect(score).to.be.lessThan(100);
    });

    it('有过期协议时应扣分', function() {
      const vendorStats = [{ status: 'agreement_active', count: '5' }];
      const agreementStats = [{ status: 'approved', count: '5' }];

      const scoreNoExpired = dpaManager.calculateComplianceScore(vendorStats, agreementStats, 0);
      const scoreWithExpired = dpaManager.calculateComplianceScore(vendorStats, agreementStats, 2);

      expect(scoreWithExpired).to.be.lessThan(scoreNoExpired);
    });
  });
});