/**
 * Pipeline Dependency Analyzer
 * 分析 GitHub Actions 工作流之间的依赖关系
 * 
 * REQ-00287: CI/CD 管道执行依赖分析与并行优化系统
 */

const yaml = require('js-yaml');
const fs = require('fs').promises;
const path = require('path');

class PipelineDependencyAnalyzer {
  constructor(workflowsDir = '.github/workflows') {
    this.workflowsDir = workflowsDir;
    this.workflows = new Map();
    this.dependencyGraph = new Map();
  }

  /**
   * 解析所有工作流文件
   */
  async loadWorkflows() {
    try {
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
    } catch (error) {
      console.error('Failed to load workflows:', error.message);
      return this.workflows;
    }
  }

  /**
   * 提取触发条件
   */
  extractTriggers(workflow) {
    const triggers = [];
    
    if (workflow.on?.push) triggers.push('push');
    if (workflow.on?.pull_request) triggers.push('pull_request');
    if (workflow.on?.workflow_dispatch) triggers.push('workflow_dispatch');
    if (workflow.on?.schedule) triggers.push('schedule');
    if (workflow.on?.workflow_call) triggers.push('workflow_call');
    
    return triggers;
  }

  /**
   * 提取作业及其依赖
   */
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

  /**
   * 提取工作流输出
   */
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

  /**
   * 提取工作流输入
   */
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

  /**
   * 提取工作流间依赖
   */
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

  /**
   * 构建依赖图
   */
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

  /**
   * 计算节点层级
   */
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

  /**
   * 识别关键路径
   */
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

  /**
   * 回溯路径
   */
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

  /**
   * 估算执行时间（分钟）
   */
  estimateExecutionTime(file) {
    const workflow = this.workflows.get(file);
    if (!workflow) return 0;
    
    let totalMinutes = 0;
    for (const job of workflow.jobs) {
      totalMinutes += job.timeout;
    }
    
    return totalMinutes;
  }

  /**
   * 识别可并行执行的工作流
   */
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

  /**
   * 计算并行节省时间
   */
  calculateParallelSaving(files) {
    const sequentialTime = files.reduce((sum, file) => {
      return sum + this.estimateExecutionTime(file);
    }, 0);
    
    const parallelTime = Math.max(...files.map(f => this.estimateExecutionTime(f)));
    
    return sequentialTime - parallelTime;
  }

  /**
   * 生成优化建议
   */
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

  /**
   * 检测循环依赖
   */
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

  /**
   * 生成依赖图可视化（Mermaid 格式）
   */
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

  /**
   * 生成完整分析报告
   */
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
