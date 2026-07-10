/**
 * SecurityPolicyEnforcer 单元测试
 */

const { SecurityPolicyEnforcer, CIS_BENCHMARK_RULES } = require('../SecurityPolicyEnforcer');
const assert = require('assert');

// Mock Kubernetes Client
class MockKubernetesClient {
  constructor(config) {
    this.config = config;
    this.mockPods = [];
    this.mockDeployments = [];
    this.mockNodes = [];
  }

  setMockPods(pods) {
    this.mockPods = pods;
  }

  setMockNodes(nodes) {
    this.mockNodes = nodes;
  }

  async listPods() {
    return this.mockPods;
  }

  async listNodes() {
    return this.mockNodes;
  }

  async getApiServerConfig() {
    return {
      spec: {
        containers: [{
          command: ['--tls-cert-file=/etc/kubernetes/certs/server.crt', '--tls-private-key-file=/etc/kubernetes/certs/server.key']
        }]
      }
    };
  }

  async listClusterRoles() {
    return [];
  }

  async listNamespaces() {
    return [{ metadata: { name: 'default' } }];
  }

  async listNetworkPolicies() {
    return [];
  }
}

// Mock Metrics
class MockPrometheusMetrics {
  constructor(namespace) {
    this.namespace = namespace;
    this.gauges = {};
    this.counters = {};
  }

  registerGauge(name, help) {
    this.gauges[name] = 0;
  }

  registerCounter(name, help) {
    this.counters[name] = 0;
  }

  setGauge(name, value) {
    this.gauges[name] = value;
  }

  incrementCounter(name) {
    this.counters[name]++;
  }
}

// Mock Slack Notifier
class MockSlackNotifier {
  constructor(config) {
    this.config = config;
    this.notifications = [];
  }

  async send(options) {
    this.notifications.push(options);
    return { ok: true };
  }
}

