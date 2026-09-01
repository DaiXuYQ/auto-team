import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { accessTokenClaims, refreshOpenAiAccessToken } from './openai-auth.mjs';
import { consumeOAuthCallback, loginFreeAccount, storeOAuthCallback } from './openai-login.mjs';
import { createProxyFetch, maskProxyUrl, parseProxyInput, publicProxySettings } from './proxy.mjs';
import { createStateStorage, isLoopbackHost, secureTokenEqual } from './security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.TEAM_ROTATION_DATA_DIR || path.join(root, 'data'));
const stateFile = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 8786);
const host = process.env.HOST || '127.0.0.1';
const apiAuthToken = String(process.env.TEAM_ROTATION_API_TOKEN || '').trim();
const configuredDataKey = String(process.env.TEAM_ROTATION_DATA_KEY || '').trim();
const CHATGPT_BASE_URL = process.env.CHATGPT_BASE_URL || 'https://chatgpt.com';
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 15000);

if (!isLoopbackHost(host) && !apiAuthToken) {
  throw new Error('TEAM_ROTATION_API_TOKEN is required when HOST is not loopback');
}
if (!isLoopbackHost(host) && !configuredDataKey) {
  throw new Error('TEAM_ROTATION_DATA_KEY is required when HOST is not loopback');
}
const stateStorage = await createStateStorage(dataDir);

const emptyState = {
  version: 1,
  settings: {
    autoRefill: true,
    threshold: 10,
    checkInterval: 60,
    kickOnExhausted: true,
    kickWindow: '5h',
    integrations: {
      sub2api: { baseUrl: '', apiKey: '', groupId: null, groupName: '', enabled: false },
      mailbox: { serviceType: 'manual', endpoint: '', apiKey: '', enabled: false },
    },
    proxy: { enabled: false, strategy: 'failover', timeoutMs: 15000, maxRetries: 2, entries: [] },
  },
  mothers: [],
  children: [],
  history: [],
  updatedAt: new Date().toISOString(),
};

async function loadState() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(stateFile)) return structuredClone(emptyState);
  try {
    const parsed = stateStorage.decode(await readFile(stateFile, 'utf8'));
    return {
      ...structuredClone(emptyState),
      ...parsed,
      settings: {
        ...emptyState.settings,
        ...(parsed.settings || {}),
        integrations: {
          ...emptyState.settings.integrations,
          ...(parsed.settings?.integrations || {}),
          sub2api: { ...emptyState.settings.integrations.sub2api, ...(parsed.settings?.integrations?.sub2api || {}) },
          mailbox: { ...emptyState.settings.integrations.mailbox, ...(parsed.settings?.integrations?.mailbox || {}) },
        },
        proxy: {
          ...emptyState.settings.proxy,
          ...(parsed.settings?.proxy || {}),
          entries: Array.isArray(parsed.settings?.proxy?.entries) ? parsed.settings.proxy.entries : [],
        },
      },
    };
  } catch (error) {
    if (error?.code === 'STATE_DECRYPTION_FAILED' || String(error?.message || '').startsWith('state_encryption_')) throw error;
    return structuredClone(emptyState);
  }
}

let state = await loadState();
const storedProxyTimeout = Number(state.settings.proxy?.timeoutMs);
const storedProxyRetries = Number(state.settings.proxy?.maxRetries);
const storedProxyEntries = (Array.isArray(state.settings.proxy?.entries) ? state.settings.proxy.entries : []).flatMap((entry) => {
  try {
    const raw = typeof entry === 'string' ? entry : entry?.url;
    const parsed = parseProxyInput(raw);
    return [{
      ...parsed,
      id: entry?.id || randomUUID(),
      label: String(entry?.label || '').trim() || (parsed.sourceType === 'local' ? '本机代理' : '家宽代理'),
      display: maskProxyUrl(parsed.url),
      createdAt: entry?.createdAt || now(),
    }];
  } catch {
    return [];
  }
});
state.settings.proxy = {
  enabled: state.settings.proxy?.enabled === true,
  strategy: state.settings.proxy?.strategy === 'round_robin' ? 'round_robin' : 'failover',
  timeoutMs: Number.isFinite(storedProxyTimeout) ? Math.min(120000, Math.max(1000, storedProxyTimeout)) : 15000,
  maxRetries: Number.isFinite(storedProxyRetries) ? Math.min(5, Math.max(0, storedProxyRetries)) : 2,
  entries: storedProxyEntries,
};
state.mothers = (Array.isArray(state.mothers) ? state.mothers : []).map((mother) => ({
  ...mother,
  team: mother.accountId || mother.team || mother.id,
  teamName: mother.teamName || mother.displayName || '',
  rotationMode: mother.rotationMode === 'rotating' ? 'rotating' : 'fixed',
  primaryOwnerEmail: mother.primaryOwnerEmail || mother.email || '',
  tokenScope: 'team',
  planType: mother.planType || 'team',
}));
const proxyFetch = createProxyFetch(() => state.settings.proxy);
state.children = (Array.isArray(state.children) ? state.children : []).map((child) => ({
  ...child,
  // Free credentials stay independent from short-lived Team workspace tokens.
  workspaceTokens: child.workspaceTokens && typeof child.workspaceTokens === 'object' && !Array.isArray(child.workspaceTokens)
    ? child.workspaceTokens
    : {},
  teamAuthSessions: child.teamAuthSessions && typeof child.teamAuthSessions === 'object' && !Array.isArray(child.teamAuthSessions)
    ? child.teamAuthSessions
    : {},
  tokenScope: 'free',
  accountType: 'free',
  plan: String(child.plan || '').toLowerCase() === 'team' ? 'free' : (child.plan || 'free'),
}));
let writeQueue = Promise.resolve();
function persist() {
  state.updatedAt = new Date().toISOString();
  const snapshot = stateStorage.encode(state);
  writeQueue = writeQueue.then(async () => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, stateFile);
  });
  return writeQueue;
}

if (stateStorage.legacyPlaintextLoaded) await persist();
for (const entry of await readdir(dataDir).catch(() => [])) {
  if (!/^state\.json\.\d+\.tmp$/.test(entry)) continue;
  await unlink(path.join(dataDir, entry)).catch(() => {});
}

function now() { return new Date().toISOString(); }
function addHistory(action, detail, result = 'success') {
  state.history = [{ id: randomUUID(), time: now(), action, detail, result }, ...state.history].slice(0, 200);
}
function preview(value) {
  if (!value || typeof value !== 'string') return '';
  return value.length <= 12 ? `${value.slice(0, 3)}...` : `${value.slice(0, 8)}...${value.slice(-4)}`;
}
function membershipFor(child, teamId, create = false) {
  if (!child || !teamId) return null;
  if (!Array.isArray(child.workspaceHistory)) child.workspaceHistory = [];
  let entry = child.workspaceHistory.find((item) => item.team === teamId && item.status === 'active');
  if (!entry && create) {
    entry = { team: teamId, joinedAt: child.joinedAt || now(), status: 'active' };
    child.workspaceHistory.push(entry);
  }
  return entry || null;
}
function workspaceTokenFor(child, workspaceId) {
  if (!child || !workspaceId) return null;
  const stored = child.workspaceTokens?.[workspaceId];
  const legacy = membershipFor(child, workspaceId)?.teamAccessToken;
  const accessToken = String(stored?.accessToken || legacy || '').trim();
  return accessToken ? { ...stored, accessToken } : null;
}

function teamTokenDetails(accessToken, workspaceId) {
  const token = String(accessToken || '').trim();
  const target = String(workspaceId || '').trim();
  if (!token || !target) return null;
  const claims = accessTokenClaims(token);
  if (claims.accountId !== target) return null;
  const expiresAt = Date.parse(claims.expiresAt || '');
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30_000) return null;
  return { accessToken: token, claims };
}

function teamManagerContexts(mother) {
  const workspaceId = String(mother?.accountId || mother?.team || '').trim();
  if (!mother || !workspaceId) return [];
  const candidates = [
    { ...mother, source: 'team_primary' },
    ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts.map((owner) => ({ ...owner, source: 'team_owner' })) : []),
  ];
  for (const child of state.children) {
    if (!isChildMemberOfTeam(child, mother.team) || (!childIsWorkspaceOwner(child, mother) && !childMatchesKnownTeamOwner(child, mother))) continue;
    const workspaceToken = workspaceTokenFor(child, workspaceId);
    if (!workspaceToken?.accessToken) continue;
    candidates.push({
      accessToken: workspaceToken.accessToken,
      expiresAt: workspaceToken.expiresAt,
      email: child.email,
      deviceId: child.deviceId,
      cookie: child.cookie,
      source: 'free_account_team_owner',
    });
  }
  const usable = candidates.flatMap((candidate) => {
    const details = teamTokenDetails(candidate.accessToken, workspaceId);
    return details ? [{ ...candidate, ...details }] : [];
  });
  usable.sort((left, right) => Date.parse(right.claims.expiresAt || '') - Date.parse(left.claims.expiresAt || ''));
  return usable.map((selected) => ({
    ...mother,
    accessToken: selected.accessToken,
    deviceId: selected.deviceId || mother.deviceId,
    cookie: selected.cookie || mother.cookie,
    managerSource: selected.source,
    managerEmail: selected.email || mother.email || '',
  }));
}

function teamManagerContext(mother) {
  return teamManagerContexts(mother)[0] || null;
}

function teamHasManagementPath(mother) {
  if (!mother?.accountId) return false;
  if (teamManagerContext(mother)) return true;
  if (mother.accessToken || mother.refreshToken || (mother.email && mother.password)
    || (mother.ownerAccounts || []).some((owner) => owner?.accessToken || owner?.refreshToken || (owner?.email && owner?.password))) return true;
  return state.children.some((child) => (
    isChildMemberOfTeam(child, mother.team)
    && (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother))
    && Boolean(child.accessToken || child.refreshToken || (child.email && child.password))
  ));
}

async function withTeamManager(mother, operation) {
  const managers = teamManagerContexts(mother);
  if (!managers.length) return { manager: null, result: null };
  let attempted = null;
  for (const manager of managers) {
    attempted = { manager, result: await operation(manager) };
    if (attempted.result?.status !== 401 && attempted.result?.status !== 403) return attempted;
  }
  return attempted;
}

function teamOwnerCandidateChildren(mother) {
  const ownerEmails = new Set([
    mother?.email,
    ...(Array.isArray(mother?.ownerAccounts) ? mother.ownerAccounts.map((owner) => owner?.email) : []),
  ].filter(Boolean).map((email) => String(email).trim().toLowerCase()));
  const linkedIds = new Set((mother?.ownerAccounts || []).map((owner) => String(owner?.linkedFreeAccountId || '')).filter(Boolean));
  return state.children.filter((child) => {
    if (!isChildMemberOfTeam(child, mother?.team)) return false;
    const email = String(child.email || '').trim().toLowerCase();
    const isOwner = childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother) || ownerEmails.has(email) || linkedIds.has(String(child.id));
    return isOwner && Boolean(child.accessToken || child.refreshToken || (child.email && child.password));
  });
}

async function recoverTeamManagerToken(mother, { force = false } = {}) {
  if (!mother?.accountId) return { ok: false, status: 400, message: 'workspace_id_required' };
  if (!force && teamManagerContext(mother)) return { ok: true, status: 200, source: 'stored_team_token' };
  const workspaceId = mother.accountId;
  const records = [mother, ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts : [])];
  for (const record of records) {
    if (!record?.refreshToken) continue;
    const refreshed = await refreshOpenAiAccessToken(record.refreshToken, record.clientId, OPENAI_REQUEST_TIMEOUT_MS, proxyFetch);
    if (!refreshed.ok) continue;
    const claims = refreshed.claims || accessTokenClaims(refreshed.accessToken);
    record.refreshToken = refreshed.refreshToken || record.refreshToken;
    record.idToken = refreshed.idToken || record.idToken;
    await persist();
    if (claims.accountId !== workspaceId) {
      const temporary = { ...record, accessToken: refreshed.accessToken, workspaceTokens: {}, workspaceHistory: [] };
      const exchanged = await switchWorkspace(temporary, { workspaceId });
      const workspaceToken = workspaceTokenFor(temporary, workspaceId);
      if (!exchanged.ok || !workspaceToken?.accessToken) continue;
      record.accessToken = workspaceToken.accessToken;
      record.expiresAt = workspaceToken.expiresAt || record.expiresAt || null;
      addHistory('刷新 Team 管理凭据', `${record.email || mother.email} 已通过 refresh token 重新切换到 ${mother.team}`);
      await persist();
      return { ok: true, status: 200, source: 'team_refresh_and_workspace_exchange' };
    }
    record.accessToken = refreshed.accessToken;
    record.expiresAt = claims.expiresAt || record.expiresAt || null;
    addHistory('刷新 Team 管理凭据', `${record.email || mother.email} 已通过 refresh token 恢复 ${mother.team}`);
    await persist();
    return { ok: true, status: 200, source: 'team_refresh_token' };
  }
  let lastFailure = null;
  for (const child of teamOwnerCandidateChildren(mother)) {
    const exchanged = await switchWorkspaceWithFreeRecovery(child, mother.accountId);
    if (exchanged.ok) {
      addHistory('恢复 Team 管理凭据', `${child.email} 已重新取得 ${mother.team} 的管理 Token`);
      await persist();
      return { ok: true, status: 200, source: exchanged.freeAuth?.source || 'workspace_exchange', childId: child.id };
    }
    lastFailure = exchanged;
  }
  for (const record of records) {
    if (!record?.email || !record.password || (!record.totp && !record.secret)) continue;
    const temporary = {
      ...record,
      workspaceTokens: {},
      workspaceHistory: [],
      teamAuthSessions: record.teamAuthSessions && typeof record.teamAuthSessions === 'object' ? record.teamAuthSessions : {},
    };
    const authenticated = await acquireTeamAuth(mother, temporary, { force: true });
    record.teamAuthSessions = temporary.teamAuthSessions;
    if (!authenticated.ok) {
      lastFailure = authenticated;
      await persist();
      continue;
    }
    const workspaceToken = workspaceTokenFor(temporary, workspaceId);
    if (!workspaceToken?.accessToken) continue;
    record.accessToken = workspaceToken.accessToken;
    record.refreshToken = temporary.refreshToken || record.refreshToken || '';
    record.idToken = temporary.idToken || record.idToken || '';
    record.expiresAt = workspaceToken.expiresAt || record.expiresAt || null;
    record.teamAuthSessions = {};
    addHistory('重新登录 Team 所有者', `${record.email} 已通过邮箱、密码和 2FA 恢复 ${mother.team}`);
    await persist();
    return { ok: true, status: 200, source: 'team_email_password_2fa' };
  }
  return { ok: false, status: lastFailure?.status || 401, message: lastFailure?.message || 'workspace_owner_token_required', code: lastFailure?.code || null };
}
function saveWorkspaceToken(child, workspaceId, accessToken, claims = {}) {
  if (!child || !workspaceId || !accessToken) return null;
  if (!child.workspaceTokens || typeof child.workspaceTokens !== 'object' || Array.isArray(child.workspaceTokens)) child.workspaceTokens = {};
  const record = {
    accessToken,
    accountId: claims.accountId || workspaceId,
    userId: claims.userId || child.chatgptUserId || null,
    expiresAt: claims.expiresAt || null,
    acquiredAt: now(),
    source: 'workspace_session_exchange',
  };
  child.workspaceTokens[workspaceId] = record;
  return record;
}
function membershipHistoryFor(child, teamId) {
  if (!child || !teamId || !Array.isArray(child.workspaceHistory)) return [];
  return child.workspaceHistory.filter((item) => item && item.team === teamId);
}
function latestMembershipHistoryFor(child, teamId) {
  const entries = membershipHistoryFor(child, teamId);
  return entries.length ? entries[entries.length - 1] : null;
}
function canRejoinTeam(child, teamId) {
  if (!child || !teamId) return false;
  if (membershipHistoryFor(child, teamId).some((entry) => entry.status === 'active')) return false;
  const last = [...membershipHistoryFor(child, teamId)].reverse().find((entry) => ['kicked', 'cooldown'].includes(entry.status));
  if (!last) return true;
  const retryAt = Date.parse(last.retryAfter || '');
  if (Number.isFinite(retryAt)) return retryAt <= Date.now();
  // A quota removal without a server-provided reset must be held until the
  // account is explicitly rechecked; a manual removal remains rejoinable.
  if (last.reason === 'quota_5h' || last.reason === 'quota_7d') return last.rejoinEligible === true;
  return last.rejoinEligible !== false;
}
function isChildMemberOfTeam(child, teamId) {
  if (!child || !teamId) return false;
  if (membershipHistoryFor(child, teamId).some((entry) => entry.status === 'active')) return true;
  const history = membershipHistoryFor(child, teamId);
  return child.team === teamId && child.status !== 'kicked' && !history.some((entry) => ['kicked', 'cooldown'].includes(entry.status));
}
function publicChild(child, teamId = null) {
  const { accessToken, refreshToken, idToken, password, totp, secret, cookies, sessionJson, credentials, authSession, teamAuthSessions, verificationCode, loginUrl, loginBrowserRequired, workspaceTokens, ...safe } = child;
  const membership = teamId ? membershipFor(child, teamId) : null;
  const safeToken = accessToken ? preview(accessToken) : child.token?.startsWith('待') ? child.token : preview(child.token);
  const history = Array.isArray(child.workspaceHistory) ? child.workspaceHistory : [];
  const joinedTeams = history.map((entry) => ({
    team: entry.team || entry.workspaceId || '',
    status: entry.status || 'unknown',
    joinedAt: entry.joinedAt || null,
    removedAt: entry.removedAt || null,
    cooldownAt: entry.cooldownAt || null,
    retryAfter: entry.retryAfter || null,
    rejoinEligible: entry.rejoinEligible ?? null,
    reason: entry.reason || null,
    quota5h: entry.quota5h ?? null,
    quota7d: entry.quota7d ?? null,
    quotaUpdatedAt: entry.quotaUpdatedAt || null,
  })).filter((entry) => entry.team);
  if (child.team && !joinedTeams.some((entry) => entry.team === child.team && entry.status === 'active')
    && !joinedTeams.some((entry) => entry.team === child.team && ['kicked', 'cooldown'].includes(entry.status))) {
    joinedTeams.push({ team: child.team, status: 'active', joinedAt: child.joinedAt || null, removedAt: null, retryAfter: null, reason: null, quota5h: child.quota5h ?? null, quota7d: child.quota7d ?? null, quotaUpdatedAt: child.lastQuotaCheckAt || null });
  }
  return {
    ...safe,
    quota5h: membership?.quota5h ?? child.quota5h ?? null,
    quota7d: membership?.quota7d ?? child.quota7d ?? null,
    quotaSnapshot: membership?.quotaSnapshot || child.quotaSnapshot || null,
    token: safeToken,
    hasAccessToken: Boolean(accessToken || (child.token && !child.token.startsWith('待'))),
    // A Free account keeps its pool identity after joining one or more Teams.
    // Team membership is represented by `team` and `joinedTeams`, not by the
    // account type itself; imported Team owner records live on `mothers`.
    accountType: String(child.plan || '').toLowerCase() === 'team' ? 'team' : 'free',
    credentialsStatus: {
      hasPassword: Boolean(password),
      hasTotp: Boolean(totp || child.secret),
      hasAccessToken: Boolean(accessToken || (child.token && !child.token.startsWith('待'))),
      hasRefreshToken: Boolean(refreshToken),
      canAcquire: Boolean(accessToken || refreshToken || (child.email && password)),
    },
    login: {
      status: child.loginStatus || (accessToken ? 'ready' : child.password ? 'login_required' : 'credentials_required'),
      message: child.loginMessage || '',
      browserRequired: Boolean(loginBrowserRequired),
      authUrl: loginBrowserRequired ? loginUrl || null : null,
      lastAttemptAt: child.loginAttemptedAt || null,
    },
    sub2apiStatus: {
      imported: Boolean(child.sub2apiImported || child.sub2api?.imported || child.importSource === 'sub2api' || accessToken),
      exportable: Boolean(accessToken),
      importedAt: child.importedAt || null,
    },
    tokenScope: 'free',
    joinedTeams,
  };
}
function publicMother(mother) {
  const { accessToken, refreshToken, idToken, password, totp, secret, cookies, sessionJson, credentials, authSession, teamAuthSessions, workspaceTokens, workspaceHistory, verificationCode, loginUrl, token, ownerAccounts, ...safe } = mother;
  const safeOwners = Array.isArray(ownerAccounts) ? ownerAccounts.map((owner) => ({
    email: owner.email || '',
    name: owner.name || '',
    userId: owner.chatgptUserId || null,
    token: owner.accessToken ? preview(owner.accessToken) : '',
    hasAccessToken: Boolean(owner.accessToken),
    tokenScope: 'team',
    credentialsStatus: { hasPassword: Boolean(owner.password), hasTotp: Boolean(owner.totp), hasAccessToken: Boolean(owner.accessToken), hasRefreshToken: Boolean(owner.refreshToken) },
  })) : [];
  return {
    ...safe,
    ownerAccounts: safeOwners,
    token: accessToken ? preview(accessToken) : token?.startsWith('待') ? token : preview(token),
    hasAccessToken: Boolean(accessToken || (token && !token.startsWith('待'))),
    credentialsStatus: {
      hasPassword: Boolean(password),
      hasTotp: Boolean(totp || mother.secret),
      hasAccessToken: Boolean(accessToken || (token && !token.startsWith('待'))),
    },
    tokenScope: 'team',
  };
}

