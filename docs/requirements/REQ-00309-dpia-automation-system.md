# REQ-00309: 数据隐私影响评估（DPIA）自动化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00309 |
| 标题 | 数据隐私影响评估（DPIA）自动化系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、backend/shared |
| 创建时间 | 2026-06-24 04:00 |

## 需求描述

根据 GDPR 第 35 条规定，当处理操作可能对个人权利和自由造成高风险时，数据控制者必须进行数据隐私影响评估（DPIA）。本系统旨在自动化 DPIA 流程，包括：

1. **风险评估自动化**：基于数据处理特征自动生成风险评估报告
2. **合规检查清单**：自动化检查 GDPR 合规项
3. **缓解措施追踪**：记录和追踪风险缓解措施的实施状态
4. **文档生成**：自动生成符合监管要求的 DPIA 文档
5. **定期复核提醒**：对高风险处理活动设置定期复核提醒

### 业务价值
- 确保合规性，避免 GDPR 违规罚款（最高可达全球年营业额的 4%）
- 降低人工评估成本，提高效率
- 建立可审计的合规记录
- 提升用户信任度

## 技术方案

### 1. DPIA 数据模型设计

```sql
-- 数据隐私影响评估表
CREATE TABLE dpia_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_code VARCHAR(50) UNIQUE NOT NULL,  -- DPIA-2026-001
    title VARCHAR(255) NOT NULL,
    description TEXT,
    processing_activity VARCHAR(255) NOT NULL,  -- 数据处理活动类型
    data_categories TEXT[] NOT NULL,  -- 涉及的数据类别
    data_subjects TEXT[] NOT NULL,  -- 数据主体类型
    processing_purpose TEXT NOT NULL,  -- 处理目的
    legal_basis VARCHAR(100) NOT NULL,  -- 法律依据
    risk_level VARCHAR(20) NOT NULL,  -- low/medium/high/critical
    status VARCHAR(30) NOT NULL DEFAULT 'draft',  -- draft/review/approved/rejected/revoked
    created_by UUID REFERENCES users(id),
    reviewed_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP,
    approved_at TIMESTAMP,
    next_review_date DATE,
    valid_until DATE,
    metadata JSONB DEFAULT '{}'
);

-- DPIA 风险条目表
CREATE TABLE dpia_risks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID REFERENCES dpia_assessments(id) ON DELETE CASCADE,
    risk_category VARCHAR(100) NOT NULL,  -- 数据泄露/未经授权访问/滥用等
    risk_description TEXT NOT NULL,
    likelihood VARCHAR(20) NOT NULL,  -- unlikely/possible/likely/almost_certain
    impact VARCHAR(20) NOT NULL,  -- negligible/limited/significant/maximal
    risk_score INTEGER GENERATED ALWAYS AS (
        CASE likelihood
            WHEN 'unlikely' THEN 1
            WHEN 'possible' THEN 2
            WHEN 'likely' THEN 3
            WHEN 'almost_certain' THEN 4
        END *
        CASE impact
            WHEN 'negligible' THEN 1
            WHEN 'limited' THEN 2
            WHEN 'significant' THEN 3
            WHEN 'maximal' THEN 4
        END
    ) STORED,
    mitigations TEXT[],
    mitigation_status VARCHAR(30) DEFAULT 'pending',  -- pending/in_progress/completed/verified
    residual_risk_score INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- DPIA 缓解措施表
CREATE TABLE dpia_mitigations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    risk_id UUID REFERENCES dpia_risks(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    implementation_details TEXT,
    responsible_party VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'planned',
    due_date DATE,
    completed_at TIMESTAMP,
    evidence_links TEXT[],
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- DPIA 合规检查项表
CREATE TABLE dpia_compliance_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID REFERENCES dpia_assessments(id) ON DELETE CASCADE,
    check_code VARCHAR(50) NOT NULL,  -- GDPR-Art35-1, etc.
    check_category VARCHAR(100) NOT NULL,  -- lawful_basis, data_minimization, etc.
    check_description TEXT NOT NULL,
    is_applicable BOOLEAN DEFAULT true,
    is_compliant BOOLEAN,
    compliance_notes TEXT,
    evidence TEXT,
    checked_by UUID REFERENCES users(id),
    checked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- DPIA 复核记录表
CREATE TABLE dpia_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID REFERENCES dpia_assessments(id) ON DELETE CASCADE,
    review_type VARCHAR(30) NOT NULL,  -- periodic/incident_driven/processing_change
    reviewer_id UUID REFERENCES users(id),
    review_findings TEXT,
    recommendations TEXT[],
    outcome VARCHAR(30),  -- approved/revision_needed/revoke
    reviewed_at TIMESTAMP DEFAULT NOW(),
    next_review_date DATE
);

-- 索引
CREATE INDEX idx_dpia_assessments_status ON dpia_assessments(status);
CREATE INDEX idx_dpia_assessments_risk_level ON dpia_assessments(risk_level);
CREATE INDEX idx_dpia_risks_assessment ON dpia_risks(assessment_id);
CREATE INDEX idx_dpia_mitigations_risk ON dpia_mitigations(risk_id);
CREATE INDEX idx_dpia_compliance_assessment ON dpia_compliance_checks(assessment_id);
CREATE INDEX idx_dpia_reviews_assessment ON dpia_reviews(assessment_id);
```

