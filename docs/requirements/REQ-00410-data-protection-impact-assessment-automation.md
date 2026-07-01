# REQ-00410: 数据隐私影响评估（DPIA）自动化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00410 |
| 标题 | 数据隐私影响评估（DPIA）自动化系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、backend/shared |
| 创建时间 | 2026-07-01 12:00 UTC |

## 需求描述

### 背景
GDPR 第 35 条要求在开展高风险数据处理活动前进行数据保护影响评估（Data Protection Impact Assessment，DPIA）。当前项目缺乏系统化的 DPIA 流程，导致：
- 隐私风险评估依赖人工判断，效率低下
- 评估标准不统一，缺乏一致性
- 评估结果难以追踪和审计
- 无法及时发现和缓解高风险处理活动

### 目标
构建自动化的 DPIA 系统，实现：
1. **风险识别自动化**：基于数据处理特征自动识别高风险场景
2. **评估问卷智能化**：根据业务场景生成定制化评估问卷
3. **风险评分标准化**：采用标准化评分模型量化隐私风险
4. **缓解措施推荐**：基于风险类型推荐合适的缓解措施
5. **合规报告生成**：自动生成符合监管要求的 DPIA 报告

### 适用场景
- 新功能上线前的隐私影响评估
- 数据处理流程变更时的风险评估
- 定期的隐私合规审计
- 监管机构要求的 DPIA 报告提交

## 技术方案

### 1. DPIA 风险识别引擎

```javascript
// backend/shared/dpia/RiskIdentifier.js
class RiskIdentifier {
  constructor() {
    this.riskIndicators = {
      // 高风险数据类型
      sensitiveDataTypes: [
        'biometric', 'health', 'financial', 'location', 'racial',
        'political_opinion', 'religious_belief', 'sexual_orientation',
        'genetic', 'criminal_record'
      ],
      
      // 高风险处理活动
      highRiskProcessing: [
        'profiling', 'automated_decision', 'large_scale_monitoring',
        'systematic_evaluation', 'data_combination', 'innovative_technology',
        'cross_border_transfer', 'data_matching'
      ],
      
      // 高风险场景
      highRiskScenarios: [
        'minor_data', 'employee_monitoring', 'blacklist_blocking',
        'invisible_processing', 'vulnerable_data_subjects'
      ]
    };
  }

  /**
   * 分析数据处理活动，识别潜在风险
   * @param {Object} processingActivity - 数据处理活动描述
   * @returns {Object} 风险识别结果
   */
  async analyzeProcessingActivity(processingActivity) {
    const risks = {
      dataSensitivity: [],
      processingRisk: [],
      scenarioRisk: [],
      overallRiskLevel: 'low'
    };

    // 检查敏感数据类型
    for (const dataType of processingActivity.dataTypes || []) {
      if (this.riskIndicators.sensitiveDataTypes.includes(dataType)) {
        risks.dataSensitivity.push({
          type: dataType,
          severity: this.getDataSensitivitySeverity(dataType),
          gdprArticle: 'Article 9',
          description: this.getDataTypeDescription(dataType)
        });
      }
    }

    // 检查处理活动风险
    for (const activity of processingActivity.processingTypes || []) {
      if (this.riskIndicators.highRiskProcessing.includes(activity)) {
        risks.processingRisk.push({
          type: activity,
          severity: this.getProcessingSeverity(activity),
          gdprArticle: 'Article 35(3)',
          description: this.getProcessingDescription(activity)
        });
      }
    }

    // 检查高风险场景
    for (const scenario of processingActivity.scenarios || []) {
      if (this.riskIndicators.highRiskScenarios.includes(scenario)) {
        risks.scenarioRisk.push({
          type: scenario,
          severity: this.getScenarioSeverity(scenario),
          description: this.getScenarioDescription(scenario)
        });
      }
    }

    // 计算总体风险等级
    risks.overallRiskLevel = this.calculateOverallRisk(risks);
    risks.requiresDPIA = risks.overallRiskLevel !== 'low';

    return risks;
  }

  /**
   * 计算总体风险等级
   */
  calculateOverallRisk(risks) {
    const allRisks = [
      ...risks.dataSensitivity,
      ...risks.processingRisk,
      ...risks.scenarioRisk
    ];

    if (allRisks.length === 0) return 'low';

    const highCount = allRisks.filter(r => r.severity === 'high').length;
    const mediumCount = allRisks.filter(r => r.severity === 'medium').length;

    if (highCount > 0 || mediumCount >= 3) return 'high';
    if (mediumCount > 0 || allRisks.length >= 3) return 'medium';
    return 'low';
  }

  getDataTypeDescription(dataType) {
    const descriptions = {
      biometric: '生物特征数据，用于唯一识别自然人',
      health: '健康数据，涉及身体或心理健康状况',
      financial: '金融数据，涉及支付、银行账户等敏感信息',
      location: '位置数据，可用于追踪个人行踪',
      racial: '种族或族裔出身数据',
      political_opinion: '政治观点数据',
      religious_belief: '宗教或哲学信仰数据',
      sexual_orientation: '性取向或性生活数据',
      genetic: '基因数据，具有独特性和敏感性',
      criminal_record: '犯罪记录或安全措施相关数据'
    };
    return descriptions[dataType] || '敏感个人信息';
  }

  getDataSensitivitySeverity(dataType) {
    const severityMap = {
      biometric: 'high',
      health: 'high',
      genetic: 'high',
      criminal_record: 'high',
      financial: 'medium',
      location: 'medium',
      racial: 'high',
      political_opinion: 'medium',
      religious_belief: 'medium',
      sexual_orientation: 'high'
    };
    return severityMap[dataType] || 'medium';
  }

  getProcessingSeverity(processingType) {
    const severityMap = {
      profiling: 'high',
      automated_decision: 'high',
      large_scale_monitoring: 'high',
      systematic_evaluation: 'medium',
      data_combination: 'medium',
      innovative_technology: 'medium',
      cross_border_transfer: 'medium',
      data_matching: 'medium'
    };
    return severityMap[processingType] || 'medium';
  }

  getProcessingDescription(processingType) {
    const descriptions = {
      profiling: '对个人进行自动化画像和分析',
      automated_decision: '基于自动化处理做出对个人产生法律影响的决定',
      large_scale_monitoring: '大规模监控或跟踪个人活动',
      systematic_evaluation: '系统化评估个人行为、偏好或特征',
      data_combination: '组合多个数据集以获取更详细的个人信息',
      innovative_technology: '使用创新技术处理数据（如AI、区块链）',
      cross_border_transfer: '跨境数据传输，可能涉及不同法律管辖区',
      data_matching: '数据匹配和比对，可能扩大数据处理范围'
    };
    return descriptions[processingType] || '高风险数据处理活动';
  }

  getScenarioSeverity(scenario) {
    const severityMap = {
      minor_data: 'high',
      employee_monitoring: 'medium',
      blacklist_blocking: 'high',
      invisible_processing: 'high',
      vulnerable_data_subjects: 'high'
    };
    return severityMap[scenario] || 'medium';
  }

  getScenarioDescription(scenario) {
    const descriptions = {
      minor_data: '处理未成年人的个人数据',
      employee_monitoring: '员工监控或工作场所监控',
      blacklist_blocking: '黑名单或阻止服务访问机制',
      invisible_processing: '数据主体不知情的情况下处理数据',
      vulnerable_data_subjects: '处理弱势群体（如患者、难民）的数据'
    };
    return descriptions[scenario] || '高风险处理场景';
  }
}

module.exports = RiskIdentifier;
```

