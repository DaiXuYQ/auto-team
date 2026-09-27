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

function token(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })).toString('base64url');
  return `${header}.${body}.test-signature`;
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

test('held seats remain unassigned and cannot trigger automatic refill', { timeout: 20_000 }, async (t) => {
  const accountId = 'workspace-held-test';
  const motherId = 'mother-held-test';
  const subscription = {
    seats_in_use: 52,
    seats_entitled: 62,
    seat_capacity: [
      { type: 'default', paid: 2, held: 0 },
      { type: 'prolite', paid: 60, held: 10 },
    ],
    assigned: { default: 2, prolite: 50 },
  };
  const members = Array.from({ length: 52 }, (_, index) => ({
    id: `member-${index}`,
    email: index === 0 ? 'owner@example.test' : `member-${index}@example.test`,
    role: index === 0 ? 'account-owner' : 'standard-user',
    seat_type: index < 2 ? 'default' : 'prolite',
  }));
  const remoteRequests = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    remoteRequests.push({ method: req.method, pathname: url.pathname });
    let payload;
    if (req.method === 'GET' && url.pathname === '/backend-api/subscriptions' && url.searchParams.get('account_id') === accountId) {
      payload = subscription;
    } else if (req.method === 'GET' && url.pathname === `/backend-api/accounts/${accountId}/users`) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 25;
      payload = { items: members.slice(offset, offset + limit), total: members.length, offset, limit };
    } else {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unexpected_remote_request' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstreamPort = await listen(upstream);
  const testRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(testRoot, 'held-seat-integration-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), testRoot);
    assert.match(path.basename(dataDir), /^held-seat-integration-/);
    await rm(dataDir, { recursive: true, force: true });
  });

  const state = {
    version: 1,
    settings: { autoRefill: false, promoteJoinedAccounts: false },
    mothers: [{
      id: motherId,
      team: accountId,
      accountId,
      teamName: 'Held Seats Team',
      email: members[0].email,
      primaryOwnerEmail: members[0].email,
      accessToken: token({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'team' } }),
      inviteSeatType: 'auto',
      members: [],
    }],
    children: [{
      id: 'available-free-account',
      email: 'candidate@example.test',
      status: 'ready',
      accessToken: token({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'free' } }),
      workspaceHistory: [],
    }],
    history: [],
  };
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'held-seat-test-only-key',
      TEAM_ROTATION_API_TOKEN: '',
      TEAM_ROTATION_LOGIN_PASSWORD: 'daixuteam',
      DISABLE_MAINTENANCE: 'true',
      OPENAI_CALLBACK_ENABLED: 'false',
      OPENAI_REQUEST_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForApp(baseUrl, app, () => output);
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'daixuteam' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(loginResponse.status, 200, await loginResponse.text());
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'login must set a session cookie');

  const refillResponse = await fetch(`${baseUrl}/api/maintenance/refill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ motherId }),
    signal: AbortSignal.timeout(5000),
  });
  const refill = await refillResponse.json();
  assert.equal(refillResponse.status, 200, JSON.stringify(refill));
  assert.equal(refill.ok, true, JSON.stringify(refill));
  assert.equal(refill.seatsInUse, 52);
  assert.equal(refill.seatsOpen, 0);
  assert.equal(refill.acceptedSeats, 0);
  assert.deepEqual(refill.joined, []);
  assert.deepEqual(refill.joinFailures, []);
  assert.deepEqual(remoteRequests.filter((request) => request.method !== 'GET'), [], 'held capacity must not start a join or removal request');

  const stateResponse = await fetch(`${baseUrl}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(stateResponse.status, 200);
  const publicState = await stateResponse.json();
  const team = publicState.teams.find((item) => item.id === motherId);
  assert.ok(team);
  assert.equal(team.seats.used, 52);
  assert.equal(team.seats.entitled, 62);
  assert.equal(team.seats.held, 10);
  assert.equal(team.seats.open, 0);
  assert.equal(team.currentAccounts.length, 52, 'held seats are not joined accounts');
  assert.equal(publicState.mothers[0].seatsInUse, 52);
  assert.equal(publicState.mothers[0].seatsHeld, 10);
  assert.equal(publicState.mothers[0].seatsOpen, 0);
  assert.equal(publicState.mothers[0].seatSnapshot.seatCapacity[1].held, 10);
});
