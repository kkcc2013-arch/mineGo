# REQ-00184: 数据隐私影响评估（DPIA）自动化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00184 |
| 标题 | 数据隐私影响评估（DPIA）自动化系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、database/migrations |
| 创建时间 | 2026-06-14 05:00 |

## 需求描述

根据 GDPR 第 35 条要求，处理个人数据可能对用户权利和自由造成高风险时，必须进行数据隐私影响评估（Data Protection Impact Assessment，DPIA）。本项目需要建立一个自动化 DPIA 系统，帮助运营团队：

1. **自动识别高风险数据处理活动** - 基于预设规则自动检测需要评估的场景
2. **标准化评估流程** - 提供结构化的评估问卷和风险评分模型
3. **生成合规报告** - 自动生成符合监管要求的 DPIA 报告
4. **追踪评估历史** - 保留所有历史评估记录以备审计
5. **风险缓解建议** - 基于评估结果自动推荐安全措施

### 适用场景
- 新功能涉及新的个人数据收集
- 数据处理方式发生变化（如跨境传输、第三方共享）
- 使用新的数据处理技术（如 AI 分析、行为追踪）
- 定期合规审查（每年至少一次）

## 技术方案

### 1. DPIA 评估数据模型

```sql
-- database/migrations/20260614_dpia_system.sql

-- DPIA 评估记录表
CREATE TABLE dpia_assessments (
    id SERIAL PRIMARY KEY,
    assessment_id VARCHAR(50) UNIQUE NOT NULL,  -- DPIA-YYYY-NNNN
    title VARCHAR(255) NOT NULL,
    description TEXT,
    feature_id VARCHAR(100),  -- 关联的功能/需求编号
    assessor_id INTEGER REFERENCES users(id),
    status VARCHAR(30) DEFAULT 'draft',  -- draft, in_review, approved, rejected, expired
    risk_level VARCHAR(20),  -- low, medium, high, critical
    overall_score DECIMAL(3,1),  -- 0-100 风险评分
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    submitted_at TIMESTAMP,
    approved_at TIMESTAMP,
    approved_by INTEGER REFERENCES users(id),
    expires_at TIMESTAMP,  -- 评估有效期
    metadata JSONB DEFAULT '{}'
);

-- DPIA 评估问卷答案表
CREATE TABLE dpia_responses (
    id SERIAL PRIMARY KEY,
    assessment_id VARCHAR(50) REFERENCES dpia_assessments(assessment_id),
    category VARCHAR(100) NOT NULL,  -- 问题类别
    question_id VARCHAR(50) NOT NULL,  -- 问题编号
    question_text TEXT NOT NULL,
    answer TEXT,
    answer_type VARCHAR(20),  -- text, select, multiselect, boolean, number
    risk_weight DECIMAL(3,2),  -- 该问题的风险权重
    risk_score DECIMAL(3,1),  -- 该问题的风险得分
    mitigation_measures TEXT,  -- 缓解措施
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DPIA 风险登记册
CREATE TABLE dpia_risk_register (
    id SERIAL PRIMARY KEY,
    assessment_id VARCHAR(50) REFERENCES dpia_assessments(assessment_id),
    risk_id VARCHAR(50) NOT NULL,
    risk_description TEXT NOT NULL,
    likelihood VARCHAR(20),  -- rare, unlikely, possible, likely, almost_certain
    impact VARCHAR(20),  -- negligible, limited, significant, maximum
    inherent_risk_score DECIMAL(3,1),
    residual_risk_score DECIMAL(3,1),
    mitigation_measures TEXT,
    mitigation_status VARCHAR(30),  -- planned, in_progress, implemented, accepted
    owner_id INTEGER REFERENCES users(id),
    due_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DPIA 合规检查项表
CREATE TABLE dpia_compliance_checks (
    id SERIAL PRIMARY KEY,
    assessment_id VARCHAR(50) REFERENCES dpia_assessments(assessment_id),
    regulation VARCHAR(50),  -- GDPR, CCPA, COPPA, PIPL
    article_reference VARCHAR(100),  -- 条款引用
    requirement TEXT NOT NULL,
    compliance_status VARCHAR(30),  -- compliant, partial, non_compliant, not_applicable
    evidence TEXT,
    remediation_plan TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DPIA 评估历史记录
CREATE TABLE dpia_audit_log (
    id SERIAL PRIMARY KEY,
    assessment_id VARCHAR(50) REFERENCES dpia_assessments(assessment_id),
    action VARCHAR(50) NOT NULL,
    actor_id INTEGER REFERENCES users(id),
    old_values JSONB,
    new_values JSONB,
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_dpia_assessments_status ON dpia_assessments(status);
CREATE INDEX idx_dpia_assessments_risk_level ON dpia_assessments(risk_level);
CREATE INDEX idx_dpia_assessments_feature ON dpia_assessments(feature_id);
CREATE INDEX idx_dpia_responses_category ON dpia_responses(assessment_id, category);
CREATE INDEX idx_dpia_risk_register_status ON dpia_risk_register(mitigation_status);
```

