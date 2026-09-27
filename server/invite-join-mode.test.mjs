import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const workspaceId = 'workspace-invite-mode-test';
const motherId = 'mother-invite-mode-test';

function token(accountId = '', marker = '') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': accountId
      ? { chatgpt_account_id: accountId, chatgpt_plan_type: 'team' }
      : { chatgpt_plan_type: 'free' },
  })).toString('base64url');
  return `${header}.${payload}.${marker || 'test-signature'}`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForApp(baseUrl, app, output) {
  let last = 'no_response';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`test app exited: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      last = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      last = error?.message || String(error);
    }
    await delay(50);
  }
  throw new Error(`test app did not start (${last}): ${output()}`);
}

async function fixture(t, {
  joinMode = 'invite', ownerEmail = 'owner@gmail.com', childEmails = ['child@different.test'],
  seatType = 'default', defaultSeatType = seatType, paidDefault = 2, paidProlite = 0, heldProlite = 0,
  invitationRows = [], confirmMember = true, confirmedSeatType = null, acceptStatus = 200,
  acceptPayload = { success: true }, defaultSeatStatus = 200, defaultSeatPayload = { success: true },
  initialMembers = [], pushConfigured = false,
} = {}) {
  const requests = [];
  const pushRequests = [];
  const unexpected = [];
  const ownerToken = token(workspaceId);
  const members = [{ id: 'owner-user', email: ownerEmail, role: 'account-owner', seat_type: 'default' }, ...initialMembers];
  const pendingInvites = [...invitationRows];
  const pendingRequests = new Map();
  const freeTokens = new Map(childEmails.map((email) => [email.toLowerCase(), token('', email)]));
  let remoteDefaultSeatType = defaultSeatType;
  const emailForAuthorization = (authorization) => [...freeTokens]
    .find(([, accessToken]) => `Bearer ${accessToken}` === authorization)?.[0];
  const assignedSeatType = () => {
    if (confirmedSeatType) return confirmedSeatType;
    const remaining = {
      default: Math.max(0, paidDefault - members.filter((member) => member.seat_type === 'default').length),
      prolite: Math.max(0, paidProlite - heldProlite - members.filter((member) => member.seat_type === 'prolite').length),
    };
    if (remaining[remoteDefaultSeatType] > 0) return remoteDefaultSeatType;
    return ['default', 'prolite'].find((type) => remaining[type] > 0) || remoteDefaultSeatType;
  };
  let sub2api;
  let sub2apiPort;
  if (pushConfigured) {
    sub2api = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let bodyText = '';
      for await (const chunk of req) bodyText += chunk;
      const body = bodyText ? JSON.parse(bodyText) : null;
      pushRequests.push({ method: req.method, path: url.pathname, body });
      let status = 200;
      let data = {};
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/accounts') data = { items: [] };
      else if (req.method === 'POST' && url.pathname === '/api/v1/admin/accounts') data = { id: 'sub2api-created' };
      else status = 503;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
    sub2apiPort = await listen(sub2api);
  }
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const bodyText = await new Promise((resolve) => {
      let value = '';
      req.on('data', (chunk) => { value += chunk; });
      req.on('end', () => resolve(value));
    });
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
    const entry = { method: req.method, path: url.pathname, search: url.search, authorization: req.headers.authorization, body, bodyText };
    requests.push(entry);
    let payload = null;
    let status = 200;
    const base = `/backend-api/accounts/${workspaceId}`;
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions'
      && url.searchParams.get('account_id') === workspaceId) {
      payload = {
        seats_in_use: members.length,
        seats_entitled: paidDefault + paidProlite,
        seat_capacity: [
          { type: 'default', paid: paidDefault, held: 0 },
          { type: 'prolite', paid: paidProlite, held: heldProlite },
        ],
        assigned: {
          default: members.filter((member) => member.seat_type === 'default').length,
          prolite: members.filter((member) => member.seat_type === 'prolite').length,
        },
      };
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      payload = { rate_limit: { limit_reached: false, primary_window: { used_percent: 0 }, secondary_window: { used_percent: 0 } } };
    } else if (req.method === 'GET' && url.pathname === `${base}/users`) {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const matching = query ? members.filter((member) => member.email.toLowerCase().includes(query)) : members;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 100;
      payload = { items: matching.slice(offset, offset + limit), total: matching.length, offset, limit };
    } else if (req.method === 'GET' && url.pathname === `${base}/invites`) {
      payload = { items: pendingInvites, total: pendingInvites.length };
    } else if (req.method === 'POST' && url.pathname === `${base}/invites`) {
      const email = body?.email_addresses?.[0];
      const invite = { email_address: email, id: `invitation-${pendingInvites.length + 1}` };
      pendingInvites.push(invite);
      payload = { account_invites: [invite] };
    } else if (req.method === 'POST' && url.pathname === `${base}/invites/accept`) {
      status = acceptStatus;
      payload = acceptStatus === 200 ? acceptPayload : { error: 'mock_accept_failed' };
      if (acceptStatus === 200 && acceptPayload.success !== false && confirmMember) {
        const email = emailForAuthorization(req.headers.authorization);
        if (email && !members.some((member) => member.email.toLowerCase() === email)) {
          members.push({ id: `member-${email}`, email, role: 'standard-user', seat_type: assignedSeatType() });
        }
      }
    } else if (req.method === 'POST' && url.pathname === `${base}/invites/request`) {
      const email = emailForAuthorization(req.headers.authorization);
      const requestId = `request-${pendingRequests.size + 1}`;
      pendingRequests.set(requestId, email);
      payload = { id: requestId };
    } else if (req.method === 'POST' && url.pathname === `${base}/settings/default_seat_type`) {
      status = defaultSeatStatus;
      payload = defaultSeatStatus >= 200 && defaultSeatStatus < 300
        ? defaultSeatPayload
        : { error: 'mock_default_seat_failed' };
      if (status >= 200 && status < 300 && ['default', 'prolite'].includes(body?.value)) {
        remoteDefaultSeatType = body.value;
      }
    } else if (req.method === 'PATCH' && url.pathname.startsWith(`${base}/invites/`)) {
      if (body?.accept_request === true && confirmMember) {
        const inviteId = decodeURIComponent(url.pathname.slice(`${base}/invites/`.length));
        const email = pendingRequests.get(inviteId);
        if (email && !members.some((member) => member.email.toLowerCase() === email)) {
          members.push({ id: `member-${email}`, email, role: body.role || 'standard-user', seat_type: assignedSeatType() });
        }
      }
      payload = { success: true };
    } else if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      payload = { accessToken: token(workspaceId) };
    } else {
      unexpected.push(`${req.method} ${url.pathname}${url.search}`);
      status = 503;
      payload = { message: 'unexpected_remote_request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const testRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(testRoot, 'invite-join-mode-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    if (sub2api) {
      sub2api.closeAllConnections?.();
      await new Promise((resolve) => sub2api.close(resolve));
    }
    assert.equal(path.dirname(path.resolve(dataDir)), testRoot);
    assert.match(path.basename(dataDir), /^invite-join-mode-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: {
      autoRefill: false, promoteJoinedAccounts: false, concurrency: 3, joinMode,
      ...(pushConfigured ? { integrations: { sub2apis: [{ id: 'test-sub2api', name: 'Mock Sub2API', enabled: true, baseUrl: `http://127.0.0.1:${sub2apiPort}`, apiKey: 'test-key', groupId: 11 }] } } : {}),
    },
    mothers: [{
      id: motherId, team: workspaceId, accountId: workspaceId, teamName: 'Invitation Fixture',
      email: ownerEmail, primaryOwnerEmail: ownerEmail, accessToken: ownerToken,
      ...(pushConfigured ? { sub2apiIntegrationId: 'test-sub2api' } : {}),
      defaultSeatType, members: [],
    }],
    children: childEmails.map((email, index) => ({
      id: `child-${index}`, email, status: 'ready', accessToken: freeTokens.get(email.toLowerCase()), workspaceHistory: [],
    })),
    history: [],
  }));
  const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: new URL(baseUrl).port,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'invite-join-mode-test-only-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
      DISABLE_MAINTENANCE: 'true', OPENAI_CALLBACK_ENABLED: 'false', OPENAI_REQUEST_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForApp(baseUrl, app, () => output);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'daixuteam' }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie || '', /^team_rotation_session=/);
  const apiFetch = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    ...options, headers: { ...options.headers, cookie },
  });
  return {
    requests, pushRequests, unexpected, freeTokens, members, ownerToken,
    async refill() {
      const response = await apiFetch('/api/maintenance/refill', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motherId }), signal: AbortSignal.timeout(7000),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    },
    async check() {
      const response = await apiFetch('/api/maintenance/check', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motherId }), signal: AbortSignal.timeout(7000),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    },
    async publicState() {
      const response = await apiFetch('/api/state');
      assert.equal(response.status, 200);
      return response.json();
    },
    async manualJoin(childId, options = {}) {
      const response = await apiFetch(`/api/children/${childId}/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motherId, workspaceId, ...options }), signal: AbortSignal.timeout(7000),
      });
      return { status: response.status, result: await response.json() };
    },
    async setJoinMode(mode) {
      const response = await apiFetch('/api/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinMode: mode }), signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async updateTeam(body) {
      const response = await apiFetch(`/api/mothers/${motherId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, result: await response.json() };
    },
  };
}

