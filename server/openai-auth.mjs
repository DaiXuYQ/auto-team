const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_ENDPOINTS = [
  'https://auth.openai.com/api/oauth/oauth2/token',
  'https://auth.openai.com/oauth/token',
];

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

export function accessTokenClaims(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  const auth = claims['https://api.openai.com/auth'] || claims.auth || {};
  return {
    email: String(claims.email || claims['https://api.openai.com/email'] || ''),
    accountId: String(auth.chatgpt_account_id || claims.chatgpt_account_id || ''),
    userId: String(auth.chatgpt_user_id || claims.chatgpt_user_id || claims.sub || ''),
    planType: String(auth.chatgpt_plan_type || claims.chatgpt_plan_type || ''),
    expiresAt: Number.isFinite(Number(claims.exp)) ? new Date(Number(claims.exp) * 1000).toISOString() : null,
  };
}

export async function refreshOpenAiAccessToken(refreshToken, clientId = DEFAULT_CLIENT_ID, timeoutMs = 15000, requestFetch = fetch) {
  const token = String(refreshToken || '').trim();
  if (!token) return { ok: false, status: 400, message: 'refresh_token_required' };
  let last = { ok: false, status: 502, message: 'refresh_failed' };
  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: String(clientId || DEFAULT_CLIENT_ID),
      });
      const response = await requestFetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      const accessToken = String(payload.access_token || payload.accessToken || '').trim();
      if (response.ok && accessToken) {
        return {
          ok: true,
          status: response.status,
          accessToken,
          refreshToken: String(payload.refresh_token || payload.refreshToken || token),
          idToken: String(payload.id_token || payload.idToken || ''),
          expiresIn: Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : null,
          claims: accessTokenClaims(accessToken),
        };
      }
      const errorValue = payload.error_description || payload.error?.message || payload.error?.code || payload.error || payload.message;
      last = { ok: false, status: response.status, code: String(payload.error?.code || payload.code || ''), message: typeof errorValue === 'string' ? errorValue : errorValue ? JSON.stringify(errorValue) : `http_${response.status}` };
      if (response.status !== 404 && response.status !== 405) break;
    } catch (error) {
      last = { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
  }
  return last;
}

export const OPENAI_OAUTH_CLIENT_ID = DEFAULT_CLIENT_ID;
