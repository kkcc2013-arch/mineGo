'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'pending');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // 1. Replace inline INTEGER/INT/VARCHAR(36) references users(id)
  content = content.replace(
    /([a-zA-Z0-9_]+)\s+(?:INTEGER|INT|VARCHAR\(36\))\s+(NOT\s+NULL\s+)?(UNIQUE\s+)?(NOT\s+NULL\s+)?REFERENCES\s+users\s*\(\s*id\s*\)/gi,
    (match, colName, notNull1, unique, notNull2) => {
      const parts = [colName, 'UUID'];
      if (notNull1) parts.push(notNull1.trim());
      if (unique) parts.push(unique.trim());
      if (notNull2) parts.push(notNull2.trim());
      parts.push('REFERENCES users(id)');
      return parts.join(' ');
    }
  );

  // 2. Specific replacements for 20260609_130000__add_friend_system_tables.sql
  if (file === '20260609_130000__add_friend_system_tables.sql') {
    content = content.replace(/user_id VARCHAR\(36\) NOT NULL/g, 'user_id UUID NOT NULL');
    content = content.replace(/friend_user_id VARCHAR\(36\) NOT NULL/g, 'friend_user_id UUID NOT NULL');
    content = content.replace(/from_user_id VARCHAR\(36\) NOT NULL/g, 'from_user_id UUID NOT NULL');
    content = content.replace(/to_user_id VARCHAR\(36\) NOT NULL/g, 'to_user_id UUID NOT NULL');
  }

  // 3. Specific replacements for 20260605_170000__add_trading_system_tables.sql
  if (file === '20260605_170000__add_trading_system_tables.sql') {
    content = content.replace(/initiator_id VARCHAR\(36\) NOT NULL REFERENCES users\(id\)/g, 'initiator_id UUID NOT NULL REFERENCES users(id)');
    content = content.replace(/receiver_id VARCHAR\(36\) NOT NULL REFERENCES users\(id\)/g, 'receiver_id UUID NOT NULL REFERENCES users(id)');
    content = content.replace(/user_id VARCHAR\(36\) NOT NULL REFERENCES users\(id\)/g, 'user_id UUID NOT NULL REFERENCES users(id)');
  }

  // 4. Replace u.username with u.nickname (since username is nickname in existing users table)
  content = content.replace(/u\.username/g, 'u.nickname');

  // 5. Replace CREATE INDEX CONCURRENTLY with CREATE INDEX
  content = content.replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX');

  // 6. Replace CREATE INDEX with CREATE INDEX IF NOT EXISTS
  content = content.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)([a-zA-Z0-9_]+)/gi, (match, unique, indexName) => {
    return `CREATE ${unique || ''}INDEX IF NOT EXISTS ${indexName}`;
  });

  // 7. Remove redundant manual INSERT INTO schema_migrations statements
  content = content.replace(/INSERT\s+INTO\s+schema_migrations[\s\S]*?;/gi, '');

  // 8. Comment out SELECT cron.schedule(...) statements
  content = content.replace(/(SELECT\s+cron\.schedule[\s\S]*?\);)/gi, (match) => {
    return match.split('\n').map(line => `-- ${line}`).join('\n');
  });

  // 9. Fix valid_timezone check constraint subquery in users table
  if (file === '20260605_220000__add_user_timezone.sql') {
    content = content.replace(/ALTER\s+TABLE\s+users\s+ADD\s+CONSTRAINT\s+valid_timezone\s+CHECK\s*\([\s\S]*?\);/gi, '-- ALTER TABLE users ADD CONSTRAINT valid_timezone CHECK ... (removed subquery constraint)');
  }

  // 10. Fix JSONB array ANY search in cloud cost tables
  if (file === '20260609_000000__add_cloud_cost_tables.sql') {
    content = content.replace(/cr\.service_name\s+=\s+ANY\s*\(\s*bc\.scope_values->>'services'\s*\)/gi, "bc.scope_values->'services' @> jsonb_build_array(cr.service_name)");
    content = content.replace(/cr\.namespace\s+=\s+ANY\s*\(\s*bc\.scope_values->>'namespaces'\s*\)/gi, "bc.scope_values->'namespaces' @> jsonb_build_array(cr.namespace)");
  }

  // 11. Fix user_pokemon references to pokemon_instances
  content = content.replace(/REFERENCES\s+user_pokemon\s*\(\s*id\s*\)/gi, "REFERENCES pokemon_instances(id)");

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Patched: ${file}`);
  }
}

console.log('Patching complete!');
