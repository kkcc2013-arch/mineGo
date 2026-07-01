/**
 * 快照差异报告生成器
 * 生成 HTML 和 CLI 格式的差异报告
 */

const fs = require('fs');
const path = require('path');

class SnapshotDiffReporter {
  constructor(config = {}) {
    this.outputDir = config.outputDir || path.join(__dirname, '../tests/snapshots/reports');
  }

  /**
   * 格式化单个差异项
   */
  formatDiffItem(diff) {
    switch (diff.type) {
      case 'field_missing':
        return `❌ 字段缺失: ${diff.path}`;
      case 'field_added':
        return `➕ 字段新增: ${diff.path}`;
      case 'type_mismatch':
        return `⚠️ 类型不匹配: ${diff.path} (期望: ${diff.expectedType}, 实际: ${diff.actualType})`;
      case 'value_mismatch':
        return `🔄 值不匹配: ${diff.path}`;
      case 'array_length_mismatch':
        return `📊 数组长度不匹配: ${diff.path} (期望: ${diff.expectedLength}, 实际: ${diff.actualLength})`;
      default:
        return `❓ 未知差异: ${diff.path}`;
    }
  }

  /**
   * 获取差异严重级别
   */
  getSeverity(diff) {
    switch (diff.type) {
      case 'field_missing':
      case 'type_mismatch':
        return 'error';
      case 'field_added':
        return 'warning';
      case 'value_mismatch':
      case 'array_length_mismatch':
        return 'info';
      default:
        return 'info';
    }
  }