function publicTeamOwnerRecord(mother, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const owner = [mother, ...(Array.isArray(mother?.ownerAccounts) ? mother.ownerAccounts : [])]
    .find((item) => String(item?.email || '').trim().toLowerCase() === target);
  if (!owner) return null;
  return {
    name: owner.name || owner.email || email,
    token: owner.accessToken ? preview(owner.accessToken) : '',
    hasAccessToken: Boolean(owner.accessToken),
    tokenScope: 'team',
    credentialsStatus: { hasPassword: Boolean(owner.password), hasTotp: Boolean(owner.totp || owner.secret), hasAccessToken: Boolean(owner.accessToken), hasRefreshToken: Boolean(owner.refreshToken) },
    sub2apiStatus: { imported: Boolean(owner.accessToken), exportable: Boolean(owner.accessToken), importedAt: owner.importedAt || null },
  };
}
function publicTeam(mother) {
  const teamId = canonicalTeamId(mother);
  const displayName = mother.teamName || mother.displayName || '未命名 Team';
  const primaryOwnerEmail = String(mother.primaryOwnerEmail || mother.email || '');
  const snapshot = mother.seatSnapshot || mother.subscription || {};
  const seatsEntitled = Number.isFinite(Number(mother.seats)) ? Number(mother.seats) : Number(snapshot.seatsEntitled);
  const seatsInUse = Number.isFinite(Number(mother.used)) ? Number(mother.used) : Number(snapshot.seatsInUse);
  const children = state.children.filter((child) => isChildMemberOfTeam(child, teamId));
  const currentAccounts = [];
  const ownerEmails = new Set([mother.email, ...(mother.ownerAccounts || []).map((owner) => owner.email)].filter(Boolean).map((email) => String(email).toLowerCase()));
  const seenChildren = new Set();
  for (const member of (mother.members || []).filter((item) => item.email || item.id)) {
    const child = children.find((item) => (member.id && item.memberId === member.id) || (member.email && item.email?.toLowerCase() === member.email.toLowerCase()));
    if (child) {
      seenChildren.add(child.id);
      const owner = memberIsOwner(member, mother) || ownerEmails.has(String(child.email || '').toLowerCase());
      const childProjection = publicChild(child, teamId);
      const ownerProjection = owner ? publicTeamOwnerRecord(mother, child.email) : null;
      currentAccounts.push({ ...childProjection, ...(ownerProjection || {}), quota5h: childProjection.quota5h, quota7d: childProjection.quota7d, quotaSnapshot: childProjection.quotaSnapshot, accountType: owner ? 'team-owner' : 'team-member', role: owner ? (member.role || 'account-owner') : member.role || null });
    } else {
      const memberOwner = memberIsOwner(member, mother) ? publicTeamOwnerRecord(mother, member.email) : null;
      currentAccounts.push({
        id: member.id || member.accountUserId || `member_${currentAccounts.length}`,
        email: member.email || '',
        name: member.name || '',
        ...(memberOwner || {}),
        accountType: memberIsOwner(member, mother) ? 'team-owner' : 'team-member',
        role: member.role || null,
        status: member.deactivatedTime ? 'inactive' : 'active',
        quota5h: null,
        quota7d: null,
        credentialsStatus: member.email?.toLowerCase() === mother.email?.toLowerCase() ? { hasPassword: Boolean(mother.password), hasTotp: Boolean(mother.totp || mother.secret), hasAccessToken: Boolean(mother.accessToken) } : null,
        joinedTeams: [{ team: teamId, status: 'active', joinedAt: member.createdTime || null }],
      });
    }
  }
  for (const child of children) if (!seenChildren.has(child.id)) {
    const owner = memberIsOwner(child.memberSnapshot, mother) || ownerEmails.has(String(child.email || '').toLowerCase());
    const childProjection = publicChild(child, teamId);
    const ownerProjection = owner ? publicTeamOwnerRecord(mother, child.email) : null;
    currentAccounts.push({ ...childProjection, ...(ownerProjection || {}), quota5h: childProjection.quota5h, quota7d: childProjection.quota7d, quotaSnapshot: childProjection.quotaSnapshot, accountType: owner ? 'team-owner' : 'team-member', role: child.memberSnapshot?.role || null });
  }
  for (const owner of (mother.ownerAccounts || [])) {
    if (!owner.email || currentAccounts.some((account) => account.email?.toLowerCase() === owner.email.toLowerCase())) continue;
    currentAccounts.push({
      id: owner.chatgptUserId || `owner_${currentAccounts.length}`,
      email: owner.email,
      name: owner.name || '',
      accountType: 'team-owner',
      role: 'account-owner',
      status: 'active',
      token: owner.accessToken ? preview(owner.accessToken) : '',
      hasAccessToken: Boolean(owner.accessToken),
      tokenScope: 'team',
      quota5h: null,
      quota7d: null,
      credentialsStatus: { hasPassword: Boolean(owner.password), hasTotp: Boolean(owner.totp), hasAccessToken: Boolean(owner.accessToken), hasRefreshToken: Boolean(owner.refreshToken) },
      sub2apiStatus: { imported: Boolean(owner.accessToken), exportable: Boolean(owner.accessToken), importedAt: null },
      joinedTeams: [{ team: teamId, status: 'active', joinedAt: null }],
    });
  }
  if (!currentAccounts.some((account) => account.email?.toLowerCase() === mother.email?.toLowerCase()) && mother.email) {
    currentAccounts.unshift({ id: mother.chatgptUserId || `owner_${mother.id}`, email: mother.email, ...publicTeamOwnerRecord(mother, mother.email), accountType: 'team-owner', status: 'active', quota5h: null, quota7d: null, joinedTeams: [{ team: teamId, status: 'active', joinedAt: mother.createdAt || null }] });
  }
  const primaryOwner = currentAccounts.find((account) => String(account.email || '').toLowerCase() === primaryOwnerEmail.toLowerCase()) || currentAccounts.find((account) => account.accountType === 'team-owner');
  return {
    id: mother.id,
    teamId,
    name: displayName,
    displayName,
    rotationMode: mother.rotationMode === 'rotating' ? 'rotating' : 'fixed',
    owner: { email: primaryOwner?.email || mother.email || '', name: primaryOwner?.name || mother.name || '', userId: primaryOwner?.id || mother.chatgptUserId || null },
    primaryOwnerEmail,
    owners: currentAccounts.filter((account) => account.accountType === 'team-owner').map((account) => ({ email: account.email || '', name: account.name || '', userId: account.id || null })),
    seats: {
      used: Number.isFinite(seatsInUse) ? seatsInUse : null,
      entitled: Number.isFinite(seatsEntitled) ? seatsEntitled : null,
      open: Number.isFinite(seatsInUse) && Number.isFinite(seatsEntitled) ? Math.max(0, seatsEntitled - seatsInUse) : null,
    },
    status: mother.status || 'unconfigured',
    lastCheck: mother.lastCheck || null,
    lastSync: mother.lastWorkspaceSyncAt || null,
    currentAccounts,
  };
}
function publicHistory() {
  return (Array.isArray(state.history) ? state.history : []).map((item) => {
    let detail = String(item.detail || '');
    for (const mother of state.mothers) {
      const teamId = canonicalTeamId(mother);
      if (!teamId) continue;
      detail = detail.split(teamId).join(teamDisplayName(mother));
    }
    return { ...item, detail };
  });
}
function publicState({ includeHistory = true } = {}) {
  const integrations = state.settings?.integrations || {};
  const safeSettings = {
    ...state.settings,
    integrations: {
      sub2api: { baseUrl: integrations.sub2api?.baseUrl || '', enabled: integrations.sub2api?.enabled === true, groupId: Number.isFinite(Number(integrations.sub2api?.groupId)) ? Number(integrations.sub2api.groupId) : null, groupName: integrations.sub2api?.groupName || '', apiKeySet: Boolean(integrations.sub2api?.apiKey) },
      mailbox: { serviceType: integrations.mailbox?.serviceType || 'manual', endpoint: integrations.mailbox?.endpoint || '', enabled: integrations.mailbox?.enabled === true, apiKeySet: Boolean(integrations.mailbox?.apiKey) },
    },
    proxy: publicProxySettings(state.settings),
  };
  const snapshot = { ...state, settings: safeSettings, teams: state.mothers.map(publicTeam), mothers: state.mothers.map(publicMother), children: state.children.map(publicChild) };
  if (includeHistory) snapshot.history = publicHistory();
  else delete snapshot.history;
  return snapshot;
}
const configuredCorsOrigins = new Set(String(process.env.TEAM_ROTATION_ALLOWED_ORIGINS || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
if (isLoopbackHost(host)) {
  configuredCorsOrigins.add('http://127.0.0.1:5173');
  configuredCorsOrigins.add('http://localhost:5173');
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (configuredCorsOrigins.has(origin)) return true;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin || !requestOriginAllowed(req)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function apiAuthOk(req) {
  if (!apiAuthToken) return true;
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : String(req.headers['x-api-token'] || '').trim();
  return secureTokenEqual(supplied, apiAuthToken);
}

function responseHeaders(res) {
  return {
    ...(res.securityHeaders || {}),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...responseHeaders(res), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendText(res, status, body, type = 'text/plain; charset=utf-8') { res.writeHead(status, { ...responseHeaders(res), 'content-type': type }); res.end(body); }
async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error('request too large');
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('invalid JSON'); }
}
function findMother(id) { return state.mothers.find((mother) => mother.id === id); }
function findChild(id) { return state.children.find((child) => child.id === id); }
function canonicalTeamId(mother) { return mother?.accountId || mother?.team || mother?.id || ''; }
function teamDisplayName(mother) { return mother?.teamName || mother?.displayName || '未命名 Team'; }
function primaryOwnerRecord(mother) {
  const primaryEmail = String(mother?.primaryOwnerEmail || mother?.email || '').toLowerCase();
  return [mother, ...(mother?.ownerAccounts || [])].find((owner) => String(owner?.email || '').toLowerCase() === primaryEmail) || mother;
}
function promotePrimaryOwner(mother) {
  const owner = primaryOwnerRecord(mother);
  if (!owner || owner === mother) return;
  for (const key of ['email', 'password', 'totp', 'mailboxUrl', 'accessToken', 'refreshToken', 'accountId', 'chatgptUserId', 'clientId', 'idToken', 'organizationId', 'modelMapping', 'expiresAt', 'subscriptionExpiresAt', 'quotaSnapshot', 'quota5h', 'quota7d', 'quota5hResetAfterSeconds', 'quota7dResetAfterSeconds', 'quota5hResetAt', 'quota7dResetAt', 'quotaUpdatedAt']) {
    if (owner[key] !== undefined && owner[key] !== null && owner[key] !== '') mother[key] = owner[key];
  }
}
function isTeamAccount(item) {
  const fields = credentialFields(item);
  return String(fields.planType || item.plan || item.accountType || '').toLowerCase() === 'team';
}
function mergeImportedMother(mother, item) {
  const imported = motherFromImportedAccount(item);
  const owner = imported.ownerAccounts?.[0];
  if (!Array.isArray(mother.ownerAccounts)) mother.ownerAccounts = [];
  if (owner?.email) {
    const existing = mother.ownerAccounts.find((entry) => entry.email?.toLowerCase() === owner.email.toLowerCase());
    if (existing) Object.assign(existing, Object.fromEntries(Object.entries(owner).filter(([, value]) => value !== '' && value !== null && value !== undefined)));
    else mother.ownerAccounts.push(owner);
  }
  const primaryFields = ['teamName', 'seats', 'used', 'accountId', 'team', 'subscription', 'seatSnapshot'];
  for (const key of primaryFields) {
    if ((mother[key] === '' || mother[key] === null || mother[key] === undefined) && imported[key] !== '' && imported[key] !== null && imported[key] !== undefined) mother[key] = imported[key];
  }
  if (!mother.accessToken && imported.accessToken) mother.accessToken = imported.accessToken;
  if (!mother.refreshToken && imported.refreshToken) mother.refreshToken = imported.refreshToken;
  if (!mother.email && imported.email) mother.email = imported.email;
  if (!mother.name && imported.name) mother.name = imported.name;
  return mother;
}
function linkFreeAccountsToImportedTeams() {
  const teamsByOwnerEmail = new Map();
  const ownerCredentialsByEmail = new Map();
  const teamQuotaByEmail = new Map();
  for (const mother of state.mothers) {
    const teamId = canonicalTeamId(mother);
    if (!teamId) continue;
    for (const owner of [{ email: mother.email, password: mother.password, totp: mother.totp, mailboxUrl: mother.mailboxUrl }, ...(mother.ownerAccounts || [])]) {
      if (owner.email) {
        const key = String(owner.email).toLowerCase();
        const existing = ownerCredentialsByEmail.get(key) || {};
        ownerCredentialsByEmail.set(key, {
          ...existing,
          password: existing.password || owner.password || '',
          totp: existing.totp || owner.totp || '',
          mailboxUrl: existing.mailboxUrl || owner.mailboxUrl || '',
        });
        const teamKey = `${teamId}:${key}`;
        const existingQuota = teamQuotaByEmail.get(teamKey) || {};
        teamQuotaByEmail.set(teamKey, {
          quota5h: existingQuota.quota5h ?? owner.quota5h ?? null,
          quota7d: existingQuota.quota7d ?? owner.quota7d ?? null,
          quotaSnapshot: existingQuota.quotaSnapshot || owner.quotaSnapshot || null,
          quota5hResetAfterSeconds: existingQuota.quota5hResetAfterSeconds ?? owner.quota5hResetAfterSeconds ?? null,
          quota7dResetAfterSeconds: existingQuota.quota7dResetAfterSeconds ?? owner.quota7dResetAfterSeconds ?? null,
          quota5hResetAt: existingQuota.quota5hResetAt || owner.quota5hResetAt || null,
          quota7dResetAt: existingQuota.quota7dResetAt || owner.quota7dResetAt || null,
          quotaUpdatedAt: existingQuota.quotaUpdatedAt || owner.quotaUpdatedAt || null,
        });
      }
    }
    const memberEmails = (mother.members || [])
      .filter((member) => memberIsActive(member))
      .map((member) => member.email)
      .filter(Boolean);
    const accountEmails = [mother.email, ...(mother.ownerAccounts || []).map((owner) => owner.email), ...memberEmails].filter(Boolean);
    for (const email of accountEmails) {
      const key = String(email).toLowerCase();
      if (!teamsByOwnerEmail.has(key)) teamsByOwnerEmail.set(key, []);
      const values = teamsByOwnerEmail.get(key);
      if (!values.includes(teamId)) values.push(teamId);
    }
  }
  for (const child of state.children) {
    if (String(child.plan || '').toLowerCase() !== 'free' || !child.email) continue;
    const teamIds = teamsByOwnerEmail.get(child.email.toLowerCase()) || [];
    const ownerCredentials = ownerCredentialsByEmail.get(child.email.toLowerCase());
    if (ownerCredentials) {
      if (!child.password && ownerCredentials.password) child.password = ownerCredentials.password;
      if (!child.totp && ownerCredentials.totp) child.totp = ownerCredentials.totp;
      if (!child.mailboxUrl && ownerCredentials.mailboxUrl) child.mailboxUrl = ownerCredentials.mailboxUrl;
    }
    for (const teamId of teamIds) {
      const membership = membershipFor(child, teamId, true);
      membership.source = membership.source || 'team_owner_email_match';
      membership.status = 'active';
      membership.joinedAt = membership.joinedAt || child.joinedAt || now();
      const importedQuota = teamQuotaByEmail.get(`${teamId}:${child.email.toLowerCase()}`);
      const measuredQuota = membership.quotaSnapshot?.primary?.usedPercent != null || membership.quotaSnapshot?.secondary?.usedPercent != null;
      if (importedQuota && !measuredQuota) {
        if (importedQuota.quota5h != null) membership.quota5h = importedQuota.quota5h;
        if (importedQuota.quota7d != null) membership.quota7d = importedQuota.quota7d;
        if (importedQuota.quotaSnapshot) membership.quotaSnapshot = importedQuota.quotaSnapshot;
        if (importedQuota.quota5hResetAfterSeconds != null) membership.quota5hResetAfterSeconds = importedQuota.quota5hResetAfterSeconds;
        if (importedQuota.quota7dResetAfterSeconds != null) membership.quota7dResetAfterSeconds = importedQuota.quota7dResetAfterSeconds;
        if (importedQuota.quota5hResetAt) membership.quota5hResetAt = importedQuota.quota5hResetAt;
        if (importedQuota.quota7dResetAt) membership.quota7dResetAt = importedQuota.quota7dResetAt;
        if (importedQuota.quotaUpdatedAt) membership.quotaUpdatedAt = importedQuota.quotaUpdatedAt;
        membership.quotaSource = 'sub2api-team-import';
      }
    }
    if (teamIds.length && !child.team) {
      child.team = teamIds[0];
      child.joinedAt = child.joinedAt || now();
      child.status = child.accessToken ? 'active' : 'login_required';
    }
  }
}
function migrateTeamMemberships(oldTeam, newTeam) {
  if (!oldTeam || !newTeam || oldTeam === newTeam) return;
  for (const child of state.children) {
    if (child.team === oldTeam) child.team = newTeam;
    if (Array.isArray(child.workspaceHistory)) {
      for (const entry of child.workspaceHistory) {
        if (entry.team === oldTeam) entry.team = newTeam;
      }
    }
    if (child.memberSnapshot?.team === oldTeam) child.memberSnapshot.team = newTeam;
    if (child.workspaceTokens?.[oldTeam]) {
      child.workspaceTokens[newTeam] = child.workspaceTokens[newTeam] || child.workspaceTokens[oldTeam];
      delete child.workspaceTokens[oldTeam];
    }
  }
}
function bearer(token) { return token ? { authorization: `Bearer ${token}` } : {}; }

function chatGptHeaders(accessToken, accountId, targetPath, targetRoute, extra = {}) {
  return {
    accept: 'application/json, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...bearer(accessToken),
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    origin: CHATGPT_BASE_URL,
    referer: `${CHATGPT_BASE_URL}/admin/members`,
    'oai-device-id': extra['oai-device-id'] || randomUUID(),
    'oai-language': 'zh-CN',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36',
    'x-openai-target-path': targetPath,
    'x-openai-target-route': targetRoute,
    ...(extra.cookie ? { cookie: extra.cookie } : {}),
    ...extra,
  };
}

async function fetchChatGptJson(accessToken, requestPath, options = {}) {
  if (!accessToken) return { ok: false, status: 0, message: 'missing_token', payload: {} };
  const targetPath = options.targetPath || requestPath.split('?')[0];
  const targetRoute = options.targetRoute || targetPath.replace(/\/[^/]+(?=\/users|\/subscriptions)/, '/{account_id}');
  const url = requestPath.startsWith('http') ? requestPath : `${CHATGPT_BASE_URL}${requestPath}`;
  const started = Date.now();
  try {
    const response = await proxyFetch(url, {
      method: options.method || 'GET',
      headers: chatGptHeaders(accessToken, options.accountId, targetPath, targetRoute, options.headers || {}),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || OPENAI_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
    const detail = payload && typeof payload === 'object' ? payload.detail || payload.error || payload.message : '';
    return { ok: response.ok, status: response.status, payload, latencyMs: Date.now() - started, message: response.ok ? 'ok' : String(detail || `http_${response.status}`), location: response.headers.get('location') };
  } catch (error) {
    return { ok: false, status: 0, payload: {}, latencyMs: Date.now() - started, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

function readWindow(source) {
  if (!source || typeof source !== 'object') return { usedPercent: null, resetAfterSeconds: null };
  const used = Number(source.used_percent ?? source.usedPercent ?? source.used_percentage);
  const reset = Number(source.reset_after_seconds ?? source.resetAfterSeconds ?? source.reset_seconds);
  const resetAt = source.reset_at ?? source.resetAt ?? source.reset_time;
  return {
    usedPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
    resetAfterSeconds: Number.isFinite(reset) ? reset : null,
    resetAt: typeof resetAt === 'string' ? resetAt : null,
    windowMinutes: Number.isFinite(Number(source.window_minutes ?? source.windowMinutes)) ? Number(source.window_minutes ?? source.windowMinutes) : null,
  };
}

function quotaFromExtra(extra = {}) {
  const primary = readWindow({
    used_percent: extra.codex_5h_used_percent ?? extra.codex_primary_used_percent,
    reset_after_seconds: extra.codex_5h_reset_after_seconds ?? extra.codex_primary_reset_after_seconds,
    reset_at: extra.codex_5h_reset_at,
    window_minutes: extra.codex_5h_window_minutes ?? extra.codex_primary_window_minutes,
  });
  const secondary = readWindow({
    used_percent: extra.codex_7d_used_percent ?? extra.codex_secondary_used_percent,
    reset_after_seconds: extra.codex_7d_reset_after_seconds ?? extra.codex_secondary_reset_after_seconds,
    reset_at: extra.codex_7d_reset_at,
    window_minutes: extra.codex_7d_window_minutes ?? extra.codex_secondary_window_minutes,
  });
  return {
    quota5h: primary.usedPercent == null ? null : Math.max(0, Math.round(100 - primary.usedPercent)),
    quota7d: secondary.usedPercent == null ? null : Math.max(0, Math.round(100 - secondary.usedPercent)),
    quotaSnapshot: { primary, secondary, source: 'sub2api-extra', updatedAt: extra.codex_usage_updated_at || null },
  };
}

function quotaSnapshotFromInput(input, extra, derived) {
  if (input.quotaSnapshot && typeof input.quotaSnapshot === 'object') return input.quotaSnapshot;
  const primary = { ...(derived.primary || {}) };
  const secondary = { ...(derived.secondary || {}) };
  if (primary.usedPercent == null && input.quota5h != null && Number.isFinite(Number(input.quota5h))) primary.usedPercent = Math.max(0, Math.min(100, 100 - Number(input.quota5h)));
  if (secondary.usedPercent == null && input.quota7d != null && Number.isFinite(Number(input.quota7d))) secondary.usedPercent = Math.max(0, Math.min(100, 100 - Number(input.quota7d)));
  if (primary.resetAfterSeconds == null && Number.isFinite(Number(input.quota5hResetAfterSeconds))) primary.resetAfterSeconds = Number(input.quota5hResetAfterSeconds);
  if (secondary.resetAfterSeconds == null && Number.isFinite(Number(input.quota7dResetAfterSeconds))) secondary.resetAfterSeconds = Number(input.quota7dResetAfterSeconds);
  if (primary.resetAt == null && input.quota5hResetAt) primary.resetAt = input.quota5hResetAt;
  if (secondary.resetAt == null && input.quota7dResetAt) secondary.resetAt = input.quota7dResetAt;
  return {
    primary,
    secondary,
    source: Object.keys(extra || {}).length ? 'sub2api-extra' : 'import',
    updatedAt: input.quotaUpdatedAt || extra?.codex_usage_updated_at || derived.quotaSnapshot?.updatedAt || null,
  };
}

function credentialFields(input = {}) {
  const credentials = input.credentials && typeof input.credentials === 'object' ? input.credentials : input;
  const extra = input.extra && typeof input.extra === 'object'
    ? input.extra
    : credentials.extra && typeof credentials.extra === 'object' ? credentials.extra : {};
  const accessToken = credentials.access_token || credentials.accessToken || input.accessToken || input.token || '';
  const refreshToken = credentials.refresh_token || credentials.refreshToken || input.refreshToken || '';
  const accountId = credentials.chatgpt_account_id || credentials.chatgptAccountId || input.accountId || input.workspaceId || '';
  const email = input.email || credentials.email || extra.email || '';
  const planType = credentials.plan_type || credentials.planType || input.planType || input.plan || '';
  const derivedSnapshot = quotaFromExtra(extra);
  const snapshot = quotaSnapshotFromInput(input, extra, derivedSnapshot);
  return {
    accessToken,
    refreshToken,
    accountId,
    email: String(email),
    planType,
    chatgptUserId: credentials.chatgpt_user_id || credentials.chatgptUserId || '',
    clientId: credentials.client_id || credentials.clientId || '',
    idToken: credentials.id_token || credentials.idToken || '',
    organizationId: credentials.organization_id || credentials.organizationId || '',
    modelMapping: credentials.model_mapping || credentials.modelMapping || null,
    concurrency: input.concurrency ?? credentials.concurrency ?? null,
    priority: input.priority ?? credentials.priority ?? null,
    rateMultiplier: input.rate_multiplier ?? input.rateMultiplier ?? credentials.rate_multiplier ?? credentials.rateMultiplier ?? null,
    autoPauseOnExpired: input.auto_pause_on_expired ?? input.autoPauseOnExpired ?? credentials.auto_pause_on_expired ?? credentials.autoPauseOnExpired ?? null,
    password: credentials.password || credentials.pass || input.password || '',
    totp: credentials.totp || credentials.two_factor_secret || credentials.twoFactorSecret || input.totp || input.twoFactorSecret || '',
    mailboxUrl: credentials.mailbox_url || credentials.mailboxUrl || input.mailboxUrl || input.mailbox_url || '',
    expiresAt: credentials.expires_at || credentials.expiresAt || null,
    subscriptionExpiresAt: credentials.subscription_expires_at || credentials.subscriptionExpiresAt || null,
    extra,
    ...derivedSnapshot,
    quotaSnapshot: snapshot,
    quota5h: input.quota5h ?? derivedSnapshot.quota5h,
    quota7d: input.quota7d ?? derivedSnapshot.quota7d,
    quota5hResetAfterSeconds: input.quota5hResetAfterSeconds ?? extra.codex_5h_reset_after_seconds ?? null,
    quota7dResetAfterSeconds: input.quota7dResetAfterSeconds ?? extra.codex_7d_reset_after_seconds ?? null,
    quota5hResetAt: input.quota5hResetAt ?? extra.codex_5h_reset_at ?? null,
    quota7dResetAt: input.quota7dResetAt ?? extra.codex_7d_reset_at ?? null,
    quotaUpdatedAt: input.quotaUpdatedAt ?? extra.codex_usage_updated_at ?? snapshot.updatedAt ?? null,
  };
}

function splitCredentialLine(value) {
  const line = String(value || '').trim();
  if (!line) return [];
  const delimiter = line.includes('----') ? '----' : line.includes('|') ? '|' : line.includes(',') ? ',' : null;
  return delimiter ? line.split(delimiter).map((part) => part.trim()) : [line];
}

function childFromImportedAccount(item) {
  const fields = credentialFields(item);
  const history = Array.isArray(item.workspaceHistory) ? item.workspaceHistory : [];
  const token = fields.accessToken ? preview(fields.accessToken) : '待登录获取 AT';
  const initialStatus = item.status || (fields.accessToken ? 'ready' : fields.password ? 'login_required' : 'unconfigured');
  return {
    id: item.id || `child_${randomUUID().slice(0, 8)}`,
    email: fields.email,
    password: fields.password,
    totp: fields.totp,
    mailboxUrl: fields.mailboxUrl,
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    accountId: fields.accountId,
    chatgptUserId: fields.chatgptUserId,
    clientId: fields.clientId,
    idToken: fields.idToken,
    organizationId: fields.organizationId,
    modelMapping: fields.modelMapping,
    concurrency: fields.concurrency,
    priority: fields.priority,
    rateMultiplier: fields.rateMultiplier,
    autoPauseOnExpired: fields.autoPauseOnExpired,
    expiresAt: fields.expiresAt,
    subscriptionExpiresAt: fields.subscriptionExpiresAt,
    plan: fields.planType || '待检测',
    tokenScope: 'free',
    token,
    status: initialStatus,
    quota5h: fields.quota5h,
    quota7d: fields.quota7d,
    quotaSnapshot: fields.quotaSnapshot,
    quota5hResetAfterSeconds: fields.quota5hResetAfterSeconds,
    quota7dResetAfterSeconds: fields.quota7dResetAfterSeconds,
    quota5hResetAt: fields.quota5hResetAt,
    quota7dResetAt: fields.quota7dResetAt,
    quotaUpdatedAt: fields.quotaUpdatedAt,
    extra: fields.extra,
    team: item.team || null,
    joinedAt: item.joinedAt || null,
    nextRetry: item.nextRetry || null,
    workspaceHistory: history,
    importSource: item.source || item.importSource || null,
    sub2apiImported: Boolean(item.sub2apiImported || item.source === 'sub2api' || item.importSource === 'sub2api'),
    createdAt: item.createdAt || now(),
    importedAt: now(),
  };
}

function singleSub2ApiAccount(input = {}) {
  let candidate = input?.json ?? input?.account ?? input;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: 'invalid_sub2api_json' };
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, message: 'invalid_sub2api_account' };
  if (candidate.account !== undefined) candidate = candidate.account;
  if (Array.isArray(candidate?.accounts)) {
    if (candidate.accounts.length !== 1) return { ok: false, message: 'single_sub2api_account_required' };
    candidate = candidate.accounts[0];
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, message: 'invalid_sub2api_account' };
  return { ok: true, account: candidate };
}

function childHasActiveTeamMembership(child) {
  const history = Array.isArray(child?.workspaceHistory) ? child.workspaceHistory : [];
  if (history.some((entry) => entry?.team && entry.status === 'active')) return true;
  if (!child?.team) return false;
  return !history.some((entry) => entry?.team === child.team && ['kicked', 'cooldown'].includes(entry.status));
}

function applyFreeSub2ApiAccount(child, account, fields = credentialFields(account)) {
  const imported = childFromImportedAccount({
    ...account,
    id: child.id,
    planType: fields.planType || 'free',
    source: 'sub2api',
    sub2apiImported: true,
    team: child.team || null,
    workspaceHistory: child.workspaceHistory || [],
  });
  const credentialKeys = [
    'password', 'totp', 'mailboxUrl', 'accessToken', 'refreshToken', 'accountId', 'chatgptUserId',
    'clientId', 'idToken', 'organizationId', 'modelMapping', 'concurrency', 'priority', 'rateMultiplier',
    'autoPauseOnExpired', 'expiresAt', 'subscriptionExpiresAt', 'quota5h', 'quota7d', 'quotaSnapshot',
    'quota5hResetAfterSeconds', 'quota7dResetAfterSeconds', 'quota5hResetAt', 'quota7dResetAt', 'quotaUpdatedAt',
  ];
  for (const key of credentialKeys) {
    const value = imported[key];
    if (value !== '' && value !== null && value !== undefined) child[key] = value;
  }
  if (fields.email) child.email = fields.email;
  if (fields.extra && Object.keys(fields.extra).length) child.extra = { ...(child.extra || {}), ...fields.extra };
  child.plan = fields.planType || (child.plan && child.plan !== '待检测' ? child.plan : 'free');
  child.tokenScope = 'free';
  child.token = child.accessToken ? preview(child.accessToken) : child.token || '待登录获取 AT';
  child.importSource = 'sub2api';
  child.sub2apiImported = true;
  child.importedAt = now();
  child.authAt = now();
  child.status = child.team ? 'active' : 'ready';
  setChildLoginState(child, 'ready', '已录入 Sub2API Free JSON');
}

function ownerAccountFromImportedAccount(item) {
  const fields = credentialFields(item);
  return {
    email: fields.email,
    name: item.name || fields.email || '',
    password: fields.password,
    totp: fields.totp,
    mailboxUrl: fields.mailboxUrl,
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    accountId: fields.accountId,
    chatgptUserId: fields.chatgptUserId,
    clientId: fields.clientId,
    idToken: fields.idToken,
    organizationId: fields.organizationId,
    modelMapping: fields.modelMapping,
    expiresAt: fields.expiresAt,
    subscriptionExpiresAt: fields.subscriptionExpiresAt,
    planType: fields.planType || 'team',
    tokenScope: 'team',
    quota5h: fields.quota5h,
    quota7d: fields.quota7d,
    quotaSnapshot: fields.quotaSnapshot,
    quota5hResetAfterSeconds: fields.quota5hResetAfterSeconds,
    quota7dResetAfterSeconds: fields.quota7dResetAfterSeconds,
    quota5hResetAt: fields.quota5hResetAt,
    quota7dResetAt: fields.quota7dResetAt,
    quotaUpdatedAt: fields.quotaUpdatedAt,
    extra: fields.extra,
  };
}

function motherFromImportedAccount(item) {
  const fields = credentialFields(item);
  return {
    id: item.id || `mother_${randomUUID().slice(0, 8)}`,
    email: fields.email,
    name: item.name || fields.email || '未命名母号',
    password: fields.password,
    totp: fields.totp,
    mailboxUrl: fields.mailboxUrl,
    team: item.team || item.workspaceName || fields.accountId || '',
    teamName: item.teamName || item.displayName || item.workspaceName || item.workspace_name || '',
    rotationMode: item.rotationMode === 'rotating' ? 'rotating' : 'fixed',
    primaryOwnerEmail: item.primaryOwnerEmail || item.primary_owner_email || fields.email || '',
    seats: item.seats == null ? null : Number(item.seats),
    used: item.used == null ? null : Number(item.used),
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    accountId: fields.accountId,
    chatgptUserId: fields.chatgptUserId,
    clientId: fields.clientId,
    idToken: fields.idToken,
    organizationId: fields.organizationId,
    modelMapping: fields.modelMapping,
    subscriptionExpiresAt: fields.subscriptionExpiresAt,
    expiresAt: fields.expiresAt,
    planType: fields.planType || null,
    tokenScope: 'team',
    quotaSnapshot: fields.quotaSnapshot,
    extra: fields.extra,
    ownerAccounts: [ownerAccountFromImportedAccount(item)],
    status: fields.accessToken ? 'unconfigured' : 'unconfigured',
    lastCheck: null,
    createdAt: item.createdAt || now(),
  };
}

async function probeUsage(accessToken, accountId) {
  if (!accessToken) return { ok: false, status: 0, message: 'missing_token', primary: readWindow(), secondary: readWindow() };
  const started = Date.now();
  try {
    const response = await proxyFetch(`${CHATGPT_BASE_URL}/backend-api/wham/usage`, { headers: chatGptHeaders(accessToken, accountId, '/backend-api/wham/usage', '/backend-api/wham/usage'), signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS) });
    const payload = await response.json().catch(() => ({}));
    const limit = payload.rate_limit || payload.rateLimit || payload;
    return { ok: response.ok, status: response.status, message: response.ok ? 'ok' : (payload.detail || payload.error || `http_${response.status}`), latencyMs: Date.now() - started, planType: payload.plan_type || payload.planType, limitReached: Boolean(limit.limit_reached ?? limit.limitReached), primary: readWindow(limit.primary_window || limit.primaryWindow), secondary: readWindow(limit.secondary_window || limit.secondaryWindow), source: 'wham/usage' };
  } catch (error) {
    return { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', latencyMs: Date.now() - started, primary: readWindow(), secondary: readWindow() };
  }
}

function normalizeSubscription(payload, accountId) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const capacities = Array.isArray(record.seat_capacity) ? record.seat_capacity : Array.isArray(record.seatCapacity) ? record.seatCapacity : [];
  const seatsInUse = Number(record.seats_in_use ?? record.seatsInUse);
  const seatsEntitled = Number(record.seats_entitled ?? record.seatsEntitled);
  const entitledFromCapacity = capacities.reduce((sum, entry) => sum + (Number(entry?.paid) || 0), 0);
  return {
    id: record.id || accountId || null,
    planType: record.plan_type || record.planType || null,
    seatsInUse: Number.isFinite(seatsInUse) ? seatsInUse : null,
    seatsEntitled: Number.isFinite(seatsEntitled) ? seatsEntitled : (entitledFromCapacity || null),
    seatCapacity: capacities,
    assigned: record.assigned && typeof record.assigned === 'object' ? record.assigned : {},
    activeStart: record.active_start || record.activeStart || null,
    activeUntil: record.active_until || record.activeUntil || null,
    billingPeriod: record.billing_period || record.billingPeriod || null,
    willRenew: typeof record.will_renew === 'boolean' ? record.will_renew : record.willRenew ?? null,
    isDelinquent: typeof record.is_delinquent === 'boolean' ? record.is_delinquent : record.isDelinquent ?? null,
    fetchedAt: now(),
  };
}

function normalizeMember(value) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    id: record.id || record.user_id || record.account_user_id || null,
    accountUserId: record.account_user_id || record.accountUserId || null,
    email: record.email || record.email_address || null,
    verifiedEmail: record.verified_email || record.verifiedEmail || null,
    role: record.role || null,
    seatType: record.seat_type || record.seatType || null,
    creditLimits: record.credit_limits || record.creditLimits || null,
    name: record.name || record.full_name || null,
    createdTime: record.created_time || record.createdTime || null,
    isScimManaged: record.is_scim_managed ?? record.isScimManaged ?? null,
    creationSource: record.creation_source || record.creationSource || null,
    deactivatedTime: record.deactivated_time || record.deactivatedTime || null,
    pendingSeatType: record.pending_seat_type || record.pendingSeatType || null,
    reclaimableSeatType: record.reclaimable_seat_type || record.reclaimableSeatType || null,
  };
}

function memberIsActive(member) {
  return Boolean((member?.email || member?.id || member?.accountUserId) && !member.deactivatedTime);
}

function memberIsOwner(member, mother) {
  const role = String(member?.role || '').toLowerCase().replace(/[\s_]+/g, '-');
  const email = String(member?.email || '').toLowerCase();
  const motherEmail = String(mother?.email || '').toLowerCase();
  return (Boolean(email && motherEmail) && email === motherEmail) || role === 'owner' || role === 'account-owner';
}

function workspaceMemberCount(mother, fallback = 1) {
  const count = Array.isArray(mother?.members) ? mother.members.filter(memberIsActive).length : 0;
  return count || Math.max(1, Number(fallback) || 1);
}

function memberIsProtected(member, mother) {
  const role = String(member?.role || '').toLowerCase().replace(/[\s_]+/g, '-');
  const email = String(member?.email || '').toLowerCase();
  if (mother?.rotationMode === 'fixed') {
    const primaryEmail = String(mother.primaryOwnerEmail || mother.email || '').toLowerCase();
    const primaryOwner = primaryOwnerRecord(mother);
    const primaryUserId = String(primaryOwner?.chatgptUserId || mother.chatgptUserId || '');
    if (primaryEmail && email === primaryEmail) return true;
    if (primaryUserId && String(member?.id || '') === primaryUserId) return true;
  }
  // Some Team responses label every seat as account-owner; only protect an
  // unidentified owner when there is no usable identity to match.
  return !email && (role === 'account-owner' || role === 'owner');
}

async function queryWorkspaceMembersPage(mother, { offset = 0, limit = 25, query = '' } = {}) {
  if (!mother?.accountId) return { ok: false, status: 400, message: 'workspace_id_required', items: [], total: 0, offset, limit };
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const params = new URLSearchParams({ offset: String(safeOffset), limit: String(safeLimit), query: String(query || '') });
  const accountId = encodeURIComponent(mother.accountId);
  const requestPath = `/backend-api/accounts/${accountId}/users?${params}`;
  const attempted = await withTeamManager(mother, (manager) => fetchChatGptJson(manager.accessToken, requestPath, {
    accountId: mother.accountId,
    targetPath: `/backend-api/accounts/${mother.accountId}/users`,
    targetRoute: '/backend-api/accounts/{account_id}/users',
    headers: { ...(manager.deviceId ? { 'oai-device-id': manager.deviceId } : {}), ...(manager.cookie ? { cookie: manager.cookie } : {}) },
  }));
  if (!attempted?.result) return { ok: false, status: 401, message: 'workspace_owner_token_required', items: [], total: 0, offset: safeOffset, limit: safeLimit };
  const result = attempted.result;
  const record = result.payload && typeof result.payload === 'object' ? result.payload : {};
  const items = Array.isArray(record.items) ? record.items.map(normalizeMember).filter((item) => item.id || item.email) : [];
  return { ...result, accountId: mother.accountId, items, total: Number.isFinite(Number(record.total)) ? Number(record.total) : items.length, offset: Number(record.offset ?? safeOffset), limit: Number(record.limit ?? safeLimit) };
}

async function queryAllWorkspaceMembers(mother, query = '') {
  const members = [];
  const seen = new Set();
  let offset = 0;
  const pageLimit = 100;
  for (let page = 0; page < 200; page += 1) {
    const result = await queryWorkspaceMembersPage(mother, { offset, limit: pageLimit, query });
    if (!result.ok) return { ...result, items: members, total: members.length };
    for (const member of result.items) {
      const key = member.id || `${member.email || ''}:${member.createdTime || ''}`;
      if (!seen.has(key)) { seen.add(key); members.push(member); }
    }
    if (!result.items.length || (result.total > 0 && offset + result.items.length >= result.total)) break;
    offset += Math.max(1, result.items.length);
  }
  return { ok: true, status: 200, message: 'ok', accountId: mother.accountId, items: members, total: members.length, offset: 0, limit: pageLimit };
}

async function queryWorkspaceSubscription(mother) {
  if (!mother?.accountId) return { ok: false, status: 400, message: 'workspace_id_required', subscription: null };
  const accountId = encodeURIComponent(mother.accountId);
  const requestPath = `/backend-api/subscriptions?account_id=${accountId}`;
  const attempted = await withTeamManager(mother, (manager) => fetchChatGptJson(manager.accessToken, requestPath, {
    accountId: mother.accountId,
    targetPath: '/backend-api/subscriptions',
    targetRoute: '/backend-api/subscriptions',
    headers: { ...(manager.deviceId ? { 'oai-device-id': manager.deviceId } : {}), ...(manager.cookie ? { cookie: manager.cookie } : {}) },
  }));
  if (!attempted?.result) return { ok: false, status: 401, message: 'workspace_owner_token_required', subscription: null };
  const result = attempted.result;
  return { ...result, accountId: mother.accountId, subscription: result.ok ? normalizeSubscription(result.payload, mother.accountId) : null };
}

async function syncMotherWorkspace(mother, { query = '', force = false } = {}) {
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  if (!teamManagerContext(mother)) await recoverTeamManagerToken(mother);
  let [subscriptionResult, membersResult] = await Promise.all([
    queryWorkspaceSubscription(mother),
    queryAllWorkspaceMembers(mother, query),
  ]);
  if ([subscriptionResult.status, membersResult.status].some((status) => [401, 403].includes(Number(status)))) {
    const recovered = await recoverTeamManagerToken(mother, { force: true });
    if (recovered.ok) {
      [subscriptionResult, membersResult] = await Promise.all([
        queryWorkspaceSubscription(mother),
        queryAllWorkspaceMembers(mother, query),
      ]);
    }
  }
  const subscription = subscriptionResult.subscription;
  const members = membersResult.items || [];
  mother.lastWorkspaceSyncAt = now();
  mother.lastSubscriptionProbe = { ok: subscriptionResult.ok, status: subscriptionResult.status, message: subscriptionResult.message, latencyMs: subscriptionResult.latencyMs };
  mother.lastMembersProbe = { ok: membersResult.ok, status: membersResult.status, message: membersResult.message, latencyMs: membersResult.latencyMs, total: members.length };
  if (subscription) {
    mother.subscription = subscription;
    mother.seatSnapshot = subscription;
    mother.seats = subscription.seatsEntitled;
    mother.used = subscription.seatsInUse;
  }
  if (membersResult.ok) mother.members = members;
  const activeMembers = members.filter(memberIsActive);
  for (const child of state.children) {
    const member = activeMembers.find((entry) => entry.email && child.email && entry.email.toLowerCase() === child.email.toLowerCase());
    if (member && !memberIsProtected(member, mother)) {
      child.accountUserId = member.accountUserId || child.accountUserId;
      child.memberId = member.id || child.memberId;
      child.memberSnapshot = member;
      if (child.status !== 'kicked') {
        const membership = membershipFor(child, mother.team, true);
        membership.joinedAt = membership.joinedAt || now();
        membership.source = membership.source || 'member_sync';
        membership.role = member.role || membership.role || null;
        // `team` remains a current-space convenience field; history holds all active memberships.
        child.team = child.team || mother.team;
        child.joinedAt = child.joinedAt || membership.joinedAt;
        child.status = child.accessToken ? 'active' : 'ready';
      }
    }
  }
  addHistory('同步空间', `${mother.team || mother.accountId} 席位 ${mother.used ?? '-'} / ${mother.seats ?? '-'}，成员 ${members.length}`);
  await persist();
  return { ok: subscriptionResult.ok && membersResult.ok, status: subscriptionResult.ok && membersResult.ok ? 200 : (subscriptionResult.status || membersResult.status || 502), motherId: mother.id, accountId: mother.accountId, subscription: subscription || null, seatSnapshot: mother.seatSnapshot || null, members, subscriptionResult: { ok: subscriptionResult.ok, status: subscriptionResult.status, message: subscriptionResult.message }, membersResult: { ok: membersResult.ok, status: membersResult.status, message: membersResult.message } };
}

async function removeWorkspaceMember(mother, member) {
  if (!mother?.accountId || !member?.id) return { ok: false, status: 400, message: 'workspace_member_credentials_required' };
  const accountId = encodeURIComponent(mother.accountId);
  const memberId = encodeURIComponent(member.id);
  const attempted = await withTeamManager(mother, (manager) => fetchChatGptJson(manager.accessToken, `/backend-api/accounts/${accountId}/users/${memberId}`, {
    method: 'DELETE',
    accountId: mother.accountId,
    targetPath: `/backend-api/accounts/${mother.accountId}/users/${member.id}`,
    targetRoute: '/backend-api/accounts/{account_id}/users/{user_id}',
    headers: { ...(manager.deviceId ? { 'oai-device-id': manager.deviceId } : {}), ...(manager.cookie ? { cookie: manager.cookie } : {}) },
  }));
  if (!attempted?.result) return { ok: false, status: 401, message: 'workspace_owner_token_required' };
  const result = attempted.result;
  return { ok: result.ok && result.payload?.success !== false, status: result.status, message: result.message, payload: result.payload };
}

async function setWorkspaceMemberRole(mother, workspaceId, memberId, role = 'account-owner') {
  if (!workspaceId || !memberId) return { ok: false, status: 400, message: 'workspace_member_credentials_required' };
  const accountId = encodeURIComponent(workspaceId);
  const userId = encodeURIComponent(memberId);
  const attempted = await withTeamManager(mother, (manager) => fetchChatGptJson(manager.accessToken, `/backend-api/accounts/${accountId}/users/${userId}`, {
    method: 'PATCH',
    accountId: workspaceId,
    targetPath: `/backend-api/accounts/${workspaceId}/users/${memberId}`,
    targetRoute: '/backend-api/accounts/{account_id}/users/{user_id}',
    body: { role },
    headers: {
      'content-type': 'application/json',
      'x-openai-account-user-update-source': 'web_members_table',
      ...(manager.deviceId ? { 'oai-device-id': manager.deviceId } : {}),
      ...(manager.cookie ? { cookie: manager.cookie } : {}),
    },
  }));
  if (!attempted?.result) return { ok: false, status: 401, message: 'workspace_owner_token_required' };
  const result = attempted.result;
  return { ok: result.ok && result.payload?.success !== false, status: result.status, message: result.message, payload: result.payload };
}

async function promoteJoinedMemberToOwner(mother, child, workspaceId) {
  const email = String(child?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, status: 400, message: 'member_email_required' };
  let member = null;
  let membersResult = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    membersResult = await queryAllWorkspaceMembers(mother, child.email);
    member = (membersResult.items || []).filter(memberIsActive).find((item) => String(item.email || '').trim().toLowerCase() === email);
    if (member?.id || !membersResult.ok) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!membersResult?.ok) return { ok: false, status: membersResult?.status || 502, message: membersResult?.message || 'member_lookup_failed' };
  if (!member?.id) return { ok: false, status: 202, message: 'membership_not_visible_after_approval' };

  child.accountUserId = member.accountUserId || child.accountUserId;
  child.memberId = member.id;
  child.memberSnapshot = member;
  child.status = 'active';
  child.team = mother.team;
  child.joinedAt = child.joinedAt || now();
  const membership = membershipFor(child, mother.team, true);
  membership.role = member.role || membership.role || null;
  membership.memberId = member.id;

  const updated = await setWorkspaceMemberRole(mother, workspaceId, member.id, 'account-owner');
  if (!updated.ok) return { ...updated, memberId: member.id };

  const ownerMember = { ...member, role: 'account-owner' };
  const memberIndex = (mother.members || []).findIndex((item) => item.id === member.id || (item.email && item.email.toLowerCase() === email));
  if (memberIndex >= 0) mother.members[memberIndex] = ownerMember;
  else mother.members = [...(mother.members || []), ownerMember];
  child.accountUserId = ownerMember.accountUserId || child.accountUserId;
  child.memberId = ownerMember.id;
  child.memberSnapshot = ownerMember;
  membership.role = 'account-owner';
  membership.memberId = ownerMember.id;
  return { ok: true, status: updated.status, message: 'owner_role_confirmed', member: ownerMember, payload: updated.payload };
}

function accessTokenFromSessionPayload(payload) {
  const candidates = [
    payload,
    payload?.session,
    payload?.data,
    payload?.data?.session,
    payload?.user,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of ['access_token', 'accessToken', 'token']) {
      const token = String(candidate[key] || '').trim();
      if (token) return token;
    }
  }
  return '';
}

function childIsWorkspaceOwner(child, mother) {
  const membership = membershipFor(child, mother?.team);
  return child?.ownerRoleStatus === 'applied'
    || membership?.role === 'account-owner'
    || memberIsOwner(child?.memberSnapshot, mother);
}

function childMatchesKnownTeamOwner(child, mother) {
  const email = String(child?.email || '').trim().toLowerCase();
  if (!email || !mother) return false;
  return [mother, ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts : [])]
    .some((owner) => String(owner?.email || '').trim().toLowerCase() === email);
}

function upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken) {
  if (!mother || !child?.email || !workspaceToken?.accessToken) return null;
  if (!Array.isArray(mother.ownerAccounts)) mother.ownerAccounts = [];
  const target = child.email.toLowerCase();
  const index = mother.ownerAccounts.findIndex((owner) => String(owner?.email || '').toLowerCase() === target);
  const existing = index >= 0 ? mother.ownerAccounts[index] : {};
  const membership = membershipFor(child, mother.team);
  const next = {
    ...existing,
    email: child.email,
    name: child.name || existing.name || child.email,
    accessToken: workspaceToken.accessToken,
    refreshToken: child.refreshToken || existing.refreshToken || '',
    idToken: child.idToken || existing.idToken || '',
    clientId: child.clientId || existing.clientId || '',
    chatgptUserId: workspaceToken.userId || child.chatgptUserId || existing.chatgptUserId || '',
    accountId: workspaceId,
    team: mother.team || workspaceId,
    plan: 'team',
    planType: 'team',
    tokenScope: 'team',
    expiresAt: workspaceToken.expiresAt || existing.expiresAt || null,
    quota5h: membership?.quota5h ?? existing.quota5h ?? null,
    quota7d: membership?.quota7d ?? existing.quota7d ?? null,
    quotaSnapshot: membership?.quotaSnapshot || existing.quotaSnapshot || null,
    quotaUpdatedAt: membership?.quotaUpdatedAt || existing.quotaUpdatedAt || null,
    linkedFreeAccountId: child.id,
    workspaceTokenUpdatedAt: workspaceToken.acquiredAt || now(),
  };
  if (index >= 0) mother.ownerAccounts[index] = next;
  else mother.ownerAccounts.push(next);
  return next;
}

