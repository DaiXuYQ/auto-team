import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { accessTokenClaims, isOpenAiAuthFailure, refreshOpenAiAccessToken } from './openai-auth.mjs';
import { consumeOAuthCallback, loginFreeAccount, storeOAuthCallback } from './openai-login.mjs';
import { createProxyFetch, maskProxyUrl, parseProxyInput, publicProxySettings } from './proxy.mjs';
import { createStateStorage, isLoopbackHost, secureTokenEqual } from './security.mjs';
import { inviteApprovalPayloads, normalizeInviteSeatType, reconcileAcceptedSeatUsage, selectInviteSeatType, shouldRetainSeatClaim } from './seat-policy.mjs';
import { excludePreviouslyRemovedMembers, manualKickCooldownAt, manualKickTimerExpired, manualKickTimerState, parseManualKickTimerInput } from './manual-kick-timer.mjs';
import { groupTeamAccounts } from '../shared/team-members.mjs';
import { isChallenge, managementHealth, quotaHealth } from '../shared/team-health.mjs';
import { selectTeamSub2ApiRecords } from './sub2api-scope.mjs';
import { managerLoginCooldown } from './team-manager-recovery.mjs';
import { automaticRotationTeams, normalizeTeamRotationEnabled } from './team-rotation-policy.mjs';
import { currentSeatQuantity, normalizeBillingPreview } from './billing-preview.mjs';

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
    kickAfterHours: 12,
    promoteJoinedAccounts: true,
    concurrency: 3,
    integrations: {
      sub2api: { baseUrl: '', apiKey: '', groupId: null, groupName: '', enabled: false },
      sub2apis: [],
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
const DEFAULT_SUB2API_ID = 'sub2api_default';

function normalizeSub2ApiConfig(input = {}, index = 0) {
  const groupId = Number(input.groupId);
  return {
    id: String(input.id || (index === 0 ? DEFAULT_SUB2API_ID : `sub2api_${index + 1}`)).trim(),
    name: String(input.name || input.label || (index === 0 ? '默认 Sub2API' : `Sub2API ${index + 1}`)).trim(),
    baseUrl: String(input.baseUrl || '').trim(),
    apiKey: String(input.apiKey || '').trim(),
    groupId: Number.isFinite(groupId) && groupId > 0 ? groupId : null,
    groupName: String(input.groupName || '').trim(),
    enabled: input.enabled === true,
  };
}

function normalizeSub2ApiIntegrations() {
  const integrations = state.settings.integrations || (state.settings.integrations = structuredClone(emptyState.settings.integrations));
  const configured = Array.isArray(integrations.sub2apis) && integrations.sub2apis.length
    ? integrations.sub2apis
    : [{ ...(integrations.sub2api || {}), id: DEFAULT_SUB2API_ID, name: integrations.sub2api?.name || '默认 Sub2API' }];
  const seen = new Set();
  integrations.sub2apis = configured.map((item, index) => {
    const normalized = normalizeSub2ApiConfig(item, index);
    if (!normalized.id || seen.has(normalized.id)) normalized.id = `sub2api_${index + 1}`;
    seen.add(normalized.id);
    return normalized;
  });
  integrations.sub2api = { ...integrations.sub2apis[0] };
  const fallbackId = integrations.sub2apis[0]?.id || DEFAULT_SUB2API_ID;
  for (const mother of state.mothers || []) {
    if (!String(mother.sub2apiIntegrationId || '').trim()) mother.sub2apiIntegrationId = fallbackId;
  }
}

function sub2ApiConfigs() {
  return state.settings?.integrations?.sub2apis || [];
}

function sub2ApiConfigById(id) {
  const target = String(id || '').trim();
  return sub2ApiConfigs().find((config) => config.id === target) || null;
}

function sub2ApiConfigForMother(mother) {
  const selectedId = String(mother?.sub2apiIntegrationId || '').trim();
  return selectedId ? sub2ApiConfigById(selectedId) : sub2ApiConfigs()[0] || null;
}

function publicSub2ApiConfig(config = {}) {
  return {
    id: config.id || DEFAULT_SUB2API_ID,
    name: config.name || 'Sub2API',
    baseUrl: config.baseUrl || '',
    enabled: config.enabled === true,
    groupId: Number.isFinite(Number(config.groupId)) ? Number(config.groupId) : null,
    groupName: config.groupName || '',
    apiKeySet: Boolean(config.apiKey),
  };
}

function replaceSub2ApiConfigs(inputs) {
  const current = new Map(sub2ApiConfigs().map((config) => [config.id, config]));
  const source = Array.isArray(inputs) && inputs.length
    ? inputs
    : [{ id: DEFAULT_SUB2API_ID, name: '默认 Sub2API', enabled: false }];
  state.settings.integrations.sub2apis = source.map((input, index) => {
    const existing = current.get(String(input?.id || '')) || {};
    const apiKey = input?.apiKey === undefined ? existing.apiKey : input.apiKey;
    return normalizeSub2ApiConfig({ ...existing, ...(input || {}), apiKey }, index);
  });
  state.settings.integrations.sub2api = { ...state.settings.integrations.sub2apis[0] };
  normalizeSub2ApiIntegrations();
}

normalizeSub2ApiIntegrations();
function normalizeConcurrency(value, fallback = 3) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(10, Math.max(1, Math.floor(numeric))) : fallback;
}
function normalizeKickWindow(value, fallback = '5h') {
  return ['5h', '7d', 'time'].includes(String(value || '').trim()) ? String(value).trim() : fallback;
}
function normalizeKickAfterHours(value, fallback = 12) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(720, Math.max(1, Math.floor(numeric))) : fallback;
}
state.settings.kickWindow = normalizeKickWindow(state.settings.kickWindow);
state.settings.kickAfterHours = normalizeKickAfterHours(state.settings.kickAfterHours);
state.settings.concurrency = normalizeConcurrency(state.settings.concurrency);
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
  rotationEnabled: normalizeTeamRotationEnabled(mother.rotationEnabled),
  inviteSeatType: normalizeInviteSeatType(mother.inviteSeatType),
  dailyRotationLimit: normalizeDailyRotationLimit(mother.dailyRotationLimit),
  primaryOwnerEmail: mother.primaryOwnerEmail || mother.email || '',
  tokenScope: 'team',
  planType: mother.planType || 'team',
  seatClaims: (Array.isArray(mother.seatClaims) ? mother.seatClaims : []).filter((claim) => claim && (claim.childId || claim.email)).map((claim) => ({
    id: claim.id || randomUUID(),
    workspaceId: String(claim.workspaceId || mother.accountId || mother.team || '').trim() || null,
    childId: claim.childId || null,
    email: String(claim.email || '').trim(),
    inviteId: claim.inviteId || null,
    seatType: claim.seatType === 'prolite' ? 'prolite' : 'default',
    phase: claim.phase || 'accepted_pending_sync',
    createdAt: claim.createdAt || now(),
    updatedAt: claim.updatedAt || claim.createdAt || now(),
    acceptedAt: claim.acceptedAt || null,
    error: claim.error || null,
  })),
}));
let activeOutboundRequests = 0;
const outboundRequestQueue = [];

function drainOutboundRequestQueue() {
  const limit = normalizeConcurrency(state.settings.concurrency);
  while (activeOutboundRequests < limit && outboundRequestQueue.length) {
    activeOutboundRequests += 1;
    outboundRequestQueue.shift()();
  }
}

function withOutboundConcurrency(operation) {
  return new Promise((resolve, reject) => {
    outboundRequestQueue.push(async () => {
      try {
        resolve(await operation());
      } catch (error) {
        reject(error);
      } finally {
        activeOutboundRequests = Math.max(0, activeOutboundRequests - 1);
        drainOutboundRequestQueue();
      }
    });
    drainOutboundRequestQueue();
  });
}

async function mapWithConcurrency(items, operation, limit = state.settings.concurrency) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(values.length, normalizeConcurrency(limit)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const rawProxyFetch = createProxyFetch(() => state.settings.proxy);
const proxyFetch = (...args) => withOutboundConcurrency(() => rawProxyFetch(...args));
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
        try {
          await rename(tmp, stateFile);
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EEXIST'].includes(error?.code)) throw error;
          await writeFile(stateFile, snapshot, 'utf8');
          await unlink(tmp).catch(() => {});
        }
  });
  return writeQueue;
}

if (stateStorage.legacyPlaintextLoaded) await persist();
for (const entry of await readdir(dataDir).catch(() => [])) {
  if (!/^state\.json\.\d+\.tmp$/.test(entry)) continue;
  await unlink(path.join(dataDir, entry)).catch(() => {});
}

function now() { return new Date().toISOString(); }
function normalizeDailyRotationLimit(value, fallback = 3) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(1, Math.floor(numeric))) : fallback;
}
function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function dailyRotationUsage(mother, { mutate = false } = {}) {
  const date = localDateKey();
  const stored = mother?.dailyRotationUsage && typeof mother.dailyRotationUsage === 'object'
    ? mother.dailyRotationUsage
    : {};
  const count = stored.date === date && Number.isFinite(Number(stored.count))
    ? Math.max(0, Math.floor(Number(stored.count)))
    : 0;
  const usage = { date, count };
  if (mutate && mother) mother.dailyRotationUsage = usage;
  return usage;
}
function dailyRotationBudget(mother) {
  const limit = normalizeDailyRotationLimit(mother?.dailyRotationLimit);
  const usage = dailyRotationUsage(mother);
  return { ...usage, limit, remaining: Math.max(0, limit - usage.count) };
}
function consumeDailyRotation(mother) {
  const usage = dailyRotationUsage(mother, { mutate: true });
  usage.count += 1;
  mother.dailyRotationUsage = usage;
  return dailyRotationBudget(mother);
}
function addHistory(action, detail, result = 'success', meta = {}) {
  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  state.history = [{ id: randomUUID(), time: now(), action, detail, result, ...safeMeta }, ...state.history].slice(0, 200);
}
function preview(value) {
  if (!value || typeof value !== 'string') return '';
  return value.length <= 12 ? `${value.slice(0, 3)}...` : `${value.slice(0, 8)}...${value.slice(-4)}`;
}
function membershipFor(child, teamId, create = false) {
  if (!child || !teamId) return null;
  if (!Array.isArray(child.workspaceHistory)) child.workspaceHistory = [];
  const teamKey = workspaceIdKey(teamId);
  let entry = child.workspaceHistory.find((item) => workspaceIdKey(item.team || item.workspaceId) === teamKey && item.status === 'active');
  if (!entry && create) {
    entry = { team: teamId, joinedAt: now(), status: 'active' };
    child.workspaceHistory.push(entry);
  }
  return entry || null;
}

function publicManualKickTimerFields(membership) {
  const timer = manualKickTimerState(membership);
  return {
    manualKickEnabled: timer.enabled,
    manualKickStartedAt: timer.startedAt,
    manualKickAt: timer.kickAt,
    manualKickDurationMinutes: timer.durationMinutes,
    manualKickExpired: timer.expired,
    manualKickRemainingSeconds: timer.remainingSeconds,
    lastManualKick: membership?.lastManualKick && typeof membership.lastManualKick === 'object'
      ? { ...membership.lastManualKick }
      : null,
  };
}

function clearManualKickTimer(membership, outcome, completedAt = now()) {
  if (!membership) return null;
  const timer = manualKickTimerState(membership);
  if (timer.enabled) {
    membership.lastManualKick = {
      startedAt: timer.startedAt,
      kickAt: timer.kickAt,
      durationMinutes: timer.durationMinutes,
      completedAt,
      outcome,
    };
  }
  membership.manualKickEnabled = false;
  membership.manualKickStartedAt = null;
  membership.manualKickAt = null;
  membership.manualKickDurationMinutes = null;
  return timer;
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
    if (childIsBanned(child)) continue;
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
    if (childIsBanned(child)) return false;
    if (!isChildMemberOfTeam(child, mother?.team)) return false;
    const email = String(child.email || '').trim().toLowerCase();
    const isOwner = childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother) || ownerEmails.has(email) || linkedIds.has(String(child.id));
    return isOwner && Boolean(child.accessToken || child.refreshToken || (child.email && child.password));
  });
}

async function recoverTeamManagerToken(mother, { force = false, allowCredentialLogin = true, primaryOnly = false, bypassCooldown = false } = {}) {
  if (!mother?.accountId) return { ok: false, status: 400, message: 'workspace_id_required' };
  const workspaceId = mother.accountId;
  if (primaryOnly && !force && !teamTokenDetails(mother.accessToken, workspaceId)) {
    const primaryEmail = String(mother.primaryOwnerEmail || mother.email || '').trim().toLowerCase();
    const linkedChild = state.children.find((child) => (
      !childIsBanned(child)
      && String(child.email || '').trim().toLowerCase() === primaryEmail
      && isChildMemberOfTeam(child, mother.team)
    ));
    const childToken = workspaceTokenFor(linkedChild, workspaceId);
    const owner = (mother.ownerAccounts || []).find((item) => String(item?.email || '').trim().toLowerCase() === primaryEmail);
    const candidates = [
      childToken ? { source: 'linked_primary_child_token', record: childToken } : null,
      owner?.accessToken ? { source: 'linked_primary_owner_token', record: owner } : null,
    ].filter(Boolean);
    const selected = candidates.find((candidate) => teamTokenDetails(candidate.record.accessToken, workspaceId));
    if (selected) {
      const claims = accessTokenClaims(selected.record.accessToken);
      mother.accessToken = selected.record.accessToken;
      mother.refreshToken = selected.record.refreshToken || mother.refreshToken || '';
      mother.idToken = selected.record.idToken || mother.idToken || '';
      mother.clientId = selected.record.clientId || mother.clientId || '';
      mother.chatgptUserId = selected.record.userId || selected.record.chatgptUserId || mother.chatgptUserId || '';
      mother.expiresAt = claims.expiresAt || selected.record.expiresAt || mother.expiresAt || null;
      mother.token = preview(selected.record.accessToken);
      addHistory('恢复 Team 管理凭据', `${mother.email || primaryEmail} 已复用关联账号的新 Team Token`);
      await persist();
      return { ok: true, status: 200, source: selected.source };
    }
  }
  if (!force && (primaryOnly ? teamTokenDetails(mother.accessToken, workspaceId) : teamManagerContext(mother))) {
    return { ok: true, status: 200, source: 'stored_team_token' };
  }
  const records = primaryOnly ? [mother] : [mother, ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts : [])];
  let lastFailure = null;
  // Periodic quota checks must never start an interactive OAuth login. They can
  // still use a stored refresh token; credential login is reserved for manual
  // setup/refill actions.
  for (const record of records) {
    if (!record?.refreshToken) continue;
    const refreshed = await refreshOpenAiAccessToken(record.refreshToken, record.clientId, OPENAI_REQUEST_TIMEOUT_MS, proxyFetch);
    if (!refreshed.ok) continue;
    const claims = refreshed.claims || accessTokenClaims(refreshed.accessToken);
    if (claims.accountId !== workspaceId) continue;
    record.refreshToken = refreshed.refreshToken || record.refreshToken;
    record.idToken = refreshed.idToken || record.idToken;
    record.accessToken = refreshed.accessToken;
    record.expiresAt = claims.expiresAt || record.expiresAt || null;
    addHistory('刷新 Team 管理凭据', `${record.email || mother.email} 已通过 refresh token 恢复 ${mother.team}`);
    await persist();
    return { ok: true, status: 200, source: 'team_refresh_token' };
  }
  if (!allowCredentialLogin) {
    return { ok: false, status: 401, message: 'workspace_owner_token_required', code: 'stored_token_unavailable' };
  }
  const retryAfterMs = bypassCooldown ? 0 : managerLoginCooldown(mother.lastManagerRecoveryAttemptAt);
  if (retryAfterMs) {
    return { ok: false, status: 429, code: 'workspace_manager_recovery_cooldown', message: 'workspace_manager_recovery_cooldown', retryAfterMs };
  }
  mother.lastManagerRecoveryAttemptAt = now();
  await persist();
  if (!primaryOnly) {
    for (const child of teamOwnerCandidateChildren(mother)) {
      const exchanged = await switchWorkspaceWithFreeRecovery(child, mother.accountId);
      if (exchanged.ok) {
        addHistory('恢复 Team 管理凭据', `${child.email} 已重新取得 ${mother.team} 的管理 Token`);
        await persist();
        return { ok: true, status: 200, source: exchanged.freeAuth?.source || 'workspace_exchange', childId: child.id };
      }
      lastFailure = exchanged;
    }
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
    record.refreshToken = workspaceToken.refreshToken || record.refreshToken || '';
    record.idToken = workspaceToken.idToken || record.idToken || '';
    record.expiresAt = workspaceToken.expiresAt || record.expiresAt || null;
    record.teamAuthSessions = {};
    addHistory('重新登录 Team 所有者', `${record.email} 已通过邮箱、密码和 2FA 恢复 ${mother.team}`);
    await persist();
    return { ok: true, status: 200, source: 'team_email_password_2fa' };
  }
  return { ok: false, status: lastFailure?.status || 401, message: lastFailure?.message || 'workspace_owner_token_required', code: lastFailure?.code || null };
}
function saveWorkspaceToken(child, workspaceId, accessToken, claims = {}, oauth = {}) {
  if (!child || !workspaceId || !accessToken) return null;
  if (!child.workspaceTokens || typeof child.workspaceTokens !== 'object' || Array.isArray(child.workspaceTokens)) child.workspaceTokens = {};
  const previous = child.workspaceTokens[workspaceId] || {};
  const record = {
    ...previous,
    accessToken,
    accountId: claims.accountId || workspaceId,
    userId: claims.userId || child.chatgptUserId || null,
    expiresAt: claims.expiresAt || null,
    refreshToken: oauth.refreshToken ?? previous.refreshToken ?? '',
    idToken: oauth.idToken ?? previous.idToken ?? '',
    clientId: oauth.clientId ?? previous.clientId ?? child.clientId ?? '',
    sub2api: oauth.sub2api ?? previous.sub2api ?? null,
    acquiredAt: now(),
    source: oauth.source || 'workspace_session_exchange',
  };
  child.workspaceTokens[workspaceId] = record;
  return record;
}
function membershipHistoryFor(child, teamId) {
  if (!child || !teamId || !Array.isArray(child.workspaceHistory)) return [];
  const teamKey = workspaceIdKey(teamId);
  return child.workspaceHistory.filter((item) => item && workspaceIdKey(item.team || item.workspaceId) === teamKey);
}
function latestMembershipHistoryFor(child, teamId) {
  const entries = membershipHistoryFor(child, teamId);
  return entries.length ? entries[entries.length - 1] : null;
}
function canRejoinTeam(child, teamId) {
  if (!child || !teamId) return false;
  if (child.banStatus === 'banned' || child.status === 'banned') return false;
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
  return workspaceIdKey(child.team) === workspaceIdKey(teamId) && child.status !== 'kicked' && !history.some((entry) => ['kicked', 'cooldown'].includes(entry.status));
}

function seatClaimsForMother(mother) {
  if (!mother) return [];
  if (!Array.isArray(mother.seatClaims)) mother.seatClaims = [];
  return mother.seatClaims;
}

function workspaceIdKey(value) {
  return String(value || '').trim().toLowerCase();
}

function configuredTeamKey(mother) {
  return workspaceIdKey(configuredTeamId(mother));
}

function workspaceVisibleMemberCount(mother) {
  const teamKey = configuredTeamKey(mother);
  const records = teamKey
    ? state.mothers.filter((candidate) => configuredTeamKey(candidate) === teamKey)
    : [mother];
  return records.reduce((maximum, candidate) => {
    const count = Array.isArray(candidate?.members) ? candidate.members.filter(memberIsActive).length : 0;
    return Math.max(maximum, count);
  }, 0);
}

function seatClaimEntriesForWorkspace(mother) {
  const teamKey = configuredTeamKey(mother);
  if (!teamKey) return seatClaimsForMother(mother).map((claim) => ({ mother, claim }));
  return state.mothers.flatMap((candidate) => seatClaimsForMother(candidate)
    .filter((claim) => workspaceIdKey(claim.workspaceId || configuredTeamId(candidate)) === teamKey)
    .map((claim) => ({ mother: candidate, claim })));
}

function seatClaimMatchesChild(claim, child) {
  const childId = String(child?.id || '');
  const email = String(child?.email || '').trim().toLowerCase();
  return Boolean(
    (childId && String(claim?.childId || '') === childId)
    || (email && String(claim?.email || '').trim().toLowerCase() === email)
  );
}

function seatClaimForChild(mother, child) {
  return seatClaimEntriesForWorkspace(mother).find(({ claim }) => seatClaimMatchesChild(claim, child))?.claim || null;
}

function anySeatClaimForChild(child) {
  return state.mothers.some((mother) => seatClaimsForMother(mother).some((claim) => seatClaimMatchesChild(claim, child)));
}

function seatClaimReservations(mother) {
  const claims = seatClaimEntriesForWorkspace(mother).map(({ claim }) => claim);
  return claims.reduce((result, claim) => {
    const type = claim?.seatType === 'prolite' ? 'prolite' : 'default';
    result[type] += 1;
    return result;
  }, { default: 0, prolite: 0 });
}

