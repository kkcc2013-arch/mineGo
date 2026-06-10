#!/usr/bin/env node
/**
 * Schema Consistency Check - OpenAPI Schema 与代码一致性检测
 * 
 * 功能：
 * - 检测 OpenAPI Schema 与实际代码路由是否一致
 * - 发现缺失的 Schema 定义
 * - 检测参数/响应不匹配
 * - 输出一致性报告
 * 
 * 用法: node scripts/schema-consistency-check.js [--fix] [--verbose]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.resolve(__dirname, '../backend/services');
const DOCS_DIR = path.resolve(__dirname, '../docs/api-spec');

// 颜色输出
const colors = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

/**
 * 从代码中提取路由
 */
function extractRoutesFromCode() {
  const routes = [];
  
  const services = fs.readdirSync(SERVICES_DIR).filter(d => 
    fs.statSync(path.join(SERVICES_DIR, d)).isDirectory()
  );

  for (const service of services) {
    const indexPath = path.join(SERVICES_DIR, service, 'src/index.js');
    const routesDir = path.join(SERVICES_DIR, service, 'src/routes');
    
    // 从 index.js 提取路由
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf8');
      extractRoutes(content, service, routes);
    }
    
    // 从 routes/ 目录提取路由
    if (fs.existsSync(routesDir)) {
      const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
      for (const file of routeFiles) {
        const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
        extractRoutes(content, service, routes);
      }
    }
  }

  return routes;
}

/**
 * 从文件内容提取路由定义
 */
function extractRoutes(content, service, routes) {
  // 匹配 Express 路由: app.get/post/put/patch/delete(path, ...)
  const routeRegex = /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  
  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toLowerCase();
    let routePath = match[2];
    
    // 标准化路径
    routePath = routePath.replace(/\/+/g, '/').replace(/\/$/, '');
    
    routes.push({
      method,
      path: routePath,
      service,
    });
  }
}

/**
 * 加载 OpenAPI Schema
 */
function loadSchemas() {
  const schemas = {};
  
  if (!fs.existsSync(DOCS_DIR)) {
    console.log(colors.yellow('⚠️  No api-spec directory found'));
    return schemas;
  }

  const files = fs.readdirSync(DOCS_DIR).filter(f => 
    f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml')
  );

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8');
    try {
      const ext = path.extname(file);
      let doc;
      if (ext === '.json') {
        doc = JSON.parse(content);
      } else {
        const yaml = require('js-yaml');
        doc = yaml.load(content);
      }
      
      const version = file.replace(ext, '');
      schemas[version] = doc;
    } catch (error) {
      console.log(colors.red(`  ❌ Failed to parse ${file}: ${error.message}`));
    }
  }

  return schemas;
}

/**
 * 从 Schema 中提取路由
 */
function extractRoutesFromSchema(schema) {
  const routes = [];

  if (!schema.paths) return routes;

  for (const [routePath, methods] of Object.entries(schema.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== 'object') continue;

      routes.push({
        method,
        path: routePath,
        operationId: operation.operationId,
        hasRequestBody: !!operation.requestBody,
        responseCodes: operation.responses ? Object.keys(operation.responses) : [],
      });
    }
  }

  return routes;
}

/**
 * 运行一致性检测
 */
