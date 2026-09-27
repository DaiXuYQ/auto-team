import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardAuth } from './dashboard-auth.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const request = (token, headers = {}) => ({ headers: { cookie: `team_rotation_session=${token}`, ...headers }, socket: {} });

test('password validation creates unpredictable, distinct sessions without accepting other inputs', () => {
  const auth = createDashboardAuth();
  assert.equal(auth.login('wrong'), null);
  assert.equal(auth.login(''), null);
  assert.equal(auth.login({ toString: () => 'daixuteam' }), null);
  const first = auth.login('daixuteam');
  const second = auth.login('daixuteam');
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(auth.authenticated(request(first)), true);
  assert.equal(auth.authenticated(request(second)), true);
  assert.equal(auth.authenticated({ headers: { authorization: `Bearer ${first}` } }), false);
  assert.equal(auth.authenticated(request('X'.repeat(43))), false);

  const custom = createDashboardAuth({ password: 'secret' });
  assert.equal(custom.login('daixuteam'), null);
  assert.ok(custom.login('secret'));
});

test('session expires at seven days and logout revokes it immediately', () => {
  let time = 1000;
  const auth = createDashboardAuth({ now: () => time });
  const token = auth.login('daixuteam');
  time += WEEK_MS - 1;
  assert.equal(auth.authenticated(request(token)), true);
  time++;
  assert.equal(auth.authenticated(request(token)), false);

  const next = auth.login('daixuteam');
  assert.equal(auth.logout(request(next)), true);
  assert.equal(auth.logout(request(next)), false);
  assert.equal(auth.authenticated(request(next)), false);
});

test('parses only a single exact and well-formed session cookie', () => {
  const auth = createDashboardAuth();
  const token = auth.login('daixuteam');
  assert.equal(auth.authenticated(request(token, { cookie: `other=value; team_rotation_session=${token}; more=yes` })), true);
  assert.equal(auth.authenticated(request(token, { cookie: `other_team_rotation_session=${token}` })), false);
  assert.equal(auth.authenticated(request(token, { cookie: `team_rotation_session=${token}; team_rotation_session=${token}` })), false);
  assert.equal(auth.authenticated(request(token, { cookie: `team_rotation_session=%${token}` })), false);
  assert.equal(auth.authenticated(request(token, { cookie: `team_rotation_session=${token}\r\nSet-Cookie: injected=1` })), false);
  assert.equal(auth.authenticated({ headers: { cookie: 'x'.repeat(8193) } }), false);
  assert.equal(auth.authenticated({ headers: { cookie: ['team_rotation_session=' + token] } }), false);
  assert.equal(auth.authenticated(null), false);
});

test('cookie attributes scope sessions to API and secure both creation and clearing over HTTPS', () => {
  const auth = createDashboardAuth();
  const token = auth.login('daixuteam');
  const plain = request(token);
  assert.equal(auth.cookie(token, plain), `team_rotation_session=${token}; Max-Age=604800; Path=/api; HttpOnly; SameSite=Lax`);
  assert.equal(auth.clearCookie(plain), 'team_rotation_session=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax');
  assert.match(auth.cookie(token, { socket: { encrypted: true } }), /; Secure$/);
  assert.match(auth.clearCookie({ headers: { 'x-forwarded-proto': 'https' } }), /; Secure$/);
  assert.match(auth.cookie(token, { headers: { 'x-forwarded-proto': 'HTTPS, http' } }), /; Secure$/);
  assert.doesNotMatch(auth.cookie(token, { headers: { 'x-forwarded-proto': 'http, https' } }), /; Secure$/);
  assert.throws(() => auth.cookie('bad\r\nSet-Cookie: unsafe=1', plain), /invalid_session_token/);
});

test('caps active in-memory sessions by evicting the oldest token', () => {
  const auth = createDashboardAuth();
  const oldest = auth.login('daixuteam');
  for (let index = 0; index < 1024; index++) auth.login('daixuteam');
  assert.equal(auth.authenticated(request(oldest)), false);
});

test('limits failed logins per remote address without locking out the correct password', () => {
  let time = 0;
  const auth = createDashboardAuth({ now: () => time });
  const alice = { socket: { remoteAddress: '192.0.2.1' }, headers: { 'x-forwarded-for': '203.0.113.1' } };
  const bob = { socket: { remoteAddress: '192.0.2.2' }, headers: { 'x-forwarded-for': '203.0.113.1' } };
  for (let index = 0; index < 5; index++) assert.equal(auth.login('wrong', alice), null);
  assert.equal(auth.isRateLimited(alice), true);
  assert.ok(auth.login('daixuteam', alice));
  assert.equal(auth.isRateLimited(alice), false);
  assert.ok(auth.login('daixuteam', bob));
  time += 15 * 60 * 1000;
  assert.equal(auth.isRateLimited(alice), false);
  assert.equal(auth.login('wrong', alice), null);
  assert.ok(auth.login('daixuteam', alice));
  assert.equal(auth.isRateLimited(alice), false);
});
