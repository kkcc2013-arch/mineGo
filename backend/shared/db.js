// shared/db.js — PostgreSQL connection pool with shared pool manager
const { createLogger } = require('./logger');
const logger = createLogger('db');
const path = require('path');
const { context, trace } = require('@opentelemetry/api');
const { getTracer } = require('./tracing');
const { getPoolManager, metrics: poolMetrics } = require('./DatabasePool');

// 使用 shared/metrics.js 中的 dbQueryDuration metric，避免重复注册
const { dbQueryDuration } = require('./metrics');

// REQ-00575: 预编译语句管理
const { PREPARED_STATEMENTS, getStatementByName } = require('./preparedStatements');

const { Client: PrometheusClient } = require('prom-client');

// 预编译语句性能指标
const preparedQueryDuration = new PrometheusClient.Histogram({
  name: 'db_prepared_query_duration_seconds',
  help: 'Prepared statement query duration in seconds',
  labelNames: ['statement', 'service'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
});

const preparedQueryCount = new PrometheusClient.Counter({
  name: 'db_prepared_query_count_total',
  help: 'Total number of prepared statement queries',
  labelNames: ['statement', 'service']
});

const preparedWarmupCount = new PrometheusClient.Counter({
  name: 'db_prepared_warmup_count_total',
  help: 'Total number of prepared statement warmup attempts',
  labelNames: ['service']
});

// 预编译语句统计
const statementStats = new Map();

let poolManager = null;
let migrationsInitialized = false;
let statementsWarmedUp = false;

/**
 * Get the pool manager instance
 */
function getPoolManagerInstance() {
  if (!poolManager) {
    poolManager = getPoolManager();
  }
  return poolManager;
}

/**
 * Get the default pool (backwards compatible)
 */
function getPool() {
  const serviceName = process.env.SERVICE_NAME || 'default';
  return getPoolManagerInstance().getPool(serviceName);
}

/**
 * Execute a database query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const start = Date.now();
  const serviceName = process.env.SERVICE_NAME || 'default';
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  const poolName = poolManager.getPoolName(serviceName);
  
  // Get current tracing context
  const currentSpan = trace.getSpan(context.active());
  let dbSpan = null;
  
  // Create database tracing span
  if (currentSpan) {
    const tracer = getTracer('mineGo-db');
    const operation = text.trim().split(' ')[0].toUpperCase();
    
    dbSpan = tracer.startSpan(`db.query ${operation}`, {
      attributes: {
        'db.system': 'postgresql',
        'db.statement': text.substring(0, 500),
        'db.operation': operation,
      },
    });
  }

  const acquireStart = Date.now();
  const client = await pool.connect();
  const acquireDuration = Date.now() - acquireStart;
  
  try {
    const res = await client.query(text, params);
    const dur = Date.now() - start;
    
    // Record query duration (使用 service 和 query_name 标签)
    const operation = text.trim().split(' ')[0].toUpperCase();
    dbQueryDuration.observe({ service: serviceName, query_name: operation }, dur);
    
    // Record to span
    if (dbSpan) {
      dbSpan.setAttributes({
        'db.rows_affected': res.rowCount || 0,
        'db.duration_ms': dur,
        'db.connection_acquire_ms': acquireDuration,
      });
      dbSpan.setStatus({ code: 0 });
      dbSpan.end();
    }
    
    if (dur > 500) {
      logger.warn({ module: 'DB', msg: `Slow query (${dur}ms): ${text.substring(0, 120)}` });
    }
    
    return res;
  } catch (err) {
    // Record error to span
    if (dbSpan) {
      dbSpan.setStatus({ code: 2, message: err.message });
      dbSpan.recordException(err);
      dbSpan.end();
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a database transaction
 * REQ-00096: 增强版事务管理，支持隔离级别和死锁检测
 * 
 * @param {Function} fn - Transaction callback
 * @param {Object} options - Transaction options
 * @param {string} options.isolationLevel - Isolation level (READ COMMITTED, REPEATABLE READ, SERIALIZABLE)
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {boolean} options.retryOnDeadlock - Whether to retry on deadlock
 * @param {number} options.maxRetries - Maximum retry attempts
 * @param {string} options.transactionName - Transaction name for monitoring
 * @returns {Promise<any>} Transaction result
 */
async function transaction(fn, options = {}) {
  const serviceName = process.env.SERVICE_NAME || 'default';
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  
  // 如果提供了高级选项，使用 TransactionManager
  if (options && Object.keys(options).length > 0) {
    const { TransactionManager } = require('./TransactionManager');
    const txManager = new TransactionManager(pool);
    return txManager.execute(fn, options);
  }
  
  // 向后兼容：简单的无参数事务
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Initialize database migrations
 * Should be called once during application startup
 */
async function initializeMigrations() {
  if (migrationsInitialized) {
    return;
  }
  
  try {
    // Import migration runner
    const migratePath = path.join(__dirname, '..', '..', 'database', 'migrate.js');
    const { verifyChecksums, runPendingMigrations } = require(migratePath);
    
    // Verify checksums of already executed migrations
    const verifyResult = await verifyChecksums();
    if (!verifyResult.valid) {
      logger.error({ module: 'db' }, '[DB] Migration checksum verification failed!');;
      for (const err of verifyResult.errors) {
        logger.error({ module: 'db' }, `  ${err.version}: ${err.message}`);;
      }
      throw new Error('Migration checksum verification failed');
    }
    
    logger.info({ module: 'DB] Migration checksums verified' }, 'DB] Migration checksums verified message');;
    
    // Run pending migrations if AUTO_MIGRATE is enabled
    if (process.env.AUTO_MIGRATE === 'true') {
      logger.info({ module: 'DB] Running pending migrations...' }, 'DB] Running pending migrations... message');;
      const result = await runPendingMigrations();
      logger.info({ module: 'DB] Migrations complete: ${result.ran} executed' }, 'DB] Migrations complete: ${result.ran} executed message');;
    }
    
    migrationsInitialized = true;
  } catch (err) {
    logger.error({ module: 'DB] Migration initialization failed', error: err.message.message }, 'DB] Migration initialization failed error');;
    throw err;
  }
}

/**
 * Get pool statistics
 * @returns {Object} Pool statistics
 */
function getPoolStats() {
  const poolManager = getPoolManagerInstance();
  return poolManager.getStats();
}

/**
 * Get aggregate pool statistics
 * @returns {Object} Aggregate statistics
 */
function getAggregateStats() {
  const poolManager = getPoolManagerInstance();
  return poolManager.getAggregateStats();
}

/**
 * Health check for database pools
 * @returns {Promise<Object>} Health check results
 */
async function healthCheck() {
  const poolManager = getPoolManagerInstance();
  return poolManager.healthCheck();
}

/**
 * Close all database pools
 */
async function closePools() {
  if (poolManager) {
    await poolManager.closeAll();
  }
}

/**
 * Get service-specific pool configuration
 * @param {string} serviceName - Service name
 * @returns {Object} Pool configuration
 */
function getServicePoolConfig(serviceName) {
  const { SERVICE_POOL_CONFIG } = require('./DatabasePool');
  return SERVICE_POOL_CONFIG[serviceName] || SERVICE_POOL_CONFIG['default'];
}

async function getClient() {
  return await getPool().connect();
}

// ============================================================
// Knex-style Query Builder
// ============================================================

/**
 * Knex 风格查询构建器
 * 支持 db('table').where().orderBy() 等链式调用
 */
class QueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.conditions = [];
    this.orderColumns = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.selectColumns = ['*'];
    this.insertData = null;
    this.updateData = null;
    this.isDelete = false;
    this.returningColumns = [];
    this.joinClauses = [];
    this.groupByColumns = [];
    this.havingConditions = [];
    this.isFirst = false;
  }

  /**
   * WHERE 条件
   * @param {Object|string} conditions - 条件对象或字段名
   * @param {any} value - 值（当 conditions 是字符串时）
   * @param {string} operator - 操作符（默认 '='）
   */
  where(conditions, value = null, operator = '=') {
    if (typeof conditions === 'object') {
      for (const [key, val] of Object.entries(conditions)) {
        this.conditions.push({ column: key, operator: '=', value: val });
      }
    } else if (typeof conditions === 'string') {
      this.conditions.push({ column: conditions, operator, value });
    }
    return this;
  }

  /**
   * WHERE NOT 条件
   */
  whereNot(column, value) {
    this.conditions.push({ column, operator: '!=', value });
    return this;
  }

  /**
   * WHERE IN 条件
   */
  whereIn(column, values) {
    this.conditions.push({ column, operator: 'IN', value: values });
    return this;
  }

  /**
   * WHERE NULL 条件
   */
  whereNull(column) {
    this.conditions.push({ column, operator: 'IS NULL', value: null });
    return this;
  }

  /**
   * WHERE NOT NULL 条件
   */
  whereNotNull(column) {
    this.conditions.push({ column, operator: 'IS NOT NULL', value: null });
    return this;
  }

  /**
   * WHERE LIKE 条件
   */
  whereLike(column, pattern) {
    this.conditions.push({ column, operator: 'LIKE', value: pattern });
    return this;
  }

  /**
   * WHERE BETWEEN 条件
   */
  whereBetween(column, values) {
    this.conditions.push({ column, operator: 'BETWEEN', value: values });
    return this;
  }

  /**
   * OR WHERE 条件
   */
  orWhere(column, value, operator = '=') {
    this.conditions.push({ column, operator, value, isOr: true });
    return this;
  }

  /**
   * JOIN
   */
  join(table, onClause, type = 'INNER') {
    this.joinClauses.push({ table, on: onClause, type });
    return this;
  }

  /**
   * LEFT JOIN
   */
  leftJoin(table, onClause) {
    return this.join(table, onClause, 'LEFT');
  }

  /**
   * RIGHT JOIN
   */
  rightJoin(table, onClause) {
    return this.join(table, onClause, 'RIGHT');
  }

  /**
   * ORDER BY
   * @param {string} column - 列名
   * @param {string} direction - 方向 ('asc' 或 'desc')
   */
  orderBy(column, direction = 'asc') {
    this.orderColumns.push({ column, direction: direction.toUpperCase() });
    return this;
  }

  /**
   * LIMIT
   */
  limit(value) {
    this.limitValue = value;
    return this;
  }

  /**
   * OFFSET
   */
  offset(value) {
    this.offsetValue = value;
    return this;
  }

  /**
   * SELECT
   */
  select(...columns) {
    if (columns.length > 0) {
      this.selectColumns = columns.flat();
    }
    return this;
  }

  /**
   * INSERT
   */
  insert(data) {
    if (Array.isArray(data)) {
      this.insertData = data;
    } else {
      this.insertData = [data];
    }
    return this;
  }

  /**
   * UPDATE
   */
  update(data) {
    this.updateData = data;
    return this;
  }

  /**
   * DELETE
   */
  delete() {
    this.isDelete = true;
    return this;
  }

  /**
   * RETURNING
   */
  returning(...columns) {
    this.returningColumns = columns.flat();
    return this;
  }

  /**
   * FIRST - 只返回第一条记录
   */
  first() {
    this.isFirst = true;
    this.limitValue = 1;
    return this;
  }

  /**
   * GROUP BY
   */
  groupBy(...columns) {
    this.groupByColumns = columns.flat();
    return this;
  }

  /**
   * HAVING
   */
  having(condition) {
    this.havingConditions.push(condition);
    return this;
  }

  /**
   * COUNT
   */
  count(column = '*', alias = 'count') {
    this.selectColumns = [`COUNT(${column}) AS ${alias}`];
    return this;
  }

  /**
   * 构建 SQL 查询语句
   */
  buildSQL() {
    let sql = '';
    const params = [];
    let paramIndex = 1;

    // INSERT
    if (this.insertData) {
      const columns = Object.keys(this.insertData[0]);
      const valuesPlaceholders = this.insertData.map(row => {
        const rowParams = columns.map(col => {
          params.push(row[col]);
          return `$${paramIndex++}`;
        });
        return `(${rowParams.join(', ')})`;
      }).join(', ');
      
      sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES ${valuesPlaceholders}`;
      
      if (this.returningColumns.length > 0) {
        sql += ` RETURNING ${this.returningColumns.join(', ')}`;
      } else {
        sql += ' RETURNING *';
      }
      return { sql, params };
    }

    // UPDATE
    if (this.updateData) {
      const setClauses = [];
      for (const [key, val] of Object.entries(this.updateData)) {
        params.push(val);
        setClauses.push(`${key} = $${paramIndex++}`);
      }
      
      sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')}`;
      
      // WHERE
      if (this.conditions.length > 0) {
        sql += ' WHERE ' + this.buildWhereClause(params, paramIndex);
      }
      
      if (this.returningColumns.length > 0) {
        sql += ` RETURNING ${this.returningColumns.join(', ')}`;
      } else {
        sql += ' RETURNING *';
      }
      return { sql, params };
    }

    // DELETE
    if (this.isDelete) {
      sql = `DELETE FROM ${this.tableName}`;
      
      if (this.conditions.length > 0) {
        sql += ' WHERE ' + this.buildWhereClause(params, paramIndex);
      }
      
      if (this.returningColumns.length > 0) {
        sql += ` RETURNING ${this.returningColumns.join(', ')}`;
      }
      return { sql, params };
    }

    // SELECT
    sql = `SELECT ${this.selectColumns.join(', ')} FROM ${this.tableName}`;

    // JOINs
    for (const join of this.joinClauses) {
      sql += ` ${join.type} JOIN ${join.table} ON ${join.on}`;
    }

    // WHERE
    if (this.conditions.length > 0) {
      sql += ' WHERE ' + this.buildWhereClause(params, paramIndex);
    }

    // GROUP BY
    if (this.groupByColumns.length > 0) {
      sql += ` GROUP BY ${this.groupByColumns.join(', ')}`;
    }

    // HAVING
    if (this.havingConditions.length > 0) {
      sql += ` HAVING ${this.havingConditions.join(' AND ')}`;
    }

    // ORDER BY
    if (this.orderColumns.length > 0) {
      const orderParts = this.orderColumns.map(o => `${o.column} ${o.direction}`);
      sql += ` ORDER BY ${orderParts.join(', ')}`;
    }

    // LIMIT
    if (this.limitValue !== null) {
      sql += ` LIMIT ${this.limitValue}`;
    }

    // OFFSET
    if (this.offsetValue !== null) {
      sql += ` OFFSET ${this.offsetValue}`;
    }

    return { sql, params };
  }

  /**
   * 构建 WHERE 子句
   */
  buildWhereClause(params, startIndex) {
    let paramIndex = startIndex;
    const clauses = [];
    
    for (const cond of this.conditions) {
      let clause = '';
      if (cond.isOr) {
        clause = 'OR ';
      }
      
      if (cond.operator === 'IN') {
        const placeholders = cond.value.map(v => {
          params.push(v);
          return `$${paramIndex++}`;
        });
        clause += `${cond.column} IN (${placeholders.join(', ')})`;
      } else if (cond.operator === 'BETWEEN') {
        params.push(cond.value[0]);
        params.push(cond.value[1]);
        clause += `${cond.column} BETWEEN $${paramIndex++} AND $${paramIndex++}`;
      } else if (cond.operator === 'IS NULL' || cond.operator === 'IS NOT NULL') {
        clause += `${cond.column} ${cond.operator}`;
      } else {
        params.push(cond.value);
        clause += `${cond.column} ${cond.operator} $${paramIndex++}`;
      }
      
      clauses.push(clause);
    }
    
    return clauses.map((c, i) => i === 0 && c.startsWith('OR ') ? c.substring(3) : c).join(' AND ');
  }

  /**
   * 执行查询
   */
  async then(resolve, reject) {
    try {
      const { sql, params } = this.buildSQL();
      const result = await query(sql, params);
      
      let data = result.rows;
      
      if (this.isFirst) {
        data = result.rows[0] || null;
      }
      
      resolve(data);
    } catch (err) {
      reject(err);
    }
  }

  /**
   * 转换为 Promise
   */
  toPromise() {
    return new Promise((resolve, reject) => {
      this.then(resolve, reject);
    });
  }

  /**
   * 支持 async/await
   */
  [Symbol.toStringTag] = 'Promise';
}