### 2. DPIA 评估问卷系统

```javascript
// backend/shared/dpia/AssessmentQuestionnaire.js
class AssessmentQuestionnaire {
  constructor() {
    this.questionTemplates = {
      necessity: [
        {
          id: 'necessity_1',
          question: '数据处理是否为实现特定目的所必需？',
          type: 'radio',
          options: ['必需', '部分必需', '非必需'],
          weight: 10,
          gdprArticle: 'Article 5(1)(b)'
        },
        {
          id: 'necessity_2',
          question: '数据处理方式是否符合数据最小化原则？',
          type: 'radio',
          options: ['完全符合', '部分符合', '不符合'],
          weight: 8,
          gdprArticle: 'Article 5(1)(c)'
        },
        {
          id: 'necessity_3',
          question: '数据存储期限是否合理且必要？',
          type: 'radio',
          options: ['合理', '需优化', '不合理'],
          weight: 7,
          gdprArticle: 'Article 5(1)(e)'
        }
      ],
      proportionality: [
        {
          id: 'proportionality_1',
          question: '数据处理的目的与手段是否成比例？',
          type: 'scale',
          min: 1,
          max: 5,
          weight: 9
        },
        {
          id: 'proportionality_2',
          question: '数据主体的利益、权利和自由是否得到充分考虑？',
          type: 'scale',
          min: 1,
          max: 5,
          weight: 10
        }
      ],
      dataSubjectRights: [
        {
          id: 'rights_1',
          question: '数据主体是否被告知数据处理活动？',
          type: 'radio',
          options: ['完全告知', '部分告知', '未告知'],
          weight: 10,
          gdprArticle: 'Article 13/14'
        },
        {
          id: 'rights_2',
          question: '数据主体是否可以行使访问、更正、删除等权利？',
          type: 'checkbox',
          options: ['访问权', '更正权', '删除权', '限制处理权', '可携带权', '反对权'],
          weight: 9,
          gdprArticle: 'Article 15-22'
        },
        {
          id: 'rights_3',
          question: '是否提供了反对自动化决策的机制？',
          type: 'radio',
          options: ['是', '否', '不适用'],
          weight: 8,
          gdprArticle: 'Article 22'
        }
      ],
      securityMeasures: [
        {
          id: 'security_1',
          question: '数据传输是否加密？',
          type: 'radio',
          options: ['强加密(TLS 1.3+)', '标准加密(TLS 1.2)', '弱加密', '未加密'],
          weight: 10,
          gdprArticle: 'Article 32'
        },
        {
          id: 'security_2',
          question: '数据存储是否加密？',
          type: 'radio',
          options: ['静态加密', '部分加密', '未加密'],
          weight: 10,
          gdprArticle: 'Article 32'
        },
        {
          id: 'security_3',
          question: '访问控制措施是否充分？',
          type: 'checkbox',
          options: ['身份认证', '授权控制', '审计日志', '最小权限原则', '定期权限审查'],
          weight: 9,
          gdprArticle: 'Article 32'
        },
        {
          id: 'security_4',
          question: '是否有数据泄露应急响应计划？',
          type: 'radio',
          options: ['有完整计划', '有部分计划', '无计划'],
          weight: 10,
          gdprArticle: 'Article 33/34'
        }
      ],
      thirdParty: [
        {
          id: 'third_party_1',
          question: '数据是否共享给第三方？',
          type: 'radio',
          options: ['是', '否'],
          weight: 5
        },
        {
          id: 'third_party_2',
          question: '是否有数据处理协议（DPA）？',
          type: 'radio',
          options: ['有', '部分有', '无'],
          weight: 8,
          gdprArticle: 'Article 28'
        },
        {
          id: 'third_party_3',
          question: '跨境数据传输是否有合法依据？',
          type: 'checkbox',
          options: ['充分性认定', '标准合同条款', '约束性企业规则', '特定情况下的例外'],
          weight: 9,
          gdprArticle: 'Article 45-49'
        }
      ]
    };
  }

  /**
   * 生成定制化评估问卷
   * @param {Object} riskAnalysis - 风险分析结果
   * @returns {Object} 定制化问卷
   */
  generateQuestionnaire(riskAnalysis) {
    const questionnaire = {
      sections: [],
      estimatedTime: 30,
      totalQuestions: 0,
      totalWeight: 0
    };

    // 根据风险类型选择相关问题
    const hasSensitiveData = riskAnalysis.dataSensitivity.length > 0;
    const hasProfiling = riskAnalysis.processingRisk.some(r => r.type === 'profiling');
    const hasAutomatedDecision = riskAnalysis.processingRisk.some(r => r.type === 'automated_decision');
    const hasCrossBorder = riskAnalysis.processingRisk.some(r => r.type === 'cross_border_transfer');

    // 添加必要性评估部分
    questionnaire.sections.push({
      name: 'necessity',
      title: '必要性与相称性评估',
      description: '评估数据处理的必要性和相称性',
      questions: this.questionTemplates.necessity.concat(this.questionTemplates.proportionality)
    });

    // 添加数据主体权利部分
    questionnaire.sections.push({
      name: 'dataSubjectRights',
      title: '数据主体权利保障',
      description: '评估数据主体权利的实现情况',
      questions: this.questionTemplates.dataSubjectRights
    });

    // 添加安全措施部分（高风险场景需要更详细的问题）
    const securityQuestions = [...this.questionTemplates.securityMeasures];
    if (hasSensitiveData) {
      securityQuestions.push({
        id: 'security_sensitive',
        question: '针对敏感数据是否有额外的安全措施？',
        type: 'textarea',
        weight: 8,
        gdprArticle: 'Article 9'
      });
    }
    questionnaire.sections.push({
      name: 'securityMeasures',
      title: '安全措施评估',
      description: '评估技术性和组织性安全措施',
      questions: securityQuestions
    });

    // 添加第三方相关部分（如有跨境传输）
    if (hasCrossBorder || riskAnalysis.processingRisk.length > 0) {
      questionnaire.sections.push({
        name: 'thirdParty',
        title: '第三方与跨境传输评估',
        description: '评估数据共享和跨境传输的合规性',
        questions: this.questionTemplates.thirdParty
      });
    }

    // 添加自动化决策评估部分
    if (hasAutomatedDecision || hasProfiling) {
      questionnaire.sections.push({
        name: 'automatedProcessing',
        title: '自动化决策与画像评估',
        description: 'GDPR Article 22 合规性评估',
        questions: [
          {
            id: 'auto_1',
            question: '是否有人类干预自动化决策的机制？',
            type: 'radio',
            options: ['是', '否'],
            weight: 10,
            gdprArticle: 'Article 22(3)'
          },
          {
            id: 'auto_2',
            question: '数据主体是否可以表达观点并提出异议？',
            type: 'radio',
            options: ['是', '否'],
            weight: 10,
            gdprArticle: 'Article 22(3)'
          },
          {
            id: 'auto_3',
            question: '是否有算法可解释性说明？',
            type: 'radio',
            options: ['完整说明', '部分说明', '无说明'],
            weight: 9
          },
          {
            id: 'auto_4',
            question: '是否定期检查算法的偏见和公平性？',
            type: 'radio',
            options: ['定期检查', '偶尔检查', '未检查'],
            weight: 8
          }
        ]
      });
    }

    // 计算统计信息
    for (const section of questionnaire.sections) {
      questionnaire.totalQuestions += section.questions.length;
      questionnaire.totalWeight += section.questions.reduce((sum, q) => sum + q.weight, 0);
    }
    questionnaire.estimatedTime = questionnaire.totalQuestions * 2; // 每题约2分钟

    return questionnaire;
  }

  /**
   * 计算评估得分
   * @param {Object} responses - 问卷响应
   * @returns {Object} 评估结果
   */
  calculateScore(responses) {
    const result = {
      totalScore: 0,
      maxScore: 0,
      percentage: 0,
      sections: {},
      riskLevel: 'low',
      recommendations: []
    };

    for (const [sectionId, sectionResponses] of Object.entries(responses)) {
      let sectionScore = 0;
      let sectionMaxScore = 0;

      for (const [questionId, answer] of Object.entries(sectionResponses)) {
        const question = this.findQuestion(questionId);
        if (!question) continue;

        const score = this.calculateQuestionScore(question, answer);
        sectionScore += score;
        sectionMaxScore += question.weight;

        // 识别需要改进的领域
        if (score < question.weight * 0.6) {
          result.recommendations.push({
            questionId,
            question: question.question,
            answer,
            severity: score < question.weight * 0.3 ? 'high' : 'medium',
            gdprArticle: question.gdprArticle
          });
        }
      }

      result.sections[sectionId] = {
        score: sectionScore,
        maxScore: sectionMaxScore,
        percentage: (sectionScore / sectionMaxScore * 100).toFixed(1)
      };

      result.totalScore += sectionScore;
      result.maxScore += sectionMaxScore;
    }

    result.percentage = (result.totalScore / result.maxScore * 100).toFixed(1);

    // 确定风险等级
    if (result.percentage < 50) {
      result.riskLevel = 'critical';
    } else if (result.percentage < 70) {
      result.riskLevel = 'high';
    } else if (result.percentage < 85) {
      result.riskLevel = 'medium';
    } else {
      result.riskLevel = 'low';
    }

    return result;
  }

  calculateQuestionScore(question, answer) {
    if (question.type === 'radio') {
      const scoreMap = {
        '必需': 10, '完全符合': 10, '合理': 10, '完全告知': 10, '是': 10,
        '部分必需': 6, '部分符合': 6, '需优化': 6, '部分告知': 6, '部分有': 6,
        '非必需': 0, '不符合': 0, '不合理': 0, '未告知': 0, '否': 0, '无': 0,
        '有完整计划': 10, '有部分计划': 6, '无计划': 0,
        '强加密(TLS 1.3+)': 10, '标准加密(TLS 1.2)': 8, '弱加密': 3, '未加密': 0,
        '静态加密': 10, '部分加密': 6, '未加密': 0,
        '定期检查': 10, '偶尔检查': 6, '未检查': 0,
        '完整说明': 10, '部分说明': 6, '无说明': 0,
        '不适用': 5
      };
      return (scoreMap[answer] || 0) / 10 * question.weight;
    }

    if (question.type === 'scale') {
      return (answer / question.max) * question.weight;
    }

    if (question.type === 'checkbox') {
      return (answer.length / question.options.length) * question.weight;
    }

    return 0;
  }

  findQuestion(questionId) {
    for (const section of Object.values(this.questionTemplates)) {
      const question = section.find(q => q.id === questionId);
      if (question) return question;
    }
    return null;
  }
}

module.exports = AssessmentQuestionnaire;
```

