'use strict';

/**
 * 让 Sequelize 风格的迁移（up(queryInterface, Sequelize)）在本项目的迁移执行器下运行。
 *
 * database/migrate.js 与 database/bootstrap-dev.js 以 up(client) 传入 pg client；少数迁移是按
 * Sequelize queryInterface 写的。这里只实现这些迁移用到的子集，并生成幂等 SQL
 * （CREATE TABLE/INDEX IF NOT EXISTS、ADD/DROP COLUMN IF [NOT] EXISTS）。
 *
 * 用法（迁移文件内）：
 *   const { wrapSequelizeMigration } = require('../tools/sequelizeShim');
 *   module.exports = wrapSequelizeMigration({ up: async (queryInterface, Sequelize) => { ... } });
 */

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

function literal(sql) {
  return { __literal: sql };
}

const Sequelize = {
  STRING: (n = 255) => ({ sql: `VARCHAR(${n})` }),
  TEXT: { sql: 'TEXT' },
  INTEGER: { sql: 'INTEGER' },
  BIGINT: { sql: 'BIGINT' },
  FLOAT: { sql: 'DOUBLE PRECISION' },
  DOUBLE: { sql: 'DOUBLE PRECISION' },
  DECIMAL: (p = 10, s = 2) => ({ sql: `DECIMAL(${p},${s})` }),
  BOOLEAN: { sql: 'BOOLEAN' },
  DATE: { sql: 'TIMESTAMPTZ' },
  DATEONLY: { sql: 'DATE' },
  UUID: { sql: 'UUID' },
  UUIDV4: literal('gen_random_uuid()'),
  JSON: { sql: 'JSON' },
  JSONB: { sql: 'JSONB' },
  ARRAY: (t) => ({ sql: `${typeSql(t)}[]` }),
  ENUM: (...values) => ({ sql: 'VARCHAR(64)', check: values.flat() }),
  NOW: literal('NOW()'),
  literal,
};
Sequelize.DataTypes = Sequelize;

function typeSql(t) {
  if (typeof t === 'function') t = t();
  if (t && t.sql) return t.sql;
  if (typeof t === 'string') return t;
  throw new Error(`sequelizeShim: 不支持的类型 ${JSON.stringify(t)}`);
}

function valueSql(v) {
  if (v && v.__literal) return v.__literal;
  if (v === null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function columnSql(name, def) {
  if (!def || def.sql || typeof def === 'function' || typeof def === 'string') def = { type: def };
  let t = def.type;
  if (typeof t === 'function') t = t();
  const parts = [ident(name), def.autoIncrement ? (typeSql(t) === 'BIGINT' ? 'BIGSERIAL' : 'SERIAL') : typeSql(t)];
  if (def.primaryKey) parts.push('PRIMARY KEY');
  if (def.allowNull === false && !def.primaryKey) parts.push('NOT NULL');
  if (def.unique) parts.push('UNIQUE');
  if (def.defaultValue !== undefined) parts.push(`DEFAULT ${valueSql(def.defaultValue)}`);
  if (def.references) {
    const r = def.references;
    parts.push(`REFERENCES ${ident(r.model.tableName || r.model)}(${ident(r.key || 'id')})`);
    if (def.onDelete) parts.push(`ON DELETE ${def.onDelete}`);
    if (def.onUpdate) parts.push(`ON UPDATE ${def.onUpdate}`);
  }
  if (t && t.check) parts.push(`CHECK (${ident(name)} IN (${t.check.map(valueSql).join(', ')}))`);
  return parts.join(' ');
}

function makeQueryInterface(client) {
  const q = (sql) => client.query(sql);
  return {
    sequelize: { query: (sql) => q(typeof sql === 'string' ? sql : sql.query) },
    createTable: (table, cols) => q(`CREATE TABLE IF NOT EXISTS ${ident(table)} (\n  ${
      Object.entries(cols).map(([n, d]) => columnSql(n, d)).join(',\n  ')}\n)`),
    dropTable: (table) => q(`DROP TABLE IF EXISTS ${ident(table)}`),
    addColumn: (table, name, def) => q(`ALTER TABLE ${ident(table)} ADD COLUMN IF NOT EXISTS ${columnSql(name, def)}`),
    removeColumn: (table, name) => q(`ALTER TABLE ${ident(table)} DROP COLUMN IF EXISTS ${ident(name)}`),
    addIndex: (table, fields, opts = {}) => {
      const cols = fields.map((f) => (typeof f === 'string' ? ident(f) : `${ident(f.name || f.attribute)}${f.order ? ` ${f.order}` : ''}`));
      const name = opts.name || `${table}_${fields.map((f) => f.name || f).join('_')}_idx`;
      return q(`CREATE ${opts.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ident(name)} ON ${ident(table)} (${cols.join(', ')})`);
    },
    removeIndex: (_table, name) => q(`DROP INDEX IF EXISTS ${ident(name)}`),
  };
}

function wrapSequelizeMigration(mod) {
  return {
    up: (client) => mod.up(makeQueryInterface(client), Sequelize),
    down: mod.down ? (client) => mod.down(makeQueryInterface(client), Sequelize) : undefined,
  };
}

module.exports = { Sequelize, makeQueryInterface, wrapSequelizeMigration };