/**
 * Knex 风格的 db 函数
 * db('table_name') 返回查询构建器
 */
function db(tableName) {
  return new QueryBuilder(tableName);
}

db.db = db;
module.exports = db;

// 导出所有原有函数作为属性
module.exports.getPool = getPool;
module.exports.getClient = getClient;
module.exports.query = query;
module.exports.transaction = transaction;
module.exports.initializeMigrations = initializeMigrations;
module.exports.getPoolStats = getPoolStats;
module.exports.getAggregateStats = getAggregateStats;
module.exports.healthCheck = healthCheck;
module.exports.closePools = closePools;
module.exports.getServicePoolConfig = getServicePoolConfig;
module.exports.getPoolManagerInstance = getPoolManagerInstance;
module.exports.TransactionManager = require('./TransactionManager').TransactionManager;
module.exports.ISOLATION_LEVELS = require('./TransactionManager').ISOLATION_LEVELS;

// QueryBuilder 类导出（供高级使用）
module.exports.QueryBuilder = QueryBuilder;

// ============================================================
// REQ-00575: Prepared Statement Support
// ============================================================

/**
 * 执行预编译查询
 * @param {string} name - 预编译语句名称（如 'getNearbyWild'）
 * @param {Array} params - 参数数组
 * @returns {Promise<Object>} 查询结果
 */