### 2. DPIA 自动化评估引擎

```javascript
// backend/shared/dpiaEngine.js

const RiskCalculator = require('./riskCalculator');
const ComplianceChecker = require('./complianceChecker');

class DPIAEngine {
  constructor() {
    this.riskCalculator = new RiskCalculator();
    this.complianceChecker = new ComplianceChecker();
    
    // 风险评分阈值
    this.riskThresholds = {
      low: { min: 1, max: 4 },
      medium: { min: 5, max: 8 },
      high: { min: 9, max: 12 },
      critical: { min: 13, max: 16 }
    };
    
    // 强制 DPIA 的处理活动
    this.mandatoryDPIAActivities = [
      'systematic_profiling',
      'large_scale_special_category',
      'public_area_monitoring',
      'automated_decision_making',
      'large_scale_processing',
      'data_matching_combination'
    ];
  }

  /**
   * 判断是否需要进行 DPIA
   */
  async requiresDPIA(processingActivity) {
    const checks = {
      mandatory: this.mandatoryDPIAActivities.includes(processingActivity.type),
      highRiskData: this.hasHighRiskDataCategories(processingActivity.dataCategories),
      vulnerableSubjects: this.hasVulnerableSubjects(processingActivity.dataSubjects),
      largeScale: processingActivity.scale === 'large',
      innovativeTech: processingActivity.usesInnovativeTechnology,
      crossBorderTransfer: processingActivity.crossBorderTransfer
    };
    
    // 任一条件满足则需要进行 DPIA
    return Object.values(checks).some(v => v === true);
  }

  /**
   * 自动生成风险评估
   */
  async generateRiskAssessment(assessmentId, processingActivity) {
    const risks = [];
    
    // 1. 数据泄露风险
    if (processingActivity.dataCategories.includes('sensitive') || 
        processingActivity.dataCategories.includes('financial')) {
      risks.push({
        riskCategory: 'data_breach',
        riskDescription: `潜在的数据泄露风险，涉及${processingActivity.dataCategories.join(', ')}数据`,
        likelihood: this.assessLikelihood(processingActivity, 'breach'),
        impact: this.assessImpact(processingActivity, 'breach'),
        suggestedMitigations: [
          '实施端到端加密',
          '部署数据防泄露系统 (DLP)',
          '建立访问控制和审计日志',
          '制定数据泄露应急响应计划'
        ]
      });
    }
    
    // 2. 未经授权访问风险
    risks.push({
      riskCategory: 'unauthorized_access',
      riskDescription: '未授权访问个人数据的风险',
      likelihood: this.assessLikelihood(processingActivity, 'access'),
      impact: this.assessImpact(processingActivity, 'access'),
      suggestedMitigations: [
        '实施多因素认证',
        '基于角色的访问控制 (RBAC)',
        '定期访问权限审核',
        '最小权限原则实施'
      ]
    });
    
    // 3. 数据滥用风险
    if (processingActivity.purpose === 'marketing' || 
        processingActivity.automatedDecisionMaking) {
      risks.push({
        riskCategory: 'data_misuse',
        riskDescription: '数据可能被用于未授权目的或自动化决策造成不公平影响',
        likelihood: 'possible',
        impact: 'significant',
        suggestedMitigations: [
          '明确限定处理目的',
          '实施目的绑定机制',
          '提供人工复核选项',
          '用户同意机制'
        ]
      });
    }
    
    // 4. 跨境传输风险
    if (processingActivity.crossBorderTransfer) {
      risks.push({
        riskCategory: 'cross_border_transfer',
        riskDescription: '数据跨境传输可能面临不同隐私保护标准的风险',
        likelihood: 'likely',
        impact: 'significant',
        suggestedMitigations: [
          '确保接收国有足够的保护水平',
          '签署标准合同条款 (SCC)',
          '实施绑定企业规则 (BCR)',
          '数据本地化存储选项'
        ]
      });
    }
    
    // 5. 数据主体权利行使风险
    risks.push({
      riskCategory: 'rights_exercise',
      riskDescription: '数据主体行使访问、删除、更正等权利可能存在障碍',
      likelihood: 'possible',
      impact: 'limited',
      suggestedMitigations: [
        '建立用户数据门户',
        '自动化数据导出功能',
        '数据删除工作流',
        '权利行使响应时限监控'
      ]
    });
    
    // 6. 数据保留风险
    if (!processingActivity.retentionPeriod || processingActivity.retentionPeriod === 'indefinite') {
      risks.push({
        riskCategory: 'data_retention',
        riskDescription: '无限期或过长的数据保留期限违反最小化原则',
        likelihood: 'likely',
        impact: 'significant',
        suggestedMitigations: [
          '设定明确的数据保留期限',
          '实施自动数据删除机制',
          '定期数据清理审计',
          '匿名化处理过期数据'
        ]
      });
    }
    
    return risks;
  }

  /**
   * 评估可能性
   */
  assessLikelihood(activity, riskType) {
    const factors = {
      breach: {
        encryption: activity.encryptionEnabled ? -1 : 1,
        accessControls: activity.accessControlsStrength || 0,
        securityIncidents: activity.pastSecurityIncidents ? 2 : 0
      },
      access: {
        mfa: activity.mfaEnabled ? -1 : 1,
        externalAccess: activity.allowsExternalAccess ? 1 : 0,
        employeeCount: activity.employeeCount > 100 ? 1 : 0
      }
    };
    
    const score = Object.values(factors[riskType] || {}).reduce((a, b) => a + b, 0);
    
    if (score <= -1) return 'unlikely';
    if (score <= 1) return 'possible';
    if (score <= 2) return 'likely';
    return 'almost_certain';
  }

  /**
   * 评估影响程度
   */
  assessImpact(activity, riskType) {
    const dataSensitivityScore = {
      'basic': 1,
      'contact': 2,
      'financial': 3,
      'health': 4,
      'sensitive': 4
    };
    
    const maxSensitivity = Math.max(
      ...activity.dataCategories.map(cat => dataSensitivityScore[cat] || 1)
    );
    
    const scaleMultiplier = activity.scale === 'large' ? 1.2 : 1;
    const impactScore = Math.round(maxSensitivity * scaleMultiplier);
    
    if (impactScore <= 1) return 'negligible';
    if (impactScore <= 2) return 'limited';
    if (impactScore <= 3) return 'significant';
    return 'maximal';
  }

  /**
   * 检查是否包含高风险数据类别
   */
  hasHighRiskDataCategories(categories) {
    const highRiskCategories = [
      'health', 'biometric', 'genetic', 'financial',
      'political', 'religious', 'sexual', 'criminal'
    ];
    return categories.some(cat => highRiskCategories.includes(cat));
  }

  /**
   * 检查是否涉及弱势群体
   */
  hasVulnerableSubjects(subjects) {
    const vulnerableGroups = [
      'children', 'elderly', 'patients', 'employees',
      'mentally_disabled', 'economically_disadvantaged'
    ];
    return subjects.some(sub => vulnerableGroups.includes(sub));
  }

  /**
   * 生成合规检查清单
   */
  async generateComplianceChecklist(assessmentId, processingActivity) {
    const checks = [];
    
    // GDPR 第 5 条 - 数据处理原则
    checks.push({
      checkCode: 'GDPR-Art5-Lawfulness',
      checkCategory: 'lawful_basis',
      checkDescription: '数据处理是否有合法的法律依据？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-PurposeLimitation',
      checkCategory: 'purpose_limitation',
      checkDescription: '数据是否仅为明确、具体且合法的目的而收集？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-DataMinimization',
      checkCategory: 'data_minimization',
      checkDescription: '处理的数据是否限于目的所需的最小范围？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-Accuracy',
      checkCategory: 'accuracy',
      checkDescription: '是否有机制确保数据准确并及时更新？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-StorageLimitation',
      checkCategory: 'storage_limitation',
      checkDescription: '是否设定了数据保留期限并在到期后删除？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-Integrity',
      checkCategory: 'security',
      checkDescription: '是否采取了适当的技术和组织措施确保数据安全？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art5-Accountability',
      checkCategory: 'accountability',
      checkDescription: '是否能证明符合 GDPR 原则？',
      isApplicable: true
    });
    
    // GDPR 第 6 条 - 合法依据
    checks.push({
      checkCode: 'GDPR-Art6-LegalBasis',
      checkCategory: 'lawful_basis',
      checkDescription: '是否明确识别并记录了数据处理的合法依据？',
      isApplicable: true
    });
    
    // GDPR 第 7 条 - 同意
    if (processingActivity.legalBasis === 'consent') {
      checks.push({
        checkCode: 'GDPR-Art7-Consent',
        checkCategory: 'consent',
        checkDescription: '同意是否自由给出、具体、知情且明确？',
        isApplicable: true
      });
      
      checks.push({
        checkCode: 'GDPR-Art7-Withdrawal',
        checkCategory: 'consent',
        checkDescription: '是否提供易于撤回同意的机制？',
        isApplicable: true
      });
    }
    
    // GDPR 第 13/14 条 - 信息提供
    checks.push({
      checkCode: 'GDPR-Art13-Information',
      checkCategory: 'transparency',
      checkDescription: '是否在收集数据时向数据主体提供隐私声明？',
      isApplicable: true
    });
    
    // GDPR 第 15-22 条 - 数据主体权利
    checks.push({
      checkCode: 'GDPR-Art15-Access',
      checkCategory: 'data_subject_rights',
      checkDescription: '是否建立了数据访问请求处理机制？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art17-Erasure',
      checkCategory: 'data_subject_rights',
      checkDescription: '是否建立了数据删除请求处理机制？',
      isApplicable: true
    });
    
    checks.push({
      checkCode: 'GDPR-Art20-Portability',
      checkCategory: 'data_subject_rights',
      checkDescription: '是否支持数据可携带性？',
      isApplicable: true
    });
    
    // GDPR 第 25 条 - 隐私设计
    checks.push({
      checkCode: 'GDPR-Art25-PbD',
      checkCategory: 'privacy_by_design',
      checkDescription: '是否在设计阶段就考虑了数据保护原则？',
      isApplicable: true
    });
    
    // GDPR 第 32 条 - 安全措施
    checks.push({
      checkCode: 'GDPR-Art32-Security',
      checkCategory: 'security',
      checkDescription: '是否实施了适当的技术和组织安全措施？',
      isApplicable: true
    });
    
    // GDPR 第 33 条 - 数据泄露通知
    checks.push({
      checkCode: 'GDPR-Art33-BreachNotification',
      checkCategory: 'breach_response',
      checkDescription: '是否建立了72小时内报告数据泄露的机制？',
      isApplicable: true
    });
    
    // GDPR 第 35 条 - DPIA
    checks.push({
      checkCode: 'GDPR-Art35-DPIA',
      checkCategory: 'dpia',
      checkDescription: '是否对高风险处理活动进行了隐私影响评估？',
      isApplicable: true
    });
    
    return checks;
  }

  /**
   * 计算 DPIA 总体风险等级
   */
  calculateOverallRiskLevel(risks) {
    if (!risks || risks.length === 0) return 'low';
    
    const maxScore = Math.max(...risks.map(r => r.risk_score || 0));
    
    for (const [level, range] of Object.entries(this.riskThresholds)) {
      if (maxScore >= range.min && maxScore <= range.max) {
        return level;
      }
    }
    
    return 'critical';
  }

  /**
   * 生成 DPIA 报告
   */
  async generateDPIAReport(assessmentId) {
    const assessment = await this.getAssessment(assessmentId);
    const risks = await this.getRisks(assessmentId);
    const mitigations = await this.getMitigations(assessmentId);
    const complianceChecks = await this.getComplianceChecks(assessmentId);
    
    const report = {
      header: {
        assessmentCode: assessment.assessment_code,
        title: assessment.title,
        generatedAt: new Date().toISOString(),
        validUntil: assessment.valid_until
      },
      executiveSummary: {
        overallRiskLevel: this.calculateOverallRiskLevel(risks),
        totalRisks: risks.length,
        highRisks: risks.filter(r => r.risk_score >= 9).length,
        mitigationsImplemented: mitigations.filter(m => m.status === 'completed').length,
        complianceRate: this.calculateComplianceRate(complianceChecks)
      },
      processingActivity: {
        description: assessment.processing_activity,
        purpose: assessment.processing_purpose,
        legalBasis: assessment.legal_basis,
        dataCategories: assessment.data_categories,
        dataSubjects: assessment.data_subjects
      },
      riskAssessment: risks.map(risk => ({
        category: risk.risk_category,
        description: risk.risk_description,
        likelihood: risk.likelihood,
        impact: risk.impact,
        score: risk.risk_score,
        mitigations: risk.mitigations || [],
        residualRisk: risk.residual_risk_score
      })),
      complianceStatus: {
        checks: complianceChecks,
        summary: {
          total: complianceChecks.length,
          compliant: complianceChecks.filter(c => c.is_compliant).length,
          nonCompliant: complianceChecks.filter(c => c.is_compliant === false).length,
          pending: complianceChecks.filter(c => c.is_compliant === null).length
        }
      },
      recommendations: this.generateRecommendations(risks, complianceChecks),
      approval: {
        preparedBy: assessment.created_by,
        reviewedBy: assessment.reviewed_by,
        approvedBy: assessment.approved_by,
        status: assessment.status
      }
    };
    
    return report;
  }

  /**
   * 计算合规率
   */
  calculateComplianceRate(checks) {
    const applicableChecks = checks.filter(c => c.is_applicable && c.is_compliant !== null);
    if (applicableChecks.length === 0) return 0;
    
    const compliant = applicableChecks.filter(c => c.is_compliant).length;
    return Math.round((compliant / applicableChecks.length) * 100);
  }

  /**
   * 生成改进建议
   */
  generateRecommendations(risks, complianceChecks) {
    const recommendations = [];
    
    // 基于风险的建议
    const highRisks = risks.filter(r => r.risk_score >= 9);
    highRisks.forEach(risk => {
      recommendations.push({
        priority: 'high',
        category: 'risk_mitigation',
        description: `优先处理${risk.risk_category}风险`,
        relatedRisk: risk.id
      });
    });
    
    // 基于合规检查的建议
    const nonCompliant = complianceChecks.filter(c => !c.is_compliant);
    nonCompliant.forEach(check => {
      recommendations.push({
        priority: 'medium',
        category: 'compliance',
        description: `解决${check.check_category}合规缺口: ${check.check_code}`,
        relatedCheck: check.id
      });
    });
    
    return recommendations;
  }
}

module.exports = DPIAEngine;
```