function reserveSeatClaim(mother, child, seatType, inviteId, workspaceId = configuredTeamId(mother)) {
  const existing = seatClaimForChild(mother, child);
  const timestamp = now();
  if (existing) {
    Object.assign(existing, {
      inviteId: inviteId || existing.inviteId || null,
      seatType: seatType === 'prolite' ? 'prolite' : 'default',
      phase: 'approval_pending',
      updatedAt: timestamp,
    });
    return existing;
  }
  const claim = {
    id: randomUUID(),
    workspaceId: String(workspaceId || '').trim() || null,
    childId: child?.id || null,
    email: String(child?.email || '').trim(),
    inviteId: inviteId || null,
    seatType: seatType === 'prolite' ? 'prolite' : 'default',
    phase: 'approval_pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  seatClaimsForMother(mother).push(claim);
  return claim;
}

function releaseSeatClaim(mother, claim) {
  if (!mother || !claim) return;
  for (const candidate of state.mothers) {
    candidate.seatClaims = seatClaimsForMother(candidate).filter((entry) => entry.id !== claim.id);
  }
}

function reconcileSeatClaimsWithMembers(mother, members) {
  if (!mother || !Array.isArray(members)) return;
  const emails = new Set(members.filter(memberIsActive).map((member) => String(member.email || '').trim().toLowerCase()).filter(Boolean));
  const ids = new Set(members.filter(memberIsActive).flatMap((member) => [member.id, member.accountUserId]).filter(Boolean).map(String));
  const teamKey = configuredTeamKey(mother);
  for (const candidate of state.mothers) {
    candidate.seatClaims = seatClaimsForMother(candidate).filter((claim) => {
      if (workspaceIdKey(claim.workspaceId || configuredTeamId(candidate)) !== teamKey) return true;
      const email = String(claim.email || '').trim().toLowerCase();
      const child = claim.childId ? findChild(claim.childId) : null;
      return !(
        (email && emails.has(email))
        || (child?.memberId && ids.has(String(child.memberId)))
        || (child?.accountUserId && ids.has(String(child.accountUserId)))
      );
    });
  }
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
    seatType: entry.seatType || null,
    quota5h: entry.quota5h ?? null,
    quota7d: entry.quota7d ?? null,
    quotaUpdatedAt: entry.quotaUpdatedAt || null,
    ...publicManualKickTimerFields(entry),
  })).filter((entry) => entry.team);
  if (child.team && !joinedTeams.some((entry) => entry.team === child.team && entry.status === 'active')
    && !joinedTeams.some((entry) => entry.team === child.team && ['kicked', 'cooldown'].includes(entry.status))) {
    joinedTeams.push({ team: child.team, status: 'active', joinedAt: child.joinedAt || null, removedAt: null, retryAfter: null, reason: null, seatType: child.memberSnapshot?.seatType || null, quota5h: child.quota5h ?? null, quota7d: child.quota7d ?? null, quotaUpdatedAt: child.lastQuotaCheckAt || null, ...publicManualKickTimerFields(null) });
  }
  return {
    ...safe,
    quota5h: membership?.quota5h ?? child.quota5h ?? null,
    quota7d: membership?.quota7d ?? child.quota7d ?? null,
    quotaSnapshot: membership?.quotaSnapshot || child.quotaSnapshot || null,
    seatType: membership?.seatType || child.memberSnapshot?.seatType || child.seatType || null,
    ...publicManualKickTimerFields(membership),
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
      synced: child.sub2api?.synced === true,
      integrationId: child.sub2api?.integrationId || null,
      integrationName: child.sub2api?.integrationName || '',
      accountId: child.sub2api?.accountId || null,
      groupId: child.sub2api?.groupId || null,
      groupName: child.sub2api?.groupName || '',
      message: child.sub2api?.message || '',
      syncedAt: child.sub2api?.syncedAt || null,
    },
    tokenScope: 'free',
    banStatus: child.banStatus === 'banned' || child.status === 'banned' ? 'banned' : 'clear',
    bannedAt: child.bannedAt || null,
    banReason: child.banReason || '',
    banEvidence: child.banEvidence || null,
    joinedTeams,
  };
}
function publicMother(mother) {
  const { accessToken, refreshToken, idToken, password, totp, secret, cookies, sessionJson, credentials, authSession, teamAuthSessions, workspaceTokens, workspaceHistory, verificationCode, loginUrl, token, ownerAccounts, seatClaims, ...safe } = mother;
  const sub2apiConfig = sub2ApiConfigForMother(mother);
  const seatReservations = seatClaimReservations(mother);
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
    rotationEnabled: normalizeTeamRotationEnabled(mother.rotationEnabled),
    inviteSeatType: normalizeInviteSeatType(mother.inviteSeatType),
    seatClaimsCount: seatReservations.default + seatReservations.prolite,
    dailyRotationLimit: normalizeDailyRotationLimit(mother.dailyRotationLimit),
    syncOwnerToSub2api: mother.syncOwnerToSub2api !== false,
    dailyRotationUsage: dailyRotationBudget(mother),
    sub2apiIntegrationId: mother.sub2apiIntegrationId || sub2apiConfig?.id || null,
    sub2apiIntegrationName: sub2apiConfig?.name || '',
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
  const seatReservations = seatClaimReservations(mother);
  const reservedSeats = seatReservations.default + seatReservations.prolite;
  const currentAccounts = [];
  const ownerEmails = new Set([mother.email, ...(mother.ownerAccounts || []).map((owner) => owner.email)].filter(Boolean).map((email) => String(email).toLowerCase()));
  const authoritativeMembers = mother.lastMembersProbe?.ok === true;
  const memberGroups = groupTeamAccounts((mother.members || []).filter(memberIsActive), children, { authoritativeMembers });
  for (const group of memberGroups) {
    const { member, child } = group;
    if (child) {
      const memberSnapshot = member || child.memberSnapshot || {};
      const owner = memberIsOwner(memberSnapshot, mother) || ownerEmails.has(String(child.email || '').toLowerCase());
      const childProjection = publicChild(child, teamId);
      const ownerProjection = owner ? publicTeamOwnerRecord(mother, child.email) : null;
      currentAccounts.push({
        ...childProjection,
        ...(ownerProjection || {}),
        id: childProjection.id,
        email: childProjection.email || memberSnapshot.email || '',
        name: childProjection.name || memberSnapshot.name || ownerProjection?.name || '',
        memberId: childProjection.memberId || memberSnapshot.id || null,
        accountUserId: childProjection.accountUserId || memberSnapshot.accountUserId || memberSnapshot.account_user_id || null,
        quota5h: childProjection.quota5h,
        quota7d: childProjection.quota7d,
        quotaSnapshot: childProjection.quotaSnapshot,
        credentialsStatus: childProjection.credentialsStatus || ownerProjection?.credentialsStatus || null,
        accountType: owner ? 'team-owner' : 'team-member',
        role: owner ? (memberSnapshot.role || 'account-owner') : memberSnapshot.role || null,
        seatType: memberSnapshot.seatType || memberSnapshot.seat_type || childProjection.seatType || null,
        joinedAt: childProjection.joinedAt || memberSnapshot.createdTime || memberSnapshot.created_time || null,
      });
    } else if (member) {
      const memberOwner = memberIsOwner(member, mother) ? publicTeamOwnerRecord(mother, member.email) : null;
      currentAccounts.push({
        id: member.id || member.accountUserId || `member_${currentAccounts.length}`,
        memberId: member.id || null,
        accountUserId: member.accountUserId || member.account_user_id || null,
        email: member.email || '',
        name: member.name || '',
        ...(memberOwner || {}),
        accountType: memberIsOwner(member, mother) ? 'team-owner' : 'team-member',
        role: member.role || null,
        seatType: member.seatType || null,
        status: member.deactivatedTime ? 'inactive' : 'active',
        quota5h: null,
        quota7d: null,
        credentialsStatus: member.email?.toLowerCase() === mother.email?.toLowerCase() ? { hasPassword: Boolean(mother.password), hasTotp: Boolean(mother.totp || mother.secret), hasAccessToken: Boolean(mother.accessToken) } : null,
        joinedTeams: [{ team: teamId, status: 'active', joinedAt: member.createdTime || null }],
      });
    }
  }
  for (const owner of authoritativeMembers ? [] : (mother.ownerAccounts || [])) {
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
  if (!authoritativeMembers && !currentAccounts.some((account) => account.email?.toLowerCase() === mother.email?.toLowerCase()) && mother.email) {
    currentAccounts.unshift({ id: mother.chatgptUserId || `owner_${mother.id}`, email: mother.email, ...publicTeamOwnerRecord(mother, mother.email), accountType: 'team-owner', status: 'active', quota5h: null, quota7d: null, joinedTeams: [{ team: teamId, status: 'active', joinedAt: mother.createdAt || null }] });
  }
  const primaryOwner = currentAccounts.find((account) => String(account.email || '').toLowerCase() === primaryOwnerEmail.toLowerCase()) || currentAccounts.find((account) => account.accountType === 'team-owner');
  const sub2apiConfig = sub2ApiConfigForMother(mother);
  return {
    id: mother.id,
    teamId,
    name: displayName,
    displayName,
    rotationMode: mother.rotationMode === 'rotating' ? 'rotating' : 'fixed',
    rotationEnabled: normalizeTeamRotationEnabled(mother.rotationEnabled),
    inviteSeatType: normalizeInviteSeatType(mother.inviteSeatType),
    dailyRotationLimit: normalizeDailyRotationLimit(mother.dailyRotationLimit),
    dailyRotationUsage: dailyRotationBudget(mother),
    owner: { email: primaryOwner?.email || mother.email || '', name: primaryOwner?.name || mother.name || '', userId: primaryOwner?.id || mother.chatgptUserId || null },
    primaryOwnerEmail,
    owners: currentAccounts.filter((account) => account.accountType === 'team-owner').map((account) => ({ email: account.email || '', name: account.name || '', userId: account.id || null })),
    seats: {
      used: Number.isFinite(seatsInUse) ? seatsInUse : null,
      entitled: Number.isFinite(seatsEntitled) ? seatsEntitled : null,
      open: Number.isFinite(seatsInUse) && Number.isFinite(seatsEntitled) ? Math.max(0, seatsEntitled - seatsInUse) : null,
      reserved: reservedSeats,
    },
    status: mother.status || 'unconfigured',
    lastCheck: mother.lastCheck || null,
    lastSync: mother.lastWorkspaceSyncAt || null,
    sub2apiIntegrationId: mother.sub2apiIntegrationId || sub2apiConfig?.id || null,
    sub2apiIntegrationName: sub2apiConfig?.name || '',
    rotationProgress: mother.rotationProgress || null,
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
  const safeSub2Apis = sub2ApiConfigs().map(publicSub2ApiConfig);
  const safeSettings = {
    ...state.settings,
    integrations: {
      sub2api: safeSub2Apis[0] || publicSub2ApiConfig(integrations.sub2api),
      sub2apis: safeSub2Apis,
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
function configuredTeamId(mother) {
  const accountId = String(mother?.accountId || '').trim();
  if (accountId) return accountId;
  const team = String(mother?.team || '').trim();
  return team && team !== String(mother?.id || '').trim() ? team : '';
}
function canonicalTeamId(mother) { return configuredTeamId(mother) || mother?.id || ''; }
function teamDisplayName(mother) { return mother?.teamName || mother?.displayName || '未命名 Team'; }
function primaryOwnerRecord(mother) {
  const primaryEmail = String(mother?.primaryOwnerEmail || mother?.email || '').toLowerCase();
  return [mother, ...(mother?.ownerAccounts || [])].find((owner) => String(owner?.email || '').toLowerCase() === primaryEmail) || mother;
}
function promotePrimaryOwner(mother) {
  const owner = primaryOwnerRecord(mother);
  if (!owner || owner === mother) return;
  // Changing the primary operator must never change the Team workspace itself.
  for (const key of ['email', 'password', 'totp', 'mailboxUrl', 'accessToken', 'refreshToken', 'chatgptUserId', 'clientId', 'idToken', 'organizationId', 'modelMapping', 'expiresAt', 'subscriptionExpiresAt', 'quotaSnapshot', 'quota5h', 'quota7d', 'quota5hResetAfterSeconds', 'quota7dResetAfterSeconds', 'quota5hResetAt', 'quota7dResetAt', 'quotaUpdatedAt']) {
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
  const primaryFields = ['teamName', 'seats', 'used', 'accountId', 'team', 'subscription', 'seatSnapshot', 'dailyRotationLimit', 'inviteSeatType', 'rotationEnabled'];
  for (const key of primaryFields) {
    if ((mother[key] === '' || mother[key] === null || mother[key] === undefined) && imported[key] !== '' && imported[key] !== null && imported[key] !== undefined) mother[key] = imported[key];
  }
  if (mother.accountId) mother.team = String(mother.accountId).trim();
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
      if (!childIsBanned(child)) child.status = child.accessToken ? 'active' : 'login_required';
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
    const detail = payload && typeof payload === 'object' ? payload.detail || payload.error_description || payload.error?.message || payload.error?.code || payload.error || payload.message : '';
    const message = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `http_${response.status}`;
    return { ok: response.ok, status: response.status, payload, latencyMs: Date.now() - started, message: response.ok ? 'ok' : message, errorCode: payload?.code || payload?.error?.code || null, location: response.headers.get('location') };
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
  if (!childIsBanned(child)) child.status = child.team ? 'active' : 'ready';
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
    team: fields.accountId || item.team || item.workspaceName || '',
    teamName: item.teamName || item.displayName || item.workspaceName || item.workspace_name || '',
    rotationMode: item.rotationMode === 'rotating' ? 'rotating' : 'fixed',
    rotationEnabled: normalizeTeamRotationEnabled(item.rotationEnabled ?? item.rotation_enabled),
    inviteSeatType: normalizeInviteSeatType(item.inviteSeatType ?? item.invite_seat_type),
    dailyRotationLimit: normalizeDailyRotationLimit(item.dailyRotationLimit ?? item.daily_rotation_limit),
    primaryOwnerEmail: item.primaryOwnerEmail || item.primary_owner_email || fields.email || '',
    sub2apiIntegrationId: sub2ApiConfigById(item.sub2apiIntegrationId)?.id || sub2ApiConfigs()[0]?.id || DEFAULT_SUB2API_ID,
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
    const errorValue = payload?.detail || payload?.error_description || payload?.error?.message || payload?.error?.code || payload?.error;
    const errorMessage = typeof errorValue === 'string' ? errorValue : errorValue ? JSON.stringify(errorValue) : `http_${response.status}`;
    return { ok: response.ok, status: response.status, message: response.ok ? 'ok' : errorMessage, errorCode: payload?.code || payload?.error?.code || null, latencyMs: Date.now() - started, planType: payload.plan_type || payload.planType, limitReached: Boolean(limit.limit_reached ?? limit.limitReached), primary: readWindow(limit.primary_window || limit.primaryWindow), secondary: readWindow(limit.secondary_window || limit.secondaryWindow), source: 'wham/usage' };
  } catch (error) {
    return { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', latencyMs: Date.now() - started, primary: readWindow(), secondary: readWindow() };
  }
}

// K12's liveness flow distinguishes an explicit OpenAI account suspension from
// ordinary expired-token/network failures. Only run it after the quota probe
// fails, so healthy accounts do not spend an extra Responses request.
async function probeAccountLiveness(accessToken, accountId) {
  if (!accessToken) return { ok: false, status: 0, message: 'missing_token', banned: false };
  const started = Date.now();
  try {
    const response = await proxyFetch(`${CHATGPT_BASE_URL}/backend-api/codex/responses`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream, application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'openai-beta': 'responses=experimental',
        originator: 'opencode',
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
      body: JSON.stringify({ model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], instructions: 'You are a helpful assistant.', stream: true, store: false }),
      signal: AbortSignal.timeout(Math.max(10000, Math.min(45000, OPENAI_REQUEST_TIMEOUT_MS * 3))),
    });
    const raw = await response.text().catch(() => '');
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    const value = payload?.error?.message || payload?.error?.code || payload?.detail || payload?.message || raw.slice(0, 500) || `http_${response.status}`;
    const message = typeof value === 'string' ? value : JSON.stringify(value);
    return { ok: response.ok, status: response.status, message: response.ok ? 'ok' : message, banned: !response.ok && Boolean(explicitAccountBanMessage(message)), latencyMs: Date.now() - started, source: 'codex/responses' };
  } catch (error) {
    return { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error', banned: false, latencyMs: Date.now() - started, source: 'codex/responses' };
  }
}

function explicitAccountBanMessage(...values) {
  for (const value of values) {
    const message = value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? [value.message, value.errorCode, value.code].filter(Boolean).join(' ')
          : '';
    if (/account_deactivated|account disabled|account has been (?:deleted|deactivated|disabled|suspended|banned|terminated)|account.*(?:suspended|banned|terminated|deactivated|disabled)|user.*(?:suspended|banned|terminated|deactivated|disabled)|账号已停用|账户已停用|账号已被删除|账户已被删除|账号已封|账号被封|封号|被封禁|账户被封|停用/i.test(message)) return message;
  }
  return '';
}

function childIsBanned(child) {
  return child?.banStatus === 'banned' || child?.status === 'banned';
}

function markChildBanned(child, mother, evidence = {}) {
  if (!child) return false;
  const detectedAt = now();
  const reason = explicitAccountBanMessage(evidence) || 'OpenAI 账号已被停用或封禁';
  const wasBanned = childIsBanned(child);
  child.banStatus = 'banned';
  child.status = 'banned';
  child.bannedAt = child.bannedAt || detectedAt;
  child.banReason = child.banReason || reason;
  child.banEvidence = {
    teamId: canonicalTeamId(mother) || null,
    source: evidence.source || 'team_quota_probe',
    status: Number.isFinite(Number(evidence.status)) ? Number(evidence.status) : null,
    code: evidence.errorCode || evidence.code || null,
    message: reason,
    detectedAt,
  };
  if (!wasBanned) addHistory('检测到封号', `${child.email} 已确认封禁，永久移出 Free 补位池`, 'partial');
  return !wasBanned;
}

function normalizeSubscription(payload, accountId) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const capacities = Array.isArray(record.seat_capacity) ? record.seat_capacity : Array.isArray(record.seatCapacity) ? record.seatCapacity : [];
  const rawSeatsInUse = record.seats_in_use ?? record.seatsInUse;
  const rawSeatsEntitled = record.seats_entitled ?? record.seatsEntitled;
  const seatsInUse = rawSeatsInUse === null || rawSeatsInUse === undefined || rawSeatsInUse === '' ? null : Number(rawSeatsInUse);
  const seatsEntitled = rawSeatsEntitled === null || rawSeatsEntitled === undefined || rawSeatsEntitled === '' ? null : Number(rawSeatsEntitled);
  return {
    id: record.id || accountId || null,
    planType: record.plan_type || record.planType || null,
    seatsInUse: Number.isFinite(seatsInUse) ? seatsInUse : null,
    seatsEntitled: Number.isFinite(seatsEntitled) ? seatsEntitled : null,
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
  // Subscription/seat data is scoped to the primary Team account. Do not use
  // a rotating member or secondary owner here: those tokens may authenticate
  // successfully but are not guaranteed to have billing/seat permissions.
  const attempted = await fetchChatGptJson(mother.accessToken, requestPath, {
    accountId: mother.accountId,
    targetPath: '/backend-api/subscriptions',
    targetRoute: '/backend-api/subscriptions',
    headers: { ...(mother.deviceId ? { 'oai-device-id': mother.deviceId } : {}), ...(mother.cookie ? { cookie: mother.cookie } : {}) },
  });
  if (!attempted) return { ok: false, status: 401, message: 'workspace_owner_token_required', subscription: null };
  const result = attempted;
  return { ...result, accountId: mother.accountId, subscription: result.ok ? normalizeSubscription(result.payload, mother.accountId) : null };
}

function applyMotherSubscription(mother, subscription) {
  if (!mother || !subscription) return;
  mother.subscription = subscription;
  mother.seatSnapshot = subscription;
  mother.seats = subscription.seatsEntitled;
  const remoteUsed = subscription.seatsInUse !== null && subscription.seatsInUse !== '' && Number.isFinite(Number(subscription.seatsInUse))
    ? Math.max(0, Number(subscription.seatsInUse))
    : 0;
  const visibleMembers = workspaceVisibleMemberCount(mother);
  const reservations = seatClaimReservations(mother);
  const claimed = reservations.default + reservations.prolite;
  const effectiveUsed = Math.max(remoteUsed, visibleMembers) + claimed;
  const entitled = subscription.seatsEntitled !== null && subscription.seatsEntitled !== '' && Number.isFinite(Number(subscription.seatsEntitled))
    ? Math.max(0, Number(subscription.seatsEntitled))
    : null;
  mother.used = entitled == null ? effectiveUsed : Math.min(entitled, effectiveUsed);
}

function seatAdmissionSnapshot(mother) {
  const snapshot = mother?.seatSnapshot || mother?.subscription || {};
  const remoteUsed = snapshot.seatsInUse !== null && snapshot.seatsInUse !== '' && Number.isFinite(Number(snapshot.seatsInUse))
    ? Math.max(0, Number(snapshot.seatsInUse))
    : null;
  const visibleMembers = workspaceVisibleMemberCount(mother);
  return {
    ...snapshot,
    seatsEntitled: snapshot.seatsEntitled ?? mother?.seats ?? null,
    seatsInUse: remoteUsed == null ? (visibleMembers || null) : Math.max(remoteUsed, visibleMembers),
  };
}

async function refreshMotherSubscription(mother, { allowCredentialLogin = true, unauthorizedOnly = false } = {}) {
  if (!teamTokenDetails(mother?.accessToken, mother?.accountId)) {
    await recoverTeamManagerToken(mother, { allowCredentialLogin, primaryOnly: true });
  }
  let result = await queryWorkspaceSubscription(mother);
  const shouldRecover = unauthorizedOnly
    ? Number(result?.status) === 401 || result?.message === 'missing_token'
    : isOpenAiAuthFailure(result);
  if (shouldRecover) {
    const recovered = await recoverTeamManagerToken(mother, { force: true, allowCredentialLogin, primaryOnly: true });
    if (recovered.ok) result = await queryWorkspaceSubscription(mother);
  }
  if (result.ok && result.subscription) applyMotherSubscription(mother, result.subscription);
  return result;
}

function normalizeExpiryThresholdDays(value, fallback = 7) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(365, Math.max(1, Math.floor(numeric))) : fallback;
}

async function requestWorkspaceBillingPreview(mother, updatedSeats) {
  const params = new URLSearchParams({ account_id: mother.accountId, updated_seats: String(updatedSeats) });
  return fetchChatGptJson(mother.accessToken, `/backend-api/subscriptions/update/preview?${params}`, {
    accountId: mother.accountId,
    targetPath: '/backend-api/subscriptions/update/preview',
    targetRoute: '/backend-api/subscriptions/update/preview',
    headers: { ...(mother.deviceId ? { 'oai-device-id': mother.deviceId } : {}), ...(mother.cookie ? { cookie: mother.cookie } : {}) },
  });
}

async function requestSingleSeatBillingPreview(mother, initialSeats) {
  let updatedSeats = Number.isInteger(Number(initialSeats)) && Number(initialSeats) >= 2 ? Number(initialSeats) : 3;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestWorkspaceBillingPreview(mother, updatedSeats);
    if (!result.ok) return { ...result, updatedSeats, attempt };
    const currentSeats = currentSeatQuantity(result.payload);
    if (currentSeats == null) return { ok: false, status: 502, message: 'billing_preview_current_seats_missing', updatedSeats, attempt };
    const expectedUpdatedSeats = currentSeats + 1;
    if (updatedSeats === expectedUpdatedSeats) return { ...result, currentSeats, updatedSeats, attempt };
    updatedSeats = expectedUpdatedSeats;
  }
  return { ok: false, status: 409, message: 'billing_preview_seats_changed_repeatedly', updatedSeats, attempt: 3 };
}

async function queryWorkspaceBillingPreview(mother, { thresholdDays = 7 } = {}) {
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  const identity = {
    motherId: mother.id,
    teamId: canonicalTeamId(mother),
    teamName: teamDisplayName(mother),
    ownerEmail: mother.email || '',
  };
  if (!mother.accountId) return { ...identity, ok: false, status: 400, message: 'workspace_id_required' };

  const normalizedThreshold = normalizeExpiryThresholdDays(thresholdDays);
  const subscriptionResult = await refreshMotherSubscription(mother, { allowCredentialLogin: true, unauthorizedOnly: true });
  const subscription = subscriptionResult.subscription || mother.subscription || mother.seatSnapshot || {};
  const currentSeats = Number(subscription.seatsEntitled ?? mother.seats);
  const initialSeats = Number.isInteger(currentSeats) && currentSeats >= 1 ? currentSeats + 1 : 3;

  let previewResult = await requestSingleSeatBillingPreview(mother, initialSeats);
  let managerRecovery = null;
  if (Number(previewResult?.status) === 401 || previewResult?.message === 'missing_token') {
    managerRecovery = await recoverTeamManagerToken(mother, { force: true, allowCredentialLogin: true, primaryOnly: true });
    if (managerRecovery.ok) previewResult = await requestSingleSeatBillingPreview(mother, initialSeats);
  }
  if (!previewResult.ok) {
    mother.lastBillingPreviewProbe = {
      ok: false,
      previewOk: false,
      subscriptionOk: subscriptionResult.ok === true,
      status: previewResult.status,
      message: previewResult.message,
      checkedAt: now(),
    };
    return {
      ...identity,
      ok: false,
      status: previewResult.status || 502,
      code: previewResult.errorCode || null,
      message: previewResult.message || 'billing_preview_failed',
      cached: mother.billingPreview || null,
      managerRecovery: managerRecovery ? { ok: managerRecovery.ok, code: managerRecovery.code || null, message: managerRecovery.message || '' } : null,
    };
  }

  const normalized = normalizeBillingPreview(previewResult.payload, {
    updatedSeats: previewResult.updatedSeats,
    activeUntil: subscription.activeUntil,
    willRenew: subscription.willRenew,
    isDelinquent: subscription.isDelinquent,
    billingPeriod: subscription.billingPeriod,
    thresholdDays: normalizedThreshold,
    fetchedAt: now(),
  });
  if (!normalized.ok) {
    mother.lastBillingPreviewProbe = { ok: false, status: 502, message: normalized.message, checkedAt: now() };
    return { ...identity, ...normalized, status: 502, cached: mother.billingPreview || null };
  }

  const subscriptionFresh = subscriptionResult.ok === true;
  const billingPreview = {
    ...normalized,
    ok: subscriptionFresh,
    partial: !subscriptionFresh,
    subscriptionFresh,
    subscriptionStatus: subscriptionResult.status || null,
    subscriptionMessage: subscriptionResult.message || null,
    activeUntilSource: subscriptionFresh ? 'live' : (normalized.activeUntil ? 'cached' : 'unavailable'),
  };
  mother.billingPreview = billingPreview;
  if (!subscriptionResult.ok) {
    const subscriptionStatus = Number(subscriptionResult.status);
    const status = Number.isInteger(subscriptionStatus) && subscriptionStatus >= 400 && subscriptionStatus <= 599
      ? subscriptionStatus
      : 207;
    const message = subscriptionResult.message || 'workspace_subscription_failed';
    mother.lastBillingPreviewProbe = {
      ok: false,
      previewOk: true,
      subscriptionOk: false,
      status,
      message,
      checkedAt: now(),
    };
    return {
      ...identity,
      ...billingPreview,
      ok: false,
      partial: true,
      status,
      code: subscriptionResult.errorCode || null,
      message,
    };
  }
  mother.lastBillingPreviewProbe = {
    ok: true,
    previewOk: true,
    subscriptionOk: true,
    status: 200,
    message: 'ok',
    checkedAt: now(),
  };
  return { ...identity, status: 200, ...billingPreview };
}

async function scanWorkspaceBillingPreviews({ motherIds = [], thresholdDays = 7 } = {}) {
  const ids = new Set((Array.isArray(motherIds) ? motherIds : []).map(String).filter(Boolean));
  const mothers = state.mothers.filter((mother) => !ids.size || ids.has(String(mother.id)) || ids.has(String(canonicalTeamId(mother))));
  const normalizedThreshold = normalizeExpiryThresholdDays(thresholdDays);
  const items = await mapWithConcurrency(mothers, async (mother) => {
    try {
      return await queryWorkspaceBillingPreview(mother, { thresholdDays: normalizedThreshold });
    } catch (error) {
      const message = error?.message || 'billing_preview_unexpected_error';
      mother.lastBillingPreviewProbe = { ok: false, status: 500, message, checkedAt: now() };
      return {
        motherId: mother.id,
        teamId: canonicalTeamId(mother),
        teamName: teamDisplayName(mother),
        ownerEmail: mother.email || '',
        ok: false,
        status: 500,
        message,
        cached: mother.billingPreview || null,
      };
    }
  });
  items.sort((left, right) => {
    if (left.ok !== right.ok) return left.ok ? -1 : 1;
    const leftTime = Date.parse(left.activeUntil || '');
    const rightTime = Date.parse(right.activeUntil || '');
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
    if (!Number.isFinite(rightTime)) return -1;
    return leftTime - rightTime;
  });
  const succeeded = items.filter((item) => item.ok).length;
  const failed = items.length - succeeded;
  const expiring = items.filter((item) => ['due_soon', 'expired', 'cancelling', 'delinquent'].includes(item.expiryStatus)).length;
  addHistory('查询临期 Team', `查询 ${items.length} 个 Team，临期或异常 ${expiring} 个，失败 ${failed} 个`, failed ? 'partial' : 'success');
  await persist();
  return {
    ok: items.length > 0 && failed === 0,
    status: failed ? 207 : 200,
    thresholdDays: normalizedThreshold,
    total: items.length,
    succeeded,
    failed,
    expiring,
    checkedAt: now(),
    items,
  };
}

async function syncMotherWorkspace(mother, { query = '', force = false, allowCredentialLogin = true, excludedMemberIds = [], excludedMemberEmails = [] } = {}) {
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  if (!teamManagerContext(mother)) await recoverTeamManagerToken(mother, { allowCredentialLogin });
  if (!teamTokenDetails(mother.accessToken, mother.accountId)) {
    await recoverTeamManagerToken(mother, { allowCredentialLogin, primaryOnly: true });
  }
  let [subscriptionResult, membersResult] = await Promise.all([
    queryWorkspaceSubscription(mother),
    queryAllWorkspaceMembers(mother),
  ]);
  if (isOpenAiAuthFailure(subscriptionResult)) {
    const recovered = await recoverTeamManagerToken(mother, { force: true, allowCredentialLogin, primaryOnly: true });
    if (recovered.ok) subscriptionResult = await queryWorkspaceSubscription(mother);
  }
  if (isOpenAiAuthFailure(membersResult)) {
    const recovered = await recoverTeamManagerToken(mother, { force: true, allowCredentialLogin });
    if (recovered.ok) membersResult = await queryAllWorkspaceMembers(mother);
  }
  const subscription = subscriptionResult.subscription;
  const members = excludePreviouslyRemovedMembers(membersResult.items, excludedMemberIds, excludedMemberEmails);
  mother.lastWorkspaceSyncAt = now();
  mother.lastSubscriptionProbe = { ok: subscriptionResult.ok, status: subscriptionResult.status, message: subscriptionResult.message, latencyMs: subscriptionResult.latencyMs };
  mother.lastMembersProbe = { ok: membersResult.ok, status: membersResult.status, message: membersResult.message, latencyMs: membersResult.latencyMs, total: members.length };
  if (membersResult.ok) {
    mother.members = members;
    reconcileSeatClaimsWithMembers(mother, members);
  }
  if (subscription) applyMotherSubscription(mother, subscription);
  else if (mother.subscription) applyMotherSubscription(mother, mother.subscription);
  const activeMembers = members.filter(memberIsActive);
  for (const child of state.children) {
    const member = activeMembers.find((entry) => entry.email && child.email && entry.email.toLowerCase() === child.email.toLowerCase());
    if (member && !memberIsProtected(member, mother)) {
      child.accountUserId = member.accountUserId || child.accountUserId;
      child.memberId = member.id || child.memberId;
      child.memberSnapshot = member;
      const latestMembership = latestMembershipHistoryFor(child, mother.team);
      const retryAt = Date.parse(latestMembership?.retryAfter || '');
      const locallyCooling = ['kicked', 'cooldown'].includes(latestMembership?.status)
        && ((Number.isFinite(retryAt) && retryAt > Date.now()) || latestMembership?.rejoinEligible === false);
      if (child.status !== 'kicked' && !locallyCooling) {
        const existingMembership = membershipFor(child, mother.team);
        const membership = existingMembership || membershipFor(child, mother.team, true);
        if (!existingMembership && member.createdTime) membership.joinedAt = member.createdTime;
        membership.source = membership.source || 'member_sync';
        membership.role = member.role || membership.role || null;
        membership.seatType = member.seatType || membership.seatType || null;
        // `team` remains a current-space convenience field; history holds all active memberships.
        child.team = child.team || mother.team;
        child.joinedAt = child.joinedAt || membership.joinedAt;
        if (!childIsBanned(child)) child.status = child.accessToken ? 'active' : 'ready';
      }
    }
  }
  addHistory('同步空间', `${mother.team || mother.accountId} 席位 ${mother.used ?? '-'} / ${mother.seats ?? '-'}，成员 ${members.length}`);
  await persist();
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const returnedMembers = normalizedQuery
    ? members.filter((member) => [member.email, member.name, member.id, member.accountUserId].some((value) => String(value || '').toLowerCase().includes(normalizedQuery)))
    : members;
  return { ok: subscriptionResult.ok && membersResult.ok, status: subscriptionResult.ok && membersResult.ok ? 200 : (subscriptionResult.status || membersResult.status || 502), motherId: mother.id, accountId: mother.accountId, subscription: subscription || null, seatSnapshot: mother.seatSnapshot || null, members: returnedMembers, subscriptionResult: { ok: subscriptionResult.ok, status: subscriptionResult.status, message: subscriptionResult.message }, membersResult: { ok: membersResult.ok, status: membersResult.status, message: membersResult.message } };
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

async function kickChildFromWorkspace(childId, body = {}) {
  const child = findChild(childId);
  if (!child) return { status: 404, payload: { message: 'child_not_found' } };
  const oldTeam = child.team;
  const mother = state.mothers.find((item) => configuredTeamKey(item) === workspaceIdKey(oldTeam));
  if (!oldTeam || !mother) return { status: 409, payload: { message: 'child_workspace_not_configured' } };
  if (!teamManagerContext(mother)) await recoverTeamManagerToken(mother);
  if (!teamManagerContext(mother) || !mother.accountId) return { status: 400, payload: { message: 'workspace_credentials_required' } };
  const listed = await queryAllWorkspaceMembers(mother);
  if (!listed.ok) return { status: listed.status || 502, payload: { message: listed.message || 'workspace_members_refresh_failed' } };
  mother.members = listed.items || [];
  reconcileSeatClaimsWithMembers(mother, mother.members);
  const member = mother.members.find((item) => (
    (child.memberId && item.id === child.memberId)
    || (item.email && child.email && item.email.toLowerCase() === child.email.toLowerCase())
  ));
  if (!member?.id) return { status: 404, payload: { message: 'workspace_member_not_found' } };
  if (memberIsProtected(member, mother)) return { status: 403, payload: { message: 'protected_workspace_member' } };
  if (workspaceMemberCount(mother, 2) <= 1) return { status: 409, payload: { message: 'minimum_workspace_member_required' } };
  const remote = await removeWorkspaceMember(mother, member);
  if (!remote.ok) return { status: remote.status || 502, payload: { message: remote.message || 'workspace_member_remove_failed', remote } };
  releaseSeatClaim(mother, seatClaimForChild(mother, child));
  const banned = childIsBanned(child);
  child.status = banned ? 'banned' : 'kicked';
  child.retryReason = body.reason || 'manual';
  const removedAt = now();
  const membership = membershipFor(child, oldTeam, true);
  clearManualKickTimer(membership, banned ? 'account_banned' : 'manual_removal', removedAt);
  Object.assign(membership, {
    status: 'kicked',
    removedAt,
    reason: child.retryReason,
    retryAfter: body.retryAfter || null,
    rejoinEligible: banned ? false : true,
  });
  child.team = null;
  const replacement = (child.workspaceHistory || []).find((entry) => entry.status === 'active' && entry.team);
  child.team = replacement?.team || null;
  removeTeamOwnerForChild(mother, child);
  if (child.team && !banned) child.status = 'active';
  mother.members = (mother.members || []).filter((item) => item.id !== member.id);
  if (Number.isFinite(Number(mother.used))) mother.used = Math.max(0, Number(mother.used) - 1);
  addHistory('移出 Team', `${child.email} 已从 ${oldTeam} 移除`);
  await persist();
  return { status: 200, payload: publicChild(child) };
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
  if (!childIsBanned(child)) child.status = 'active';
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
  if (membership?.role) return memberIsOwner({ email: child?.email, role: membership.role }, mother);
  if (membership?.ownerRoleStatus) return membership.ownerRoleStatus === 'applied';
  const email = String(child?.email || '').trim().toLowerCase();
  const currentMember = (mother?.members || []).find((member) => String(member?.email || '').trim().toLowerCase() === email);
  if (currentMember) return memberIsOwner(currentMember, mother);
  return child?.team === mother?.team
    && (child?.ownerRoleStatus === 'applied' || memberIsOwner(child?.memberSnapshot, mother));
}

function childMatchesKnownTeamOwner(child, mother) {
  const email = String(child?.email || '').trim().toLowerCase();
  if (!email || !mother) return false;
  const membership = membershipFor(child, mother.team);
  if (membership?.role && !memberIsOwner({ email: child.email, role: membership.role }, mother)) return false;
  if (membership?.ownerRoleStatus === 'skipped') return false;
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
    refreshToken: workspaceToken.refreshToken || existing.refreshToken || '',
    idToken: workspaceToken.idToken || existing.idToken || '',
    clientId: workspaceToken.clientId || child.clientId || existing.clientId || '',
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
  const primaryEmail = String(mother.primaryOwnerEmail || mother.email || '').trim().toLowerCase();
  if (target === primaryEmail) {
    mother.accessToken = workspaceToken.accessToken;
    mother.refreshToken = workspaceToken.refreshToken || mother.refreshToken || '';
    mother.idToken = workspaceToken.idToken || mother.idToken || '';
    mother.clientId = workspaceToken.clientId || child.clientId || mother.clientId || '';
    mother.chatgptUserId = workspaceToken.userId || child.chatgptUserId || mother.chatgptUserId || '';
    mother.expiresAt = workspaceToken.expiresAt || mother.expiresAt || null;
    mother.token = preview(workspaceToken.accessToken);
  }
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
  let attempted = await withTeamManager(mother, (manager) => probeUsage(manager.accessToken, mother.accountId));
  let result = attempted?.result || await probeUsage('', mother.accountId);
  const workspace = await syncMotherWorkspace(mother, { force: true });
  if (isOpenAiAuthFailure(result)) {
    attempted = await withTeamManager(mother, (manager) => probeUsage(manager.accessToken, mother.accountId));
    result = attempted?.result || result;
  }
  mother.lastCheck = now();
  mother.lastProbe = result;
  const banReason = explicitAccountBanMessage(result);
  Object.assign(mother, quotaHealth(result, banReason));
  mother.banReason = banReason || '';
  mother.bannedAt = banReason ? (mother.bannedAt || now()) : null;
  mother.managementStatus = managementHealth(workspace.membersResult, workspace.subscriptionResult);
  result.seatSnapshot = workspace.seatSnapshot;
  result.members = workspace.members;
  result.subscriptionOk = workspace.subscriptionResult?.ok || false;
  result.membersOk = workspace.membersResult?.ok || false;
  result.membersResult = workspace.membersResult;
  result.subscriptionResult = workspace.subscriptionResult;
  result.accountStatus = mother.accountStatus;
  result.managementStatus = mother.managementStatus;
  result.banReason = mother.banReason || null;
  return result;
}

function selectedKickWindow(mother = null) {
  const configured = normalizeKickWindow(state.settings?.kickWindow);
  // A time-based policy is explicit and applies to every Team rotation mode.
  if (configured === 'time') return 'time';
  // Rotating spaces use the long quota window so a seat is only replaced after
  // its weekly allowance is exhausted. Fixed spaces follow the global setting.
  if (mother?.rotationMode === 'rotating') return '7d';
  return configured;
}

function quotaIsExhausted(child, result, window = selectedKickWindow()) {
  if (window === 'time') return false;
  const selected = window === '7d' ? result?.secondary : result?.primary;
  return Boolean(result?.ok && selected?.usedPercent != null && selected.usedPercent >= 99.99);
}

function quotaRetryAfter(child, window = selectedKickWindow(), teamId = null) {
  if (window === 'time') return new Date(Date.now() + normalizeKickAfterHours(state.settings?.kickAfterHours) * 60 * 60 * 1000).toISOString();
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
  if (window === 'time') return 'time_elapsed';
  return window === '7d' ? 'quota_7d' : 'quota_5h';
}

function membershipQuotaIsExhausted(child, teamId, window = selectedKickWindow()) {
  if (window === 'time') return false;
  const membership = latestMembershipHistoryFor(child, teamId);
  if (!membership) return false;
  if (membership.quotaStatus === 'exhausted' && membership.quotaStatusWindow === window) return true;
  return quotaIsExhausted(child, membership.lastProbe, window);
}

function childManualKickTimerExpired(child, teamId, currentTime = Date.now()) {
  return manualKickTimerExpired(membershipFor(child, teamId), currentTime);
}

function teamHasExpiredManualKickTimers(mother, currentTime = Date.now()) {
  const teamId = canonicalTeamId(mother);
  return state.children.some((child) => (
    isChildMemberOfTeam(child, teamId)
    && childManualKickTimerExpired(child, teamId, currentTime)
  ));
}

function teamHasActiveManualKickTimers(mother) {
  const teamId = canonicalTeamId(mother);
  return state.children.some((child) => (
    isChildMemberOfTeam(child, teamId)
    && membershipFor(child, teamId)?.manualKickEnabled === true
  ));
}

function timeKickExpired(child, teamId, afterHours = state.settings?.kickAfterHours) {
  const membership = membershipFor(child, teamId);
  // An explicitly started member timer replaces the joinedAt-based deadline.
  // A malformed explicit timer fails closed instead of causing an early kick.
  if (membership?.manualKickEnabled === true) return manualKickTimerExpired(membership);
  const joinedAt = membership?.joinedAt || (child?.team === teamId ? child.joinedAt : null);
  const joinedTimestamp = Date.parse(joinedAt || '');
  if (!Number.isFinite(joinedTimestamp)) return false;
  const hours = normalizeKickAfterHours(afterHours);
  return Date.now() >= joinedTimestamp + hours * 60 * 60 * 1000;
}

function childIsProtectedForManualKick(child, mother) {
  if (mother?.rotationMode !== 'fixed') return false;
  const email = String(child?.email || '').trim().toLowerCase();
  const primaryEmail = String(mother.primaryOwnerEmail || mother.email || '').trim().toLowerCase();
  if (email && primaryEmail && email === primaryEmail) return true;
  const member = (mother.members || []).find((item) => (
    (child?.memberId && item.id === child.memberId)
    || (item.email && email && String(item.email).trim().toLowerCase() === email)
  ));
  return Boolean(member && memberIsProtected(member, mother));
}

async function updateManualKickTimers(motherId, body = {}) {
  const mother = findMother(motherId);
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };

  const rawIds = Array.isArray(body.childIds)
    ? body.childIds
    : Array.isArray(body.ids)
      ? body.ids
      : body.childId !== undefined
        ? [body.childId]
        : [];
  const childIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!childIds.length) return { ok: false, status: 400, message: 'child_ids_required' };
  if (childIds.length > 500) return { ok: false, status: 400, message: 'too_many_child_ids', maximum: 500 };

  const timerInput = parseManualKickTimerInput(body);
  if (!timerInput.ok) return { ok: false, status: 400, message: timerInput.code, ...timerInput };

  const teamId = canonicalTeamId(mother);
  const updated = [];
  const skipped = [];
  const changedAt = now();
  for (const childId of childIds) {
    const child = findChild(childId);
    if (!child) {
      skipped.push({ id: childId, email: '', reason: 'child_not_found' });
      continue;
    }
    if (!isChildMemberOfTeam(child, teamId)) {
      skipped.push({ id: child.id, email: child.email || '', reason: 'child_not_active_in_team' });
      continue;
    }
    if (timerInput.enabled && childIsBanned(child)) {
      skipped.push({ id: child.id, email: child.email || '', reason: 'account_banned' });
      continue;
    }
    if (timerInput.enabled && childIsProtectedForManualKick(child, mother)) {
      skipped.push({ id: child.id, email: child.email || '', reason: 'protected_workspace_member' });
      continue;
    }

    let membership = membershipFor(child, teamId);
    if (!membership && !timerInput.enabled) {
      skipped.push({ id: child.id, email: child.email || '', reason: 'manual_kick_timer_not_active' });
      continue;
    }
    // Legacy records may only have child.team. The membership assertion above
    // makes it safe to materialize their active history when starting a timer.
    if (!membership) membership = membershipFor(child, teamId, true);

    if (!timerInput.enabled) {
      if (membership.manualKickEnabled !== true) {
        skipped.push({ id: child.id, email: child.email || '', reason: 'manual_kick_timer_not_active' });
        continue;
      }
      clearManualKickTimer(membership, 'cancelled', changedAt);
    } else {
      if (membership.manualKickEnabled === true) clearManualKickTimer(membership, 'restarted', changedAt);
      Object.assign(membership, {
        manualKickEnabled: true,
        manualKickStartedAt: timerInput.startedAt,
        manualKickAt: timerInput.kickAt,
        manualKickDurationMinutes: timerInput.durationMinutes,
      });
    }
    updated.push({
      id: child.id,
      email: child.email || '',
      team: teamId,
      ...publicManualKickTimerFields(membership),
    });
  }

  const action = timerInput.enabled ? '启动成员倒计时' : '取消成员倒计时';
  const durationDetail = timerInput.enabled ? `，时长 ${timerInput.durationMinutes} 分钟` : '';
  addHistory(action, `${teamDisplayName(mother)} 更新 ${updated.length} 个账号${durationDetail}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`, skipped.length ? 'partial' : 'success', {
    summary: {
      team: teamId,
      enabled: timerInput.enabled,
      durationMinutes: timerInput.durationMinutes || null,
      kickAt: timerInput.kickAt || null,
      updated: updated.map((item) => ({ id: item.id, email: item.email })),
      skipped,
    },
  });
  await persist();
  return {
    ok: updated.length > 0,
    status: updated.length ? (skipped.length ? 207 : 200) : 409,
    message: updated.length
      ? (skipped.length ? 'manual_kick_timer_partially_updated' : 'manual_kick_timer_updated')
      : skipped[0]?.reason || 'manual_kick_timer_no_accounts_updated',
    enabled: timerInput.enabled,
    updated,
    skipped,
    state: publicState({ includeHistory: false }),
  };
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
  if (!childIsBanned(child) && shouldUpdateAccount && quotaIsExhausted(child, result, window)) child.status = 'exhausted';
  else if (!childIsBanned(child) && shouldUpdateAccount && (result.primary?.usedPercent != null || result.secondary?.usedPercent != null)) {
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

function freeAuthRequiresManualInput(child) {
  return child?.status === 'login_pending'
    || child?.status === 'phone_verification_required'
    || child?.loginStatus === 'phone_verification_required';
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
  child.clientId = result.clientId || child.clientId;
  child.organizationId = result.organizationId || child.organizationId;
  child.subscriptionExpiresAt = result.subscriptionExpiresAt || child.subscriptionExpiresAt;
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
  if (!childIsBanned(child)) child.status = child.team ? 'active' : 'ready';
  setChildLoginState(child, 'ready', '已通过 refresh token 获取新的 AT');
}

function applyLoggedInChildToken(child, result) {
  const claims = result.claims || accessTokenClaims(result.accessToken);
  child.accessToken = result.accessToken;
  child.refreshToken = result.refreshToken || child.refreshToken;
  child.idToken = result.idToken || child.idToken;
  child.clientId = result.clientId || child.clientId;
  child.organizationId = result.organizationId || child.organizationId;
  child.subscriptionExpiresAt = result.subscriptionExpiresAt || child.subscriptionExpiresAt;
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
  if (result.sub2api) {
    child.sub2api = {
      ...(child.sub2api || {}),
      imported: true,
      integrationId: result.sub2api.integrationId || null,
      integrationName: result.sub2api.integrationName || '',
      accountId: result.sub2api.accountId || null,
      groupId: result.sub2api.groupId || null,
      groupName: result.sub2api.groupName || '',
      action: result.sub2api.action || '',
      synced: result.sub2api.synced === true,
      message: result.sub2api.message || '',
      syncedAt: result.sub2api.synced ? now() : null,
    };
  }
  if (!childIsBanned(child)) child.status = child.team ? 'active' : 'ready';
  setChildLoginState(child, 'ready', result.sub2api?.synced
    ? '已完成 Codex OAuth，Free JSON 已生成并同步 Sub2API'
    : result.sub2api
      ? `已生成 Free JSON，Sub2API 同步未完成：${result.sub2api.message || 'unknown_error'}`
      : '已完成登录，Free JSON 已生成');
}

const childAuthQueues = new Map();

async function acquireChildAuth(child, options = {}) {
  if (!child) return { ok: false, status: 404, message: 'child_not_found' };
  const key = String(child.id || child.email || 'unknown');
  const previous = childAuthQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => acquireChildAuthInternal(child, options));
  childAuthQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (childAuthQueues.get(key) === current) childAuthQueues.delete(key);
  }
}

async function acquireChildAuthInternal(child, { refresh = false, verificationCode = '', callbackUrl = '', allowCredentialLogin = false } = {}) {
  if (!child) return { ok: false, status: 404, message: 'child_not_found' };
  if (childIsBanned(child)) return { ok: false, status: 409, code: 'account_banned', message: child.banReason || '账号已封禁，不能刷新或重新获取 JSON', banned: true, child: publicChild(child) };
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
    const refreshBanMessage = explicitAccountBanMessage(refreshed);
    if (refreshBanMessage) {
      markChildBanned(child, null, { source: 'free_refresh_token', status: refreshed.status, code: refreshed.code, message: refreshBanMessage });
      await persist();
      return { ok: false, status: refreshed.status || 403, code: 'account_banned', message: refreshBanMessage, banned: true, child: publicChild(child) };
    }
    setChildLoginState(child, 'login_required', 'refresh token 已失效，需要重新登录获取 AT');
    if (!childIsBanned(child)) child.status = 'login_required';
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
  if (!child.totp && !child.secret) {
    setChildLoginState(child, 'waiting_code', 'Codex OAuth 登录需要现有 2FA Secret');
    await persist();
    return { ok: false, status: 202, code: 'totp_required', message: '请先填写账号现有的 2FA Secret', needsInput: true, child: publicChild(child) };
  }
  if (child.loginStatus === 'phone_verification_required' && !verificationCode && !callbackUrl) {
    child.authSession = null;
    child.loginUrl = null;
  }
  setChildLoginState(child, 'authenticating', '正在使用邮箱、密码和 2FA 登录 OpenAI');
  if (!childIsBanned(child)) child.status = 'login_pending';
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
  const sub2apiConfig = sub2ApiConfigs()[0] || null;
  const oauthAdapter = sub2ApiOAuthAdapter(sub2apiConfig, child, { scope: 'free' });
  const authSession = oauthSessionForAdapter(child.authSession, oauthAdapter);
  const activeOAuthAdapter = authSession?.state && authSession?.codeVerifier && !authSession?.authorization
    ? null
    : oauthAdapter;
  const login = await loginFreeAccount({
    email: child.email,
    password: child.password,
    totp: child.totp || child.secret,
    mailboxUrl,
    mailboxHeaders,
    sentinelProxy,
    verificationCode,
    callbackUrl: callbackUrl || consumeOAuthCallback(authSession?.state),
    session: authSession,
    workspaceId: '',
    workspaceMode: 'free',
    fetch: proxyFetch,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    onProgress: (phase, message) => setChildLoginState(child, phase, message),
    ...(activeOAuthAdapter || {}),
  });
  if (login.ok) {
    const needsPostSync = !login.sub2api && sub2apiConfig?.enabled === true;
    if (needsPostSync) {
      // Persist the new OAuth credentials before attempting the optional
      // integration so a broken Sub2API cannot discard a successful login.
      applyLoggedInChildToken(child, login);
      await persist();
      login.sub2api = await syncSub2ApiAfterLocalOAuth(sub2apiConfig, child, login, { scope: 'free' });
    }
    applyLoggedInChildToken(child, login);
    if (login.oauthFallback) {
      child.loginMessage = `Sub2API OAuth 不可用，已自动回退本地 OAuth；${child.loginMessage}`;
    }
    const syncPartial = Boolean(login.sub2api && !login.sub2api.synced);
    const syncMessage = login.sub2api?.synced
      ? `，已同步到 ${login.sub2api.integrationName || 'Sub2API'}`
      : syncPartial ? `，Sub2API 同步未完成：${login.sub2api.message || 'unknown_error'}` : '';
    const fallbackMessage = login.oauthFallback ? `，已从 ${login.oauthFallback.code} 自动回退本地 OAuth` : '';
    addHistory('登录 Free 账号', `${child.email} 已完成 Codex OAuth 并生成 Free JSON${fallbackMessage}${syncMessage}`, syncPartial ? 'partial' : 'success');
    await persist();
    return { ok: true, status: 200, code: 'ready', source: login.oauthFallback ? 'email_password_2fa' : login.sub2api ? 'sub2api_oauth_email_password_2fa' : 'email_password_2fa', format: 'free-json', partial: syncPartial, oauthFallback: login.oauthFallback || null, sub2api: login.sub2api || null, child: publicChild(child), exportable: true };
  }
  const loginBanMessage = explicitAccountBanMessage(login);
  if (loginBanMessage) markChildBanned(child, null, { source: 'free_oauth_login', status: login.status, code: login.code, message: loginBanMessage });
  const phoneRequired = login.code === 'phone_verification_required';
  child.authSession = phoneRequired ? null : login.session || child.authSession || null;
  child.loginUrl = login.authUrl || null;
  child.loginBrowserRequired = Boolean(login.browserRequired);
  const waiting = login.code === 'email_otp_required' || login.code === 'email_otp_timeout' || login.code === 'totp_required' || login.code === 'totp_invalid';
  const browserRequired = Boolean(login.browserRequired) || login.code === 'browser_verification_required';
  const status = phoneRequired ? 'phone_verification_required' : browserRequired ? 'verification_required' : waiting ? 'waiting_code' : 'login_required';
  const message = phoneRequired
    ? '账号需要手机号验证，自动登录已停止，请完成接码后重试'
    : browserRequired ? '登录需要浏览器验证，请打开授权链接完成验证后重试'
    : login.message || (waiting ? '登录需要验证码，请填写验证码后重试' : '登录失败，请检查凭据或稍后重试');
  setChildLoginState(child, status, message);
  if (!childIsBanned(child)) child.status = phoneRequired ? 'phone_verification_required' : status === 'waiting_code' || status === 'verification_required' ? 'login_pending' : 'login_required';
  addHistory('登录 Free 账号', `${child.email} ${message}`, 'partial');
  await persist();
  return { ok: false, status: login.status || 202, code: loginBanMessage ? 'account_banned' : login.code || (browserRequired ? 'verification_required' : 'login_failed'), message: loginBanMessage || message, banned: Boolean(loginBanMessage), stage: login.stage, browserRequired, needsInput: login.needsInput, authUrl: login.authUrl || null, child: publicChild(child) };
}

async function acquireTeamAuth(mother, child, { verificationCode = '', callbackUrl = '', force = false } = {}) {
  const workspaceId = String(mother?.accountId || '').trim();
  if (!mother || !child || !workspaceId) return { ok: false, status: 400, code: 'workspace_id_required', message: '请先配置目标 Team ID' };
  if (childIsBanned(child)) return { ok: false, status: 409, code: 'account_banned', message: child.banReason || '账号已封禁，不能生成 Team JSON', banned: true, child: publicChild(child, mother.team) };
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
  const authMembership = membershipFor(child, mother.team, true);
  authMembership.teamAuthAttemptedAt = now();
  authMembership.workspaceTokenStatus = 'authenticating';
  child.teamLoginAttemptedAt = authMembership.teamAuthAttemptedAt;
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
  const sub2apiConfig = sub2ApiConfigForMother(mother);
  const oauthAdapter = sub2ApiOAuthAdapter(sub2apiConfig, child, { scope: 'team', workspaceId });
  const compatibleSession = oauthSessionForAdapter(session, oauthAdapter);
  const activeOAuthAdapter = compatibleSession?.state && compatibleSession?.codeVerifier && !compatibleSession?.authorization
    ? null
    : oauthAdapter;
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
    callbackUrl: callbackUrl || consumeOAuthCallback(compatibleSession?.state),
    session: compatibleSession,
    workspaceId,
    workspaceMode: 'team',
    fetch: proxyFetch,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    onProgress: (phase, message) => { child.teamLoginStatus = phase; child.teamLoginMessage = message; },
    ...(activeOAuthAdapter || {}),
  });
  if (!login.ok) {
    const banMessage = explicitAccountBanMessage(login);
    if (banMessage) markChildBanned(child, mother, { source: 'team_oauth_login', status: login.status, code: login.code, message: banMessage });
    child.teamAuthSessions[workspaceId] = login.session || session || null;
    child.teamLoginStatus = login.stage || 'login_required';
    child.teamLoginMessage = login.message || 'Team OAuth 登录失败';
    authMembership.workspaceTokenStatus = 'login_required';
    authMembership.teamAuthLastError = child.teamLoginMessage;
    authMembership.teamAuthRetryAfter = new Date(Date.now() + teamAuthRetryBackoffMs()).toISOString();
    addHistory('Team OAuth 登录', `${child.email} 登录 ${mother.team} 失败：${child.teamLoginMessage}`, 'partial', {
      summary: { team: mother.team, childId: child.id, code: login.code || 'team_login_failed', status: login.status || null },
    });
    await persist();
    return {
      ok: false,
      status: login.status || 202,
      code: banMessage ? 'account_banned' : login.code || 'team_login_failed',
      message: banMessage || login.message || 'Team OAuth 登录失败',
      banned: Boolean(banMessage),
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
    authMembership.workspaceTokenStatus = 'login_required';
    authMembership.teamAuthLastError = child.teamLoginMessage;
    authMembership.teamAuthRetryAfter = new Date(Date.now() + teamAuthRetryBackoffMs()).toISOString();
    await persist();
    return { ok: false, status: 502, code: 'team_workspace_mismatch', message: 'OAuth 登录后未选择目标 Team 空间', accountId: claims.accountId || null, child: publicChild(child, mother.team) };
  }
  child.cookies = login.cookies || child.cookies || null;
  const needsPostSync = !login.sub2api && sub2apiConfig?.enabled === true;
  const workspaceToken = saveWorkspaceToken(child, workspaceId, login.accessToken, claims, {
    refreshToken: login.refreshToken || '',
    idToken: login.idToken || '',
    clientId: login.clientId || child.clientId || '',
    sub2api: login.sub2api || null,
    source: 'team_oauth_email_password_2fa',
  });
  if (needsPostSync) {
    // Quota recovery must use the new Team token immediately. checkTeam runs
    // its repair_only push after the quota recheck, so do not wait on a broken
    // Sub2API connection here or accidentally create a second account.
    login.sub2api = deferredSub2ApiSync(
      sub2apiConfig,
      login.oauthFallback?.message || 'sub2api_repair_deferred_until_quota_recheck',
    );
    workspaceToken.sub2api = login.sub2api;
  }
  delete child.teamAuthSessions[workspaceId];
  child.teamLoginStatus = 'ready';
  const syncPartial = Boolean(login.sub2api && !login.sub2api.synced);
  child.teamLoginMessage = login.sub2api?.synced
    ? '已通过 Codex OAuth 生成 Team JSON 并同步 Sub2API'
    : syncPartial
      ? `已生成 Team JSON，Sub2API 同步未完成：${login.sub2api.message || 'unknown_error'}`
      : '已通过 OAuth 登录并生成 Team JSON';
  if (login.oauthFallback) {
    child.teamLoginMessage = `Sub2API OAuth 不可用，已自动回退本地 OAuth；${child.teamLoginMessage}`;
  }
  child.pendingWorkspaceId = null;
  const membership = authMembership;
  membership.workspaceTokenStatus = 'ready';
  membership.workspaceTokenUpdatedAt = workspaceToken.acquiredAt;
  membership.teamAuthRetryAfter = null;
  membership.teamAuthLastError = null;
  if (!childIsBanned(child) && isChildMemberOfTeam(child, mother.team) && ['login_required', 'login_pending', 'ready'].includes(child.status)) child.status = 'active';
  if (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother)) upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken);
  const syncMessage = login.sub2api?.synced
    ? `，已同步到 ${login.sub2api.integrationName || 'Sub2API'}`
    : syncPartial ? `，Sub2API 同步未完成：${login.sub2api.message || 'unknown_error'}` : '';
  const fallbackMessage = login.oauthFallback ? `，已从 ${login.oauthFallback.code} 自动回退本地 OAuth` : '';
  addHistory('生成 Team JSON', `${child.email} 已通过 OAuth 登录并选择 ${mother.team}${fallbackMessage}${syncMessage}`, syncPartial ? 'partial' : 'success');
  await persist();
  return { ok: true, status: 200, code: 'ready', source: login.oauthFallback ? 'oauth_email_password_2fa_team' : login.sub2api ? 'sub2api_oauth_email_password_2fa_team' : 'oauth_email_password_2fa_team', format: 'team-json', tokenScope: 'team', accountId: workspaceId, expiresAt: workspaceToken.expiresAt, partial: syncPartial, oauthFallback: login.oauthFallback || null, sub2api: login.sub2api || null, exportable: true, child: publicChild(child, mother.team) };
}