async function preparedQuery(name, params) {
  const start = Date.now();
  const serviceName = process.env.SERVICE_NAME || 'default';
  
  // 获取预编译语句配置
  const statementConfig = getStatementByName(name);
  if (!statementConfig) {
    logger.warn({ module: 'DB', msg: `Prepared statement '${name}' not found, falling back to query()` });
    // 降级：如果语句未定义，返回空结果
    throw new Error(`Prepared statement '${name}' not found`);
  }
  
  const statementName = statementConfig.name;
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  const client = await pool.connect();
  
  try {
    // 执行预编译查询
    const res = await client.query({
      name: statementName,
      text: statementConfig.text,
      values: params
    });
    
    const dur = Date.now() - start;
    
    // 更新 Prometheus 指标
    preparedQueryDuration.observe({ statement: name, service: serviceName }, dur / 1000);
    preparedQueryCount.inc({ statement: name, service: serviceName });
    
    // 更新统计
    if (!statementStats.has(name)) {
      statementStats.set(name, { count: 0, totalTime: 0, avgTime: 0 });
    }
    const stats = statementStats.get(name);
    stats.count++;
    stats.totalTime += dur;
    stats.avgTime = stats.totalTime / stats.count;
    
    if (dur > 500) {
      logger.warn({ module: 'DB', msg: `Slow prepared query (${name}, ${dur}ms)` });
    }
    
    return res;
  } catch (err) {
    // 如果预编译失败，尝试降级为普通查询
    if (err.code === '26000') { // prepared statement not found
      logger.warn({ module: 'DB', msg: `Prepared statement '${name}' not found on server, falling back to query()` });
      const res = await client.query(statementConfig.text, params);
      return res;
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 预热指定预编译语句（服务启动时调用）
 * @param {string} name - 预编译语句名称
 */
async function warmupStatement(name) {
  const serviceName = process.env.SERVICE_NAME || 'default';
  const statementConfig = getStatementByName(name);
  
  if (!statementConfig) {
    logger.warn({ module: 'DB', msg: `Cannot warmup: prepared statement '${name}' not found` });
    return false;
  }
  
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  const client = await pool.connect();
  
  try {
    // 执行空查询以预热预编译语句
    // 注意：PostgreSQL 会缓存执行计划
    const dummyParams = statementConfig.paramTypes
      ? statementConfig.paramTypes.map((type, i) => getDummyValueForType(type))
      : [];
    
    await client.query({
      name: statementConfig.name,
      text: statementConfig.text,
      values: dummyParams
    });
    
    preparedWarmupCount.inc({ service: serviceName });
    logger.info({ module: 'DB', msg: `Prepared statement '${name}' warmed up successfully` });
    return true;
  } catch (err) {
    // 预热失败不影响服务启动
    logger.warn({ module: 'DB', msg: `Failed to warmup prepared statement '${name}': ${err.message}` });
    return false;
  } finally {
    client.release();
  }
}

/**
 * 预热服务的所有预编译语句
 * @param {string} serviceName - 服务名称
 */
async function warmupServiceStatements(serviceName) {
  const serviceStatements = Object.entries(PREPARED_STATEMENTS)
    .filter(([_, config]) => config.service === serviceName);
  
  if (serviceStatements.length === 0) {
    logger.info({ module: 'DB', msg: `No prepared statements for service '${serviceName}'` });
    return;
  }
  
  logger.info({ module: 'DB', msg: `Warming up ${serviceStatements.length} prepared statements for ${serviceName}` });
  
  for (const [name, config] of serviceStatements) {
    await warmupStatement(name);
    // 每次预热间隔 100ms，避免瞬间压力
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  statementsWarmedUp = true;
  logger.info({ module: 'DB', msg: `Prepared statements warmup complete for ${serviceName}` });
}

/**
 * 获取预编译语句统计信息
 */
function getStatementStats() {
  const stats = {};
  for (const [name, data] of statementStats.entries()) {
    stats[name] = { ...data };
  }
  return {
    statements: stats,
    warmedUp: statementsWarmedUp,
    total: statementStats.size
  };
}

/**
 * 根据参数类型返回虚拟值用于预热
 */
function getDummyValueForType(type) {
  switch (type) {
    case 'int4': return 0;
    case 'float8': return 0.0;
    case 'varchar': return '';
    case 'bool': return false;
    case 'timestamp': return '1970-01-01';
    default: return null;
  }
}

// 导出预编译查询函数
module.exports.preparedQuery = preparedQuery;
module.exports.warmupStatement = warmupStatement;
module.exports.warmupServiceStatements = warmupServiceStatements;
module.exports.getStatementStats = getStatementStats;
module.exports.PREPARED_STATEMENTS = PREPARED_STATEMENTS;