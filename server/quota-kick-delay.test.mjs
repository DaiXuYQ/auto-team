import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clearQuotaKickDelay,
  normalizeDelayedKickMinutes,
  quotaKickDelayDue,
  updateQuotaKickDelay,
} from './quota-kick-delay.mjs';

const START = Date.parse('2026-09-24T08:00:00.000Z');
const exhausted5h = { ok: true, primary: { usedPercent: 100 }, secondary: { usedPercent: 30 } };
const exhausted7d = { ok: true, primary: { usedPercent: 30 }, secondary: { usedPercent: 100 } };

function membership(window = '5h') {
  return { team: 'workspace-a', status: 'active', quotaStatus: 'exhausted', quotaStatusWindow: window };
}

test('quota delay keeps the first exhaustion deadline across checks and persisted state', () => {
  const entry = membership();
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 12, probe: exhausted5h, nowMs: START });
  assert.equal(entry.quotaKickExhaustedAt, '2026-09-24T08:00:00.000Z');
  assert.equal(entry.quotaKickPendingUntil, '2026-09-24T08:12:00.000Z');
  assert.equal(quotaKickDelayDue(entry, '5h', START + 12 * 60_000), false, 'a timer alone cannot authorize a removal');

  const restored = JSON.parse(JSON.stringify(entry));
  updateQuotaKickDelay(restored, { enabled: true, window: '5h', minutes: 12, probe: exhausted5h, nowMs: START + 5 * 60_000 });
  assert.equal(restored.quotaKickExhaustedAt, entry.quotaKickExhaustedAt, 'repeat detection must not restart the timer');
  assert.equal(restored.quotaKickPendingUntil, entry.quotaKickPendingUntil);
  assert.equal(quotaKickDelayDue(restored, '5h', START + 11 * 60_000), false);

  updateQuotaKickDelay(restored, { enabled: true, window: '5h', minutes: 12, probe: exhausted5h, nowMs: START + 12 * 60_000 });
  assert.equal(restored.quotaKickVerifiedAt, restored.quotaKickPendingUntil);
  assert.equal(quotaKickDelayDue(restored, '5h', START + 12 * 60_000), true);
  assert.equal(quotaKickDelayDue(restored, '7d', START + 12 * 60_000), false);
});

test('failed and incomplete quota probes cannot establish or verify a delayed removal', () => {
  const entry = membership();
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: { ok: false, primary: { usedPercent: 100 } }, nowMs: START });
  assert.equal(entry.quotaKickPendingUntil, undefined);

  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: exhausted5h, nowMs: START });
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: { ok: false, primary: { usedPercent: 100 } }, nowMs: START + 11 * 60_000 });
  assert.equal(quotaKickDelayDue(entry, '5h', START + 11 * 60_000), false);
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: { ok: true, primary: {} }, nowMs: START + 11 * 60_000 });
  assert.equal(quotaKickDelayDue(entry, '5h', START + 11 * 60_000), false);
});

test('quota recovery and policy changes clear stale deadlines', () => {
  const entry = membership();
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: exhausted5h, nowMs: START });
  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: { ok: true, primary: { usedPercent: 98 } }, nowMs: START + 4 * 60_000 });
  assert.equal(entry.quotaKickPendingUntil, null);
  assert.equal(quotaKickDelayDue(entry, '5h', START + 30 * 60_000), false);

  updateQuotaKickDelay(entry, { enabled: true, window: '5h', minutes: 10, probe: exhausted5h, nowMs: START + 5 * 60_000 });
  assert.equal(entry.quotaKickExhaustedAt, '2026-09-24T08:05:00.000Z');
  updateQuotaKickDelay(entry, { enabled: true, window: '7d', minutes: 10, probe: exhausted7d, nowMs: START + 6 * 60_000 });
  entry.quotaStatusWindow = '7d';
  assert.equal(entry.quotaKickWindow, '7d');
  assert.equal(entry.quotaKickExhaustedAt, '2026-09-24T08:06:00.000Z');
  assert.equal(entry.quotaKickPendingUntil, '2026-09-24T08:16:00.000Z');
  assert.equal(quotaKickDelayDue(entry, '5h', START + 30 * 60_000), false);

  updateQuotaKickDelay(entry, { enabled: false, window: '7d', minutes: 10, probe: exhausted7d, nowMs: START + 7 * 60_000 });
  assert.equal(entry.quotaKickPendingUntil, null);
  updateQuotaKickDelay(entry, { enabled: true, window: 'time', minutes: 10, probe: exhausted7d, nowMs: START + 8 * 60_000 });
  assert.equal(entry.quotaKickPendingUntil, null);
  clearQuotaKickDelay(entry);
  assert.equal(quotaKickDelayDue(entry, '7d', START + 30 * 60_000), false);
});