### 3. DPIA API 服务层

```javascript
// backend/services/user-service/routes/dpia.js

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const DPIAEngine = require('../../shared/dpiaEngine');
const { authenticate, authorize } = require('../../shared/middleware/auth');
const auditLogger = require('../../shared/auditLogger');

const dpiaEngine = new DPIAEngine();

/**
 * @api {post} /api/v1/dpia/assessments 创建 DPIA 评估
 */
router.post('/assessments',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  [
    body('title').notEmpty().withMessage('标题不能为空'),
    body('processingActivity').notEmpty().withMessage('处理活动不能为空'),
    body('dataCategories').isArray({ min: 1 }).withMessage('至少需要一个数据类别'),
    body('dataSubjects').isArray({ min: 1 }).withMessage('至少需要一个数据主体类型'),
    body('processingPurpose').notEmpty().withMessage('处理目的不能为空'),
    body('legalBasis').isIn(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const assessmentData = {
        ...req.body,
        createdBy: req.user.id
      };

      // 检查是否需要 DPIA
      const requiresDPIA = await dpiaEngine.requiresDPIA(assessmentData);
      
      if (!requiresDPIA) {
        return res.status(400).json({
          message: '根据评估，该处理活动不需要进行 DPIA',
          recommendation: '建议进行简化版隐私评估'
        });
      }

      // 创建评估记录
      const assessment = await createAssessment(assessmentData);
      
      // 自动生成风险评估
      const risks = await dpiaEngine.generateRiskAssessment(assessment.id, assessmentData);
      await saveRisks(assessment.id, risks);

      // 生成合规检查清单
      const checks = await dpiaEngine.generateComplianceChecklist(assessment.id, assessmentData);
      await saveComplianceChecks(assessment.id, checks);

      // 记录审计日志
      await auditLogger.log({
        action: 'DPIA_CREATED',
        entityType: 'dpia_assessment',
        entityId: assessment.id,
        userId: req.user.id,
        details: {
          assessmentCode: assessment.assessment_code,
          riskLevel: dpiaEngine.calculateOverallRiskLevel(risks)
        }
      });

      res.status(201).json({
        assessment,
        risks,
        checks,
        message: 'DPIA 评估已创建，请完成风险评估和合规检查'
      });
    } catch (error) {
      console.error('DPIA 创建失败:', error);
      res.status(500).json({ message: 'DPIA 创建失败', error: error.message });
    }
  }
);

/**
 * @api {get} /api/v1/dpia/assessments 获取 DPIA 列表
 */
router.get('/assessments',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer', 'auditor']),
  async (req, res) => {
    try {
      const { status, riskLevel, page = 1, limit = 20 } = req.query;
      
      const assessments = await getAssessments({
        status,
        riskLevel,
        page: parseInt(page),
        limit: parseInt(limit)
      });

      res.json(assessments);
    } catch (error) {
      console.error('获取 DPIA 列表失败:', error);
      res.status(500).json({ message: '获取列表失败' });
    }
  }
);

/**
 * @api {get} /api/v1/dpia/assessments/:id 获取 DPIA 详情
 */
router.get('/assessments/:id',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer', 'auditor']),
  async (req, res) => {
    try {
      const assessment = await getAssessmentById(req.params.id);
      if (!assessment) {
        return res.status(404).json({ message: 'DPIA 评估不存在' });
      }

      const risks = await getRisksByAssessment(assessment.id);
      const mitigations = await getMitigationsByAssessment(assessment.id);
      const complianceChecks = await getComplianceChecksByAssessment(assessment.id);

      res.json({
        assessment,
        risks,
        mitigations,
        complianceChecks
      });
    } catch (error) {
      console.error('获取 DPIA 详情失败:', error);
      res.status(500).json({ message: '获取详情失败' });
    }
  }
);

/**
 * @api {put} /api/v1/dpia/assessments/:id/risks/:riskId 更新风险项
 */
router.put('/assessments/:id/risks/:riskId',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  async (req, res) => {
    try {
      const { id, riskId } = req.params;
      const { mitigations, mitigationStatus, residualRiskScore } = req.body;

      const risk = await updateRisk(riskId, {
        mitigations,
        mitigationStatus,
        residualRiskScore,
        updatedAt: new Date()
      });

      // 记录审计日志
      await auditLogger.log({
        action: 'DPIA_RISK_UPDATED',
        entityType: 'dpia_risk',
        entityId: riskId,
        userId: req.user.id,
        details: { assessmentId: id, mitigationStatus }
      });

      res.json(risk);
    } catch (error) {
      console.error('更新风险项失败:', error);
      res.status(500).json({ message: '更新失败' });
    }
  }
);

/**
 * @api {post} /api/v1/dpia/assessments/:id/risks/:riskId/mitigations 添加缓解措施
 */
router.post('/assessments/:id/risks/:riskId/mitigations',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  async (req, res) => {
    try {
      const { id, riskId } = req.params;
      const mitigation = await createMitigation({
        riskId,
        ...req.body
      });

      res.status(201).json(mitigation);
    } catch (error) {
      console.error('创建缓解措施失败:', error);
      res.status(500).json({ message: '创建失败' });
    }
  }
);

/**
 * @api {put} /api/v1/dpia/assessments/:id/compliance/:checkId 更新合规检查项
 */
router.put('/assessments/:id/compliance/:checkId',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  async (req, res) => {
    try {
      const { id, checkId } = req.params;
      const { isCompliant, complianceNotes, evidence } = req.body;

      const check = await updateComplianceCheck(checkId, {
        isCompliant,
        complianceNotes,
        evidence,
        checkedBy: req.user.id,
        checkedAt: new Date()
      });

      res.json(check);
    } catch (error) {
      console.error('更新合规检查项失败:', error);
      res.status(500).json({ message: '更新失败' });
    }
  }
);

/**
 * @api {post} /api/v1/dpia/assessments/:id/submit 提交审核
 */
router.post('/assessments/:id/submit',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  async (req, res) => {
    try {
      const assessment = await getAssessmentById(req.params.id);
      if (!assessment) {
        return res.status(404).json({ message: 'DPIA 评估不存在' });
      }

      // 检查是否所有必要项已完成
      const risks = await getRisksByAssessment(assessment.id);
      const checks = await getComplianceChecksByAssessment(assessment.id);
      
      const pendingMitigations = risks.filter(r => r.mitigation_status === 'pending');
      const uncheckedItems = checks.filter(c => c.is_compliant === null);

      if (pendingMitigations.length > 0 || uncheckedItems.length > 0) {
        return res.status(400).json({
          message: '请先完成所有风险评估和合规检查',
          pendingMitigations: pendingMitigations.length,
          uncheckedItems: uncheckedItems.length
        });
      }

      // 更新状态为审核中
      await updateAssessmentStatus(assessment.id, 'review');

      // 记录审计日志
      await auditLogger.log({
        action: 'DPIA_SUBMITTED',
        entityType: 'dpia_assessment',
        entityId: assessment.id,
        userId: req.user.id,
        details: { assessmentCode: assessment.assessment_code }
      });

      res.json({
        message: 'DPIA 已提交审核',
        status: 'review'
      });
    } catch (error) {
      console.error('提交审核失败:', error);
      res.status(500).json({ message: '提交失败' });
    }
  }
);

/**
 * @api {post} /api/v1/dpia/assessments/:id/approve 批准 DPIA
 */
router.post('/assessments/:id/approve',
  authenticate,
  authorize(['dpo']),  // 只有数据保护官可以批准
  async (req, res) => {
    try {
      const assessment = await getAssessmentById(req.params.id);
      if (!assessment) {
        return res.status(404).json({ message: 'DPIA 评估不存在' });
      }

      if (assessment.status !== 'review') {
        return res.status(400).json({ message: '当前状态不允许批准' });
      }

      // 计算 DPIA 有效期（通常 2 年）
      const validUntil = new Date();
      validUntil.setFullYear(validUntil.getFullYear() + 2);

      // 设置下次复核日期（高风险 6 个月，中风险 12 个月）
      const nextReviewDate = new Date();
      const months = assessment.risk_level === 'high' || assessment.risk_level === 'critical' ? 6 : 12;
      nextReviewDate.setMonth(nextReviewDate.getMonth() + months);

      await updateAssessment(assessment.id, {
        status: 'approved',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        validUntil,
        nextReviewDate
      });

      // 记录审计日志
      await auditLogger.log({
        action: 'DPIA_APPROVED',
        entityType: 'dpia_assessment',
        entityId: assessment.id,
        userId: req.user.id,
        details: {
          assessmentCode: assessment.assessment_code,
          validUntil,
          nextReviewDate
        }
      });

      res.json({
        message: 'DPIA 已批准',
        validUntil,
        nextReviewDate
      });
    } catch (error) {
      console.error('批准 DPIA 失败:', error);
      res.status(500).json({ message: '批准失败' });
    }
  }
);

/**
 * @api {get} /api/v1/dpia/assessments/:id/report 生成 DPIA 报告
 */
router.get('/assessments/:id/report',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer', 'auditor']),
  async (req, res) => {
    try {
      const report = await dpiaEngine.generateDPIAReport(req.params.id);
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="dpia-${report.header.assessmentCode}.json"`);
      res.json(report);
    } catch (error) {
      console.error('生成报告失败:', error);
      res.status(500).json({ message: '生成报告失败' });
    }
  }
);