### 3. DPIA 报告生成器

```javascript
// backend/shared/dpia/ReportGenerator.js
const PDFDocument = require('pdfkit');
const fs = require('fs').promises;
const path = require('path');

class ReportGenerator {
  constructor() {
    this.templatePath = path.join(__dirname, 'templates');
  }

  /**
   * 生成 DPIA 报告
   * @param {Object} assessmentData - 评估数据
   * @returns {Buffer} PDF 报告内容
   */
  async generateReport(assessmentData) {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 60, right: 60 },
      info: {
        Title: `DPIA Report - ${assessmentData.projectName}`,
        Author: 'mineGo DPIA System',
        Subject: 'Data Protection Impact Assessment',
        CreationDate: new Date()
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    // 封面
    await this.addCoverPage(doc, assessmentData);

    // 执行摘要
    doc.addPage();
    await this.addExecutiveSummary(doc, assessmentData);

    // 1. 项目概述
    doc.addPage();
    await this.addProjectOverview(doc, assessmentData);

    // 2. 数据处理描述
    doc.addPage();
    await this.addDataProcessingDescription(doc, assessmentData);

    // 3. 风险评估
    doc.addPage();
    await this.addRiskAssessment(doc, assessmentData);

    // 4. 必要性与相称性评估
    doc.addPage();
    await this.addNecessityAssessment(doc, assessmentData);

    // 5. 风险缓解措施
    doc.addPage();
    await this.addMitigationMeasures(doc, assessmentData);

    // 6. 建议与结论
    doc.addPage();
    await this.addRecommendations(doc, assessmentData);

    // 附录
    doc.addPage();
    await this.addAppendix(doc, assessmentData);

    doc.end();

    return new Promise((resolve) => {
      doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async addCoverPage(doc, data) {
    // 标题
    doc.fontSize(28)
       .font('Helvetica-Bold')
       .text('Data Protection Impact Assessment', { align: 'center' });

    doc.moveDown();
    doc.fontSize(20)
       .text('数据隐私影响评估报告', { align: 'center' });

    doc.moveDown(2);
    doc.fontSize(16)
       .font('Helvetica')
       .text(`项目名称: ${data.projectName}`, { align: 'center' });

    doc.moveDown(0.5);
    doc.text(`评估编号: DPIA-${data.assessmentId}`, { align: 'center' });

    doc.moveDown(0.5);
    doc.text(`评估日期: ${new Date(data.assessmentDate).toLocaleDateString('zh-CN')}`, { align: 'center' });

    doc.moveDown(0.5);
    doc.text(`风险等级: ${this.getRiskLevelText(data.riskLevel)}`, { align: 'center' });

    doc.moveDown(4);
    doc.fontSize(12)
       .text('GDPR Article 35 Compliant', { align: 'center' })
       .moveDown(0.5)
       .text('Generated by mineGo DPIA Automation System', { align: 'center' });

    doc.moveDown(2);
    doc.fontSize(10)
       .text(`Document Version: ${data.version || '1.0'}`, { align: 'center' })
       .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  }

  async addExecutiveSummary(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('执行摘要 (Executive Summary)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica');

    const summary = `本数据保护影响评估（DPIA）针对"${data.projectName}"项目进行，评估编号为 DPIA-${data.assessmentId}。

