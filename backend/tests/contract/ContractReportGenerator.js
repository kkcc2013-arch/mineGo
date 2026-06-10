'use strict';
/**
 * ContractReportGenerator - 契约测试报告生成器
 * 生成 Markdown 和 HTML 格式的测试报告
 */

const fs = require('fs').promises;
const path = require('path');

class ContractReportGenerator {
  constructor() {
    this.reports = [];
  }

  /**
   * 生成测试报告
   * @param {Object} results - 测试结果
   * @returns {Object}
   */
  generateReport(results) {
    const report = {
      timestamp: results.timestamp || new Date().toISOString(),
      summary: {
        total: results.total,
        passed: results.passed,
        failed: results.failed,
        skipped: results.skipped || 0,
        duration: results.duration,
        successRate: results.total > 0 
          ? ((results.passed / results.total) * 100).toFixed(2)
          : '0.00'
      },
      providers: results.providers?.map(provider => ({
        name: provider.provider,
        version: provider.version,
        total: provider.total,
        passed: provider.passed,
        failed: provider.failed,
        skipped: provider.skipped || 0,
        tests: provider.tests?.map(test => ({
          endpoint: test.endpoint,
          method: test.method,
          path: test.path,
          status: test.status,
          duration: test.duration,
          errors: test.errors
        }))
      }))
    };

    this.reports.push(report);
    return report;
  }

  /**
   * 生成 Markdown 报告
   * @param {Object} results - 测试结果
   * @param {string} outputPath - 输出路径
   */
  async generateMarkdownReport(results, outputPath) {
    const lines = [];

    lines.push(`# API Contract Test Report`);
    lines.push(``);
    lines.push(`**Generated**: ${results.timestamp || new Date().toISOString()}`);
    lines.push(`**Duration**: ${results.duration}ms`);
    lines.push(``);

    // 摘要表格
    lines.push(`## 📊 Summary`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Tests | ${results.total} |`);
    lines.push(`| Passed | ${results.passed} ✅ |`);
    lines.push(`| Failed | ${results.failed} ${results.failed > 0 ? '❌' : ''} |`);
    lines.push(`| Skipped | ${results.skipped || 0} ⏭️ |`);
    lines.push(`| Success Rate | ${results.total > 0 ? ((results.passed / results.total) * 100).toFixed(2) : 0}% |`);
    lines.push(``);

    // 结果状态
    if (results.failed === 0) {
      lines.push(`> ✅ **All contract tests passed!**`);
    } else {
      lines.push(`> ❌ **${results.failed} contract test(s) failed.**`);
    }
    lines.push(``);

    // 各服务详情
    if (results.providers) {
      for (const provider of results.providers) {
        const status = provider.failed === 0 ? '✅' : '❌';
        lines.push(`## ${status} ${provider.provider}`);
        
        if (provider.version) {
          lines.push(`**Version**: ${provider.version}`);
        }
        lines.push(``);
        
        lines.push(`| Endpoint | Method | Status | Duration | Errors |`);
        lines.push(`|----------|--------|--------|----------|--------|`);

        if (provider.tests) {
          for (const test of provider.tests) {
            const testStatus = test.status === 'passed' ? '✅' : 
                              test.status === 'failed' ? '❌' : '⏭️';
            const errors = test.errors?.length > 0 
              ? test.errors.map(e => `\`${e.type}\``).join(', ')
              : '-';
            lines.push(`| \`${test.path}\` | ${test.method} | ${testStatus} | ${test.duration}ms | ${errors} |`);
          }
        }
        lines.push(``);

        // 错误详情
        if (provider.tests) {
          const failedTests = provider.tests.filter(t => t.status === 'failed');
          if (failedTests.length > 0) {
            lines.push(`### Error Details`);
            lines.push(``);
            for (const test of failedTests) {
              lines.push(`#### \`${test.method} ${test.path}\``);
              lines.push(``);
              for (const error of test.errors) {
                lines.push(`- **${error.type}**: ${error.message || ''}`);
                if (error.details) {
                  lines.push(`  - Details: ${JSON.stringify(error.details)}`);
                }
                if (error.expected !== undefined && error.actual !== undefined) {
                  lines.push(`  - Expected: ${error.expected}`);
                  lines.push(`  - Actual: ${error.actual}`);
                }
              }
              lines.push(``);
            }
          }
        }
      }
    }