/**
 * @api {get} /api/v1/dpia/dashboard 获取 DPIA 仪表板数据
 */
router.get('/dashboard',
  authenticate,
  authorize(['admin', 'dpo', 'compliance_officer']),
  async (req, res) => {
    try {
      const stats = await getDPIAStats();
      const upcomingReviews = await getUpcomingReviews(30); // 未来30天需要复核的
      const expiringAssessments = await getExpiringAssessments(60); // 未来60天过期的

      res.json({
        stats,
        upcomingReviews,
        expiringAssessments
      });
    } catch (error) {
      console.error('获取仪表板数据失败:', error);
      res.status(500).json({ message: '获取数据失败' });
    }
  }
);

module.exports = router;
```

### 4. DPIA 复核任务调度

```javascript
// backend/jobs/dpiaReviewReminder.js

const cron = require('node-cron');
const { sendEmail, sendPushNotification } = require('../shared/notifications');
const NotificationService = require('../services/notification-service');

class DPIAReviewReminder {
  constructor() {
    this.init();
  }

  init() {
    // 每天上午 9 点检查 DPIA 复核提醒
    cron.schedule('0 9 * * *', async () => {
      await this.checkUpcomingReviews();
    });

    // 每周一检查即将过期的 DPIA
    cron.schedule('0 10 * * 1', async () => {
      await this.checkExpiringAssessments();
    });
  }