### 2. DPIA 评估服务

```javascript
// backend/shared/DPIAService.js

const { v4: uuidv4 } = require('uuid');

class DPIAService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
    this.cachePrefix = 'dpia:';
  }

  /**
   * 创建新的 DPIA 评估
   */
  async createAssessment(data) {
    const assessmentId = `DPIA-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    
    const result = await this.db.query(`
      INSERT INTO dpia_assessments 
        (assessment_id, title, description, feature_id, assessor_id, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      assessmentId,
      data.title,
      data.description,
      data.featureId,
      data.assessorId,
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 有效期1年
      data.metadata || {}
    ]);

    // 记录审计日志
    await this.logAction(assessmentId, 'created', data.assessorId, null, result.rows[0]);

    return result.rows[0];
  }

  /**
   * 获取评估问卷模板
   */
  async getQuestionnaireTemplate() {
    return {
      categories: [
        {
          id: 'data_collection',
          name: '数据收集',
          questions: [
            {
              id: 'Q1.1',
              text: '收集哪些类型的个人数据？',
              type: 'multiselect',
              options: [
                '身份信息（姓名、ID号）',
                '联系信息（邮箱、电话、地址）',
                '位置数据',
                '生物识别数据',
                '财务信息',
                '行为数据',
                '设备信息',
                '健康数据',
                '儿童数据',
                '其他敏感数据'
              ],
              riskWeight: 0.8,
              riskMapping: {
                '健康数据': 15,
                '儿童数据': 20,
                '生物识别数据': 18,
                '位置数据': 12,
                '身份信息': 8,
                '联系信息': 5,
                '财务信息': 10,
                '行为数据': 8,
                '设备信息': 5,
                '其他敏感数据': 15
              }
            },
            {
              id: 'Q1.2',
              text: '数据收集的法律依据是什么？',
              type: 'multiselect',
              options: [
                '用户同意',
                '合同履行',
                '法律义务',
                '重大利益',
                '公共利益',
                '正当利益'
              ],
              riskWeight: 0.6,
              riskMapping: {
                '用户同意': 2,
                '合同履行': 3,
                '法律义务': 2,
                '重大利益': 5,
                '公共利益': 4,
                '正当利益': 6
              }
            },
            {
              id: 'Q1.3',
              text: '数据是否涉及自动决策或画像？',
              type: 'select',
              options: ['否', '是-无重大影响', '是-有重大影响'],
              riskWeight: 0.7,
              riskMapping: {
                '否': 0,
                '是-无重大影响': 8,
                '是-有重大影响': 15
              }
            }
          ]
        },
        {
          id: 'data_processing',
          name: '数据处理',
          questions: [
            {
              id: 'Q2.1',
              text: '数据处理的目的是什么？',
              type: 'multiselect',
              options: [
                '服务提供',
                '用户账户管理',
                '支付处理',
                '营销推广',
                '数据分析',
                'AI/机器学习',
                '安全监控',
                '合规审计'
              ],
              riskWeight: 0.5,
              riskMapping: {
                '服务提供': 3,
                '用户账户管理': 2,
                '支付处理': 6,
                '营销推广': 10,
                '数据分析': 8,
                'AI/机器学习': 12,
                '安全监控': 5,
                '合规审计': 3
              }
            },
            {
              id: 'Q2.2',
              text: '数据保留期限是多久？',
              type: 'select',
              options: [
                '少于30天',
                '30天-1年',
                '1-3年',
                '3-7年',
                '无限期保留'
              ],
              riskWeight: 0.4,
              riskMapping: {
                '少于30天': 2,
                '30天-1年': 4,
                '1-3年': 6,
                '3-7年': 10,
                '无限期保留': 18
              }
            },
            {
              id: 'Q2.3',
              text: '数据是否涉及跨境传输？',
              type: 'select',
              options: ['否', '是-传输至欧盟/EEA', '是-传输至其他地区'],
              riskWeight: 0.6,
              riskMapping: {
                '否': 0,
                '是-传输至欧盟/EEA': 3,
                '是-传输至其他地区': 12
              }
            }
          ]
        },
        {
          id: 'data_sharing',
          name: '数据共享',
          questions: [
            {
              id: 'Q3.1',
              text: '数据是否与第三方共享？',
              type: 'multiselect',
              options: [
                '不共享',
                '服务提供商',
                '业务合作伙伴',
                '政府机构',
                '研究机构',
                '其他'
              ],
              riskWeight: 0.6,
              riskMapping: {
                '不共享': 0,
                '服务提供商': 5,
                '业务合作伙伴': 8,
                '政府机构': 10,
                '研究机构': 7,
                '其他': 6
              }
            },
            {
              id: 'Q3.2',
              text: '是否有数据共享协议？',
              type: 'select',
              options: ['否', '部分有', '全部有'],
              riskWeight: 0.5,
              riskMapping: {
                '否': 12,
                '部分有': 6,
                '全部有': 2
              }
            }
          ]
        },
        {
          id: 'security_measures',
          name: '安全措施',
          questions: [
            {
              id: 'Q4.1',
              text: '数据是否加密存储？',
              type: 'select',
              options: ['否', '部分加密', '全部加密'],
              riskWeight: 0.7,
              riskMapping: {
                '否': 15,
                '部分加密': 6,
                '全部加密': 1
              }
            },
            {
              id: 'Q4.2',
              text: '是否实施了访问控制？',
              type: 'select',
              options: ['否', '基础控制', '细粒度RBAC', '零信任架构'],
              riskWeight: 0.6,
              riskMapping: {
                '否': 15,
                '基础控制': 8,
                '细粒度RBAC': 3,
                '零信任架构': 1
              }
            },
            {
              id: 'Q4.3',
              text: '是否有安全审计日志？',
              type: 'select',
              options: ['否', '基础日志', '完整审计日志'],
              riskWeight: 0.4,
              riskMapping: {
                '否': 10,
                '基础日志': 5,
                '完整审计日志': 1
              }
            }
          ]
        },
        {
          id: 'user_rights',
          name: '用户权利',
          questions: [
            {
              id: 'Q5.1',
              text: '用户是否可以行使数据访问权？',
              type: 'select',
              options: ['否', '是-人工处理', '是-自助服务'],
              riskWeight: 0.5,
              riskMapping: {
                '否': 12,
                '是-人工处理': 4,
                '是-自助服务': 1
              }
            },
            {
              id: 'Q5.2',
              text: '用户是否可以请求数据删除？',
              type: 'select',
              options: ['否', '是-有限制', '是-完全支持'],
              riskWeight: 0.5,
              riskMapping: {
                '否': 12,
                '是-有限制': 5,
                '是-完全支持': 1
              }
            },
            {
              id: 'Q5.3',
              text: '是否有透明的隐私政策？',
              type: 'select',
              options: ['否', '基础政策', '详细且易懂的政策'],
              riskWeight: 0.4,
              riskMapping: {
                '否': 15,
                '基础政策': 6,
                '详细且易懂的政策': 1
              }
            }
          ]
        }
      ]
    };
  }

  /**
   * 提交评估答案
   */
  async submitResponses(assessmentId, responses, assessorId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // 获取问卷模板
      const template = await this.getQuestionnaireTemplate();
      const questionMap = {};
      template.categories.forEach(cat => {
        cat.questions.forEach(q => {
          questionMap[q.id] = { ...q, category: cat.id };
        });
      });

      // 计算总风险分
      let totalScore = 0;
      let totalWeight = 0;

      for (const response of responses) {
        const question = questionMap[response.questionId];
        if (!question) continue;

        let riskScore = 0;
        if (question.riskMapping) {
          if (Array.isArray(response.answer)) {
            response.answer.forEach(ans => {
              riskScore += question.riskMapping[ans] || 0;
            });
          } else {
            riskScore = question.riskMapping[response.answer] || 0;
          }
        }

        totalScore += riskScore * question.riskWeight;
        totalWeight += question.riskWeight;

        // 保存答案
        await client.query(`
          INSERT INTO dpia_responses 
            (assessment_id, category, question_id, question_text, answer, answer_type, 
             risk_weight, risk_score, mitigation_measures)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          assessmentId,
          question.category,
          question.id,
          question.text,
          Array.isArray(response.answer) ? JSON.stringify(response.answer) : response.answer,
          question.type,
          question.riskWeight,
          riskScore,
          response.mitigationMeasures || null
        ]);
      }

      // 计算归一化风险分数 (0-100)
      const normalizedScore = totalWeight > 0 ? Math.min(100, (totalScore / totalWeight) * 2) : 0;

      // 确定风险等级
      let riskLevel;
      if (normalizedScore < 30) riskLevel = 'low';
      else if (normalizedScore < 50) riskLevel = 'medium';
      else if (normalizedScore < 70) riskLevel = 'high';
      else riskLevel = 'critical';

      // 更新评估记录
      const result = await client.query(`
        UPDATE dpia_assessments 
        SET overall_score = $1, risk_level = $2, status = 'in_review', submitted_at = $3, updated_at = $4
        WHERE assessment_id = $5
        RETURNING *
      `, [normalizedScore, riskLevel, new Date(), new Date(), assessmentId]);

      await client.query('COMMIT');

      // 清除缓存
      await this.redis.del(`${this.cachePrefix}assessment:${assessmentId}`);

      // 记录审计日志
      await this.logAction(assessmentId, 'submitted', assessorId, null, { 
        totalScore, 
        normalizedScore, 
        riskLevel,
        responseCount: responses.length 
      });

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 生成合规检查清单
   */
  async generateComplianceChecklist(assessmentId) {
    const gdprChecks = [
      { article: 'Art. 5', requirement: '数据处理的合法性、公平性和透明性' },
      { article: 'Art. 6', requirement: '数据处理的合法依据' },
      { article: 'Art. 7', requirement: '同意的条件' },
      { article: 'Art. 12', requirement: '信息提供的透明性' },
      { article: 'Art. 13-14', requirement: '数据收集时的信息提供' },
      { article: 'Art. 15', requirement: '数据访问权' },
      { article: 'Art. 16', requirement: '数据更正权' },
      { article: 'Art. 17', requirement: '数据删除权（被遗忘权）' },
      { article: 'Art. 18', requirement: '数据处理限制权' },
      { article: 'Art. 20', requirement: '数据可携带权' },
      { article: 'Art. 21', requirement: '反对权' },
      { article: 'Art. 25', requirement: '隐私保护设计（Privacy by Design）' },
      { article: 'Art. 32', requirement: '数据处理安全措施' },
      { article: 'Art. 33', requirement: '数据泄露通知义务' },
      { article: 'Art. 35', requirement: '数据保护影响评估（DPIA）' },
      { article: 'Art. 37', requirement: '数据保护官（DPO）指定' }
    ];

    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      for (const check of gdprChecks) {
        await client.query(`
          INSERT INTO dpia_compliance_checks 
            (assessment_id, regulation, article_reference, requirement)
          VALUES ($1, $2, $3, $4)
        `, [assessmentId, 'GDPR', check.article, check.requirement]);
      }

      await client.query('COMMIT');
      return gdprChecks.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 生成 DPIA 报告
   */
  async generateReport(assessmentId) {
    const assessment = await this.getAssessment(assessmentId);
    const responses = await this.getResponses(assessmentId);
    const risks = await this.getRiskRegister(assessmentId);
    const compliance = await this.getComplianceChecks(assessmentId);

    return {
      metadata: {
        reportId: `DPIA-REPORT-${assessmentId}`,
        generatedAt: new Date().toISOString(),
        assessment: {
          id: assessment.assessment_id,
          title: assessment.title,
          description: assessment.description,
          assessor: assessment.assessor_id,
          riskLevel: assessment.risk_level,
          overallScore: assessment.overall_score,
          status: assessment.status
        }
      },
      executiveSummary: {
        overallRiskLevel: assessment.risk_level,
        riskScore: assessment.overall_score,
        keyRisks: risks.filter(r => r.inherent_risk_score > 10).map(r => ({
          id: r.risk_id,
          description: r.risk_description,
          score: r.inherent_risk_score,
          status: r.mitigation_status
        })),
        recommendation: this.getRecommendation(assessment.risk_level, assessment.overall_score)
      },
      dataProcessingOverview: {
        dataTypes: this.extractDataTypes(responses),
        legalBasis: this.extractLegalBasis(responses),
        purposes: this.extractPurposes(responses),
        retentionPeriod: this.extractRetentionPeriod(responses),
        crossBorderTransfer: this.extractCrossBorderTransfer(responses)
      },
      riskAssessment: {
        methodology: '基于GDPR第35条要求的标准化风险评分模型',
        riskCategories: this.groupRisksByCategory(risks),
        mitigationMeasures: this.extractMitigationMeasures(responses)
      },
      complianceStatus: {
        gdpr: this.summarizeCompliance(compliance, 'GDPR'),
        overallCompliance: this.calculateOverallCompliance(compliance)
      },
      conclusion: {
        canProceed: assessment.risk_level !== 'critical',
        conditions: assessment.risk_level === 'high' ? 
          ['需要实施额外安全措施', '需要定期复审'] : [],
        nextReviewDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
      }
    };
  }

  /**
   * 辅助方法
   */
  async getAssessment(assessmentId) {
    const result = await this.db.query(
      'SELECT * FROM dpia_assessments WHERE assessment_id = $1',
      [assessmentId]
    );
    return result.rows[0];
  }

  async getResponses(assessmentId) {
    const result = await this.db.query(
      'SELECT * FROM dpia_responses WHERE assessment_id = $1',
      [assessmentId]
    );
    return result.rows;
  }

  async getRiskRegister(assessmentId) {
    const result = await this.db.query(
      'SELECT * FROM dpia_risk_register WHERE assessment_id = $1',
      [assessmentId]
    );
    return result.rows;
  }

  async getComplianceChecks(assessmentId) {
    const result = await this.db.query(
      'SELECT * FROM dpia_compliance_checks WHERE assessment_id = $1',
      [assessmentId]
    );
    return result.rows;
  }

  async logAction(assessmentId, action, actorId, oldValues, newValues) {
    await this.db.query(`
      INSERT INTO dpia_audit_log (assessment_id, action, actor_id, old_values, new_values)
      VALUES ($1, $2, $3, $4, $5)
    `, [assessmentId, action, actorId, oldValues, newValues]);
  }

  getRecommendation(riskLevel, score) {
    if (riskLevel === 'low') {
      return '数据处理活动风险较低，可正常进行，建议定期复审。';
    } else if (riskLevel === 'medium') {
      return '数据处理活动存在中等风险，建议实施额外安全措施后再进行。';
    } else if (riskLevel === 'high') {
      return '数据处理活动存在较高风险，必须实施全面的安全措施和缓解计划，并咨询数据保护官。';
    } else {
      return '数据处理活动存在严重风险，在未实施充分安全措施前不得进行。';
    }
  }

  extractDataTypes(responses) {
    const response = responses.find(r => r.question_id === 'Q1.1');
    if (!response) return [];
    try {
      return JSON.parse(response.answer);
    } catch {
      return [response.answer];
    }
  }

  extractLegalBasis(responses) {
    const response = responses.find(r => r.question_id === 'Q1.2');
    if (!response) return [];
    try {
      return JSON.parse(response.answer);
    } catch {
      return [response.answer];
    }
  }

  extractPurposes(responses) {
    const response = responses.find(r => r.question_id === 'Q2.1');
    if (!response) return [];
    try {
      return JSON.parse(response.answer);
    } catch {
      return [response.answer];
    }
  }

  extractRetentionPeriod(responses) {
    const response = responses.find(r => r.question_id === 'Q2.2');
    return response ? response.answer : '未指定';
  }

  extractCrossBorderTransfer(responses) {
    const response = responses.find(r => r.question_id === 'Q2.3');
    return response ? response.answer : '否';
  }

  groupRisksByCategory(risks) {
    const groups = {};
    risks.forEach(risk => {
      if (!groups[risk.risk_id.split('.')[0]]) {
        groups[risk.risk_id.split('.')[0]] = [];
      }
      groups[risk.risk_id.split('.')[0]].push({
        id: risk.risk_id,
        description: risk.risk_description,
        likelihood: risk.likelihood,
        impact: risk.impact,
        inherentScore: risk.inherent_risk_score,
        residualScore: risk.residual_risk_score,
        mitigationStatus: risk.mitigation_status
      });
    });
    return groups;
  }

  extractMitigationMeasures(responses) {
    return responses
      .filter(r => r.mitigation_measures)
      .map(r => ({
        questionId: r.question_id,
        measure: r.mitigation_measures
      }));
  }

  summarizeCompliance(checks, regulation) {
    const regChecks = checks.filter(c => c.regulation === regulation);
    const summary = {
      total: regChecks.length,
      compliant: regChecks.filter(c => c.compliance_status === 'compliant').length,
      partial: regChecks.filter(c => c.compliance_status === 'partial').length,
      nonCompliant: regChecks.filter(c => c.compliance_status === 'non_compliant').length,
      notApplicable: regChecks.filter(c => c.compliance_status === 'not_applicable').length
    };
    summary.percentage = Math.round((summary.compliant / summary.total) * 100);
    return summary;
  }

  calculateOverallCompliance(checks) {
    const compliant = checks.filter(c => c.compliance_status === 'compliant').length;
    const partial = checks.filter(c => c.compliance_status === 'partial').length;
    const nonCompliant = checks.filter(c => c.compliance_status === 'non_compliant').length;
    const relevant = checks.length - checks.filter(c => c.compliance_status === 'not_applicable').length;
    
    if (relevant === 0) return 100;
    
    // 完全合规权重1，部分合规权重0.5
    const score = (compliant * 1 + partial * 0.5) / relevant * 100;
    return Math.round(score);
  }
}

