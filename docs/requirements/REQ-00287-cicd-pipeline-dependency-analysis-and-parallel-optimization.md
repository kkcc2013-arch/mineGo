# REQ-00287：CI/CD 管道执行依赖分析与并行优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00287 |
| 标题 | CI/CD 管道执行依赖分析与并行优化系统 |
| 类别 | 运维/CICD |
| 优先级 | P2 |
| 状态 | new |
| 涉及服务 | .github/workflows, backend/jobs, admin-dashboard, scripts/ |
| 创建时间 | 2026-06-22 08:00 |
| 依赖需求 | REQ-00260（CI/CD 管道可视化仪表板） |

## 需求描述

当前 mineGo 项目有多个 GitHub Actions 工作流（ci-cd.yml、deploy.yml、security-scan.yml 等），这些工作流之间存在隐式依赖关系，但缺乏系统化的依赖分析和并行优化机制。导致：

1. **串行执行效率低**：部分独立任务串行执行，浪费 CI 时间和资源
2. **依赖关系不透明**：工作流之间的依赖关系未显式定义，难以维护
3. **执行瓶颈难定位**：无法快速识别哪些步骤是关键路径，哪些可以优化
4. **资源利用率低**：并行度不足，GitHub Actions 分钟消耗高

### 目标
构建 CI/CD 管道依赖分析与并行优化系统：
- 自动分析工作流之间的依赖关系
- 生成依赖图可视化
- 识别可并行执行的步骤
- 优化执行顺序减少总时间
- 预测执行时间和成本

## 技术方案

### 1. 依赖分析引擎