test('delay requires the selected window to be confirmed exhausted', () => {
  const entry = membership('7d');
  updateQuotaKickDelay(entry, { enabled: true, window: '7d', minutes: 1, probe: exhausted7d, nowMs: START });
  assert.equal(quotaKickDelayDue(entry, '7d', START + 2 * 60_000), false);
  updateQuotaKickDelay(entry, { enabled: true, window: '7d', minutes: 1, probe: exhausted7d, nowMs: START + 2 * 60_000 });
  assert.equal(quotaKickDelayDue(entry, '7d', START + 2 * 60_000), true);
  entry.quotaStatus = 'unknown';
  assert.equal(quotaKickDelayDue(entry, '7d', START + 2 * 60_000), false);
  entry.quotaStatus = 'available';
  assert.equal(quotaKickDelayDue(entry, '7d', START + 2 * 60_000), false);
  assert.equal(normalizeDelayedKickMinutes(-1), 1);
  assert.equal(normalizeDelayedKickMinutes(2000), 1440);
});

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));

function token(accountId) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'team' },
  };
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test-signature`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function isolatedTeam(t, membershipFields = {}, { status = 'active', usedPercent = 100, weeklyUsedPercent = 10, quotaFails = false, rotationMode = 'fixed' } = {}) {
  const accountId = 'quota-delay-workspace';
  const childEmail = 'member@example.test';
  const members = [
    { id: 'owner-member', email: 'owner@example.test', role: 'account-owner', seat_type: 'default' },
    { id: 'child-member', email: childEmail, role: 'standard-user', seat_type: 'default' },
  ];
  const requests = [];
  const remote = { usedPercent, weeklyUsedPercent, quotaFails };
  const upstream = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname });
    let payload;
    let responseStatus = 200;
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      payload = {
        seats_in_use: members.length,
        seats_entitled: 2,
        seat_capacity: [{ type: 'default', paid: 2, held: 0 }],
        assigned: { default: members.length },
      };
    } else if (req.method === 'GET' && url.pathname === `/backend-api/accounts/${accountId}/users`) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 100;
      payload = { items: members.slice(offset, offset + limit), total: members.length, offset, limit };
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      responseStatus = remote.quotaFails ? 503 : 200;
      payload = remote.quotaFails
        ? { error: 'usage_temporarily_unavailable' }
        : { rate_limit: { primary_window: { used_percent: remote.usedPercent, reset_after_seconds: 3600 }, secondary_window: { used_percent: remote.weeklyUsedPercent } } };
    } else if (req.method === 'POST' && url.pathname === '/backend-api/codex/responses') {
      payload = { status: 'active' };
    } else if (req.method === 'DELETE' && url.pathname === `/backend-api/accounts/${accountId}/users/child-member`) {
      const index = members.findIndex((member) => member.id === 'child-member');
      if (index >= 0) members.splice(index, 1);
      payload = { success: true };
    } else {
      responseStatus = 503;
      payload = { message: 'unexpected_mock_request' };
    }
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const dataRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(dataRoot, 'quota-kick-delay-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), dataRoot);
    assert.match(path.basename(dataDir), /^quota-kick-delay-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  const teamToken = token(accountId);
  const state = {
    settings: { autoRefill: false, promoteJoinedAccounts: false, kickWindow: '5h', delayedKickEnabled: true, delayedKickMinutes: 10 },
    mothers: [{ id: 'quota-delay-mother', accountId, team: accountId, email: 'owner@example.test', primaryOwnerEmail: 'owner@example.test', accessToken: teamToken, rotationMode }],
    children: [{
      id: 'quota-delay-child', email: childEmail, status, team: accountId,
      workspaceTokens: { [accountId]: { accessToken: teamToken } },
      workspaceHistory: [{ team: accountId, status: 'active', joinedAt: new Date(START).toISOString(), memberId: 'child-member', ...membershipFields }],
    }],
    history: [],
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie;
  const apiFetch = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    ...options, headers: { ...options.headers, cookie },
  });
  async function start() {
    let output = '';
    app = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        HOST: '127.0.0.1', PORT: String(port), CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        TEAM_ROTATION_DATA_DIR: dataDir, TEAM_ROTATION_DATA_KEY: 'quota-delay-test-only-key',
        TEAM_ROTATION_API_TOKEN: '', TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
        DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false',
        OPENAI_REQUEST_TIMEOUT_MS: '2000',
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    app.stdout.on('data', (chunk) => { output += chunk.toString(); });
    app.stderr.on('data', (chunk) => { output += chunk.toString(); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`isolated app exited: ${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for the isolated child process to bind its local port.
      }
      await delay(50);
    }
    if (!ready) throw new Error(`isolated app did not start: ${output}`);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'daixuteam' }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(login.status, 200, await login.text());
    cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.match(cookie || '', /^team_rotation_session=/);
  }
  async function stop() {
    if (!app || app.exitCode !== null || app.signalCode !== null) return;
    const exited = new Promise((resolve) => app.once('exit', resolve));
    app.kill();
    await exited;
  }
  async function post(pathname) {
    const response = await apiFetch(pathname, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ motherId: 'quota-delay-mother' }), signal: AbortSignal.timeout(6000),
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }
  async function memberState() {
    const response = await apiFetch('/api/state', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    return payload.children[0].joinedTeams.find((entry) => entry.team === accountId);
  }
  await start();
  return { remote, requests, start, stop, post, memberState };
}

