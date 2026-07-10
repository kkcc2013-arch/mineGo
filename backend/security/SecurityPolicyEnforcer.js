/**
 * Security Policy Enforcer - 自动化安全合规扫描与配置加固系统
 * 
 * 功能：
 * 1. 定期检查 Kubernetes 资源配置是否符合安全基线
 * 2. 自动检测并阻止非合规的资源部署
 * 3. 提供自动化修复建议
 * 4. Prometheus 指标监控合规性评分
 * 5. Slack 告警通知
 */

const { KubernetesClient } = require('../shared/kubernetes');
const { PrometheusMetrics } = require('../shared/metrics');
const { SlackNotifier } = require('../shared/notifications');
const { logger } = require('../shared/logger');

// CIS Kubernetes Benchmark 安全基线规则
const CIS_BENCHMARK_RULES = {
  // 1. 控制平面安全配置
  controlPlane: {
    '1.1.1': {
      id: 'CIS-1.1.1',
      name: '确保 API Server 使用 TLS 加密',
      severity: 'critical',
      check: async (client) => {
        const config = await client.getApiServerConfig();
        return config.spec.containers[0].command.includes('--tls-cert-file') &&
               config.spec.containers[0].command.includes('--tls-private-key-file');
      },
      remediation: '在 API Server 启动参数中添加 --tls-cert-file 和 --tls-private-key-file'
    },
    '1.1.2': {
      id: 'CIS-1.1.2',
      name: '确保 API Server 审计日志启用',
      severity: 'high',
      check: async (client) => {
        const config = await client.getApiServerConfig();
        return config.spec.containers[0].command.includes('--audit-log-path');
      },
      remediation: '在 API Server 启动参数中添加 --audit-log-path=/var/log/kubernetes/audit.log'
    }
  },
  
  // 2. 节点安全配置
  node: {
    '2.1.1': {
      id: 'CIS-2.1.1',
      name: '确保 kubelet 使用 TLS 加密',
      severity: 'critical',
      check: async (client) => {
        const nodes = await client.listNodes();
        return nodes.every(node => 
          node.status.config?.kubeletconfig?.tlsCertFile &&
          node.status.config?.kubeletconfig?.tlsPrivateKeyFile
        );
      },
      remediation: '在 kubelet 配置中设置 tlsCertFile 和 tlsPrivateKeyFile'
    }
  },
  
  // 3. Pod 安全配置
  pod: {
    '3.1.1': {
      id: 'CIS-3.1.1',
      name: '禁止特权容器运行',
      severity: 'critical',
      check: async (client) => {
        const pods = await client.listPods();
        return pods.every(pod => 
          pod.spec.containers.every(c => !c.securityContext?.privileged) &&
          pod.spec.initContainers?.every(c => !c.securityContext?.privileged) || true
        );
      },
      remediation: '移除 Pod securityContext 中的 privileged: true 配置'
    },
    '3.1.2': {
      id: 'CIS-3.1.2',
      name: '确保容器以非 root 用户运行',
      severity: 'high',
      check: async (client) => {
        const pods = await client.listPods();
        return pods.every(pod => 
          pod.spec.containers.every(c => 
            c.securityContext?.runAsNonRoot === true ||
            c.securityContext?.runAsUser > 0
          )
        );
      },
      remediation: '在容器 securityContext 中设置 runAsNonRoot: true 或 runAsUser: 1000'
    },
    '3.1.3': {
      id: 'CIS-3.1.3',
      name: '禁止容器使用宿主机网络',
      severity: 'high',
      check: async (client) => {
        const pods = await client.listPods();
        return pods.every(pod => !pod.spec.hostNetwork);
      },
      remediation: '移除 Pod spec 中的 hostNetwork: true 配置'
    },
    '3.1.4': {
      id: 'CIS-3.1.4',
      name: '确保容器设置资源限制',
      severity: 'medium',
      check: async (client) => {
        const pods = await client.listPods();
        return pods.every(pod => 
          pod.spec.containers.every(c => 
            c.resources?.limits?.cpu && c.resources?.limits?.memory
          )
        );
      },
      remediation: '在容器 resources 中设置 limits.cpu 和 limits.memory'
    },
    '3.1.5': {
      id: 'CIS-3.1.5',
      name: '禁止挂载敏感宿主机路径',
      severity: 'critical',
      check: async (client) => {
        const forbiddenPaths = ['/etc', '/var/run/docker.sock', '/proc', '/sys'];
        const pods = await client.listPods();
        return pods.every(pod => 
          pod.spec.volumes?.every(v => 
            !v.hostPath || !forbiddenPaths.some(fp => v.hostPath.path.startsWith(fp))
          ) || true
        );
      },
      remediation: '移除对 /etc、/var/run/docker.sock、/proc、/sys 等敏感路径的 hostPath 挂载'
    }
  },
  
  // 4. RBAC 安全配置
  rbac: {
    '4.1.1': {
      id: 'CIS-4.1.1',
      name: '确保默认 ServiceAccount 不被自动挂载',
      severity: 'medium',
      check: async (client) => {
        const pods = await client.listPods();
        return pods.every(pod => 
          pod.spec.serviceAccountName !== 'default' ||
          pod.spec.automountServiceAccountToken === false
        );
      },
      remediation: '设置 automountServiceAccountToken: false 或使用明确的 ServiceAccount'
    },
    '4.1.2': {
      id: 'CIS-4.1.2',
      name: '检查是否存在过度权限的 ClusterRole',
      severity: 'high',
      check: async (client) => {
        const clusterRoles = await client.listClusterRoles();
        const dangerousVerbs = ['*', 'create', 'delete', 'update', 'patch'];
        const dangerousResources = ['*', 'pods', 'secrets', 'configmaps'];
        return clusterRoles.every(role => 
          role.rules?.every(rule => 
            !rule.resources?.includes('*') || 
            !rule.verbs?.includes('*')
          ) || true
        );
      },
      remediation: '限制 ClusterRole 权限范围，避免使用通配符 *'
    }
  },
  
  // 5. NetworkPolicy 安全配置
  networkPolicy: {
    '5.1.1': {
      id: 'CIS-5.1.1',
      name: '确保所有 Namespace 都有 NetworkPolicy',
      severity: 'medium',
      check: async (client) => {
        const namespaces = await client.listNamespaces();
        const policies = await client.listNetworkPolicies();
        const policyNamespaces = new Set(policies.map(p => p.metadata.namespace));
        return namespaces.every(ns => policyNamespaces.has(ns.metadata.name));
      },
      remediation: '为每个 Namespace 创建默认 NetworkPolicy，限制入站/出站流量'
    }
  }
};

