// shared/db.js — PostgreSQL connection pool with shared pool manager
const path = require('path');
const { context, trace } = require('@opentelemetry/api');
const { getTracer } = require('./tracing');
const { getPoolManager, metrics: poolMetrics } = require('./DatabasePool');

// 使用 shared/metrics.js 中的 dbQueryDuration metric，避免重复注册
const { dbQueryDuration } = require('./metrics');

let poolManager = null;
let migrationsInitialized = false;

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
      console.warn('[DB] Slow query (%dms): %s', dur, text.substring(0, 120));
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
      console.error('[DB] Migration checksum verification failed!');
      for (const err of verifyResult.errors) {
        console.error(`  ${err.version}: ${err.message}`);
      }
      throw new Error('Migration checksum verification failed');
    }
    
    console.log('[DB] Migration checksums verified');
    
    // Run pending migrations if AUTO_MIGRATE is enabled
    if (process.env.AUTO_MIGRATE === 'true') {
      console.log('[DB] Running pending migrations...');
      const result = await runPendingMigrations();
      console.log(`[DB] Migrations complete: ${result.ran} executed`);
    }
    
    migrationsInitialized = true;
  } catch (err) {
    console.error('[DB] Migration initialization failed:', err.message);
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

// 导出 db 函数作为主要接口，同时保持原有接口兼容
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