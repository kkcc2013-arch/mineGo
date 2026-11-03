'use strict';

const crypto = require('node:crypto');
const {AppError} = require('../auth');

const sha256 = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const subjectField = /(^|_)(user|owner|sender|receiver|recipient|creator|player|member|inviter|buyer|seller|actor|reviewer|approver|trainer|participant)(_|$)|^(created|approved|bred|sent)_by$/i;
const fail = code => new AppError(code, code, 503);

// Discovery is deliberately separate from executable resource operators. A foreign
// key denotes an association, not ownership or authority to erase the referencing
// row. Proposal table names, SQL fragments and retention days never reach queries.
class ErasureResourcePlanner {
  async inspect(client, request) {
    const state = (await client.query(`SELECT current_database() AS database,
      current_schema() AS schema, current_setting('transaction_isolation') AS isolation,
      clock_timestamp() AS observed_at`)).rows[0];
    if (!['repeatable read', 'serializable'].includes(state.isolation)) throw fail('ERASURE_PLAN_SNAPSHOT_REQUIRED');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!request || !uuid.test(request.user_id || '') || !uuid.test(request.id || '') || !Array.isArray(request.requested_data_types)) throw fail('ERASURE_PLAN_SUBJECT_INVALID');
    const local = state.schema;
    const normalize = value => value.replaceAll(quote(local) + '.', '@local.').replaceAll(local + '.', '@local.');
    const schemaName = value => value === local ? '@local' : value;
    const relations = (await client.query(`SELECT c.relname AS name, c.relkind AS kind,
      c.relispartition AS partition, c.relrowsecurity AS row_security,
      c.relforcerowsecurity AS force_row_security, c.relpersistence AS persistence,
      has_table_privilege(c.oid,'SELECT') AS readable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN('r','p','f','v','m') ORDER BY c.relname`, [local])).rows;
    const columns = (await client.query(`SELECT c.relname AS relation, a.attname AS name,
      a.attnum AS position, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS not_null, a.attgenerated AS generated,
      a.attidentity AS identity, pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind IN('r','p','f','v','m')
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [local])).rows
      .map(row => ({...row, type: normalize(row.type), expression: row.expression === null ? null : sha256(normalize(row.expression))}));
    const references = (await client.query(`SELECT ns.nspname AS source_schema, s.relname AS source,
      nt.nspname AS target_schema, t.relname AS target, k.conname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY f(num,pos)
        JOIN pg_attribute a ON a.attrelid=s.oid AND a.attnum=f.num ORDER BY f.pos) AS source_columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY f(num,pos)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=f.num ORDER BY f.pos) AS target_columns,
      k.confdeltype AS on_delete, k.confupdtype AS on_update,
      k.convalidated AS validated, k.condeferrable AS deferrable, k.condeferred AS deferred
      FROM pg_constraint k JOIN pg_class s ON s.oid=k.conrelid
      JOIN pg_namespace ns ON ns.oid=s.relnamespace JOIN pg_class t ON t.oid=k.confrelid
      JOIN pg_namespace nt ON nt.oid=t.relnamespace
      WHERE k.contype='f' AND (ns.nspname=$1 OR nt.nspname=$1)
      ORDER BY ns.nspname,s.relname,k.conname`, [local])).rows
      .map(row => ({...row, source_schema: schemaName(row.source_schema), target_schema: schemaName(row.target_schema)}));
    const constraints = (await client.query(`SELECT c.relname AS relation, k.conname AS name,
      k.contype AS kind, k.convalidated AS validated, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,k.conname`, [local])).rows
      .map(row => ({...row, definition: sha256(normalize(row.definition))}));
    const triggers = (await client.query(`SELECT c.relname AS relation, t.tgname AS name,
      t.tgenabled AS enabled, t.tgtype AS event_mask,
      np.nspname AS function_schema, p.proname AS function_name,
      pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(p.oid) AS function_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace np ON np.oid=p.pronamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [local])).rows
      .map(row => ({...row, function_schema: schemaName(row.function_schema), definition: sha256(normalize(row.definition)), function_definition: sha256(normalize(row.function_definition))}));
    const rules = (await client.query(`SELECT c.relname AS relation, r.rulename AS name,
      r.ev_type AS event, r.ev_enabled AS enabled, pg_get_ruledef(r.oid) AS definition
      FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,r.rulename`, [local])).rows
      .map(row => ({...row, definition: sha256(normalize(row.definition))}));
    const inheritance = (await client.query(`SELECT nc.nspname AS child_schema, c.relname AS child,
      np.nspname AS parent_schema, p.relname AS parent, i.inhseqno AS position,
      pg_get_expr(c.relpartbound,c.oid) AS partition_bound
      FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      JOIN pg_namespace nc ON nc.oid=c.relnamespace JOIN pg_class p ON p.oid=i.inhparent
      JOIN pg_namespace np ON np.oid=p.relnamespace
      WHERE nc.nspname=$1 OR np.nspname=$1 ORDER BY nc.nspname,c.relname,i.inhseqno`, [local])).rows
      .map(row => ({...row, child_schema: schemaName(row.child_schema), parent_schema: schemaName(row.parent_schema), partition_bound: row.partition_bound === null ? null : sha256(normalize(row.partition_bound))}));
    const policies = (await client.query(`SELECT c.relname AS relation, p.polname AS name,
      p.polcmd AS command, p.polpermissive AS permissive, p.polroles::text AS roles,
      pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,p.polname`, [local])).rows
      .map(row => ({...row, using_expression: row.using_expression === null ? null : sha256(normalize(row.using_expression)), check_expression: row.check_expression === null ? null : sha256(normalize(row.check_expression))}));
    const canonicalSubject = columns.find(c => c.relation === 'users' && c.name === 'id' && c.type === 'uuid');
    if (!canonicalSubject) throw fail('ERASURE_SCHEMA_INVALID');
    const metadata = {relations, columns, references, constraints, triggers, rules, inheritance, policies};
    const resources = [];
    for (const relation of relations) {
      const fields = columns.filter(c => c.relation === relation.name);
      const incoming = references.filter(fk => fk.target_schema === '@local' && fk.target === relation.name);
      const outgoing = references.filter(fk => fk.source_schema === '@local' && fk.source === relation.name);
      const canonicalReferences = new Set(outgoing.filter(fk => fk.target_schema === '@local' && fk.target === 'users' && fk.target_columns.length === 1 && fk.target_columns[0] === 'id' && fk.source_columns.length === 1).map(fk => fk.source_columns[0]));
      const associations = fields.filter(c => canonicalReferences.has(c.name) || subjectField.test(c.name) || relation.name === 'users' && c.name === 'id')
        .map(c => ({column: c.name, type: c.type, basis: relation.name === 'users' && c.name === 'id' ? 'canonical_subject' : canonicalReferences.has(c.name) ? 'foreign_key_association' : 'name_requires_ownership_review'}));
      const parents = inheritance.filter(i => i.child_schema === '@local' && i.child === relation.name);
      const review = ['RESOURCE_CLASSIFICATION_REQUIRED'];
      if (associations.length) review.push('OWNERSHIP_AND_RETENTION_POLICY_REQUIRED');
      if (associations.some(a => a.type !== 'uuid')) review.push('SUBJECT_MAPPING_REQUIRED');
      if (incoming.length) review.push('INCOMING_REFERENCE_REVIEW_REQUIRED');
      if (incoming.some(fk => fk.source_schema !== '@local')) review.push('EXTERNAL_REFERENCE_REVIEW_REQUIRED');
      if (triggers.some(trigger => trigger.relation === relation.name)) review.push('TRIGGER_EFFECT_REVIEW_REQUIRED');
      if (rules.some(rule => rule.relation === relation.name)) review.push('RULE_EFFECT_REVIEW_REQUIRED');
      if (relation.row_security || relation.force_row_security) review.push('ROW_SECURITY_REVIEW_REQUIRED');
      if (!relation.readable) review.push('SELECT_PRIVILEGE_REQUIRED');
      if (!['r','p'].includes(relation.kind)) review.push('NON_TABLE_RESOURCE_REVIEW_REQUIRED');
      if (parents.length) review.push('INHERITANCE_REVIEW_REQUIRED');
      const uuidFields = associations.filter(a => a.type === 'uuid');
      let associatedRows = null;
      // Counts are associations in this snapshot, never a deletion estimate. Do
      // not execute view/FDW code or accept filtered RLS results as full coverage.
      const descendants = new Set([relation.name]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of inheritance) if (edge.parent_schema === '@local' && descendants.has(edge.parent) && !descendants.has(edge.child)) {descendants.add(edge.child); changed = true;}
      }
      const unsafeDescendant = inheritance.some(edge => descendants.has(edge.parent) && edge.child_schema !== '@local') ||
        relations.some(child => descendants.has(child.name) && (!['r','p'].includes(child.kind) || child.row_security || child.force_row_security || !child.readable));
      if (unsafeDescendant) review.push('DESCENDANT_ACCESS_REVIEW_REQUIRED');
      if (uuidFields.length && !parents.length && !unsafeDescendant && relation.readable && !relation.row_security && !relation.force_row_security && ['r','p'].includes(relation.kind)) {
        const condition = uuidFields.map(a => quote(a.column) + '=$1::uuid').join(' OR ');
        associatedRows = (await client.query(`SELECT count(*)::text AS count FROM ${quote(local)}.${quote(relation.name)} WHERE ${condition}`, [request.user_id])).rows[0].count;
      }
      resources.push({name: relation.name, kind: relation.kind, partition: relation.partition,
        associations, associatedRows, countScope: 'direct_uuid_associations_only', parents,
        incomingReferences: incoming, reviewRequired: review});
    }
    const catalogSha256 = sha256(metadata);
    const binding = {namespace: sha256([state.database, local]), requestId: request.id, subjectId: request.user_id, requestType: request.request_type,
      requestedCategories: [...request.requested_data_types].sort(), verifiedAt: request.verified_at,
      approvalStatus: request.approval_status, executeAfter: request.execute_after};
    return {version: 'erasure-resource-inventory-v1', ...binding, observedAt: state.observed_at,
      isolation: state.isolation, catalogSha256, fingerprint: sha256({binding, catalogSha256, resources}),
      executionReady: false, blockers: ['RESOURCE_OPERATORS_REQUIRED','RETENTION_POLICY_REVIEW_REQUIRED','EXTERNAL_STORAGE_INVENTORY_REQUIRED'],
      counts: {relations: relations.length, associationResources: resources.filter(r => r.associations.length).length,
        countedResources: resources.filter(r => r.associatedRows !== null).length, foreignKeys: references.length, triggers: triggers.length},
      resources, columns, foreignKeys: references, constraints, inheritance, triggers, rules, policies,
      limitations: ['Associations do not establish ownership or permission to erase.',
        'Counts include inherited rows only through their root; child relations are not counted again.',
        'JSON, text, integer, array and external-storage identities require explicit mapping.',
        'This inventory creates no tasks, changes no request state and authorizes no execution.']};
  }
}

module.exports = {ErasureResourcePlanner};
