'use strict';

const express = require('express');
const request = require('supertest');
const auth = require('../../shared/auth');
const authenticate = require('../../shared/middleware/auth');

function app() {
  const server = express();
  server.get('/identity', authenticate, (req, res) => res.json({ id: req.user.id, userId: req.userId }));
  server.get('/admin', authenticate.authenticate, authenticate.requireAdmin, (req, res) => res.json({ id: req.user.id }));
  server.get('/permission', authenticate, authenticate.requirePermissions('ops'), (req, res) => res.json({ id: req.user.id }));
  server.get('/optional', authenticate.optionalAuth, (req, res) => res.json({ id: req.user?.id || null }));
  server.use((error, req, res, next) => res.status(error.statusCode || 500).json({ code: error.code }));
  return server;
}

test('user-service sub claims supply the identity expected by service routes', async () => {
  const response = await request(app()).get('/identity').set('Authorization', `Bearer ${auth.signAccess({ sub: 'user-123' })}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ id: 'user-123', userId: 'user-123' });
});

test('legacy id claims remain compatible', async () => {
  const response = await request(app()).get('/identity').set('Authorization', `Bearer ${auth.signAccess({ id: 'legacy-user' })}`);
  expect(response.status).toBe(200);
  expect(response.body.id).toBe('legacy-user');
});

test('the verified subject takes precedence over a conflicting id claim', async () => {
  const response = await request(app()).get('/identity').set('Authorization', `Bearer ${auth.signAccess({ sub: 'subject', id: 'other' })}`);
  expect(response.body.id).toBe('subject');
});

test('admin routes reject unauthenticated callers', async () => {
  expect((await request(app()).get('/admin')).status).toBe(401);
});

test('admin routes reject authenticated members and forged role headers', async () => {
  const response = await request(app()).get('/admin').set('Authorization', `Bearer ${auth.signAccess({ sub: 'member' })}`).set('X-Role', 'admin');
  expect(response.status).toBe(403);
});

test('admin routes accept verified admin roles', async () => {
  const response = await request(app()).get('/admin').set('Authorization', `Bearer ${auth.signAccess({ sub: 'admin-user', roles: ['admin'] })}`);
  expect(response.status).toBe(200);
});

test('signed tokens without a subject are rejected', async () => {
  const response = await request(app()).get('/admin').set('Authorization', `Bearer ${auth.signAccess({ roles: ['admin'] })}`);
  expect(response.status).toBe(401);
});

test('tampered signatures cannot reach service handlers', async () => {
  const token = auth.signAccess({ sub: 'user-123' });
  const response = await request(app()).get('/identity').set('Authorization', `Bearer ${token.slice(0, -8)}tampered`);
  expect(response.status).toBe(401);
});

test('permissions use verified token claims', async () => {
  const server = app();
  expect((await request(server).get('/permission').set('Authorization', `Bearer ${auth.signAccess({ sub: 'member' })}`)).status).toBe(403);
  expect((await request(server).get('/permission').set('Authorization', `Bearer ${auth.signAccess({ sub: 'operator', permissions: ['ops'] })}`)).status).toBe(200);
});

test('optional authentication normalizes valid subjects and ignores invalid tokens', async () => {
  const server = app();
  expect((await request(server).get('/optional').set('Authorization', `Bearer ${auth.signAccess({ sub: 'member' })}`)).body.id).toBe('member');
  expect((await request(server).get('/optional').set('Authorization', 'Bearer invalid')).body.id).toBe(null);
});
