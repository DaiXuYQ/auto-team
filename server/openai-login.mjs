import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessTokenClaims, decodeJwtPayload } from './openai-auth.mjs';
import { browserLoginForCallback } from './openai-browser-login.mjs';

const AUTH_BASE_URL = 'https://auth.openai.com';
const CHATGPT_BASE_URL = 'https://chatgpt.com';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const TOKEN_ENDPOINTS = [
  'https://auth.openai.com/api/oauth/oauth2/token',
  'https://auth.openai.com/oauth/token',
];
const callbackInbox = new Map();

const browserHeaders = {
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
};

export class OpenAiLoginError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'OpenAiLoginError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export function storeOAuthCallback(callbackUrl) {
  try {
    const url = new URL(callbackUrl);
    const state = string(url.searchParams.get('state'));
    const code = string(url.searchParams.get('code'));
    if (!state || !code) return false;
    callbackInbox.set(state, { url: url.toString(), expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of callbackInbox) if (value.expiresAt <= Date.now()) callbackInbox.delete(key);
    return true;
  } catch {
    return false;
  }
}

export function consumeOAuthCallback(state) {
  const key = string(state);
  const value = callbackInbox.get(key);
  if (!value || value.expiresAt <= Date.now()) { callbackInbox.delete(key); return ''; }
  callbackInbox.delete(key);
  return value.url;
}

