#!/usr/bin/env node
/**
 * 安全合规报告生成器
 * 生成包含 Kube-bench、Policy Enforcer、Trivy 结果的综合报告
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      options[key] = value;
    }
  }
  
  return options;
}

function loadResults(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function generateReport(options) {
  const kubeBench = loadResults(options['kube-bench'] || 'kube-bench-results.json');
  const policy = loadResults(options['policy'] || 'policy-results.json');
  
  const report = [];
  const timestamp = new Date().toISOString();
  
  report.push('# 安全合规扫描报告');
  report.push('');
  report.push(`> 扫描时间: ${timestamp}`);
  report.push('');
  
  // 概览
  report.push('## 📊 概览');
  report.push('');
  
  const score = policy?.score || 0;
  const scoreEmoji = score >= 90 ? '🟢' : score >= 80 ? '🟡' : '🔴';
  
  report.push(`| 指标 | 结果 |`);
  report.push(`|------|------|`);
  report.push(`| 合规评分 | ${scoreEmoji} ${score}/100 |`);
  report.push(`| 检查规则数 | ${policy?.summary?.totalRules || 0} |`);
  report.push(`| 通过项 | ${policy?.summary?.passed || 0} |`);
  report.push(`| 失败项 | ${policy?.summary?.failed || 0} |`);
  report.push(`| 关键问题 | ${policy?.summary?.criticalIssues?.length || 0} |`);
  report.push(`| 高危问题 | ${policy?.summary?.highIssues?.length || 0} |`);
  report.push('');
  
  // CIS Benchmark 结果
  report.push('## 🔍 CIS Kubernetes Benchmark');
  report.push('');
  
  if (kubeBench) {
    report.push(`| 类别 | 通过 | 失败 | 警告 |`);
    report.push(`|------|------|------|------|`);
    if (kubeBench.Controls) {
      for (const control of kubeBench.Controls) {
        const passed = control.tests_summary?.Pass || 0;
        const failed = control.tests_summary?.Fail || 0;
        const warn = control.tests_summary?.Warn || 0;
        report.push(`| ${control.text} | ${passed} | ${failed} | ${warn} |`);
      }
    }
  } else {
    report.push('*Kube-bench 结果不可用*');
  }
  report.push('');
  
  // 安全策略违规详情
  report.push('## 🛡️ 安全策略违规详情');
  report.push('');
  
  if (policy?.results) {
    const violations = policy.results.filter(r => !r.passed);
    
    if (violations.length === 0) {
      report.push('✅ **所有安全策略检查通过！**');
    } else {
      // 按严重程度分组
      const bySeverity = {
        critical: violations.filter(v => v.severity === 'critical'),
        high: violations.filter(v => v.severity === 'high'),
        medium: violations.filter(v => v.severity === 'medium'),
        low: violations.filter(v => v.severity === 'low')
      };
      
      for (const [severity, issues] of Object.entries(bySeverity)) {
        if (issues.length === 0) continue;
        
        const emoji = {
          critical: '🔴',
          high: '🟠',
          medium: '🟡',
          low: '🔵'
        }[severity];
        
        report.push(`### ${emoji} ${severity.toUpperCase()} (${issues.length} 项)`);
        report.push('');
        
        for (const issue of issues) {
          report.push(`#### ${issue.id}: ${issue.name}`);
          report.push('');
          report.push(`- **类别**: ${issue.category}`);
          report.push(`- **修复建议**: ${issue.remediation}`);
          report.push('');
        }
      }
    }
  }
  report.push('');
  
  // 自动修复脚本
  report.push('## 🔧 自动修复脚本');
  report.push('');
  
  if (policy?.report?.autoFixScripts?.length > 0) {
    report.push('以下脚本可用于自动修复部分违规项：');
    report.push('');
    
    for (const script of policy.report.autoFixScripts) {
      report.push(`### ${script.ruleId}`);
      report.push('');
      report.push('```bash');
      report.push(script.script.trim());
      report.push('```');
      report.push('');
    }
  } else {
    report.push('*无可自动修复的违规项*');
  }
  report.push('');
  
  // 建议
  report.push('## 💡 改进建议');
  report.push('');
  
  if (score >= 90) {
    report.push('系统安全合规状态良好，继续保持当前的配置管理水平。');
  } else if (score >= 80) {
    report.push('建议优先处理高危违规项，并在下一版本中修复中等风险问题。');
  } else {
    report.push('**立即行动**：请尽快修复所有关键和高危违规项，这些可能影响生产环境安全。');
  }
  report.push('');
  
  // 附录
  report.push('## 📎 附录');
  report.push('');
  report.push('- [CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)');
  report.push('- [kube-bench 文档](https://github.com/aquasecurity/kube-bench)');
  report.push('- [mineGo 安全策略](../docs/security-policy.md)');
  report.push('');
  
  report.push(`---`);
  report.push(`*报告由 mineGo Security Policy Enforcer 自动生成*`);
  
  return report.join('\n');
}

// 主函数
function main() {
  const options = parseArgs();
  const report = generateReport(options);
  
  const outputPath = options.output || 'compliance-report.md';
  fs.writeFileSync(outputPath, report);
  
  console.log(`✅ 合规报告已生成: ${outputPath}`);
}

main();