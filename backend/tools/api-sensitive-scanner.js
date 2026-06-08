#!/usr/bin/env node

/**
 * REQ-00038: API 敏感字段扫描工具
 * 自动扫描所有 API 端点，检测敏感字段暴露
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');

const logger = createLogger('api-sensitive-scanner');

// ============================================================
// 配置
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const SERVICES_DIR = path.join(PROJECT_ROOT, 'backend/services');
const GATEWAY_DIR = path.join(PROJECT_ROOT, 'backend/gateway');

// 敏感字段定义
const SENSITIVE_FIELDS = {
  P0: ['password', 'payment_token', 'card_number', 'cvv', 'card_cvv', 'ssn', 'id_card_number'],
  P1: ['email', 'phone', 'real_name', 'address', 'billing_address', 'shipping_address', 'full_name', 'payment_info'],
  P2: ['birthday', 'gender', 'location_history', 'ip_address', 'device_id', 'last_login_ip', 'iv_values', 'shiny_rate'],
  P3: ['user_id', 'username', 'avatar', 'nickname', 'display_name'],
};

// 反向映射
const FIELD_LEVEL_MAP = {};
Object.entries(SENSITIVE_FIELDS).forEach(([level, fields]) => {
  fields.forEach(f => FIELD_LEVEL_MAP[f.toLowerCase()] = level);
});

// 扫描结果
const scanResults = {
  scannedFiles: 0,
  scannedRoutes: 0,
  issues: [],
  warnings: [],
  info: [],
};

// ============================================================
// 扫描函数
// ============================================================

/**
 * 扫描目录中的所有路由文件
 */
function scanDirectory(dir, serviceName = '') {
  if (!fs.existsSync(dir)) {
    logger.warn(`Directory not found: ${dir}`);
    return;
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      scanDirectory(fullPath, serviceName || entry.name);
    } else if (entry.isFile() && isRouteFile(entry.name)) {
      scanRouteFile(fullPath, serviceName);
    }
  }
}

/**
 * 判断是否为路由文件
 */
function isRouteFile(filename) {
  return /\.(js|ts)$/.test(filename) && 
         (filename.includes('route') || 
          filename.includes('controller') ||
          filename === 'index.js' ||
          filename.includes('api'));
}

/**
 * 扫描单个路由文件
 */
function scanRouteFile(filePath, serviceName) {
  scanResults.scannedFiles++;
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  // 查找所有 API 路由定义
  const routePatterns = [
    /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  ];
  
  lines.forEach((line, lineIndex) => {
    routePatterns.forEach(pattern => {
      let match;
      pattern.lastIndex = 0;
      
      while ((match = pattern.exec(line)) !== null) {
        const method = match[1].toUpperCase();
        const route = match[2];
        
        scanResults.scannedRoutes++;
        
        // 扫描该路由附近的代码，查找敏感字段暴露
        const contextStart = Math.max(0, lineIndex - 5);
        const contextEnd = Math.min(lines.length - 1, lineIndex + 20);
        const context = lines.slice(contextStart, contextEnd).join('\n');
        
        detectSensitiveFieldExposure(filePath, lineIndex + 1, method, route, context, serviceName);
      }
    });
  });
  
  // 扫描响应对象中的敏感字段
  detectSensitiveFieldsInResponses(filePath, content, serviceName);
}

/**
 * 检测敏感字段暴露
 */
function detectSensitiveFieldExposure(filePath, lineNum, method, route, context, serviceName) {
  // 检查响应中是否包含敏感字段
  for (const [field, level] of Object.entries(FIELD_LEVEL_MAP)) {
    // 查找字段返回模式
    const patterns = [
      new RegExp(`["']${field}["']\\s*:`),
      new RegExp(`\\.${field}\\s*[,;)]`),
      new RegExp(`res\\.json\\([^)]*${field}`),
      new RegExp(`return\\s*{[^}]*${field}`),
    ];
    
    for (const pattern of patterns) {
      if (pattern.test(context)) {
        const issue = {
          file: path.relative(PROJECT_ROOT, filePath),
          line: lineNum,
          method,
          route,
          field,
          level,
          service: serviceName,
          severity: getSeverity(level),
        };
        
        if (level === 'P0') {
          scanResults.issues.push({
            ...issue,
            message: `P0 级敏感字段 "${field}" 可能暴露在 ${method} ${route}`,
            recommendation: '该字段应完全移除或仅在系统服务间传递',
          });
        } else if (level === 'P1') {
          scanResults.warnings.push({
            ...issue,
            message: `P1 级敏感字段 "${field}" 可能暴露在 ${method} ${route}`,
            recommendation: '该字段应根据用户角色进行脱敏处理',
          });
        } else if (level === 'P2') {
          scanResults.info.push({
            ...issue,
            message: `P2 级敏感字段 "${field}" 存在于 ${method} ${route}`,
            recommendation: '考虑是否需要脱敏处理',
          });
        }
      }
    }
  }
}

/**
 * 检测响应对象中的敏感字段
 */
function detectSensitiveFieldsInResponses(filePath, content, serviceName) {
  // 查找 res.json() 调用
  const jsonPattern = /res\.json\s*\(\s*(\{[\s\S]*?\}|\w+)\s*\)/g;
  let match;
  
  while ((match = jsonPattern.exec(content)) !== null) {
    const responseObj = match[1];
    
    // 检查是否包含敏感字段
    for (const field of Object.keys(FIELD_LEVEL_MAP)) {
      if (new RegExp(`["']?${field}["']?\\s*:`).test(responseObj)) {
        scanResults.info.push({
          file: path.relative(PROJECT_ROOT, filePath),
          field,
          level: FIELD_LEVEL_MAP[field],
          service: serviceName,
          message: `在响应中发现字段 "${field}"`,
        });
      }
    }
  }
}

