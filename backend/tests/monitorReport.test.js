/**
 * backend/tests/monitorReport.test.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 单元测试
 */

'use strict';

const { describe, it, beforeEach } = require('mocha');
const { expect } = require('chai');
const MonitorDataCollector = require('../shared/monitorReport/MonitorDataCollector');
const MonitorSummaryGenerator = require('../shared/monitorReport/MonitorSummaryGenerator');
const ReportGenerator = require('../shared/monitorReport/ReportGenerator');

describe('MonitorReportSystem', () => {
  
  describe('MonitorSummaryGenerator', () => {
    let generator;
    
    beforeEach(() => {
      generator = new MonitorSummaryGenerator();
    });
    
    it('should calculate health score correctly', () => {
      const data = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.01,
              responseTimeP99: 500,
              cpuUsage: 0.5,
              memoryUsage: 0.6
            },
            status: 'healthy'
          }
        },
        anomalies: [],
        systemHealth: { overall: 'healthy' }
      };
      
      const score = generator.calculateHealthScore(data);
      expect(score).to.be.a('number');
      expect(score).to.be.at.least(0);
      expect(score).to.be.at.most(100);
    });
    
    it('should deduct score for high error rate', () => {
      const healthyData = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.01,
              responseTimeP99: 500,
              cpuUsage: 0.3,
              memoryUsage: 0.4
            },
            status: 'healthy'
          }
        },
        anomalies: [],
        systemHealth: { overall: 'healthy' }
      };
      
      const errorData = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.10, // 10% 错误率
              responseTimeP99: 500,
              cpuUsage: 0.3,
              memoryUsage: 0.4
            },
            status: 'critical'
          }
        },
        anomalies: [],
        systemHealth: { overall: 'healthy' }
      };
      
      const healthyScore = generator.calculateHealthScore(healthyData);
      const errorScore = generator.calculateHealthScore(errorData);
      
      expect(healthyScore).to.be.greaterThan(errorScore);
    });
    
    it('should determine overall status correctly', () => {
      const healthyData = {
        services: {
          'gateway': { status: 'healthy' }
        },
        anomalies: []
      };
      
      const criticalData = {
        services: {
          'gateway': { status: 'critical' }
        },
        anomalies: [
          { severity: 'critical' }
        ]
      };
      
      const warningData = {
        services: {
          'gateway': { status: 'warning' }
        },
        anomalies: [
          { severity: 'warning' }
        ]
      };
      
      expect(generator.determineOverallStatus(95, healthyData)).to.equal('healthy');
      expect(generator.determineOverallStatus(50, criticalData)).to.equal('critical');
      expect(generator.determineOverallStatus(70, warningData)).to.equal('warning');
    });
    
    it('should generate service summary', () => {
      const data = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.01,
              responseTimeP99: 500,
              cpuUsage: 0.3
            },
            status: 'healthy'
          },
          'user-service': {
            metrics: {
              errorRate: 0.03,
              responseTimeP99: 2000,
              cpuUsage: 0.8
            },
            status: 'warning'
          }
        }
      };
      
      const summary = generator.generateServiceSummary(data);
      
      expect(summary.total).to.equal(2);
      expect(summary.healthy).to.equal(1);
      expect(summary.warning).to.equal(1);
    });
    
    it('should identify critical issues', () => {
      const data = {
        services: {
          'payment-service': {
            metrics: {
              errorRate: 0.10,
              responseTimeP99: 5000,
              cpuUsage: 0.95
            },
            status: 'critical'
          }
        },
        anomalies: [
          { severity: 'critical', service: 'gateway', message: 'High error rate' }
        ],
        resourceUsage: {
          cpuUsage: 0.95
        }
      };
      
      const issues = generator.identifyCriticalIssues(data);
      
      expect(issues).to.be.an('array');
      expect(issues.length).to.be.greaterThan(0);
    });
    
    it('should detect changes between periods', () => {
      const currentData = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.05,
              responseTimeP99: 1500
            }
          }
        },
        businessMetrics: {
          catchRate: 0.75
        }
      };
      
      const previousData = {
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.02,
              responseTimeP99: 1000
            }
          }
        },
        businessMetrics: {
          catchRate: 0.70
        }
      };
      
      const changes = generator.detectChanges(currentData, previousData);
      
      expect(changes).to.be.an('array');
      expect(changes.some(c => c.type === 'error_rate_change')).to.be.true;
    });
    
    it('should generate recommendations based on issues', () => {
      const summary = {
        healthScore: 50,
        criticalIssues: [
          { type: 'service_critical', service: 'payment-service', message: 'Critical error rate' }
        ],
        warnings: [],
        trends: [
          { type: 'latency_increasing', service: 'gateway', message: 'Latency increasing' }
        ]
      };
      
      const recommendations = generator.generateRecommendations(summary);
      
      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
      expect(recommendations.some(r => r.priority === 'high')).to.be.true;
    });
  });
  
  describe('ReportGenerator', () => {
    let reporter;
    
    beforeEach(() => {
      reporter = new ReportGenerator();
    });
    
    it('should generate markdown report', async () => {
      const summary = {
        healthScore: 85,
        overallStatus: 'healthy',
        serviceSummary: {
          total: 2,
          healthy: 2,
          warning: 0,
          critical: 0,
          topIssues: []
        },
        keyFindings: [
          { type: 'system_health', message: '系统整体健康状态：healthy', severity: 'info' }
        ],
        criticalIssues: [],
        warnings: [],
        changes: [],
        trends: [],
        recommendations: [],
        resourceSummary: {
          cpu: { value: 0.45, status: 'healthy' },
          memory: { value: 0.60, status: 'healthy' }
        },
        businessSummary: {
          catchRate: { value: 0.75, attempts: 1000, success: 750 },
          gymBattles: 500,
          paymentTransactions: 100
        }
      };
      
      const rawData = {
        timeRange: {
          start: new Date(Date.now() - 24 * 60 * 60 * 1000),
          end: new Date()
        },
        services: {
          'gateway': {
            metrics: {
              errorRate: 0.01,
              responseTimeP99: 500,
              cpuUsage: 0.4
            },
            status: 'healthy'
          }
        },
        anomalies: []
      };
      
      const report = await reporter.generateReport('daily', summary, rawData, 'markdown');
      
      expect(report).to.be.a('string');
      expect(report).to.include('mineGo 监控报告');
      expect(report).to.include('健康评分');
      expect(report).to.include('85');
    });
    
    it('should generate html report', async () => {
      const summary = {
        healthScore: 75,
        overallStatus: 'warning',
        serviceSummary: {
          total: 1,
          healthy: 0,
          warning: 1,
          critical: 0,
          topIssues: []
        },
        keyFindings: [],
        criticalIssues: [],
        warnings: [{ type: 'resource', resource: 'cpu', message: 'CPU usage high' }],
        changes: [],
        trends: [],
        recommendations: [{ priority: 'medium', message: 'Optimize CPU usage' }]
      };
      
      const rawData = {
        timeRange: {
          start: new Date(),
          end: new Date()
        },
        services: {},
        anomalies: []
      };
      
      const report = await reporter.generateReport('daily', summary, rawData, 'html');
      
      expect(report).to.be.a('string');
      expect(report).to.include('<!DOCTYPE html>');
      expect(report).to.include('mineGo 监控报告');
    });
    
    it('should generate json report', async () => {
      const summary = {
        healthScore: 90,
        overallStatus: 'healthy',
        serviceSummary: { total: 1, healthy: 1, warning: 0, critical: 0 },
        keyFindings: [],
        criticalIssues: [],
        warnings: [],
        changes: [],
        trends: [],
        recommendations: []
      };
      
      const rawData = {
        timeRange: { start: new Date(), end: new Date() },
        services: {},
        anomalies: []
      };
      
      const report = await reporter.generateReport('daily', summary, rawData, 'json');
      const parsed = JSON.parse(report);
      
      expect(parsed).to.be.an('object');
      expect(parsed.reportType).to.equal('daily');
      expect(parsed.summary.healthScore).to.equal(90);
    });
    
    it('should get correct status emoji', () => {
      expect(reporter.getStatusEmoji('healthy')).to.equal('✅');
      expect(reporter.getStatusEmoji('warning')).to.equal('⚠️');
      expect(reporter.getStatusEmoji('critical')).to.equal('🚨');
    });
    
    it('should get correct health color', () => {
      expect(reporter.getHealthColor(90)).to.equal('#27ae60');
      expect(reporter.getHealthColor(70)).to.equal('#f39c12');
      expect(reporter.getHealthColor(40)).to.equal('#e74c3c');
    });
    
    it('should get correct report title', () => {
      expect(reporter.getReportTitle('daily')).to.include('每日');
      expect(reporter.getReportTitle('weekly')).to.include('每周');
      expect(reporter.getReportTitle('incident')).to.include('异常');
    });
  });
  
  describe('MonitorDataCollector', () => {
    let collector;
    
    beforeEach(() => {
      collector = new MonitorDataCollector({
        prometheusUrl: 'http://prometheus:9090',
        healthCheckUrl: 'http://gateway:3000/health'
      });
    });
    
    it('should get correct duration string', () => {
      const hourRange = {
        start: new Date(Date.now() - 1 * 60 * 60 * 1000),
        end: new Date()
      };
      expect(collector.getDuration(hourRange)).to.equal('1h');
      
      const dayRange = {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000),
        end: new Date()
      };
      expect(collector.getDuration(dayRange)).to.equal('1d');
      
      const minuteRange = {
        start: new Date(Date.now() - 30 * 60 * 1000),
        end: new Date()
      };
      expect(collector.getDuration(minuteRange)).to.equal('30m');
    });
    
    it('should evaluate service status correctly', () => {
      const healthyMetrics = {
        errorRate: 0.01,
        responseTimeP99: 500,
        cpuUsage: 0.3,
        memoryUsage: 0.4
      };
      expect(collector.evaluateServiceStatus(healthyMetrics)).to.equal('healthy');
      
      const warningMetrics = {
        errorRate: 0.03,
        responseTimeP99: 1600,
        cpuUsage: 0.75,
        memoryUsage: 0.5
      };
      expect(collector.evaluateServiceStatus(warningMetrics)).to.equal('warning');
      
      const criticalMetrics = {
        errorRate: 0.10,
        responseTimeP99: 4000,
        cpuUsage: 0.95,
        memoryUsage: 0.95
      };
      expect(collector.evaluateServiceStatus(criticalMetrics)).to.equal('critical');
    });
    
    it('should parse prometheus value correctly', () => {
      const validData = {
        result: [{ value: [1234567890, '0.123'] }]
      };
      expect(collector.parsePrometheusValue(validData)).to.equal(0.123);
      
      const emptyData = { result: [] };
      expect(collector.parsePrometheusValue(emptyData)).to.equal(0);
      
      const nullData = null;
      expect(collector.parsePrometheusValue(nullData)).to.equal(0);
    });
  });
});