function hasTeamLoginCredentials(child) {
  return Boolean(child?.email && child?.password && (child?.totp || child?.secret));
}

function teamAuthRetryBackoffMs() {
  return Math.max(60_000, Number(process.env.TEAM_AUTH_RETRY_BACKOFF_MS) || 300_000);
}

function activeTeamAuthBackoff(child, teamId) {
  const membership = membershipFor(child, teamId);
  const retryAt = Date.parse(membership?.teamAuthRetryAfter || '');
  return Number.isFinite(retryAt) && retryAt > Date.now()
    ? { retryAfter: membership.teamAuthRetryAfter, message: membership.teamAuthLastError || child?.teamLoginMessage || 'Team OAuth 登录暂时失败' }
    : null;
}

function acquireTeamJson(mother, child, { verificationCode = '', callbackUrl = '' } = {}) {
  return hasTeamLoginCredentials(child)
    ? acquireTeamAuth(mother, child, { force: true, verificationCode, callbackUrl })
    : switchWorkspaceWithFreeRecovery(child, mother.accountId, { verificationCode, callbackUrl });
}

function canAutoPushRenewedTeamJson(mother) {
  const config = sub2ApiConfigForMother(mother) || {};
  const groupId = Number(config.groupId);
  return config.enabled === true
    && Boolean(sub2ApiRoot(config.baseUrl))
    && Boolean(config.apiKey)
    && (Number.isFinite(groupId) && groupId > 0 || Boolean(String(config.groupName || '').trim()));
}