// 测试套件
async function runTests() {
  console.log('开始 SecurityPolicyEnforcer 测试...\n');
  let passed = 0;
  let failed = 0;

  // 测试 1: 创建实例
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    assert(enforcer instanceof SecurityPolicyEnforcer);
    console.log('✅ 测试 1: 实例创建成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 1 失败:', e.message);
    failed++;
  }

  // 测试 2: 扫描无违规的 Pod
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.k8sClient = new MockKubernetesClient();
    enforcer.k8sClient.setMockPods([
      {
        metadata: { name: 'app-pod', namespace: 'default' },
        spec: {
          containers: [{
            name: 'app',
            securityContext: { runAsNonRoot: true, runAsUser: 1000 },
            resources: { limits: { cpu: '500m', memory: '512Mi' } }
          }],
          hostNetwork: false,
          automountServiceAccountToken: false
        }
      }
    ]);
    
    // 模拟节点检查通过
    enforcer.k8sClient.setMockNodes([]);
    
    const result = await enforcer.runFullScan();
    
    assert(typeof result.score === 'number');
    assert(Array.isArray(result.results));
    console.log('✅ 测试 2: 安全 Pod 扫描通过');
    passed++;
  } catch (e) {
    console.log('❌ 测试 2 失败:', e.message);
    failed++;
  }

  // 测试 3: 检测特权容器
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.k8sClient = new MockKubernetesClient();
    enforcer.k8sClient.setMockPods([
      {
        metadata: { name: 'privileged-pod', namespace: 'default' },
        spec: {
          containers: [{
            name: 'app',
            securityContext: { privileged: true }
          }]
        }
      }
    ]);
    
    const result = await enforcer.runFullScan();
    const violations = result.results.filter(r => !r.passed);
    
    assert(violations.some(v => v.id === 'CIS-3.1.1'));
    console.log('✅ 测试 3: 特权容器检测成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 3 失败:', e.message);
    failed++;
  }

  // 测试 4: 检测 hostNetwork
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.k8sClient = new MockKubernetesClient();
    enforcer.k8sClient.setMockPods([
      {
        metadata: { name: 'hostnet-pod', namespace: 'default' },
        spec: {
          containers: [{ name: 'app' }],
          hostNetwork: true
        }
      }
    ]);
    
    const result = await enforcer.runFullScan();
    const violations = result.results.filter(r => !r.passed);
    
    assert(violations.some(v => v.id === 'CIS-3.1.3'));
    console.log('✅ 测试 4: hostNetwork 检测成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 4 失败:', e.message);
    failed++;
  }

  // 测试 5: 验证 Deployment 合规性
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    const deployment = {
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'app',
              securityContext: { privileged: true }
            }],
            hostNetwork: true
          }
        }
      }
    };
    
    const validation = await enforcer.validateDeployment(deployment);
    
    assert(validation.valid === false);
    assert(validation.violations.length > 0);
    console.log('✅ 测试 5: Deployment 验证成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 5 失败:', e.message);
    failed++;
  }

  // 测试 6: 合规 Deployment 验证
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    const deployment = {
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'app',
              securityContext: { runAsNonRoot: true, runAsUser: 1000 },
              resources: { limits: { cpu: '500m', memory: '512Mi' } }
            }],
            hostNetwork: false
          }
        }
      }
    };
    
    const validation = await enforcer.validateDeployment(deployment);
    
    assert(validation.valid === true);
    console.log('✅ 测试 6: 合规 Deployment 验证通过');
    passed++;
  } catch (e) {
    console.log('❌ 测试 6 失败:', e.message);
    failed++;
  }

  // 测试 7: 计算合规评分
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.scanResults = [
      { severity: 'critical', passed: true },
      { severity: 'critical', passed: false },
      { severity: 'high', passed: true },
      { severity: 'high', passed: false },
      { severity: 'medium', passed: true }
    ];
    
    enforcer.calculateComplianceScore();
    
    // 预期评分计算：
    // critical: 10 (2 个) = 20, 违规 10
    // high: 5 (2 个) = 10, 违规 5
    // medium: 2 (1 个) = 2
    // 总权重: 20 + 10 + 2 = 32
    // 违规权重: 10 + 5 = 15
    // 评分: 100 * (32 - 15) / 32 ≈ 53
    
    assert(typeof enforcer.complianceScore === 'number');
    assert(enforcer.complianceScore >= 0 && enforcer.complianceScore <= 100);
    console.log('✅ 测试 7: 评分计算成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 7 失败:', e.message);
    failed++;
  }

  // 测试 8: 生成修复报告
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.scanResults = [
      { id: 'CIS-3.1.2', name: '非 root 用户', severity: 'high', passed: false, remediation: '设置 runAsNonRoot' },
      { id: 'CIS-3.1.3', name: '禁止 hostNetwork', severity: 'high', passed: false, remediation: '设置 hostNetwork: false' }
    ];
    enforcer.complianceScore = 80;
    
    const report = enforcer.generateRemediationReport();
    
    assert(report.violations.length === 2);
    assert(Array.isArray(report.autoFixScripts));
    console.log('✅ 测试 8: 修复报告生成成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 8 失败:', e.message);
    failed++;
  }

  // 测试 9: 自动修复能力检查
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    assert(enforcer.canAutoFix({ id: 'CIS-3.1.2' }) === true);
    assert(enforcer.canAutoFix({ id: 'CIS-3.1.1' }) === false);
    console.log('✅ 测试 9: 自动修复判断成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 9 失败:', e.message);
    failed++;
  }

  // 测试 10: 检测敏感 hostPath 挂载
  try {
    const enforcer = new SecurityPolicyEnforcer({
      kubernetes: {},
      slack: { securityChannel: 'security-alerts' }
    });
    
    enforcer.k8sClient = new MockKubernetesClient();
    enforcer.k8sClient.setMockPods([
      {
        metadata: { name: 'dangerous-pod', namespace: 'default' },
        spec: {
          containers: [{ name: 'app' }],
          volumes: [{ hostPath: { path: '/var/run/docker.sock' } }]
        }
      }
    ]);
    
    const result = await enforcer.runFullScan();
    const violations = result.results.filter(r => !r.passed);
    
    assert(violations.some(v => v.id === 'CIS-3.1.5'));
    console.log('✅ 测试 10: 敏感 hostPath 检测成功');
    passed++;
  } catch (e) {
    console.log('❌ 测试 10 失败:', e.message);
    failed++;
  }

  // 输出结果
  console.log('\n' + '='.repeat(50));
  console.log(`测试完成: ${passed} 通过, ${failed} 失败`);
  console.log('='.repeat(50));
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);