function removeTeamOwnerForChild(mother, child) {
  if (!mother || !child?.email || !Array.isArray(mother.ownerAccounts)) return;
  const email = child.email.toLowerCase();
  const primaryOwner = String(mother.email || '').toLowerCase();
  mother.ownerAccounts = mother.ownerAccounts.filter((owner) => {
    const ownerEmail = String(owner?.email || '').toLowerCase();
    if (ownerEmail !== email) return true;
    return ownerEmail === primaryOwner;
  });
}

async function probeMother(mother) {
  const attempted = await withTeamManager(mother, (manager) => probeUsage(manager.accessToken, mother.accountId));
  const result = attempted?.result || await probeUsage('', mother.accountId);
  mother.lastCheck = now();
  mother.lastProbe = result;
  mother.status = result.ok ? 'online' : result.message === 'missing_token' ? 'unconfigured' : 'offline';
  const workspace = await syncMotherWorkspace(mother, { force: true });
  result.seatSnapshot = workspace.seatSnapshot;
  result.members = workspace.members;
  result.subscriptionOk = workspace.subscriptionResult?.ok || false;
  result.membersOk = workspace.membersResult?.ok || false;
  return result;
}

function selectedKickWindow(mother = null) {
  // Rotating spaces use the long window so a seat is only replaced after its
  // weekly allowance is exhausted. Fixed spaces follow the global setting.
  if (mother?.rotationMode === 'rotating') return '7d';
  return state.settings?.kickWindow === '7d' ? '7d' : '5h';
}

function quotaIsExhausted(child, result, window = selectedKickWindow()) {
  const selected = window === '7d' ? result?.secondary : result?.primary;
  return Boolean(result?.ok && selected?.usedPercent != null && selected.usedPercent >= 99.99);
}

function quotaRetryAfter(child, window = selectedKickWindow(), teamId = null) {
  const membership = teamId ? latestMembershipHistoryFor(child, teamId) : null;
  const resetAt = window === '7d'
    ? (membership?.quota7dResetAt || (child.team === teamId ? child.quota7dResetAt : null))
    : (membership?.quota5hResetAt || (child.team === teamId ? child.quota5hResetAt : null));
  const resetTimes = [resetAt]
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value) && value > Date.now());
  if (!resetTimes.length) return null;
  return new Date(resetTimes[0]).toISOString();
}

function quotaKickReason(child, window = selectedKickWindow()) {
  return window === '7d' ? 'quota_7d' : 'quota_5h';
}

function membershipQuotaIsExhausted(child, teamId, window = selectedKickWindow()) {
  const membership = latestMembershipHistoryFor(child, teamId);
  if (!membership) return false;
  if (membership.quotaStatus === 'exhausted' && membership.quotaStatusWindow === window) return true;
  return quotaIsExhausted(child, membership.lastProbe, window);
}

function applyQuotaResult(child, result, teamId = null, window = selectedKickWindow(), { createMembership = false } = {}) {
  child.lastQuotaCheckAt = now();
  const shouldUpdateAccount = !teamId || child.team === teamId;
  if (shouldUpdateAccount) child.lastProbe = result;
  const hasPrimaryQuota = result.primary?.usedPercent != null;
  const hasSecondaryQuota = result.secondary?.usedPercent != null;
  const hasMeasuredQuota = hasPrimaryQuota || hasSecondaryQuota;
  const membership = teamId ? membershipFor(child, teamId, createMembership) : null;
  const previousSnapshot = child.quotaSnapshot || {};
  const nextSnapshot = hasMeasuredQuota ? {
    primary: hasPrimaryQuota ? result.primary : (previousSnapshot.primary || result.primary || {}),
    secondary: hasSecondaryQuota ? result.secondary : (previousSnapshot.secondary || result.secondary || {}),
    source: result.source || 'wham/usage',
    updatedAt: now(),
  } : previousSnapshot;
  const previousQuota5h = membership?.quota5h ?? (shouldUpdateAccount ? child.quota5h : null);
  const previousQuota7d = membership?.quota7d ?? (shouldUpdateAccount ? child.quota7d : null);
  const nextQuota5h = hasPrimaryQuota ? Math.max(0, Math.round(100 - result.primary.usedPercent)) : previousQuota5h;
  const nextQuota7d = hasSecondaryQuota ? Math.max(0, Math.round(100 - result.secondary.usedPercent)) : previousQuota7d;
  const nextReset5h = result.primary?.resetAfterSeconds != null
    ? result.primary.resetAfterSeconds
    : (membership?.quota5hResetAfterSeconds ?? (shouldUpdateAccount ? child.quota5hResetAfterSeconds : null));
  const nextReset7d = result.secondary?.resetAfterSeconds != null
    ? result.secondary.resetAfterSeconds
    : (membership?.quota7dResetAfterSeconds ?? (shouldUpdateAccount ? child.quota7dResetAfterSeconds : null));
  const nextResetAt5h = result.primary?.resetAt
    || (result.primary?.resetAfterSeconds != null ? new Date(Date.now() + result.primary.resetAfterSeconds * 1000).toISOString() : (membership?.quota5hResetAt || (shouldUpdateAccount ? child.quota5hResetAt : null)));
  const nextResetAt7d = result.secondary?.resetAt
    || (result.secondary?.resetAfterSeconds != null ? new Date(Date.now() + result.secondary.resetAfterSeconds * 1000).toISOString() : (membership?.quota7dResetAt || (shouldUpdateAccount ? child.quota7dResetAt : null)));
  // Keep the account-level values for a direct Free probe or its current Team.
  if (!teamId || child.team === teamId) {
    if (hasPrimaryQuota) child.quota5h = nextQuota5h;
    if (hasSecondaryQuota) child.quota7d = nextQuota7d;
    if (result.primary?.resetAfterSeconds != null) child.quota5hResetAfterSeconds = nextReset5h;
    if (result.secondary?.resetAfterSeconds != null) child.quota7dResetAfterSeconds = nextReset7d;
    if (result.primary?.resetAfterSeconds != null || result.primary?.resetAt) child.quota5hResetAt = nextResetAt5h;
    if (result.secondary?.resetAfterSeconds != null || result.secondary?.resetAt) child.quota7dResetAt = nextResetAt7d;
    if (hasMeasuredQuota) {
      child.quotaSnapshot = nextSnapshot;
      child.quotaUpdatedAt = nextSnapshot.updatedAt;
    }
  }
  if (membership && hasMeasuredQuota) {
    const previousMembershipSnapshot = membership.quotaSnapshot || {};
    membership.quota5h = nextQuota5h;
    membership.quota7d = nextQuota7d;
    membership.quotaSnapshot = {
      primary: hasPrimaryQuota ? result.primary : (previousMembershipSnapshot.primary || result.primary || {}),
      secondary: hasSecondaryQuota ? result.secondary : (previousMembershipSnapshot.secondary || result.secondary || {}),
      source: result.source || 'wham/usage',
      updatedAt: now(),
    };
    membership.quotaUpdatedAt = membership.quotaSnapshot.updatedAt;
    membership.lastProbe = result;
    membership.quota5hResetAfterSeconds = nextReset5h;
    membership.quota7dResetAfterSeconds = nextReset7d;
    if (result.primary?.resetAfterSeconds != null || result.primary?.resetAt) membership.quota5hResetAt = nextResetAt5h;
    if (result.secondary?.resetAfterSeconds != null || result.secondary?.resetAt) membership.quota7dResetAt = nextResetAt7d;
    membership.quotaSource = result.source || 'wham/usage';
    membership.quotaStatus = quotaIsExhausted(child, result, window) ? 'exhausted' : (result.ok ? 'available' : 'unknown');
    membership.quotaStatusWindow = window;
  }
  if (shouldUpdateAccount && quotaIsExhausted(child, result, window)) child.status = 'exhausted';
  else if (shouldUpdateAccount && (result.primary?.usedPercent != null || result.secondary?.usedPercent != null)) {
    const remaining = [membership?.quota5h ?? child.quota5h, membership?.quota7d ?? child.quota7d].filter((value) => value != null);
    child.status = remaining.length && Math.min(...remaining) <= state.settings.threshold ? 'warning' : result.ok ? 'active' : child.status;
  }
}

async function probeChild(child) {
  if (!child) return { ok: false, status: 404, message: 'child_not_found' };
  // Free accounts are only credentials for entering a Team. Their usable quota
  // starts from the Team workspace and must never be probed as a Free account.
  return { ok: false, status: 409, code: 'free_quota_not_tracked', message: 'Free 账号不单独检测额度；请在加入 Team 后检测对应空间额度', id: child.id, email: child.email };
}

function setChildLoginState(child, status, message = '') {
  child.loginStatus = status;
  child.loginMessage = message;
  child.loginAttemptedAt = now();
}

function freeTokenNeedsRefresh(child, skewMs = 30_000) {
  if (!child?.accessToken) return true;
  const claims = accessTokenClaims(child.accessToken);
  const expiresAt = Date.parse(claims.expiresAt || child.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + skewMs;
}

function freeAuthRetryBackoffActive(child) {
  const retryBackoffMs = Math.max(60_000, Number(process.env.FREE_AUTH_RETRY_BACKOFF_MS) || 300_000);
  const lastAttempt = Date.parse(child?.loginAttemptedAt || '');
  return Number.isFinite(lastAttempt)
    && Date.now() - lastAttempt < retryBackoffMs
    && ['login_required', 'credentials_required'].includes(child?.loginStatus);
}

async function ensureChildFreeAuth(child, { forceRefresh = false, verificationCode = '', callbackUrl = '' } = {}) {
  if (!child) return { ok: false, status: 404, code: 'child_not_found', message: 'child_not_found' };
  if (!forceRefresh && !freeTokenNeedsRefresh(child)) {
    return { ok: true, status: 200, source: 'access_token', child: publicChild(child) };
  }
  return acquireChildAuth(child, { refresh: true, allowCredentialLogin: true, verificationCode, callbackUrl });
}

function applyRefreshedChildToken(child, result) {
  const claims = result.claims || accessTokenClaims(result.accessToken);
  child.accessToken = result.accessToken;
  child.refreshToken = result.refreshToken || child.refreshToken;
  child.idToken = result.idToken || child.idToken;
  child.accountId = claims.accountId || child.accountId;
  child.chatgptUserId = claims.userId || child.chatgptUserId;
  child.expiresAt = claims.expiresAt || (result.expiresIn ? new Date(Date.now() + result.expiresIn * 1000).toISOString() : child.expiresAt);
  child.plan = claims.planType || child.plan || '待检测';
  child.token = preview(child.accessToken);
  child.authAt = now();
  child.sub2apiImported = true;
  child.authSession = null;
  child.loginUrl = null;
  child.loginBrowserRequired = false;
  child.status = child.team ? 'active' : 'ready';
  setChildLoginState(child, 'ready', '已通过 refresh token 获取新的 AT');
}

function applyLoggedInChildToken(child, result) {
  const claims = result.claims || accessTokenClaims(result.accessToken);
  child.accessToken = result.accessToken;
  child.refreshToken = result.refreshToken || child.refreshToken;
  child.idToken = result.idToken || child.idToken;
  child.accountId = claims.accountId || child.accountId;
  child.chatgptUserId = claims.userId || child.chatgptUserId;
  child.expiresAt = claims.expiresAt || child.expiresAt;
  child.plan = claims.planType || child.plan || 'free';
  child.token = preview(child.accessToken);
  child.authAt = now();
  child.sub2apiImported = true;
  child.authSession = null;
  child.loginUrl = null;
  child.loginBrowserRequired = false;
  child.status = child.team ? 'active' : 'ready';
  setChildLoginState(child, 'ready', '已完成登录，Free JSON 已生成');
}

async function acquireChildAuth(child, { refresh = false, verificationCode = '', callbackUrl = '', allowCredentialLogin = false } = {}) {
  if (!child) return { ok: false, status: 404, message: 'child_not_found' };
  if (child.accessToken && !refresh && !freeTokenNeedsRefresh(child)) {
    setChildLoginState(child, 'ready', '已有可用 AT');
    await persist();
    return { ok: true, status: 200, source: 'access_token', child: publicChild(child) };
  }
  if (child.accessToken && !refresh && freeTokenNeedsRefresh(child)) refresh = true;
  if (child.refreshToken) {
    setChildLoginState(child, 'refreshing', '正在使用 refresh token 更新 AT');
    await persist();
    const refreshed = await refreshOpenAiAccessToken(child.refreshToken, child.clientId, OPENAI_REQUEST_TIMEOUT_MS, proxyFetch);
    if (refreshed.ok) {
      applyRefreshedChildToken(child, refreshed);
      addHistory('刷新 Free AT', `${child.email} 已通过 refresh token 更新凭据`);
      await persist();
      return { ok: true, status: 200, source: 'refresh_token', child: publicChild(child) };
    }
    setChildLoginState(child, 'login_required', 'refresh token 已失效，需要重新登录获取 AT');
    child.status = 'login_required';
    await persist();
    if (!allowCredentialLogin) {
      return { ok: false, status: refreshed.status || 502, code: 'refresh_failed', message: 'refresh token 已失效，需要重新登录', child: publicChild(child) };
    }
  }
  if (child.accessToken && !allowCredentialLogin && !freeTokenNeedsRefresh(child)) {
    setChildLoginState(child, 'ready', '当前账号已有 AT，但没有可用 refresh token');
    await persist();
    return { ok: true, status: 200, source: 'access_token', child: publicChild(child) };
  }
  if (!child.email || !child.password) {
    setChildLoginState(child, 'credentials_required', '请先填写邮箱和密码');
    await persist();
    return { ok: false, status: 400, code: 'credentials_required', message: '请先填写邮箱和密码', child: publicChild(child) };
  }
  setChildLoginState(child, 'authenticating', '正在使用邮箱、密码和 2FA 登录 OpenAI');
  child.status = 'login_pending';
  child.loginBrowserRequired = false;
  await persist();
  const mailboxConfig = state.settings?.integrations?.mailbox || {};
  const mailboxUrl = child.mailboxUrl || (mailboxConfig.enabled && mailboxConfig.endpoint ? mailboxConfig.endpoint : '');
  const mailboxHeaders = mailboxConfig.apiKey
    ? { authorization: `Bearer ${mailboxConfig.apiKey}`, 'x-api-key': mailboxConfig.apiKey }
    : {};
  const sentinelProxyEntry = state.settings?.proxy?.enabled
    ? (state.settings.proxy.entries || []).find((entry) => entry?.url)
    : null;
  const sentinelProxy = sentinelProxyEntry ? {
    server: `${sentinelProxyEntry.protocol || 'http'}://${sentinelProxyEntry.host}:${sentinelProxyEntry.port}`,
    username: sentinelProxyEntry.username || '',
    password: sentinelProxyEntry.password || '',
  } : null;
  const login = await loginFreeAccount({
    email: child.email,
    password: child.password,
    totp: child.totp || child.secret,
    mailboxUrl,
    mailboxHeaders,
    sentinelProxy,
    verificationCode,
    callbackUrl: callbackUrl || consumeOAuthCallback(child.authSession?.state),
    session: child.authSession,
    workspaceId: '',
    workspaceMode: 'free',
    fetch: proxyFetch,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    onProgress: (phase, message) => setChildLoginState(child, phase, message),
  });
  if (login.ok) {
    applyLoggedInChildToken(child, login);
    addHistory('登录 Free 账号', `${child.email} 已完成登录并生成 AT/RT`);
    await persist();
    return { ok: true, status: 200, code: 'ready', source: 'email_password_2fa', format: 'free-json', child: publicChild(child), exportable: true };
  }
  child.authSession = login.session || child.authSession || null;
  child.loginUrl = login.authUrl || null;
  child.loginBrowserRequired = Boolean(login.browserRequired);
  const waiting = login.code === 'email_otp_required' || login.code === 'email_otp_timeout' || login.code === 'totp_required' || login.code === 'totp_invalid';
  const browserRequired = Boolean(login.browserRequired) || login.code === 'browser_verification_required';
  const status = browserRequired ? 'verification_required' : waiting ? 'waiting_code' : 'login_required';
  const message = browserRequired
    ? '登录需要浏览器验证，请打开授权链接完成验证后重试'
    : login.message || (waiting ? '登录需要验证码，请填写验证码后重试' : '登录失败，请检查凭据或稍后重试');
  setChildLoginState(child, status, message);
  child.status = status === 'waiting_code' || status === 'verification_required' ? 'login_pending' : 'login_required';
  addHistory('登录 Free 账号', `${child.email} ${message}`, 'partial');
  await persist();
  return { ok: false, status: login.status || 202, code: browserRequired ? 'verification_required' : login.code || 'login_failed', message, stage: login.stage, browserRequired, needsInput: login.needsInput, authUrl: login.authUrl || null, child: publicChild(child) };
}

async function acquireTeamAuth(mother, child, { verificationCode = '', callbackUrl = '', force = false } = {}) {
  const workspaceId = String(mother?.accountId || '').trim();
  if (!mother || !child || !workspaceId) return { ok: false, status: 400, code: 'workspace_id_required', message: '请先配置目标 Team ID' };
  const existing = workspaceTokenFor(child, workspaceId);
  if (existing?.accessToken && !force) {
    return { ok: true, status: 200, code: 'ready', source: 'stored_team_token', format: 'team-json', tokenScope: 'team', child: publicChild(child, mother.team) };
  }
  if (!child.email || !child.password) {
    return { ok: false, status: 400, code: 'credentials_required', message: 'Team JSON 生成需要 Free 账号邮箱和密码', child: publicChild(child, mother.team) };
  }
  if (!child.totp && !child.secret) {
    return { ok: false, status: 202, code: 'totp_required', message: 'Team JSON 生成需要 Free 账号 2FA Secret', needsInput: true, child: publicChild(child, mother.team) };
  }
  if (!child.teamAuthSessions || typeof child.teamAuthSessions !== 'object' || Array.isArray(child.teamAuthSessions)) child.teamAuthSessions = {};
  const session = child.teamAuthSessions[workspaceId] || null;
  const mailboxConfig = state.settings?.integrations?.mailbox || {};
  const mailboxUrl = child.mailboxUrl || (mailboxConfig.enabled && mailboxConfig.endpoint ? mailboxConfig.endpoint : '');
  const mailboxHeaders = mailboxConfig.apiKey
    ? { authorization: `Bearer ${mailboxConfig.apiKey}`, 'x-api-key': mailboxConfig.apiKey }
    : {};
  const sentinelProxyEntry = state.settings?.proxy?.enabled
    ? (state.settings.proxy.entries || []).find((entry) => entry?.url)
    : null;
  const sentinelProxy = sentinelProxyEntry ? {
    server: `${sentinelProxyEntry.protocol || 'http'}://${sentinelProxyEntry.host}:${sentinelProxyEntry.port}`,
    username: sentinelProxyEntry.username || '',
    password: sentinelProxyEntry.password || '',
  } : null;
  child.teamLoginStatus = 'authenticating';
  child.teamLoginMessage = `正在通过 OAuth 登录并选择 Team ${workspaceId}`;
  await persist();
  const login = await loginFreeAccount({
    email: child.email,
    password: child.password,
    totp: child.totp || child.secret,
    mailboxUrl,
    mailboxHeaders,
    sentinelProxy,
    verificationCode,
    callbackUrl: callbackUrl || consumeOAuthCallback(session?.state),
    session,
    workspaceId,
    workspaceMode: 'team',
    fetch: proxyFetch,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    onProgress: (phase, message) => { child.teamLoginStatus = phase; child.teamLoginMessage = message; },
  });
  if (!login.ok) {
    child.teamAuthSessions[workspaceId] = login.session || session || null;
    child.teamLoginStatus = login.stage || 'login_required';
    child.teamLoginMessage = login.message || 'Team OAuth 登录失败';
    await persist();
    return {
      ok: false,
      status: login.status || 202,
      code: login.code || 'team_login_failed',
      message: login.message || 'Team OAuth 登录失败',
      stage: login.stage,
      needsInput: Boolean(login.needsInput),
      browserRequired: Boolean(login.browserRequired),
      authUrl: login.authUrl || null,
      child: publicChild(child, mother.team),
    };
  }
  const claims = login.claims || accessTokenClaims(login.accessToken);
  if (claims.accountId !== workspaceId) {
    child.teamLoginStatus = 'login_required';
    child.teamLoginMessage = 'OAuth 登录后返回的空间不是目标 Team';
    await persist();
    return { ok: false, status: 502, code: 'team_workspace_mismatch', message: 'OAuth 登录后未选择目标 Team 空间', accountId: claims.accountId || null, child: publicChild(child, mother.team) };
  }
  child.refreshToken = login.refreshToken || child.refreshToken || '';
  child.idToken = login.idToken || child.idToken || '';
  child.cookies = login.cookies || child.cookies || null;
  const workspaceToken = saveWorkspaceToken(child, workspaceId, login.accessToken, claims);
  delete child.teamAuthSessions[workspaceId];
  child.teamLoginStatus = 'ready';
  child.teamLoginMessage = '已通过 OAuth 登录并生成 Team JSON';
  child.pendingWorkspaceId = null;
  const membership = membershipFor(child, mother.team, true);
  membership.workspaceTokenStatus = 'ready';
  membership.workspaceTokenUpdatedAt = workspaceToken.acquiredAt;
  if (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother)) upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken);
  addHistory('生成 Team JSON', `${child.email} 已通过 OAuth 登录并选择 ${mother.team}`);
  await persist();
  return { ok: true, status: 200, code: 'ready', source: 'oauth_email_password_2fa_team', format: 'team-json', tokenScope: 'team', accountId: workspaceId, expiresAt: workspaceToken.expiresAt, exportable: true, child: publicChild(child, mother.team) };
}