评估结果显示，该项目的隐私合规得分为 ${data.score.percentage}%，风险等级为 ${this.getRiskLevelText(data.riskLevel)}。

${data.riskLevel === 'low' 
  ? '该项目在数据保护方面表现良好，主要风险已得到有效控制。' 
  : data.riskLevel === 'medium'
  ? '该项目存在中等程度的隐私风险，建议采取相应的缓解措施后实施。'
  : '该项目存在较高隐私风险，必须在采取有效缓解措施后方可实施。'}

主要发现：
${data.keyFindings.map((f, i) => `${i + 1}. ${f}`).join('\n')}

建议措施：
${data.recommendations.slice(0, 3).map((r, i) => `${i + 1}. ${r.recommendation || r.question}`).join('\n')}`;

    doc.text(summary);

    // 风险评分可视化
    doc.moveDown();
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .text('风险评分概览:');

    const scoreData = Object.entries(data.score.sections);
    let y = doc.y + 10;

    for (const [sectionName, sectionScore] of scoreData) {
      doc.fontSize(10)
         .font('Helvetica')
         .text(this.formatSectionName(sectionName), 60, y);

      // 进度条
      doc.rect(250, y, 200, 15)
         .fill('#E8E8E8');

      const progressWidth = (sectionScore.percentage / 100) * 200;
      const progressColor = sectionScore.percentage >= 85 ? '#4CAF50' 
                          : sectionScore.percentage >= 70 ? '#FFC107' 
                          : '#F44336';

      doc.rect(250, y, progressWidth, 15)
         .fill(progressColor);

      doc.fillColor('#000')
         .text(`${sectionScore.percentage}%`, 460, y);

      y += 25;
    }
  }

  async addProjectOverview(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('1. 项目概述 (Project Overview)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('1.1 项目背景');

    doc.font('Helvetica')
       .text(data.projectBackground || '（项目背景描述）');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('1.2 数据处理目的');

    doc.font('Helvetica')
       .text(data.processingPurpose || '（数据处理目的描述）');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('1.3 法律依据');

    doc.font('Helvetica')
       .text(data.legalBasis || 'GDPR Article 6(1)(f) - 合法利益');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('1.4 相关方');

    const stakeholders = data.stakeholders || [];
    const tableTop = doc.y + 10;

    doc.font('Helvetica')
       .fontSize(10);

    // 表头
    doc.rect(60, tableTop, 150, 20)
       .fill('#4472C4')
       .fillColor('#FFF')
       .text('角色', 65, tableTop + 5);

    doc.rect(210, tableTop, 150, 20)
       .fill('#4472C4')
       .text('组织', 215, tableTop + 5);

    doc.rect(360, tableTop, 140, 20)
       .fill('#4472C4')
       .text('联系方式', 365, tableTop + 5);

    // 表格内容
    doc.fillColor('#000');
    let rowY = tableTop + 20;

    for (const stakeholder of stakeholders) {
      doc.rect(60, rowY, 150, 20)
         .stroke()
         .text(stakeholder.role, 65, rowY + 5);

      doc.rect(210, rowY, 150, 20)
         .stroke()
         .text(stakeholder.organization, 215, rowY + 5);

      doc.rect(360, rowY, 140, 20)
         .stroke()
         .text(stakeholder.contact, 365, rowY + 5);

      rowY += 20;
    }
  }

  async addDataProcessingDescription(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('2. 数据处理描述 (Data Processing Description)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('2.1 数据类型');

    doc.font('Helvetica')
       .text(data.dataTypes ? data.dataTypes.join(', ') : '（数据类型列表）');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('2.2 数据主体类别');

    doc.font('Helvetica')
       .text(data.dataSubjects ? data.dataSubjects.join(', ') : '（数据主体类别）');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('2.3 数据接收方');

    doc.font('Helvetica')
       .text(data.recipients ? data.recipients.join(', ') : '（数据接收方列表）');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('2.4 数据流转图');

    doc.font('Helvetica')
       .text('（数据流转图将在此处展示）', { color: '#888' });

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('2.5 数据保留期限');

    doc.font('Helvetica')
       .text(data.retentionPeriod || '（数据保留期限说明）');
  }

  async addRiskAssessment(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('3. 风险评估 (Risk Assessment)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('3.1 识别的风险');

    const risks = data.riskAnalysis || {};

    if (risks.dataSensitivity && risks.dataSensitivity.length > 0) {
      doc.font('Helvetica-Bold')
         .text('敏感数据类型风险:');
      
      doc.font('Helvetica')
         .fontSize(10);
      
      for (const risk of risks.dataSensitivity) {
        doc.text(`• ${risk.type} - 严重程度: ${risk.severity} (${risk.description})`);
      }
      doc.fontSize(11);
    }

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('3.2 风险矩阵');

    // 简化的风险矩阵
    const matrixTop = doc.y + 10;
    doc.fontSize(9)
       .font('Helvetica');

    // 绘制风险矩阵
    const matrix = [
      ['影响/可能性', '低', '中', '高'],
      ['高', '中风险', '高风险', '极高风险'],
      ['中', '低风险', '中风险', '高风险'],
      ['低', '低风险', '低风险', '中风险']
    ];

    let matrixY = matrixTop;
    for (const row of matrix) {
      let matrixX = 150;
      for (const cell of row) {
        const color = cell.includes('极高') ? '#D32F2F'
                    : cell.includes('高') ? '#F57C00'
                    : cell.includes('中') && !cell.includes('影响') ? '#FFC107'
                    : '#E8E8E8';

        doc.rect(matrixX, matrixY, 80, 20)
           .fill(color)
           .fillColor(cell.includes('影响') || cell.includes('可能性') ? '#000' : '#FFF')
           .fontSize(8)
           .text(cell, matrixX + 5, matrixY + 7);

        matrixX += 80;
      }
      matrixY += 20;
    }

    doc.fillColor('#000').fontSize(11);
  }

  async addNecessityAssessment(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('4. 必要性与相称性评估 (Necessity & Proportionality)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica');

    const necessityText = `根据 GDPR Article 5(1)(b) 和 Article 5(1)(c)，数据处理应当：