async function renewUnauthorizedTeamToken(mother, child, { allowCredentialLogin = false } = {}) {
  if (!mother?.accountId || !child) return { ok: false, status: 400, message: 'workspace_id_or_child_missing', freeRefreshed: false };
  const workspaceId = String(mother.accountId).trim();
  const stored = workspaceTokenFor(child, workspaceId) || workspaceTokenFor(child, mother.team);
  const childEmail = String(child.email || '').trim().toLowerCase();
  const importedTeamOwner = [mother, ...(Array.isArray(mother.ownerAccounts) ? mother.ownerAccounts : [])]
    .find((owner) => childEmail && String(owner?.email || '').trim().toLowerCase() === childEmail && String(owner?.accountId || workspaceId).trim() === workspaceId);
  const teamRefreshToken = stored?.refreshToken || importedTeamOwner?.refreshToken || '';
  const teamClientId = stored?.clientId || importedTeamOwner?.clientId || child.clientId || '';
  if (teamRefreshToken) {
    const refreshed = await refreshOpenAiAccessToken(teamRefreshToken, teamClientId, OPENAI_REQUEST_TIMEOUT_MS, proxyFetch);
    const claims = refreshed.claims || accessTokenClaims(refreshed.accessToken);
    if (refreshed.ok && claims.accountId === workspaceId) {
      const workspaceToken = saveWorkspaceToken(child, workspaceId, refreshed.accessToken, claims, {
        refreshToken: refreshed.refreshToken || teamRefreshToken,
        idToken: refreshed.idToken || stored?.idToken || importedTeamOwner?.idToken || '',
        clientId: teamClientId,
        source: 'team_refresh_token',
      });
      const membership = membershipFor(child, mother.team, true);
      membership.workspaceTokenStatus = 'ready';
      membership.workspaceTokenUpdatedAt = workspaceToken.acquiredAt;
      membership.teamAuthRetryAfter = null;
      membership.teamAuthLastError = null;
      child.teamLoginStatus = 'ready';
      child.teamLoginMessage = '已通过 Team refresh token 自动恢复授权';
      if (!childIsBanned(child) && isChildMemberOfTeam(child, mother.team) && ['login_required', 'login_pending', 'ready'].includes(child.status)) child.status = 'active';
      if (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother)) upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken);
      addHistory('刷新 Team JSON', `${child.email} 已使用 ${mother.team} 自己的 refresh token 更新 OAuth 授权`);
      await persist();
      return { ok: true, status: 200, message: 'team_token_renewed', source: 'team_refresh_token', freeRefreshed: false, credentialLogin: false, credentialLoginAttempted: false };
    }
  }

  if (!allowCredentialLogin) {
    return { ok: false, status: 401, code: 'team_token_refresh_failed', message: 'Team AT 已失效，未找到可用 RT；额度检测不会启动登录流程', freeRefreshed: false, credentialLogin: false, credentialLoginAttempted: false };
  }
  const backoff = activeTeamAuthBackoff(child, mother.team);
  if (backoff) {
    return { ok: false, status: 429, code: 'team_auth_retry_backoff', message: `Team OAuth 自动重登正在退避：${backoff.message}`, retryAfter: backoff.retryAfter, freeRefreshed: false, credentialLogin: false, credentialLoginAttempted: false };
  }
  const teamOAuth = await acquireTeamAuth(mother, child, { force: true });
  if (!teamOAuth.ok) {
    return {
      ok: false,
      status: teamOAuth.status || 502,
      code: teamOAuth.code || 'team_oauth_refresh_failed',
      message: teamOAuth.message || 'team_oauth_refresh_failed',
      freeRefreshed: false,
      credentialLogin: false,
      credentialLoginAttempted: true,
      needsInput: Boolean(teamOAuth.needsInput),
      browserRequired: Boolean(teamOAuth.browserRequired),
      authUrl: teamOAuth.authUrl || null,
    };
  }

  const workspaceToken = workspaceTokenFor(child, workspaceId) || workspaceTokenFor(child, mother.team);
  if (!workspaceToken?.accessToken) return { ok: false, status: 502, message: 'renewed_workspace_token_missing', freeRefreshed: false, credentialLogin: true, credentialLoginAttempted: true };
  if (childIsWorkspaceOwner(child, mother) || childMatchesKnownTeamOwner(child, mother)) {
    upsertTeamOwnerFromChild(mother, child, workspaceId, workspaceToken);
  }
  const fallbackMessage = teamOAuth.oauthFallback ? `，Sub2API OAuth 不可用时已自动回退本地 OAuth（${teamOAuth.oauthFallback.code}）` : '';
  const syncMessage = teamOAuth.sub2api && !teamOAuth.sub2api.synced ? `，Sub2API 同步未完成：${teamOAuth.sub2api.message || 'unknown_error'}` : '';
  addHistory('刷新 Team JSON', `${child.email} 已重新完成 OAuth 登录并选择 ${mother.team}${fallbackMessage}${syncMessage}`, teamOAuth.partial ? 'partial' : 'success');
  await persist();
  return { ok: true, status: 200, message: 'team_token_renewed', source: 'team_oauth_email_password_2fa', freeRefreshed: false, credentialLogin: true, credentialLoginAttempted: true, partial: Boolean(teamOAuth.partial), oauthFallback: teamOAuth.oauthFallback || null, sub2api: teamOAuth.sub2api || null };
}

async function pushRenewedTeamJson(mother, { emails = [], mode = 'create_only' } = {}) {
  if (!canAutoPushRenewedTeamJson(mother)) {
    return { attempted: false, ok: null, status: null, message: 'sub2api_auto_push_not_configured', pushed: 0, failed: 0 };
  }
  const entries = teamSub2ApiEntries([mother.id], emails);
  const result = await pushSub2ApiEntries(entries, mode === 'repair_only' ? '修复 Team Sub2API' : '推送新 Team 账号', {
    config: sub2ApiConfigForMother(mother),
    mode,
  });
  return {
    attempted: true,
    ok: result.ok === true,
    status: result.status || null,
    message: result.message || null,
    pushed: result.pushed?.length || 0,
    failed: result.failed?.length || 0,
    skipped: result.skipped?.length || 0,
  };
}