  async checkUpcomingReviews() {
    console.log('[DPIA] 检查即将到期的复核...');
    
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    // 获取 7 天内需要复核的 DPIA
    const upcomingReviews = await getDPIAsForReview(sevenDaysFromNow);
    
    for (const review of upcomingReviews) {
      const daysUntilReview = Math.ceil(
        (new Date(review.next_review_date) - new Date()) / (1000 * 60 * 60 * 24)
      );

      if (daysUntilReview <= 3) {
        // 紧急提醒
        await this.sendUrgentReminder(review, daysUntilReview);
      } else if (daysUntilReview <= 7) {
        // 常规提醒
        await this.sendStandardReminder(review, daysUntilReview);
      }
    }
  }

  async sendUrgentReminder(review, daysLeft) {
    const message = `【紧急】DPIA 复核提醒：${review.title} 将在 ${daysLeft} 天后到期，请尽快安排复核。`;
    
    // 发送给 DPO 和相关管理员
    await NotificationService.sendToRole('dpo', {
      type: 'dpia_review_urgent',
      title: 'DPIA 复核紧急提醒',
      message,
      assessmentId: review.id
    });

    // 发送邮件
    const dpoUsers = await getUsersByRole('dpo');
    for (const user of dpoUsers) {
      await sendEmail({
        to: user.email,
        subject: `【紧急】DPIA 复核提醒 - ${review.title}`,
        template: 'dpia-review-urgent',
        data: {
          name: user.name,
          assessmentCode: review.assessment_code,
          title: review.title,
          daysLeft,
          reviewDate: review.next_review_date,
          dashboardUrl: `${process.env.ADMIN_DASHBOARD_URL}/dpia/${review.id}`
        }
      });
    }
  }

