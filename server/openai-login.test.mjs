import assert from 'node:assert/strict';
import test from 'node:test';
import { loginFreeAccount } from './openai-login.mjs';

function workspaceCookie(workspaces) {
  return `${Buffer.from(JSON.stringify({ workspaces })).toString('base64url')}.signature`;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

for (const scenario of [
  {
    name: 'Sub2API OAuth selects the personal workspace for Free JSON',
    workspaceMode: 'free',
    workspaceId: '',
    expectedWorkspaceId: 'personal-account',
  },
  {
    name: 'Sub2API OAuth selects the requested Team workspace for Team JSON',
    workspaceMode: 'team',
    workspaceId: 'team-account',
    expectedWorkspaceId: 'team-account',
  },
]) {
  test(scenario.name, async () => {
    const oauthState = 'state-from-sub2api';
    const callbackUrl = `http://localhost:1455/auth/callback?code=authorization-code&state=${oauthState}`;
    const authUrl = `https://auth.openai.com/oauth/authorize?state=${oauthState}&redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`;
    const selected = [];
    let providerCalls = 0;
    let callbackCalls = 0;

    const requestFetch = async (input, options = {}) => {
      const url = String(input);
      if (url === authUrl) {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://auth.openai.com/workspace',
            'set-cookie': `oai-client-auth-session=${workspaceCookie([
              { id: 'team-account', kind: 'team' },
              { id: 'personal-account', kind: 'personal' },
            ])}; Path=/; Secure; HttpOnly`,
          },
        });
      }
      if (url === 'https://auth.openai.com/workspace' || url === 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent') {
        return new Response('', { status: 200 });
      }
      if (url === 'https://auth.openai.com/api/accounts/workspace/select') {
        selected.push(JSON.parse(options.body));
        return jsonResponse({ continue_url: callbackUrl });
      }
      throw new Error(`unexpected request: ${options.method || 'GET'} ${url}`);
    };

    const result = await loginFreeAccount({
      email: 'member@example.com',
      password: 'password',
      totp: 'JBSWY3DPEHPK3PXP',
      workspaceMode: scenario.workspaceMode,
      workspaceId: scenario.workspaceId,
      fetch: requestFetch,
      authorizationProvider: async () => {
        providerCalls += 1;
        return {
          source: 'sub2api',
          providerId: 'sub2api-primary',
          authUrl,
          sessionId: 'sub2api-session',
          state: oauthState,
          redirectUri: 'http://localhost:1455/auth/callback',
        };
      },
      callbackHandler: async ({ code, state, authorization }) => {
        callbackCalls += 1;
        assert.equal(code, 'authorization-code');
        assert.equal(state, oauthState);
        assert.equal(authorization.sessionId, 'sub2api-session');
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: 'id-token',
          claims: { accountId: scenario.expectedWorkspaceId, planType: scenario.workspaceMode },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(providerCalls, 1);
    assert.equal(callbackCalls, 1);
    assert.deepEqual(selected, [{ workspace_id: scenario.expectedWorkspaceId }]);
    assert.equal(result.session.authorization.providerId, 'sub2api-primary');
  });
}

test('Sub2API callback completion reuses a persisted OAuth session', async () => {
  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    callbackUrl: 'http://localhost:1455/auth/callback?code=authorization-code&state=persisted-state',
    session: {
      state: 'persisted-state',
      currentUrl: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      authorization: {
        source: 'sub2api',
        providerId: 'sub2api-primary',
        authUrl: 'https://auth.openai.com/oauth/authorize?state=persisted-state',
        sessionId: 'persisted-session',
        state: 'persisted-state',
      },
    },
    callbackHandler: async ({ authorization }) => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      claims: { accountId: 'personal-account', planType: 'free' },
      sub2api: { synced: true, accountId: 42, integrationId: authorization.providerId },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.sub2api.accountId, 42);
  assert.equal(result.sub2api.integrationId, 'sub2api-primary');
});