function runConsistencyCheck() {
  console.log(colors.blue('\n📋 API Schema 一致性检测\n'));
  console.log(colors.gray('─'.repeat(60)));

  const codeRoutes = extractRoutesFromCode();
  const schemas = loadSchemas();

  console.log(`\n📊 统计信息:`);
  console.log(`   代码路由: ${codeRoutes.length} 个`);
  console.log(`   Schema 文件: ${Object.keys(schemas).length} 个`);

  const issues = [];

  // 1. 检查代码中定义但 Schema 中缺失的路由
  for (const route of codeRoutes) {
    let found = false;
    
    for (const [version, schema] of Object.entries(schemas)) {
      const schemaRoutes = extractRoutesFromSchema(schema);
      const match = schemaRoutes.find(sr => 
        sr.method === route.method && 
        normalizePath(sr.path) === normalizePath(route.path)
      );
      
      if (match) {
        found = true;
        
        // 检查 operationId
        if (!match.operationId) {
          issues.push({
            type: 'missing_operation_id',
            severity: 'warning',
            route: `${route.method.toUpperCase()} ${route.path}`,
            service: route.service,
            version,
            message: `路由缺少 operationId`,
          });
        }
        break;
      }
    }

    if (!found) {
      issues.push({
        type: 'missing_schema',
        severity: 'error',
        route: `${route.method.toUpperCase()} ${route.path}`,
        service: route.service,
        message: `代码中的路由缺少 OpenAPI Schema 定义`,
      });
    }
  }

  // 2. 检查 Schema 中定义但代码中不存在的路由
  for (const [version, schema] of Object.entries(schemas)) {
    const schemaRoutes = extractRoutesFromSchema(schema);
    
    for (const sr of schemaRoutes) {
      const found = codeRoutes.find(cr => 
        cr.method === sr.method && 
        normalizePath(cr.path) === normalizePath(sr.path)
      );
      
      if (!found) {
        issues.push({
          type: 'missing_route',
          severity: 'warning',
          route: `${sr.method.toUpperCase()} ${sr.path}`,
          version,
          operationId: sr.operationId,
          message: `Schema 中定义的路由在代码中不存在`,
        });
      }
    }
  }

  // 3. 检查统一响应格式
  for (const [version, schema] of Object.entries(schemas)) {
    if (!schema.paths) continue;

    for (const [routePath, methods] of Object.entries(schema.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (typeof operation !== 'object') continue;

        // 检查 200 响应是否有标准格式
        if (operation.responses && operation.responses['200']) {
          const response = operation.responses['200'];
          if (response.content?.['application/json']?.schema) {
            const schema = response.content['application/json'].schema;
            // 检查是否包含 code/data/message 字段
            if (schema.properties) {
              if (!schema.properties.code && !schema.properties.data) {
                issues.push({
                  type: 'non_standard_response',
                  severity: 'info',
                  route: `${method.toUpperCase()} ${routePath}`,
                  operationId: operation.operationId,
                  message: `响应格式不符合统一标准 (缺少 code/data 字段)`,
                });
              }
            }
          }
        }
      }
    }
  }

  // 输出结果
  console.log('\n' + colors.gray('─'.repeat(60)));
  console.log(colors.blue('检测结果:\n'));

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  if (errors.length > 0) {
    console.log(colors.red(`❌ 错误 (${errors.length}):`));
    errors.forEach(i => {
      console.log(colors.red(`   • [${i.type}] ${i.route} (${i.service || i.version}) - ${i.message}`));
    });
  }

  if (warnings.length > 0) {
    console.log(colors.yellow(`\n⚠️  警告 (${warnings.length}):`));
    warnings.forEach(i => {
      console.log(colors.yellow(`   • [${i.type}] ${i.route} (${i.service || i.version}) - ${i.message}`));
    });
  }

  if (infos.length > 0) {
    console.log(colors.blue(`\nℹ️  信息 (${infos.length}):`));
    infos.slice(0, 10).forEach(i => {
      console.log(colors.blue(`   • [${i.type}] ${i.route} - ${i.message}`));
    });
    if (infos.length > 10) {
      console.log(colors.gray(`   ... 还有 ${infos.length - 10} 条信息`));
    }
  }

  if (issues.length === 0) {
    console.log(colors.green('✅ 所有 API 路由与 Schema 一致'));
  }

  // 汇总
  console.log('\n' + colors.gray('─'.repeat(60)));
  console.log(`\n📊 汇总: ${colors.red(`${errors.length} 错误`)} | ${colors.yellow(`${warnings.length} 警告`)} | ${colors.blue(`${infos.length} 信息`)}`);
  console.log();

  // 返回退出码
  return errors.length > 0 ? 1 : 0;
}

/**
 * 标准化路径（将路径参数统一格式）
 */
function normalizePath(p) {
  return p
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/:([a-zA-Z_]+)/g, '{$1}')  // Express :param → OpenAPI {param}
    .replace(/\{([a-zA-Z_]+)\}/g, '{$1}'); // 统一花括号格式
}

// 执行检测
const exitCode = runConsistencyCheck();
process.exit(exitCode);