1. 为了特定、明确和合法的目的而收集（目的限制）
2. 充足、相关且限于处理目的所必需（数据最小化）
3. 准确且在必要时保持更新（准确性）
4. 以识别数据主体的形式保存的时间不超过处理目的所必需（存储限制）

评估结论：
${data.necessityConclusion || '数据处理符合必要性原则，所收集的数据为实现处理目的所必需。'}`;

    doc.text(necessityText);
  }

  async addMitigationMeasures(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('5. 风险缓解措施 (Risk Mitigation Measures)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica');

    const measures = data.mitigationMeasures || [
      {
        category: '技术措施',
        measures: [
          '数据传输采用 TLS 1.3 加密',
          '敏感数据静态加密存储',
          '实施基于角色的访问控制',
          '定期安全审计和渗透测试'
        ]
      },
      {
        category: '组织措施',
        measures: [
          '制定数据处理政策',
          '员工隐私保护培训',
          '指定数据保护官（DPO）',
          '建立数据泄露应急响应机制'
        ]
      }
    ];

    for (const category of measures) {
      doc.font('Helvetica-Bold')
         .text(`${category.category}:`);

      doc.font('Helvetica')
         .fontSize(10);

      for (const measure of category.measures) {
        doc.text(`  • ${measure}`);
      }

      doc.fontSize(11).moveDown();
    }
  }

  async addRecommendations(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('6. 建议与结论 (Recommendations & Conclusion)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('6.1 主要建议');

    doc.font('Helvetica')
       .fontSize(10);

    const recommendations = data.recommendations || [];
    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      doc.text(`${i + 1}. ${rec.recommendation || rec.question || rec}`);
      if (rec.gdprArticle) {
        doc.text(`   参考: ${rec.gdprArticle}`);
      }
      doc.moveDown(0.5);
    }

    doc.fontSize(11).moveDown();
    doc.font('Helvetica-Bold')
       .text('6.2 实施时间表');

    doc.font('Helvetica')
       .text('建议在 30 天内完成所有 P0 级缓解措施的实施。');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .text('6.3 审查与监控');

    doc.font('Helvetica')
       .text('建议每 12 个月或在数据处理活动发生重大变更时重新评估。');

    doc.moveDown(2);
    doc.font('Helvetica-Bold')
       .fontSize(12)
       .text('结论:');

    doc.font('Helvetica')
       .fontSize(11)
       .text(data.conclusion || '在实施上述缓解措施后，该项目的隐私风险处于可接受水平。');
  }

  async addAppendix(doc, data) {
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .text('附录 (Appendix)', { underline: true });

    doc.moveDown();
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('A. 评估问卷详情');

    doc.font('Helvetica')
       .fontSize(10)
       .text('完整的评估问卷和响应记录请参见附件。');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .fontSize(11)
       .text('B. 相关法规引用');

    doc.font('Helvetica')
       .fontSize(10)
       .text('• GDPR Article 35 - 数据保护影响评估\n• GDPR Article 36 - 监管机构的事先咨询\n• GDPR Article 5 - 处理原则\n• GDPR Article 32 - 处理安全性');

    doc.moveDown();
    doc.font('Helvetica-Bold')
       .fontSize(11)
       .text('C. 文档版本历史');

    doc.font('Helvetica')
       .fontSize(10)
       .text(`版本 1.0 - ${new Date().toISOString()} - 初始创建`);
  }

  getRiskLevelText(level) {
    const levelMap = {
      low: '低风险 (Low Risk)',
      medium: '中风险 (Medium Risk)',
      high: '高风险 (High Risk)',
      critical: '极高风险 (Critical Risk)'
    };
    return levelMap[level] || level;
  }

  formatSectionName(name) {
    const nameMap = {
      necessity: '必要性与相称性',
      proportionality: '相称性评估',
      dataSubjectRights: '数据主体权利',
      securityMeasures: '安全措施',
      thirdParty: '第三方与跨境传输',
      automatedProcessing: '自动化决策与画像'
    };
    return nameMap[name] || name;
  }
}

module.exports = ReportGenerator;
```