  async sendStandardReminder(review, daysLeft) {
    await NotificationService.sendToRole('dpo', {
      type: 'dpia_review_reminder',
      title: 'DPIA 复核提醒',
      message: `DPIA 复核提醒：${review.title} 将在 ${daysLeft} 天后到期`,
      assessmentId: review.id
    });
  }

  async checkExpiringAssessments() {
    console.log('[DPIA] 检查即将过期的评估...');
    
    const sixtyDaysFromNow = new Date();
    sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);

    const expiringAssessments = await getExpiringDPIAs(sixtyDaysFromNow);
    
    for (const assessment of expiringAssessments) {
      const daysUntilExpiry = Math.ceil(
        (new Date(assessment.valid_until) - new Date()) / (1000 * 60 * 60 * 24)
      );

      if (daysUntilExpiry <= 30) {
        // 即将过期，需要续期或重新评估
        await this.sendExpiryWarning(assessment, daysUntilExpiry);
      }
    }
  }

  async sendExpiryWarning(assessment, daysLeft) {
    await NotificationService.sendToRole('dpo', {
      type: 'dpia_expiry_warning',
      title: 'DPIA 即将过期',
      message: `${assessment.title} 将在 ${daysLeft} 天后过期，请安排续期或重新评估`,
      assessmentId: assessment.id
    });
  }
}

