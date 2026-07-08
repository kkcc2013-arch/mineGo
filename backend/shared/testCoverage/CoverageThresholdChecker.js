'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('coverage-threshold');

/**
 * 覆盖率阈值检查器
 * 检查覆盖率是否满足配置的阈值要求
 */
class CoverageThresholdChecker {
  constructor(options = {}) {
    this.defaultThreshold = {
      lines: options.minLines || 60,
      statements: options.minStatements || 60,
      functions: options.minFunctions || 50,
      branches: options.minBranches || 40
    };

    this.serviceThresholds = {
      'payment-service': { lines: 80, statements: 80, functions: 80, branches: 70 },
      'catch-service': { lines: 70, statements: 70, functions: 70, branches: 60 },
      'user-service': { lines: 60, statements: 60, functions: 60, branches: 50 },
      'pokemon-service': { lines: 60, statements: 60, functions: 60, branches: 50 },
      'reward-service': { lines: 60, statements: 60, functions: 60, branches: 50 }
    };
  }

  /**
   * 检查覆盖率是否满足阈值
   * @param {object} coverageData - 覆盖率数据
   * @returns {object} 检查结果
   */
  async check(coverageData) {
    const startTime = Date.now();
    const results = {
      total: null,
      services: {},
      passes: true,
      failures: []
    };

    // 检查总覆盖率
    if (coverageData.total) {
      const totalCheck = this.checkThreshold('total', coverageData.total, this.defaultThreshold);
      results.total = totalCheck;
      if (!totalCheck.passes) {
        results.passes = false;
        results.failures.push({
          scope: 'total',
          ...totalCheck.failureDetails
        });
      }
    }

    // 检查各服务覆盖率
    if (coverageData.services) {
      for (const [service, data] of Object.entries(coverageData.services)) {
        if (data.error) {
          results.services[service] = {
            passes: false,
            error: data.error,
            message: `Coverage data unavailable for ${service}`
          };
          continue;
        }

        const threshold = this.getServiceThreshold(service);
        const serviceCheck = this.checkThreshold(service, data, threshold);
        results.services[service] = serviceCheck;

        if (!serviceCheck.passes) {
          results.passes = false;
          results.failures.push({
            scope: service,
            ...serviceCheck.failureDetails
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info({
      passes: results.passes,
      failures: results.failures.length,
      duration
    }, 'Threshold check completed');

    return {
      ...results,
      threshold: this.defaultThreshold,
      serviceThresholds: this.serviceThresholds,
      duration,
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * 检查单个范围是否满足阈值
   */
  checkThreshold(scope, data, threshold) {
    const failures = [];
    const details = {
      lines: { value: data.lines || 0, threshold: threshold.lines, passes: true },
      statements: { value: data.statements || 0, threshold: threshold.statements, passes: true },
      functions: { value: data.functions || 0, threshold: threshold.functions, passes: true },
      branches: { value: data.branches || 0, threshold: threshold.branches, passes: true }
    };

    // 检查各项指标
    for (const [metric, detail] of Object.entries(details)) {
      if (detail.value < detail.threshold) {
        detail.passes = false;
        failures.push({
          metric,
          value: detail.value,
          threshold: detail.threshold,
          gap: detail.threshold - detail.value
        });
      }
    }

    const passes = failures.length === 0;

    return {
      scope,
      passes,
      details,
      failureDetails: failures.length > 0 ? failures : null,
      summary: this.formatSummary(scope, details)
    };
  }

  /**
   * 获取服务特定阈值
   */
  getServiceThreshold(service) {
    return this.serviceThresholds[service] || this.defaultThreshold;
  }

  /**
   * 设置服务阈值
   */
  setServiceThreshold(service, threshold) {
    this.serviceThresholds[service] = {
      ...this.defaultThreshold,
      ...threshold
    };
    logger.info({ service, threshold }, 'Service threshold updated');
  }

  /**
   * 格式化摘要
   */
  formatSummary(scope, details) {
    const statusEmoji = (passes) => passes ? '✅' : '❌';

    return {
      scope,
      lines: `${statusEmoji(details.lines.passes)} Lines: ${details.lines.value.toFixed(1)}% (threshold: ${details.lines.threshold}%)`,
      functions: `${statusEmoji(details.functions.passes)} Functions: ${details.functions.value.toFixed(1)}% (threshold: ${details.functions.threshold}%)`,
      branches: `${statusEmoji(details.branches.passes)} Branches: ${details.branches.value.toFixed(1)}% (threshold: ${details.branches.threshold}%)`
    };
  }

  /**
   * 生成检查报告
   */
  generateReport(result) {
    const lines = [];

    lines.push('# Coverage Threshold Check Report');
    lines.push('');
    lines.push(`**Status:** ${result.passes ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push('');
    lines.push(`**Checked at:** ${result.checkedAt}`);
    lines.push('');

    // 总覆盖率
    if (result.total) {
      lines.push('## Total Coverage');
      lines.push('');
      lines.push(result.total.summary.lines);
      lines.push(result.total.summary.functions);
      lines.push(result.total.summary.branches);
      lines.push('');
    }

    // 各服务覆盖率
    if (Object.keys(result.services).length > 0) {
      lines.push('## Service Coverage');
      lines.push('');

      for (const [service, check] of Object.entries(result.services)) {
        if (check.error) {
          lines.push(`### ${service}`);
          lines.push(`⚠️ ${check.message}`);
          lines.push('');
          continue;
        }

        lines.push(`### ${service}`);
        lines.push(check.summary.lines);
        lines.push(check.summary.functions);
        lines.push(check.summary.branches);
        lines.push('');
      }
    }

    // 失败详情
    if (result.failures.length > 0) {
      lines.push('## Failures');
      lines.push('');

      for (const failure of result.failures) {
        lines.push(`### ${failure.scope}`);
        lines.push('');

        for (const detail of failure.failureDetails || [failure]) {
          lines.push(`- **${detail.metric}:** ${detail.value.toFixed(1)}% < ${detail.threshold}% (gap: ${detail.gap?.toFixed(1) || 'N/A'}%)`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 生成 CLI 输出
   */
  generateCliOutput(result) {
    const emoji = result.passes ? '✅' : '❌';
    const color = result.passes ? '\x1b[32m' : '\x1b[31m';

    let output = `${color}${emoji} Coverage Threshold Check${result.passes ? ' PASSED' : ' FAILED'}\x1b[0m\n\n`;

    if (result.total) {
      const t = result.total.details;
      output += `Total Coverage:\n`;
      output += `  Lines:      ${this.formatMetric(t.lines)}\n`;
      output += `  Functions:  ${this.formatMetric(t.functions)}\n`;
      output += `  Branches:   ${this.formatMetric(t.branches)}\n\n`;
    }

    if (result.failures.length > 0) {
      output += '\x1b[31mFailures:\x1b[0m\n';
      for (const f of result.failures) {
        output += `  - ${f.scope}: ${f.failureDetails?.map(d => `${d.metric} (${d.value.toFixed(1)}%)`).join(', ') || 'missing'}\n`;
      }
    }

    return output;
  }

  /**
   * 格式化指标显示
   */
  formatMetric(detail) {
    const status = detail.passes ? '\x1b[32m✅' : '\x1b[31m❌';
    return `${status} ${detail.value.toFixed(1)}% (min: ${detail.threshold}%)\x1b[0m`;
  }
}

module.exports = CoverageThresholdChecker;