function string(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJsonPart(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function normalizeTotpSecret(secret) {
  const raw = string(secret).replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
  return raw.replace(/=+$/g, '');
}

function generateTotp(secret, timestamp = Date.now()) {
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) return '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new OpenAiLoginError('totp_invalid', '2FA Secret 格式无效', 400);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counterBuffer).digest();
  const index = digest[digest.length - 1] & 0x0f;
  const value = ((digest[index] & 0x7f) << 24) | (digest[index + 1] << 16) | (digest[index + 2] << 8) | digest[index + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

function extractCode(value) {
  if (Array.isArray(value)) {
    for (const item of value) { const code = extractCode(item); if (code) return code; }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const key of ['code', 'otp', 'verification_code', 'verificationCode', 'passcode']) {
      const code = extractCode(value[key]);
      if (code) return code;
    }
    for (const key of ['body', 'text', 'html', 'content', 'message', 'subject']) {
      const code = extractCode(value[key]);
      if (code) return code;
    }
    for (const child of Object.values(value)) { const code = extractCode(child); if (code) return code; }
    return '';
  }
  const text = string(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const contextual = text.match(/(?:verification|security|login|sign[- ]?in|code|验证码)[^\d]{0,100}((?:\d[ -]?){6})/i)
    || text.match(/((?:\d[ -]?){6})[^\w]{0,100}(?:verification|security|login|sign[- ]?in|code)/i);
  const code = contextual?.[1] || text.match(/\b\d{6}\b/)?.[0] || '';
  return code.replace(/\D/g, '').slice(0, 6);
}

function createCookieJar(snapshot = {}) {
  const jar = new Map(Object.entries(snapshot || {}).filter(([key, value]) => key && value));
  function absorb(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') || '').split(/,(?=[^;,]+=)/g);
    for (const line of values) {
      const pair = String(line || '').split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!value || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }
  return {
    absorb,
    header: () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
    snapshot: () => Object.fromEntries(jar),
    get: (name) => jar.get(name) || '',
  };
}

function authStep(url, name) {
  try { return new URL(url).pathname.toLowerCase().includes(name); } catch { return false; }
}

function isCallback(url) {
  return string(url).startsWith(DEFAULT_REDIRECT_URI) || string(url).startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`);
}

function pageUrl(payload, fallback = '') {
  if (!payload || typeof payload !== 'object') return fallback;
  const next = string(payload.page?.payload?.url || payload.continue_url || payload.continueUrl || payload.url || fallback);
  if (!next) return '';
  try { return new URL(next, AUTH_BASE_URL).toString(); } catch { return next; }
}

function classifyChallenge(url, body = '', status = 0) {
  const value = `${url} ${body}`.toLowerCase();
  if (status === 403 || /turnstile|captcha|sentinel|unsupported_country|country_region/.test(value)) return 'browser_verification_required';
  if (/mfa|two-factor|two_factor|totp|authenticator|one-time-password/.test(value)) return 'totp_required';
  if (/email-verification|email_otp|passwordless/.test(value)) return 'email_otp_required';
  return '';
}

function workspaceIdFromCookie(value) {
  const decoded = decodeJsonPart(string(value).split('.')[0]);
  if (!decoded || typeof decoded !== 'object') return '';
  const workspaces = Array.isArray(decoded.workspaces) ? decoded.workspaces : [];
  return string(workspaces.find((item) => item?.kind === 'personal')?.id || workspaces[0]?.id);
}

function sessionFromInput(input = {}) {
  const session = input && typeof input === 'object' ? input : {};
  return {
    state: string(session.state),
    codeVerifier: string(session.codeVerifier),
    currentUrl: string(session.currentUrl),
    phase: string(session.phase),
    deviceId: string(session.deviceId) || randomUUID(),
    cookies: session.cookies && typeof session.cookies === 'object' ? session.cookies : {},
    baselineMailbox: session.baselineMailbox && typeof session.baselineMailbox === 'object' ? session.baselineMailbox : null,
    attempts: Number(session.attempts) || 0,
  };
}

function publicSession(session) {
  return {
    state: session.state,
    codeVerifier: session.codeVerifier,
    currentUrl: session.currentUrl,
    phase: session.phase,
    deviceId: session.deviceId,
    cookies: session.cookies,
    baselineMailbox: session.baselineMailbox,
    attempts: session.attempts,
  };
}

async function waitForMailboxCode(mailboxUrl, email, baseline, requestFetch, timeoutMs = 120000, mailboxHeaders = {}) {
  const target = string(mailboxUrl).replace(/\{email\}/gi, encodeURIComponent(email));
  if (!target) throw new OpenAiLoginError('email_otp_required', '需要邮箱验证码', 202);
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestFetch(target, { headers: { accept: 'application/json,text/plain,*/*', ...mailboxHeaders }, signal: AbortSignal.timeout(Math.min(15000, timeoutMs)) });
      const raw = await response.text().catch(() => '');
      if (!response.ok) last = `mailbox_http_${response.status}`;
      else {
        const code = extractCode(raw);
        const hash = createHash('sha256').update(raw).digest('hex');
        if (code && (!baseline || (baseline.hash !== hash && baseline.code !== code))) return code;
        if (code && !baseline) return code;
        last = code ? 'mailbox_code_unchanged' : 'mailbox_code_missing';
      }
    } catch (error) { last = error?.name === 'TimeoutError' ? 'mailbox_timeout' : 'mailbox_network_error'; }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new OpenAiLoginError('email_otp_timeout', `邮箱验证码获取超时（${last || '未收到新验证码'}）`, 408);
}

class LoginRunner {
  constructor(options = {}) {
    this.email = string(options.email).toLowerCase();
    this.password = string(options.password);
    this.totp = string(options.totp || options.secret);
    this.mailboxUrl = string(options.mailboxUrl);
    this.verificationCode = string(options.verificationCode);
    this.callbackUrl = string(options.callbackUrl);
    this.accountId = string(options.accountId);
    this.requestFetch = options.fetch || fetch;
    this.mailboxHeaders = options.mailboxHeaders && typeof options.mailboxHeaders === 'object' ? options.mailboxHeaders : {};
    this.timeoutMs = Number(options.timeoutMs) || 15000;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.session = sessionFromInput(options.session);
    this.jar = createCookieJar(this.session.cookies);
    this.phase = this.session.phase || 'initializing';
  }

  progress(phase, message) {
    this.phase = phase;
    this.session.phase = phase;
    this.onProgress(phase, message);
  }

  async request(url, options = {}) {
    const headers = { ...browserHeaders, ...(options.headers || {}) };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    const response = await this.requestFetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
    });
    this.jar.absorb(response);
    const text = await response.text().catch(() => '');
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    const location = response.headers.get('location') || '';
    return { response, status: response.status, ok: response.ok || (response.status >= 300 && response.status < 400), text, payload, location: location ? new URL(location, url).toString() : '' };
  }

  authorizeUrl() {
    this.session.state ||= base64Url(randomBytes(18));
    this.session.codeVerifier ||= base64Url(randomBytes(48));
    const query = new URLSearchParams({
      client_id: DEFAULT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: DEFAULT_REDIRECT_URI,
      scope: 'openid email profile offline_access',
      state: this.session.state,
      code_challenge: pkceChallenge(this.session.codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      login_hint: this.email,
    });
    return `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
  }

  async mailboxCode() {
    this.progress('waiting_code', '正在邮箱中等待登录验证码');
    if (this.verificationCode) return this.verificationCode;
    if (!this.mailboxUrl) throw new OpenAiLoginError('email_otp_required', '登录验证码已发送，请填写验证码后重试', 202, { needsInput: true });
    return waitForMailboxCode(this.mailboxUrl, this.email, this.session.baselineMailbox, this.requestFetch, Math.min(120000, Math.max(15000, this.timeoutMs * 8)), this.mailboxHeaders);
  }

  async captureMailboxBaseline() {
    if (!this.mailboxUrl || this.session.baselineMailbox) return;
    try {
      const target = this.mailboxUrl.replace(/\{email\}/gi, encodeURIComponent(this.email));
      const response = await this.requestFetch(target, { headers: { accept: 'application/json,text/plain,*/*', ...this.mailboxHeaders }, signal: AbortSignal.timeout(Math.min(10000, this.timeoutMs)) });
      const raw = await response.text().catch(() => '');
      if (response.ok) this.session.baselineMailbox = { hash: createHash('sha256').update(raw).digest('hex'), code: extractCode(raw) };
    } catch {
      // A mailbox baseline is optional; the provider can still return a new code.
    }
  }

  async sendAuthorizeContinue() {
    this.progress('authenticating', '正在提交登录邮箱');
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/authorize/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/log-in` },
      body: { username: { kind: 'email', value: this.email } },
    });
    if (!result.ok) {
      const challenge = classifyChallenge(result.location || '', result.text, result.status);
      throw new OpenAiLoginError(challenge || 'authorize_failed', challenge ? '登录需要浏览器验证' : '登录邮箱提交失败', result.status || 502, { browserRequired: Boolean(challenge) });
    }
    return pageUrl(result.payload, result.location || `${AUTH_BASE_URL}/email-verification`);
  }

  async sendPasswordlessOtp() {
    await this.captureMailboxBaseline();
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/passwordless/send-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/log-in/password` },
    });
    if (!result.ok) {
      const challenge = classifyChallenge(result.location || '', result.text, result.status);
      throw new OpenAiLoginError(challenge || 'otp_send_failed', challenge ? '登录需要浏览器验证' : '无法发送邮箱验证码', result.status || 502, { browserRequired: Boolean(challenge) });
    }
    return pageUrl(result.payload, result.location || `${AUTH_BASE_URL}/email-verification`);
  }

  async validateEmailOtp(code) {
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/email-otp/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: `${AUTH_BASE_URL}/email-verification` },
      body: { code },
    });
    if (!result.ok) throw new OpenAiLoginError('email_otp_invalid', '邮箱验证码无效或已过期', result.status || 400);
    return pageUrl(result.payload, result.location);
  }

  async validateTotp(url) {
    if (!this.totp) throw new OpenAiLoginError('totp_required', '登录需要 2FA 验证码，请补充 2FA Secret', 202, { needsInput: true });
    const code = generateTotp(this.totp);
    const candidates = [
      url,
      `${AUTH_BASE_URL}/api/accounts/mfa/validate`,
      `${AUTH_BASE_URL}/api/accounts/totp/validate`,
      `${AUTH_BASE_URL}/api/accounts/otp/validate`,
    ].filter((item, index, list) => item && list.indexOf(item) === index);
    let last = null;
    for (const endpoint of candidates) {
      const result = await this.request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: url || `${AUTH_BASE_URL}/log-in` },
        body: { code, otp: code, totp: code, token: code },
      });
      if (result.ok) return pageUrl(result.payload, result.location);
      last = result;
      if (result.status !== 404 && result.status !== 405) break;
    }
    throw new OpenAiLoginError('totp_invalid', last?.status === 403 ? '2FA 验证需要浏览器确认' : '2FA 验证失败', last?.status || 400, { browserRequired: last?.status === 403 });
  }

  async selectWorkspace(url) {
    const workspaceId = workspaceIdFromCookie(this.jar.get('oai-client-auth-session')) || this.accountId;
    if (!workspaceId) throw new OpenAiLoginError('workspace_required', '登录会话没有可选择的空间', 202, { needsInput: true });
    const result = await this.request(`${AUTH_BASE_URL}/api/accounts/workspace/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: AUTH_BASE_URL, referer: url || `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent` },
      body: { workspace_id: workspaceId },
    });
    if (!result.ok) throw new OpenAiLoginError('workspace_select_failed', '空间选择失败', result.status || 502);
    return pageUrl(result.payload, result.location || url);
  }

  async followToCallback(url) {
    let current = url;
    for (let hop = 0; hop < 12 && current; hop += 1) {
      if (isCallback(current)) return current;
      const result = await this.request(current, { headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: `${AUTH_BASE_URL}/` } });
      const challenge = classifyChallenge(current, result.text, result.status);
      if (challenge) throw new OpenAiLoginError(challenge, '登录需要浏览器验证', result.status || 202, { browserRequired: true });
      if (result.location) { current = result.location; continue; }
      if (result.status >= 400) throw new OpenAiLoginError('oauth_redirect_failed', 'OAuth 授权跳转失败', result.status);
      break;
    }
    throw new OpenAiLoginError('oauth_callback_missing', '未能取得 OAuth 回调地址', 502);
  }

  async exchangeCode(callbackUrl) {
    let parsed;
    try { parsed = new URL(callbackUrl); } catch { throw new OpenAiLoginError('callback_invalid', 'OAuth 回调地址无效', 400); }
    const code = string(parsed.searchParams.get('code'));
    const callbackState = string(parsed.searchParams.get('state'));
    if (!code) throw new OpenAiLoginError('callback_code_missing', 'OAuth 回调缺少授权码', 400);
    if (this.session.state && callbackState && callbackState !== this.session.state) throw new OpenAiLoginError('callback_state_mismatch', 'OAuth 回调状态不匹配', 400);
    let last = null;
    for (const endpoint of TOKEN_ENDPOINTS) {
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: DEFAULT_CLIENT_ID, code, redirect_uri: DEFAULT_REDIRECT_URI, code_verifier: this.session.codeVerifier });
      const result = await this.request(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', referer: DEFAULT_REDIRECT_URI }, body });
      if (result.ok) {
        const accessToken = string(result.payload.access_token || result.payload.accessToken);
        const refreshToken = string(result.payload.refresh_token || result.payload.refreshToken);
        const idToken = string(result.payload.id_token || result.payload.idToken);
        if (!accessToken || !refreshToken) throw new OpenAiLoginError('token_incomplete', 'OAuth 返回缺少 AT 或 RT', 502);
        const accessClaims = accessTokenClaims(accessToken);
        const idClaims = decodeJwtPayload(idToken);
        const idAuth = idClaims['https://api.openai.com/auth'] || idClaims.auth || {};
        const claims = {
          ...accessClaims,
          email: accessClaims.email || string(idClaims.email),
          accountId: accessClaims.accountId || string(idAuth.chatgpt_account_id || idClaims.chatgpt_account_id),
          userId: accessClaims.userId || string(idAuth.chatgpt_user_id || idClaims.chatgpt_user_id || idClaims.sub),
          planType: accessClaims.planType || string(idAuth.chatgpt_plan_type || idClaims.chatgpt_plan_type),
        };
        return { accessToken, refreshToken, idToken, claims, cookies: this.jar.snapshot() };
      }
      last = result;
      if (result.status !== 404 && result.status !== 405) break;
    }
    throw new OpenAiLoginError('token_exchange_failed', '授权码交换 Token 失败', last?.status || 502);
  }

  async run() {
    if (!this.email || !this.password) throw new OpenAiLoginError('credentials_required', '请先填写邮箱和密码', 400);
    this.session.attempts += 1;
    try {
      let current = this.callbackUrl || this.session.currentUrl;
      if (!current) {
        this.progress('initializing', '正在创建 OpenAI 登录会话');
        const start = await this.request(this.authorizeUrl(), { headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: `${CHATGPT_BASE_URL}/` } });
        current = start.location || this.authorizeUrl();
        this.session.currentUrl = current;
      }
      if (this.callbackUrl) return await this.exchangeCode(current);
      for (let step = 0; step < 10; step += 1) {
        this.session.currentUrl = current;
        if (isCallback(current)) return await this.exchangeCode(current);
        if (authStep(current, '/log-in') && !authStep(current, '/log-in/password')) {
          current = await this.sendAuthorizeContinue();
          continue;
        }
        if (authStep(current, '/log-in/password')) {
          // OpenAI's current email flow deliberately upgrades the password page
          // to passwordless OTP; the password remains stored for future flows.
          current = await this.sendPasswordlessOtp();
          continue;
        }
        if (authStep(current, '/email-verification')) {
          const code = await this.mailboxCode();
          current = await this.validateEmailOtp(code);
          this.verificationCode = '';
          continue;
        }
        if (authStep(current, '/mfa') || authStep(current, '/two-factor') || authStep(current, '/totp') || authStep(current, '/authenticator') || authStep(current, '/one-time-password')) {
          current = await this.validateTotp(current);
          continue;
        }
        if (authStep(current, '/sign-in-with-chatgpt/codex/consent')) {
          current = await this.selectWorkspace(current);
          continue;
        }
        if (authStep(current, '/add-phone')) throw new OpenAiLoginError('browser_verification_required', '此账号需要浏览器完成额外验证', 202, { browserRequired: true });
        if (current.startsWith(AUTH_BASE_URL)) {
          current = await this.followToCallback(current);
          continue;
        }
        throw new OpenAiLoginError('auth_step_unknown', '登录停在未识别的验证页面', 202, { browserRequired: true });
      }
      throw new OpenAiLoginError('auth_steps_exceeded', '登录步骤过多，已暂停本次操作', 502);
    } catch (error) {
      if (error instanceof OpenAiLoginError) throw error;
      const message = error?.name === 'TimeoutError' ? '登录请求超时' : '登录网络请求失败';
      throw new OpenAiLoginError(error?.name === 'TimeoutError' ? 'network_timeout' : 'network_error', message, 502);
    } finally {
      this.session.cookies = this.jar.snapshot();
      this.session.phase = this.phase;
    }
  }
}

export async function loginFreeAccount(options = {}) {
  const runner = new LoginRunner(options);
  try {
    const token = await runner.run();
    return { ok: true, status: 200, code: 'ready', stage: 'ready', ...token, session: publicSession(runner.session) };
  } catch (error) {
    if (error instanceof OpenAiLoginError && error.browserRequired && options.browserFallback !== false) {
      await runner.captureMailboxBaseline();
      const browserResult = await browserLoginForCallback({
        authUrl: runner.authorizeUrl(),
        email: runner.email,
        password: runner.password,
        proxy: options.browserProxy,
        timeoutMs: Math.max(15000, Number(options.timeoutMs) || 15000),
        totalTimeoutMs: Math.max(60000, Number(options.browserTimeoutMs) || 120000),
        totpCode: () => generateTotp(runner.totp),
        emailOtp: async () => {
          try { return await runner.mailboxCode(); } catch { return ''; }
        },
        onProgress: runner.onProgress,
      });
      if (browserResult.ok && browserResult.callbackUrl) {
        try {
          const token = await runner.exchangeCode(browserResult.callbackUrl);
          return { ok: true, status: 200, code: 'ready', stage: 'ready', ...token, session: publicSession(runner.session) };
        } catch (exchangeError) {
          error = exchangeError;
        }
      } else {
        error = new OpenAiLoginError(browserResult.code || 'browser_login_failed', browserResult.message || '浏览器登录失败', browserResult.code === 'email_otp_required' || browserResult.code === 'totp_required' ? 202 : 502, { browserRequired: true, needsInput: browserResult.code === 'email_otp_required' || browserResult.code === 'totp_required' });
      }
    }
    return {
      ok: false,
      status: error.status || 502,
      code: error.code || 'login_failed',
      message: error.message || '登录失败',
      stage: runner.phase,
      browserRequired: Boolean(error.browserRequired),
      needsInput: Boolean(error.needsInput),
      authUrl: runner.authorizeUrl(),
      session: publicSession(runner.session),
    };
  }
}

export { generateTotp };