### 4. DPIA 管理服务

```javascript
// backend/services/user-service/src/routes/dpia.js
const express = require('express');
const router = express.Router();
const RiskIdentifier = require('../../../shared/dpia/RiskIdentifier');
const AssessmentQuestionnaire = require('../../../shared/dpia/AssessmentQuestionnaire');
const ReportGenerator = require('../../../shared/dpia/ReportGenerator');
const { auth, requireRole } = require('../../../shared/auth');
const logger = require('../../../shared/logger');

const riskIdentifier = new RiskIdentifier();
const questionnaireGenerator = new AssessmentQuestionnaire();
const reportGenerator = new ReportGenerator();

/**
 * POST /api/dpia/assessments
 * 创建新的 DPIA 评估
 */
router.post('/assessments', auth, requireRole(['admin', 'dpo']), async (req, res) => {
  try {
    const { 
      projectName, 
      projectBackground, 
      processingPurpose, 
      dataTypes, 
      processingTypes, 
      scenarios 
    } = req.body;

    // 1. 风险识别
    const riskAnalysis = await riskIdentifier.analyzeProcessingActivity({
      dataTypes: dataTypes || [],
      processingTypes: processingTypes || [],
      scenarios: scenarios || []
    });

    // 2. 生成评估问卷
    const questionnaire = questionnaireGenerator.generateQuestionnaire(riskAnalysis);

    // 3. 创建评估记录
    const assessment = {
      id: `DPIA-${Date.now()}`,
      projectId: req.body.projectId,
      projectName,
      projectBackground,
      processingPurpose,
      status: 'pending',
      riskAnalysis,
      questionnaire,
      createdBy: req.user.id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // 保存到数据库
    await req.db.query(`
      INSERT INTO dpia_assessments 
      (id, project_id, project_name, project_background, processing_purpose, 
       status, risk_analysis, questionnaire, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      assessment.id,
      assessment.projectId,
      assessment.projectName,
      assessment.projectBackground,
      assessment.processingPurpose,
      assessment.status,
      JSON.stringify(assessment.riskAnalysis),
      JSON.stringify(assessment.questionnaire),
      assessment.createdBy,
      assessment.createdAt,
      assessment.updatedAt
    ]);

    logger.info('DPIA assessment created', { 
      assessmentId: assessment.id, 
      projectName,
      riskLevel: riskAnalysis.overallRiskLevel 
    });

    res.status(201).json({
      success: true,
      data: {
        assessmentId: assessment.id,
        riskLevel: riskAnalysis.overallRiskLevel,
        requiresDPIA: riskAnalysis.requiresDPIA,
        questionnaire,
        estimatedTime: questionnaire.estimatedTime
      }
    });
  } catch (error) {
    logger.error('Failed to create DPIA assessment', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create DPIA assessment' 
    });
  }
});

/**
 * POST /api/dpia/assessments/:id/responses
 * 提交评估问卷响应
 */
router.post('/assessments/:id/responses', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { responses } = req.body;

    // 获取评估记录
    const result = await req.db.query(
      'SELECT * FROM dpia_assessments WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Assessment not found' 
      });
    }

    const assessment = result.rows[0];

    // 计算评估得分
    const score = questionnaireGenerator.calculateScore(responses);

    // 更新评估记录
    await req.db.query(`
      UPDATE dpia_assessments 
      SET responses = $1, score = $2, status = $3, updated_at = $4
      WHERE id = $5
    `, [
      JSON.stringify(responses),
      JSON.stringify(score),
      'completed',
      new Date(),
      id
    ]);

    logger.info('DPIA assessment responses submitted', { 
      assessmentId: id,
      score: score.percentage,
      riskLevel: score.riskLevel
    });

    res.json({
      success: true,
      data: {
        score,
        recommendations: score.recommendations
      }
    });
  } catch (error) {
    logger.error('Failed to submit DPIA responses', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to submit responses' 
    });
  }
});

/**
 * GET /api/dpia/assessments/:id/report
 * 生成 DPIA 报告
 */
router.get('/assessments/:id/report', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // 获取评估记录
    const result = await req.db.query(
      'SELECT * FROM dpia_assessments WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Assessment not found' 
      });
    }

    const assessment = result.rows[0];

    // 准备报告数据
    const reportData = {
      assessmentId: assessment.id,
      projectName: assessment.project_name,
      projectBackground: assessment.project_background,
      processingPurpose: assessment.processing_purpose,
      assessmentDate: assessment.created_at,
      riskLevel: assessment.score?.riskLevel || 'unknown',
      riskAnalysis: assessment.risk_analysis,
      score: assessment.score,
      recommendations: assessment.score?.recommendations || [],
      keyFindings: extractKeyFindings(assessment),
      conclusion: generateConclusion(assessment)
    };

    // 生成 PDF 报告
    const pdfBuffer = await reportGenerator.generateReport(reportData);

    // 记录报告生成
    logger.info('DPIA report generated', { 
      assessmentId: id,
      projectName: assessment.project_name 
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 
      `attachment; filename="DPIA-${assessment.project_name}-${Date.now()}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Failed to generate DPIA report', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate report' 
    });
  }
});

/**
 * GET /api/dpia/dashboard
 * DPIA 仪表板数据
 */
router.get('/dashboard', auth, requireRole(['admin', 'dpo']), async (req, res) => {
  try {
    // 获取统计信息
    const stats = await req.db.query(`
      SELECT 
        COUNT(*) as total_assessments,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_assessments,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_assessments,
        COUNT(*) FILTER (WHERE (score->>'riskLevel') = 'high') as high_risk,
        COUNT(*) FILTER (WHERE (score->>'riskLevel') = 'medium') as medium_risk,
        COUNT(*) FILTER (WHERE (score->>'riskLevel') = 'low') as low_risk
      FROM dpia_assessments
    `);

    // 获取最近评估
    const recentAssessments = await req.db.query(`
      SELECT id, project_name, status, 
             score->>'percentage' as score_percentage,
             score->>'riskLevel' as risk_level,
             created_at
      FROM dpia_assessments
      ORDER BY created_at DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        stats: stats.rows[0],
        recentAssessments: recentAssessments.rows
      }
    });
  } catch (error) {
    logger.error('Failed to fetch DPIA dashboard', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard data' 
    });
  }
});

