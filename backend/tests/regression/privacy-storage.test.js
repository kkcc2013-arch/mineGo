'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {Pool} = require('pg');
const express = require('express');
const request = require('supertest');
const {signAccess, errorHandler} = require('../../shared/auth');
const {router, initPrivacyRoutes} = require('../../services/user-service/src/routes/privacy');
const {PrivacyPreferencesService} = require('../../shared/privacyPreferences');
const {mountPrivacyProxy} = require('../../gateway/src/routes/privacyProxy');

test('privacy preferences and actual proxy routes with PostgreSQL, JWT and audit transactions', async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const schema = `privacy_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`});
  const database = {query: db.query.bind(db), getClient: () => db.connect()};
  let upstream, proxy;
  const userId = crypto.randomUUID();
  const secondUserId = crypto.randomUUID();
  try {
    await db.query('CREATE TABLE users (id UUID PRIMARY KEY, nickname VARCHAR(30))');
    // Use the actual initial audit definition and legacy policy definition so the
    // additive migration is exercised against the existing schema shapes.
    const initial = await fs.readFile(path.resolve(__dirname, '../../../database/migrations/V1__initial_schema.sql'), 'utf8');
    await db.query(initial.match(/CREATE TABLE audit_logs \([\s\S]*?\n\);/)[0]);
    const legacy = await fs.readFile(path.resolve(__dirname, '../../../database/pending/20260605_161000__add_gdpr_tables.sql'), 'utf8');
    await db.query(legacy.match(/CREATE TABLE IF NOT EXISTS privacy_policy_versions \([\s\S]*?\n\);/)[0]);
    await db.query("INSERT INTO privacy_policy_versions (version,title,content,published_at) VALUES ('legacy','Existing policy','Existing text', NOW() - INTERVAL '1 day')");
    const migration = await fs.readFile(path.resolve(__dirname, '../../../database/pending/20261006_150000__privacy_preference_defaults_and_policy_fields.sql'), 'utf8');
    await db.query(migration); await db.query(migration); // Idempotence must preserve existing text and choices.
    await db.query('INSERT INTO users (id,nickname) VALUES ($1,$2),($3,$4)', [userId,'player',secondUserId,'second']);
    initPrivacyRoutes(database);
    const service = express(); service.use(express.json()); service.use('/privacy', router); service.use(errorHandler);
    upstream = http.createServer(service);
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const gateway = express(); gateway.use(express.json());
    proxy = mountPrivacyProxy(gateway, `http://127.0.0.1:${upstream.address().port}`); gateway.use(errorHandler);
    const token = signAccess({sub: userId});
    const adminToken = signAccess({sub: userId, roles: ['admin']});
    const secondToken = signAccess({sub: secondUserId});
    const authenticated = (method, route, identity = token) => request(gateway)[method](route).set('Authorization', `Bearer ${identity}`);

    await t.test('migration upgrades the other policy table shape and preserves existing choices', async () => {
      const alternateSchema = `${schema}_alternate`;
      await admin.query(`CREATE SCHEMA ${alternateSchema}`);
      const alternate = new Pool({connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${alternateSchema},public`});
      try {
        await alternate.query('CREATE TABLE users (id UUID PRIMARY KEY)');
        const preferenceSchema = await fs.readFile(path.resolve(__dirname, '../../../database/pending/20260611_152900__add_privacy_preference_center.sql'), 'utf8');
        await alternate.query(preferenceSchema.match(/CREATE TABLE IF NOT EXISTS privacy_policy_versions \([\s\S]*?\n\);/)[0]);
        await alternate.query(preferenceSchema.match(/CREATE TABLE IF NOT EXISTS user_privacy_preferences \([\s\S]*?\n\);/)[0]);
        await alternate.query("INSERT INTO user_privacy_preferences (user_id,category,collectable,consented_at) VALUES ($1,'marketing',true,'2020-01-01')", [userId]);
        const priorConsent = (await alternate.query('SELECT consented_at FROM user_privacy_preferences')).rows[0].consented_at;
        await alternate.query(migration);
        const preserved = (await alternate.query('SELECT collectable,consented_at FROM user_privacy_preferences')).rows[0];
        assert.equal(preserved.collectable, true); assert.equal(preserved.consented_at.getTime(), priorConsent.getTime());
        await alternate.query("INSERT INTO user_privacy_preferences (user_id,category) VALUES ($1,'analytics')", [userId]);
        assert.equal((await alternate.query("SELECT collectable FROM user_privacy_preferences WHERE category='analytics'")).rows[0].collectable, false);
        const policy = new (require('../../shared/privacyPreferences').PrivacyPolicyService)({query: alternate.query.bind(alternate)});
        assert.equal((await policy.createPolicyVersion('new-v1', '2020-01-01', [], 'zh', 'en', 'ja')).version, 'new-v1');
      } finally {
        await alternate.end(); await admin.query(`DROP SCHEMA ${alternateSchema} CASCADE`);
      }
    });
    await t.test('public categories work; private and admin routes verify JWT and roles', async () => {
      assert.equal((await request(gateway).get('/api/v1/privacy/categories')).body.data.length, 8);
      assert.equal((await request(gateway).get('/api/v1/privacy/preferences')).status, 401);
      assert.equal((await authenticated('get', '/api/v1/privacy/preferences', 'forged')).status, 401);
      assert.equal((await authenticated('get', '/api/v1/privacy/admin/pending-users')).status, 403);
      assert.equal((await authenticated('post', '/api/v1/admin/privacy/policy').send({})).status, 403);
    });
    await t.test('all supported gateway prefixes reach the real preference router', async () => {
      for (const prefix of ['/api/v1/privacy','/api/v1/user/privacy','/v1/privacy']) {
        const result = await authenticated('get', `${prefix}/preferences`);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.userId, userId);
        assert.equal(result.body.data.preferences.marketing.collectable, false);
        assert.equal(result.body.data.preferences.location.collectable, true);
      }
    });
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const policyData = {version: 'current', effectiveDate: past, contentZh: '中文', contentEn: 'English', contentJa: '日本語'};
    await t.test('creates translated policies against the legacy table and excludes future versions', async () => {
      assert.equal((await authenticated('post', '/api/v1/admin/privacy/policy', adminToken).send(policyData)).status, 200);
      // The legacy policy is newer than current; remove only the isolated fixture to select current.
      await db.query("UPDATE privacy_policy_versions SET is_active = false WHERE version = 'legacy'");
      assert.equal((await authenticated('post', '/api/v1/admin/privacy/policy', adminToken).send({...policyData, version: 'future', effectiveDate: future})).status, 200);
      const response = await request(gateway).get('/api/v1/privacy/policy').set('Accept-Language', 'en-US');
      assert.equal(response.status, 200);
      assert.equal(response.body.data.current.version, 'current');
      assert.equal(response.body.data.current.content, 'English');
      assert.ok(response.body.data.previousVersions.every(version => version.version !== 'future' && version.version !== 'current'));
      const check = await authenticated('get', '/api/v1/privacy/policy/check');
      assert.equal(check.body.data.version, 'current');
      assert.equal(check.body.data.needsAccept, true);
    });
    await t.test('rejects unknown and future policy consent without persisting acceptance', async () => {
      for (const version of ['unknown', 'future']) assert.equal((await authenticated('post', '/api/v1/privacy/policy/accept').send({version})).status, 400);
      assert.equal((await db.query('SELECT COUNT(*) FROM privacy_policy_acceptance')).rows[0].count, '0');
    });
    await t.test('policy acceptance initializes conservative defaults and persists its audit atomically', async () => {
      assert.equal((await authenticated('post', '/api/v1/privacy/policy/accept').send({})).status, 200);
      const rows = (await db.query('SELECT category,collectable,consented_at FROM user_privacy_preferences WHERE user_id=$1', [userId])).rows;
      assert.equal(rows.length, 8);
      for (const row of rows) {
        assert.equal(row.collectable, ['location','device'].includes(row.category));
        assert.equal(row.consented_at, null);
      }
      assert.equal((await db.query("SELECT COUNT(*) FROM audit_logs WHERE user_id=$1 AND action='privacy_policy_accept'", [userId])).rows[0].count, '1');
      assert.equal((await authenticated('get','/api/v1/privacy/policy/check')).body.data.needsAccept, false);
    });
    await t.test('explicit opt-in and withdrawal update consent time and audit records', async () => {
      assert.equal((await authenticated('patch','/api/v1/privacy/preferences').send({marketing: true})).status, 200);
      let preference = (await db.query("SELECT * FROM user_privacy_preferences WHERE user_id=$1 AND category='marketing'", [userId])).rows[0];
      assert.ok(preference.consented_at);
      assert.equal(preference.collectable, true);
      // Accepting the same policy again must not overwrite explicit choices.
      assert.equal((await authenticated('post','/api/v1/privacy/policy/accept').send({})).status, 200);
      assert.equal(await new PrivacyPreferencesService(database).canCollectData(userId, 'marketing'), true);
      assert.equal((await authenticated('patch','/api/v1/privacy/preferences').send({marketing: false})).status, 200);
      preference = (await db.query("SELECT * FROM user_privacy_preferences WHERE user_id=$1 AND category='marketing'", [userId])).rows[0];
      assert.equal(preference.collectable, false); assert.equal(preference.consented_at, null);
      assert.equal((await db.query("SELECT COUNT(*) FROM audit_logs WHERE user_id=$1 AND action='privacy_preference_change'", [userId])).rows[0].count, '2');
    });
    await t.test('rejects invalid and mixed updates without partially changing preferences', async () => {
      for (const body of [{location:false}, {marketing:'false'}, {unknown:true}, [], {marketing:true, device:false}]) {
        assert.equal((await authenticated('patch','/api/v1/privacy/preferences').send(body)).status, 400);
      }
      assert.equal(await new PrivacyPreferencesService(database).canCollectData(userId, 'marketing'), false);
      assert.equal((await authenticated('get','/api/v1/privacy/admin/pending-users', adminToken)).status, 200);
      assert.equal((await authenticated('get','/api/v1/privacy/admin/pending-users?limit=999999', adminToken)).status, 400);
      assert.equal((await authenticated('get','/api/v1/privacy/report/history?limit=5abc')).status, 400);
      assert.equal((await authenticated('post','/api/v1/privacy/policy/accept').send({version: 5})).status, 400);
      assert.equal((await authenticated('post','/api/v1/admin/privacy/policy', adminToken).send({...policyData, effectiveDate:'2026-02-30'})).status, 400);
    });
    await t.test('monthly transparency reports use stored access logs and expose real metrics', async () => {
      const preferences = new PrivacyPreferencesService(database);
      await preferences.logDataAccess(userId, 'location', 'query', 'test-route');
      const month = new Date().toISOString().slice(0, 7);
      const report = await authenticated('get', `/api/v1/privacy/report?month=${month}`);
      assert.equal(report.status, 200);
      assert.equal(report.body.data.summary.totalDataPoints, 1);
      assert.equal((await authenticated('get', '/api/v1/privacy/report/history')).body.data.length, 1);
      assert.equal((await authenticated('get', '/api/v1/privacy/report?month=2026-13')).status, 400);
      const metrics = await require('../../shared/metrics').register.metrics();
      assert.match(metrics, /minego_privacy_preference_changes_total\{category="marketing",action="enable"\} 1/);
      assert.match(metrics, /minego_privacy_policy_views_total\{version="current",language="en-US"\} 1/);
      assert.match(metrics, /minego_transparency_reports_generated_total 1/);
    });
    await t.test('audit failure rolls back both preference updates and policy acceptance', async () => {
      await db.query("ALTER TABLE audit_logs ADD CONSTRAINT reject_privacy_test_audit CHECK (action NOT IN ('privacy_preference_change','privacy_policy_accept')) NOT VALID");
      assert.equal((await authenticated('patch','/api/v1/privacy/preferences').send({marketing:true})).status, 500);
      assert.equal(await new PrivacyPreferencesService(database).canCollectData(userId, 'marketing'), false);
      assert.equal((await authenticated('post','/api/v1/privacy/policy/accept', secondToken).send({})).status, 500);
      assert.equal((await db.query('SELECT COUNT(*) FROM privacy_policy_acceptance WHERE user_id=$1', [secondUserId])).rows[0].count, '0');
      assert.equal((await db.query('SELECT COUNT(*) FROM user_privacy_preferences WHERE user_id=$1', [secondUserId])).rows[0].count, '0');
    });
  } finally {
    proxy?.close();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
