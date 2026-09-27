import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverScript = fileURLToPath(new URL('./index.mjs', import.meta.url));
const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForApp(baseUrl, app, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`test server exited early: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`test server did not start: ${output()}`);
}

function jsonPost(baseUrl, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test('dashboard login gates state and version through an isolated server session', { timeout: 20_000 }, async (t) => {
  const tempRoot = path.resolve(tmpdir());
  const dataDir = await mkdtemp(path.join(tempRoot, 'team-auth-integration-'));
  let app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = new Promise((resolve) => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(dataDir)), tempRoot);
    assert.match(path.basename(dataDir), /^team-auth-integration-/);
    await rm(dataDir, { recursive: true, force: true });
  });

  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    settings: { githubRepository: 'example/old-repo' },
  }));
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    TEAM_ROTATION_DATA_DIR: dataDir,
    TEAM_ROTATION_DATA_KEY: 'isolated-auth-test-key',
    TEAM_ROTATION_API_TOKEN: '',
    DISABLE_MAINTENANCE: 'true',
    OPENAI_CALLBACK_ENABLED: 'false',
  };
  delete env.TEAM_ROTATION_LOGIN_PASSWORD;
  let output = '';
  app = spawn(process.execPath, [serverScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  app.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForApp(baseUrl, app, () => output);

  const rebound = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/auth/session', headers: { host: 'attacker.example' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(rebound.status, 403);
  assert.equal(JSON.parse(rebound.body).code, 'host_not_allowed');

  const anonymous = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(5000) });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('content-type') || '', /application\/json/);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal(anonymous.headers.get('x-frame-options'), 'DENY');
  assert.equal(anonymous.headers.get('x-content-type-options'), 'nosniff');

  const wrong = await jsonPost(baseUrl, '/api/auth/login', { password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const stillAnonymous = await fetch(`${baseUrl}/api/auth/session`, { signal: AbortSignal.timeout(5000) });
  assert.equal(stillAnonymous.status, 200);
  assert.equal((await stillAnonymous.json()).authenticated, false);

  const login = await jsonPost(baseUrl, '/api/auth/login', { password: 'daixuteam' });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^team_rotation_session=[A-Za-z0-9_-]{43};/);
  for (const attribute of ['Max-Age=604800', 'Path=/api', 'HttpOnly', 'SameSite=Lax']) {
    assert.ok(setCookie.includes(attribute), `missing cookie attribute: ${attribute}`);
  }
  assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
  const cookie = setCookie.split(';', 1)[0];

  const authorized = await fetch(`${baseUrl}/api/state?includeHistory=false`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(authorized.status, 200);
  const state = await authorized.json();
  assert.ok(Array.isArray(state.children));
  assert.ok(Array.isArray(state.mothers));
  assert.equal(Object.hasOwn(state.settings, 'githubRepository'), false);

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).authenticated, true);

  const expectedVersion = JSON.parse(await readFile(packageFile, 'utf8')).version;
  const version = await fetch(`${baseUrl}/api/version`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(version.status, 200);
  assert.deepEqual(await version.json(), { currentVersion: expectedVersion });

  const legacySettings = await fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ githubRepository: 'example/repo' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(legacySettings.status, 200);
  assert.equal(Object.hasOwn((await legacySettings.json()).settings, 'githubRepository'), false);

  const forwardedLogin = await jsonPost(baseUrl, '/api/auth/login', { password: 'daixuteam' }, { 'x-forwarded-proto': 'https' });
  assert.equal(forwardedLogin.status, 200);
  assert.match(forwardedLogin.headers.get('set-cookie') || '', /; Secure(?:;|$)/);

  const logout = await jsonPost(baseUrl, '/api/auth/logout', {}, { cookie });
  assert.ok([200, 204].includes(logout.status));
  const cleared = logout.headers.get('set-cookie') || '';
  assert.match(cleared, /^team_rotation_session=; Max-Age=0;/);
  assert.match(cleared, /Path=\/api; HttpOnly; SameSite=Lax/);
  const afterLogout = await fetch(`${baseUrl}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(afterLogout.status, 401);
  const sessionAfterLogout = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal((await sessionAfterLogout.json()).authenticated, false);
});