async function checkTeam(motherId) {
  const mother = findMother(motherId);
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  let managerRecovery = await recoverTeamManagerToken(mother, { allowCredentialLogin: false });
  let workspace = await syncMotherWorkspace(mother, { allowCredentialLogin: false }).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  if (!workspace.ok && isOpenAiAuthFailure(workspace)) {
    // Only a confirmed unauthorized response may enter the credential-login
    // fallback. The sync routine refreshes the primary mother token separately
    // because subscription/seat data cannot be queried through a child owner.
    workspace = await syncMotherWorkspace(mother, { allowCredentialLogin: true }).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
    managerRecovery = { ok: workspace.ok, status: workspace.status, source: workspace.ok ? 'workspace_401_recovery' : null };
  }
  const members = state.children.filter((child) => isChildMemberOfTeam(child, mother.team));
  const ownerAttempt = await withTeamManager(mother, (manager) => probeUsage(manager.accessToken, mother.accountId));
  const ownerProbe = ownerAttempt?.result || await probeUsage('', mother.accountId);
  mother.lastProbe = ownerProbe;
  const ownerBanReason = explicitAccountBanMessage(ownerProbe);
  Object.assign(mother, quotaHealth(ownerProbe, ownerBanReason));
  mother.banReason = ownerBanReason || '';
  mother.bannedAt = ownerBanReason ? (mother.bannedAt || now()) : null;
  mother.managementStatus = managementHealth(workspace.membersResult, workspace.subscriptionResult);
  const kickWindow = selectedKickWindow(mother);
  const results = await mapWithConcurrency(members, async (child) => {
    try {
      const teamOwner = teamOwnerRecords(mother).find((owner) => String(owner.email || '').toLowerCase() === String(child.email || '').toLowerCase());
      const workspaceToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
      const importedOwnerToken = teamTokenDetails(teamOwner?.accessToken, mother.accountId)?.accessToken || '';
      const quotaToken = workspaceToken?.accessToken || importedOwnerToken;
      let result = await probeUsage(quotaToken, mother.accountId);
      let tokenRecovery = null;
      let liveness = null;
      const initialBanMessage = explicitAccountBanMessage(result);
      if (!initialBanMessage && !result.ok && !isChallenge(result)) {
        liveness = await probeAccountLiveness(quotaToken, mother.accountId);
      }
      const livenessBanMessage = liveness?.banned ? explicitAccountBanMessage(liveness) || 'OpenAI 账号已被停用或封禁' : '';
      if (!initialBanMessage && !livenessBanMessage && isOpenAiAuthFailure(result)) {
        tokenRecovery = await renewUnauthorizedTeamToken(mother, child, { allowCredentialLogin: true });
        if (tokenRecovery.ok) {
          const renewedToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
          result = await probeUsage(renewedToken?.accessToken || '', mother.accountId);
          if (!result.ok && !isChallenge(result)) liveness = await probeAccountLiveness(renewedToken?.accessToken || '', mother.accountId);
        }
      }
      applyQuotaResult(child, result, mother.team, kickWindow);
      const banMessage = initialBanMessage || livenessBanMessage || explicitAccountBanMessage(result, liveness, tokenRecovery);
      if (banMessage) markChildBanned(child, mother, {
        source: tokenRecovery && !tokenRecovery.ok ? 'team_oauth_recovery' : 'team_quota_probe',
        status: tokenRecovery && !tokenRecovery.ok ? tokenRecovery.status : result.status,
        code: tokenRecovery && !tokenRecovery.ok ? tokenRecovery.code : result.errorCode,
        message: banMessage,
      });
      const membership = membershipFor(child, mother.team);
      return { id: child.id, email: child.email, ...result, banned: Boolean(banMessage), banReason: banMessage || null, liveness: liveness ? { ok: liveness.ok, status: liveness.status, message: liveness.message, banned: Boolean(liveness.banned), latencyMs: liveness.latencyMs } : null, quotaSource: quotaToken ? 'team' : 'team_token_missing', quota5h: membership?.quota5h ?? null, quota7d: membership?.quota7d ?? null, tokenRecovery: tokenRecovery ? { attempted: true, ok: tokenRecovery.ok, status: tokenRecovery.status, code: tokenRecovery.code || null, message: tokenRecovery.message, retryAfter: tokenRecovery.retryAfter || null, freeRefreshed: tokenRecovery.freeRefreshed, credentialLogin: Boolean(tokenRecovery.credentialLogin), credentialLoginAttempted: Boolean(tokenRecovery.credentialLoginAttempted), needsInput: Boolean(tokenRecovery.needsInput), browserRequired: Boolean(tokenRecovery.browserRequired), partial: Boolean(tokenRecovery.partial), oauthFallback: tokenRecovery.oauthFallback || null, sub2api: tokenRecovery.sub2api || null } : null };
    } catch (error) {
      return { id: child.id, email: child.email, ok: false, status: 502, message: error?.message || 'quota_probe_failed', quota5h: null, quota7d: null, tokenRecovery: null };
    }
  });
  const successfulRenewals = results.filter((result) => result.tokenRecovery?.ok && result.ok === true);
  const renewedTeamTokens = successfulRenewals.length;
  const renewedEmails = successfulRenewals.map((result) => result.email).filter(Boolean);
  const renewedFreeTokens = successfulRenewals.filter((result) => result.tokenRecovery.freeRefreshed).length;
  const reloggedTeamAccounts = successfulRenewals.filter((result) => result.tokenRecovery.credentialLogin).length;
  const bannedAccounts = results.filter((result) => result.banned === true);
  const sub2apiPush = renewedTeamTokens > 0
    ? await pushRenewedTeamJson(mother, { emails: renewedEmails, mode: 'repair_only' })
    : { attempted: false, ok: null, status: null, message: null, pushed: 0, failed: 0 };
  if (renewedTeamTokens > 0 && workspace.ok !== true) {
    workspace = await syncMotherWorkspace(mother, { allowCredentialLogin: false }).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  }
  mother.lastCheck = now();
  const probesOk = ownerProbe.ok === true && results.every((result) => result.ok === true);
  const syncOk = workspace.ok === true;
  const pushOk = !sub2apiPush.attempted || sub2apiPush.ok === true;
  const failedProbes = results.filter((result) => result.ok !== true).length;
  const renewalDetail = !renewedTeamTokens
    ? ''
    : `，刷新 ${renewedTeamTokens} 个 Team JSON${reloggedTeamAccounts ? `，重新完成 ${reloggedTeamAccounts} 个 Team OAuth` : ''}${sub2apiPush.attempted ? `，Sub2API 修复 ${sub2apiPush.pushed} 个` : '，Sub2API 未修复（未启用或未配置分组）'}`;
  const failureDetail = failedProbes || !syncOk || !pushOk
    ? `，失败 ${failedProbes} 个${!syncOk ? '，Team 同步失败' : ''}${!pushOk ? '，Sub2API 修复失败' : ''}`
    : '';
  addHistory('额度检测', `${mother.team} 检测 ${members.length} 个子号，席位 ${mother.used ?? '-'} / ${mother.seats ?? '-'}${bannedAccounts.length ? `，发现封禁 ${bannedAccounts.length} 个` : ''}${renewalDetail}${failureDetail}`, syncOk && probesOk && pushOk && !bannedAccounts.length ? 'success' : 'partial');
  await persist();
  return {
    ok: syncOk && probesOk && pushOk,
    status: syncOk && probesOk && pushOk ? 200 : 207,
    motherId,
    ownerProbe,
    checked: results.length,
    results,
    seatSnapshot: workspace.seatSnapshot || mother.seatSnapshot || null,
    members: workspace.members || mother.members || [],
    syncOk,
    probesOk,
    renewedTeamTokens,
    renewedFreeTokens,
    reloggedTeamAccounts,
    kickWindow,
    kickAfterHours: kickWindow === 'time' ? normalizeKickAfterHours(state.settings?.kickAfterHours) : null,
    bannedAccounts: bannedAccounts.map((result) => ({ id: result.id, email: result.email, reason: result.banReason })),
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

const ROTATION_STAGES = [
  ['sync', '同步 Team'],
  ['kick', '移出耗尽账号'],
  ['free_auth', '准备 Free 凭据'],
  ['request', '申请加入'],
  ['approve', '同意进入'],
  ['member', '确认 Team 成员'],
  ['owner', '设置所有者'],
  ['team_json', '获取 Team JSON'],
  ['verify', '复核席位'],
  ['push', '同步 Sub2API'],
];

function beginRotationProgress(mother) {
  const startedAt = now();
  mother.rotationProgress = {
    status: 'running',
    current: 'sync',
    message: '正在同步 Team 席位和成员',
    account: '',
    startedAt,
    updatedAt: startedAt,
    durationMs: null,
    steps: ROTATION_STAGES.map(([id, label]) => ({ id, label, status: 'pending', startedAt: null, endedAt: null, durationMs: null })),
  };
  updateRotationProgress(mother, 'sync', { message: '正在同步 Team 席位和成员' });
}

function updateRotationProgress(mother, stage, { message = '', account = '' } = {}) {
  const progress = mother?.rotationProgress;
  if (!progress) return;
  const updatedAt = now();
  for (const step of progress.steps || []) {
    if (step.status === 'running' && step.id !== stage) {
      step.status = 'completed';
      step.endedAt = updatedAt;
      step.durationMs = Math.max(0, Date.parse(updatedAt) - Date.parse(step.startedAt || updatedAt));
    }
  }
  const target = (progress.steps || []).find((step) => step.id === stage);
  if (target) {
    target.status = 'running';
    target.startedAt = target.startedAt || updatedAt;
    target.endedAt = null;
    target.durationMs = null;
  }
  progress.status = 'running';
  progress.current = stage;
  progress.message = message || target?.label || stage;
  progress.account = account || '';
  progress.updatedAt = updatedAt;
}

function finishRotationProgress(mother, status, message, summary = {}) {
  const progress = mother?.rotationProgress;
  if (!progress) return;
  const endedAt = now();
  for (const step of progress.steps || []) {
    if (step.status === 'running') {
      step.status = status === 'failed' ? 'failed' : 'completed';
      step.endedAt = endedAt;
      step.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(step.startedAt || endedAt));
    } else if (step.status === 'pending') {
      step.status = 'skipped';
    }
  }
  progress.status = status;
  progress.message = message;
  progress.account = '';
  progress.endedAt = endedAt;
  progress.updatedAt = endedAt;
  progress.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(progress.startedAt || endedAt));
  progress.summary = summary;
}

async function refillTeam(motherId, options = {}) {
  const mother = findMother(motherId);
  if (!mother) return { ok: false, status: 404, message: 'mother_not_found' };
  beginRotationProgress(mother);
  try {
    return await refillTeamInternal(motherId, mother, options);
  } catch (error) {
    finishRotationProgress(mother, 'failed', error?.message || '自动轮换失败');
    await persist();
    throw error;
  }
}

async function refillTeamInternal(motherId, mother, { manualTimersOnly = false } = {}) {
  let managerRecovery = await recoverTeamManagerToken(mother);
  let workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  if (!workspace.ok && [401, 403].includes(Number(workspace.status))) {
    managerRecovery = await recoverTeamManagerToken(mother, { force: true });
    if (managerRecovery.ok) workspace = await syncMotherWorkspace(mother).catch((error) => ({ ok: false, message: error?.message || 'workspace_sync_failed', members: [] }));
  }
  if (workspace.ok !== true) {
    const message = workspace.message || 'workspace_sync_failed';
    finishRotationProgress(mother, 'failed', `Team 同步失败：${message}`);
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
  const recoveredTeamJson = [];
  const promoteJoinedAccounts = state.settings?.promoteJoinedAccounts !== false;
  const pendingOwnerRoles = promoteJoinedAccounts ? state.children.filter((child) => {
    if (childIsBanned(child)) return false;
    if (!isChildMemberOfTeam(child, mother.team)) return false;
    const membership = membershipFor(child, mother.team);
    const ownerRoleStatus = membership?.ownerRoleStatus || child.ownerRoleStatus;
    const joinStatus = membership?.joinStatus || child.joinStatus;
    return ownerRoleStatus === 'failed' || joinStatus === 'owner_role_failed' || joinStatus === 'approved_pending_owner';
  }) : [];
  for (const child of pendingOwnerRoles) {
    const membership = membershipFor(child, mother.team, true);
    const promoted = await promoteJoinedMemberToOwner(mother, child, mother.accountId);
    if (promoted.ok) {
      child.joinStatus = 'owner_confirmed';
      child.ownerRoleStatus = 'applied';
      membership.joinStatus = 'owner_confirmed';
      membership.ownerRoleStatus = 'applied';
      membership.role = 'account-owner';
      child.ownerRoleUpdatedAt = now();
      child.ownerRoleError = null;
      addHistory('重试 Team 所有者', `${child.email} 已设置为 ${mother.team} 所有者`);
      const switched = await acquireTeamJson(mother, child);
      if (!switched.ok) {
        child.joinStatus = 'owner_confirmed_token_pending';
        membership.joinStatus = 'owner_confirmed_token_pending';
        membership.workspaceTokenStatus = 'pending';
        workspaceTokenRetryFailures.push({ id: child.id, email: child.email, ok: false, status: switched.status || 502, phase: 'workspace_token_retry', message: switched.message || 'workspace_token_exchange_failed' });
      } else recoveredTeamJson.push(child);
    } else {
      child.joinStatus = 'owner_role_failed';
      child.ownerRoleStatus = 'failed';
      membership.joinStatus = 'owner_role_failed';
      membership.ownerRoleStatus = 'failed';
      child.ownerRoleError = { status: promoted.status || 502, message: promoted.message || 'owner_role_failed', at: now() };
      ownerRoleRetryFailures.push({ id: child.id, email: child.email, ok: false, status: promoted.status || 502, phase: 'owner_role_retry', message: promoted.message || 'owner_role_failed' });
    }
  }
  const pendingWorkspaceTokens = state.children.filter((child) => {
    if (childIsBanned(child)) return false;
    if (!isChildMemberOfTeam(child, mother.team)) return false;
    const membership = membershipFor(child, mother.team);
    const workspaceToken = workspaceTokenFor(child, mother.accountId) || workspaceTokenFor(child, mother.team);
    return membership?.workspaceTokenStatus === 'pending'
      || ['team_token_failed', 'owner_confirmed_token_pending', 'member_confirmed_token_pending'].includes(membership?.joinStatus || child.joinStatus)
      || !teamTokenDetails(workspaceToken?.accessToken, mother.accountId);
  });
  for (const child of pendingWorkspaceTokens) {
    const switched = await acquireTeamJson(mother, child);
    const membership = membershipFor(child, mother.team, true);
    const roleConfirmedStatus = childIsWorkspaceOwner(child, mother) ? 'owner_confirmed' : 'member_confirmed';
    if (switched.ok) {
      child.joinStatus = roleConfirmedStatus;
      membership.joinStatus = roleConfirmedStatus;
      membership.workspaceTokenStatus = 'ready';
      recoveredTeamJson.push(child);
    } else {
      child.joinStatus = `${roleConfirmedStatus}_token_pending`;
      membership.joinStatus = child.joinStatus;
      membership.workspaceTokenStatus = 'pending';
      workspaceTokenRetryFailures.push({ id: child.id, email: child.email, ok: false, status: switched.status || 502, phase: 'workspace_token_retry', message: switched.message || 'workspace_token_exchange_failed' });
    }
  }
  const rotationBudgetBefore = dailyRotationBudget(mother);
  const kickAfterHours = normalizeKickAfterHours(state.settings?.kickAfterHours);
  const kickWindow = selectedKickWindow(mother);
  const kickDescription = manualTimersOnly
    ? '手动倒计时到期的账号'
    : kickWindow === 'time'
      ? `加入超过 ${kickAfterHours} 小时或手动倒计时到期的账号`
      : '额度耗尽或手动倒计时到期的账号';
  updateRotationProgress(mother, 'kick', { message: `${manualTimersOnly ? '正在检查' : '正在检查封禁和'}${kickDescription}（今日 ${rotationBudgetBefore.count}/${rotationBudgetBefore.limit}）` });
  const active = state.children.filter((child) => isChildMemberOfTeam(child, mother.team));
  const removalCandidates = active.filter((child) => childManualKickTimerExpired(child, mother.team)
    || (!manualTimersOnly && (childIsBanned(child)
      || (kickWindow === 'time'
        ? timeKickExpired(child, mother.team, kickAfterHours)
        : membershipQuotaIsExhausted(child, mother.team, kickWindow)
          || (child.team === mother.team && child.lastProbe?.ok === true && quotaIsExhausted(child, child.lastProbe, kickWindow))))))
    .sort((left, right) => Number(childIsBanned(right)) - Number(childIsBanned(left)));
  const rotationLimitSkipped = [];
  const kicked = [];
  const kickFailures = [];
  const removedMemberIds = new Set();
  const removedMemberEmails = new Set();
  for (const child of removalCandidates) {
    if (dailyRotationBudget(mother).remaining <= 0) {
      rotationLimitSkipped.push({ id: child.id, email: child.email, banned: childIsBanned(child) });
      continue;
    }
    if (!teamManagerContext(mother) || !mother.accountId) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 400, message: 'workspace_credentials_required' });
      continue;
    }
    const latestMembers = await queryAllWorkspaceMembers(mother);
    if (!latestMembers.ok) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: latestMembers.status || 502, message: latestMembers.message || 'workspace_members_refresh_failed' });
      continue;
    }
    mother.members = excludePreviouslyRemovedMembers(latestMembers.items, removedMemberIds, removedMemberEmails);
    reconcileSeatClaimsWithMembers(mother, mother.members);
    const currentMemberCount = workspaceMemberCount(mother, active.length + 1);
    if (currentMemberCount <= 1) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 409, message: 'minimum_workspace_member_required' });
      break;
    }
    const member = mother.members.find((item) => item.email && child.email && item.email.toLowerCase() === child.email.toLowerCase());
    if (!member?.id) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 502, message: 'member_snapshot_unavailable' });
      continue;
    }
    // A fixed primary owner is protected during ordinary rotation, but a
    // confirmed banned account must still be removed to allow replacement.
    if (memberIsProtected(member, mother) && !childIsBanned(child)) {
      kickFailures.push({ id: child.id, email: child.email, ok: false, status: 403, message: 'protected_workspace_member' });
      continue;
    }
    const remote = await removeWorkspaceMember(mother, member);
    if (!remote.ok) { kickFailures.push({ id: child.id, email: child.email, ...remote }); continue; }
    if (member.id) removedMemberIds.add(String(member.id));
    if (member.accountUserId) removedMemberIds.add(String(member.accountUserId));
    if (member.email) removedMemberEmails.add(String(member.email).trim().toLowerCase());
    mother.members = (mother.members || []).filter((item) => item.id !== member.id);
    releaseSeatClaim(mother, seatClaimForChild(mother, child));
    const removedAt = now();
    const banned = childIsBanned(child);
    const membership = membershipFor(child, mother.team, true);
    const manualTimer = manualKickTimerState(membership);
    const manualTimerTriggered = !banned && manualTimer.expired;
    const retryAfter = banned
      ? null
      : manualTimerTriggered
        ? manualKickCooldownAt(manualTimer, removedAt)
        : quotaRetryAfter(child, kickWindow, mother.team);
    const retryReason = banned ? 'account_banned' : manualTimerTriggered ? 'manual_time_elapsed' : quotaKickReason(child, kickWindow);
    clearManualKickTimer(membership, manualTimerTriggered ? 'completed' : banned ? 'account_banned' : 'membership_removed', removedAt);
    Object.assign(membership, {
      status: 'kicked',
      removedAt,
      reason: retryReason,
      retryAfter,
      rejoinEligible: banned ? false : Boolean(retryAfter),
    });
    child.status = banned ? 'banned' : 'kicked';
    child.retryReason = retryReason;
    child.rejoinEligible = banned ? false : Boolean(retryAfter);
    if (workspaceIdKey(child.team) === workspaceIdKey(mother.team)) {
      const replacement = (child.workspaceHistory || []).find((entry) => entry.status === 'active' && entry.team);
      child.team = replacement?.team || null;
    }
    removeTeamOwnerForChild(mother, child);
    if (child.team && !banned) child.status = 'active';
    kicked.push(child);
    consumeDailyRotation(mother);
    if (manualTimerTriggered) {
      addHistory('成员倒计时到期', `${child.email} 已从 ${teamDisplayName(mother)} 移出，原倒计时 ${manualTimer.durationMinutes} 分钟`, 'success', {
        summary: {
          team: mother.team,
          childId: child.id,
          email: child.email || '',
          reason: retryReason,
          durationMinutes: manualTimer.durationMinutes,
          startedAt: manualTimer.startedAt,
          kickAt: manualTimer.kickAt,
          removedAt,
          retryAfter,
        },
      });
    }
    await persist();
  }
  const joinFailures = [...ownerRoleRetryFailures, ...workspaceTokenRetryFailures];
  let seatCapacityReady = true;
  if (kicked.length) {
    updateRotationProgress(mother, 'sync', { message: '正在刷新移出后的分类席位余量' });
    const refreshedSubscription = await refreshMotherSubscription(mother).catch((error) => ({ ok: false, status: 0, message: error?.message || 'seat_capacity_refresh_failed' }));
    if (!refreshedSubscription.ok) {
      seatCapacityReady = false;
      joinFailures.push({ id: null, email: '', ok: false, status: refreshedSubscription.status || 502, phase: 'seat_capacity', code: 'seat_capacity_refresh_failed', message: refreshedSubscription.message || 'seat_capacity_refresh_failed' });
    }
  }
  const seatsEntitled = mother.seats !== null && mother.seats !== '' && Number.isFinite(Number(mother.seats)) ? Number(mother.seats) : null;
  const usedBeforeRefill = mother.used !== null && mother.used !== '' && Number.isFinite(Number(mother.used))
    ? Number(mother.used)
    : Math.max(0, workspaceMemberCount(mother, active.length) - kicked.length);
  const open = seatCapacityReady && seatsEntitled !== null ? Math.max(0, seatsEntitled - usedBeforeRefill) : 0;
  const candidatePool = state.children.filter((child) => (
    !childIsBanned(child)
    && !freeAuthRequiresManualInput(child)
    && !freeAuthRetryBackoffActive(child)
    && canRejoinTeam(child, mother.team)
    && !seatClaimForChild(mother, child)
    && Boolean(child.accessToken || child.refreshToken || (child.email && child.password))
    && !(child.workspaceHistory || []).some((entry) => entry.team === mother.team && entry.status === 'active')
  ));
  const joined = [];
  const seatReservations = seatClaimReservations(mother);
  let acceptedSeats = 0;
  let seatSelectionBlocked = false;
  let candidateCursor = 0;
  while (acceptedSeats < open && candidateCursor < candidatePool.length && !seatSelectionBlocked) {
    const batchSize = Math.min(open - acceptedSeats, normalizeConcurrency(state.settings.concurrency), candidatePool.length - candidateCursor);
    const batch = candidatePool.slice(candidateCursor, candidateCursor + batchSize);
    candidateCursor += batchSize;
    updateRotationProgress(mother, 'free_auth', { message: `正在并发准备 ${batch.length} 个 Free 账号` });
    const prepared = await mapWithConcurrency(batch, async (child) => {
      try {
        return { child, freeAuth: await ensureChildFreeAuth(child) };
      } catch (error) {
        return { child, freeAuth: { ok: false, status: 502, code: 'free_auth_failed', message: error?.message || 'free_auth_failed' } };
      }
    });
    for (const { child, freeAuth } of prepared) {
      if (acceptedSeats >= open) break;
      if (!freeAuth.ok) {
        const banMessage = explicitAccountBanMessage(freeAuth);
        if (banMessage) markChildBanned(child, mother, { source: 'free_oauth_before_team_join', status: freeAuth.status, code: freeAuth.code, message: banMessage });
        joinFailures.push({ id: child.id, email: child.email, ok: false, status: freeAuth.status || 502, phase: 'free_auth', code: freeAuth.code || null, message: freeAuth.message || 'free_auth_required', needsInput: Boolean(freeAuth.needsInput), browserRequired: Boolean(freeAuth.browserRequired), authUrl: freeAuth.authUrl || null });
        continue;
      }
      if (!teamManagerContext(mother) || !mother.accountId) { joinFailures.push({ id: child.id, email: child.email, ok: false, status: 400, message: 'workspace_credentials_required' }); continue; }
      const seatSelection = selectInviteSeatType(mother.inviteSeatType, seatAdmissionSnapshot(mother), seatReservations);
      if (!seatSelection.ok) {
        joinFailures.push({ id: child.id, email: child.email, ok: false, status: seatSelection.code === 'seat_capacity_exhausted' || seatSelection.code === 'seat_type_capacity_exhausted' ? 409 : 422, phase: 'seat_capacity', ...seatSelection });
        seatSelectionBlocked = true;
        break;
      }
      const membership = membershipFor(child, mother.team, true);
      const remote = await joinWorkspace(child, {
        motherId,
        workspaceId: mother.accountId,
        approve: true,
        pushTeamJson: false,
        onProgress: (stage, message) => updateRotationProgress(mother, stage, { message, account: child.email }),
      }, {
        selectedSeatType: seatSelection.seatType,
        seatReservations,
      });
      if (remote.seatClaimed) {
        seatReservations[remote.seatType || seatSelection.seatType] += 1;
      }
      if (remote.accepted) acceptedSeats += 1;
      if (!remote.ok) {
        const banMessage = ['free_auth', 'request', 'team_token'].includes(remote.phase)
          ? explicitAccountBanMessage(remote, remote.teamAuth)
          : '';
        if (banMessage) markChildBanned(child, mother, { source: 'team_join_oauth', status: remote.status, code: remote.code, message: banMessage });
        if (!remote.accepted) child.workspaceHistory = (child.workspaceHistory || []).filter((entry) => entry !== membership);
        joinFailures.push({ id: child.id, email: child.email, ...remote });
        continue;
      }
      const teamAuth = remote.teamAuth || { ok: false, status: 502, message: 'team_token_not_generated' };
      child.pendingWorkspaceId = mother.accountId;
      if (!teamAuth.ok) {
        const banMessage = explicitAccountBanMessage(teamAuth);
        if (banMessage) markChildBanned(child, mother, { source: 'team_json_oauth', status: teamAuth.status, code: teamAuth.code, message: banMessage });
        child.joinStatus = `${promoteJoinedAccounts ? 'owner' : 'member'}_confirmed_token_pending`;
        membership.joinStatus = child.joinStatus;
        membership.workspaceTokenStatus = 'pending';
        joinFailures.push({ id: child.id, email: child.email, ok: false, status: teamAuth.status || 502, phase: 'team_token', code: teamAuth.code || null, message: teamAuth.message || 'team_token_failed', needsInput: Boolean(teamAuth.needsInput), browserRequired: Boolean(teamAuth.browserRequired), authUrl: teamAuth.authUrl || null });
        continue;
      }
      joined.push(child);
    }
  }
  updateRotationProgress(mother, 'verify', { message: '正在复核成员和席位' });
  const synced = await syncMotherWorkspace(mother, {
    force: true,
    excludedMemberIds: removedMemberIds,
    excludedMemberEmails: removedMemberEmails,
  }).catch(() => ({ ok: false, members: [] }));
  const joinedEmails = new Set((synced.members || []).filter(memberIsActive).map((member) => String(member.email).toLowerCase()));
  const confirmedJoined = [];
  const pendingSync = [];
  for (const child of joined) {
    if (!joinedEmails.has(String(child.email || '').toLowerCase())) {
      const membership = membershipFor(child, mother.team, true);
      child.status = 'active';
      child.team = child.team || mother.team;
      child.joinStatus = 'approved_pending_sync';
      child.joinedAt = child.joinedAt || membership.joinedAt || now();
      Object.assign(membership, {
        team: mother.team,
        joinedAt: child.joinedAt,
        status: 'active',
        seatType: membership.seatType || null,
        joinStatus: 'approved_pending_sync',
        workspaceTokenStatus: membership.workspaceTokenStatus || 'ready',
        rejoinEligible: null,
        retryAfter: null,
        reason: null,
      });
      pendingSync.push(child);
      joinFailures.push({ id: child.id, email: child.email, ok: false, status: 202, message: 'membership_not_visible_after_approval' });
    } else {
      child.status = 'active'; child.team = mother.team; child.joinedAt = child.joinedAt || now();
      const membership = membershipFor(child, mother.team);
      const joinedMember = (synced.members || []).find((member) => String(member.email || '').toLowerCase() === String(child.email || '').toLowerCase());
      const role = joinedMember?.role || (promoteJoinedAccounts ? 'account-owner' : 'standard-user');
      if (joinedMember) {
        child.memberId = joinedMember.id || child.memberId;
        child.accountUserId = joinedMember.accountUserId || child.accountUserId;
        child.memberSnapshot = joinedMember;
      }
      child.joinStatus = promoteJoinedAccounts ? 'owner_confirmed' : 'member_confirmed';
      child.ownerRoleStatus = promoteJoinedAccounts ? 'applied' : 'skipped';
      const previousHistory = (child.workspaceHistory || []).filter((entry) => !(entry.team === mother.team && entry.status === 'active' && entry !== membership));
      const activeMembership = membershipFor(child, mother.team, true) || membership;
      Object.assign(activeMembership, { team: mother.team, joinedAt: child.joinedAt, status: 'active', role, seatType: joinedMember?.seatType || activeMembership.seatType || null, joinStatus: child.joinStatus, ownerRoleStatus: child.ownerRoleStatus, memberId: child.memberId || activeMembership.memberId || null, quota5h: activeMembership.quota5h ?? child.quota5h ?? null, quota7d: activeMembership.quota7d ?? child.quota7d ?? null, quotaSnapshot: activeMembership.quotaSnapshot || null, quotaUpdatedAt: activeMembership.quotaUpdatedAt || child.lastQuotaCheckAt || null, workspaceTokenStatus: 'ready', rejoinEligible: null, retryAfter: null, reason: null });
      child.workspaceHistory = [...previousHistory.filter((entry) => entry !== activeMembership), activeMembership];
      confirmedJoined.push(child);
    }
  }
  if (acceptedSeats > 0) {
    mother.used = reconcileAcceptedSeatUsage({
      syncedUsed: mother.used,
      usedBeforeRefill,
      acceptedSeats,
      seatsEntitled,
    });
  }
  const pushAccounts = [...joined, ...recoveredTeamJson]
    .filter((child, index, list) => child?.email && list.findIndex((item) => String(item?.email || '').toLowerCase() === String(child.email).toLowerCase()) === index);
  updateRotationProgress(mother, 'push', { message: pushAccounts.length ? `正在推送 ${pushAccounts.length} 个新 Team JSON` : '没有新的 Team JSON 需要推送' });
  const joinedSub2apiPush = pushAccounts.length > 0
    ? await pushRenewedTeamJson(mother, { emails: pushAccounts.map((child) => child.email), mode: 'create_only' })
    : { attempted: false, ok: null, status: null, message: null, pushed: 0, failed: 0 };
  mother.lastCheck = now();
  const pushDetail = joinedSub2apiPush.attempted ? `，Team JSON 推送 ${joinedSub2apiPush.pushed} 个` : '';
  const rotationBudgetAfter = dailyRotationBudget(mother);
  addHistory('自动补位', `${mother.team} 移出 ${kicked.length} 个，加入 ${joined.length}${pendingSync.length ? `（${pendingSync.length} 个等待成员同步）` : ''}${rotationLimitSkipped.length ? `，${rotationLimitSkipped.length} 个受每日轮转上限限制` : ''}${pushDetail}${kickFailures.length || joinFailures.length ? `，失败 ${kickFailures.length + joinFailures.length} 个` : ''}`, kickFailures.length || joinFailures.length || joinedSub2apiPush.ok === false ? 'partial' : 'success', {
    flow: mother.rotationProgress,
    summary: {
      team: mother.team,
      kicked: kicked.map((child) => ({ id: child.id, email: child.email || '', reason: child.retryReason || null })),
      joined: joined.map((child) => ({ id: child.id, email: child.email || '', pendingSync: pendingSync.includes(child) })),
      kickFailures: kickFailures.map((item) => ({ id: item.id, email: item.email || '', phase: item.phase || 'kick', status: item.status || null, message: item.message || '' })),
      joinFailures: joinFailures.map((item) => ({ id: item.id, email: item.email || '', phase: item.phase || 'join', status: item.status || null, message: item.message || '' })),
      pushed: joinedSub2apiPush.pushed || 0,
      pushFailed: joinedSub2apiPush.failed || 0,
    },
  });
  const pushFailed = joinedSub2apiPush.attempted && joinedSub2apiPush.ok === false;
  const ok = kickFailures.length === 0 && joinFailures.length === 0 && !pushFailed;
  finishRotationProgress(mother, ok ? 'completed' : 'partial', rotationLimitSkipped.length ? `已达到今日轮转上限 ${rotationBudgetAfter.count}/${rotationBudgetAfter.limit}` : ok ? '轮换链路执行完成' : '轮换完成，但存在未成功步骤', { kicked: kicked.length, joined: joined.length, accepted: acceptedSeats, pendingSync: pendingSync.length, pushed: joinedSub2apiPush.pushed || 0, skipped: (joinedSub2apiPush.skipped || 0) + rotationLimitSkipped.length, failed: kickFailures.length + joinFailures.length + (joinedSub2apiPush.failed || 0) });
  await persist();
  return { ok, status: ok ? 200 : 207, kicked: kicked.map(publicChild), joined: joined.map(publicChild), acceptedSeats, pendingSync: pendingSync.map(publicChild), kickFailures, joinFailures, rotationLimitSkipped, kickWindow, kickAfterHours: kickWindow === 'time' ? kickAfterHours : null, dailyRotationUsage: rotationBudgetAfter, sub2apiPush: joinedSub2apiPush, rotationProgress: mother.rotationProgress, seatsInUse: mother.used, seatsOpen: Number.isFinite(Number(mother.seats)) && Number.isFinite(Number(mother.used)) ? Math.max(0, mother.seats - mother.used) : null, seatSnapshot: mother.seatSnapshot || workspace.seatSnapshot || null };
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