/**
 * GET /api/dpia/templates
 * 获取 DPIA 评估模板
 */
router.get('/templates', auth, async (req, res) => {
  try {
    const templates = {
      dataTypes: riskIdentifier.riskIndicators.sensitiveDataTypes.map(type => ({
        value: type,
        label: riskIdentifier.getDataTypeDescription(type),
        severity: riskIdentifier.getDataSensitivitySeverity(type)
      })),
      processingTypes: riskIdentifier.riskIndicators.highRiskProcessing.map(type => ({
        value: type,
        label: riskIdentifier.getProcessingDescription(type),
        severity: riskIdentifier.getProcessingSeverity(type)
      })),
      scenarios: riskIdentifier.riskIndicators.highRiskScenarios.map(scenario => ({
        value: scenario,
        label: riskIdentifier.getScenarioDescription(scenario),
        severity: riskIdentifier.getScenarioSeverity(scenario)
      }))
    };

    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    logger.error('Failed to fetch DPIA templates', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch templates' 
    });
  }
});

// 辅助函数
function extractKeyFindings(assessment) {
  const findings = [];
  
  if (assessment.risk_analysis?.dataSensitivity?.length > 0) {
    findings.push(`识别出 ${assessment.risk_analysis.dataSensitivity.length} 类敏感数据`);
  }
  
  if (assessment.risk_analysis?.processingRisk?.length > 0) {
    findings.push(`存在 ${assessment.risk_analysis.processingRisk.length} 种高风险处理活动`);
  }
  
  if (assessment.score?.recommendations?.length > 0) {
    findings.push(`需要改进 ${assessment.score.recommendations.length} 个合规领域`);
  }
  
  return findings;
}

function generateConclusion(assessment) {
  const riskLevel = assessment.score?.riskLevel || 'unknown';
  const percentage = assessment.score?.percentage || 0;
  
  if (percentage >= 85) {
    return '该项目的数据处理活动符合 GDPR 要求，隐私风险处于可接受水平。';
  } else if (percentage >= 70) {
    return '该项目的数据处理活动基本符合 GDPR 要求，但需要在特定领域采取改进措施。';
  } else {
    return '该项目的数据处理活动存在显著隐私风险，必须在采取有效缓解措施后方可实施。';
  }
}

module.exports = router;
```

### 5. 数据库迁移

```sql
-- database/migrations/20260701_create_dpia_tables.sql

-- DPIA 评估表
CREATE TABLE dpia_assessments (
  id VARCHAR(50) PRIMARY KEY,
  project_id VARCHAR(50),
  project_name VARCHAR(255) NOT NULL,
  project_background TEXT,
  processing_purpose TEXT,
  legal_basis VARCHAR(255),
  
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'archived')),
  
  -- 风险分析结果
  risk_analysis JSONB,
  
  -- 评估问卷
  questionnaire JSONB,
  
  -- 问卷响应
  responses JSONB,
  
  -- 评分结果
  score JSONB,
  
  -- 缓解措施
  mitigation_measures JSONB,
  
  -- 审核信息
  reviewed_by VARCHAR(50),
  reviewed_at TIMESTAMP,
  review_comments TEXT,
  
  -- 审计字段
  created_by VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- DPIA 审核历史表