/**
 * 获取严重程度
 */
function getSeverity(level) {
  switch (level) {
    case 'P0': return 'CRITICAL';
    case 'P1': return 'HIGH';
    case 'P2': return 'MEDIUM';
    case 'P3': return 'LOW';
    default: return 'INFO';
  }
}

/**
 * 生成报告
 */
function generateReport(options = {}) {
  const { failOnP0 = true, failOnP1 = false } = options;
  
  console.log('\n' + '='.repeat(80));
  console.log('API 敏感字段扫描报告');
  console.log('='.repeat(80));
  console.log(`扫描时间: ${new Date().toISOString()}`);
  console.log(`扫描文件: ${scanResults.scannedFiles}`);
  console.log(`扫描路由: ${scanResults.scannedRoutes}`);
  
  // P0 问题
  if (scanResults.issues.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log(`❌ CRITICAL - 发现 ${scanResults.issues.length} 个 P0 级敏感字段暴露`);
    console.log('='.repeat(80));
    
    scanResults.issues.forEach((issue, i) => {
      console.log(`\n[${i + 1}] ${issue.message}`);
      console.log(`    文件: ${issue.file}:${issue.line}`);
      console.log(`    路由: ${issue.method} ${issue.route}`);
      console.log(`    服务: ${issue.service}`);
      console.log(`    建议: ${issue.recommendation}`);
    });
  }
  
  // P1 警告
  if (scanResults.warnings.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log(`⚠️  HIGH - 发现 ${scanResults.warnings.length} 个 P1 级敏感字段暴露`);
    console.log('='.repeat(80));
    
    scanResults.warnings.forEach((issue, i) => {
      console.log(`\n[${i + 1}] ${issue.message}`);
      console.log(`    文件: ${issue.file}:${issue.line}`);
      console.log(`    路由: ${issue.method} ${issue.route}`);
      console.log(`    建议: ${issue.recommendation}`);
    });
  }
  
  // P2 信息
  if (scanResults.info.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log(`ℹ️  INFO - 发现 ${scanResults.info.length} 个 P2 级敏感字段`);
    console.log('='.repeat(80));
    
    // 按字段分组
    const grouped = {};
    scanResults.info.forEach(item => {
      if (!grouped[item.field]) {
        grouped[item.field] = [];
      }
      grouped[item.field].push(item);
    });
    
    Object.entries(grouped).forEach(([field, items]) => {
      console.log(`\n- 字段 "${field}" (P2): 出现 ${items.length} 次`);
      const services = [...new Set(items.map(i => i.service).filter(Boolean))];
      if (services.length > 0) {
        console.log(`  涉及服务: ${services.join(', ')}`);
      }
    });
  }
  
  // 总结
  console.log('\n' + '='.repeat(80));
  console.log('总结');
  console.log('='.repeat(80));
  console.log(`✓ P0 级问题: ${scanResults.issues.length}`);
  console.log(`✓ P1 级警告: ${scanResults.warnings.length}`);
  console.log(`✓ P2 级信息: ${scanResults.info.length}`);
  
  // 退出码
  if (failOnP0 && scanResults.issues.length > 0) {
    console.log('\n❌ 扫描失败: 存在 P0 级敏感字段暴露');
    return 1;
  }
  
  if (failOnP1 && scanResults.warnings.length > 0) {
    console.log('\n⚠️  扫描警告: 存在 P1 级敏感字段暴露');
    return 1;
  }
  
  console.log('\n✅ 扫描通过');
  return 0;
}

/**
 * 保存报告到文件
 */
function saveReport(outputPath) {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      scannedFiles: scanResults.scannedFiles,
      scannedRoutes: scanResults.scannedRoutes,
      p0Issues: scanResults.issues.length,
      p1Warnings: scanResults.warnings.length,
      p2Info: scanResults.info.length,
    },
    issues: scanResults.issues,
    warnings: scanResults.warnings,
    info: scanResults.info,
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存到: ${outputPath}`);
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('开始扫描 API 敏感字段...\n');
  
  // 解析命令行参数
  const args = process.argv.slice(2);
  const failOnP0 = args.includes('--fail-on-p0');
  const failOnP1 = args.includes('--fail-on-p1');
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
  
  // 扫描 Gateway
  if (fs.existsSync(GATEWAY_DIR)) {
    console.log('扫描 Gateway...');
    scanDirectory(GATEWAY_DIR, 'gateway');
  }
  
  // 扫描各微服务
  if (fs.existsSync(SERVICES_DIR)) {
    const services = fs.readdirSync(SERVICES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    
    for (const service of services) {
      console.log(`扫描服务: ${service}...`);
      scanDirectory(path.join(SERVICES_DIR, service), service);
    }
  }
  
  // 生成报告
  const exitCode = generateReport({ failOnP0, failOnP1 });
  
  // 保存报告
  if (outputPath) {
    saveReport(outputPath);
  }
  
  process.exit(exitCode);
}

// 运行
main().catch(err => {
  console.error('扫描失败:', err);
  process.exit(1);
});