    await fs.writeFile(outputPath, lines.join('\n'));
    console.log(`[ContractReportGenerator] Markdown report saved: ${outputPath}`);
  }

  /**
   * 生成 HTML 报告
   * @param {Object} results - 测试结果
   * @param {string} outputPath - 输出路径
   */
  async generateHtmlReport(results, outputPath) {
    const successRate = results.total > 0 
      ? ((results.passed / results.total) * 100).toFixed(2) 
      : 0;
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Contract Test Report</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      color: #333;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #1a1a1a; margin-bottom: 10px; }
    .meta { color: #666; margin-bottom: 20px; }
    .summary {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      margin-top: 15px;
    }
    .summary-item { text-align: center; }
    .summary-value { font-size: 32px; font-weight: bold; }
    .summary-label { color: #666; font-size: 14px; }
    .pass { color: #22c55e; }
    .fail { color: #ef4444; }
    .skip { color: #f59e0b; }
    .provider {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
      overflow: hidden;
    }
    .provider-header {
      padding: 15px 20px;
      border-bottom: 1px solid #eee;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .provider-header h2 { margin: 0; font-size: 18px; }
    .provider-version { color: #666; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 20px; text-align: left; }
    th { background: #fafafa; font-weight: 600; }
    td { border-bottom: 1px solid #eee; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .error-badge { 
      background: #fee2e2; 
      color: #dc2626; 
      padding: 2px 8px; 
      border-radius: 4px; 
      font-size: 12px;
    }
    .status-pass { color: #22c55e; font-weight: bold; }
    .status-fail { color: #ef4444; font-weight: bold; }
    .status-skip { color: #f59e0b; }
    .all-passed {
      background: #dcfce7;
      border: 2px solid #22c55e;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      margin-bottom: 20px;
    }
    .all-passed h3 { color: #16a34a; margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📋 API Contract Test Report</h1>
    <div class="meta">
      Generated: ${results.timestamp || new Date().toISOString()} | Duration: ${results.duration}ms
    </div>

    <div class="summary">
      <h2>Summary</h2>
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-value">${results.total}</div>
          <div class="summary-label">Total Tests</div>
        </div>
        <div class="summary-item">
          <div class="summary-value pass">${results.passed}</div>
          <div class="summary-label">Passed ✅</div>
        </div>
        <div class="summary-item">
          <div class="summary-value fail">${results.failed}</div>
          <div class="summary-label">Failed ❌</div>
        </div>
        <div class="summary-item">
          <div class="summary-value skip">${results.skipped || 0}</div>
          <div class="summary-label">Skipped ⏭️</div>
        </div>
        <div class="summary-item">
          <div class="summary-value">${successRate}%</div>
          <div class="summary-label">Success Rate</div>
        </div>
      </div>
    </div>

    ${results.failed === 0 ? `
    <div class="all-passed">
      <h3>✅ All contract tests passed!</h3>
    </div>
    ` : ''}

    ${(results.providers || []).map(provider => `
    <div class="provider">
      <div class="provider-header">
        <span style="font-size: 24px;">${provider.failed === 0 ? '✅' : '❌'}</span>
        <h2>${provider.name}</h2>
        ${provider.version ? `<span class="provider-version">v${provider.version}</span>` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Method</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          ${(provider.tests || []).map(test => `
          <tr>
            <td><code>${test.path}</code></td>
            <td>${test.method}</td>
            <td class="status-${test.status}">${test.status === 'passed' ? '✅ Pass' : test.status === 'failed' ? '❌ Fail' : '⏭️ Skip'}</td>
            <td>${test.duration}ms</td>
            <td>${test.errors?.length > 0 ? test.errors.map(e => `<span class="error-badge">${e.type}</span>`).join(' ') : '-'}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    `).join('')}
  </div>
</body>
</html>`;

    await fs.writeFile(outputPath, html);
    console.log(`[ContractReportGenerator] HTML report saved: ${outputPath}`);
  }

  /**
   * 生成 JUnit XML 报告（用于 CI）
   * @param {Object} results - 测试结果
   * @param {string} outputPath - 输出路径
   */
  async generateJUnitReport(results, outputPath) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Contract Tests" tests="${results.total}" failures="${results.failed}" skipped="${results.skipped || 0}" time="${results.duration / 1000}">
`;

    for (const provider of results.providers || []) {
      xml += `  <testsuite name="${provider.provider}" tests="${provider.total}" failures="${provider.failed}" skipped="${provider.skipped || 0}">
`;
      
      for (const test of provider.tests || []) {
        const className = `${provider.provider}.${test.method.toLowerCase()}`;
        const testName = test.path.replace(/[^a-zA-Z0-9]/g, '_');
        
        if (test.status === 'passed') {
          xml += `    <testcase classname="${className}" name="${testName}" time="${test.duration / 1000}"/>
`;
        } else if (test.status === 'skipped') {
          xml += `    <testcase classname="${className}" name="${testName}" time="${test.duration / 1000}"><skipped/></testcase>
`;
        } else {
          const errors = test.errors?.map(e => `${e.type}: ${e.message || ''}`).join('\n') || 'Unknown error';
          xml += `    <testcase classname="${className}" name="${testName}" time="${test.duration / 1000}">
      <failure message="${test.errors?.[0]?.type || 'Test failed'}"><![CDATA[${errors}]]></failure>
    </testcase>
`;
        }
      }
      
      xml += `  </testsuite>
`;
    }

    xml += `</testsuites>`;

    await fs.writeFile(outputPath, xml);
    console.log(`[ContractReportGenerator] JUnit report saved: ${outputPath}`);
  }
}

module.exports = ContractReportGenerator;