function canAutoPushRenewedTeamJson() {
  const config = state.settings?.integrations?.sub2api || {};
  const groupId = Number(config.groupId);
  return config.enabled === true
    && Boolean(sub2ApiRoot(config.baseUrl))
    && Boolean(config.apiKey)
    && (Number.isFinite(groupId) && groupId > 0 || Boolean(String(config.groupName || '').trim()));
}

async function renewUnauthorizedTeamToken(mother, child) {
  if (!mother?.accountId || !child) return { ok: false, status: 400, message: 'workspace_id_or_child_missing', freeRefreshed: false };
  let switched = await switchWorkspaceWithFreeRecovery(child, mother.accountId, { forceRefreshFirst: Boolean(child.refreshToken) });
  let teamOAuth = null;
  if (!switched.ok && child.email && child.password && (child.totp || child.secret)) {
    teamOAuth = await acquireTeamAuth(mother, child, { force: true });
    if (teamOAuth.ok) switched = { ok: true, status: 200, freeAuth: { attempted: true, ok: true, source: 'email_password_2fa' } };
  }
  const authSource = switched.freeAuth?.source || null;
  const freeRefreshed = authSource === 'refresh_token';
  const credentialLogin = authSource === 'email_password_2fa';
  if (!switched.ok) {
    const failure = teamOAuth || switched;
    return {
      ok: false,
      status: failure.status || 502,
      code: failure.code || 'workspace_token_refresh_failed',
      message: failure.message || 'workspace_token_refresh_failed',
      freeRefreshed,
      credentialLogin,
      credentialLoginAttempted: Boolean(switched.freeAuth?.attempted),
      needsInput: Boolean(failure.needsInput),
      browserRequired: Boolean(failure.browserRequired),
      authUrl: failure.authUrl || null,
    };
  }

  const workspaceToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
  if (!workspaceToken?.accessToken) return { ok: false, status: 502, message: 'renewed_workspace_token_missing', freeRefreshed, credentialLogin };
  if (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother)) {
    upsertTeamOwnerFromChild(mother, child, mother.accountId, workspaceToken);
  }
  addHistory('刷新 Team JSON', `${child.email} 的 ${mother.team} 已${credentialLogin ? '重新登录生成 Free JSON' : freeRefreshed ? '刷新 OAuth 授权' : '使用现有 Free AT'}并重新获取 Team Token`);
  await persist();
  return { ok: true, status: 200, message: 'team_token_renewed', freeRefreshed, credentialLogin, credentialLoginAttempted: Boolean(switched.freeAuth?.attempted) };
}

async function pushRenewedTeamJson(mother) {
  if (!canAutoPushRenewedTeamJson()) {
    return { attempted: false, ok: null, status: null, message: 'sub2api_auto_push_not_configured', pushed: 0, failed: 0 };
  }
  const result = await pushSub2ApiTeams([mother.id]);
  return {
    attempted: true,
    ok: result.ok === true,
    status: result.status || null,
    message: result.message || null,
    pushed: result.pushed?.length || 0,
    failed: result.failed?.length || 0,
  };
}

async function checkTeam(motherId) {
  const mother = findMother(motherId);
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  let managerRecovery = await recoverTeamManagerToken(mother);
  let workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  if (!workspace.ok && [401, 403].includes(Number(workspace.status))) {
    managerRecovery = await recoverTeamManagerToken(mother, { force: true });
    if (managerRecovery.ok) workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  }
  const members = state.children.filter((child) => isChildMemberOfTeam(child, mother.team));
  const kickWindow = selectedKickWindow(mother);
  const results = [];
  let renewedTeamTokens = 0;
  let renewedFreeTokens = 0;
  let reloggedFreeAccounts = 0;
  for (const child of members) {
    const teamOwner = teamOwnerRecords(mother).find((owner) => String(owner.email || '').toLowerCase() === String(child.email || '').toLowerCase());
    const workspaceToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
    const importedOwnerToken = teamTokenDetails(teamOwner?.accessToken, mother.accountId)?.accessToken || '';
    const quotaToken = workspaceToken?.accessToken || importedOwnerToken;
    let result = await probeUsage(quotaToken, mother.accountId);
    let tokenRecovery = null;
    if (result.status === 401 || result.message === 'missing_token') {
      tokenRecovery = await renewUnauthorizedTeamToken(mother, child);
      if (tokenRecovery.ok) {
        renewedTeamTokens += 1;
        if (tokenRecovery.freeRefreshed) renewedFreeTokens += 1;
        if (tokenRecovery.credentialLogin) reloggedFreeAccounts += 1;
        const renewedToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
        result = await probeUsage(renewedToken?.accessToken || '', mother.accountId);
      }
    }
    applyQuotaResult(child, result, mother.team, kickWindow);
    const membership = membershipFor(child, mother.team);
    results.push({ id: child.id, email: child.email, ...result, quotaSource: quotaToken ? 'team' : 'team_token_missing', quota5h: membership?.quota5h ?? null, quota7d: membership?.quota7d ?? null, tokenRecovery: tokenRecovery ? { attempted: true, ok: tokenRecovery.ok, status: tokenRecovery.status, code: tokenRecovery.code || null, message: tokenRecovery.message, freeRefreshed: tokenRecovery.freeRefreshed, credentialLogin: Boolean(tokenRecovery.credentialLogin), credentialLoginAttempted: Boolean(tokenRecovery.credentialLoginAttempted), needsInput: Boolean(tokenRecovery.needsInput), browserRequired: Boolean(tokenRecovery.browserRequired) } : null });
  }
  const sub2apiPush = renewedTeamTokens > 0
    ? await pushRenewedTeamJson(mother)
    : { attempted: false, ok: null, status: null, message: null, pushed: 0, failed: 0 };
  if (renewedTeamTokens > 0 && workspace.ok !== true) {
    workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  }
  mother.lastCheck = now();
  const renewalDetail = !renewedTeamTokens
    ? ''
    : `，刷新 ${renewedTeamTokens} 个 Team JSON${reloggedFreeAccounts ? `，重新登录 ${reloggedFreeAccounts} 个 Free 账号` : ''}${sub2apiPush.attempted ? `，Sub2API 推送 ${sub2apiPush.pushed} 个` : '，Sub2API 未推送（未启用或未配置分组）'}`;
  addHistory('额度检测', `${mother.team} 检测 ${members.length} 个子号，席位 ${mother.used ?? '-'} / ${mother.seats ?? '-'}${renewalDetail}`);
  await persist();
  const probesOk = results.every((result) => result.ok === true);
  const syncOk = workspace.ok === true;
  const pushOk = !sub2apiPush.attempted || sub2apiPush.ok === true;
  return {
    ok: syncOk && probesOk && pushOk,
    status: syncOk && probesOk && pushOk ? 200 : 207,
    motherId,
    checked: results.length,
    results,
    seatSnapshot: workspace.seatSnapshot || mother.seatSnapshot || null,
    members: workspace.members || mother.members || [],
    syncOk,
    probesOk,
    renewedTeamTokens,
    renewedFreeTokens,
    reloggedFreeAccounts,
    sub2apiPush,
    managerRecovery,
  };
}

async function checkAllTeams() {
  const configured = state.mothers.filter(teamHasManagementPath);
  const teams = [];
  for (const mother of configured) {
    try {
      teams.push(await checkTeam(mother.id));
    } catch (error) {
      teams.push({ ok: false, status: 502, motherId: mother.id, checked: 0, results: [], message: error?.message || 'team_check_failed' });
    }
  }
  const checked = teams.reduce((sum, result) => sum + (Number(result.checked) || 0), 0);
  const failed = teams.filter((result) => result.ok !== true).length;
  return {
    ok: configured.length > 0 && failed === 0,
    status: failed ? 207 : 200,
    checked,
    teamCount: configured.length,
    succeeded: Math.max(0, configured.length - failed),
    failed,
    teams,
  };
}

async function refillTeam(motherId) {
  const mother = findMother(motherId);
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  let managerRecovery = await recoverTeamManagerToken(mother);
  let workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  if (!workspace.ok && [401, 403].includes(Number(workspace.status))) {
    managerRecovery = await recoverTeamManagerToken(mother, { force: true });
    if (managerRecovery.ok) workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  }
  if (workspace.ok !== true) {
    const message = workspace.message || 'workspace_sync_failed';
    addHistory('自动补位', `${mother.team} 空间同步失败，跳过远端补位：${message}`, 'partial');
    await persist();
    return {
      ok: false,
      status: 207,
      motherId,
      kicked: [],
      joined: [],
      kickFailures: [],
      joinFailures: [{ ok: false, status: workspace.status || 502, message }],
      seatsInUse: mother.used,
      seatsOpen: null,
      seatSnapshot: workspace.seatSnapshot || mother.seatSnapshot || null,
    };
  }
  const ownerRoleRetryFailures = [];
  const workspaceTokenRetryFailures = [];
  const pendingOwnerRoles = state.children.filter((child) => (
    isChildMemberOfTeam(child, mother.team)
    && (child.ownerRoleStatus === 'failed' || child.joinStatus === 'owner_role_failed' || child.joinStatus === 'approved_pending_owner')
  ));
  for (const child of pendingOwnerRoles) {
    const promoted = await promoteJoinedMemberToOwner(mother, child, mother.accountId);
    if (promoted.ok) {
      child.joinStatus = 'owner_confirmed';
      child.ownerRoleStatus = 'applied';
      child.ownerRoleUpdatedAt = now();
      child.ownerRoleError = null;
      addHistory('重试 Team 所有者', `${child.email} 已设置为 ${mother.team} 所有者`);
      const switched = await switchWorkspaceWithFreeRecovery(child, mother.accountId);
      if (!switched.ok) {
        child.joinStatus = 'owner_confirmed_token_pending';
        const membership = membershipFor(child, mother.team, true);
        membership.workspaceTokenStatus = 'pending';
        workspaceTokenRetryFailures.push({ id: child.id, email: child.email, ok: false, status: switched.status || 502, phase: 'workspace_token_retry', message: switched.message || 'workspace_token_exchange_failed' });
      }
    } else {
      child.joinStatus = 'owner_role_failed';
      child.ownerRoleStatus = 'failed';
      child.ownerRoleError = { status: promoted.status || 502, message: promoted.message || 'owner_role_failed', at: now() };
      ownerRoleRetryFailures.push({ id: child.id, email: child.email, ok: false, status: promoted.status || 502, phase: 'owner_role_retry', message: promoted.message || 'owner_role_failed' });
    }
  }
  const knownTeamOwnerEmails = new Set(teamOwnerRecords(mother).map((owner) => String(owner.email || '').toLowerCase()));
  const pendingWorkspaceTokens = state.children.filter((child) => (
    isChildMemberOfTeam(child, mother.team)
    && childIsWorkspaceOwner(child, mother)
    && !knownTeamOwnerEmails.has(String(child.email || '').toLowerCase())
  ));
  for (const child of pendingWorkspaceTokens) {
    const switched = await switchWorkspaceWithFreeRecovery(child, mother.accountId);
    if (switched.ok) {
      child.joinStatus = 'owner_confirmed';
      const membership = membershipFor(child, mother.team, true);
      membership.workspaceTokenStatus = 'ready';
    } else {
      child.joinStatus = 'owner_confirmed_token_pending';
      const membership = membershipFor(child, mother.team, true);
      membership.workspaceTokenStatus = 'pending';
      workspaceTokenRetryFailures.push({ id: child.id, email: child.email, ok: false, status: switched.status || 502, phase: 'workspace_token_retry', message: switched.message || 'workspace_token_exchange_failed' });
    }
  }
  const active = state.children.filter((child) => isChildMemberOfTeam(child, mother.team));
  const kickWindow = selectedKickWindow(mother);
  const exhausted = active.filter((child) => membershipQuotaIsExhausted(child, mother.team, kickWindow)
    || (child.team === mother.team && child.lastProbe?.ok === true && quotaIsExhausted(child, child.lastProbe, kickWindow)));
  const kicked = [];
  const kickFailures = [];
  for (const child of exhausted) {
    const currentMemberCount = workspaceMemberCount(mother, active.length + 1);
    if (currentMemberCount - kicked.length <= 1) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 409, message: 'minimum_workspace_member_required' });
      break;
    }
    const member = (mother.members || []).find((item) => item.email && child.email && item.email.toLowerCase() === child.email.toLowerCase());
    if (!teamManagerContext(mother) || !mother.accountId) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 400, message: 'workspace_credentials_required' });
      continue;
    }
    if (!member?.id && !workspace.ok) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 502, message: 'member_snapshot_unavailable' });
      continue;
    }
    if (memberIsProtected(member, mother)) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 403, message: 'protected_workspace_member' });
      continue;
    }
    if (member?.id) {
      const remote = await removeWorkspaceMember(mother, member);
      if (!remote.ok) { kickFailures.push({ id: child.id, email: child.email, ...remote }); continue; }
    }
    const removedAt = now();
    const retryAfter = quotaRetryAfter(child, kickWindow, mother.team);
    const retryReason = quotaKickReason(child, kickWindow);
    const membership = membershipFor(child, mother.team, true);
    Object.assign(membership, {
      status: 'kicked',
      removedAt,
      reason: retryReason,
      retryAfter,
      rejoinEligible: Boolean(retryAfter),
    });
    child.status = 'kicked';
    child.retryReason = retryReason;
    child.rejoinEligible = Boolean(retryAfter);
    if (child.team === mother.team) {
      const replacement = (child.workspaceHistory || []).find((entry) => entry.status === 'active' && entry.team);
      child.team = replacement?.team || null;
    }
    removeTeamOwnerForChild(mother, child);
    if (child.team) child.status = 'active';
    kicked.push(child);
  }
  const seatsEntitled = Number.isFinite(Number(mother.seats)) ? Number(mother.seats) : 0;
  const usedBeforeRefill = Number.isFinite(Number(mother.used)) ? Number(mother.used) : active.length;
  const open = Math.max(0, seatsEntitled - usedBeforeRefill + kicked.length);
  const candidatePool = state.children.filter((child) => (
    child.status !== 'login_pending'
    && !freeAuthRetryBackoffActive(child)
    && canRejoinTeam(child, mother.team)
    && Boolean(child.accessToken || child.refreshToken || (child.email && child.password))
    && !(child.workspaceHistory || []).some((entry) => entry.team === mother.team && entry.status === 'active')
  ));
  const joined = [];
  const joinFailures = [...ownerRoleRetryFailures, ...workspaceTokenRetryFailures];
  const candidates = [];
  for (const child of candidatePool) {
    if (candidates.length >= open) break;
    const freeAuth = await ensureChildFreeAuth(child);
    if (!freeAuth.ok) {
      joinFailures.push({ id: child.id, email: child.email, ok: false, status: freeAuth.status || 502, phase: 'free_auth', code: freeAuth.code || null, message: freeAuth.message || 'free_auth_required', needsInput: Boolean(freeAuth.needsInput), browserRequired: Boolean(freeAuth.browserRequired), authUrl: freeAuth.authUrl || null });
      continue;
    }
    candidates.push(child);
  }
  for (const child of candidates) {
    if (!teamManagerContext(mother) || !mother.accountId) { joinFailures.push({ id: child.id, email: child.email, ok: false, status: 400, message: 'workspace_credentials_required' }); continue; }
    const membership = membershipFor(child, mother.team, true);
    const remote = await joinWorkspace(child, { motherId, workspaceId: mother.accountId, approve: true, pushTeamJson: false });
    if (!remote.ok) {
      child.workspaceHistory = (child.workspaceHistory || []).filter((entry) => entry !== membership);
      joinFailures.push({ id: child.id, email: child.email, ...remote });
      continue;
    }
    const teamAuth = remote.teamAuth || { ok: false, status: 502, message: 'team_token_not_generated' };
    child.pendingWorkspaceId = mother.accountId;
    if (!teamAuth.ok) {
      child.joinStatus = 'owner_confirmed_token_pending';
      membership.workspaceTokenStatus = 'pending';
      joinFailures.push({ id: child.id, email: child.email, ok: false, status: teamAuth.status || 502, phase: 'team_token', code: teamAuth.code || null, message: teamAuth.message || 'team_token_failed', needsInput: Boolean(teamAuth.needsInput), browserRequired: Boolean(teamAuth.browserRequired), authUrl: teamAuth.authUrl || null });
      continue;
    }
    joined.push(child);
  }
  const synced = await syncMotherWorkspace(mother, { force: true }).catch(() => ({ ok: false, members: [] }));
  const joinedEmails = new Set((synced.members || []).filter(memberIsActive).map((member) => String(member.email).toLowerCase()));
  const confirmedJoined = [];
  for (const child of joined) {
    if (!joinedEmails.has(String(child.email || '').toLowerCase())) {
      child.status = child.team ? 'active' : 'ready';
      child.joinStatus = 'approved_pending_sync';
      child.joinedAt = child.joinedAt || null;
      child.workspaceHistory = (child.workspaceHistory || []).filter((entry) => !(entry.team === mother.team && entry.status === 'active'));
      joinFailures.push({ id: child.id, email: child.email, ok: false, status: 202, message: 'membership_not_visible_after_approval' });
    } else {
      child.status = 'active'; child.team = mother.team; child.joinedAt = child.joinedAt || now();
      const membership = membershipFor(child, mother.team);
      const joinedMember = (synced.members || []).find((member) => String(member.email || '').toLowerCase() === String(child.email || '').toLowerCase());
      if (joinedMember) {
        joinedMember.role = 'account-owner';
        child.memberId = joinedMember.id || child.memberId;
        child.accountUserId = joinedMember.accountUserId || child.accountUserId;
        child.memberSnapshot = { ...joinedMember, role: 'account-owner' };
      }
      child.joinStatus = 'owner_confirmed';
      child.ownerRoleStatus = 'applied';
      const previousHistory = (child.workspaceHistory || []).filter((entry) => !(entry.team === mother.team && entry.status === 'active' && entry !== membership));
      const activeMembership = membershipFor(child, mother.team, true) || membership;
      Object.assign(activeMembership, { team: mother.team, joinedAt: child.joinedAt, status: 'active', role: 'account-owner', memberId: child.memberId || activeMembership.memberId || null, quota5h: activeMembership.quota5h ?? child.quota5h ?? null, quota7d: activeMembership.quota7d ?? child.quota7d ?? null, quotaSnapshot: activeMembership.quotaSnapshot || null, quotaUpdatedAt: activeMembership.quotaUpdatedAt || child.lastQuotaCheckAt || null, workspaceTokenStatus: 'ready', rejoinEligible: null, retryAfter: null, reason: null });
      child.workspaceHistory = [...previousHistory.filter((entry) => entry !== activeMembership), activeMembership];
      confirmedJoined.push(child);
    }
  }
  if (!synced.seatSnapshot && Number.isFinite(Number(mother.used))) mother.used = Math.max(0, usedBeforeRefill - kicked.length + confirmedJoined.length);
  const joinedSub2apiPush = confirmedJoined.length > 0
    ? await pushRenewedTeamJson(mother)
    : { attempted: false, ok: null, status: null, message: null, pushed: 0, failed: 0 };
  mother.lastCheck = now();
  const pushDetail = joinedSub2apiPush.attempted ? `，Team JSON 推送 ${joinedSub2apiPush.pushed} 个` : '';
  addHistory('自动补位', `${mother.team} 移出 ${kicked.length} 个，加入 ${confirmedJoined.length}${pushDetail}${kickFailures.length || joinFailures.length ? `，失败 ${kickFailures.length + joinFailures.length} 个` : ''}`, kickFailures.length || joinFailures.length || joinedSub2apiPush.ok === false ? 'partial' : 'success');
  await persist();
  const pushFailed = joinedSub2apiPush.attempted && joinedSub2apiPush.ok === false;
  return { ok: kickFailures.length === 0 && joinFailures.length === 0 && !pushFailed, status: kickFailures.length || joinFailures.length || pushFailed ? 207 : 200, kicked: kicked.map(publicChild), joined: confirmedJoined.map(publicChild), kickFailures, joinFailures, sub2apiPush: joinedSub2apiPush, seatsInUse: mother.used, seatsOpen: Number.isFinite(Number(mother.seats)) && Number.isFinite(Number(mother.used)) ? Math.max(0, mother.seats - mother.used) : null, seatSnapshot: mother.seatSnapshot || workspace.seatSnapshot || null };
}