```javascript
// backend/jobs/pipeline-dependency-analyzer.js
const yaml = require('js-yaml');
const fs = require('fs').promises;
const path = require('path');

class PipelineDependencyAnalyzer {
  constructor(workflowsDir = '.github/workflows') {
    this.workflowsDir = workflowsDir;
    this.workflows = new Map();
    this.dependencyGraph = new Map();
  }

  // 解析所有工作流文件
  async loadWorkflows() {
    const files = await fs.readdir(this.workflowsDir);
    const workflowFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    
    for (const file of workflowFiles) {
      const filePath = path.join(this.workflowsDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const workflow = yaml.load(content);
      
      this.workflows.set(file, {
        name: workflow.name || file,
        file,
        triggers: this.extractTriggers(workflow),
        jobs: this.extractJobs(workflow),
        outputs: this.extractOutputs(workflow),
        inputs: this.extractInputs(workflow),
        dependencies: this.extractDependencies(workflow)
      });
    }
    
    return this.workflows;
  }

  // 提取触发条件
  extractTriggers(workflow) {
    const triggers = [];
    
    if (workflow.on?.push) triggers.push('push');
    if (workflow.on?.pull_request) triggers.push('pull_request');
    if (workflow.on?.workflow_dispatch) triggers.push('workflow_dispatch');
    if (workflow.on?.schedule) triggers.push('schedule');
    if (workflow.on?.workflow_call) triggers.push('workflow_call');
    
    return triggers;
  }

  // 提取作业及其依赖
  extractJobs(workflow) {
    const jobs = [];
    
    for (const [jobName, jobConfig] of Object.entries(workflow.jobs || {})) {
      jobs.push({
        name: jobName,
        needs: jobConfig.needs || [],
        runsOn: jobConfig['runs-on'],
        steps: jobConfig.steps?.length || 0,
        if: jobConfig.if,
        timeout: jobConfig['timeout-minutes'] || 360
      });
    }
    
    return jobs;
  }

  // 提取工作流输出
  extractOutputs(workflow) {
    const outputs = [];
    
    if (workflow.on?.workflow_call?.outputs) {
      for (const [name, config] of Object.entries(workflow.on.workflow_call.outputs)) {
        outputs.push({
          name,
          value: config.value,
          description: config.description
        });
      }
    }
    
    return outputs;
  }

  // 提取工作流输入
  extractInputs(workflow) {
    const inputs = [];
    
    if (workflow.on?.workflow_call?.inputs) {
      for (const [name, config] of Object.entries(workflow.on.workflow_call.inputs)) {
        inputs.push({
          name,
          type: config.type,
          required: config.required,
          default: config.default,
          description: config.description
        });
      }
    }
    
    return inputs;
  }

  // 提取工作流间依赖
  extractDependencies(workflow) {
    const dependencies = [];
    
    // 检查是否调用其他工作流
    for (const [jobName, jobConfig] of Object.entries(workflow.jobs || {})) {
      for (const step of (jobConfig.steps || [])) {
        // 检查 uses 关键字（可复用工作流）
        if (step.uses) {
          const match = step.uses.match(/\.\/\.github\/workflows\/(.+\.yml)/);
          if (match) {
            dependencies.push({
              type: 'workflow_call',
              target: match[1],
              job: jobName,
              step: step.name || step.id
            });
          }
        }
        
        // 检查等待其他工作流完成的逻辑
        if (step.run?.includes('gh workflow run') || step.run?.includes('gh run wait')) {
          dependencies.push({
            type: 'cli_call',
            target: 'unknown', // 需要进一步分析
            job: jobName,
            step: step.name || step.id
          });
        }
      }
    }
    
    return dependencies;
  }

  // 构建依赖图
  buildDependencyGraph() {
    // 初始化节点
    for (const [file, workflow] of this.workflows) {
      this.dependencyGraph.set(file, {
        workflow,
        dependsOn: [],
        dependedBy: [],
        level: 0
      });
    }
    
    // 构建依赖关系
    for (const [file, workflow] of this.workflows) {
      for (const dep of workflow.dependencies) {
        if (dep.type === 'workflow_call' && this.dependencyGraph.has(dep.target)) {
          this.dependencyGraph.get(file).dependsOn.push(dep.target);
          this.dependencyGraph.get(dep.target).dependedBy.push(file);
        }
      }
    }
    
    // 计算层级（拓扑排序）
    this.calculateLevels();
    
    return this.dependencyGraph;
  }

  // 计算节点层级
  calculateLevels() {
    const visited = new Set();
    const stack = [];
    
    // 找到所有入度为 0 的节点（无依赖）
    for (const [file, node] of this.dependencyGraph) {
      if (node.dependsOn.length === 0) {
        node.level = 0;
        stack.push(file);
      }
    }
    
    // BFS 计算层级
    while (stack.length > 0) {
      const current = stack.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      
      const node = this.dependencyGraph.get(current);
      
      for (const dependent of node.dependedBy) {
        const dependentNode = this.dependencyGraph.get(dependent);
        dependentNode.level = Math.max(dependentNode.level, node.level + 1);
        stack.push(dependent);
      }
    }
  }

  // 识别关键路径
  findCriticalPath() {
    const paths = [];
    
    // 找到所有叶子节点（无被依赖）
    const leafNodes = [];
    for (const [file, node] of this.dependencyGraph) {
      if (node.dependedBy.length === 0) {
        leafNodes.push(file);
      }
    }
    
    // 对每个叶子节点，回溯最长路径
    for (const leaf of leafNodes) {
      const path = this.backtrackPath(leaf);
      paths.push(path);
    }
    
    // 返回最长路径
    return paths.sort((a, b) => b.totalTime - a.totalTime)[0] || { nodes: [], totalTime: 0 };
  }

  // 回溯路径
  backtrackPath(node) {
    const path = {
      nodes: [],
      totalTime: 0
    };
    
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      const nodeData = this.dependencyGraph.get(current);
      
      path.nodes.unshift(current);
      path.totalTime += this.estimateExecutionTime(current);
      
      // 选择耗时最长的依赖
      if (nodeData.dependsOn.length > 0) {
        const longestDep = nodeData.dependsOn.reduce((a, b) => {
          const timeA = this.estimateExecutionTime(a);
          const timeB = this.estimateExecutionTime(b);
          return timeA > timeB ? a : b;
        });
        stack.push(longestDep);
      }
    }
    
    return path;
  }

  // 估算执行时间（分钟）
  estimateExecutionTime(file) {
    const workflow = this.workflows.get(file);
    if (!workflow) return 0;
    
    let totalMinutes = 0;
    for (const job of workflow.jobs) {
      totalMinutes += job.timeout;
    }
    
    return totalMinutes;
  }

  // 识别可并行执行的工作流
  identifyParallelizableWorkflows() {
    const byLevel = new Map();
    
    for (const [file, node] of this.dependencyGraph) {
      if (!byLevel.has(node.level)) {
        byLevel.set(node.level, []);
      }
      byLevel.get(node.level).push(file);
    }
    
    const parallelizable = [];
    for (const [level, files] of byLevel) {
      if (files.length > 1) {
        parallelizable.push({
          level,
          workflows: files,
          potentialSaving: this.calculateParallelSaving(files)
        });
      }
    }
    
    return parallelizable;
  }

  // 计算并行节省时间
  calculateParallelSaving(files) {
    const sequentialTime = files.reduce((sum, file) => {
      return sum + this.estimateExecutionTime(file);
    }, 0);
    
    const parallelTime = Math.max(...files.map(f => this.estimateExecutionTime(f)));
    
    return sequentialTime - parallelTime;
  }

  // 生成优化建议
  generateOptimizationSuggestions() {
    const suggestions = [];
    
    // 检查可并行的工作流
    const parallelizable = this.identifyParallelizableWorkflows();
    for (const group of parallelizable) {
      suggestions.push({
        type: 'parallelization',
        priority: 'high',
        message: `层级 ${group.level} 的 ${group.workflows.length} 个工作流可以并行执行`,
        workflows: group.workflows,
        potentialSaving: `${group.potentialSaving} 分钟`,
        impact: `可节省约 $${(group.potentialSaving * 0.008).toFixed(2)} (GitHub Actions 分钟费用)`
      });
    }
    
    // 检查长时运行的工作流
    for (const [file, workflow] of this.workflows) {
      const time = this.estimateExecutionTime(file);
      if (time > 30) {
        suggestions.push({
          type: 'long_running',
          priority: 'medium',
          message: `工作流 ${file} 执行时间较长（${time} 分钟）`,
          workflow: file,
          suggestion: '考虑拆分为多个独立工作流或优化步骤'
        });
      }
    }
    
    // 检查循环依赖
    const cycles = this.detectCycles();
    if (cycles.length > 0) {
      suggestions.push({
        type: 'cycle',
        priority: 'critical',
        message: '检测到循环依赖，这会导致无限执行',
        cycles,
        suggestion: '必须移除循环依赖'
      });
    }
    
    return suggestions;
  }

  // 检测循环依赖
  detectCycles() {
    const cycles = [];
    const visited = new Set();
    const recursionStack = new Set();
    
    for (const [file] of this.dependencyGraph) {
      const cycle = this.detectCycleDFS(file, visited, recursionStack, []);
      if (cycle) {
        cycles.push(cycle);
      }
    }
    
    return cycles;
  }

  detectCycleDFS(node, visited, recursionStack, path) {
    if (recursionStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return path.slice(cycleStart);
    }
    
    if (visited.has(node)) return null;
    
    visited.add(node);
    recursionStack.add(node);
    path.push(node);
    
    const nodeData = this.dependencyGraph.get(node);
    for (const dep of nodeData.dependsOn) {
      const cycle = this.detectCycleDFS(dep, visited, recursionStack, [...path]);
      if (cycle) return cycle;
    }
    
    recursionStack.delete(node);
    return null;
  }

  // 生成依赖图可视化（Mermaid 格式）
  generateMermaidGraph() {
    let mermaid = 'graph TD\n';
    
    // 添加节点
    for (const [file, node] of this.dependencyGraph) {
      const label = node.workflow.name.replace(/"/g, "'");
      mermaid += `    ${file.replace('.yml', '')}["${label}<br/>Level: ${node.level}"]\n`;
    }
    
    // 添加边
    for (const [file, node] of this.dependencyGraph) {
      for (const dep of node.dependsOn) {
        mermaid += `    ${file.replace('.yml', '')} --> ${dep.replace('.yml', '')}\n`;
      }
    }
    
    // 添加样式
    mermaid += '\n    %% 样式\n';
    for (const [file, node] of this.dependencyGraph) {
      const color = this.getLevelColor(node.level);
      mermaid += `    style ${file.replace('.yml', '')} fill:${color}\n`;
    }
    
    return mermaid;
  }

  getLevelColor(level) {
    const colors = ['#e1f5fe', '#b3e5fc', '#81d4fa', '#4fc3f7', '#29b6f6'];
    return colors[level % colors.length];
  }

  // 生成完整分析报告
  async generateReport() {
    await this.loadWorkflows();
    this.buildDependencyGraph();
    
    return {
      summary: {
        totalWorkflows: this.workflows.size,
        totalDependencies: Array.from(this.dependencyGraph.values())
          .reduce((sum, node) => sum + node.dependsOn.length, 0),
        maxLevel: Math.max(...Array.from(this.dependencyGraph.values()).map(n => n.level))
      },
      workflows: Array.from(this.workflows.entries()).map(([file, workflow]) => ({
        file,
        ...workflow
      })),
      dependencyGraph: this.generateMermaidGraph(),
      criticalPath: this.findCriticalPath(),
      parallelizable: this.identifyParallelizableWorkflows(),
      suggestions: this.generateOptimizationSuggestions(),
      cycles: this.detectCycles()
    };
  }
}

module.exports = PipelineDependencyAnalyzer;
```

