import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'team_rotation_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1024;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_FAILURE_RECORDS = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sessionToken(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  let token = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    if (token !== null) return null;
    const value = part.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

function secureCookie(req) {
  if (req?.socket?.encrypted) return true;
  const forwarded = req?.headers?.['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim().toLowerCase() === 'https';
}

function cookieAttributes(req) {
  return `Path=/api; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}`;
}

export function createDashboardAuth({ password = 'daixuteam', now = Date.now } = {}) {
  const expected = createHash('sha256').update(String(password), 'utf8').digest();
  const sessions = new Map();
  const failures = new Map();

  function clientKey(req) {
    return typeof req?.socket?.remoteAddress === 'string' && req.socket.remoteAddress
      ? req.socket.remoteAddress : '_unknown';
  }

  function isRateLimited(req) {
    const key = clientKey(req);
    const entry = failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now()) {
      failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  function login(candidate, req) {
    const supplied = createHash('sha256').update(typeof candidate === 'string' ? candidate : '', 'utf8').digest();
    const valid = typeof candidate === 'string' && timingSafeEqual(supplied, expected);
    if (!valid) {
      if (isRateLimited(req)) return null;
      const key = clientKey(req);
      const entry = failures.get(key);
      if (entry) entry.count++;
      else {
        while (failures.size >= MAX_FAILURE_RECORDS) failures.delete(failures.keys().next().value);
        failures.set(key, { count: 1, resetAt: now() + FAILURE_WINDOW_MS });
      }
      return null;
    }

    failures.delete(clientKey(req));
    const time = now();
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= time) sessions.delete(token);
    }
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, time + SESSION_TTL_MS);
    return token;
  }

  function authenticated(req) {
    const token = sessionToken(req);
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function logout(req) {
    const token = sessionToken(req);
    return token ? sessions.delete(token) : false;
  }

  function cookie(token, req) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('invalid_session_token');
    return `${COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieAttributes(req)}`;
  }

  function clearCookie(req) {
    return `${COOKIE_NAME}=; Max-Age=0; ${cookieAttributes(req)}`;
  }

  return { login, authenticated, logout, cookie, clearCookie, isRateLimited };
}