async function refillAllTeams() {
  const configured = state.mothers.filter(teamHasManagementPath);
  const teams = [];
  for (const mother of configured) {
    try {
      teams.push(await refillTeam(mother.id));
    } catch (error) {
      teams.push({ ok: false, status: 502, motherId: mother.id, kicked: [], joined: [], message: error?.message || 'team_refill_failed' });
    }
  }
  return {
    ok: configured.length > 0 && teams.every((result) => result.ok === true),
    status: teams.some((result) => result.ok !== true) ? 207 : 200,
    teamCount: configured.length,
    kicked: teams.flatMap((result) => result.kicked || []),
    joined: teams.flatMap((result) => result.joined || []),
    teams,
  };
}

let maintenanceRunning = false;
let maintenanceTimer;
let maintenanceOwner = null;
let maintenancePending = 0;
let maintenanceQueue = Promise.resolve();

async function withMaintenanceLock(owner, operation) {
  const scheduled = owner === 'scheduled';
  if (scheduled && maintenancePending > 0) return { ok: false, status: 409, message: 'maintenance_in_progress', owner: maintenanceOwner };
  maintenancePending += 1;
  const run = maintenanceQueue.then(async () => {
    maintenanceRunning = true;
    maintenanceOwner = owner;
    try {
      return await operation();
    } finally {
      maintenanceOwner = null;
      maintenanceRunning = false;
    }
  });
  maintenanceQueue = run.catch(() => {});
  try {
    return await run;
  } finally {
    maintenancePending = Math.max(0, maintenancePending - 1);
  }
}

async function prepareFreeJsonPool() {
  const results = [];
  for (const child of state.children) {
    if (child.accessToken || (!child.refreshToken && !(child.email && child.password)) || child.status === 'login_pending') continue;
    if (freeAuthRetryBackoffActive(child)) continue;
    const acquired = await ensureChildFreeAuth(child);
    results.push({
      id: child.id,
      email: child.email,
      ok: acquired.ok === true,
      status: acquired.status || null,
      code: acquired.code || null,
      source: acquired.source || null,
      needsInput: Boolean(acquired.needsInput),
      browserRequired: Boolean(acquired.browserRequired),
    });
  }
  return {
    attempted: results.length,
    acquired: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

async function runMaintenanceCycle() {
  if (state.settings.autoRefill !== true) return { ok: false, status: 204, message: 'auto_refill_disabled' };
  return withMaintenanceLock('scheduled', async () => {
    const freeJson = await prepareFreeJsonPool();
    const teams = [];
    for (const mother of state.mothers) {
      if (!teamHasManagementPath(mother)) continue;
      try {
        const checked = await checkTeam(mother.id);
        const refilled = checked.syncOk && state.settings.kickOnExhausted !== false
          ? await refillTeam(mother.id)
          : null;
        teams.push({ motherId: mother.id, checked, refilled });
      } catch (error) {
        addHistory('自动检测', `${mother.team} 检测失败，继续处理其他 Team：${error?.message || 'unknown_error'}`, 'partial');
        await persist();
        teams.push({ motherId: mother.id, ok: false, status: 502, message: error?.message || 'team_maintenance_failed' });
      }
    }
    return { ok: teams.every((team) => team.checked?.syncOk !== false && team.refilled?.ok !== false), status: teams.some((team) => team.checked?.syncOk === false || team.refilled?.ok === false) ? 207 : 200, freeJson, teams };
  });
}

function configureMaintenanceTimer() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const seconds = Math.max(30, Number(state.settings.checkInterval) || 60);
  maintenanceTimer = setInterval(() => { void runMaintenanceCycle(); }, seconds * 1000);
  maintenanceTimer.unref?.();
}

async function joinWorkspace(child, body) {
  const mother = findMother(body.motherId);
  if (!child || !mother) return { ok: false, status: 404, message: 'account_not_found' };
  if (!body.workspaceId) return { ok: false, status: 400, message: 'workspace_id_required' };
  if (body.approve !== false && !teamManagerContext(mother)) await recoverTeamManagerToken(mother, { force: true });
  if (body.approve !== false && !teamManagerContext(mother)) return { ok: false, status: 400, message: 'workspace_owner_token_required' };
  const freeAuth = await ensureChildFreeAuth(child, { verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
  if (!freeAuth.ok) {
    return {
      ok: false,
      status: freeAuth.status || 502,
      phase: 'free_auth',
      code: freeAuth.code || 'free_auth_required',
      message: freeAuth.message || 'free_auth_required',
      needsInput: Boolean(freeAuth.needsInput),
      browserRequired: Boolean(freeAuth.browserRequired),
      authUrl: freeAuth.authUrl || null,
      child: publicChild(child),
    };
  }
  const workspaceId = encodeURIComponent(body.workspaceId);
  const requestResult = await fetchChatGptJson(child.accessToken, `/backend-api/accounts/${workspaceId}/invites/request`, {
    method: 'POST', accountId: body.workspaceId,
    targetPath: `/backend-api/accounts/${body.workspaceId}/invites/request`, targetRoute: '/backend-api/accounts/{account_id}/invites/request',
    body: {}, headers: { 'content-type': 'application/json', 'oai-device-id': body.deviceId || randomUUID() },
  });
  const payload = requestResult.payload;
  if (!requestResult.ok) return { ok: false, status: requestResult.status || 502, phase: 'request', payload, message: requestResult.message };
  child.pendingInviteId = payload.id || payload.invite_id || payload.inviteId;
  child.pendingWorkspaceId = body.workspaceId;
  child.joinStatus = 'requested';
  addHistory('申请加入 Team', `${child.email} 已向 ${mother.team} 发起申请`);
  if (body.approve !== false) {
    const approved = await approveWorkspaceRequest(mother, body.workspaceId, child.email, child.pendingInviteId, body.deviceId);
    if (!approved.ok) { await persist(); return { ok: false, status: approved.status || 502, phase: 'admin_approve', request: payload, ...approved }; }
    child.joinStatus = 'approved_pending_owner';
    child.ownerRoleStatus = 'pending';
    addHistory('同意进入空间', `${mother.email} 已同意 ${child.email} 进入 ${mother.team}`);
    const promoted = await promoteJoinedMemberToOwner(mother, child, body.workspaceId);
    if (!promoted.ok) {
      child.joinStatus = 'owner_role_failed';
      child.ownerRoleStatus = 'failed';
      child.ownerRoleError = { status: promoted.status || 502, message: promoted.message || 'owner_role_failed', at: now() };
      addHistory('设置 Team 所有者', `${child.email} 进入 ${mother.team} 后提升所有者失败：${promoted.message || 'owner_role_failed'}`, 'error');
      await persist();
      return { ok: false, status: promoted.status || 502, phase: 'owner_role', inviteId: child.pendingInviteId || null, message: promoted.message || 'owner_role_failed' };
    }
    child.joinStatus = 'owner_confirmed';
    child.ownerRoleStatus = 'applied';
    child.ownerRoleUpdatedAt = now();
    child.ownerRoleError = null;
    addHistory('设置 Team 所有者', `${child.email} 已设置为 ${mother.team} 所有者`);
    const teamAuth = await switchWorkspaceWithFreeRecovery(child, mother.accountId, { verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
    if (!teamAuth.ok) {
      child.joinStatus = 'team_token_failed';
      await persist();
      return { ok: false, status: teamAuth.status || 502, phase: 'team_token', inviteId: child.pendingInviteId || null, message: teamAuth.message || 'team_token_failed', code: teamAuth.code, needsInput: Boolean(teamAuth.needsInput), browserRequired: Boolean(teamAuth.browserRequired), authUrl: teamAuth.authUrl || null, child: publicChild(child, mother.team) };
    }
    const sub2apiPush = body.pushTeamJson === false
      ? { attempted: false, ok: null, status: null, message: 'deferred_to_batch', pushed: 0, failed: 0 }
      : await pushRenewedTeamJson(mother);
    await persist();
    return { ok: true, phase: 'owner_confirmed', inviteId: child.pendingInviteId || null, payload, freeAuth: { source: freeAuth.source || null }, teamAuth, sub2apiPush };
  }
  await persist();
  return { ok: true, phase: body.approve === false ? 'requested' : 'owner_confirmed', inviteId: child.pendingInviteId || null, payload };
}

async function approveWorkspaceRequest(mother, workspaceId, email, inviteId, deviceId) {
  const base = `${CHATGPT_BASE_URL}/backend-api/accounts/${encodeURIComponent(workspaceId)}`;
  const attempted = await withTeamManager(mother, async (manager) => {
    const common = chatGptHeaders(manager.accessToken, mother.accountId || workspaceId, `/backend-api/accounts/${workspaceId}/invites`, '/backend-api/accounts/{account_id}/invites', { 'oai-device-id': deviceId || manager.deviceId || randomUUID(), 'cache-control': 'no-cache' });
    let selectedInviteId = inviteId;
    if (!selectedInviteId) {
      const list = await proxyFetch(`${base}/invites?include_pending=false&include_requests=true&offset=0&limit=100&query=${encodeURIComponent(email)}`, { headers: common }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
      const data = await list.json().catch(() => ({}));
      const candidates = Array.isArray(data.items) ? data.items : Array.isArray(data.invites) ? data.invites : [];
      const match = candidates.find((item) => String(item.email || item.target_email || '').toLowerCase() === email.toLowerCase()) || candidates[0];
      selectedInviteId = match?.id || match?.invite_id;
      if (!selectedInviteId) return { ok: false, status: list.status || 404, message: 'pending_invite_not_found', payload: data };
    }
    const approveHeaders = { ...common, 'content-type': 'application/json', 'x-openai-target-path': `/backend-api/accounts/${workspaceId}/invites/${selectedInviteId}`, 'x-openai-target-route': '/backend-api/accounts/{account_id}/invites/{invite_id}' };
    const response = await proxyFetch(`${base}/invites/${encodeURIComponent(selectedInviteId)}`, { method: 'PATCH', headers: approveHeaders, body: JSON.stringify({ role: 'account-owner', seat_type: 'default', accept_request: true }) }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, inviteId: selectedInviteId, payload, message: response.ok ? 'approved' : (payload.detail || payload.error || `http_${response.status}`) };
  });
  return attempted?.result || { ok: false, status: 401, message: 'workspace_owner_token_required' };
}

async function switchWorkspace(child, body) {
  if (!child || !body.workspaceId) return { ok: false, status: 400, message: 'child_and_workspace_required' };
  if (!child.accessToken) return { ok: false, status: 400, message: 'access_token_required' };
  const workspaceId = String(body.workspaceId).trim();
  const query = new URLSearchParams({
    exchange_workspace_token: 'true',
    workspace_id: workspaceId,
    reason: 'team_rotation',
  });
  const result = await fetchChatGptJson(child.accessToken, `/api/auth/session?${query}`, {
    accountId: workspaceId,
    targetPath: '/api/auth/session',
    targetRoute: '/api/auth/session',
    headers: { referer: `${CHATGPT_BASE_URL}/` },
  });
  child.lastWorkspaceSelectAt = now();
  if (!result.ok) {
    addHistory('切换空间', `${child.email} 切换到 ${workspaceId} 失败：${result.message}`, 'partial');
    await persist();
    return { ok: false, status: result.status || 502, message: result.message || 'workspace_session_exchange_failed', payload: result.payload };
  }
  const accessToken = accessTokenFromSessionPayload(result.payload);
  if (!accessToken) {
    addHistory('切换空间', `${child.email} 切换到 ${workspaceId} 后未返回 Team AT`, 'partial');
    await persist();
    return { ok: false, status: 502, message: 'workspace_access_token_missing', payload: result.payload };
  }
  const claims = accessTokenClaims(accessToken);
  if (!claims.accountId || claims.accountId !== workspaceId) {
    addHistory('切换空间', `${child.email} 返回的 AT 未匹配目标 Team`, 'partial');
    await persist();
    return { ok: false, status: 502, message: 'workspace_access_token_mismatch', accountId: claims.accountId || null };
  }
  const workspaceToken = saveWorkspaceToken(child, workspaceId, accessToken, claims);
  const mother = state.mothers.find((item) => item.accountId === workspaceId || item.team === workspaceId);
  const knownOwner = childMatchesKnownTeamOwner(child, mother);
  if (mother && String(mother.email || '').trim().toLowerCase() === String(child.email || '').trim().toLowerCase()) {
    mother.accessToken = accessToken;
    mother.token = preview(accessToken);
    mother.expiresAt = workspaceToken.expiresAt || mother.expiresAt || null;
  }
  if (mother && (childIsWorkspaceOwner(child, mother) || knownOwner)) upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken);
  const membership = mother ? membershipFor(child, mother.team, true) : membershipFor(child, workspaceId, true);
  if (membership) {
    membership.workspaceTokenStatus = 'ready';
    membership.workspaceTokenUpdatedAt = workspaceToken.acquiredAt;
  }
  addHistory('切换空间', `${child.email} 已取得 ${workspaceId} 的 Team AT`);
  await persist();
  return { ok: true, status: result.status, accountId: workspaceId, expiresAt: workspaceToken.expiresAt, tokenScope: 'team' };
}

async function switchWorkspaceWithFreeRecovery(child, workspaceId, { verificationCode = '', callbackUrl = '', forceRefreshFirst = false } = {}) {
  const initialAuth = await ensureChildFreeAuth(child, { forceRefresh: forceRefreshFirst && Boolean(child?.refreshToken), verificationCode, callbackUrl });
  if (!initialAuth.ok) {
    return {
      ok: false,
      status: initialAuth.status || 502,
      message: initialAuth.message || 'free_auth_required',
      code: initialAuth.code || 'free_auth_required',
      needsInput: Boolean(initialAuth.needsInput),
      browserRequired: Boolean(initialAuth.browserRequired),
      authUrl: initialAuth.authUrl || null,
      freeAuth: { attempted: true, ok: false, source: initialAuth.source || null },
    };
  }
  let result = await switchWorkspace(child, { workspaceId });
  if (result.ok || result.status !== 401) return { ...result, freeAuth: { attempted: true, ok: true, source: initialAuth.source || null } };

  // The Free token can be revoked before its JWT expiry. Refresh it once and
  // repeat the workspace exchange before surfacing the Team failure.
  const refreshed = await ensureChildFreeAuth(child, { forceRefresh: true, verificationCode, callbackUrl });
  if (!refreshed.ok) {
    return {
      ok: false,
      status: refreshed.status || result.status || 502,
      message: refreshed.message || result.message || 'free_auth_refresh_failed',
      code: refreshed.code || 'free_auth_refresh_failed',
      needsInput: Boolean(refreshed.needsInput),
      browserRequired: Boolean(refreshed.browserRequired),
      authUrl: refreshed.authUrl || null,
      freeAuth: { attempted: true, ok: false, source: refreshed.source || null, status: refreshed.status || null, code: refreshed.code || null },
    };
  }
  result = await switchWorkspace(child, { workspaceId });
  return {
    ...result,
    freeAuth: { attempted: true, ok: result.ok, source: refreshed.source || null, retriedAfter401: true },
  };
}

function sub2ApiRoot(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
}

function sub2ApiHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  return { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {}) };
}

async function sub2ApiRequest(config, requestPath, { method = 'GET', body } = {}) {
  const root = sub2ApiRoot(config.baseUrl);
  const headers = { ...sub2ApiHeaders(config.apiKey), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  const response = await proxyFetch(`${root}${requestPath}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS) });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload, data: payload?.data ?? payload, message: response.ok ? 'ok' : (payload?.message || payload?.error || `http_${response.status}`) };
}

async function querySub2ApiGroups() {
  const config = state.settings?.integrations?.sub2api || {};
  const root = sub2ApiRoot(config.baseUrl);
  if (!root || !config.apiKey) return { ok: false, status: 400, message: 'sub2api_connection_required', groups: [] };
  try {
    const result = await sub2ApiRequest(config, '/admin/groups/all');
    if (!result.ok) return { ok: false, status: result.status, message: result.message, groups: [] };
    const data = result.data;
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.groups) ? data.groups : [];
    const groups = items.map((item) => ({ id: Number(item?.id ?? item?.group_id), name: String(item?.name || item?.group_name || item?.display_name || item?.displayName || `分组 ${item?.id ?? item?.group_id ?? ''}`).trim(), platform: item?.platform || null })).filter((item) => Number.isFinite(item.id));
    return { ok: true, status: result.status, groups };
  } catch (error) {
    return { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', groups: [] };
  }
}

async function resolveSub2ApiGroup(config) {
  const groupId = Number(config?.groupId);
  const groupName = String(config?.groupName || '').trim();
  if (Number.isFinite(groupId) && groupId > 0) return { ok: true, id: groupId, name: groupName };
  if (!groupName) return { ok: false, status: 400, message: 'sub2api_group_required' };
  const result = await querySub2ApiGroups();
  if (!result.ok) return { ok: false, status: result.status || 502, message: 'sub2api_group_lookup_failed' };
  const target = groupName.toLocaleLowerCase();
  const matches = result.groups.filter((group) => group.name.toLocaleLowerCase() === target);
  if (!matches.length) return { ok: false, status: 400, message: 'sub2api_group_not_found' };
  return { ok: true, id: matches[0].id, name: matches[0].name };
}

function sub2ApiCredentials(child) {
  return Object.fromEntries(Object.entries({
    email: child.email,
    access_token: child.accessToken,
    refresh_token: child.refreshToken,
    chatgpt_account_id: child.accountId,
    chatgpt_user_id: child.chatgptUserId,
    client_id: child.clientId,
    id_token: child.idToken,
    organization_id: child.organizationId,
    model_mapping: child.modelMapping,
    expires_at: child.expiresAt,
    subscription_expires_at: child.subscriptionExpiresAt,
    plan_type: child.plan && child.plan !== '待检测' ? child.plan : child.tokenScope === 'team' ? 'team' : 'free',
  }).filter(([, value]) => value));
}

function sub2ApiExtra(child) {
  const primary = child?.quotaSnapshot?.primary || {};
  const secondary = child?.quotaSnapshot?.secondary || {};
  const used5h = Number.isFinite(Number(primary.usedPercent)) ? Number(primary.usedPercent) : Number.isFinite(Number(child?.quota5h)) ? Math.max(0, 100 - Number(child.quota5h)) : null;
  const used7d = Number.isFinite(Number(secondary.usedPercent)) ? Number(secondary.usedPercent) : Number.isFinite(Number(child?.quota7d)) ? Math.max(0, 100 - Number(child.quota7d)) : null;
  const extra = {
    ...(child?.extra && typeof child.extra === 'object' ? child.extra : {}),
  };
  if (child?.tokenScope !== 'team') {
    // A Free export is reusable for joining spaces. Team-specific usage must
    // not follow that credential into another Team's record.
    for (const key of Object.keys(extra)) if (/^codex_(5h|7d|primary|secondary|usage_)/.test(key)) delete extra[key];
    return Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  }
  const reset5h = child?.quota5hResetAfterSeconds ?? primary.resetAfterSeconds ?? null;
  const reset7d = child?.quota7dResetAfterSeconds ?? secondary.resetAfterSeconds ?? null;
  const resetAt5h = child?.quota5hResetAt || primary.resetAt || null;
  const resetAt7d = child?.quota7dResetAt || secondary.resetAt || null;
  if (used5h != null) extra.codex_5h_used_percent = used5h;
  if (used7d != null) extra.codex_7d_used_percent = used7d;
  if (reset5h != null) extra.codex_5h_reset_after_seconds = reset5h;
  if (reset7d != null) extra.codex_7d_reset_after_seconds = reset7d;
  if (resetAt5h) extra.codex_5h_reset_at = resetAt5h;
  if (resetAt7d) extra.codex_7d_reset_at = resetAt7d;
  if (used5h != null || reset5h != null || resetAt5h) extra.codex_5h_window_minutes = primary.windowMinutes ?? 300;
  if (used7d != null || reset7d != null || resetAt7d) extra.codex_7d_window_minutes = secondary.windowMinutes ?? 10080;
  const quotaUpdatedAt = child?.quotaUpdatedAt || child?.lastQuotaCheckAt || child?.quotaSnapshot?.updatedAt;
  if (quotaUpdatedAt) extra.codex_usage_updated_at = quotaUpdatedAt;
  return Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function sub2ApiAccountFromChild(child) {
  return {
    name: child.name || child.email || child.id,
    email: child.email || undefined,
    platform: 'openai',
    type: 'oauth',
    credentials: sub2ApiCredentials(child),
    extra: sub2ApiExtra(child),
    team: child.team || undefined,
    concurrency: child.concurrency,
    priority: child.priority,
    rate_multiplier: child.rateMultiplier,
    auto_pause_on_expired: child.autoPauseOnExpired,
  };
}

function teamOwnerRecords(mother) {
  if (!mother) return [];
  const byEmail = new Map();
  const workspaceId = mother.accountId || mother.team || '';
  const joinedOwners = state.children.flatMap((child) => {
    if (!isChildMemberOfTeam(child, mother.team) || !childIsWorkspaceOwner(child, mother)) return [];
    const workspaceToken = workspaceTokenFor(child, workspaceId) || workspaceTokenFor(child, mother.team);
    if (!workspaceToken?.accessToken) return [];
    const membership = membershipFor(child, mother.team);
    return [{
      ...child,
      accessToken: workspaceToken.accessToken,
      accountId: workspaceId,
      team: mother.team || workspaceId,
      plan: 'team',
      planType: 'team',
      tokenScope: 'team',
      expiresAt: workspaceToken.expiresAt || child.expiresAt || null,
      quota5h: membership?.quota5h ?? child.quota5h ?? null,
      quota7d: membership?.quota7d ?? child.quota7d ?? null,
      quotaSnapshot: membership?.quotaSnapshot || child.quotaSnapshot || null,
      quotaUpdatedAt: membership?.quotaUpdatedAt || child.quotaUpdatedAt || null,
    }];
  });
  for (const source of [mother, ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts : []), ...joinedOwners]) {
    const email = String(source?.email || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    const existing = byEmail.get(key) || {};
    const merged = { ...existing };
    for (const [field, value] of Object.entries(source)) {
      if (value !== undefined && value !== null && value !== '') merged[field] = value;
    }
    merged.email = email;
    merged.name = merged.name || email;
    merged.accountId = mother.accountId || mother.team || merged.accountId || '';
    merged.team = mother.team || mother.accountId || '';
    merged.plan = 'team';
    merged.planType = 'team';
    merged.tokenScope = 'team';
    byEmail.set(key, merged);
  }
  return [...byEmail.values()].filter((owner) => teamTokenDetails(owner.accessToken, workspaceId));
}

function sub2ApiAccountFromMotherOwner(mother, owner) {
  const record = {
    ...mother,
    ...owner,
    accountId: mother.accountId || mother.team || owner.accountId,
    team: mother.team || mother.accountId || owner.team,
    plan: 'team',
    planType: 'team',
    tokenScope: 'team',
  };
  return sub2ApiAccountFromChild(record);
}

async function pushSub2ApiEntries(entries = [], historyLabel = '推送 Sub2API') {
  const config = state.settings?.integrations?.sub2api || {};
  const root = sub2ApiRoot(config.baseUrl);
  if (!root || !config.apiKey) return { ok: false, status: 400, message: 'sub2api_connection_required', pushed: [], failed: [] };
  const group = await resolveSub2ApiGroup(config);
  if (!group.ok) return { ok: false, status: group.status || 400, message: group.message, pushed: [], failed: [] };
  const groupId = group.id;
  const pushed = [];
  const failed = [];
  for (const entry of entries) {
    const payload = { ...entry.payload, group_ids: [groupId] };
    const email = entry.email || payload.email || payload.credentials?.email || '';
    try {
      const lookup = await sub2ApiRequest(config, `/admin/accounts?page=1&page_size=100&search=${encodeURIComponent(email)}`);
      const lookupData = lookup.data;
      const items = Array.isArray(lookupData) ? lookupData : Array.isArray(lookupData?.items) ? lookupData.items : [];
      const emailMatches = items.filter((item) => String(item?.email || item?.credentials?.email || '').toLowerCase() === String(email).toLowerCase());
      const targetCredentials = payload.credentials || {};
      const targetAccountId = String(targetCredentials.chatgpt_account_id || '').trim();
      const targetPlan = String(targetCredentials.plan_type || '').trim().toLowerCase();
      const existing = emailMatches.find((item) => {
        const credentials = item?.credentials || {};
        const accountId = String(credentials.chatgpt_account_id || credentials.account_id || item?.account_id || '').trim();
        const plan = String(credentials.plan_type || item?.plan_type || '').trim().toLowerCase();
        if (targetAccountId) return Boolean(accountId) && targetAccountId === accountId;
        if (targetPlan && plan) return targetPlan === plan;
        return emailMatches.length === 1;
      });
      const result = existing?.id
        ? await sub2ApiRequest(config, `/admin/accounts/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: { ...payload, group_ids: [groupId] } })
        : await sub2ApiRequest(config, '/admin/accounts', { method: 'POST', body: payload });
      if (!result.ok) { failed.push({ id: entry.id, motherId: entry.motherId, email, status: result.status, message: result.message }); continue; }
      pushed.push({ id: entry.id, motherId: entry.motherId, email, targetGroupId: groupId, targetGroupName: group.name || config.groupName || '', action: existing?.id ? 'updated' : 'created' });
    } catch (error) {
      failed.push({ id: entry.id, motherId: entry.motherId, email, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' });
    }
  }
  addHistory(historyLabel, `${group.name || `分组 ${groupId}`} 推送 ${pushed.length} 个账号${failed.length ? `，失败 ${failed.length} 个` : ''}`, failed.length ? 'partial' : 'success');
  await persist();
  return { ok: failed.length === 0, status: failed.length ? 207 : 200, targetGroupId: groupId, targetGroupName: group.name || config.groupName || '', pushed, failed };
}

async function pushSub2ApiAccounts(ids = []) {
  const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
  const entries = state.children
    .filter((child) => child.accessToken && (!idSet.size || idSet.has(String(child.id))))
    .map((child) => ({ id: child.id, email: child.email, payload: sub2ApiAccountFromChild(child) }));
  return pushSub2ApiEntries(entries, '推送 Free 到 Sub2API');
}

function teamSub2ApiEntries(motherIds = []) {
  const idSet = new Set(Array.isArray(motherIds) ? motherIds.map(String) : []);
  return state.mothers
    .filter((mother) => !idSet.size || idSet.has(String(mother.id)) || idSet.has(String(mother.accountId || mother.team)))
    .flatMap((mother) => teamOwnerRecords(mother).map((owner) => ({
      id: `${mother.id}:${owner.email}`,
      motherId: mother.id,
      email: owner.email,
      payload: sub2ApiAccountFromMotherOwner(mother, owner),
    })));
}

async function pushSub2ApiTeams(motherIds = []) {
  return pushSub2ApiEntries(teamSub2ApiEntries(motherIds), '推送 Team 到 Sub2API');
}

// Streamable HTTP MCP transport. The tools deliberately use the same public
// projections as the dashboard so credentials and access tokens never leave
// the server through an Agent call.
const MCP_PROTOCOL_VERSION = '2025-06-18';
const mcpSessions = new Map();
const mcpTools = [
  { name: 'get_state', description: '获取 team轮转当前状态、Team 汇总、账号状态和自动化设置。', inputSchema: { type: 'object', properties: { includeHistory: { type: 'boolean', description: '是否同时返回最近操作历史，默认 true。' } }, additionalProperties: false } },
  { name: 'list_teams', description: '列出所有 Team 空间、所有者、席位和当前成员。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_accounts', description: '列出 Free 账号池中的登录状态、加入过的 Team 和凭据可用性。额度只在 Team 检测工具中返回。', inputSchema: { type: 'object', properties: { status: { type: 'string', description: '按状态筛选，例如 ready、active、warning、exhausted。' }, teamId: { type: 'string', description: '只返回当前属于指定 Team 的账号。' } }, additionalProperties: false } },
  { name: 'get_history', description: '获取额度检测、移除、加入和设置变更记录。', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 50。' } }, additionalProperties: false } },
  { name: 'check_team_quota', description: '检测一个 Team 及其成员的 5h / 7d 额度，并同步席位和成员快照。', inputSchema: { type: 'object', properties: { teamId: { type: 'string', description: 'Team 记录 id、accountId 或 team id。' } }, required: ['teamId'], additionalProperties: false } },
  { name: 'check_all_teams', description: '检测所有已配置真实凭据的 Team。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'refill_team', description: '对一个 Team 执行移除已耗尽账号并从待加入池补位。', inputSchema: { type: 'object', properties: { teamId: { type: 'string', description: 'Team 记录 id、accountId 或 team id。' } }, required: ['teamId'], additionalProperties: false } },
  { name: 'refill_all_teams', description: '对所有已配置真实凭据的 Team 执行移除和补位。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'update_settings', description: '更新自动补位、额度预警阈值、检测周期和自动踢出窗口。', inputSchema: { type: 'object', properties: { autoRefill: { type: 'boolean' }, threshold: { type: 'number', minimum: 1, maximum: 100 }, checkInterval: { type: 'number', minimum: 30 }, kickWindow: { type: 'string', enum: ['5h', '7d'] } }, additionalProperties: false } },
];

function mcpAuthOk(req) {
  const expected = String(process.env.MCP_AUTH_TOKEN || apiAuthToken || '').trim();
  if (!expected) return true;
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : String(req.headers['x-mcp-token'] || '').trim();
  return secureTokenEqual(supplied, expected);
}

function mcpSend(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...responseHeaders(res), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function mcpRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function resolveMotherId(value) {
  const needle = String(value || '').trim();
  const mother = state.mothers.find((item) => item.id === needle || item.accountId === needle || item.team === needle);
  return mother?.id || null;
}

function mcpToolPayload(name, args = {}) {
  if (name === 'get_state') {
    const snapshot = publicState({ includeHistory: args.includeHistory !== false });
    if (args.includeHistory === false) delete snapshot.history;
    return snapshot;
  }
  if (name === 'list_teams') return publicState().teams;
  if (name === 'list_accounts') {
    const requestedTeam = String(args.teamId || '').trim();
    const teamId = requestedTeam ? (state.mothers.find((mother) => mother.id === requestedTeam || mother.accountId === requestedTeam || mother.team === requestedTeam)?.team || requestedTeam) : '';
    const accounts = state.children
      .filter((child) => !args.status || child.status === args.status)
      .filter((child) => !teamId || isChildMemberOfTeam(child, teamId))
      .map((child) => publicChild(child));
    return { count: accounts.length, accounts };
  }
  if (name === 'get_history') {
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    return publicHistory().slice(0, limit);
  }
  return null;
}

async function mcpCallTool(name, args = {}) {
  const readPayload = mcpToolPayload(name, args);
  if (readPayload !== null) return readPayload;
  if (name === 'check_team_quota') {
    const motherId = resolveMotherId(args.teamId);
    if (!motherId) return { ok: false, status: 404, message: 'team_not_found' };
    return withMaintenanceLock('mcp_check_team', () => checkTeam(motherId));
  }
  if (name === 'check_all_teams') return withMaintenanceLock('mcp_check_all', () => checkAllTeams());
  if (name === 'refill_team') {
    const motherId = resolveMotherId(args.teamId);
    if (!motherId) return { ok: false, status: 404, message: 'team_not_found' };
    return withMaintenanceLock('mcp_refill_team', () => refillTeam(motherId));
  }
  if (name === 'refill_all_teams') return withMaintenanceLock('mcp_refill_all', () => refillAllTeams());
  if (name === 'update_settings') {
    const input = args && typeof args === 'object' ? args : {};
    if (input.autoRefill !== undefined) state.settings.autoRefill = Boolean(input.autoRefill);
    if (input.threshold !== undefined) state.settings.threshold = Math.min(100, Math.max(1, Number(input.threshold) || state.settings.threshold));
    if (input.checkInterval !== undefined) state.settings.checkInterval = Math.max(30, Number(input.checkInterval) || state.settings.checkInterval);
    if (input.kickWindow !== undefined) state.settings.kickWindow = input.kickWindow === '7d' ? '7d' : '5h';
    configureMaintenanceTimer();
    addHistory('更新设置', 'Agent 通过 MCP 更新自动化策略');
    await persist();
    return publicState().settings;
  }
  throw new Error(`unknown_tool: ${name}`);
}

async function mcpHandleMessage(message, req, res) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return mcpRpcError(message?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    const sessionId = randomUUID();
    const requested = String(params.protocolVersion || '');
    const protocolVersion = requested === MCP_PROTOCOL_VERSION || requested === '2025-03-26' ? requested : MCP_PROTOCOL_VERSION;
    mcpSessions.set(sessionId, protocolVersion);
    return { response: { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'team-rotation', version: '1.0.0' }, instructions: '使用工具管理 Team 额度和补位；服务器不会通过 MCP 返回完整凭据或 access token。' } }, sessionId, protocolVersion };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return { notification: true };
  if (method === 'ping') return { response: { jsonrpc: '2.0', id, result: {} } };
  if (method === 'tools/list') return { response: { jsonrpc: '2.0', id, result: { tools: mcpTools } } };
  if (method === 'tools/call') {
    const name = params?.name;
    if (!mcpTools.some((tool) => tool.name === name)) return { response: mcpRpcError(id, -32602, `Unknown tool: ${name}`) };
    try {
      const payload = await mcpCallTool(name, params.arguments || {});
      const failed = payload && payload.ok === false && Number(payload.status) >= 400;
      return { response: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: Boolean(failed), structuredContent: payload } } };
    } catch (error) {
      return { response: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error?.message || 'tool_failed' }], isError: true } } };
    }
  }
  return { response: mcpRpcError(id, -32601, `Method not found: ${method}`) };
}