### 2. 并行执行优化器

```javascript
// backend/jobs/pipeline-parallel-optimizer.js
const { execSync } = require('child_process');

class PipelineParallelOptimizer {
  constructor(analyzer) {
    this.analyzer = analyzer;
  }

  // 生成并行执行脚本
  generateParallelExecutionScript(trigger = 'push') {
    const script = `#!/bin/bash
# 自动生成的并行执行脚本
# 触发条件: ${trigger}
# 生成时间: ${new Date().toISOString()}

set -e

echo "🚀 开始并行执行 CI/CD 管道..."

`;

    const byLevel = this.groupByLevel();
    let commands = '';
    
    for (const [level, workflows] of byLevel) {
      if (workflows.length === 1) {
        commands += `# Level ${level} - 串行执行\n`;
        commands += `echo "▶ 执行: ${workflows[0]}"\n`;
        commands += `gh workflow run ${workflows[0]} --ref $GITHUB_REF\n`;
        commands += `gh run wait --log\n\n`;
      } else {
        commands += `# Level ${level} - 并行执行\n`;
        commands += `echo "▶ 并行执行: ${workflows.join(', ')}"\n`;
        
        for (const workflow of workflows) {
          commands += `(gh workflow run ${workflow} --ref $GITHUB_REF) &\n`;
        }
        
        commands += `wait\n`;
        commands += `echo "✓ Level ${level} 完成"\n\n`;
      }
    }
    
    return script + commands;
  }

  // 按层级分组
  groupByLevel() {
    const byLevel = new Map();
    
    for (const [file, node] of this.analyzer.dependencyGraph) {
      if (!byLevel.has(node.level)) {
        byLevel.set(node.level, []);
      }
      byLevel.get(node.level).push(file);
    }
    
    // 按层级排序
    return new Map([...byLevel.entries()].sort((a, b) => a[0] - b[0]));
  }

  // 估算优化后的执行时间
  estimateOptimizedTime() {
    const byLevel = this.groupByLevel();
    let totalTime = 0;
    
    for (const [level, workflows] of byLevel) {
      // 并行执行时，取最长的时间
      const maxTime = Math.max(
        ...workflows.map(w => this.analyzer.estimateExecutionTime(w))
      );
      totalTime += maxTime;
    }
    
    return totalTime;
  }

  // 计算成本节省
  calculateCostSaving() {
    const sequentialTime = Array.from(this.analyzer.workflows.values())
      .reduce((sum, w) => sum + this.analyzer.estimateExecutionTime(w.file), 0);
    
    const parallelTime = this.estimateOptimizedTime();
    const savedMinutes = sequentialTime - parallelTime;
    
    // GitHub Actions 分钟费用：$0.008/分钟（Linux）
    const costPerMinute = 0.008;
    
    return {
      sequentialTime,
      parallelTime,
      savedMinutes,
      savedCost: savedMinutes * costPerMinute,
      savedCostMonthly: savedMinutes * costPerMinute * 30 // 假设每天执行一次
    };
  }

  // 生成优化后的工作流文件
  generateOptimizedWorkflow(trigger = 'push') {
    const byLevel = this.groupByLevel();
    
    const workflow = {
      name: 'Optimized Parallel CI/CD',
      on: {
        [trigger]: {
          branches: ['main', 'develop']
        }
      },
      jobs: {}
    };
    
    let jobIndex = 0;
    const jobNames = [];
    
    for (const [level, workflowsAtLevel] of byLevel) {
      const jobName = `level_${level}`;
      jobNames.push(jobName);
      
      workflow.jobs[jobName] = {
        'runs-on': 'ubuntu-latest',
        needs: level > 0 ? [`level_${level - 1}`] : [],
        steps: [
          {
            name: 'Checkout',
            uses: 'actions/checkout@v4'
          },
          {
            name: `Execute workflows at level ${level}`,
            run: this.generateParallelRunCommand(workflowsAtLevel)
          }
        ]
      };
      
      jobIndex++;
    }
    
    return workflow;
  }

  generateParallelRunCommand(workflows) {
    if (workflows.length === 1) {
      return `gh workflow run ${workflows[0]} --ref \${{ github.ref }}`;
    }
    
    let command = '|\n';
    for (const workflow of workflows) {
      command += `  gh workflow run ${workflow} --ref \${{ github.ref }} &\n`;
    }
    command += '  wait\n';
    
    return command;
  }
}

