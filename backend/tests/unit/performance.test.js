/**
 * 压力测试配置验证
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

describe('Performance Tests', () => {
  const perfDir = path.join(__dirname, '../performance');

  describe('配置文件', () => {
    it('应该存在 config.js', () => {
      const configPath = path.join(perfDir, 'config.js');
      assert.ok(fs.existsSync(configPath), 'config.js 不存在');
    });

    it('配置应包含 SLA 定义', () => {
      const config = require(path.join(perfDir, 'config.js'));
      
      assert.ok(config.sla, '缺少 sla 定义');
      assert.ok(config.sla['auth/login'], '缺少 auth/login SLA');
      assert.ok(config.sla['catch/attempt'], '缺少 catch/attempt SLA');
      assert.ok(config.sla['gym/battle'], '缺少 gym/battle SLA');
      assert.ok(config.sla['payment/create'], '缺少 payment/create SLA');
    });

    it('SLA 应包含完整字段', () => {
      const config = require(path.join(perfDir, 'config.js'));
      
      const requiredFields = ['throughput', 'latencyP50', 'latencyP90', 'latencyP99', 'errorRate'];
      
      Object.entries(config.sla).forEach(([api, sla]) => {
        requiredFields.forEach(field => {
          assert.ok(sla[field] !== undefined, `${api} 缺少 ${field}`);
        });
      });
    });

    it('回归阈值应合理', () => {
      const config = require(path.join(perfDir, 'config.js'));
      
      assert.ok(config.regressionThresholds, '缺少 regressionThresholds');
      assert.ok(config.regressionThresholds.latencyIncrease > 0, 'latencyIncrease 应大于 0');
      assert.ok(config.regressionThresholds.latencyIncrease < 1, 'latencyIncrease 应小于 1');
      assert.ok(config.regressionThresholds.throughputDecrease > 0, 'throughputDecrease 应大于 0');
    });
  });

  describe('测试脚本', () => {
    const testScripts = [
      'auth-stress.js',
      'catch-stress.js',
      'gym-stress.js',
      'payment-stress.js',
      'comprehensive-stress.js'
    ];

    testScripts.forEach(script => {
      it(`应该存在 ${script}`, () => {
        const scriptPath = path.join(perfDir, script);
        assert.ok(fs.existsSync(scriptPath), `${script} 不存在`);
      });

      it(`${script} 应包含测试配置`, () => {
        const scriptPath = path.join(perfDir, script);
        const content = fs.readFileSync(scriptPath, 'utf-8');
        
        assert.ok(content.includes('export const options'), `${script} 缺少 options 导出`);
        assert.ok(content.includes('thresholds'), `${script} 缺少 thresholds 配置`);
      });
    });
  });

  describe('报告生成器', () => {
    it('应该存在 report-generator.js', () => {
      const reportPath = path.join(perfDir, 'report-generator.js');
      assert.ok(fs.existsSync(reportPath), 'report-generator.js 不存在');
    });

    it('报告生成器应可执行', () => {
      const reportPath = path.join(perfDir, 'report-generator.js');
      const content = fs.readFileSync(reportPath, 'utf-8');
      
      assert.ok(content.includes('generateReport'), '缺少 generateReport 函数');
      assert.ok(content.includes('parseK6Output'), '缺少 parseK6Output 函数');
    });
  });

  describe('运行脚本', () => {
    it('应该存在 run-performance-tests.sh', () => {
      const scriptPath = path.join(perfDir, 'run-performance-tests.sh');
      assert.ok(fs.existsSync(scriptPath), 'run-performance-tests.sh 不存在');
    });

    it('运行脚本应有执行权限', () => {
      const scriptPath = path.join(perfDir, 'run-performance-tests.sh');
      const stats = fs.statSync(scriptPath);
      
      // 检查用户执行权限
      const mode = stats.mode & 0o111;
      assert.ok(mode !== 0, 'run-performance-tests.sh 没有执行权限');
    });
  });

  describe('CI/CD 集成', () => {
    it('应该存在 GitHub Actions 工作流', () => {
      const workflowPath = path.join(__dirname, '../../../.github/workflows/performance-tests.yml');
      assert.ok(fs.existsSync(workflowPath), 'performance-tests.yml 不存在');
    });

    it('工作流应包含定时触发', () => {
      const workflowPath = path.join(__dirname, '../../../.github/workflows/performance-tests.yml');
      const content = fs.readFileSync(workflowPath, 'utf-8');
      
      assert.ok(content.includes('schedule:'), '工作流缺少定时触发');
      assert.ok(content.includes('cron:'), '工作流缺少 cron 配置');
    });
  });

  describe('文档', () => {
    it('应该存在性能测试文档', () => {
      const docPath = path.join(__dirname, '../../../docs/performance/README.md');
      assert.ok(fs.existsSync(docPath), '性能测试文档不存在');
    });

    it('文档应包含关键内容', () => {
      const docPath = path.join(__dirname, '../../../docs/performance/README.md');
      const content = fs.readFileSync(docPath, 'utf-8');
      
      assert.ok(content.includes('快速开始'), '文档缺少快速开始章节');
      assert.ok(content.includes('性能 SLA'), '文档缺少 SLA 章节');
      assert.ok(content.includes('CI/CD'), '文档缺少 CI/CD 章节');
    });
  });
});
