'use strict';

// Split PostgreSQL scripts without treating quoted strings, function bodies or
// nested comments as statement boundaries. Standard strings retain backslashes;
// E-prefixed strings use PostgreSQL's explicit escape syntax.
function splitStatements(sql, onDirective) {
  const statements = [];
  let start = 0, state = null, depth = 0, escaped = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (state === 'line') { if (char === '\n') state = null; continue; }
    if (state === 'block') {
      if (char === '/' && next === '*') { depth++; i++; }
      else if (char === '*' && next === '/') { i++; if (--depth === 0) state = null; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (escaped && char === '\\') { i++; continue; }
      if (char === quote) { if (next === quote) i++; else state = null; }
      continue;
    }
    if (state) {
      if (sql.startsWith(state, i)) { i += state.length - 1; state = null; }
      continue;
    }
    if (char === '-' && next === '-') {
      if (onDirective && /^\s*$/.test(sql.slice(sql.lastIndexOf('\n', i - 1) + 1, i))) {
        const end = sql.indexOf('\n', i);
        const comment = sql.slice(i, end < 0 ? sql.length : end);
        const directive = comment.match(/^--\s*migrate:(up|down)\s*$/);
        if (directive) onDirective(directive[1], i, end < 0 ? sql.length : end + 1);
      }
      state = 'line'; i++;
    }
    else if (char === '/' && next === '*') { state = 'block'; depth = 1; i++; }
    else if (char === "'") { state = 'single'; escaped = /(?:^|[^\w$])[eE]$/.test(sql.slice(0, i)); }
    else if (char === '"') { state = 'double'; escaped = false; }
    else if (char === '$') {
      const tag = sql.slice(i).match(/^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/)?.[0];
      if (tag) { state = tag; i += tag.length - 1; }
    } else if (char === ';') {
      const statement = sql.slice(start, i).trim();
      if (leadingSql(statement)) statements.push(statement);
      start = i + 1;
    }
  }
  if (state && state !== 'line') throw new Error('Unterminated SQL string, identifier, function body or comment');
  const last = sql.slice(start).trim();
  if (leadingSql(last)) statements.push(last);
  return statements;
}

function leadingSql(sql) {
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    break;
  }
  return sql.slice(i).trim();
}

function migrationStatements(sql) {
  let statements = splitStatements(sql);
  // Existing scripts may wrap their whole body. The runner owns that transaction
  // so data and its checksum history commit or roll back together.
  if (/^COMMIT(?:\s+(?:TRANSACTION|WORK))?$/i.test(leadingSql(statements.at(-1) || ''))) {
    // A few legacy scripts also have a trailing COMMIT without an opening BEGIN.
    statements = statements.slice(0, -1);
    if (/^BEGIN(?:\s+(?:TRANSACTION|WORK))?$/i.test(leadingSql(statements[0] || ''))) statements = statements.slice(1);
  }
  for (const statement of statements) {
    if (/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+TRANSACTION)\b/i.test(leadingSql(statement))) {
      throw new Error('Migration SQL cannot control the runner transaction');
    }
  }
  if (!statements.length) throw new Error('Migration contains no executable SQL');
  return statements;
}

module.exports = { splitStatements, migrationStatements };