module.exports = PipelineParallelOptimizer;
```

### 3. 执行历史分析器

```javascript
// backend/jobs/pipeline-execution-history.js
const { Octokit } = require('@octokit/rest');

class PipelineExecutionHistory {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
    this.owner = process.env.GITHUB_REPOSITORY?.split('/')[0] || 'kkcc2013-arch';
    this.repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'mineGo';
  }

  // 获取执行历史
  async getExecutionHistory(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    
    const runs = await this.octokit.paginate(
      this.octokit.rest.actions.listWorkflowRunsForRepo,
      {
        owner: this.owner,
        repo: this.repo,
        created: `>=${since.toISOString()}`,
        per_page: 100
      }
    );
    
    return this.analyzeRuns(runs);
  }

  // 分析执行记录
  analyzeRuns(runs) {
    const analysis = {
      total: runs.length,
      successful: 0,
      failed: 0,
      cancelled: 0,
      totalDuration: 0,
      avgDuration: 0,
      byWorkflow: {},
      byDay: {},
      failures: []
    };
    
    for (const run of runs) {
      // 统计状态
      if (run.status === 'completed') {
        if (run.conclusion === 'success') analysis.successful++;
        else if (run.conclusion === 'failure') {
          analysis.failed++;
          analysis.failures.push({
            id: run.id,
            workflow: run.name,
            date: run.created_at,
            duration: run.run_duration_ms / 60000, // 转换为分钟
            url: run.html_url
          });
        }
        else if (run.conclusion === 'cancelled') analysis.cancelled++;
      }
      
      // 计算时长
      if (run.run_duration_ms) {
        const durationMinutes = run.run_duration_ms / 60000;
        analysis.totalDuration += durationMinutes;
      }
      
      // 按工作流分组
      if (!analysis.byWorkflow[run.name]) {
        analysis.byWorkflow[run.name] = {
          total: 0,
          successful: 0,
          failed: 0,
          avgDuration: 0,
          totalDuration: 0
        };
      }
      analysis.byWorkflow[run.name].total++;
      if (run.conclusion === 'success') analysis.byWorkflow[run.name].successful++;
      if (run.conclusion === 'failure') analysis.byWorkflow[run.name].failed++;
      if (run.run_duration_ms) {
        analysis.byWorkflow[run.name].totalDuration += run.run_duration_ms / 60000;
      }
      
      // 按天分组
      const day = run.created_at.split('T')[0];
      if (!analysis.byDay[day]) {
        analysis.byDay[day] = { total: 0, successful: 0, failed: 0 };
      }
      analysis.byDay[day].total++;
      if (run.conclusion === 'success') analysis.byDay[day].successful++;
      if (run.conclusion === 'failure') analysis.byDay[day].failed++;
    }
    
    // 计算平均值
    analysis.avgDuration = analysis.totalDuration / runs.length;
    
    for (const workflow of Object.keys(analysis.byWorkflow)) {
      const w = analysis.byWorkflow[workflow];
      w.avgDuration = w.totalDuration / w.total;
      w.successRate = (w.successful / w.total * 100).toFixed(1);
    }
    
    return analysis;
  }

  // 识别趋势和异常
  identifyTrends(analysis) {
    const trends = [];
    
    // 检查失败率上升
    const failureRate = analysis.failed / analysis.total;
    if (failureRate > 0.1) {
      trends.push({
        type: 'high_failure_rate',
        severity: 'warning',
        message: `失败率 ${((failureRate) * 100).toFixed(1)}% 偏高`,
        recommendation: '检查最近的失败原因并修复'
      });
    }
    
    // 检查执行时间趋势
    for (const [workflow, stats] of Object.entries(analysis.byWorkflow)) {
      if (stats.avgDuration > 30) {
        trends.push({
          type: 'long_execution',
          severity: 'info',
          workflow,
          message: `${workflow} 平均执行时间 ${stats.avgDuration.toFixed(1)} 分钟`,
          recommendation: '考虑优化或拆分工作流'
        });
      }
    }
    
    // 检查失败模式
    const recentFailures = analysis.failures.slice(0, 10);
    const failureByWorkflow = {};
    for (const f of recentFailures) {
      failureByWorkflow[f.workflow] = (failureByWorkflow[f.workflow] || 0) + 1;
    }
    
    for (const [workflow, count] of Object.entries(failureByWorkflow)) {
      if (count >= 3) {
        trends.push({
          type: 'recurring_failure',
          severity: 'critical',
          workflow,
          message: `${workflow} 最近失败 ${count} 次`,
          recommendation: '需要立即调查和修复'
        });
      }
    }
    
    return trends;
  }

  // 预测下次执行时间
  predictNextExecution(workflowName, analysis) {
    const stats = analysis.byWorkflow[workflowName];
    if (!stats) return null;
    
    // 使用简单移动平均
    const avgDuration = stats.avgDuration;
    const stdDev = Math.sqrt(stats.totalDuration / stats.total - avgDuration * avgDuration);
    
    return {
      expected: avgDuration,
      min: Math.max(0, avgDuration - 2 * stdDev),
      max: avgDuration + 2 * stdDev,
      confidence: '95%'
    };
  }
}

