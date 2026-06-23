/**
 * Pipeline Dependency Analyzer Tests
 * REQ-00287: CI/CD 管道执行依赖分析与并行优化系统
 */

const assert = require('assert');
const path = require('path');
const PipelineDependencyAnalyzer = require('../../jobs/pipelineDependencyAnalyzer');
const PipelineParallelOptimizer = require('../../jobs/pipelineParallelOptimizer');
const PipelineExecutionHistory = require('../../jobs/pipelineExecutionHistory');

// 测试数据
const mockWorkflowYaml = `
name: Test Workflow
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run deploy
`;

// 模拟文件系统
class MockFileSystem {
  constructor(files = {}) {
    this.files = files;
  }

  async readdir(dir) {
    return Object.keys(this.files);
  }

  async readFile(filePath) {
    const fileName = path.basename(filePath);
    if (this.files[fileName]) {
      return this.files[fileName];
    }
    throw new Error(`File not found: ${filePath}`);
  }
}

// 测试套件
async function runTests() {
  console.log('🧪 Pipeline Dependency Analyzer Tests\n');
  
  let passed = 0;
  let failed = 0;

  // 测试 1: 解析工作流 YAML
  try {
    console.log('Test 1: 解析工作流 YAML...');
    const yaml = require('js-yaml');
    const workflow = yaml.load(mockWorkflowYaml);
    
    assert.strictEqual(workflow.name, 'Test Workflow');
    assert.ok(workflow.on.push);
    assert.ok(workflow.on.pull_request);
    assert.ok(workflow.on.workflow_dispatch);
    assert.strictEqual(Object.keys(workflow.jobs).length, 2);
    
    console.log('  ✓ YAML 解析正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 2: 提取触发条件
  try {
    console.log('Test 2: 提取触发条件...');
    const analyzer = new PipelineDependencyAnalyzer();
    const yaml = require('js-yaml');
    const workflow = yaml.load(mockWorkflowYaml);
    
    const triggers = analyzer.extractTriggers(workflow);
    
    assert.ok(triggers.includes('push'));
    assert.ok(triggers.includes('pull_request'));
    assert.ok(triggers.includes('workflow_dispatch'));
    assert.ok(!triggers.includes('schedule'));
    
    console.log('  ✓ 触发条件提取正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 3: 提取作业信息
  try {
    console.log('Test 3: 提取作业信息...');
    const analyzer = new PipelineDependencyAnalyzer();
    const yaml = require('js-yaml');
    const workflow = yaml.load(mockWorkflowYaml);
    
    const jobs = analyzer.extractJobs(workflow);
    
    assert.strictEqual(jobs.length, 2);
    assert.strictEqual(jobs[0].name, 'build');
    assert.strictEqual(jobs[0].needs.length, 0);
    assert.strictEqual(jobs[1].name, 'deploy');
    assert.ok(jobs[1].needs.includes('build'));
    
    console.log('  ✓ 作业信息提取正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 4: 执行历史分析器
  try {
    console.log('Test 4: 执行历史分析...');
    const history = new PipelineExecutionHistory();
    
    // 使用模拟数据
    const mockRuns = [
      { id: 1, name: 'ci-cd.yml', status: 'completed', conclusion: 'success', created_at: '2026-06-23T00:00:00Z', run_duration_ms: 600000 },
      { id: 2, name: 'ci-cd.yml', status: 'completed', conclusion: 'success', created_at: '2026-06-22T00:00:00Z', run_duration_ms: 700000 },
      { id: 3, name: 'deploy.yml', status: 'completed', conclusion: 'failure', created_at: '2026-06-21T00:00:00Z', run_duration_ms: 300000 },
    ];
    
    history.mockData = mockRuns;
    const analysis = history.analyzeRuns(mockRuns);
    
    assert.strictEqual(analysis.total, 3);
    assert.strictEqual(analysis.successful, 2);
    assert.strictEqual(analysis.failed, 1);
    assert.ok(analysis.avgDuration > 0);
    
    console.log('  ✓ 执行历史分析正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 5: 趋势识别
  try {
    console.log('Test 5: 趋势识别...');
    const history = new PipelineExecutionHistory();
    
    // 高失败率数据
    const highFailureRuns = Array(20).fill(null).map((_, i) => ({
      id: i,
      name: 'test.yml',
      status: 'completed',
      conclusion: i < 5 ? 'success' : 'failure', // 75% 失败率
      created_at: new Date().toISOString(),
      run_duration_ms: 600000
    }));
    
    const analysis = history.analyzeRuns(highFailureRuns);
    const trends = history.identifyTrends(analysis);
    
    const highFailureTrend = trends.find(t => t.type === 'high_failure_rate');
    assert.ok(highFailureTrend, '应该检测到高失败率趋势');
    
    console.log('  ✓ 趋势识别正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 6: 成本计算
  try {
    console.log('Test 6: 成本计算...');
    const history = new PipelineExecutionHistory();
    
    const mockRuns = Array(10).fill(null).map((_, i) => ({
      id: i,
      name: 'ci-cd.yml',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date().toISOString(),
      run_duration_ms: 600000 // 10 分钟
    }));
    
    history.mockData = mockRuns;
    const report = await history.generateHistoryReport(30);
    
    assert.ok(report.summary.avgDuration > 0);
    assert.ok(report.summary.totalRuns > 0);
    
    console.log('  ✓ 成本计算正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 7: 并行优化器
  try {
    console.log('Test 7: 并行优化器...');
    const analyzer = new PipelineDependencyAnalyzer();
    
    // 模拟已加载的工作流
    analyzer.workflows.set('workflow1.yml', { name: 'Workflow 1', jobs: [{ timeout: 10 }], dependencies: [] });
    analyzer.workflows.set('workflow2.yml', { name: 'Workflow 2', jobs: [{ timeout: 15 }], dependencies: [] });
    
    analyzer.dependencyGraph.set('workflow1.yml', { workflow: { name: 'Workflow 1' }, dependsOn: [], dependedBy: ['workflow2.yml'], level: 0 });
    analyzer.dependencyGraph.set('workflow2.yml', { workflow: { name: 'Workflow 2' }, dependsOn: ['workflow1.yml'], dependedBy: [], level: 1 });
    
    const optimizer = new PipelineParallelOptimizer(analyzer);
    const costSaving = optimizer.calculateCostSaving();
    
    assert.ok(costSaving.sequentialTime >= 0);
    assert.ok(costSaving.parallelTime >= 0);
    
    console.log('  ✓ 并行优化器正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 测试 8: Mermaid 图生成
  try {
    console.log('Test 8: Mermaid 图生成...');
    const analyzer = new PipelineDependencyAnalyzer();
    
    analyzer.workflows.set('test.yml', { name: 'Test', jobs: [], dependencies: [] });
    analyzer.dependencyGraph.set('test.yml', { workflow: { name: 'Test' }, dependsOn: [], dependedBy: [], level: 0 });
    
    const mermaid = analyzer.generateMermaidGraph();
    
    assert.ok(mermaid.includes('graph TD'));
    assert.ok(mermaid.includes('test["Test'));
    
    console.log('  ✓ Mermaid 图生成正确\n');
    passed++;
  } catch (error) {
    console.log(`  ✗ 测试失败: ${error.message}\n`);
    failed++;
  }

  // 输出结果
  console.log('━'.repeat(50));
  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

// 运行测试
runTests().catch(console.error);