test('detected exhaustion waits, survives restart, and clears after quota recovery', { timeout: 25_000 }, async (t) => {
  const sandbox = await isolatedTeam(t);
  const checked = await sandbox.post('/api/maintenance/check');
  assert.equal(checked.syncOk, true, JSON.stringify(checked));
  const pending = await sandbox.memberState();
  assert.ok(pending.quotaKickPendingUntil);
  assert.equal(pending.quotaKickWindow, '5h');
  const firstRefill = await sandbox.post('/api/maintenance/refill');
  assert.deepEqual(firstRefill.kicked, []);
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 0);

  await sandbox.stop();
  await sandbox.start();
  assert.equal((await sandbox.memberState()).quotaKickPendingUntil, pending.quotaKickPendingUntil);
  sandbox.remote.usedPercent = 45;
  await sandbox.post('/api/maintenance/check');
  assert.equal((await sandbox.memberState()).quotaKickPendingUntil, null);
  assert.deepEqual((await sandbox.post('/api/maintenance/refill')).kicked, []);
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('rotating Team waits for the 7d quota rather than the exhausted 5h quota', { timeout: 20_000 }, async (t) => {
  const sandbox = await isolatedTeam(t, {}, { rotationMode: 'rotating', usedPercent: 100, weeklyUsedPercent: 30 });
  await sandbox.post('/api/maintenance/check');
  assert.equal((await sandbox.memberState()).quotaKickPendingUntil, null);
  sandbox.remote.weeklyUsedPercent = 100;
  await sandbox.post('/api/maintenance/check');
  const pending = await sandbox.memberState();
  assert.equal(pending.quotaKickWindow, '7d');
  assert.ok(pending.quotaKickPendingUntil);
  assert.deepEqual((await sandbox.post('/api/maintenance/refill')).kicked, []);
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('a failed quota probe cannot approve an expired delayed removal', { timeout: 20_000 }, async (t) => {
  const nowMs = Date.now();
  const sandbox = await isolatedTeam(t, {
    quotaStatus: 'exhausted', quotaStatusWindow: '5h', quotaKickWindow: '5h',
    quotaKickExhaustedAt: new Date(nowMs - 25 * 60_000).toISOString(),
    quotaKickPendingUntil: new Date(nowMs - 15 * 60_000).toISOString(),
    quotaKickVerifiedAt: new Date(nowMs - 20 * 60_000).toISOString(),
  }, { quotaFails: true });
  const checked = await sandbox.post('/api/maintenance/check');
  assert.equal(checked.probesOk, false);
  const pending = await sandbox.memberState();
  assert.equal(pending.quotaStatus, 'unknown');
  assert.equal(pending.quotaKickVerifiedAt, null);
  assert.ok(pending.quotaKickPendingUntil, 'the deadline should survive a transient probe failure');
  assert.deepEqual((await sandbox.post('/api/maintenance/refill')).kicked, []);
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('manual refill rechecks an old approved deadline before removing a recovered account', { timeout: 20_000 }, async (t) => {
  const nowMs = Date.now();
  const sandbox = await isolatedTeam(t, {
    quotaStatus: 'exhausted', quotaStatusWindow: '5h', quotaKickWindow: '5h',
    quotaKickExhaustedAt: new Date(nowMs - 25 * 60_000).toISOString(),
    quotaKickPendingUntil: new Date(nowMs - 15 * 60_000).toISOString(),
    quotaKickVerifiedAt: new Date(nowMs - 14 * 60_000).toISOString(),
  }, { usedPercent: 40 });
  const result = await sandbox.post('/api/maintenance/refill');
  assert.deepEqual(result.kicked, []);
  assert.equal((await sandbox.memberState()).quotaKickPendingUntil, null);
  assert.ok(sandbox.requests.some((request) => request.path === '/backend-api/wham/usage'));
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('a past-due account is removed after a fresh exhausted quota probe', { timeout: 20_000 }, async (t) => {
  const nowMs = Date.now();
  const sandbox = await isolatedTeam(t, {
    quotaStatus: 'exhausted', quotaStatusWindow: '5h', quotaKickWindow: '5h',
    quotaKickExhaustedAt: new Date(nowMs - 25 * 60_000).toISOString(),
    quotaKickPendingUntil: new Date(nowMs - 15 * 60_000).toISOString(),
    quotaKickVerifiedAt: new Date(nowMs - 20 * 60_000).toISOString(),
  });
  const result = await sandbox.post('/api/maintenance/refill');
  assert.equal(result.kicked.length, 1, JSON.stringify(result));
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 1);
  assert.equal((await sandbox.memberState()).reason, 'quota_5h');
});

test('an expired manual timer removes a member without waiting for quota delay', { timeout: 20_000 }, async (t) => {
  const nowMs = Date.now();
  const sandbox = await isolatedTeam(t, {
    quotaStatus: 'exhausted', quotaStatusWindow: '5h', quotaKickWindow: '5h',
    quotaKickExhaustedAt: new Date(nowMs - 2 * 60_000).toISOString(),
    quotaKickPendingUntil: new Date(nowMs + 8 * 60_000).toISOString(),
    quotaKickVerifiedAt: new Date(nowMs - 2 * 60_000).toISOString(),
    manualKickEnabled: true, manualKickStartedAt: new Date(nowMs - 2 * 60_000).toISOString(),
    manualKickAt: new Date(nowMs - 60_000).toISOString(), manualKickDurationMinutes: 1,
  });
  const result = await sandbox.post('/api/maintenance/refill');
  assert.equal(result.kicked.length, 1, JSON.stringify(result));
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 1);
  assert.equal((await sandbox.memberState()).reason, 'manual_time_elapsed');
});

test('a confirmed banned member bypasses the quota delay', { timeout: 20_000 }, async (t) => {
  const nowMs = Date.now();
  const sandbox = await isolatedTeam(t, {
    quotaStatus: 'exhausted', quotaStatusWindow: '5h', quotaKickWindow: '5h',
    quotaKickExhaustedAt: new Date(nowMs - 2 * 60_000).toISOString(),
    quotaKickPendingUntil: new Date(nowMs + 8 * 60_000).toISOString(),
    quotaKickVerifiedAt: new Date(nowMs - 2 * 60_000).toISOString(),
  }, { status: 'banned' });
  const result = await sandbox.post('/api/maintenance/refill');
  assert.equal(result.kicked.length, 1, JSON.stringify(result));
  assert.equal(sandbox.requests.filter((request) => request.method === 'DELETE').length, 1);
  assert.equal((await sandbox.memberState()).reason, 'account_banned');
});
