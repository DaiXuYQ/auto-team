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

function token(email, accountId, planType) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
      chatgpt_user_id: 'user-quick-json-test',
    },
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
      // Wait for the isolated server to listen.
    }
    await delay(50);
  }
  throw new Error(`test server did not start: ${output()}`);
}

function mockSub2Api({ existing = [] } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
    }
    requests.push({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, body });
    let status = 200;
    let data = {};
    if (req.method === 'GET' && url.pathname === '/api/v1/admin/accounts') {
      // A search may filter account name instead of email. The paginated scan
      // must still find an existing email + workspace identity.
      const isPageScan = url.searchParams.get('platform') === 'openai';
      data = { items: isPageScan ? existing : [] };
    } else if (req.method === 'POST' && url.pathname === '/api/v1/admin/accounts') {
      data = { id: 'new-account' };
    } else if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/admin/accounts/')) {
      data = { id: decodeURIComponent(url.pathname.split('/').at(-1)) };
    } else {
      status = 503;
      data = { message: 'unexpected_mock_request' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  return { server, requests };
}

async function post(baseUrl, pathName, body, cookie) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}

test('quick JSON selects one exact Free identity and one explicit Team without implicit Sub2API writes', { timeout: 20_000 }, async (t) => {
  const email = 'person@example.test';
  const teamA = 'workspace-quick-alpha';
  const teamB = 'workspace-quick-beta';
  const freeToken = token(email, 'free-quick-account', 'free');
  const teamAToken = token(email, teamA, 'team');
  const teamBToken = token(email, teamB, 'team');
  const first = mockSub2Api();
  const second = mockSub2Api({ existing: [
    { id: 'existing-team-beta', email, name: 'Another workspace', credentials: { chatgpt_account_id: teamB } },
    { id: 'existing-team-alpha', email, name: 'Display name not matching search', credentials: { chatgpt_account_id: teamA } },
  ] });
  const firstPort = await listen(first.server);
  const secondPort = await listen(second.server);
  const testRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(testRoot, 'quick-json-integration-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    for (const mock of [first, second]) {
      mock.server.closeAllConnections?.();
      await new Promise((resolve) => mock.server.close(resolve));
    }
    assert.equal(path.dirname(path.resolve(dataDir)), testRoot);
    assert.match(path.basename(dataDir), /^quick-json-integration-/);
    await rm(dataDir, { recursive: true, force: true });
  });

  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    settings: {
      autoRefill: false,
      integrations: {
        sub2apis: [
          { id: 'first', name: 'First target', baseUrl: `http://127.0.0.1:${firstPort}`, apiKey: 'first-test-key', groupId: 11, enabled: true },
          { id: 'second', name: 'Second target', baseUrl: `http://127.0.0.1:${secondPort}`, apiKey: 'second-test-key', groupId: 22, enabled: true },
        ],
      },
    },
    mothers: [
      { id: 'mother-alpha', team: teamA, accountId: teamA, teamName: 'Alpha', email: 'owner-a@example.test', sub2apiIntegrationId: 'first' },
      { id: 'mother-beta', team: teamB, accountId: teamB, teamName: 'Beta', email: 'owner-b@example.test', sub2apiIntegrationId: 'first' },
    ],
    children: [
      {
        id: 'target-account', email: 'Person@Example.Test', password: 'not-for-response', totp: 'NOT_FOR_RESPONSE',
        accessToken: freeToken, refreshToken: 'free-refresh-token', accountId: 'free-quick-account', plan: 'free', status: 'active', team: teamA,
        extra: { codex_5h_used_percent: 88 },
        workspaceTokens: {
          [teamA]: { accessToken: teamAToken, refreshToken: 'team-alpha-refresh' },
          [teamB]: { accessToken: teamBToken, refreshToken: 'team-beta-refresh' },
        },
        workspaceHistory: [{ team: teamA, status: 'active' }, { team: teamB, status: 'active' }],
      },
      { id: 'similar-account', email: 'p.person@example.test', accessToken: token('p.person@example.test', 'another-free-account', 'free'), plan: 'free', status: 'ready' },
    ],
    history: [],
  }));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TEAM_ROTATION_DATA_DIR: dataDir,
      TEAM_ROTATION_DATA_KEY: 'quick-json-test-only-key',
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
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'daixuteam' }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(loginResponse.status, 200, await loginResponse.text());
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'login must set a session cookie');
  const authenticatedPost = (route, body) => post(baseUrl, route, body, cookie);

  const missing = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'free', email: 'not-person@example.test' });
  assert.ok(missing.status >= 400, JSON.stringify(missing.data));
  const incomplete = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'free', email: 'p.person@example.test' });
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.data.code, 'refresh_token_required');
  assert.equal(incomplete.data.account, undefined);
  const free = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'free', email: ' PERSON@example.test ' });
  assert.equal(free.status, 200, JSON.stringify(free.data));
  assert.equal(free.data.ok, true);
  assert.ok(free.data.ticket, 'acquire must issue a short-lived ticket for the exact account JSON');
  assert.equal(free.data.accounts.length, 1);
  assert.equal(free.data.account.credentials.access_token, freeToken);
  assert.equal(free.data.account.credentials.chatgpt_account_id, 'free-quick-account');
  assert.equal(free.data.account.credentials.plan_type, 'free');
  assert.equal(free.data.account.concurrency, 10);
  assert.equal(free.data.account.priority, 1);
  assert.equal(JSON.stringify(free.data).includes('not-for-response'), false);
  assert.equal(JSON.stringify(free.data).includes('NOT_FOR_RESPONSE'), false);

  const noTeam = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'team', email });
  assert.ok(noTeam.status >= 400, JSON.stringify(noTeam.data));
  const alpha = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'team', email, motherId: 'mother-alpha' });
  const beta = await authenticatedPost('/api/tools/quick-json/acquire', { scope: 'team', email, motherId: 'mother-beta' });
  for (const result of [alpha, beta]) {
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.ok, true);
    assert.ok(result.data.ticket);
    assert.equal(result.data.accounts.length, 1);
    assert.equal(result.data.account.credentials.plan_type, 'team');
  }
  assert.equal(alpha.data.account.credentials.access_token, teamAToken);
  assert.equal(alpha.data.account.credentials.chatgpt_account_id, teamA);
  assert.equal(beta.data.account.credentials.access_token, teamBToken);
  assert.equal(beta.data.account.credentials.chatgpt_account_id, teamB);
  assert.equal(alpha.data.account.extra.codex_5h_used_percent, undefined, 'Free usage must not leak into Team JSON');
  assert.equal(first.requests.filter((request) => ['POST', 'PUT'].includes(request.method)).length, 0);
  assert.equal(second.requests.filter((request) => ['POST', 'PUT'].includes(request.method)).length, 0);

  const wrongTeam = await authenticatedPost('/api/tools/quick-json/push', {
    scope: 'team', email, motherId: 'mother-beta', ticket: alpha.data.ticket, sub2apiIntegrationId: 'second',
  });
  assert.ok(wrongTeam.status >= 400, JSON.stringify(wrongTeam.data));
  assert.equal(second.requests.filter((request) => ['POST', 'PUT'].includes(request.method)).length, 0);

  const syncedTeam = await authenticatedPost('/api/tools/quick-json/push', {
    scope: 'team', email, motherId: 'mother-alpha', ticket: alpha.data.ticket, account: beta.data.account, sub2apiIntegrationId: 'second',
  });
  assert.equal(syncedTeam.status, 200, JSON.stringify(syncedTeam.data));
  assert.equal(syncedTeam.data.ok, true);
  const secondWrites = second.requests.filter((request) => ['POST', 'PUT'].includes(request.method));
  assert.equal(secondWrites.length, 1);
  assert.equal(secondWrites[0].method, 'PUT');
  assert.equal(secondWrites[0].pathname, '/api/v1/admin/accounts/existing-team-alpha');
  assert.deepEqual(secondWrites[0].body.group_ids, [22]);
  assert.equal(secondWrites[0].body.credentials.chatgpt_account_id, teamA);
  assert.equal(secondWrites[0].body.credentials.access_token, teamAToken, 'push must use the acquired ticket, not the supplied account JSON');
  assert.equal(first.requests.filter((request) => ['POST', 'PUT'].includes(request.method)).length, 0);

  const syncedFree = await authenticatedPost('/api/tools/quick-json/push', {
    scope: 'free', email, ticket: free.data.ticket, account: free.data.account, sub2apiIntegrationId: 'first',
  });
  assert.equal(syncedFree.status, 200, JSON.stringify(syncedFree.data));
  assert.equal(syncedFree.data.ok, true);
  const firstWrites = first.requests.filter((request) => ['POST', 'PUT'].includes(request.method));
  assert.equal(firstWrites.length, 1);
  assert.equal(firstWrites[0].method, 'POST');
  assert.equal(firstWrites[0].pathname, '/api/v1/admin/accounts');
  assert.deepEqual(firstWrites[0].body.group_ids, [11]);
  assert.equal(firstWrites[0].body.credentials.chatgpt_account_id, 'free-quick-account');
  assert.equal(firstWrites[0].body.credentials.access_token, freeToken);

  const stateResponse = await fetch(`${baseUrl}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  const publicState = await stateResponse.json();
  assert.equal(publicState.children.length, 2, 'quick acquisition must not add temporary accounts to the Free pool');
});