  /**
   * 生成 CLI 报告
   */
  generateCliReport(results) {
    const lines = [];
    
    lines.push('');
    lines.push('╔════════════════════════════════════════════════════════════╗');
    lines.push('║           API 快照差异报告                                  ║');
    lines.push('╚════════════════════════════════════════════════════════════╝');
    lines.push('');
    
    // 统计摘要
    const totalApis = results.length;
    const matchedApis = results.filter(r => r.status === 'match').length;
    const diffApis = results.filter(r => r.status === 'diff').length;
    const missingApis = results.filter(r => r.status === 'missing').length;
    
    lines.push(`📊 统计摘要:`);
    lines.push(`   总计: ${totalApis} 个 API`);
    lines.push(`   ✅ 匹配: ${matchedApis}`);
    lines.push(`   ❌ 差异: ${diffApis}`);
    lines.push(`   ⚠️  缺失: ${missingApis}`);
    lines.push('');
    
    // 差异详情
    if (diffApis > 0) {
      lines.push('🔍 差异详情:');
      lines.push('─'.repeat(60));
      
      for (const result of results.filter(r => r.status === 'diff')) {
        lines.push('');
        lines.push(`📡 ${result.apiPath} (${result.method})`);
        lines.push(`   差异数量: ${result.diffCount}`);
        lines.push(`   Breaking Changes: ${result.breakingChanges}`);
        
        for (const diff of result.diff) {
          const severity = this.getSeverity(diff);
          const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : 'ℹ️';
          lines.push(`   ${icon} ${this.formatDiffItem(diff)}`);
        }
      }
      lines.push('');
    }
    
    // 缺失快照
    if (missingApis > 0) {
      lines.push('⚠️  缺失快照的 API:');
      lines.push('─'.repeat(60));
      
      for (const result of results.filter(r => r.status === 'missing')) {
        lines.push(`   - ${result.apiPath} (${result.method})`);
      }
      lines.push('');
    }
    
    // 建议
    if (diffApis > 0 || missingApis > 0) {
      lines.push('💡 建议操作:');
      lines.push('─'.repeat(60));
      
      if (diffApis > 0) {
        lines.push('   1. 检查差异是否为预期变更');
        lines.push('   2. 如需更新快照，运行: npm run test:snapshot -- --update');
        lines.push('   3. 如为 Breaking Change，请更新客户端代码');
      }
      
      if (missingApis > 0) {
        lines.push('   4. 新增 API 需要捕获快照');
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * 生成 HTML 报告
   */
  generateHtmlReport(results, options = {}) {
    const timestamp = new Date().toISOString();
    
    // 统计
    const totalApis = results.length;
    const matchedApis = results.filter(r => r.status === 'match').length;
    const diffApis = results.filter(r => r.status === 'diff').length;
    const missingApis = results.filter(r => r.status === 'missing').length;
    const coverage = totalApis > 0 ? ((matchedApis / totalApis) * 100).toFixed(2) : '0.00';
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 快照差异报告 - mineGo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      color: #333;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .header .timestamp { opacity: 0.8; font-size: 14px; }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .stat-card .value { font-size: 32px; font-weight: bold; color: #333; }
    .stat-card .label { color: #666; font-size: 14px; margin-top: 5px; }
    .stat-card.success .value { color: #10b981; }
    .stat-card.error .value { color: #ef4444; }
    .stat-card.warning .value { color: #f59e0b; }
    .stat-card.info .value { color: #3b82f6; }
    
    .section {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .section h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
    }
    
    .diff-item {
      border: 1px solid #eee;
      border-radius: 6px;
      margin-bottom: 15px;
      overflow: hidden;
    }
    .diff-header {
      background: #f9fafb;
      padding: 12px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .diff-header .api-info { font-weight: 500; }
    .diff-header .badges { display: flex; gap: 8px; }
    .badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge.error { background: #fee2e2; color: #991b1b; }
    .badge.warning { background: #fef3c7; color: #92400e; }
    
    .diff-body { padding: 15px; }
    .diff-row {
      display: flex;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .diff-row:last-child { border-bottom: none; }
    .diff-row .icon { width: 24px; text-align: center; }
    .diff-row .path { flex: 1; font-family: monospace; }
    .diff-row .detail { color: #666; font-size: 13px; }
    
    .missing-list { list-style: none; }
    .missing-list li {
      padding: 10px;
      background: #fef3c7;
      margin-bottom: 8px;
      border-radius: 4px;
      display: flex;
      justify-content: space-between;
    }
    
    .coverage-bar {
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 10px;
    }
    .coverage-bar .fill {
      height: 100%;
      background: linear-gradient(90deg, #10b981, #34d399);
      width: ${coverage}%;
    }
    
    .footer {
      text-align: center;
      color: #666;
      font-size: 13px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 API 快照差异报告</h1>
      <div class="timestamp">生成时间: ${timestamp}</div>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card info">
        <div class="value">${totalApis}</div>
        <div class="label">总计 API</div>
      </div>
      <div class="stat-card success">
        <div class="value">${matchedApis}</div>
        <div class="label">✅ 快照匹配</div>
      </div>
      <div class="stat-card error">
        <div class="value">${diffApis}</div>
        <div class="label">❌ 存在差异</div>
      </div>
      <div class="stat-card warning">
        <div class="value">${missingApis}</div>
        <div class="label">⚠️ 缺失快照</div>
      </div>
    </div>
    
    ${diffApis > 0 ? `
    <div class="section">
      <h2>🔍 差异详情</h2>
      ${results.filter(r => r.status === 'diff').map(result => `
        <div class="diff-item">
          <div class="diff-header">
            <div class="api-info">
              <strong>${result.apiPath}</strong>
              <span style="color: #666; margin-left: 10px;">${result.method}</span>
            </div>
            <div class="badges">
              <span class="badge error">${result.diffCount} 个差异</span>
              ${result.breakingChanges > 0 ? `<span class="badge warning">${result.breakingChanges} Breaking Changes</span>` : ''}
            </div>
          </div>
          <div class="diff-body">
            ${result.diff.map(d => `
              <div class="diff-row">
                <div class="icon">${this.getSeverity(d) === 'error' ? '❌' : this.getSeverity(d) === 'warning' ? '⚠️' : 'ℹ️'}</div>
                <div class="path">${d.path}</div>
                <div class="detail">${this.formatDiffItem(d)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}
    
    ${missingApis > 0 ? `
    <div class="section">
      <h2>⚠️ 缺失快照</h2>
      <ul class="missing-list">
        ${results.filter(r => r.status === 'missing').map(r => `
          <li>
            <span>${r.apiPath} (${r.method})</span>
            <span style="color: #666;">需要首次捕获</span>
          </li>
        `).join('')}
      </ul>
    </div>
    ` : ''}
    
    <div class="section">
      <h2>📈 覆盖率</h2>
      <div style="font-size: 24px; font-weight: bold; color: #333;">
        ${coverage}%
      </div>
      <div class="coverage-bar">
        <div class="fill"></div>
      </div>
      <p style="margin-top: 10px; color: #666; font-size: 14px;">
        ${matchedApis} / ${totalApis} API 快照匹配成功
      </p>
    </div>
    
    <div class="footer">
      <p>mineGo API 快照测试系统 | 自动生成报告</p>
      <p style="margin-top: 5px;">如有问题，请运行 <code>npm run test:snapshot -- --update</code> 更新快照</p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * 保存报告到文件
   */
  async saveReport(results, format = 'html') {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `snapshot-report-${timestamp}.${format}`;
    const filepath = path.join(this.outputDir, filename);
    
    const content = format === 'html' 
      ? this.generateHtmlReport(results)
      : this.generateCliReport(results);
    
    await fs.promises.writeFile(filepath, content, 'utf-8');
    
    return { path: filepath, filename };
  }

  /**
   * 生成 JSON 格式的差异报告
   */
  generateJsonReport(results) {
    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        matched: results.filter(r => r.status === 'match').length,
        diff: results.filter(r => r.status === 'diff').length,
        missing: results.filter(r => r.status === 'missing').length,
        breakingChanges: results.reduce((sum, r) => sum + (r.breakingChanges || 0), 0)
      },
      results: results.map(r => ({
        apiPath: r.apiPath,
        method: r.method,
        status: r.status,
        diffCount: r.diffCount || 0,
        breakingChanges: r.breakingChanges || 0,
        diff: r.diff || []
      }))
    };
  }
}

module.exports = { SnapshotDiffReporter };