test('request mode keeps the same-domain Free candidate and skips a different domain', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { joinMode: 'request', childEmails: ['cross@icloud.com', 'same-local-different@gmail.com'] });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 1, JSON.stringify(result));
  const requests = f.requests.filter((item) => item.path.endsWith('/invites/request'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${f.freeTokens.get('same-local-different@gmail.com')}`);
  assert.equal(f.requests.some((item) => item.method === 'POST' && item.path.endsWith('/invites')), false);
  assert.deepEqual(f.unexpected, []);
});

test('request mode fills one ordinary and one premium remainder without changing seats per request', { timeout: 20_000 }, async (t) => {
  const childEmails = ['first@gmail.com', 'second@gmail.com'];
  const f = await fixture(t, {
    joinMode: 'request', childEmails, defaultSeatType: 'default', paidDefault: 2, paidProlite: 1,
  });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 2, JSON.stringify(result));
  assert.equal(result.joined.length, 2, JSON.stringify(result));

  const joinRequests = f.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/invites/request'));
  const approvals = f.requests.filter((item) => item.method === 'PATCH' && item.body?.accept_request === true);
  assert.equal(joinRequests.length, 2);
  assert.equal(approvals.length, 2);
  assert.deepEqual(approvals.map((item) => item.body), [
    { role: 'standard-user', accept_request: true },
    { role: 'standard-user', accept_request: true },
  ]);
  assert.equal(f.requests.some((item) => item.path.endsWith('/settings/default_seat_type')), false,
    'refill must not temporarily change the Team default seat type');
  assert.equal(f.requests.some((item) => item.method === 'PATCH' && item.body?.seat_type), false,
    'refill must not assign a seat type on an individual request');

  const joinedMembers = f.members.filter((member) => childEmails.includes(member.email));
  assert.deepEqual(joinedMembers.map((member) => member.seat_type).sort(), ['default', 'prolite']);
  const state = await f.publicState();
  const recordedSeatTypes = state.children
    .filter((child) => childEmails.includes(child.email))
    .map((child) => child.joinedTeams.find((team) => team.team === workspaceId)?.seatType)
    .sort();
  assert.deepEqual(recordedSeatTypes, ['default', 'prolite']);
  assert.deepEqual(f.unexpected, []);
});

test('a premium Team default prefers premium first and then falls back to ordinary capacity', { timeout: 20_000 }, async (t) => {
  const childEmails = ['premium-first@gmail.com', 'ordinary-fallback@gmail.com'];
  const f = await fixture(t, {
    joinMode: 'request', childEmails, defaultSeatType: 'prolite', paidDefault: 2, paidProlite: 1,
  });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 2, JSON.stringify(result));
  assert.deepEqual(f.members.filter((member) => childEmails.includes(member.email)).map((member) => member.seat_type).sort(), ['default', 'prolite']);
  assert.equal(f.requests.some((item) => item.path.endsWith('/settings/default_seat_type')), false);
  assert.equal(f.requests.some((item) => item.method === 'PATCH' && item.body?.seat_type), false);
  assert.deepEqual(f.unexpected, []);
});

test('request mode fails closed when the owner email has no valid domain', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { joinMode: 'request', ownerEmail: 'not-an-email', childEmails: ['child@gmail.com'] });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 0);
  assert.deepEqual(result.joined, []);
  assert.equal(f.requests.some((item) => item.path.includes('/invites')), false);
  assert.deepEqual(f.unexpected, []);
});

test('manual request join rejects a cross-domain address before sending a request', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { joinMode: 'request', childEmails: ['cross@icloud.com'] });
  const { status, result } = await f.manualJoin('child-0');
  assert.equal(status, 409, JSON.stringify(result));
  assert.equal(result.ok, false);
  assert.equal(f.requests.some((item) => item.path.includes('/invites')), false);
  assert.deepEqual(f.unexpected, []);
});

test('settings can switch the manual join path between invitation and domain-limited request', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { joinMode: 'request', childEmails: ['cross@icloud.com'] });
  const inviteSetting = await f.setJoinMode('invite');
  assert.equal(inviteSetting.settings.joinMode, 'invite');
  const invited = await f.manualJoin('child-0', { approve: false });
  assert.equal(invited.status, 202, JSON.stringify(invited.result));
  assert.equal(invited.result.phase, 'invited');
  const requestSetting = await f.setJoinMode('request');
  assert.equal(requestSetting.settings.joinMode, 'request');
  assert.equal((await f.publicState()).settings.joinMode, 'request');
  const rejected = await f.manualJoin('child-0');
  assert.equal(rejected.status, 409, JSON.stringify(rejected.result));
  assert.equal(f.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/invites')).length, 1);
  assert.equal(f.requests.some((item) => item.path.endsWith('/invites/request')), false);
  assert.equal(f.requests.some((item) => item.path.endsWith('/invites/accept')), false);
  assert.deepEqual(f.unexpected, []);
});

test('invite mode creates a cross-domain invitation and accepts with the Free AT before Team JSON', { timeout: 20_000 }, async (t) => {
  const email = 'cross@icloud.com';
  const f = await fixture(t, { childEmails: [email, 'extra@different.test'], pushConfigured: true });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 1, JSON.stringify(result));
  assert.equal(result.joined.length, 1, JSON.stringify(result));
  const invited = f.requests.find((item) => item.method === 'POST' && item.path.endsWith('/invites'));
  assert.deepEqual(invited.body, { email_addresses: [email], role: 'standard-user', resend_emails: false });
  assert.equal(invited.authorization, `Bearer ${f.ownerToken}`);
  const accepted = f.requests.find((item) => item.method === 'POST' && item.path.endsWith('/invites/accept'));
  assert.ok(accepted);
  assert.equal(accepted.authorization, `Bearer ${f.freeTokens.get(email)}`);
  assert.equal(accepted.bodyText, '');
  assert.equal(f.requests.some((item) => item.method === 'PATCH'), false, 'default seats skip the seat assignment PATCH');
  const exchange = f.requests.find((item) => item.path === '/api/auth/session');
  assert.ok(exchange, 'confirmed membership proceeds to Team JSON exchange');
  assert.ok(f.requests.indexOf(exchange) > f.requests.indexOf(accepted));
  assert.equal(f.requests.filter((item) => item.path.endsWith('/invites/accept')).length, 1, 'one open seat cannot admit the extra candidate');
  assert.equal(result.sub2apiPush?.pushed, 1, JSON.stringify(result.sub2apiPush));
  const created = f.pushRequests.filter((item) => item.method === 'POST' && item.path === '/api/v1/admin/accounts');
  assert.equal(created.length, 1);
  assert.equal(created[0].body.credentials.chatgpt_account_id, workspaceId);
  assert.deepEqual(created[0].body.group_ids, [11]);
  const state = await f.publicState();
  assert.equal(state.settings.joinMode, 'invite');
  assert.equal(state.children.find((child) => child.email === email)?.joinedTeams.some((team) => team.team === workspaceId), true);
  assert.deepEqual(f.unexpected, []);
});

test('invite mode reuses an exact email invitation and relies on the Team premium default', { timeout: 20_000 }, async (t) => {
  const email = 'premium@other.test';
  const f = await fixture(t, {
    childEmails: [email], defaultSeatType: 'prolite', paidDefault: 1, paidProlite: 1,
    invitationRows: [
      { id: 'wrong-invite', email_address: 'unrelated@other.test' },
      { id: 'existing-invite', email_address: email.toUpperCase() },
    ],
  });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 1, JSON.stringify(result));
  assert.equal(f.requests.some((item) => item.method === 'POST' && item.path.endsWith('/invites')), false);
  const accepted = f.requests.find((item) => item.method === 'POST' && item.path.endsWith('/invites/accept'));
  assert.ok(accepted);
  assert.equal(f.requests.some((item) => item.method === 'PATCH' && item.path.includes('/invites/')), false);
  assert.equal(f.requests.some((item) => item.path.endsWith('/settings/default_seat_type')), false);
  assert.equal(f.members.find((member) => member.email === email)?.seat_type, 'prolite');
  assert.deepEqual(f.unexpected, []);
});

test('Team management saves a changed remote default seat type exactly once', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, {
    defaultSeatType: 'default', paidDefault: 1, paidProlite: 1,
  });
  const saved = await f.updateTeam({ defaultSeatType: 'prolite' });
  assert.equal(saved.status, 200, JSON.stringify(saved.result));
  const settings = f.requests.filter((item) => item.method === 'POST'
    && item.path === `/backend-api/accounts/${workspaceId}/settings/default_seat_type`);
  assert.equal(settings.length, 1);
  assert.deepEqual(settings[0].body, { value: 'prolite' });
  assert.equal(settings[0].authorization, `Bearer ${f.ownerToken}`);
  const state = await f.publicState();
  assert.equal(state.mothers[0].defaultSeatType, 'prolite');
  assert.deepEqual(f.unexpected, []);
});

test('Team management keeps the local default when the remote setting fails', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { defaultSeatType: 'default', defaultSeatStatus: 422 });
  const saved = await f.updateTeam({ defaultSeatType: 'prolite', teamName: 'Must Not Persist' });
  assert.equal(saved.status, 422, JSON.stringify(saved.result));
  const settings = f.requests.filter((item) => item.method === 'POST'
    && item.path === `/backend-api/accounts/${workspaceId}/settings/default_seat_type`);
  assert.equal(settings.length, 1);
  assert.deepEqual(settings[0].body, { value: 'prolite' });
  assert.equal(f.requests.some((item) => item.body?.accept_request === true), false);
  const state = await f.publicState();
  assert.equal(state.mothers[0].defaultSeatType, 'default');
  assert.equal(state.mothers[0].teamName, 'Invitation Fixture');
  assert.deepEqual(f.unexpected, []);
});

test('held seats block invitations before any join side effect', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { seatType: 'prolite', paidDefault: 1, paidProlite: 1, heldProlite: 1 });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 0);
  assert.equal(result.seatsOpen, 0);
  assert.equal(f.requests.some((item) => item.path.includes('/invites')), false);
  assert.deepEqual(f.unexpected, []);
});

test('the total seat limit blocks invitations even when a seat type appears available', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, {
    paidDefault: 1, paidProlite: 1,
    initialMembers: [{ id: 'other-member', email: 'other@gmail.com', role: 'standard-user', seat_type: 'default' }],
  });
  const result = await f.refill();
  assert.equal(result.acceptedSeats, 0);
  assert.equal(result.seatsOpen, 0);
  assert.equal(f.requests.some((item) => item.path.includes('/invites')), false);
  assert.deepEqual(f.unexpected, []);
});

test('invitation-only action leaves the Free account outside the Team and reserves no seat', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { childEmails: ['cross@icloud.com'] });
  const { status, result } = await f.manualJoin('child-0', { approve: false });
  assert.equal(status, 202, JSON.stringify(result));
  assert.equal(result.phase, 'invited');
  assert.equal(f.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/invites')).length, 1);
  assert.equal(f.requests.some((item) => item.path.endsWith('/invites/accept')), false);
  assert.equal(f.requests.some((item) => item.path === '/api/auth/session'), false);
  const state = await f.publicState();
  assert.equal(state.mothers[0].seatClaimsCount, 0);
  assert.equal(state.children[0].joinedTeams.some((team) => team.team === workspaceId && team.status === 'active'), false);
  assert.deepEqual(f.unexpected, []);
});

test('failed invitation acceptance does not start Team JSON or Sub2API push', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { acceptStatus: 403, pushConfigured: true });
  const result = await f.refill();
  assert.equal(result.joined.length, 0);
  assert.equal(result.acceptedSeats, 0);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/invites/accept')).length, 1);
  assert.equal(f.requests.some((item) => item.path === '/api/auth/session'), false);
  assert.equal(f.pushRequests.length, 0);
  assert.deepEqual(f.unexpected, []);
});

test('HTTP 200 acceptance with success:false is not treated as a joined member', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { acceptPayload: { success: false }, pushConfigured: true });
  const result = await f.refill();
  assert.equal(result.joined.length, 0);
  assert.equal(result.acceptedSeats, 0);
  assert.equal(f.requests.some((item) => item.path === '/api/auth/session'), false);
  assert.equal(f.pushRequests.length, 0);
  assert.deepEqual(f.unexpected, []);
});

test('unconfirmed acceptance retains the seat claim and never starts Team JSON or duplicate push', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { confirmMember: false, pushConfigured: true });
  const first = await f.refill();
  assert.equal(first.joined.length, 0);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/invites/accept')).length, 1);
  assert.equal(f.requests.some((item) => item.path === '/api/auth/session'), false);
  assert.equal(f.pushRequests.length, 0);
  const state = await f.publicState();
  assert.equal(state.mothers[0].seatClaimsCount, 1);
  await f.refill();
  assert.equal(f.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/invites')).length, 1);
  assert.equal(f.requests.filter((item) => item.path.endsWith('/invites/accept')).length, 1);
  assert.equal(f.requests.some((item) => item.path === '/api/auth/session'), false);
  assert.equal(f.pushRequests.length, 0);
  assert.deepEqual(f.unexpected, []);
});