module.exports = PipelineExecutionHistory;
```

### 4. API 端点

```javascript
// backend/routes/pipeline-analysis.js
const express = require('express');
const router = express.Router();
const PipelineDependencyAnalyzer = require('../jobs/pipeline-dependency-analyzer');
const PipelineParallelOptimizer = require('../jobs/pipeline-parallel-optimizer');
const PipelineExecutionHistory = require('../jobs/pipeline-execution-history');

// 获取依赖分析报告
router.get('/analysis', async (req, res) => {
  try {
    const analyzer = new PipelineDependencyAnalyzer();
    const report = await analyzer.generateReport();
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取依赖图（Mermaid 格式）
router.get('/dependency-graph', async (req, res) => {
  try {
    const analyzer = new PipelineDependencyAnalyzer();
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    res.json({
      success: true,
      data: {
        mermaid: analyzer.generateMermaidGraph(),
        nodes: Array.from(analyzer.dependencyGraph.entries()).map(([file, node]) => ({
          file,
          name: node.workflow.name,
          level: node.level,
          dependsOn: node.dependsOn,
          dependedBy: node.dependedBy
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取优化建议
router.get('/optimization-suggestions', async (req, res) => {
  try {
    const analyzer = new PipelineDependencyAnalyzer();
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const suggestions = analyzer.generateOptimizationSuggestions();
    
    res.json({
      success: true,
      data: suggestions
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取并行优化方案
router.get('/parallel-optimization', async (req, res) => {
  try {
    const analyzer = new PipelineDependencyAnalyzer();
    await analyzer.loadWorkflows();
    analyzer.buildDependencyGraph();
    
    const optimizer = new PipelineParallelOptimizer(analyzer);
    const costSaving = optimizer.calculateCostSaving();
    
    res.json({
      success: true,
      data: {
        costSaving,
        optimizedWorkflow: optimizer.generateOptimizedWorkflow(),
        executionScript: optimizer.generateParallelExecutionScript()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取执行历史
router.get('/execution-history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = new PipelineExecutionHistory(process.env.GITHUB_TOKEN);
    const data = await history.getExecutionHistory(days);
    const trends = history.identifyTrends(data);
    
    res.json({
      success: true,
      data: {
        history: data,
        trends
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 5. 前端可视化组件

```vue
<!-- admin-dashboard/src/components/PipelineDependencyGraph.vue -->
<template>
  <div class="pipeline-dependency-graph">
    <div class="header">
      <h2>CI/CD 管道依赖分析</h2>
      <button @click="refreshAnalysis" :disabled="loading">
        {{ loading ? '分析中...' : '刷新分析' }}
      </button>
    </div>

    <div class="summary-cards">
      <div class="card">
        <div class="label">总工作流</div>
        <div class="value">{{ analysis?.summary?.totalWorkflows || 0 }}</div>
      </div>
      <div class="card">
        <div class="label">依赖关系</div>
        <div class="value">{{ analysis?.summary?.totalDependencies || 0 }}</div>
      </div>
      <div class="card">
        <div class="label">最大层级</div>
        <div class="value">{{ analysis?.summary?.maxLevel || 0 }}</div>
      </div>
      <div class="card highlight">
        <div class="label">关键路径时长</div>
        <div class="value">{{ analysis?.criticalPath?.totalTime || 0 }} 分钟</div>
      </div>
    </div>

    <div class="graph-container">
      <h3>依赖关系图</h3>
      <div ref="mermaidContainer" class="mermaid"></div>
    </div>

    <div class="optimization-section">
      <h3>优化建议</h3>
      <div v-for="(suggestion, index) in analysis?.suggestions" :key="index"
           :class="['suggestion', suggestion.type, suggestion.priority]">
        <div class="suggestion-header">
          <span class="priority-badge">{{ suggestion.priority }}</span>
          <span class="type">{{ suggestion.type }}</span>
        </div>
        <div class="message">{{ suggestion.message }}</div>
        <div v-if="suggestion.potentialSaving" class="saving">
          💰 潜在节省: {{ suggestion.potentialSaving }}
        </div>
        <div v-if="suggestion.suggestion" class="recommendation">
          💡 {{ suggestion.suggestion }}
        </div>
      </div>
    </div>

    <div class="parallel-section">
      <h3>并行优化方案</h3>
      <div v-for="(group, index) in analysis?.parallelizable" :key="index" class="parallel-group">
        <div class="group-header">
          层级 {{ group.level }} - {{ group.workflows.length }} 个工作流可并行
        </div>
        <div class="workflows">
          <span v-for="w in group.workflows" :key="w" class="workflow-tag">{{ w }}</span>
        </div>
        <div class="saving">
          预计节省: {{ group.potentialSaving }} 分钟
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import mermaid from 'mermaid';
import { ref, onMounted, watch } from 'vue';

export default {
  name: 'PipelineDependencyGraph',
  setup() {
    const loading = ref(false);
    const analysis = ref(null);
    const mermaidContainer = ref(null);

    const refreshAnalysis = async () => {
      loading.value = true;
      try {
        const response = await fetch('/api/v1/pipeline/analysis');
        const data = await response.json();
        analysis.value = data.data;
        
        // 渲染 Mermaid 图
        if (data.data.dependencyGraph) {
          mermaid.render('dependency-graph', data.data.dependencyGraph).then(({ svg }) => {
            mermaidContainer.value.innerHTML = svg;
          });
        }
      } catch (error) {
        console.error('Failed to fetch analysis:', error);
      } finally {
        loading.value = false;
      }
    };

    onMounted(() => {
      mermaid.initialize({ startOnLoad: false });
      refreshAnalysis();
    });

    return {
      loading,
      analysis,
      mermaidContainer,
      refreshAnalysis
    };
  }
};
</script>

<style scoped>
.pipeline-dependency-graph {
  padding: 20px;
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.card {
  background: #f5f5f5;
  padding: 16px;
  border-radius: 8px;
}

.card.highlight {
  background: #e3f2fd;
}

.graph-container {
  background: white;
  padding: 20px;
  border-radius: 8px;
  margin-bottom: 24px;
}

.suggestion {
  padding: 12px;
  margin-bottom: 12px;
  border-left: 4px solid #ddd;
  background: #fafafa;
}

.suggestion.critical {
  border-left-color: #f44336;
  background: #ffebee;
}

.suggestion.high {
  border-left-color: #ff9800;
  background: #fff3e0;
}

.parallel-group {
  background: #e8f5e9;
  padding: 12px;
  margin-bottom: 12px;
  border-radius: 4px;
}

.workflow-tag {
  display: inline-block;
  background: #4caf50;
  color: white;
  padding: 4px 8px;
  margin: 4px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
```

## 验收标准

- [ ] **依赖分析**
  - [ ] 正确解析所有 GitHub Actions 工作流文件
  - [ ] 准确识别工作流间的依赖关系
  - [ ] 正确计算节点层级
  - [ ] 检测到循环依赖并告警

- [ ] **关键路径分析**
  - [ ] 正确识别关键路径
  - [ ] 准确估算执行时间
  - [ ] 识别瓶颈步骤

- [ ] **并行优化**
  - [ ] 正确识别可并行的工作流
  - [ ] 准确计算时间节省
  - [ ] 生成的并行执行脚本可执行
  - [ ] 成本计算准确

- [ ] **可视化**
  - [ ] Mermaid 图正确渲染
  - [ ] 节点按层级颜色编码
  - [ ] 依赖关系清晰可见

- [ ] **历史分析**
  - [ ] 正确获取 GitHub Actions 执行历史
  - [ ] 准确计算统计数据
  - [ ] 正确识别趋势和异常

- [ ] **API 端点**
  - [ ] GET /api/v1/pipeline/analysis 返回完整分析
  - [ ] GET /api/v1/pipeline/dependency-graph 返回依赖图
  - [ ] GET /api/v1/pipeline/optimization-suggestions 返回优化建议
  - [ ] GET /api/v1/pipeline/parallel-optimization 返回并行优化方案
  - [ ] GET /api/v1/pipeline/execution-history 返回执行历史

## 影响范围

### 新增文件
- `backend/jobs/pipeline-dependency-analyzer.js`
- `backend/jobs/pipeline-parallel-optimizer.js`
- `backend/jobs/pipeline-execution-history.js`
- `backend/routes/pipeline-analysis.js`
- `admin-dashboard/src/components/PipelineDependencyGraph.vue`
- `scripts/pipeline-parallel-execution.sh`

### 修改文件
- `backend/gateway/index.js` - 添加路由
- `admin-dashboard/src/router/index.js` - 添加页面路由

### 数据库变更
- 无需数据库变更

## 工作量估算