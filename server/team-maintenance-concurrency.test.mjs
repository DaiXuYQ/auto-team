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

function token(accountId) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'team' },
  })).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function freeToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'free' },
  })).toString('base64url');
  return `${header}.${payload}.test-signature`;
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

async function waitForApp(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited early: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The child may still be starting.
    }
    await delay(50);
  }
  throw new Error(`test server did not start: ${output()}`);
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'daixuteam' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'login must set a session cookie');
  return cookie;
}

async function post(baseUrl, route, body, cookie) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

test('one Team can check, refill, and push while another Team is busy; same-Team checks serialize', { timeout: 20_000 }, async (t) => {
  const teams = [
    { id: 'mother-a', accountId: 'workspace-a', email: 'owner-a@example.test' },
    { id: 'mother-b', accountId: 'workspace-b', email: 'owner-b@example.test' },
  ];
  let releaseFirstA;
  const firstAReleased = new Promise((resolve) => { releaseFirstA = resolve; });
  let notifyFirstA;
  const firstAStarted = new Promise((resolve) => { notifyFirstA = resolve; });
  let aSubscriptionRequests = 0;
  let bSubscriptionRequests = 0;
  const remoteRequests = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    remoteRequests.push({ method: req.method, pathname: url.pathname });
    let payload;
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions') {
      const accountId = url.searchParams.get('account_id');
      if (accountId === teams[0].accountId) {
        aSubscriptionRequests += 1;
        if (aSubscriptionRequests === 1) {
          notifyFirstA();
          await firstAReleased;
        }
      } else if (accountId === teams[1].accountId) {
        bSubscriptionRequests += 1;
      }
      payload = {
        seats_in_use: 1,
        seats_entitled: 1,
        seat_capacity: [{ type: 'default', paid: 1, held: 0 }],
        assigned: { default: 1 },
      };
    } else if (req.method === 'GET' && url.pathname.endsWith('/users')) {
      const team = teams.find((item) => url.pathname === `/backend-api/accounts/${item.accountId}/users`);
      payload = team ? {
        items: [{ id: `user-${team.id}`, email: team.email, role: 'account-owner', seat_type: 'default' }],
        total: 1,
        limit: 25,
        offset: 0,
      } : null;
    } else if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
      payload = { rate_limit: { limit_reached: false, primary_window: { used_percent: 0 }, secondary_window: { used_percent: 0 } } };
    }
    if (!payload) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unexpected_remote_request' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const testRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(testRoot, 'team-maintenance-concurrency-'));
  let app;
  t.after(async () => {
    releaseFirstA();
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), testRoot);
    assert.match(path.basename(dataDir), /^team-maintenance-concurrency-/);
    await rm(dataDir, { recursive: true, force: true });
  });

  const state = {
    version: 1,
    settings: { autoRefill: false, promoteJoinedAccounts: false, concurrency: 3 },
    mothers: teams.map((team) => ({
      id: team.id,
      team: team.accountId,
      accountId: team.accountId,
      teamName: team.id,
      email: team.email,
      primaryOwnerEmail: team.email,
      accessToken: token(team.accountId),
      members: [],
    })),
    children: [],
    history: [],
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: new URL(baseUrl).port,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'team-maintenance-concurrency-test-only-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
      DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: 'false',
      OPENAI_REQUEST_TIMEOUT_MS: '2500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForApp(baseUrl, app, () => output);
  const cookie = await login(baseUrl);
  const authenticatedPost = (route, body) => post(baseUrl, route, body, cookie);

  const firstACheck = authenticatedPost('/api/maintenance/check', { motherId: teams[0].id });
  let secondACheck;
  let aPush;
  let allChecks;
  try {
    await Promise.race([firstAStarted, delay(3000).then(() => { throw new Error('Team A check did not reach mock subscription'); })]);
    secondACheck = authenticatedPost('/api/maintenance/check', { motherId: teams[0].id });
    let aPushSettled = false;
    aPush = authenticatedPost('/api/sub2api/team-push', { motherId: teams[0].id })
      .finally(() => { aPushSettled = true; });
    const bCheck = await authenticatedPost('/api/maintenance/check', { motherId: teams[1].id });
    assert.equal(bCheck.ok, true, JSON.stringify(bCheck));
    assert.equal(bCheck.motherId, teams[1].id);

    const bRefill = await authenticatedPost('/api/maintenance/refill', { motherId: teams[1].id });
    assert.equal(bRefill.ok, true, JSON.stringify(bRefill));
    assert.equal(bRefill.seatsOpen, 0);
    assert.deepEqual(bRefill.joined, []);
    assert.deepEqual(bRefill.kicked, []);

    const bPush = await authenticatedPost('/api/sub2api/team-push', { motherId: teams[1].id });
    assert.equal(bPush.targets.length, 1);
    assert.equal(bPush.targets[0].ok, false, 'no Sub2API endpoint is configured in the isolated test');
    const previousBSubscriptions = bSubscriptionRequests;
    allChecks = authenticatedPost('/api/maintenance/check-all', {});
    for (let attempt = 0; attempt < 50 && bSubscriptionRequests === previousBSubscriptions; attempt += 1) await delay(20);
    assert.ok(bSubscriptionRequests > previousBSubscriptions, 'check-all must start Team B without waiting for Team A');
    await delay(50);
    assert.equal(aSubscriptionRequests, 1, 'second Team A check must wait for the first');
    assert.equal(aPushSettled, false, 'Team A push must wait for its active check');

    releaseFirstA();
    const [firstResult, secondResult, aPushResult, allResult] = await Promise.all([firstACheck, secondACheck, aPush, allChecks]);
    assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
    assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
    assert.equal(aPushResult.targets.length, 1);
    assert.equal(allResult.teamCount, 2);
    assert.equal(allResult.failed, 0, JSON.stringify(allResult));
    assert.equal(aSubscriptionRequests, 3);
    assert.deepEqual(remoteRequests.filter((request) => request.method !== 'GET'), []);
  } finally {
    releaseFirstA();
    await Promise.allSettled([firstACheck, secondACheck, aPush, allChecks].filter(Boolean));
  }
});

