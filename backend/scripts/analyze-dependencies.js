#!/usr/bin/env node
/**
 * 依赖分析脚本
 * 用法: node scripts/analyze-dependencies.js [options]
 * 
 * 选项:
 * --format <format>  输出格式: json, mermaid, dot (默认: json)
 * --output <file>    输出文件路径 (默认: stdout)
 * --check-cycles     检测循环依赖并以退出码报告
 */

const path = require('path');
const fs = require('fs').promises;
const { DependencyAnalyzer } = require('../shared/dependencyAnalyzer');

async function main() {
  const args = process.argv.slice(2);
  
  // 解析参数
  const formatIndex = args.indexOf('--format');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'json';
  
  const outputIndex = args.indexOf('--output');
  const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
  
  const checkCycles = args.includes('--check-cycles');
  
  console.log('[Dependency Analysis] Starting...');
  console.log(`[Dependency Analysis] Format: ${format}`);
  
  // 执行分析
  const analyzer = new DependencyAnalyzer();
  const result = await analyzer.analyzeAll();
  
  console.log(`[Dependency Analysis] Found ${result.dependencies.length} dependencies`);
  console.log(`[Dependency Analysis] Found ${result.cycles.length} cycles`);
  
  // 生成输出
  let output;
  
  if (format === 'mermaid') {
    output = analyzer.generateMermaidGraph();
  } else if (format === 'dot') {
    output = analyzer.generateDotGraph();
  } else {
    output = JSON.stringify(result, null, 2);
  }
  
  // 写入文件或输出到控制台
  if (outputFile) {
    await fs.writeFile(outputFile, output, 'utf8');
    console.log(`[Dependency Analysis] Output written to: ${outputFile}`);
  } else {
    console.log('\n' + output);
  }
  
  // 循环依赖检查
  if (checkCycles) {
    if (result.cycles.length > 0) {
      console.error('\n[Dependency Analysis] ❌ CIRCULAR DEPENDENCIES DETECTED:');
      result.cycles.forEach((cycle, i) => {
        console.error(`  Cycle ${i + 1}: ${cycle.join(' → ')}`);
      });
      
      // 生成报告文件
      const reportPath = path.join(__dirname, '../dependency-report.json');
      await fs.writeFile(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        status: 'FAILED',
        cycles: result.cycles,
        dependencies: result.dependencies,
        startupOrder: result.startupOrder
      }, null, 2));
      
      console.error(`\nReport saved to: ${reportPath}`);
      process.exit(1);
    } else {
      console.log('\n[Dependency Analysis] ✅ No circular dependencies detected');
      
      // 生成报告文件
      const reportPath = path.join(__dirname, '../dependency-report.json');
      await fs.writeFile(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        status: 'OK',
        cycles: [],
        dependencies: result.dependencies,
        startupOrder: result.startupOrder
      }, null, 2));
      
      console.log(`Report saved to: ${reportPath}`);
      process.exit(0);
    }
  }
}

main().catch(err => {
  console.error('[Dependency Analysis] Error:', err);
  process.exit(1);
});