CREATE TABLE dpia_review_history (
  id SERIAL PRIMARY KEY,
  assessment_id VARCHAR(50) NOT NULL,
  reviewer_id VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  comments TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (assessment_id) REFERENCES dpia_assessments(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(id)
);

-- 索引
CREATE INDEX idx_dpia_assessments_status ON dpia_assessments(status);
CREATE INDEX idx_dpia_assessments_project ON dpia_assessments(project_id);
CREATE INDEX idx_dpia_assessments_created ON dpia_assessments(created_at DESC);
CREATE INDEX idx_dpia_assessments_risk_level ON dpia_assessments((score->>'riskLevel'));

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_dpia_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_dpia_updated_at
BEFORE UPDATE ON dpia_assessments
FOR EACH ROW
EXECUTE FUNCTION update_dpia_updated_at();

-- 注释
COMMENT ON TABLE dpia_assessments IS '数据保护影响评估记录';
COMMENT ON TABLE dpia_review_history IS 'DPIA 审核历史记录';
```

### 6. Admin Dashboard 集成

```javascript
// frontend/admin-dashboard/src/pages/DPIA/DPIADashboard.jsx
import React, { useState, useEffect } from 'react';
import { 
  Card, 
  CardContent, 
  Typography, 
  Grid, 
  Button, 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableRow,
  Chip,
  LinearProgress
} from '@material-ui/core';
import { Assessment, Warning, CheckCircle, HourglassEmpty } from '@material-ui/icons';
import axios from 'axios';

const DPIADashboard = () => {
  const [stats, setStats] = useState({});
  const [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      const response = await axios.get('/api/dpia/dashboard');
      setStats(response.data.data.stats);
      setAssessments(response.data.data.recentAssessments);
    } catch (error) {
      console.error('Failed to fetch DPIA dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const getRiskColor = (level) => {
    const colors = {
      low: '#4CAF50',
      medium: '#FFC107',
      high: '#F44336',
      critical: '#9C27B0'
    };
    return colors[level] || '#9E9E9E';
  };

  const getStatusIcon = (status) => {
    const icons = {
      pending: <HourglassEmpty />,
      in_progress: <Assessment />,
      completed: <CheckCircle />
    };
    return icons[status] || <Warning />;
  };

  return (
    <div className="dpia-dashboard">
      <Typography variant="h4" gutterBottom>
        数据保护影响评估（DPIA）
      </Typography>

      <Grid container spacing={3} style={{ marginBottom: 20 }}>
        <Grid item xs={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                总评估数
              </Typography>
              <Typography variant="h3">
                {stats.total_assessments || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                待处理
              </Typography>
              <Typography variant="h3" style={{ color: '#FFC107' }}>
                {stats.pending_assessments || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                高风险
              </Typography>
              <Typography variant="h3" style={{ color: '#F44336' }}>
                {stats.high_risk || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                低风险
              </Typography>
              <Typography variant="h3" style={{ color: '#4CAF50' }}>
                {stats.low_risk || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <Typography variant="h6">
              最近评估
            </Typography>
            <Button variant="contained" color="primary" href="/dpia/new">
              新建评估
            </Button>
          </div>

          <Table>
            <TableHead>
              <TableRow>
                <TableCell>评估编号</TableCell>
                <TableCell>项目名称</TableCell>
                <TableCell>状态</TableCell>
                <TableCell>风险等级</TableCell>
                <TableCell>得分</TableCell>
                <TableCell>创建时间</TableCell>
                <TableCell>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {assessments.map((assessment) => (
                <TableRow key={assessment.id}>
                  <TableCell>{assessment.id}</TableCell>
                  <TableCell>{assessment.project_name}</TableCell>
                  <TableCell>
                    <Chip
                      icon={getStatusIcon(assessment.status)}
                      label={assessment.status}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={assessment.risk_level}
                      size="small"
                      style={{ backgroundColor: getRiskColor(assessment.risk_level), color: '#FFF' }}
                    />
                  </TableCell>
                  <TableCell>
                    {assessment.score_percentage ? (
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <LinearProgress
                          variant="determinate"
                          value={parseFloat(assessment.score_percentage)}
                          style={{ width: 100, marginRight: 10 }}
                        />
                        <span>{assessment.score_percentage}%</span>
                      </div>
                    ) : '-'}
                  </TableCell>
                  <TableCell>
                    {new Date(assessment.created_at).toLocaleDateString('zh-CN')}
                  </TableCell>
                  <TableCell>
                    <Button size="small" href={`/dpia/${assessment.id}`}>
                      查看
                    </Button>
                    {assessment.status === 'completed' && (
                      <Button size="small" href={`/api/dpia/assessments/${assessment.id}/report`}>
                        下载报告
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};

export default DPIADashboard;
```

## 验收标准

- [ ] **风险识别引擎**
  - [ ] 支持 10+ 敏感数据类型识别
  - [ ] 支持 8+ 高风险处理活动检测
  - [ ] 支持 5+ 高风险场景识别
  - [ ] 自动计算总体风险等级

- [ ] **评估问卷系统**
  - [ ] 根据风险类型动态生成问卷
  - [ ] 支持多种题型（单选、多选、量表、文本）
  - [ ] 每题关联 GDPR 法条引用
  - [ ] 自动计算评估得分和风险等级

- [ ] **报告生成功能**
  - [ ] 自动生成符合监管要求的 PDF 报告
  - [ ] 包含执行摘要、风险评估、缓解措施等完整章节
  - [ ] 支持风险评分可视化
  - [ ] 包含 GDPR 法条引用

- [ ] **管理功能**
  - [ ] 支持 DPIA 评估的完整生命周期管理
  - [ ] 提供仪表板展示统计信息
  - [ ] 支持评估模板管理
  - [ ] 支持审核历史追踪

- [ ] **合规性**
  - [ ] 符合 GDPR Article 35 要求
  - [ ] 支持 GDPR Article 36 事先咨询判断
  - [ ] 审计日志完整
  - [ ] 数据保留政策符合要求

- [ ] **性能要求**
  - [ ] 风险识别响应时间 < 500ms
  - [ ] 问卷生成时间 < 1s
  - [ ] 报告生成时间 < 5s
  - [ ] 支持并发评估

- [ ] **安全性**
  - [ ] 仅 DPO 和管理员可访问
  - [ ] 敏感数据加密存储
  - [ ] 操作审计完整
  - [ ] 报告访问权限控制

## 影响范围

### 新增文件
- `backend/shared/dpia/RiskIdentifier.js` - 风险识别引擎
- `backend/shared/dpia/AssessmentQuestionnaire.js` - 评估问卷系统
- `backend/shared/dpia/ReportGenerator.js` - 报告生成器
- `backend/services/user-service/src/routes/dpia.js` - DPIA API 路由
- `database/migrations/20260701_create_dpia_tables.sql` - 数据库迁移
- `frontend/admin-dashboard/src/pages/DPIA/DPIADashboard.jsx` - 仪表板页面
- `frontend/admin-dashboard/src/pages/DPIA/NewAssessment.jsx` - 新建评估页面
- `frontend/admin-dashboard/src/pages/DPIA/AssessmentDetail.jsx` - 评估详情页面

### 修改文件
- `backend/services/user-service/src/index.js` - 挂载 DPIA 路由
- `frontend/admin-dashboard/src/routes/index.js` - 添加 DPIA 路由
- `frontend/admin-dashboard/src/components/Sidebar.jsx` - 添加 DPIA 菜单

## 参考

- [GDPR Article 35 - Data Protection Impact Assessment](https://gdpr-info.eu/art-35-gdpr/)
- [ICO DPIA Guidance](https://ico.org.uk/for-organisations/guide-to-data-protection/guide-to-the-general-data-protection-regulation-gdpr/accountability-and-governance/data-protection-impact-assessments/)
- [EDPB Guidelines on Data Protection Impact Assessment](https://edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-data-protection-impact-assessment_en)
- [ISO 27552 - Privacy Information Management](https://www.iso.org/standard/71676.html)