module.exports = new DPIAReviewReminder();
```

### 5. DPIA 前端界面组件

```javascript
// frontend/game-client/src/components/admin/DPIADashboard.jsx

import React, { useState, useEffect } from 'react';
import { Box, Card, Typography, Grid, Chip, Button, Table, TableBody, TableCell, TableHead, TableRow, Alert } from '@mui/material';
import { Warning, CheckCircle, Schedule, Security } from '@mui/icons-material';
import { apiClient } from '../../utils/apiClient';

const DPIADashboard = () => {
  const [stats, setStats] = useState(null);
  const [upcomingReviews, setUpcomingReviews] = useState([]);
  const [expiringAssessments, setExpiringAssessments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      const response = await apiClient.get('/api/v1/dpia/dashboard');
      setStats(response.data.stats);
      setUpcomingReviews(response.data.upcomingReviews);
      setExpiringAssessments(response.data.expiringAssessments);
    } catch (error) {
      console.error('获取 DPIA 仪表板数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const getRiskLevelColor = (level) => {
    const colors = {
      low: 'success',
      medium: 'warning',
      high: 'error',
      critical: 'error'
    };
    return colors[level] || 'default';
  };

  if (loading) return <Typography>加载中...</Typography>;

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" sx={{ mb: 3, display: 'flex', alignItems: 'center' }}>
        <Security sx={{ mr: 1 }} />
        数据隐私影响评估（DPIA）管理
      </Typography>

      {/* 统计卡片 */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ p: 2 }}>
            <Typography color="text.secondary" variant="body2">总评估数</Typography>
            <Typography variant="h3">{stats?.total || 0}</Typography>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ p: 2 }}>
            <Typography color="text.secondary" variant="body2">已批准</Typography>
            <Typography variant="h3" color="success.main">{stats?.approved || 0}</Typography>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ p: 2 }}>
            <Typography color="text.secondary" variant="body2">待审核</Typography>
            <Typography variant="h3" color="warning.main">{stats?.pending || 0}</Typography>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ p: 2 }}>
            <Typography color="text.secondary" variant="body2">高风险</Typography>
            <Typography variant="h3" color="error.main">{stats?.highRisk || 0}</Typography>
          </Card>
        </Grid>
      </Grid>

      {/* 即将复核提醒 */}
      {upcomingReviews.length > 0 && (
        <Alert severity="warning" sx={{ mb: 3 }} icon={<Schedule />}>
          <Typography variant="subtitle2">
            有 {upcomingReviews.length} 个 DPIA 需要近期复核
          </Typography>
        </Alert>
      )}

      {/* 即将过期警告 */}
      {expiringAssessments.length > 0 && (
        <Alert severity="error" sx={{ mb: 3 }} icon={<Warning />}>
          <Typography variant="subtitle2">
            有 {expiringAssessments.length} 个 DPIA 即将过期
          </Typography>
        </Alert>
      )}

      {/* 评估列表 */}
      <Card>
        <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6">DPIA 评估列表</Typography>
          <Button variant="contained" color="primary" href="/dpia/create">
            创建新评估
          </Button>
        </Box>
        
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>评估编号</TableCell>
              <TableCell>标题</TableCell>
              <TableCell>风险等级</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>下次复核</TableCell>
              <TableCell>有效期至</TableCell>
              <TableCell>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {upcomingReviews.map((assessment) => (
              <TableRow key={assessment.id}>
                <TableCell>{assessment.assessment_code}</TableCell>
                <TableCell>{assessment.title}</TableCell>
                <TableCell>
                  <Chip
                    label={assessment.risk_level}
                    color={getRiskLevelColor(assessment.risk_level)}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  <Chip
                    label={assessment.status}
                    color={assessment.status === 'approved' ? 'success' : 'warning'}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  {assessment.next_review_date ? 
                    new Date(assessment.next_review_date).toLocaleDateString() : '-'}
                </TableCell>
                <TableCell>
                  {assessment.valid_until ? 
                    new Date(assessment.valid_until).toLocaleDateString() : '-'}
                </TableCell>
                <TableCell>
                  <Button size="small" href={`/dpia/${assessment.id}`}>
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Box>
  );
};

export default DPIADashboard;
```

## 验收标准

- [ ] DPIA 评估创建流程完整，支持自动风险评估生成
- [ ] 风险评估引擎能正确计算风险分数和等级
- [ ] 合规检查清单覆盖 GDPR 所有相关条款
- [ ] 缓解措施管理支持状态追踪和证据上传
- [ ] DPIA 报告生成功能完整，支持导出
- [ ] 审核流程支持 DPO 审批和状态流转
- [ ] 复核提醒系统正常工作，能发送邮件和站内通知
- [ ] 管理后台 DPIA 仪表板显示完整统计信息
- [ ] 审计日志记录所有 DPIA 操作
- [ ] API 接口有完善的权限控制（DPO 专属权限）
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] 集成测试验证完整工作流

## 影响范围

- `backend/services/user-service/routes/dpia.js` - 新增 DPIA 路由
- `backend/shared/dpiaEngine.js` - DPIA 评估引擎
- `backend/shared/riskCalculator.js` - 风险计算器
- `backend/shared/complianceChecker.js` - 合规检查器
- `backend/jobs/dpiaReviewReminder.js` - 复核提醒任务
- `database/migrations/` - 新增 DPIA 相关表
- `frontend/game-client/src/components/admin/DPIADashboard.jsx` - 管理界面
- `frontend/game-client/src/components/admin/DPIAForm.jsx` - 评估表单
- `admin-dashboard/` - 管理后台集成

## 参考

- [GDPR Article 35 - Impact Assessment](https://gdpr-info.eu/art-35-gdpr/)
- [ICO DPIA Guidance](https://ico.org.uk/for-organisations/guide-to-data-protection/guide-to-the-general-data-protection-regulation-gdpr/accountability-and-governance/data-protection-impact-assessments/)
- [CNIL DPIA Template](https://www.cnil.fr/en/privacy-impact-assessment-pia)
- [ISO 29134 - Privacy Impact Assessment](https://www.iso.org/standard/80293.html)