function freeAuthBatchResult(child, acquired, extra = {}) {
  return {
    id: child.id,
    email: child.email,
    ok: acquired.ok === true,
    status: acquired.status || null,
    code: acquired.code || null,
    message: acquired.message || acquired.child?.login?.message || null,
    source: acquired.source || null,
    needsInput: Boolean(acquired.needsInput),
    browserRequired: Boolean(acquired.browserRequired),
    ...extra,
  };
}

async function prepareFreeJsonPool() {
  const candidates = state.children.filter((child) => (
    !childIsBanned(child)
    && freeTokenNeedsRefresh(child)
    && Boolean(child.refreshToken || (child.email && child.password))
    && !freeAuthRequiresManualInput(child)
    && !freeAuthRetryBackoffActive(child)
  ));
  const results = await mapWithConcurrency(candidates, async (child) => {
    try {
      return freeAuthBatchResult(child, await ensureChildFreeAuth(child));
    } catch (error) {
      return freeAuthBatchResult(child, { ok: false, status: 502, code: 'free_auth_failed', message: error?.message || 'free_auth_failed' });
    }
  });
  return {
    attempted: results.length,
    acquired: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

async function acquireMissingFreeJson() {
  const missing = state.children.filter((child) => !childIsBanned(child) && !child.accessToken);
  const candidates = [];
  const skipped = [];
  for (const child of missing) {
    if (freeAuthRequiresManualInput(child)) {
      skipped.push(freeAuthBatchResult(child, {
        ok: false,
        status: 202,
        code: child.loginStatus || child.status || 'verification_required',
        message: child.loginMessage || '账号需要人工完成登录验证',
        needsInput: true,
        browserRequired: child.loginBrowserRequired,
      }, { skipped: true }));
      continue;
    }
    if (!child.refreshToken && !(child.email && child.password)) {
      skipped.push(freeAuthBatchResult(child, {
        ok: false,
        status: 400,
        code: 'credentials_required',
        message: '缺少 refresh token 或邮箱密码',
      }, { skipped: true }));
      continue;
    }
    candidates.push(child);
  }
  const attempted = await mapWithConcurrency(candidates, async (child) => {
    try {
      const result = await acquireChildAuth(child, { refresh: true, allowCredentialLogin: true });
      return freeAuthBatchResult(child, result);
    } catch (error) {
      return freeAuthBatchResult(child, { ok: false, status: 502, code: 'free_auth_failed', message: error?.message || 'free_auth_failed' });
    }
  });
  const results = [...attempted, ...skipped];
  const acquired = attempted.filter((result) => result.ok).length;
  const failed = attempted.length - acquired;
  addHistory('批量获取 Free JSON', `缺少 JSON ${missing.length} 个，并发 ${normalizeConcurrency(state.settings.concurrency)}，成功 ${acquired} 个，失败 ${failed} 个，跳过 ${skipped.length} 个`, failed || skipped.length ? 'partial' : 'success');
  await persist();
  return {
    ok: failed === 0 && skipped.length === 0,
    status: failed || skipped.length ? 207 : 200,
    concurrency: normalizeConcurrency(state.settings.concurrency),
    totalMissing: missing.length,
    attempted: attempted.length,
    acquired,
    failed,
    skipped: skipped.length,
    results,
  };
}

async function runMaintenanceCycle() {
  if (state.settings.autoRefill !== true) return { ok: false, status: 204, message: 'auto_refill_disabled' };
  return withMaintenanceLock('scheduled', async () => {
    const automaticTeams = automaticRotationTeams(state.mothers, teamHasManagementPath);
    if (!automaticTeams.length) {
      return { ok: true, status: 200, message: 'no_automatic_rotation_teams', freeJson: null, teams: [], skipped: state.mothers.length };
    }
    const freeJson = await prepareFreeJsonPool();
    const teams = [];
    for (const mother of automaticTeams) {
      try {
        const checked = await checkTeam(mother.id);
        const expiredManualTimers = teamHasExpiredManualKickTimers(mother);
        const automaticKickEnabled = state.settings.kickOnExhausted !== false;
        const refilled = checked.syncOk && (automaticKickEnabled || expiredManualTimers)
          ? await refillTeam(mother.id, { manualTimersOnly: !automaticKickEnabled && expiredManualTimers })
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

async function joinWorkspace(child, body, internal = {}) {
  const mother = findMother(body.motherId);
  const onProgress = typeof body.onProgress === 'function' ? body.onProgress : () => {};
  if (!child || !mother) return { ok: false, status: 404, message: 'account_not_found' };
  if (childIsBanned(child)) return { ok: false, status: 409, code: 'account_banned', message: child.banReason || '账号已封禁，不能再加入 Team' };
  if (!body.workspaceId) return { ok: false, status: 400, message: 'workspace_id_required' };
  if (mother.accountId && workspaceIdKey(body.workspaceId) !== configuredTeamKey(mother)) {
    return { ok: false, status: 409, code: 'workspace_mismatch', message: 'workspace_id_does_not_match_team' };
  }
  if (body.approve !== false && seatClaimForChild(mother, child)) {
    return { ok: false, status: 409, code: 'seat_claim_pending', message: '该账号已有待核验席位占位，请先同步 Team 成员' };
  }
  if (body.approve !== false && !teamManagerContext(mother)) await recoverTeamManagerToken(mother, { force: true });
  if (body.approve !== false && !teamManagerContext(mother)) return { ok: false, status: 400, message: 'workspace_owner_token_required' };
  let seatSelection = null;
  let requestedSeatType = null;
  const seatReservations = internal.seatReservations || seatClaimReservations(mother);
  if (body.approve !== false) {
    if (!internal.selectedSeatType) {
      const subscription = await refreshMotherSubscription(mother);
      if (!subscription.ok) {
        return { ok: false, status: subscription.status || 502, phase: 'seat_capacity', code: 'seat_capacity_unavailable', message: subscription.message || 'seat_capacity_unavailable' };
      }
    }
    requestedSeatType = internal.selectedSeatType || body.seatType || mother.inviteSeatType;
    seatSelection = selectInviteSeatType(requestedSeatType, seatAdmissionSnapshot(mother), seatReservations);
    if (!seatSelection.ok) {
      return { ok: false, status: seatSelection.code === 'seat_type_capacity_exhausted' || seatSelection.code === 'seat_capacity_exhausted' ? 409 : 422, phase: 'seat_capacity', ...seatSelection };
    }
  }
  if (freeTokenNeedsRefresh(child)) onProgress('free_auth', '正在准备 Free OAuth 凭据');
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
  onProgress('request', '正在申请加入 Team');
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
    const latestSubscription = await refreshMotherSubscription(mother);
    if (!latestSubscription.ok) {
      await persist();
      return { ok: false, status: latestSubscription.status || 502, phase: 'seat_capacity', code: 'seat_capacity_unavailable', message: latestSubscription.message || 'seat_capacity_unavailable', request: payload };
    }
    seatSelection = selectInviteSeatType(requestedSeatType, seatAdmissionSnapshot(mother), seatReservations);
    if (!seatSelection.ok) {
      await persist();
      return { ok: false, status: seatSelection.code === 'seat_type_capacity_exhausted' || seatSelection.code === 'seat_capacity_exhausted' ? 409 : 422, phase: 'seat_capacity', request: payload, ...seatSelection };
    }
    const promoteJoinedAccounts = state.settings?.promoteJoinedAccounts !== false;
    const approvedRole = promoteJoinedAccounts ? 'account-owner' : 'standard-user';
    onProgress(
      'approve',
      seatSelection.seatType === 'prolite'
        ? '正在设置高级席位并同意申请'
        : '正在同意普通席位申请',
    );
    if (workspaceIdKey(body.workspaceId) !== configuredTeamKey(mother)) {
      return { ok: false, status: 409, phase: 'seat_capacity', code: 'workspace_changed', message: 'team_workspace_changed_during_join', request: payload };
    }
    const seatClaim = reserveSeatClaim(mother, child, seatSelection.seatType, child.pendingInviteId, body.workspaceId);
    if (mother.subscription) applyMotherSubscription(mother, mother.subscription);
    await persist();
    if (workspaceIdKey(body.workspaceId) !== configuredTeamKey(mother)) {
      releaseSeatClaim(mother, seatClaim);
      await persist();
      return { ok: false, status: 409, phase: 'seat_capacity', code: 'workspace_changed', message: 'team_workspace_changed_during_join', request: payload };
    }
    let approved = await approveWorkspaceRequest(mother, body.workspaceId, child.email, child.pendingInviteId, body.deviceId, approvedRole, seatSelection.seatType);
    if (!approved.ok) {
      if (approved.acceptAttempted) {
        const verified = await queryAllWorkspaceMembers(mother, child.email);
        const acceptedMember = (verified.items || []).filter(memberIsActive)
          .find((member) => String(member.email || '').trim().toLowerCase() === String(child.email || '').trim().toLowerCase());
        if (acceptedMember) {
          approved = { ...approved, ok: true, status: 200, message: 'approved_verified_by_member_sync', recovered: true, member: acceptedMember };
        }
      }
      if (!approved.ok) {
        const status = Number(approved.status) || 0;
        const definitiveFailure = !shouldRetainSeatClaim(approved);
        if (definitiveFailure) releaseSeatClaim(mother, seatClaim);
        else Object.assign(seatClaim, { phase: 'approval_unknown', updatedAt: now(), error: approved.message || `http_${status}` });
        if (mother.subscription) applyMotherSubscription(mother, mother.subscription);
        await persist();
        return { ok: false, status: approved.status || 502, phase: 'admin_approve', request: payload, ...approved, seatClaimed: !definitiveFailure, seatType: seatSelection.seatType };
      }
    }
    Object.assign(seatClaim, { phase: 'accepted_pending_sync', acceptedAt: now(), updatedAt: now(), error: null });
    child.status = 'active';
    child.team = mother.team;
    child.joinedAt = child.joinedAt || now();
    const membership = membershipFor(child, mother.team, true);
    membership.role = approvedRole;
    membership.seatType = approved.seatType || seatSelection.seatType;
    membership.joinStatus = promoteJoinedAccounts ? 'approved_pending_owner' : 'member_confirmed';
    membership.ownerRoleStatus = promoteJoinedAccounts ? 'pending' : 'skipped';
    child.joinStatus = membership.joinStatus;
    child.ownerRoleStatus = membership.ownerRoleStatus;
    child.ownerRoleError = null;
    if (mother.subscription) applyMotherSubscription(mother, mother.subscription);
    await persist();
    onProgress('member', '账号已进入 Team，正在确认身份');
    addHistory(
      '同意进入空间',
      membership.seatType === 'prolite'
        ? `${mother.email} 已将 ${child.email} 设为高级席位并同意进入 ${mother.team}`
        : `${mother.email} 已同意 ${child.email} 以普通席位进入 ${mother.team}`,
    );
    if (promoteJoinedAccounts) {
      onProgress('owner', '正在设置为 Team 所有者');
      const promoted = await promoteJoinedMemberToOwner(mother, child, body.workspaceId);
      if (!promoted.ok) {
        child.joinStatus = 'owner_role_failed';
        child.ownerRoleStatus = 'failed';
        membership.joinStatus = 'owner_role_failed';
        membership.ownerRoleStatus = 'failed';
        child.ownerRoleError = { status: promoted.status || 502, message: promoted.message || 'owner_role_failed', at: now() };
        addHistory('设置 Team 所有者', `${child.email} 进入 ${mother.team} 后提升所有者失败：${promoted.message || 'owner_role_failed'}`, 'error');
        await persist();
        return { ok: false, status: promoted.status || 502, phase: 'owner_role', inviteId: child.pendingInviteId || null, message: promoted.message || 'owner_role_failed', accepted: true, seatClaimed: true, seatType: membership.seatType };
      }
      child.joinStatus = 'owner_confirmed';
      child.ownerRoleStatus = 'applied';
      membership.joinStatus = 'owner_confirmed';
      membership.ownerRoleStatus = 'applied';
      membership.role = 'account-owner';
      child.ownerRoleUpdatedAt = now();
      child.ownerRoleError = null;
      addHistory('设置 Team 所有者', `${child.email} 已设置为 ${mother.team} 所有者`);
    }
    onProgress('team_json', '正在获取该空间的 Team JSON');
    const teamAuth = await acquireTeamJson(mother, child, { verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
    if (!teamAuth.ok) {
      child.joinStatus = `${promoteJoinedAccounts ? 'owner' : 'member'}_confirmed_token_pending`;
      membership.joinStatus = child.joinStatus;
      membership.workspaceTokenStatus = 'pending';
      await persist();
      return { ok: false, status: teamAuth.status || 502, phase: 'team_token', inviteId: child.pendingInviteId || null, message: teamAuth.message || 'team_token_failed', code: teamAuth.code, needsInput: Boolean(teamAuth.needsInput), browserRequired: Boolean(teamAuth.browserRequired), authUrl: teamAuth.authUrl || null, child: publicChild(child, mother.team), accepted: true, seatClaimed: true, seatType: membership.seatType };
    }
    membership.workspaceTokenStatus = 'ready';
    onProgress('team_json', 'Team JSON 已获取');
    const sub2apiPush = body.pushTeamJson === false
      ? { attempted: false, ok: null, status: null, message: 'deferred_to_batch', pushed: 0, failed: 0 }
      : await pushRenewedTeamJson(mother, { emails: [child.email], mode: 'create_only' });
    await persist();
    const phase = promoteJoinedAccounts ? 'owner_confirmed' : 'member_confirmed';
    return { ok: true, phase, inviteId: child.pendingInviteId || null, payload, freeAuth: { source: freeAuth.source || null }, teamAuth, sub2apiPush, accepted: true, seatClaimed: true, seatType: membership.seatType };
  }
  await persist();
  return { ok: true, phase: body.approve === false ? 'requested' : 'owner_confirmed', inviteId: child.pendingInviteId || null, payload };
}

async function approveWorkspaceRequest(mother, workspaceId, email, inviteId, deviceId, role = 'account-owner', seatType = 'default') {
  const payloads = inviteApprovalPayloads(seatType, role);
  const approvedSeatType = payloads.seatType;
  const base = `${CHATGPT_BASE_URL}/backend-api/accounts/${encodeURIComponent(workspaceId)}`;
  const attempted = await withTeamManager(mother, async (manager) => {
    const common = chatGptHeaders(manager.accessToken, workspaceId, `/backend-api/accounts/${workspaceId}/invites`, '/backend-api/accounts/{account_id}/invites', { 'oai-device-id': deviceId || manager.deviceId || randomUUID(), 'cache-control': 'no-cache' });
    let selectedInviteId = inviteId;
    if (!selectedInviteId) {
      const list = await proxyFetch(`${base}/invites?include_pending=false&include_requests=true&offset=0&limit=100&query=${encodeURIComponent(email)}`, { headers: common }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
      const data = await list.json().catch(() => ({}));
      const candidates = Array.isArray(data.items) ? data.items : Array.isArray(data.invites) ? data.invites : [];
      const match = candidates.find((item) => String(item.email || item.target_email || '').toLowerCase() === email.toLowerCase());
      selectedInviteId = match?.id || match?.invite_id;
      if (!selectedInviteId) return { ok: false, status: list.status || 404, approvalAttempted: false, acceptAttempted: false, seatAssignmentAttempted: false, seatAssigned: false, message: 'pending_invite_not_found', payload: data };
    }
    const approveHeaders = { ...common, 'content-type': 'application/json', 'x-openai-target-path': `/backend-api/accounts/${workspaceId}/invites/${selectedInviteId}`, 'x-openai-target-route': '/backend-api/accounts/{account_id}/invites/{invite_id}' };
    let seatPayload = null;
    if (payloads.seatAssignment) {
      const seatResponse = await proxyFetch(`${base}/invites/${encodeURIComponent(selectedInviteId)}`, {
        method: 'PATCH',
        headers: approveHeaders,
        body: JSON.stringify(payloads.seatAssignment),
      }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
      seatPayload = await seatResponse.json().catch(() => ({}));
      if (!seatResponse.ok) {
        return { ok: false, status: seatResponse.status, phase: 'seat_assignment', approvalAttempted: false, acceptAttempted: false, seatAssignmentAttempted: true, inviteId: selectedInviteId, seatType: approvedSeatType, seatAssigned: false, payload: seatPayload, message: seatPayload.detail || seatPayload.error || `http_${seatResponse.status}` };
      }
    }
    const response = await proxyFetch(`${base}/invites/${encodeURIComponent(selectedInviteId)}`, {
      method: 'PATCH',
      headers: approveHeaders,
      body: JSON.stringify(payloads.approval),
    }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: error.message }) }));
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, phase: response.ok ? 'approved' : 'admin_approve', approvalAttempted: true, acceptAttempted: true, seatAssignmentAttempted: Boolean(payloads.seatAssignment), inviteId: selectedInviteId, seatType: approvedSeatType, seatAssigned: Boolean(payloads.seatAssignment), seatPayload, payload, message: response.ok ? 'approved' : (payload.detail || payload.error || `http_${response.status}`) };
  });
  return attempted?.result || { ok: false, status: 401, approvalAttempted: false, acceptAttempted: false, seatAssignmentAttempted: false, seatAssigned: false, message: 'workspace_owner_token_required' };
}

async function switchWorkspace(child, body) {
  if (!child || !body.workspaceId) return { ok: false, status: 400, message: 'child_and_workspace_required' };
  if (childIsBanned(child)) return { ok: false, status: 409, code: 'account_banned', message: child.banReason || '账号已封禁，不能切换 Team 空间', banned: true };
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

function sub2ApiOAuthError(code, message, status = 502) {
  const error = new Error(String(message || code || 'sub2api_oauth_failed'));
  error.code = code;
  error.status = status;
  return error;
}

function sub2ApiOAuthMessage(result, fallback) {
  const value = result?.message || result?.payload?.message || result?.payload?.error || fallback;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(fallback || 'sub2api_oauth_failed'); }
}

function sub2ApiOAuthReady(config) {
  const groupId = Number(config?.groupId);
  return config?.enabled === true
    && Boolean(sub2ApiRoot(config?.baseUrl))
    && Boolean(String(config?.apiKey || '').trim())
    && ((Number.isFinite(groupId) && groupId > 0) || Boolean(String(config?.groupName || '').trim()));
}

function oauthSessionForAdapter(session, adapter) {
  const authorization = session?.authorization;
  if (!adapter) return authorization?.source === 'sub2api' ? null : session;
  if (!authorization && session?.state && session?.codeVerifier) return session;
  if (!authorization || authorization.source !== 'sub2api') return null;
  return authorization.providerId === adapter.providerId ? session : null;
}

function deferredSub2ApiSync(config, message, group = null) {
  return {
    integrationId: config?.id || null,
    integrationName: config?.name || '',
    groupId: group?.id || (Number.isFinite(Number(config?.groupId)) ? Number(config.groupId) : null),
    groupName: group?.name || String(config?.groupName || '').trim(),
    accountId: null,
    action: 'sync_deferred',
    synced: false,
    message: String(message || 'sub2api_sync_failed'),
  };
}

async function syncSub2ApiAfterLocalOAuth(config, child, login, { scope = 'free', workspaceId = '' } = {}) {
  if (!sub2ApiRoot(config?.baseUrl) || !String(config?.apiKey || '').trim()) {
    return deferredSub2ApiSync(config, 'sub2api_connection_required');
  }
  try {
    const group = await resolveSub2ApiGroup(config);
    if (!group.ok) return deferredSub2ApiSync(config, group.message || 'sub2api_group_lookup_failed');
    const tokenClaims = login?.claims || accessTokenClaims(login?.accessToken);
    const claims = {
      ...tokenClaims,
      email: tokenClaims.email || child?.email || '',
      accountId: tokenClaims.accountId || workspaceId || '',
      planType: tokenClaims.planType || (scope === 'team' ? 'team' : 'free'),
    };
    const fields = credentialFields({
      ...login,
      email: claims.email,
      accountId: claims.accountId,
      planType: claims.planType,
      clientId: login?.clientId || child?.clientId || '',
    });
    return await syncSub2ApiOAuthAccount(config, group, child, fields, claims, { scope, workspaceId });
  } catch (error) {
    return deferredSub2ApiSync(config, error?.name === 'TimeoutError' ? 'timeout' : error?.message || 'network_error');
  }
}

function sub2ApiOAuthAdapter(config, child, { scope = 'free', workspaceId = '' } = {}) {
  if (!sub2ApiOAuthReady(config)) return null;
  const providerId = String(config.id || DEFAULT_SUB2API_ID);
  let resolvedGroup = null;
  const ensureGroup = async () => {
    if (resolvedGroup) return resolvedGroup;
    const group = await resolveSub2ApiGroup(config);
    if (!group.ok) throw sub2ApiOAuthError('sub2api_oauth_group_unavailable', group.message || 'Sub2API OAuth 目标分组不可用', group.status || 502);
    resolvedGroup = group;
    return group;
  };
  return {
    providerId,
    authorizationProvider: async () => {
      const result = await sub2ApiRequest(config, '/admin/openai/generate-auth-url', { method: 'POST', body: {} });
      if (!result.ok) {
        throw sub2ApiOAuthError('sub2api_oauth_url_failed', sub2ApiOAuthMessage(result, 'Sub2API OAuth 授权链接获取失败'), result.status || 502);
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {};
      const authUrl = String(data.auth_url || data.authUrl || data.url || '').trim();
      const sessionId = String(data.session_id || data.sessionId || '').trim();
      let parsed = null;
      try { parsed = new URL(authUrl); } catch { parsed = null; }
      const stateValue = String(data.state || parsed?.searchParams.get('state') || '').trim();
      const redirectUri = String(data.redirect_uri || data.redirectUri || parsed?.searchParams.get('redirect_uri') || 'http://localhost:1455/auth/callback').trim();
      if (!parsed || !sessionId || !stateValue) {
        throw sub2ApiOAuthError('sub2api_oauth_url_invalid', 'Sub2API OAuth 响应缺少 auth_url、state 或 session_id', 502);
      }
      return { source: 'sub2api', providerId, authUrl, sessionId, state: stateValue, redirectUri };
    },
    callbackHandler: async ({ code, state: oauthState, authorization }) => {
      if (!authorization?.sessionId || authorization.providerId !== providerId) {
        throw sub2ApiOAuthError('sub2api_oauth_session_invalid', 'Sub2API OAuth 会话缺失或连接已切换', 409);
      }
      const exchanged = await sub2ApiRequest(config, '/admin/openai/exchange-code', {
        method: 'POST',
        body: {
          session_id: authorization.sessionId,
          code,
          state: oauthState,
          redirect_uri: authorization.redirectUri || undefined,
        },
      });
      if (!exchanged.ok) {
        throw sub2ApiOAuthError('sub2api_oauth_exchange_failed', sub2ApiOAuthMessage(exchanged, 'Sub2API OAuth 换取凭据失败'), exchanged.status || 502);
      }
      const tokenInfo = exchanged.data && typeof exchanged.data === 'object' ? exchanged.data : {};
      const fields = credentialFields(tokenInfo);
      if (!fields.accessToken || !fields.refreshToken) {
        throw sub2ApiOAuthError('sub2api_oauth_token_incomplete', 'Sub2API OAuth 返回缺少 access_token 或 refresh_token', 502);
      }
      const accessClaims = accessTokenClaims(fields.accessToken);
      const claims = {
        ...accessClaims,
        email: accessClaims.email || fields.email || child?.email || '',
        accountId: accessClaims.accountId || fields.accountId || '',
        userId: accessClaims.userId || fields.chatgptUserId || '',
        planType: accessClaims.planType || fields.planType || (scope === 'team' ? 'team' : 'free'),
      };
      if (scope === 'team' && workspaceId && claims.accountId !== workspaceId) {
        throw sub2ApiOAuthError('team_workspace_mismatch', 'OAuth 登录后未选择目标 Team 空间', 409);
      }
      let sub2api;
      try {
        const group = await ensureGroup();
        sub2api = await syncSub2ApiOAuthAccount(config, group, child, fields, claims, { scope, workspaceId });
      } catch (error) {
        // Token acquisition is independent from the optional Sub2API sync.
        // A later repair push can retry after the destination becomes available.
        sub2api = deferredSub2ApiSync(config, error?.message || 'sub2api_group_lookup_failed');
      }
      return {
        accessToken: fields.accessToken,
        refreshToken: fields.refreshToken,
        idToken: fields.idToken,
        clientId: fields.clientId,
        organizationId: fields.organizationId,
        subscriptionExpiresAt: fields.subscriptionExpiresAt,
        expiresAt: fields.expiresAt,
        claims,
        sub2api,
      };
    },
  };
}

async function syncSub2ApiOAuthAccount(config, group, child, fields, claims, { scope = 'free', workspaceId = '' } = {}) {
  const email = String(fields.email || claims.email || child?.email || '').trim();
  const accountId = String(claims.accountId || fields.accountId || workspaceId || '').trim();
  const metadata = {
    integrationId: config.id || null,
    integrationName: config.name || '',
    groupId: group.id,
    groupName: group.name || config.groupName || '',
    accountId: null,
    action: '',
    synced: false,
    message: '',
  };
  if (!email || !accountId) return { ...metadata, message: 'sub2api_identity_requires_email_and_chatgpt_account_id' };
  const record = {
    ...(child || {}),
    email,
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken,
    idToken: fields.idToken,
    clientId: fields.clientId,
    organizationId: fields.organizationId,
    subscriptionExpiresAt: fields.subscriptionExpiresAt,
    expiresAt: fields.expiresAt || claims.expiresAt,
    accountId,
    plan: fields.planType || claims.planType || (scope === 'team' ? 'team' : 'free'),
    planType: fields.planType || claims.planType || (scope === 'team' ? 'team' : 'free'),
    tokenScope: scope,
    team: scope === 'team' ? workspaceId || accountId : child?.team,
  };
  const payload = { ...sub2ApiAccountFromChild(record), group_ids: [group.id] };
  try {
    const lookup = await sub2ApiRequest(config, `/admin/accounts?page=1&page_size=100&search=${encodeURIComponent(email)}`);
    if (!lookup.ok) return { ...metadata, message: sub2ApiOAuthMessage(lookup, 'sub2api_lookup_failed') };
    const lookupItems = (lookupData) => Array.isArray(lookupData)
      ? lookupData
      : Array.isArray(lookupData?.items) ? lookupData.items
        : Array.isArray(lookupData?.accounts) ? lookupData.accounts : [];
    const matchesIdentity = (item) => {
      const itemEmail = String(item?.email || item?.credentials?.email || '').trim().toLowerCase();
      const itemAccountId = String(item?.credentials?.chatgpt_account_id || item?.credentials?.account_id || item?.account_id || '').trim().toLowerCase();
      return itemEmail === email.toLowerCase() && itemAccountId === accountId.toLowerCase();
    };
    const items = lookupItems(lookup.data);
    let existing = items.find(matchesIdentity);
    // Sub2API's `search` filter currently matches account.name only. If an
    // existing OAuth account uses a different display name, walk the OpenAI
    // account pages and perform the required email + workspace identity match.
    if (!existing) {
      for (let page = 1; page <= 20 && !existing; page += 1) {
        const pageResult = await sub2ApiRequest(config, `/admin/accounts?page=${page}&page_size=100&platform=openai&type=oauth`);
        if (!pageResult.ok) break;
        const pageItems = lookupItems(pageResult.data);
        if (!pageItems.length) break;
        existing = pageItems.find(matchesIdentity);
        if (pageItems.length < 100) break;
      }
    }
    const synced = existing?.id
      ? await sub2ApiRequest(config, `/admin/accounts/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: payload })
      : await sub2ApiRequest(config, '/admin/accounts', { method: 'POST', body: payload });
    if (!synced.ok) return { ...metadata, accountId: existing?.id || null, action: existing?.id ? 'update_failed' : 'create_failed', message: sub2ApiOAuthMessage(synced, 'sub2api_sync_failed') };
    const saved = synced.data && typeof synced.data === 'object' ? synced.data : {};
    return { ...metadata, accountId: saved.id || existing?.id || null, action: existing?.id ? 'updated' : 'created', synced: true, message: 'ok' };
  } catch (error) {
    return { ...metadata, message: error?.name === 'TimeoutError' ? 'timeout' : error?.message || 'network_error' };
  }
}

async function querySub2ApiGroups(config = sub2ApiConfigs()[0] || {}) {
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
  const result = await querySub2ApiGroups(config);
  if (!result.ok) return { ok: false, status: result.status || 502, message: result.message || 'sub2api_group_lookup_failed' };
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
    concurrency: 10,
    priority: 1,
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
      refreshToken: workspaceToken.refreshToken || '',
      idToken: workspaceToken.idToken || '',
      clientId: workspaceToken.clientId || child.clientId || '',
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

function teamJsonRecords(mother) {
  const workspaceId = mother?.accountId || mother?.team || '';
  const byEmail = new Map(teamOwnerRecords(mother).map((record) => [String(record.email || '').toLowerCase(), record]));
  for (const child of state.children) {
    if (!isChildMemberOfTeam(child, mother?.team)) continue;
    const workspaceToken = workspaceTokenFor(child, workspaceId) || workspaceTokenFor(child, mother.team);
    if (!teamTokenDetails(workspaceToken?.accessToken, workspaceId)) continue;
    const membership = membershipFor(child, mother.team);
    const record = {
      ...child,
      accessToken: workspaceToken.accessToken,
      refreshToken: workspaceToken.refreshToken || '',
      idToken: workspaceToken.idToken || '',
      clientId: workspaceToken.clientId || child.clientId || '',
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
    };
    const key = String(child.email || '').toLowerCase();
    if (key) byEmail.set(key, { ...(byEmail.get(key) || {}), ...record });
  }
  return [...byEmail.values()];
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

async function pushSub2ApiEntries(entries = [], historyLabel = '推送 Sub2API', { config = sub2ApiConfigs()[0] || {}, mode = 'create_only' } = {}) {
  const root = sub2ApiRoot(config.baseUrl);
  if (!root || !config.apiKey) return { ok: false, status: 400, message: 'sub2api_connection_required', pushed: [], failed: [] };
  const group = await resolveSub2ApiGroup(config);
  if (!group.ok) return { ok: false, status: group.status || 400, message: group.message, pushed: [], failed: [] };
  const groupId = group.id;
  const outcomes = await mapWithConcurrency(entries, async (entry) => {
    const payload = { ...entry.payload, group_ids: [groupId] };
    const email = String(entry.email || payload.email || payload.credentials?.email || '').trim();
    const targetAccountId = String(payload.credentials?.chatgpt_account_id || '').trim();
    if (!email || !targetAccountId) {
      return { ok: false, value: { id: entry.id, motherId: entry.motherId, email, status: 400, phase: 'identity', message: 'sub2api_identity_requires_email_and_chatgpt_account_id' } };
    }
    try {
      const lookup = await sub2ApiRequest(config, `/admin/accounts?page=1&page_size=100&search=${encodeURIComponent(email)}`);
      if (!lookup.ok) return { ok: false, value: { id: entry.id, motherId: entry.motherId, email, status: lookup.status, phase: 'lookup', message: lookup.message || 'sub2api_lookup_failed' } };
      const lookupData = lookup.data;
      const items = Array.isArray(lookupData) ? lookupData : Array.isArray(lookupData?.items) ? lookupData.items : [];
      const emailMatches = items.filter((item) => String(item?.email || item?.credentials?.email || '').toLowerCase() === String(email).toLowerCase());
      const existing = emailMatches.find((item) => {
        const credentials = item?.credentials || {};
        const accountId = String(credentials.chatgpt_account_id || credentials.account_id || item?.account_id || '').trim();
        return Boolean(accountId) && targetAccountId.toLowerCase() === accountId.toLowerCase();
      });
      if (mode === 'create_only' && existing?.id) {
        return { ok: true, skipped: true, value: { id: entry.id, motherId: entry.motherId, email, targetGroupId: groupId, targetGroupName: group.name || config.groupName || '', integrationId: config.id || null, integrationName: config.name || '', action: 'skipped_existing', sub2apiAccountId: existing.id } };
      }
      if (mode === 'repair_only' && !existing?.id) {
        return { ok: false, value: { id: entry.id, motherId: entry.motherId, email, status: 404, phase: 'repair_lookup', message: 'sub2api_account_not_found_for_repair' } };
      }
      const result = mode === 'repair_only'
        ? await sub2ApiRequest(config, `/admin/accounts/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: { ...payload, group_ids: [groupId] } })
        : await sub2ApiRequest(config, '/admin/accounts', { method: 'POST', body: payload });
      if (!result.ok) return { ok: false, value: { id: entry.id, motherId: entry.motherId, email, status: result.status, message: result.message } };
      return { ok: true, skipped: false, value: { id: entry.id, motherId: entry.motherId, email, targetGroupId: groupId, targetGroupName: group.name || config.groupName || '', integrationId: config.id || null, integrationName: config.name || '', action: mode === 'repair_only' ? 'repaired' : 'created' } };
    } catch (error) {
      return { ok: false, value: { id: entry.id, motherId: entry.motherId, email, status: 0, message: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' } };
    }
  });
  const pushed = outcomes.filter((outcome) => outcome.ok && !outcome.skipped).map((outcome) => outcome.value);
  const skipped = outcomes.filter((outcome) => outcome.ok && outcome.skipped).map((outcome) => outcome.value);
  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.value);
  addHistory(historyLabel, `${config.name || 'Sub2API'} / ${group.name || `分组 ${groupId}`} ${mode === 'repair_only' ? '修复' : '新增'} ${pushed.length} 个账号${skipped.length ? `，已存在跳过 ${skipped.length} 个` : ''}${failed.length ? `，失败 ${failed.length} 个` : ''}`, failed.length ? 'partial' : 'success');
  await persist();
  return { ok: failed.length === 0, status: failed.length ? 207 : 200, mode, integrationId: config.id || null, integrationName: config.name || '', targetGroupId: groupId, targetGroupName: group.name || config.groupName || '', pushed, skipped, failed };
}

async function pushSub2ApiAccounts(ids = []) {
  const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
  const entries = state.children
    .filter((child) => child.accessToken && (!idSet.size || idSet.has(String(child.id))))
    .map((child) => ({ id: child.id, email: child.email, payload: sub2ApiAccountFromChild(child) }));
  return pushSub2ApiEntries(entries, '推送 Free 到 Sub2API', { config: sub2ApiConfigs()[0] || {}, mode: 'create_only' });
}

function teamSub2ApiEntries(motherIds = [], emails = []) {
  const idSet = new Set(Array.isArray(motherIds) ? motherIds.map(String) : []);
  const emailSet = new Set(Array.isArray(emails) ? emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean) : []);
  return state.mothers
    .filter((mother) => !idSet.size || idSet.has(String(mother.id)) || idSet.has(String(mother.accountId || mother.team)))
    .flatMap((mother) => selectTeamSub2ApiRecords(teamJsonRecords(mother), mother, mother.syncOwnerToSub2api === false).filter((owner) => !emailSet.size || emailSet.has(String(owner.email || '').trim().toLowerCase())).map((owner) => ({
      id: `${mother.id}:${owner.email}`,
      motherId: mother.id,
      email: owner.email,
      payload: sub2ApiAccountFromMotherOwner(mother, owner),
    })));
}

async function pushSub2ApiTeams(motherIds = []) {
  const idSet = new Set(Array.isArray(motherIds) ? motherIds.map(String) : []);
  const mothers = state.mothers.filter((mother) => !idSet.size || idSet.has(String(mother.id)) || idSet.has(String(mother.accountId || mother.team)));
  const results = await mapWithConcurrency(mothers, (mother) => pushSub2ApiEntries(teamSub2ApiEntries([mother.id]), '推送 Team 到 Sub2API', {
    config: sub2ApiConfigForMother(mother) || {},
    mode: 'create_only',
  }));
  const pushed = results.flatMap((result) => result.pushed || []);
  const skipped = results.flatMap((result) => result.skipped || []);
  const failed = results.flatMap((result, index) => {
    if (result.failed?.length) return result.failed;
    if (result.ok === false) return [{ motherId: mothers[index]?.id || null, status: result.status || 400, message: result.message || 'sub2api_push_failed' }];
    return [];
  });
  return {
    ok: results.every((result) => result.ok === true),
    status: failed.length ? 207 : 200,
    pushed,
    skipped,
    failed,
    targets: results.map((result) => ({ integrationId: result.integrationId || null, integrationName: result.integrationName || '', targetGroupId: result.targetGroupId || null, targetGroupName: result.targetGroupName || '', ok: result.ok })),
  };
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
  { name: 'refill_team', description: '对一个 Team 按当前踢出条件移除账号并从待加入池补位。', inputSchema: { type: 'object', properties: { teamId: { type: 'string', description: 'Team 记录 id、accountId 或 team id。' } }, required: ['teamId'], additionalProperties: false } },
  { name: 'refill_all_teams', description: '对所有已配置真实凭据的 Team 执行移除和补位。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'acquire_missing_free_json', description: '按全局并发设置，为所有尚无可导出 JSON 的 Free 账号获取 AT/RT。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'update_settings', description: '更新自动补位、加入账号角色、额度预警阈值、检测周期、并发数和自动踢出窗口。', inputSchema: { type: 'object', properties: { autoRefill: { type: 'boolean' }, promoteJoinedAccounts: { type: 'boolean' }, threshold: { type: 'number', minimum: 1, maximum: 100 }, checkInterval: { type: 'number', minimum: 30 }, concurrency: { type: 'integer', minimum: 1, maximum: 10 }, kickWindow: { type: 'string', enum: ['5h', '7d', 'time'] }, kickAfterHours: { type: 'number', minimum: 1, maximum: 720 } }, additionalProperties: false } },
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
  if (name === 'acquire_missing_free_json') return withMaintenanceLock('mcp_acquire_missing_free_json', () => acquireMissingFreeJson());
  if (name === 'update_settings') {
    const input = args && typeof args === 'object' ? args : {};
    if (input.autoRefill !== undefined) state.settings.autoRefill = Boolean(input.autoRefill);
    if (input.promoteJoinedAccounts !== undefined) state.settings.promoteJoinedAccounts = Boolean(input.promoteJoinedAccounts);
    if (input.threshold !== undefined) state.settings.threshold = Math.min(100, Math.max(1, Number(input.threshold) || state.settings.threshold));
    if (input.checkInterval !== undefined) state.settings.checkInterval = Math.max(30, Number(input.checkInterval) || state.settings.checkInterval);
    if (input.concurrency !== undefined) state.settings.concurrency = normalizeConcurrency(input.concurrency, state.settings.concurrency);
    if (input.kickWindow !== undefined) state.settings.kickWindow = normalizeKickWindow(input.kickWindow, state.settings.kickWindow);
    if (input.kickAfterHours !== undefined) state.settings.kickAfterHours = normalizeKickAfterHours(input.kickAfterHours, state.settings.kickAfterHours);
    drainOutboundRequestQueue();
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
    const allowed = ['autoRefill', 'promoteJoinedAccounts', 'threshold', 'checkInterval', 'concurrency', 'kickOnExhausted', 'kickWindow', 'kickAfterHours'];
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      if (key === 'autoRefill' || key === 'promoteJoinedAccounts' || key === 'kickOnExhausted') state.settings[key] = Boolean(body[key]);
      else if (key === 'kickWindow') state.settings.kickWindow = normalizeKickWindow(body[key], state.settings.kickWindow);
      else if (key === 'kickAfterHours') state.settings.kickAfterHours = normalizeKickAfterHours(body[key], state.settings.kickAfterHours);
      else if (key === 'concurrency') state.settings.concurrency = normalizeConcurrency(body[key], state.settings.concurrency);
      else state.settings[key] = Math.max(1, Number(body[key]) || state.settings[key]);
    }
    drainOutboundRequestQueue();
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
    if (Array.isArray(body.sub2apis)) {
      replaceSub2ApiConfigs(body.sub2apis);
    } else if (body.sub2api && typeof body.sub2api === 'object') {
      const input = body.sub2api;
      const first = sub2ApiConfigs()[0] || normalizeSub2ApiConfig({}, 0);
      replaceSub2ApiConfigs([{ ...first, ...input, apiKey: input.apiKey === undefined ? first.apiKey : String(input.apiKey || '').trim() }, ...sub2ApiConfigs().slice(1)]);
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
    const config = sub2ApiConfigById(url.searchParams.get('integrationId')) || sub2ApiConfigs()[0] || {};
    return sendJson(res, 200, await querySub2ApiGroups(config));
  }
  if (method === 'POST' && url.pathname === '/api/teams/billing-preview') {
    return withMaintenanceLock('http_billing_preview_all', async () => {
      const result = await scanWorkspaceBillingPreviews({
        motherIds: body.motherIds,
        thresholdDays: body.thresholdDays,
      });
      return sendJson(res, result.status || 200, result);
    });
  }
  if (method === 'POST' && url.pathname === '/api/mothers') {
    return withMaintenanceLock('http_create_team', async () => {
      if (body.sub2apiIntegrationId !== undefined && !sub2ApiConfigById(body.sub2apiIntegrationId)) return sendJson(res, 400, { message: 'sub2api_integration_not_found' });
      const imported = motherFromImportedAccount(body);
      const importedTeam = body.team !== undefined ? String(body.team || '').trim() : (body.accountId ? String(body.accountId).trim() : imported.team);
      const mother = { ...imported, id: body.id || imported.id, email: String(body.email || imported.email), name: String(body.name || imported.name), team: importedTeam, teamName: String(body.teamName || body.displayName || ''), rotationMode: body.rotationMode === 'rotating' ? 'rotating' : 'fixed', rotationEnabled: normalizeTeamRotationEnabled(body.rotationEnabled ?? imported.rotationEnabled), inviteSeatType: normalizeInviteSeatType(body.inviteSeatType ?? imported.inviteSeatType), dailyRotationLimit: normalizeDailyRotationLimit(body.dailyRotationLimit ?? imported.dailyRotationLimit), primaryOwnerEmail: String(body.primaryOwnerEmail || imported.primaryOwnerEmail || body.email || imported.email || ''), syncOwnerToSub2api: body.syncOwnerToSub2api !== false, sub2apiIntegrationId: sub2ApiConfigById(body.sub2apiIntegrationId)?.id || sub2ApiConfigs()[0]?.id || DEFAULT_SUB2API_ID, seats: body.seats == null ? imported.seats : Number(body.seats), used: body.used == null ? imported.used : Number(body.used), status: 'unconfigured', lastCheck: null };
      if (!body.teamName && !body.displayName) mother.teamName = imported.teamName || '';
      if (body.accountId !== undefined) mother.accountId = String(body.accountId || '').trim();
      if (mother.accountId) mother.team = mother.accountId;
      const incomingTeamId = configuredTeamId(mother);
      const duplicate = state.mothers.find((item) => incomingTeamId
        ? configuredTeamKey(item) === workspaceIdKey(incomingTeamId)
        : !configuredTeamId(item) && mother.email && item.email && item.email.toLowerCase() === mother.email.toLowerCase());
      if (duplicate) {
        const existingId = duplicate.id;
        const importedFields = Object.fromEntries(Object.entries(mother).filter(([, value]) => value !== '' && value !== null && value !== undefined));
        if (body.rotationEnabled === undefined && body.rotation_enabled === undefined) delete importedFields.rotationEnabled;
        if (body.syncOwnerToSub2api === undefined) delete importedFields.syncOwnerToSub2api;
        Object.assign(duplicate, importedFields);
        duplicate.id = existingId;
        addHistory('更新母号', `${duplicate.email} 已从导入记录更新`);
        await persist();
        return sendJson(res, 200, publicState({ includeHistory: false }));
      }
      state.mothers.push(mother);
      addHistory('添加母号', `${mother.email} 已加入母号列表`);
      await persist();
      return sendJson(res, 201, publicState({ includeHistory: false }));
    });
  }
  if (method === 'PATCH' && segments[1] === 'mothers' && segments[2]) {
    return withMaintenanceLock(`http_update_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      if (body.sub2apiIntegrationId !== undefined && !sub2ApiConfigById(body.sub2apiIntegrationId)) return sendJson(res, 400, { message: 'sub2api_integration_not_found' });
      const fields = credentialFields(body);
      const previousTeam = canonicalTeamId(mother);
      const nextAccountId = fields.accountId
        || (body.accountId !== undefined ? String(body.accountId || '').trim() : undefined)
        || (body.team !== undefined ? String(body.team || '').trim() : mother.accountId);
      const nextTeam = body.team !== undefined
        ? String(body.team || '').trim()
        : (body.accountId !== undefined ? nextAccountId : mother.team);
      const prospectiveTeamId = configuredTeamId({
        ...mother,
        ...(nextAccountId !== undefined ? { accountId: nextAccountId } : {}),
        ...(nextTeam !== undefined ? { team: nextTeam } : {}),
      });
      const workspaceChanges = workspaceIdKey(previousTeam) !== workspaceIdKey(prospectiveTeamId);
      if (workspaceChanges && seatClaimEntriesForWorkspace(mother).length) {
        return sendJson(res, 409, { message: 'team_has_pending_seat_claims' });
      }
      if (workspaceChanges && teamHasActiveManualKickTimers(mother)) {
        return sendJson(res, 409, { message: 'team_has_active_manual_kick_timers' });
      }
      if (prospectiveTeamId && state.mothers.some((candidate) => candidate !== mother && configuredTeamKey(candidate) === workspaceIdKey(prospectiveTeamId))) {
        return sendJson(res, 409, { message: 'team_workspace_exists' });
      }
      Object.assign(mother, ['email', 'name', 'teamName', 'displayName', 'seats'].reduce((out, key) => body[key] !== undefined ? { ...out, [key]: key === 'seats' ? (body[key] == null ? null : Number(body[key])) : body[key] } : out, {}));
      if (body.primaryOwnerEmail !== undefined) mother.primaryOwnerEmail = String(body.primaryOwnerEmail || '').trim() || mother.email || '';
      if (nextAccountId !== undefined) mother.accountId = nextAccountId;
      if (nextTeam !== undefined) mother.team = nextTeam || mother.accountId || mother.id;
      if (body.rotationMode !== undefined) mother.rotationMode = body.rotationMode === 'rotating' ? 'rotating' : 'fixed';
      if (body.syncOwnerToSub2api !== undefined) mother.syncOwnerToSub2api = body.syncOwnerToSub2api === true;
      if (body.rotationEnabled !== undefined) mother.rotationEnabled = normalizeTeamRotationEnabled(body.rotationEnabled, mother.rotationEnabled);
      if (body.inviteSeatType !== undefined) mother.inviteSeatType = normalizeInviteSeatType(body.inviteSeatType);
      if (body.dailyRotationLimit !== undefined) mother.dailyRotationLimit = normalizeDailyRotationLimit(body.dailyRotationLimit, mother.dailyRotationLimit);
      if (body.sub2apiIntegrationId !== undefined) mother.sub2apiIntegrationId = String(body.sub2apiIntegrationId);
      if (fields.accessToken) mother.accessToken = fields.accessToken;
      if (fields.refreshToken) mother.refreshToken = fields.refreshToken;
      if (fields.password) mother.password = fields.password;
      if (fields.totp) mother.totp = fields.totp;
      if (body.mailboxUrl !== undefined || body.mailbox_url !== undefined) mother.mailboxUrl = fields.mailboxUrl;
      if (fields.accountId) mother.accountId = fields.accountId;
      if (fields.chatgptUserId) mother.chatgptUserId = fields.chatgptUserId;
      if (fields.planType) mother.planType = fields.planType;
      promotePrimaryOwner(mother);
      if (mother.accountId) mother.team = String(mother.accountId).trim();
      migrateTeamMemberships(previousTeam, canonicalTeamId(mother));
      addHistory('更新母号', `${mother.email} 配置已更新`);
      await persist();
      return sendJson(res, 200, publicState({ includeHistory: false }));
    });
  }
  if (method === 'DELETE' && segments[1] === 'mothers' && segments[2] && !segments[3]) {
    return withMaintenanceLock(`http_delete_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]);
      if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      if (seatClaimEntriesForWorkspace(mother).length) return sendJson(res, 409, { message: 'team_has_pending_seat_claims' });
      if (teamHasActiveManualKickTimers(mother)) return sendJson(res, 409, { message: 'team_has_active_manual_kick_timers' });
      const teamId = canonicalTeamId(mother);
      const keys = new Set([teamId, mother.team, mother.accountId].filter(Boolean).map(workspaceIdKey));
      let detached = 0;
      for (const child of state.children) {
        let changed = false;
        for (const membership of child.workspaceHistory || []) {
          if (!keys.has(workspaceIdKey(membership.team || membership.workspaceId)) || membership.status !== 'active') continue;
          Object.assign(membership, { status: 'team_removed', removedAt: now(), reason: 'team_deleted_local', retryAfter: null, rejoinEligible: false });
          changed = true;
        }
        for (const key of Object.keys(child.workspaceTokens || {})) {
          if (keys.has(workspaceIdKey(key))) delete child.workspaceTokens[key];
        }
        if (keys.has(workspaceIdKey(child.pendingWorkspaceId))) {
          child.pendingWorkspaceId = null;
          child.pendingInviteId = null;
        }
        if (changed || keys.has(workspaceIdKey(child.team))) {
          const replacement = (child.workspaceHistory || []).find((entry) => entry.status === 'active' && !keys.has(workspaceIdKey(entry.team || entry.workspaceId)));
          child.team = replacement?.team || null;
          if (!childIsBanned(child)) child.status = child.team ? 'active' : child.accessToken ? 'ready' : child.password ? 'login_required' : 'unconfigured';
        }
        if (changed) detached += 1;
      }
      state.mothers = state.mothers.filter((item) => item.id !== mother.id);
      addHistory('删除 Team', `${teamDisplayName(mother)} 已从本项目删除，解除 ${detached} 个账号关联；未操作远端 Team 或 Sub2API`);
      await persist();
      return sendJson(res, 200, { ok: true, deleted: { id: mother.id, teamId, detached }, state: publicState({ includeHistory: false }) });
    });
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'recover') {
    return withMaintenanceLock(`http_recover_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]);
      if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      const fields = credentialFields(body);
      if (fields.email) mother.email = fields.email;
      if (fields.password) mother.password = fields.password;
      if (fields.totp) mother.totp = fields.totp;
      if (body.mailboxUrl !== undefined || body.mailbox_url !== undefined) mother.mailboxUrl = fields.mailboxUrl;
      const result = await recoverTeamManagerToken(mother, { force: true, allowCredentialLogin: true, primaryOnly: true, bypassCooldown: true });
      mother.lastManagerRecovery = { ok: result.ok === true, status: result.status || null, code: result.code || null, message: result.message || result.source || null, attemptedAt: now() };
      await persist();
      return sendJson(res, result.ok ? 200 : (result.status || 502), { ...result, mother: publicMother(mother) });
    });
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'billing-preview') {
    return withMaintenanceLock(`http_billing_preview:${segments[2]}`, async () => {
      const mother = findMother(segments[2]);
      if (!mother) return sendJson(res, 404, { ok: false, status: 404, message: 'mother_not_found' });
      const result = await queryWorkspaceBillingPreview(mother, { thresholdDays: body.thresholdDays });
      const detail = result.ok
        ? `${teamDisplayName(mother)} 到期 ${result.activeUntil || '未知'}，新增普通席位 ${result.formattedAmount || '费用未知'}`
        : `${teamDisplayName(mother)} 查询失败：${result.message || 'billing_preview_failed'}`;
      addHistory('查询临期 Team', detail, result.ok ? 'success' : 'partial', { motherId: mother.id });
      await persist();
      return sendJson(res, result.ok ? 200 : (result.status || 502), result);
    });
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
    return withMaintenanceLock(`http_subscription:${segments[2]}`, async () => {
      const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      const result = await queryWorkspaceSubscription(mother);
      if (result.ok && result.subscription) { applyMotherSubscription(mother, result.subscription); mother.lastSubscriptionProbe = { ok: true, status: result.status, message: result.message, latencyMs: result.latencyMs }; await persist(); }
      return sendJson(res, result.ok ? 200 : 502, { ok: result.ok, status: result.status, message: result.message, accountId: result.accountId, subscription: result.subscription });
    });
  }
  if (method === 'GET' && segments[1] === 'mothers' && segments[2] && segments[3] === 'sync') {
    return withMaintenanceLock(`http_sync_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      return sendJson(res, 200, await syncMotherWorkspace(mother, { query: url.searchParams.get('query') || '' }));
    });
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'sync') {
    return withMaintenanceLock(`http_sync_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      return sendJson(res, 200, await syncMotherWorkspace(mother, { query: body.query || '', force: true }));
    });
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'probe') {
    return withMaintenanceLock(`http_probe_team:${segments[2]}`, async () => {
      const mother = findMother(segments[2]); if (!mother) return sendJson(res, 404, { message: 'mother_not_found' });
      const result = await probeMother(mother); await persist(); return sendJson(res, result.ok ? 200 : 502, result);
    });
  }
  if (method === 'POST' && segments[1] === 'mothers' && segments[2] && segments[3] === 'member-kick-timers') {
    return withMaintenanceLock(`http_member_kick_timers:${segments[2]}`, async () => {
      const result = await updateManualKickTimers(segments[2], body);
      return sendJson(res, result.status || 500, result);
    });
  }
  if (method === 'POST' && (url.pathname === '/api/children/import' || url.pathname === '/api/accounts/import' || url.pathname === '/api/sub2api/import')) {
    return withMaintenanceLock('http_import_accounts', async () => {
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
      const added = [];
      const updated = [];
      for (const item of incoming) {
        const next = motherFromImportedAccount({ ...item, ...(body.sub2apiIntegrationId ? { sub2apiIntegrationId: body.sub2apiIntegrationId } : {}) });
        const teamId = configuredTeamId(next);
        const existing = [...added, ...state.mothers].find((mother) => teamId
          ? configuredTeamKey(mother) === workspaceIdKey(teamId)
          : !configuredTeamId(mother) && next.email && mother.email && next.email.toLowerCase() === mother.email.toLowerCase());
        if (existing) {
          mergeImportedMother(existing, item);
          if (!added.includes(existing) && !updated.includes(existing)) updated.push(existing);
        } else {
          added.push(next);
        }
      }
      state.mothers = [...added, ...state.mothers];
      linkFreeAccountsToImportedTeams();
      addHistory('导入 Team', `新增 ${added.length} 个 Team${updated.length ? `，合并 ${updated.length} 个已有 Team` : ''}`);
      await persist();
      return sendJson(res, 201, { added: added.map(publicMother), updated: updated.map(publicMother), state: publicState({ includeHistory: false }) });
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
        const matchingMother = [...mothersAdded, ...state.mothers].find((mother) => configuredTeamKey(mother) === workspaceIdKey(teamId) && teamId);
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
        const importedTeamKey = configuredTeamKey(importedMother);
        const matchingTeamKey = configuredTeamKey(matchingMother);
        const workspaceMother = importedTeamKey
          ? [...mothersAdded, ...state.mothers].find((mother) => configuredTeamKey(mother) === importedTeamKey)
          : null;
        if (workspaceMother && workspaceMother !== matchingMother) {
          mergeImportedMother(workspaceMother, item);
          if (!mothersAdded.includes(workspaceMother)) mothersUpdated.push(workspaceMother);
        } else if (importedTeamKey && matchingTeamKey && importedTeamKey !== matchingTeamKey) {
          mothersAdded.push(importedMother);
        } else {
          Object.assign(matchingMother, Object.fromEntries(Object.entries(importedMother).filter(([key, value]) => !['id', 'status', 'lastCheck', 'createdAt'].includes(key) && value !== '' && value !== null && value !== undefined)));
          if (matchingMother.accountId) matchingMother.team = String(matchingMother.accountId).trim();
          mothersUpdated.push(matchingMother);
        }
        continue;
      }
      const next = childFromImportedAccount(source ? { ...item, source } : item);
      const existing = state.children.find((child) => child.email && next.email && child.email.toLowerCase() === next.email.toLowerCase());
      if (existing) {
        const history = existing.workspaceHistory || [];
        const merged = Object.fromEntries(Object.entries(next).filter(([key, value]) => {
          if (key === 'id' || key === 'workspaceHistory' || value === '' || value === null || value === undefined) return false;
          // Re-importing credentials must not erase a live membership snapshot.
          if (key === 'status' && childIsBanned(existing)) return false;
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
    });
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
    if (!childIsBanned(child)) child.status = child.team ? 'active' : 'ready';
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
    return withMaintenanceLock(`http_delete_child:${segments[2]}`, async () => {
      const child = findChild(segments[2]);
      if (!child) return sendJson(res, 404, { message: 'child_not_found' });
      if (childHasActiveTeamMembership(child)) return sendJson(res, 409, { message: 'child_has_active_team_memberships' });
      if (anySeatClaimForChild(child)) return sendJson(res, 409, { message: 'child_has_pending_seat_claim' });
      state.children = state.children.filter((item) => item.id !== child.id);
      addHistory('删除 Free 账号', `${child.email || child.id} 已从本地账号池删除`);
      await persist();
      return sendJson(res, 200, { ok: true, state: publicState({ includeHistory: false }) });
    });
  }
  if (method === 'POST' && url.pathname === '/api/children/batch-delete') {
    return withMaintenanceLock('http_batch_delete_children', async () => {
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 1000);
      if (!ids.length) return sendJson(res, 400, { message: 'child_ids_required' });
      const bannedOnly = body.bannedOnly !== false;
      const deleted = [];
      const skipped = [];
      for (const id of ids) {
        const child = findChild(id);
        if (!child) {
          skipped.push({ id, reason: 'child_not_found' });
          continue;
        }
        if (bannedOnly && !childIsBanned(child)) {
          skipped.push({ id, email: child.email || '', reason: 'child_not_banned' });
          continue;
        }
        if (childHasActiveTeamMembership(child)) {
          skipped.push({ id, email: child.email || '', reason: 'child_has_active_team_memberships' });
          continue;
        }
        if (anySeatClaimForChild(child)) {
          skipped.push({ id, email: child.email || '', reason: 'child_has_pending_seat_claim' });
          continue;
        }
        deleted.push({ id, email: child.email || '' });
      }
      const deletedIds = new Set(deleted.map((item) => item.id));
      state.children = state.children.filter((child) => !deletedIds.has(child.id));
      addHistory('批量删除 Free 账号', `删除 ${deleted.length} 个封禁账号，跳过 ${skipped.length} 个`, skipped.length ? 'partial' : 'success');
      await persist();
      return sendJson(res, 200, { ok: skipped.length === 0, deleted, skipped, state: publicState({ includeHistory: false }) });
    });
  }
  if (method === 'PATCH' && segments[1] === 'children' && segments[2]) {
    return withMaintenanceLock(`http_update_child:${segments[2]}`, async () => {
      const child = findChild(segments[2]);
      if (!child) return sendJson(res, 404, { message: 'child_not_found' });
      const nextEmail = body.email === undefined ? String(child.email || '').trim() : String(body.email || '').trim();
      if (workspaceIdKey(nextEmail) !== workspaceIdKey(child.email) && anySeatClaimForChild(child)) {
        return sendJson(res, 409, { message: 'child_has_pending_seat_claim' });
      }
      if (body.email !== undefined) child.email = nextEmail;
      if (body.password) child.password = String(body.password);
      if (body.totp) child.totp = String(body.totp).trim();
      if (body.mailboxUrl !== undefined) child.mailboxUrl = String(body.mailboxUrl || '').trim();
      addHistory('更新账号', `${child.email} 的账号记录已更新`);
      await persist();
      return sendJson(res, 200, publicChild(child));
    });
  }
  if ((method === 'GET' || method === 'POST') && segments[1] === 'children' && segments[2] && (segments[3] === 'probe' || segments[3] === 'quota')) {
    const child = findChild(segments[2]);
    if (!child) return sendJson(res, 404, { message: 'child_not_found' });
    const result = await probeChild(child);
    return sendJson(res, result.ok ? 200 : 502, result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'join') {
    const result = await withMaintenanceLock(`http_join:${body.motherId || 'unknown'}`, () => joinWorkspace(findChild(segments[2]), body));
    return sendJson(res, result.ok ? (result.phase === 'requested' ? 202 : 200) : (result.status || 502), result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'switch') {
    const child = findChild(segments[2]);
    const result = await switchWorkspaceWithFreeRecovery(child, body.workspaceId, { verificationCode: body.verificationCode, callbackUrl: body.callbackUrl });
    return sendJson(res, result.ok ? 200 : (result.status || 502), result);
  }
  if (method === 'POST' && segments[1] === 'children' && segments[2] && segments[3] === 'kick') {
    const result = await withMaintenanceLock(`http_kick:${segments[2]}`, () => kickChildFromWorkspace(segments[2], body));
    return sendJson(res, result.status || 500, result.payload || { message: 'workspace_member_remove_failed' });
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
  if (method === 'POST' && url.pathname === '/api/children/acquire-missing-json') {
    const result = await withMaintenanceLock('http_acquire_missing_free_json', () => acquireMissingFreeJson());
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
function canHandleReadConcurrently(req) {
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) return false;
  try {
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    return pathname === '/api/state' || pathname === '/api/history' || pathname === '/api/health' || !pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

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
  if (canHandleReadConcurrently(req)) {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { message: error?.message || 'request_failed' });
    });
    return;
  }
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