module.exports = DPIAService;
```

### 3. API 路由设计

```javascript
// backend/services/user-service/src/routes/dpia.js

const express = require('express');
const router = express.Router();
const DPIAService = require('../../../shared/DPIAService');
const auth = require('../../../shared/auth');
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');

const dpiaService = new DPIAService(db, redis);

// 创建新的 DPIA 评估
router.post('/assessments', auth.authenticate, async (req, res) => {
  try {
    const assessment = await dpiaService.createAssessment({
      title: req.body.title,
      description: req.body.description,
      featureId: req.body.featureId,
      assessorId: req.user.id,
      metadata: req.body.metadata
    });

    // 自动生成合规检查清单
    await dpiaService.generateComplianceChecklist(assessment.assessment_id);

    res.status(201).json(assessment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取评估问卷模板
router.get('/questionnaire', auth.authenticate, async (req, res) => {
  try {
    const template = await dpiaService.getQuestionnaireTemplate();
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 提交评估答案
router.post('/assessments/:id/responses', auth.authenticate, async (req, res) => {
  try {
    const result = await dpiaService.submitResponses(
      req.params.id,
      req.body.responses,
      req.user.id
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取评估详情
router.get('/assessments/:id', auth.authenticate, async (req, res) => {
  try {
    const assessment = await dpiaService.getAssessment(req.params.id);
    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const responses = await dpiaService.getResponses(req.params.id);
    const risks = await dpiaService.getRiskRegister(req.params.id);
    const compliance = await dpiaService.getComplianceChecks(req.params.id);

    res.json({
      assessment,
      responses,
      risks,
      compliance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新合规检查状态
router.patch('/assessments/:id/compliance/:checkId', auth.authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE dpia_compliance_checks 
      SET compliance_status = $1, evidence = $2, remediation_plan = $3, updated_at = $4
      WHERE id = $5 AND assessment_id = $6
      RETURNING *
    `, [
      req.body.status,
      req.body.evidence,
      req.body.remediationPlan,
      new Date(),
      req.params.checkId,
      req.params.id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Compliance check not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 审批评估
router.post('/assessments/:id/approve', auth.authenticate, auth.requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE dpia_assessments 
      SET status = 'approved', approved_at = $1, approved_by = $2, updated_at = $3
      WHERE assessment_id = $4
      RETURNING *
    `, [new Date(), req.user.id, new Date(), req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    await dpiaService.logAction(req.params.id, 'approved', req.user.id, null, { approvedAt: new Date() });

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 生成 DPIA 报告
router.get('/assessments/:id/report', auth.authenticate, async (req, res) => {
  try {
    const report = await dpiaService.generateReport(req.params.id);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 导出 PDF 报告
router.get('/assessments/:id/report/pdf', auth.authenticate, async (req, res) => {
  try {
    const report = await dpiaService.generateReport(req.params.id);
    
    // 使用 PDF 生成库（如 PDFKit）生成 PDF
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="DPIA-${req.params.id}.pdf"`);
    
    doc.pipe(res);
    
    // 报告标题
    doc.fontSize(24).text('Data Protection Impact Assessment Report', { align: 'center' });
    doc.moveDown();
    
    // 元数据
    doc.fontSize(12)
       .text(`Report ID: ${report.metadata.reportId}`)
       .text(`Generated: ${report.metadata.generatedAt}`)
       .text(`Assessment: ${report.metadata.assessment.title}`)
       .text(`Risk Level: ${report.metadata.assessment.riskLevel.toUpperCase()}`)
       .text(`Risk Score: ${report.metadata.assessment.overallScore}/100`);
    
    doc.moveDown();
    doc.fontSize(14).text('Executive Summary', { underline: true });
    doc.fontSize(12).text(report.executiveSummary.recommendation);
    
    doc.moveDown();
    doc.fontSize(14).text('Conclusion', { underline: true });
    doc.fontSize(12)
       .text(`Can Proceed: ${report.conclusion.canProceed ? 'Yes' : 'No'}`)
       .text(`Next Review: ${report.conclusion.nextReviewDate}`);
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 列出评估记录
router.get('/assessments', auth.authenticate, async (req, res) => {
  try {
    const { status, riskLevel, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = 'SELECT * FROM dpia_assessments WHERE 1=1';
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    
    if (riskLevel) {
      params.push(riskLevel);
      query += ` AND risk_level = $${params.length}`;
    }
    
    params.push(limit, offset);
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    
    const result = await db.query(query, params);
    
    // 获取总数
    const countResult = await db.query('SELECT COUNT(*) FROM dpia_assessments');
    
    res.json({
      assessments: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 4. 定期审查定时任务

```javascript
// backend/jobs/dpia-review-checker.js

const cron = require('node-cron');
const db = require('../shared/db');
const NotificationService = require('../shared/NotificationService');

class DPIAReviewChecker {
  constructor() {
    this.notificationService = new NotificationService();
  }

  start() {
    // 每天凌晨 2 点检查即将过期的评估
    cron.schedule('0 2 * * *', async () => {
      await this.checkExpiringAssessments();
    });

    // 每周一检查需要复审的评估
    cron.schedule('0 3 * * 1', async () => {
      await this.checkPendingReviews();
    });
  }

  async checkExpiringAssessments() {
    // 查找30天内即将过期的评估
    const result = await db.query(`
      SELECT * FROM dpia_assessments 
      WHERE status = 'approved' 
      AND expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM dpia_audit_log 
        WHERE assessment_id = dpia_assessments.assessment_id 
        AND action = 'expiry_warning_sent'
        AND created_at > NOW() - INTERVAL '7 days'
      )
    `);

    for (const assessment of result.rows) {
      const daysUntilExpiry = Math.ceil(
        (new Date(assessment.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
      );

      // 发送通知给评估者和管理员
      await this.notificationService.send({
        type: 'dpia_expiry_warning',
        recipientId: assessment.assessor_id,
        data: {
          assessmentId: assessment.assessment_id,
          title: assessment.title,
          daysUntilExpiry,
          expiresAt: assessment.expires_at
        }
      });

      // 记录已发送警告
      await db.query(`
        INSERT INTO dpia_audit_log (assessment_id, action, actor_id, new_values)
        VALUES ($1, 'expiry_warning_sent', 0, $2)
      `, [assessment.assessment_id, { daysUntilExpiry }]);
    }

    console.log(`[DPIA Review Checker] Sent expiry warnings for ${result.rows.length} assessments`);
  }

  async checkPendingReviews() {
    // 查找高风险评估（需要更频繁复审）
    const result = await db.query(`
      SELECT * FROM dpia_assessments 
      WHERE status = 'approved' 
      AND risk_level IN ('high', 'critical')
      AND approved_at < NOW() - INTERVAL '6 months'
      AND NOT EXISTS (
        SELECT 1 FROM dpia_audit_log 
        WHERE assessment_id = dpia_assessments.assessment_id 
        AND action = 'review_reminder_sent'
        AND created_at > NOW() - INTERVAL '30 days'
      )
    `);

    for (const assessment of result.rows) {
      await this.notificationService.send({
        type: 'dpia_review_required',
        recipientId: assessment.assessor_id,
        data: {
          assessmentId: assessment.assessment_id,
          title: assessment.title,
          riskLevel: assessment.risk_level,
          lastApproved: assessment.approved_at
        }
      });

      await db.query(`
        INSERT INTO dpia_audit_log (assessment_id, action, actor_id, new_values)
        VALUES ($1, 'review_reminder_sent', 0, $2)
      `, [assessment.assessment_id, { reason: 'high_risk_periodic_review' }]);
    }

    console.log(`[DPIA Review Checker] Sent review reminders for ${result.rows.length} assessments`);
  }
}

module.exports = DPIAReviewChecker;
```

### 5. 管理后台集成

```javascript
// admin-dashboard/src/pages/DPIAManagement.jsx

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import './DPIAManagement.css';

const DPIAManagement = () => {
  const { id } = useParams();
  const [assessments, setAssessments] = useState([]);
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [questionnaire, setQuestionnaire] = useState(null);
  const [responses, setResponses] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAssessments();
    loadQuestionnaire();
  }, []);

  const loadAssessments = async () => {
    try {
      const res = await fetch('/api/dpia/assessments', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setAssessments(data.assessments);
    } catch (error) {
      console.error('Failed to load assessments:', error);
    }
  };

  const loadQuestionnaire = async () => {
    try {
      const res = await fetch('/api/dpia/questionnaire', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setQuestionnaire(data);
      setLoading(false);
    } catch (error) {
      console.error('Failed to load questionnaire:', error);
    }
  };

  const handleCreateAssessment = async (data) => {
    try {
      const res = await fetch('/api/dpia/assessments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(data)
      });
      const assessment = await res.json();
      setAssessments([assessment, ...assessments]);
      return assessment;
    } catch (error) {
      console.error('Failed to create assessment:', error);
      throw error;
    }
  };

  const handleSubmitResponses = async (assessmentId, responses) => {
    try {
      const res = await fetch(`/api/dpia/assessments/${assessmentId}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ responses })
      });
      const result = await res.json();
      loadAssessments();
      return result;
    } catch (error) {
      console.error('Failed to submit responses:', error);
      throw error;
    }
  };

  const handleApprove = async (assessmentId) => {
    try {
      const res = await fetch(`/api/dpia/assessments/${assessmentId}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const result = await res.json();
      loadAssessments();
      return result;
    } catch (error) {
      console.error('Failed to approve assessment:', error);
      throw error;
    }
  };

  const handleExportReport = async (assessmentId) => {
    window.open(`/api/dpia/assessments/${assessmentId}/report/pdf?token=${localStorage.getItem('token')}`);
  };

  if (loading) {
    return <div className="loading">Loading DPIA Management...</div>;
  }

  return (
    <div className="dpia-management">
      <header className="dpia-header">
        <h1>Data Protection Impact Assessment</h1>
        <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
          + New Assessment
        </button>
      </header>

      <div className="dpia-stats">
        <div className="stat-card">
          <h3>Total</h3>
          <span className="stat-number">{assessments.length}</span>
        </div>
        <div className="stat-card">
          <h3>Pending Review</h3>
          <span className="stat-number">
            {assessments.filter(a => a.status === 'in_review').length}
          </span>
        </div>
        <div className="stat-card">
          <h3>High Risk</h3>
          <span className="stat-number risk-high">
            {assessments.filter(a => a.risk_level === 'high' || a.risk_level === 'critical').length}
          </span>
        </div>
      </div>

      <div className="dpia-list">
        {assessments.map(assessment => (
          <div key={assessment.assessment_id} className="assessment-card">
            <div className="assessment-header">
              <span className="assessment-id">{assessment.assessment_id}</span>
              <span className={`risk-badge ${assessment.risk_level || 'pending'}`}>
                {assessment.risk_level || 'Pending'}
              </span>
            </div>
            <h3>{assessment.title}</h3>
            <p>{assessment.description}</p>
            <div className="assessment-footer">
              <span className="status">{assessment.status}</span>
              <span className="date">{new Date(assessment.created_at).toLocaleDateString()}</span>
            </div>
            <div className="assessment-actions">
              <button onClick={() => setSelectedAssessment(assessment)}>View</button>
              {assessment.status === 'in_review' && (
                <button onClick={() => handleApprove(assessment.assessment_id)}>Approve</button>
              )}
              <button onClick={() => handleExportReport(assessment.assessment_id)}>Export PDF</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DPIAManagement;
```

## 验收标准

- [ ] DPIA 评估创建功能正常，自动生成唯一评估编号
- [ ] 评估问卷模板包含至少 5 个类别，每个类别至少 3 个问题
- [ ] 风险评分算法正确计算，归一化到 0-100 范围
- [ ] 风险等级自动判定准确（low/medium/high/critical）
- [ ] GDPR 合规检查清单自动生成（至少 16 条检查项）
- [ ] DPIA 报告生成功能正常，包含执行摘要、风险评估、合规状态
- [ ] PDF 导出功能正常，报告格式清晰易读
- [ ] 定时任务正确检查即将过期评估并发送通知
- [ ] 定时任务正确提醒高风险评估复审
- [ ] 审计日志完整记录所有评估操作
- [ ] API 端点都有适当的权限控制
- [ ] 管理后台界面正确显示评估列表和统计信息
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 文档完整，包含所有端点和示例

## 影响范围

- 新增文件：
  - `backend/shared/DPIAService.js`
  - `backend/services/user-service/src/routes/dpia.js`
  - `backend/jobs/dpia-review-checker.js`
  - `admin-dashboard/src/pages/DPIAManagement.jsx`
  - `admin-dashboard/src/pages/DPIAManagement.css`
  - `database/migrations/20260614_dpia_system.sql`

- 修改文件：
  - `backend/services/user-service/src/index.js` - 挂载 DPIA 路由
  - `backend/jobs/index.js` - 启动 DPIA 定时任务
  - `admin-dashboard/src/App.jsx` - 添加 DPIA 管理路由

## 参考

- [GDPR Article 35 - Impact Assessment](https://gdpr.eu/article-35-impact-assessment/)
- [ICO - Data Protection Impact Assessments](https://ico.org.uk/for-organisations/guide-to-data-protection/guide-to-the-general-data-protection-regulation-gdpr/accountability-and-governance/data-protection-impact-assessments/)
- [CNIL - PIA Tool](https://www.cnil.fr/en/privacy-impact-assessment-pia)
