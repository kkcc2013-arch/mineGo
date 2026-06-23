/**
 * Pipeline Parallel Optimizer
 * 基于 CI/CD 依赖分析生成并行执行优化方案
 * 
 * REQ-00287: CI/CD 管道执行依赖分析与并行优化系统
 */

const yaml = require('js-yaml');

class PipelineParallelOptimizer {
  constructor(analyzer) {
    this.analyzer = analyzer;
  }

  /**
   * 生成并行执行脚本
   */
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

  /**
   * 按层级分组
   */
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

  /**
   * 估算优化后的执行时间
   */
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

  /**
   * 计算成本节省
   */
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

  /**
   * 生成优化后的工作流文件
   */
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

  /**
   * 生成执行计划（JSON 格式）
   */
  generateExecutionPlan() {
    const byLevel = this.groupByLevel();
    const plan = {
      levels: [],
      estimatedTotalTime: 0,
      costEstimate: {}
    };
    
    for (const [level, workflows] of byLevel) {
      const levelInfo = {
        level,
        workflows: workflows.map(w => ({
          file: w,
          name: this.analyzer.workflows.get(w)?.name || w,
          estimatedTime: this.analyzer.estimateExecutionTime(w)
        })),
        executionMode: workflows.length > 1 ? 'parallel' : 'sequential',
        estimatedTime: Math.max(...workflows.map(w => this.analyzer.estimateExecutionTime(w)))
      };
      
      plan.levels.push(levelInfo);
      plan.estimatedTotalTime += levelInfo.estimatedTime;
    }
    
    // 计算成本
    const costSaving = this.calculateCostSaving();
    plan.costEstimate = {
      currentMonthlyCost: costSaving.sequentialTime * 0.008 * 30,
      optimizedMonthlyCost: costSaving.parallelTime * 0.008 * 30,
      monthlySavings: costSaving.savedCostMonthly,
      annualSavings: costSaving.savedCostMonthly * 12
    };
    
    return plan;
  }

  /**
   * 生成优化报告
   */
  generateOptimizationReport() {
    const costSaving = this.calculateCostSaving();
    const parallelizable = this.analyzer.identifyParallelizableWorkflows();
    const suggestions = this.analyzer.generateOptimizationSuggestions();
    
    return {
      summary: {
        totalWorkflows: this.analyzer.workflows.size,
        parallelizableGroups: parallelizable.length,
        potentialTimeSaving: costSaving.savedMinutes,
        potentialCostSaving: costSaving.savedCostMonthly
      },
      currentPerformance: {
        sequentialTime: costSaving.sequentialTime,
        monthlyCost: costSaving.sequentialTime * 0.008 * 30
      },
      optimizedPerformance: {
        parallelTime: costSaving.parallelTime,
        monthlyCost: costSaving.parallelTime * 0.008 * 30
      },
      parallelizableWorkflows: parallelizable,
      suggestions: suggestions.filter(s => s.type === 'parallelization'),
      executionPlan: this.generateExecutionPlan()
    };
  }
}

module.exports = PipelineParallelOptimizer;