async function handleMcp(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...responseHeaders(res), 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, x-mcp-token', 'access-control-max-age': '600' });
    res.end();
    return;
  }
  if (!mcpAuthOk(req)) return mcpSend(res, 401, { error: 'mcp_auth_required' }, { 'www-authenticate': 'Bearer' });
  if (req.method === 'GET') return mcpSend(res, 405, { error: 'mcp_post_required' }, { allow: 'POST, DELETE' });
  if (req.method === 'DELETE') { const sessionId = String(req.headers['mcp-session-id'] || ''); if (sessionId) mcpSessions.delete(sessionId); res.writeHead(204, responseHeaders(res)); res.end(); return; }
  if (req.method !== 'POST') return mcpSend(res, 405, { error: 'method_not_allowed' }, { allow: 'POST, DELETE' });
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return mcpSend(res, 415, { error: 'json_content_type_required' });
  const sessionId = String(req.headers['mcp-session-id'] || '');
  if (sessionId && !mcpSessions.has(sessionId)) return mcpSend(res, 404, mcpRpcError(null, -32000, 'Unknown MCP session'));
  let message;
  try { message = await bodyOf(req); } catch (error) { return mcpSend(res, 400, mcpRpcError(null, -32700, error?.message || 'Parse error')); }
  const messages = Array.isArray(message) ? message : [message];
  const results = [];
  let responseSessionId = sessionId || null;
  let responseProtocolVersion = mcpSessions.get(sessionId) || MCP_PROTOCOL_VERSION;
  for (const item of messages) {
    const result = await mcpHandleMessage(item, req, res);
    if (result.sessionId) responseSessionId = result.sessionId;
    if (result.protocolVersion) responseProtocolVersion = result.protocolVersion;
    if (result.response) results.push(result.response);
  }
  if (!results.length) { res.writeHead(202, responseHeaders(res)); res.end(); return; }
  const payload = Array.isArray(message) ? results : results[0];
  return mcpSend(res, 200, payload, { ...(responseSessionId ? { 'mcp-session-id': responseSessionId } : {}), 'mcp-protocol-version': responseProtocolVersion });
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const segments = url.pathname.split('/').filter(Boolean);
  if (method === 'OPTIONS') {
    res.writeHead(204, { ...responseHeaders(res), 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-api-token', 'access-control-max-age': '600' });
    res.end();
    return;
  }
  if (!apiAuthOk(req)) return sendJson(res, 401, { code: 'api_auth_required', message: 'API Token 无效或未提供' });
  if (['POST', 'PATCH', 'PUT'].includes(method) && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return sendJson(res, 415, { code: 'json_content_type_required', message: 'Content-Type 必须是 application/json' });
  }
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await bodyOf(req) : {};
  if (method === 'GET' && url.pathname === '/api/state') {
    const includeHistory = !['false', '0', 'no'].includes(String(url.searchParams.get('includeHistory') || '').toLowerCase());
    return sendJson(res, 200, publicState({ includeHistory }));
  }
  if (method === 'GET' && url.pathname === '/api/history') {
    const hasPagination = ['page', 'pageSize', 'page_size', 'limit', 'offset'].some((key) => url.searchParams.has(key));
    const allHistory = publicHistory();
    if (!hasPagination) return sendJson(res, 200, allHistory);
    const requestedPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const requestedPageSize = Number.parseInt(url.searchParams.get('pageSize') || url.searchParams.get('page_size') || url.searchParams.get('limit') || '20', 10);
    const pageSize = Number.isFinite(requestedPageSize) ? Math.min(200, Math.max(1, requestedPageSize)) : 20;
    const total = allHistory.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '', 10);
    const offsetPage = Number.isFinite(requestedOffset) ? Math.floor(Math.max(0, requestedOffset) / pageSize) + 1 : null;
    const page = Number.isFinite(requestedPage) && !url.searchParams.has('offset')
      ? Math.min(totalPages, Math.max(1, requestedPage))
      : Math.min(totalPages, Math.max(1, offsetPage || 1));
    const start = (page - 1) * pageSize;
    const items = allHistory.slice(start, start + pageSize);
    return sendJson(res, 200, { items, page, pageSize, offset: start, limit: pageSize, total, totalPages, hasPreviousPage: page > 1, hasNextPage: page < totalPages });
  }
  if (method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, updatedAt: state.updatedAt });
  if (method === 'PATCH' && url.pathname === '/api/settings') {
    const autoRefillWasEnabled = state.settings.autoRefill === true;
    const allowed = ['autoRefill', 'threshold', 'checkInterval', 'kickOnExhausted', 'kickWindow'];
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      if (key === 'autoRefill' || key === 'kickOnExhausted') state.settings[key] = Boolean(body[key]);
      else if (key === 'kickWindow') state.settings.kickWindow = body[key] === '7d' ? '7d' : '5h';
      else state.settings[key] = Math.max(1, Number(body[key]) || state.settings[key]);
    }
    configureMaintenanceTimer();
    addHistory('更新设置', '自动化策略已更新');
    await persist();
    if (!autoRefillWasEnabled && state.settings.autoRefill === true) setTimeout(() => { void runMaintenanceCycle(); }, 0).unref?.();
    return sendJson(res, 200, { settings: publicState({ includeHistory: false }).settings, state: publicState({ includeHistory: false }) });
  }
  if (method === 'PATCH' && url.pathname === '/api/proxy') {
    const current = state.settings.proxy || (state.settings.proxy = structuredClone(emptyState.settings.proxy));
    if (body.enabled !== undefined) current.enabled = Boolean(body.enabled);
    if (body.strategy !== undefined) current.strategy = body.strategy === 'round_robin' ? 'round_robin' : 'failover';
    if (body.timeoutMs !== undefined) { const value = Number(body.timeoutMs); if (Number.isFinite(value)) current.timeoutMs = Math.min(120000, Math.max(1000, value)); }
    if (body.maxRetries !== undefined) { const value = Number(body.maxRetries); if (Number.isFinite(value)) current.maxRetries = Math.min(5, Math.max(0, value)); }
    addHistory('更新代理设置', current.enabled ? `代理池已启用（${current.entries?.length || 0} 条）` : '代理池已停用');
    await persist();
    return sendJson(res, 200, { proxy: publicState({ includeHistory: false }).settings.proxy, settings: publicState({ includeHistory: false }).settings, state: publicState({ includeHistory: false }) });
  }
  if (method === 'POST' && url.pathname === '/api/proxy/entries') {
    const rawValues = Array.isArray(body.values)
      ? body.values
      : typeof body.values === 'string'
        ? body.values.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
        : body.value !== undefined ? [body] : [];
    const current = state.settings.proxy || (state.settings.proxy = structuredClone(emptyState.settings.proxy));
    if (!Array.isArray(current.entries)) current.entries = [];
    const added = [];
    const errors = [];
    for (const item of rawValues) {
      const raw = typeof item === 'string' ? item : item?.value || item?.proxy || item?.url;
      const label = typeof item === 'object' ? String(item?.label || '').trim() : '';
      try {
        const parsed = parseProxyInput(raw);
        const duplicate = current.entries.some((entry) => entry.url === parsed.url);
        if (duplicate) {
          errors.push({ message: 'proxy_duplicate' });
          continue;
        }
        const entry = {
          id: randomUUID(),
          label: label || (parsed.sourceType === 'local' ? '本机代理' : '家宽代理'),
          ...parsed,
          display: maskProxyUrl(parsed.url),
          createdAt: now(),
        };
        current.entries.push(entry);
        added.push(entry);
      } catch (error) {
        errors.push({ message: error?.message || 'invalid_proxy' });
      }
    }
    if (added.length) {
      addHistory('添加代理', `新增 ${added.length} 条代理${errors.length ? `，${errors.length} 条未添加` : ''}`);
      await persist();
    }
    if (!added.length && errors.length) return sendJson(res, 400, { added: [], errors, proxy: publicState({ includeHistory: false }).settings.proxy });
    const addedPublic = added.map((entry) => publicProxySettings({ proxy: { entries: [entry] } }).entries[0]);
    return sendJson(res, 200, { added: addedPublic, errors, proxy: publicState({ includeHistory: false }).settings.proxy, state: publicState({ includeHistory: false }) });
  }
  if (method === 'DELETE' && segments[1] === 'proxy' && segments[2] === 'entries' && segments[3]) {
    const current = state.settings.proxy || (state.settings.proxy = structuredClone(emptyState.settings.proxy));
    const id = decodeURIComponent(segments[3]);
    const index = Array.isArray(current.entries) ? current.entries.findIndex((entry) => entry.id === id) : -1;
    if (index < 0) return sendJson(res, 404, { message: 'proxy_not_found' });
    const [removed] = current.entries.splice(index, 1);
    addHistory('删除代理', `${removed.label || removed.host || '代理'} 已移除`);
    await persist();
    return sendJson(res, 200, { proxy: publicState({ includeHistory: false }).settings.proxy, state: publicState({ includeHistory: false }) });
  }
  if (method === 'PATCH' && url.pathname === '/api/integrations') {
    const current = state.settings.integrations || (state.settings.integrations = structuredClone(emptyState.settings.integrations));
    if (body.sub2api && typeof body.sub2api === 'object') {
      const input = body.sub2api;
      current.sub2api = { ...current.sub2api, ...(input.baseUrl !== undefined ? { baseUrl: String(input.baseUrl || '').trim() } : {}), ...(input.groupId !== undefined ? { groupId: input.groupId == null || input.groupId === '' ? null : Number(input.groupId) } : {}), ...(input.groupName !== undefined ? { groupName: String(input.groupName || '').trim() } : {}), ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}) };
      if (input.apiKey !== undefined) current.sub2api.apiKey = String(input.apiKey || '').trim();
    }
    if (body.mailbox && typeof body.mailbox === 'object') {
      const input = body.mailbox;
      current.mailbox = { ...current.mailbox, ...(input.serviceType !== undefined ? { serviceType: String(input.serviceType || 'manual') } : {}), ...(input.endpoint !== undefined ? { endpoint: String(input.endpoint || '').trim() } : {}), ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}) };
      if (input.apiKey !== undefined) current.mailbox.apiKey = String(input.apiKey || '').trim();
    }
    addHistory('更新集成', 'Sub2API 或邮箱/接码配置已更新');
    await persist();
    return sendJson(res, 200, { settings: publicState({ includeHistory: false }).settings, state: publicState({ includeHistory: false }) });
  }
  if (method === 'GET' && url.pathname === '/api/integrations/sub2api/groups') {
    return sendJson(res, 200, await querySub2ApiGroups());
  }
  if (method === 'POST' && url.pathname === '/api/mothers') {
    const imported = motherFromImportedAccount(body);
    const importedTeam = body.team !== undefined ? String(body.team || '').trim() : (body.accountId ? String(body.accountId).trim() : imported.team);
    const mother = { ...imported, id: body.id || imported.id, email: String(body.email || imported.email), name: String(body.name || imported.name), team: importedTeam, teamName: String(body.teamName || body.displayName || imported.teamName || ''), rotationMode: body.rotationMode === 'rotating' ? 'rotating' : 'fixed', primaryOwnerEmail: String(body.primaryOwnerEmail || imported.primaryOwnerEmail || body.email || imported.email || ''), seats: body.seats == null ? imported.seats : Number(body.seats), used: body.used == null ? imported.used : Number(body.used), status: 'unconfigured', lastCheck: null };
    if (body.accountId !== undefined) mother.accountId = String(body.accountId || '').trim();
    if (mother.accountId) mother.team = mother.accountId;
    const duplicate = state.mothers.find((item) => (
      (mother.accountId && item.accountId === mother.accountId)
      || (mother.email && item.email && item.email.toLowerCase() === mother.email.toLowerCase())
    ));
    if (duplicate) {
      const existingId = duplicate.id;
      Object.assign(duplicate, Object.fromEntries(Object.entries(mother).filter(([, value]) => value !== '' && value !== null && value !== undefined)));
      duplicate.id = existingId;
      addHistory('更新母号', `${duplicate.email} 已从导入记录更新`);
      await persist();
      return sendJson(res, 200, publicState({ includeHistory: false }));
    }
    state.mothers.push(mother); addHistory('添加母号', `${mother.email} 已加入母号列表`); await persist(); return sendJson(res, 201, publicState({ includeHistory: false }));
  }
  if (method === 'PATCH' && segments[1] === 'mothers' && segments[2]) {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    const fields = credentialFields(body);
    const previousTeam = canonicalTeamId(mother);
    const nextAccountId = fields.accountId
      || (body.accountId !== undefined ? String(body.accountId || '').trim() : undefined)
      || (body.team !== undefined ? String(body.team || '').trim() : mother.accountId);
    const nextTeam = body.team !== undefined
      ? String(body.team || '').trim()
      : (body.accountId !== undefined ? nextAccountId : mother.team);
    Object.assign(mother, ['email', 'name', 'teamName', 'displayName', 'seats'].reduce((out, key) => body[key] !== undefined ? { ...out, [key]: key === 'seats' ? (body[key] == null ? null : Number(body[key])) : body[key] } : out, {}));
    if (body.primaryOwnerEmail !== undefined) mother.primaryOwnerEmail = String(body.primaryOwnerEmail || '').trim() || mother.email || '';
    if (nextAccountId !== undefined) mother.accountId = nextAccountId;
    if (nextTeam !== undefined) mother.team = nextTeam || mother.accountId || mother.id;
    if (body.rotationMode !== undefined) mother.rotationMode = body.rotationMode === 'rotating' ? 'rotating' : 'fixed';
    if (fields.accessToken) mother.accessToken = fields.accessToken;
    if (fields.refreshToken) mother.refreshToken = fields.refreshToken;
    if (fields.accountId) mother.accountId = fields.accountId;
    if (fields.chatgptUserId) mother.chatgptUserId = fields.chatgptUserId;
    if (fields.planType) mother.planType = fields.planType;
    promotePrimaryOwner(mother);
    migrateTeamMemberships(previousTeam, canonicalTeamId(mother));
    addHistory('更新母号', `${mother.email} 配置已更新`); await persist(); return sendJson(res, 200, publicState({ includeHistory: false }));
  }
  if (method === 'POST' && url.pathname === '/api/children') {
    const fields = credentialFields(body);
    if (!fields.email) return sendJson(res, 400, { message: 'email_required' });
    const duplicate = state.children.find((item) => String(item.email || '').toLowerCase() === String(fields.email).toLowerCase());
    if (duplicate) return sendJson(res, 409, { message: 'child_email_exists', child: publicChild(duplicate) });
    const child = childFromImportedAccount({ ...body, planType: 'free', source: body.source || 'manual' });
    child.id = body.id || child.id;
    child.status = fields.accessToken ? 'ready' : fields.password ? 'login_required' : 'unconfigured';
    state.children.unshift(child);
    addHistory('添加 Free 账号', `${child.email} 已加入普通账号池`);
    await persist();
    return sendJson(res, 201, { child: publicChild(child), state: publicState({ includeHistory: false }) });
  }
  if (method === 'GET' && segments[1] === 'mothers' && segments[2] && segments[3] === 'members') {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    const result = await queryWorkspaceMembersPage(mother, { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit'), query: url.searchParams.get('query') || '' });
    return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, status: result.status, message: result.message, accountId: result.accountId, items: result.items, total: result.total, offset: result.offset, limit: result.limit });
  }
  if (method === 'GET' && segments[1] === 'mothers' && segments[2] && segments[3] === 'subscription') {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    const result = await queryWorkspaceSubscription(mother);
    if (result.ok && result.subscription) { mother.subscription = result.subscription; mother.seatSnapshot = result.subscription; mother.seats = result.subscription.seatsEntitled; mother.used = result.subscription.seatsInUse; mother.lastSubscriptionProbe = { ok: true, status: result.status, message: result.message, latencyMs: result.latencyMs }; await persist(); }
    return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, status: result.status, message: result.message, accountId: result.accountId, subscription: result.subscription });
  }
  if (method === 'GET' && segments[1] === 'mothers' && segments[2] && segments[3] === 'sync') {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    return sendJson(res, 200, await syncMotherWorkspace(mother, { query: url.searchParams.get('query') || '' }));
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'sync') {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    return sendJson(res, 200, await syncMotherWorkspace(mother, { query: body.query || '', force: true }));
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'probe') {
    const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    const result = await probeMother(mother); await persist(); return sendJson(res, result.ok ? 200 : 502, result);
  }
  if (method === 'POST' && (url.pathname === '/api/children/import' || url.pathname === '/api/accounts/import' || url.pathname === '/api/sub2api/import')) {
    let rawItems = Array.isArray(body.accounts) ? body.accounts : Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length && body.text) {
      try {
        const parsed = JSON.parse(body.text);
        rawItems = Array.isArray(parsed.accounts) ? parsed.accounts : Array.isArray(parsed.items) ? parsed.items : [];
      } catch {
        rawItems = String(body.text).split(/\r?\n/).filter(Boolean);
      }
    }
    const asObject = (item) => {
      if (item && typeof item === 'object') return item;
      const parts = splitCredentialLine(item);
      return { email: parts[0] || '', mailboxUrl: parts.length === 2 ? parts[1] : '', password: parts[1] || '', totp: parts[2] || '' };
    };
    const motherTarget = body.target === 'mothers' || body.kind === 'mother';
    const incoming = rawItems.map(asObject).filter((item) => credentialFields(item).email || credentialFields(item).accessToken);
    if (motherTarget) {
      const added = incoming.map(motherFromImportedAccount);
      state.mothers = [...added, ...state.mothers];
      addHistory('导入母号', `新增 ${added.length} 个母号`);
      await persist();
      return sendJson(res, 201, { added: added.map(publicMother), state: publicState({ includeHistory: false }) });
    }
    const added = [];
    const updated = [];
    const mothersAdded = [];
    const mothersUpdated = [];
    const source = body.source || (url.pathname === '/api/sub2api/import' ? 'sub2api' : null);
    for (const item of incoming) {
      const fields = credentialFields(item);
      if (isTeamAccount(item)) {
        const teamId = String(fields.accountId || item.team || item.workspaceId || '').trim();
        const matchingMother = [...mothersAdded, ...state.mothers].find((mother) => canonicalTeamId(mother) === teamId && teamId);
        if (matchingMother) {
          mergeImportedMother(matchingMother, item);
          if (mothersAdded.includes(matchingMother)) continue;
          mothersUpdated.push(matchingMother);
        } else {
          const nextMother = motherFromImportedAccount({ ...item, team: teamId });
          mothersAdded.push(nextMother);
        }
        continue;
      }
      const matchingMother = state.mothers.find((mother) => (
        fields.email && mother.email && fields.email.toLowerCase() === mother.email.toLowerCase()
      ));
      if (matchingMother && String(fields.planType || '').toLowerCase() !== 'free') {
        const importedMother = motherFromImportedAccount(item);
        Object.assign(matchingMother, Object.fromEntries(Object.entries(importedMother).filter(([key, value]) => !['id', 'status', 'lastCheck', 'createdAt'].includes(key) && value !== '' && value !== null && value !== undefined)));
        mothersUpdated.push(matchingMother);
        continue;
      }
      const next = childFromImportedAccount(source ? { ...item, source } : item);
      const existing = state.children.find((child) => child.email && next.email && child.email.toLowerCase() === next.email.toLowerCase());
      if (existing) {
        const history = existing.workspaceHistory || [];
        const merged = Object.fromEntries(Object.entries(next).filter(([key, value]) => {
          if (key === 'id' || key === 'workspaceHistory' || value === '' || value === null || value === undefined) return false;
          // Re-importing credentials must not erase a live membership snapshot.
          if (key === 'status' && value === 'ready' && existing.status && existing.status !== 'ready' && !item.status) return false;
          if (key === 'plan' && value === '待检测' && existing.plan && existing.plan !== '待检测' && !item.plan && !item.planType) return false;
          if (key === 'token' && value === '待登录获取 AT' && existing.accessToken) return false;
          return true;
        }));
        Object.assign(existing, merged, { id: existing.id, workspaceHistory: history.length ? history : next.workspaceHistory });
        updated.push(existing);
      } else {
        added.push(next);
      }
    }
    state.mothers = [...mothersAdded, ...state.mothers];
    state.children = [...added, ...state.children];
    linkFreeAccountsToImportedTeams();
    addHistory('导入账号', `新增 ${added.length} 个 Free 账号${updated.length ? `，更新 ${updated.length} 个已有账号` : ''}${mothersAdded.length ? `，新增 ${mothersAdded.length} 个 Team 空间` : ''}${mothersUpdated.length ? `，更新 ${mothersUpdated.length} 个 Team 所有者` : ''}`);
    await persist();
    return sendJson(res, 201, { added: added.map(publicChild), updated: updated.map(publicChild), mothersAdded: mothersAdded.map(publicMother), mothersUpdated: mothersUpdated.map(publicMother), state: publicState({ includeHistory: false }) });
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'login') {
    const child = findChild(segments[2]); if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const fields = credentialFields(body);
    if (fields.email && !child.email) child.email = fields.email;
    if (fields.password) child.password = fields.password;
    if (fields.totp) child.totp = fields.totp;
    if (fields.mailboxUrl) child.mailboxUrl = fields.mailboxUrl;
    if (!fields.accessToken) {
      const result = await acquireChildAuth(child, { refresh: body.refresh === true, verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
      return sendJson(res, result.status || 202, result);
    }
    child.accessToken = fields.accessToken;
    child.refreshToken = fields.refreshToken || child.refreshToken;
    child.accountId = fields.accountId || child.accountId;
    child.chatgptUserId = fields.chatgptUserId || child.chatgptUserId;
    child.clientId = fields.clientId || child.clientId;
    child.idToken = fields.idToken || child.idToken;
    child.organizationId = fields.organizationId || child.organizationId;
    child.expiresAt = fields.expiresAt || child.expiresAt;
    child.subscriptionExpiresAt = fields.subscriptionExpiresAt || child.subscriptionExpiresAt;
    child.password = fields.password || child.password;
    child.totp = fields.totp || child.totp;
    child.mailboxUrl = fields.mailboxUrl || child.mailboxUrl;
    child.plan = fields.planType || child.plan || '待检测';
    child.token = preview(fields.accessToken);
    child.authAt = now();
    child.sub2apiImported = true;
    setChildLoginState(child, 'ready', 'AT 已保存，可导出 Free JSON');
    child.status = child.team ? 'active' : 'ready';
    if (fields.quota5h != null) child.quota5h = fields.quota5h;
    if (fields.quota7d != null) child.quota7d = fields.quota7d;
    child.quota5hResetAfterSeconds = fields.quota5hResetAfterSeconds ?? child.quota5hResetAfterSeconds ?? null;
    child.quota7dResetAfterSeconds = fields.quota7dResetAfterSeconds ?? child.quota7dResetAfterSeconds ?? null;
    child.quota5hResetAt = fields.quota5hResetAt || child.quota5hResetAt || null;
    child.quota7dResetAt = fields.quota7dResetAt || child.quota7dResetAt || null;
    child.quotaUpdatedAt = fields.quotaUpdatedAt || child.quotaUpdatedAt || null;
    if (fields.extra && Object.keys(fields.extra).length) child.extra = { ...(child.extra || {}), ...fields.extra };
    if (fields.quotaSnapshot && (fields.quotaSnapshot.primary || fields.quotaSnapshot.secondary)) child.quotaSnapshot = fields.quotaSnapshot;
    addHistory('获取 AT', `${child.email} 已保存新的 AT`); await persist(); return sendJson(res, 200, publicChild(child));
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'acquire') {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const fields = credentialFields(body);
    if (fields.email && !child.email) child.email = fields.email;
    if (fields.password) child.password = fields.password;
    if (fields.totp) child.totp = fields.totp;
    if (fields.mailboxUrl) child.mailboxUrl = fields.mailboxUrl;
    const acquireMode = body.mode || body.action || '';
    const shouldRefresh = body.refresh === true || acquireMode === 'refresh-at' || acquireMode === 'free-json';
    const result = await acquireChildAuth(child, {
      refresh: shouldRefresh,
      allowCredentialLogin: acquireMode === 'free-json',
      verificationCode: body.verificationCode,
      callbackUrl: body.callbackUrl,
    });
    return sendJson(res, result.status || 200, result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'team-auth') {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const mother = findMother(body.motherId) || state.mothers.find((item) => item.accountId === String(body.workspaceId || '').trim());
    if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
    const result = await acquireTeamAuth(mother, child, {
      force: body.force !== false,
      verificationCode: body.verificationCode,
      callbackUrl: body.callbackUrl,
    });
    return sendJson(res, result.status || 200, result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'export') {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    if (!child.accessToken) return sendJson(res, 409, { message: 'access_token_required' });
    const exportedAt = now();
    return sendJson(res, 200, { exported_at: exportedAt, exportedAt, scope: 'free', account: sub2ApiAccountFromChild(child) });
  }
  if (method === 'PUT' && segments[1] === 'children' && segments[2] && segments[3] === 'sub2api') {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const parsed = singleSub2ApiAccount(body);
    if (!parsed.ok) return sendJson(res, 400, { message: parsed.message });
    const fields = credentialFields(parsed.account);
    if (isTeamAccount(parsed.account)) return sendJson(res, 409, { message: 'team_sub2api_json_not_allowed' });
    if (!fields.accessToken && !fields.refreshToken) return sendJson(res, 400, { message: 'sub2api_token_required' });
    const incomingEmail = String(fields.email || '').trim();
    const currentEmail = String(child.email || '').trim();
    const emailChanged = incomingEmail && currentEmail && incomingEmail.toLowerCase() !== currentEmail.toLowerCase();
    const childHasCredentials = Boolean(child.accessToken || child.refreshToken || child.password || child.totp || child.mailboxUrl);
    if (emailChanged && childHasCredentials) return sendJson(res, 409, { message: 'child_email_mismatch' });
    const duplicate = incomingEmail && state.children.find((item) => (
      item.id !== child.id && String(item.email || '').trim().toLowerCase() === incomingEmail.toLowerCase()
    ));
    if (duplicate) return sendJson(res, 409, { message: 'child_email_exists', child: publicChild(duplicate) });
    applyFreeSub2ApiAccount(child, parsed.account, fields);
    addHistory('录入 Free JSON', `${child.email} 已保存 Sub2API 完整凭据`);
    await persist();
    return sendJson(res, 200, { child: publicChild(child), state: publicState({ includeHistory: false }) });
  }
  if (method === 'DELETE' && segments[1] === 'children' && segments[2] && !segments[3]) {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    if (childHasActiveTeamMembership(child)) return sendJson(res, 409, { message: 'child_has_active_team_memberships' });
    state.children = state.children.filter((item) => item.id !== child.id);
    addHistory('删除 Free 账号', `${child.email || child.id} 已从本地账号池删除`);
    await persist();
    return sendJson(res, 200, { ok: true, state: publicState({ includeHistory: false }) });
  }
  if (method === 'PATCH' && segments[1] === 'children' && segments[2]) {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    if (body.email !== undefined) child.email = String(body.email || '').trim();
    if (body.password) child.password = String(body.password);
    if (body.totp) child.totp = String(body.totp).trim();
    if (body.mailboxUrl !== undefined) child.mailboxUrl = String(body.mailboxUrl || '').trim();
    addHistory('更新账号', `${child.email} 的账号记录已更新`);
    await persist();
    return sendJson(res, 200, publicChild(child));
  }
  if ((method === 'GET' || method === 'POST') && segments[1] === 'children' && segments[2] && (segments[3] === 'probe' || segments[3] === 'quota')) {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const result = await probeChild(child);
    return sendJson(res, result.ok ? 200 : 502, result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'join') {
    const child = findChild(segments[2]);
    const result = await joinWorkspace(child, body);
    return sendJson(res, result.ok ? (result.phase === 'requested' ? 202 : 200) : (result.status || 502), result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'switch') {
    const child = findChild(segments[2]);
    const result = await switchWorkspaceWithFreeRecovery(child, body.workspaceId, { verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
    return sendJson(res, result.ok ? 200 : (result.status || 502), result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'kick') {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const oldTeam = child.team;
    const mother = state.mothers.find((item) => item.team === oldTeam);
    if (!oldTeam || !mother) return sendJson(res, 409, { message: 'child_workspace_not_configured' });
    if (!teamManagerContext(mother)) await recoverTeamManagerToken(mother);
    if (!teamManagerContext(mother) || !mother.accountId) return sendJson(res, 400, { message: 'workspace_credentials_required' });
    let member = (mother.members || []).find((item) => (
      (child.memberId && item.id === child.memberId)
      || (item.email && child.email && item.email.toLowerCase() === child.email.toLowerCase())
    ));
    if (!member?.id) {
      const listed = await queryAllWorkspaceMembers(mother, child.email);
      member = listed.items?.find((item) => item.email && child.email && item.email.toLowerCase() === child.email.toLowerCase());
    }
    if (!member?.id) return sendJson(res, 404, { message: 'workspace_member_not_found' });
    if (memberIsProtected(member, mother)) return sendJson(res, 403, { message: 'protected_workspace_member' });
    if (workspaceMemberCount(mother, 2) <= 1) return sendJson(res, 409, { message: 'minimum_workspace_member_required' });
    const remote = await removeWorkspaceMember(mother, member);
    if (!remote.ok) return sendJson(res, remote.status || 502, { message: remote.message || 'workspace_member_remove_failed', remote });
    child.status = 'kicked';
    child.retryReason = body.reason || 'manual';
    const removedAt = now();
    const membership = membershipFor(child, oldTeam, true);
    Object.assign(membership, {
      status: 'kicked',
      removedAt,
      reason: child.retryReason,
      retryAfter: body.retryAfter || null,
      rejoinEligible: true,
    });
    child.team = null;
    const replacement = (child.workspaceHistory || []).find((entry) => entry.status === 'active' && entry.team);
    child.team = replacement?.team || null;
    removeTeamOwnerForChild(mother, child);
    if (child.team) child.status = 'active';
    mother.members = (mother.members || []).filter((item) => item.id !== member.id);
    if (Number.isFinite(Number(mother.used))) mother.used = Math.max(0, Number(mother.used) - 1);
    addHistory('移出 Team', `${child.email} 已从 ${oldTeam} 移除`);
    await persist();
    return sendJson(res, 200, publicChild(child));
  }
  if (method === 'POST' && url.pathname === '/api/maintenance/check') {
    const result = await withMaintenanceLock('http_check_team', () => checkTeam(body.motherId));
    return sendJson(res, result.status === 409 ? 409 : 200, result);
  }
  if (method === 'POST' && url.pathname === '/api/maintenance/check-all') {
    const result = await withMaintenanceLock('http_check_all', () => checkAllTeams());
    return sendJson(res, result.status === 409 ? 409 : 200, result);
  }
  if (method === 'POST' && url.pathname === '/api/maintenance/refill') {
    const result = await withMaintenanceLock('http_refill_team', () => refillTeam(body.motherId));
    return sendJson(res, result.status === 409 ? 409 : 200, result);
  }
  if (method === 'POST' && url.pathname === '/api/maintenance/refill-all') {
    const result = await withMaintenanceLock('http_refill_all', () => refillAllTeams());
    return sendJson(res, result.status === 409 ? 409 : 200, result);
  }
  if (method === 'POST' && url.pathname === '/api/sub2api/export') {
    const items = state.children.filter((child) => child.accessToken).map(sub2ApiAccountFromChild);
    const exportedAt = now();
    return sendJson(res, 200, { exported_at: exportedAt, exportedAt, proxies: [], accounts: items });
  }
  if (method === 'POST' && url.pathname === '/api/sub2api/team-export') {
    const motherIds = Array.isArray(body.motherIds) ? body.motherIds : body.motherId ? [body.motherId] : [];
    const accounts = teamSub2ApiEntries(motherIds).map((entry) => entry.payload);
    const exportedAt = now();
    return sendJson(res, 200, { exported_at: exportedAt, exportedAt, scope: 'team', proxies: [], accounts });
  }
  if (method === 'POST' && url.pathname === '/api/sub2api/push') {
    return sendJson(res, 200, await pushSub2ApiAccounts(body.ids));
  }
  if (method === 'POST' && url.pathname === '/api/sub2api/team-push') {
    const motherIds = Array.isArray(body.motherIds) ? body.motherIds : body.motherId ? [body.motherId] : [];
    return sendJson(res, 200, await pushSub2ApiTeams(motherIds));
  }
  return sendJson(res, 404, { message: 'route_not_found' });
}

let requestQueue = Promise.resolve();
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    res.securityHeaders = corsHeaders(req);
    if ((url.pathname === '/mcp' || url.pathname.startsWith('/api/')) && !requestOriginAllowed(req)) {
      return sendJson(res, 403, { code: 'origin_not_allowed', message: '请求来源不允许' });
    }
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const distRoot = path.join(root, 'dist');
    const file = path.resolve(root, `dist${requested}`);
    const relativeFile = path.relative(distRoot, file);
    if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) return sendText(res, 403, 'Forbidden');
    if (!existsSync(file)) return sendText(res, 404, 'Not Found');
    const content = await readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {
      ...responseHeaders(res),
      'content-type': type,
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:8786 http://localhost:8786; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }); res.end(content);
  } catch (error) { sendJson(res, 400, { message: error?.message || 'request_failed' }); }
}
const server = createServer((req, res) => {
  requestQueue = requestQueue.then(() => handleRequest(req, res)).catch((error) => {
    if (!res.headersSent) sendJson(res, 500, { message: error?.message || 'request_failed' });
  });
});

server.listen(port, host, () => {
  if (process.env.DISABLE_MAINTENANCE !== 'true') {
    configureMaintenanceTimer();
    setTimeout(() => { void runMaintenanceCycle(); }, 1500).unref?.();
  }
  console.log(`team-rotation server listening on http://${host}:${port}`);
});

// OAuth uses a localhost callback that is easier to complete in the user's
// browser than through a second copy of the login flow. Keep only the short-
// lived code/state pair in memory; the next acquire request exchanges it with
// the PKCE verifier kept on the matching Free account.
const oauthCallbackPort = Number(process.env.OPENAI_CALLBACK_PORT || 1455);
if (process.env.OPENAI_CALLBACK_ENABLED !== 'false' && Number.isInteger(oauthCallbackPort) && oauthCallbackPort > 0 && oauthCallbackPort < 65536) {
  const oauthCallbackServer = createServer((req, res) => {
    try {
      const callback = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (callback.pathname !== '/auth/callback' || !storeOAuthCallback(callback.toString())) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Invalid OAuth callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>Quota Hub</title><p>验证完成，可以返回 Quota Hub 点击“获取 Free JSON”。</p>');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid OAuth callback');
    }
  });
  oauthCallbackServer.on('error', (error) => console.warn(`OAuth callback listener unavailable on ${oauthCallbackPort}: ${error?.code || error?.message || 'error'}`));
  oauthCallbackServer.listen(oauthCallbackPort, '127.0.0.1', () => console.log(`OAuth callback listener on http://127.0.0.1:${oauthCallbackPort}/auth/callback`));
}
