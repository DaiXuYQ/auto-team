import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChallenge, loginFreeAccount } from './openai-login.mjs';

test('classifies explicit account suspension before generic HTTP 403 verification', () => {
  assert.equal(classifyChallenge('', '{"error":{"code":"account_deactivated","message":"Your account has been deactivated"}}', 403), 'account_banned');
  assert.equal(classifyChallenge('', '{"detail":"account suspended"}', 400), 'account_banned');
  assert.equal(classifyChallenge('', '{"error":"turnstile_required"}', 403), 'protocol_verification_required');
});

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

test('stale persisted login session is discarded and retried from a fresh OAuth authorization', async () => {
  let passwordAttempts = 0;
  let authorizationAttempts = 0;
  let exchanged = false;
  const requestFetch = async (input) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/api/accounts/password/verify') {
      passwordAttempts += 1;
      return jsonResponse({ error: { code: 'signin_session_invalid', message: 'Your sign-in session is no longer valid. Please start over to continue.' } }, 400);
    }
    if (url.startsWith('https://auth.openai.com/oauth/authorize?')) {
      authorizationAttempts += 1;
      const state = new URL(url).searchParams.get('state');
      return new Response('', { status: 302, headers: { location: `http://localhost:1455/auth/callback?code=fresh-code&state=${state}` } });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      exchanged = true;
      return jsonResponse({ access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token', id_token: 'fresh-id-token' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    totp: 'JBSWY3DPEHPK3PXP',
    fetch: requestFetch,
    sentinelTokenProvider: async () => 'sentinel-token',
    session: { currentUrl: 'https://auth.openai.com/log-in/password' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionRecovered, true);
  assert.equal(passwordAttempts, 1);
  assert.equal(authorizationAttempts, 1);
  assert.equal(exchanged, true);
  assert.equal(result.accessToken, 'fresh-access-token');
});

test('Sub2API OAuth URL failure falls back to the local PKCE authorization flow', async () => {
  let providerCalls = 0;
  let localAuthorizationCalls = 0;
  let tokenExchangeCalls = 0;
  let callbackHandlerCalls = 0;
  let localOAuthState = '';
  const selected = [];
  const teamAccessToken = `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'team-account',
      chatgpt_plan_type: 'team',
    },
  })).toString('base64url')}.signature`;
  const requestFetch = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith('https://auth.openai.com/oauth/authorize?')) {
      localAuthorizationCalls += 1;
      const authorization = new URL(url);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(authorization.searchParams.get('code_challenge'));
      localOAuthState = authorization.searchParams.get('state');
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
      return jsonResponse({ continue_url: `http://localhost:1455/auth/callback?code=local-code&state=${localOAuthState}` });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      tokenExchangeCalls += 1;
      return jsonResponse({
        access_token: teamAccessToken,
        refresh_token: 'local-refresh-token',
        id_token: 'local-id-token',
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await loginFreeAccount({
    email: 'member@example.com',
    password: 'password',
    totp: 'JBSWY3DPEHPK3PXP',
    workspaceMode: 'team',
    workspaceId: 'team-account',
    fetch: requestFetch,
    authorizationProvider: async () => {
      providerCalls += 1;
      const error = new Error('Invalid admin API key');
      error.code = 'sub2api_oauth_url_failed';
      error.status = 401;
      throw error;
    },
    callbackHandler: async () => {
      callbackHandlerCalls += 1;
      throw new Error('Sub2API callback must not run after local OAuth fallback');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.accessToken, teamAccessToken);
  assert.equal(result.refreshToken, 'local-refresh-token');
  assert.equal(result.claims.accountId, 'team-account');
  assert.equal(result.oauthFallback?.code, 'sub2api_oauth_url_failed');
  assert.equal(result.oauthFallback?.message, 'Invalid admin API key');
  assert.equal(providerCalls, 1);
  assert.equal(localAuthorizationCalls, 1);
  assert.equal(tokenExchangeCalls, 1);
  assert.equal(callbackHandlerCalls, 0);
  assert.deepEqual(selected, [{ workspace_id: 'team-account' }]);
  assert.equal(result.session.authorization, null);
});