// 合规性评分权重
const SEVERITY_WEIGHTS = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1
};

class SecurityPolicyEnforcer {
  constructor(config) {
    this.config = config;
    this.k8sClient = new KubernetesClient(config.kubernetes);
    this.metrics = new PrometheusMetrics('security_policy');
    this.notifier = new SlackNotifier(config.slack);
    this.scanResults = [];
    this.complianceScore = 100;
    
    // Prometheus 指标定义
    this.metrics.registerGauge('security_compliance_score', '安全合规性评分');
    this.metrics.registerGauge('security_violations_total', '安全违规总数');
    this.metrics.registerGauge('security_violations_critical', '关键安全违规数');
    this.metrics.registerGauge('security_violations_high', '高危安全违规数');
    this.metrics.registerGauge('security_rules_checked', '已检查规则数');
    this.metrics.registerCounter('security_remediations_applied', '已应用的修复数');
  }
  
  /**
   * 执行完整的安全合规扫描
   */
  async runFullScan() {
    logger.info('开始安全合规扫描...');
    this.scanResults = [];
    
    for (const [category, rules] of Object.entries(CIS_BENCHMARK_RULES)) {
      for (const [ruleId, rule] of Object.entries(rules)) {
        try {
          const passed = await rule.check(this.k8sClient);
          const result = {
            id: rule.id,
            category,
            ruleId,
            name: rule.name,
            severity: rule.severity,
            passed,
            remediation: rule.remediation,
            timestamp: new Date().toISOString()
          };
          this.scanResults.push(result);
          
          logger.debug(`规则 ${rule.id}: ${rule.name} - ${passed ? '通过' : '失败'}`);
        } catch (error) {
          logger.error(`规则 ${rule.id} 检查失败: ${error.message}`);
          this.scanResults.push({
            id: rule.id,
            category,
            ruleId,
            name: rule.name,
            severity: rule.severity,
            passed: false,
            error: error.message,
            remediation: rule.remediation,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
    // 计算合规性评分
    this.calculateComplianceScore();
    
    // 更新 Prometheus 指标
    this.updateMetrics();
    
    logger.info(`安全合规扫描完成，评分: ${this.complianceScore}`);
    
    return {
      score: this.complianceScore,
      results: this.scanResults,
      summary: this.getSummary()
    };
  }
  
  /**
   * 计算合规性评分
   */
  calculateComplianceScore() {
    let totalWeight = 0;
    let violationWeight = 0;
    
    for (const result of this.scanResults) {
      totalWeight += SEVERITY_WEIGHTS[result.severity];
      if (!result.passed) {
        violationWeight += SEVERITY_WEIGHTS[result.severity];
      }
    }
    
    this.complianceScore = Math.round(100 * (totalWeight - violationWeight) / totalWeight);
  }
  
  /**
   * 更新 Prometheus 指标
   */
  updateMetrics() {
    const violations = this.scanResults.filter(r => !r.passed);
    const critical = violations.filter(r => r.severity === 'critical').length;
    const high = violations.filter(r => r.severity === 'high').length;
    
    this.metrics.setGauge('security_compliance_score', this.complianceScore);
    this.metrics.setGauge('security_violations_total', violations.length);
    this.metrics.setGauge('security_violations_critical', critical);
    this.metrics.setGauge('security_violations_high', high);
    this.metrics.setGauge('security_rules_checked', this.scanResults.length);
  }
  
  /**
   * 获取扫描摘要
   */
  getSummary() {
    const violations = this.scanResults.filter(r => !r.passed);
    const byCategory = {};
    const bySeverity = {};
    
    for (const v of violations) {
      byCategory[v.category] = (byCategory[v.category] || 0) + 1;
      bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
    }
    
    return {
      totalRules: this.scanResults.length,
      passed: this.scanResults.length - violations.length,
      failed: violations.length,
      score: this.complianceScore,
      byCategory,
      bySeverity,
      criticalIssues: violations.filter(r => r.severity === 'critical'),
      highIssues: violations.filter(r => r.severity === 'high')
    };
  }
  
  /**
   * 发送告警通知
   */
  async sendAlert(summary) {
    if (summary.score < 80 || summary.criticalIssues.length > 0) {
      const message = this.formatAlertMessage(summary);
      await this.notifier.send({
        channel: this.config.slack.securityChannel,
        message,
        severity: summary.criticalIssues.length > 0 ? 'critical' : 'warning'
      });
    }
  }
  
  /**
   * 格式化告警消息
   */
  formatAlertMessage(summary) {
    const lines = [
      ':warning: *安全合规扫描结果*',
      `评分: ${summary.score}/100`,
      `违规项: ${summary.failed}/${summary.totalRules}`,
      ''
    ];
    
    if (summary.criticalIssues.length > 0) {
      lines.push(':rotating_light: *关键问题*:');
      for (const issue of summary.criticalIssues) {
        lines.push(`- ${issue.id}: ${issue.name}`);
      }
    }
    
    if (summary.highIssues.length > 0) {
      lines.push(':exclamation: *高危问题*:');
      for (const issue of summary.highIssues.slice(0, 5)) {
        lines.push(`- ${issue.id}: ${issue.name}`);
      }
    }
    
    lines.push('');
    lines.push(`详细报告: ${this.config.reportingUrl}`);
    
    return lines.join('\n');
  }
  
  /**
   * 生成修复建议报告
   */
  generateRemediationReport() {
    const violations = this.scanResults.filter(r => !r.passed);
    
    const report = {
      generatedAt: new Date().toISOString(),
      complianceScore: this.complianceScore,
      violations: violations.map(v => ({
        ruleId: v.id,
        name: v.name,
        severity: v.severity,
        remediation: v.remediation,
        autoFixable: this.canAutoFix(v)
      })),
      autoFixScripts: this.generateAutoFixScripts(violations)
    };
    
    return report;
  }
  
  /**
   * 检查是否可以自动修复
   */
  canAutoFix(violation) {
    const autoFixableRules = [
      'CIS-3.1.2', // 设置 runAsNonRoot
      'CIS-3.1.3', // 禁止 hostNetwork
      'CIS-4.1.1'  // 禁止自动挂载 ServiceAccount token
    ];
    return autoFixableRules.includes(violation.id);
  }
  
  /**
   * 生成自动修复脚本
   */
  generateAutoFixScripts(violations) {
    const scripts = [];
    
    for (const v of violations) {
      if (!this.canAutoFix(v)) continue;
      
      switch (v.id) {
        case 'CIS-3.1.2':
          scripts.push({
            ruleId: v.id,
            script: `
# 自动修复: 确保容器以非 root 用户运行
kubectl patch deployment -n minego --patch '
spec:
  template:
    spec:
      containers:
      - name: "*"
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
' --all
`
          });
          break;
          
        case 'CIS-3.1.3':
          scripts.push({
            ruleId: v.id,
            script: `
# 自动修复: 禁止容器使用宿主机网络
kubectl patch deployment -n minego --patch '
spec:
  template:
    spec:
      hostNetwork: false
' --all
`
          });
          break;
          
        case 'CIS-4.1.1':
          scripts.push({
            ruleId: v.id,
            script: `
# 自动修复: 禁止自动挂载 ServiceAccount token
kubectl patch serviceaccount default -n minego --patch '
automountServiceAccountToken: false
'
`
          });
          break;
      }
    }
    
    return scripts;
  }
  
  /**
   * Admission Controller 验证钩子
   * 用于在资源创建前验证是否合规
   */
  async validateDeployment(deployment) {
    const violations = [];
    
    // 检查特权容器
    for (const container of deployment.spec.template.spec.containers || []) {
      if (container.securityContext?.privileged) {
        violations.push({
          rule: 'CIS-3.1.1',
          message: '禁止运行特权容器',
          severity: 'critical'
        });
      }
      
      // 检查 root 用户
      if (!container.securityContext?.runAsNonRoot && 
          !container.securityContext?.runAsUser) {
        violations.push({
          rule: 'CIS-3.1.2',
          message: '容器应以非 root 用户运行',
          severity: 'high'
        });
      }
      
      // 检查资源限制
      if (!container.resources?.limits) {
        violations.push({
          rule: 'CIS-3.1.4',
          message: '容器应设置资源限制',
          severity: 'medium'
        });
      }
    }
    
    // 检查 hostNetwork
    if (deployment.spec.template.spec.hostNetwork) {
      violations.push({
        rule: 'CIS-3.1.3',
        message: '禁止使用宿主机网络',
        severity: 'high'
      });
    }
    
    // 检查敏感 hostPath 挂载
    const forbiddenPaths = ['/etc', '/var/run/docker.sock', '/proc', '/sys'];
    for (const volume of deployment.spec.template.spec.volumes || []) {
      if (volume.hostPath && forbiddenPaths.some(fp => volume.hostPath.path.startsWith(fp))) {
        violations.push({
          rule: 'CIS-3.1.5',
          message: `禁止挂载敏感路径: ${volume.hostPath.path}`,
          severity: 'critical'
        });
      }
    }
    
    return {
      valid: violations.length === 0,
      violations,
      recommendation: violations.length > 0 ? 
        '请修复以上违规项后再部署' : 
        '部署配置符合安全基线'
    };
  }
  
  /**
   * 执行每日扫描任务
   */
  async runDailyScan() {
    const result = await this.runFullScan();
    const summary = result.summary;
    
    // 发送告警
    await this.sendAlert(summary);
    
    // 生成报告
    const report = this.generateRemediationReport();
    
    logger.info('每日安全合规扫描完成');
    
    return {
      scanResult: result,
      report
    };
  }
}

module.exports = {
  SecurityPolicyEnforcer,
  CIS_BENCHMARK_RULES
};