test('parallel Team refills do not apply the same Free candidate twice, and release it after failure', { timeout: 20_000 }, async (t) => {
  const teams = [
    { id: 'mother-c', accountId: 'workspace-c', email: 'owner-c@example.test' },
    { id: 'mother-d', accountId: 'workspace-d', email: 'owner-d@example.test' },
  ];
  const candidate = { id: 'one-free-candidate', email: 'candidate@example.test' };
  let releaseFirstInvite;
  const firstInviteReleased = new Promise((resolve) => { releaseFirstInvite = resolve; });
  let notifyFirstInvite;
  const firstInviteStarted = new Promise((resolve) => { notifyFirstInvite = resolve; });
  const inviteRequests = [];
  const unexpectedRequests = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const team = teams.find((item) => url.pathname.startsWith(`/backend-api/accounts/${item.accountId}/`));
    let payload;
    let status = 200;
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions'
      && teams.some((item) => item.accountId === url.searchParams.get('account_id'))) {
      payload = {
        seats_in_use: 1,
        seats_entitled: 2,
        seat_capacity: [{ type: 'default', paid: 2, held: 0 }],
        assigned: { default: 1 },
      };
    } else if (req.method === 'GET' && team && url.pathname === `/backend-api/accounts/${team.accountId}/users`) {
      payload = {
        items: [{ id: `user-${team.id}`, email: team.email, role: 'account-owner', seat_type: 'default' }],
        total: 1,
        limit: 25,
        offset: 0,
      };
    } else if (req.method === 'POST' && team && url.pathname === `/backend-api/accounts/${team.accountId}/invites/request`) {
      inviteRequests.push(team.id);
      if (inviteRequests.length === 1 && team.id === teams[0].id) {
        notifyFirstInvite();
        await firstInviteReleased;
      }
      status = 503;
      payload = { message: 'mock_join_request_failed' };
    } else {
      unexpectedRequests.push(`${req.method} ${url.pathname}`);
      status = 503;
      payload = { message: 'unexpected_remote_request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const testRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(testRoot, 'team-refill-candidate-concurrency-'));
  let app;
  t.after(async () => {
    releaseFirstInvite();
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), testRoot);
    assert.match(path.basename(dataDir), /^team-refill-candidate-concurrency-/);
    await rm(dataDir, { recursive: true, force: true });
  });

  const state = {
    version: 1,
    settings: { autoRefill: false, promoteJoinedAccounts: false, concurrency: 3 },
    mothers: teams.map((team) => ({
      id: team.id,
      team: team.accountId,
      accountId: team.accountId,
      teamName: team.id,
      email: team.email,
      primaryOwnerEmail: team.email,
      accessToken: token(team.accountId),
      members: [],
    })),
    children: [{ ...candidate, status: 'ready', accessToken: freeToken(), workspaceHistory: [] }],
    history: [],
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const baseUrl = `http://127.0.0.1:${await unusedPort()}`;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: new URL(baseUrl).port,
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'team-refill-candidate-concurrency-test-only-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
      DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: 'false',
      OPENAI_REQUEST_TIMEOUT_MS: '2500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForApp(baseUrl, app, () => output);
  const cookie = await login(baseUrl);
  const authenticatedPost = (route, body) => post(baseUrl, route, body, cookie);

  const firstRefill = authenticatedPost('/api/maintenance/refill', { motherId: teams[0].id });
  try {
    await Promise.race([firstInviteStarted, delay(3000).then(() => { throw new Error('Team A did not request the mock invite'); })]);
    const secondRefill = await authenticatedPost('/api/maintenance/refill', { motherId: teams[1].id });
    assert.equal(secondRefill.ok, true, JSON.stringify(secondRefill));
    assert.deepEqual(secondRefill.joined, []);
    assert.equal(secondRefill.seatsOpen, 1);
    assert.deepEqual(inviteRequests, [teams[0].id], 'the reserved Free candidate cannot be applied to Team B concurrently');

    releaseFirstInvite();
    const firstResult = await firstRefill;
    assert.equal(firstResult.ok, false, JSON.stringify(firstResult));
    assert.deepEqual(firstResult.joined, []);
    assert.equal(firstResult.joinFailures[0]?.phase, 'request');

    const retry = await authenticatedPost('/api/maintenance/refill', { motherId: teams[0].id });
    assert.equal(retry.joinFailures[0]?.phase, 'request');
    assert.deepEqual(inviteRequests, [teams[0].id, teams[0].id], 'candidate must be usable after failed join releases its reservation');
    assert.deepEqual(unexpectedRequests, []);
  } finally {
    releaseFirstInvite();
    await Promise.allSettled([firstRefill]);
  }
});
