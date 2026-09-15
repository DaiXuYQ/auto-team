import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowUpRight, Bot, Check, CheckCircle2,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, CloudDownload, Copy, Download, ExternalLink,
  FileText, Gauge, KeyRound, LayoutDashboard, ListFilter, Mail, Moon, MoreHorizontal,
  Pause, Play, Plus, RefreshCw, Settings2, ShieldAlert, ShieldCheck, SlidersHorizontal,
  Sparkles, Sun, Trash2, UserMinus, UserRound, Users, X, Zap
} from 'lucide-react';
import { groupTeamAccounts } from '../shared/team-members.mjs';
import './styles.css';

const initialChildren = [];
const initialMothers = [];
const initialHistory = [];
const historyPageSizeOptions = [20, 50, 100];
const defaultProxySettings = { enabled: false, strategy: 'failover', timeoutMs: 15000, maxRetries: 2, entries: [] };
const defaultSub2Api = { id: 'sub2api_default', name: '默认 Sub2API', baseUrl: '', apiKey: '', groupId: null, groupName: '', enabled: false, apiKeySet: false };
// The production server serves the API from the same origin; Vite dev runs it
// separately on 8786, so point browser requests at the live local API there.
const API_BASE = import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://127.0.0.1:8786' : '');
const API_TOKEN_STORAGE_KEY = 'team_rotation_api_token';
const LEGACY_API_TOKEN_STORAGE_KEY = 'TEAM_ROTATION_API_TOKEN';

const navItems = [
  { id: 'run', label: '首页', icon: LayoutDashboard },
  { id: 'teams', label: 'Team管理', icon: Users },
  { id: 'free', label: 'Free账号管理', icon: UserRound },
  { id: 'history', label: '操作历史', icon: Clock3 },
  { id: 'settings', label: '设置', icon: SlidersHorizontal },
];

function hydrateChildren(items) {
  return (Array.isArray(items) ? items : []).map((child) => ({
    ...child,
    workspaceHistory: Array.isArray(child.workspaceHistory) ? child.workspaceHistory : [],
    joinedTeams: Array.isArray(child.joinedTeams) ? child.joinedTeams : [],
  }));
}

function storedApiToken() {
  try {
    for (const storage of [window.sessionStorage, window.localStorage]) {
      for (const key of [API_TOKEN_STORAGE_KEY, LEGACY_API_TOKEN_STORAGE_KEY]) {
        const token = storage.getItem(key)?.trim();
        if (token) return token;
      }
    }
  } catch { /* browser storage may be unavailable */ }
  return '';
}

function saveApiToken(token) {
  try {
    window.sessionStorage.setItem(API_TOKEN_STORAGE_KEY, token);
    window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_API_TOKEN_STORAGE_KEY);
  } catch { /* browser storage may be unavailable */ }
}

async function apiRequest(path, options = {}, retriedAfterAuth = false, promptedToken = '') {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const token = promptedToken || storedApiToken();
  if (token && (!headers.has('authorization') || promptedToken)) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!retriedAfterAuth && response.status === 401 && payload?.code === 'api_auth_required') {
    const token = window.prompt('服务端需要 API Token，请输入 TEAM_ROTATION_API_TOKEN：', '')?.trim();
    if (token) {
      saveApiToken(token);
      return apiRequest(path, options, true, token);
    }
  }
  if (!response.ok) {
    const error = new Error(payload.message || payload.detail || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function applyStatePayload(payload, setChildren, setMothers) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.children)) setChildren(hydrateChildren(payload.children));
  if (Array.isArray(payload.mothers)) setMothers(payload.mothers);
}

function mergedIntegrations(current, source = {}) {
  const legacy = { ...defaultSub2Api, ...(source.sub2api || {}) };
  const sub2apis = Array.isArray(source.sub2apis) && source.sub2apis.length
    ? source.sub2apis.map((item, index) => ({ ...defaultSub2Api, id: index === 0 ? 'sub2api_default' : `sub2api_${index + 1}`, name: `Sub2API ${index + 1}`, ...item }))
    : [legacy];
  return {
    ...current,
    sub2api: sub2apis[0],
    sub2apis,
    mailbox: { ...(current.mailbox || {}), ...(source.mailbox || {}) },
  };
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function remainingQuota(used, remaining) {
  const direct = numericOrNull(remaining);
  if (direct != null) return Math.max(0, Math.min(100, direct));
  const consumed = numericOrNull(used);
  return consumed == null ? null : Math.max(0, Math.min(100, 100 - consumed));
}

function snapshotQuota(account = {}) {
  const snapshot = account.quotaSnapshot || account.lastProbe || {};
  return {
    quota5h: remainingQuota(snapshot.primary?.usedPercent, snapshot.primary?.remainingPercent),
    quota7d: remainingQuota(snapshot.secondary?.usedPercent, snapshot.secondary?.remainingPercent),
  };
}

function joinedTeamsFor(account = {}) {
  const entries = Array.isArray(account.joinedTeams) && account.joinedTeams.length
    ? account.joinedTeams
    : (Array.isArray(account.workspaceHistory) ? account.workspaceHistory : []);
  const normalized = entries.filter((entry) => entry?.team).map((entry) => ({
    ...entry,
    team: entry.team || entry.workspaceId,
  }));
  const byTeam = new Map();
  for (const entry of normalized) {
    const previous = byTeam.get(entry.team);
    if (!previous || entry.status === 'active' || previous.status !== 'active') byTeam.set(entry.team, entry);
  }
  const teams = [...byTeam.values()];
  if (account.team && !teams.some((entry) => entry.team === account.team && entry.status === 'active')
    && !teams.some((entry) => entry.team === account.team && ['kicked', 'cooldown'].includes(entry.status))) {
    teams.push({ team: account.team, status: 'active', joinedAt: account.joinedAt || null, quota5h: account.quota5h ?? null, quota7d: account.quota7d ?? null });
  }
  return teams;
}

function teamMembershipFor(account, teamId) {
  return joinedTeamsFor(account).find((entry) => entry.team === teamId && entry.status === 'active')
    || joinedTeamsFor(account).find((entry) => entry.team === teamId)
    || null;
}

function isMemberOfTeam(account, teamId) {
  return joinedTeamsFor(account).some((entry) => entry.team === teamId && entry.status === 'active');
}

function accountForTeam(account, teamId) {
  const membership = teamMembershipFor(account, teamId);
  return membership ? { ...account, quota5h: membership.quota5h ?? account.quota5h, quota7d: membership.quota7d ?? account.quota7d, quotaSnapshot: membership.quotaSnapshot || account.quotaSnapshot, seatType: membership.seatType || account.seatType || account.memberSnapshot?.seatType || null, joinedAt: membership.joinedAt || account.joinedAt } : account;
}

function teamDisplayName(mother) {
  return mother?.teamName || mother?.displayName || '未命名 Team';
}

function seatTypeLabel(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'prolite' || value === 'pro' || value === 'premium') return '高级席位';
  if (value === 'default' || value === 'standard') return '普通席位';
  return type || '其他席位';
}

function inviteSeatTypeLabel(type) {
  if (type === 'default') return '普通席位';
  if (type === 'prolite') return '高级席位';
  return '自动分配';
}

function seatBreakdown(snapshot = {}) {
  const capacities = Array.isArray(snapshot.seatCapacity) ? snapshot.seatCapacity : [];
  const assigned = snapshot.assigned && typeof snapshot.assigned === 'object' ? snapshot.assigned : {};
  return capacities.map((entry) => {
    const total = Number(entry?.paid ?? entry?.entitled ?? entry?.total);
    const availableValue = entry?.available;
    const available = availableValue === null || availableValue === undefined || availableValue === '' ? null : Number(availableValue);
    const assignedValue = assigned[String(entry?.type || '').toLowerCase()];
    const assignedCount = assignedValue === null || assignedValue === undefined || assignedValue === '' ? null : Number(assignedValue);
    const used = Number.isFinite(assignedCount)
      ? Math.max(0, assignedCount)
      : Number.isFinite(total) && Number.isFinite(available) ? Math.max(0, total - available) : null;
    return { type: entry?.type || '', label: seatTypeLabel(entry?.type), used, total: Number.isFinite(total) ? total : null, available: Number.isFinite(available) ? available : null };
  }).filter((entry) => entry.total != null || entry.available != null);
}

function teamNameForId(mothers, teamId) {
  const mother = (mothers || []).find((item) => item.id === teamId || item.team === teamId || item.accountId === teamId);
  return mother ? teamDisplayName(mother) : '未命名 Team';
}

function isOwnerMember(member = {}) {
  const role = String(member.role || '').toLowerCase().replace(/[\s_]+/g, '-');
  return ['owner', 'account-owner'].includes(role);
}

function normalizedOwners(mother, members = []) {
  const owners = [];
  for (const member of members) {
    if (!isOwnerMember(member) || member.deactivated_time || member.deactivatedTime || !(member.email || member.name || member.id)) continue;
    owners.push({ email: member.email || '', name: member.name || '', userId: member.id || member.account_user_id || null, role: member.role || 'owner' });
  }
  for (const owner of mother?.ownerAccounts || []) {
    if (owner.email || owner.name || owner.userId) owners.push({ email: owner.email || '', name: owner.name || '', userId: owner.userId || null, role: 'account-owner' });
  }
  if (mother?.email && !owners.some((owner) => owner.email && owner.email.toLowerCase() === mother.email.toLowerCase())) {
    owners.unshift({ email: mother.email, name: mother.name || '', userId: mother.chatgptUserId || null, role: 'account-owner' });
  }
  const seen = new Set();
  return owners.filter((owner) => {
    const key = (owner.email || owner.userId || owner.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function OwnerEmails({ owners = [], fallback = '未设置' }) {
  const list = owners.length ? owners : [{ email: fallback }];
  return <div className="owner-list">{list.map((owner, index) => <span key={`${owner.email || owner.userId || owner.name || fallback}-${index}`} title={owner.name || owner.role || undefined}>{owner.email || owner.name || fallback}</span>)}</div>;
}

function ownerAccountRecord(mother) {
  const teamId = mother.accountId || mother.team || mother.id;
  return {
    id: mother.id,
    email: mother.email || '',
    name: mother.name || '',
    plan: mother.planType || 'team',
    status: mother.status === 'online' ? 'active' : mother.status || 'unconfigured',
    team: teamId,
    accountType: 'team-owner',
    recordType: 'mother',
    sourceMotherId: mother.id,
    hasAccessToken: Boolean(mother.hasAccessToken),
    credentialsStatus: mother.credentialsStatus || {},
    sub2apiStatus: { imported: Boolean(mother.hasAccessToken), exportable: Boolean(mother.hasAccessToken), importedAt: mother.importedAt || null },
    joinedAt: mother.createdAt || null,
    joinedTeams: [{ team: teamId, status: 'active', joinedAt: mother.createdAt || null }],
    workspaceHistory: [],
    ...snapshotQuota(mother),
  };
}

function teamOwnerRecordFor(mother, email) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;
  const owner = [...(mother?.ownerAccounts || []), mother].find((item) => String(item?.email || '').toLowerCase() === target);
  if (!owner) return null;
  return {
    id: owner.userId || owner.chatgptUserId || `${mother.id}:owner:${target}`,
    email: owner.email || email,
    name: owner.name || owner.email || email,
    plan: 'team',
    accountType: 'team-owner',
    recordType: 'mother',
    sourceMotherId: mother.id,
    team: mother.accountId || mother.team || mother.id,
    token: owner.token || '',
    hasAccessToken: Boolean(owner.hasAccessToken),
    credentialsStatus: owner.credentialsStatus || {},
    sub2apiStatus: { imported: Boolean(owner.hasAccessToken), exportable: Boolean(owner.hasAccessToken), importedAt: owner.importedAt || null },
  };
}

function teamScopedAccount(child, teamId, ownerRecord) {
  const scoped = accountForTeam(child, teamId);
  if (!ownerRecord) return scoped;
  return {
    ...scoped,
    id: ownerRecord.id || scoped.id,
    name: ownerRecord.name || scoped.name,
    token: ownerRecord.token,
    hasAccessToken: ownerRecord.hasAccessToken,
    credentialsStatus: ownerRecord.credentialsStatus,
    sub2apiStatus: ownerRecord.sub2apiStatus,
    accountType: 'team-owner',
    recordType: 'mother',
    sourceMotherId: ownerRecord.sourceMotherId,
  };
}

function normalizeSub2ApiAccount(account = {}) {
  const credentials = account.credentials || account;
  const extra = account.extra || {};
  const email = credentials.email || account.email || '';
  const accessToken = credentials.access_token || credentials.accessToken || '';
  const refreshToken = credentials.refresh_token || credentials.refreshToken || '';
  const accountId = credentials.chatgpt_account_id || credentials.account_id || credentials.accountId || '';
  const planType = credentials.plan_type || credentials.planType || account.plan_type || '';
  return {
    email,
    name: credentials.name || account.name || email.split('@')[0] || '',
    accessToken,
    refreshToken,
    accountId,
    chatgptUserId: credentials.chatgpt_user_id || credentials.user_id || '',
    clientId: credentials.client_id || '',
    idToken: credentials.id_token || '',
    organizationId: credentials.organization_id || '',
    modelMapping: credentials.model_mapping || account.model_mapping || null,
    concurrency: account.concurrency ?? null,
    priority: account.priority ?? null,
    rateMultiplier: account.rate_multiplier ?? account.rateMultiplier ?? null,
    autoPauseOnExpired: account.auto_pause_on_expired ?? account.autoPauseOnExpired ?? null,
    expiresAt: credentials.expires_at || null,
    subscriptionExpiresAt: credentials.subscription_expires_at || null,
    planType,
    quota5h: remainingQuota(extra.codex_5h_used_percent, extra.codex_5h_remaining_percent),
    quota7d: remainingQuota(extra.codex_7d_used_percent, extra.codex_7d_remaining_percent),
    quota5hResetAfterSeconds: numericOrNull(extra.codex_5h_reset_after_seconds),
    quota7dResetAfterSeconds: numericOrNull(extra.codex_7d_reset_after_seconds),
    quota5hResetAt: extra.codex_5h_reset_at || null,
    quota7dResetAt: extra.codex_7d_reset_at || null,
    quotaUpdatedAt: extra.codex_usage_updated_at || null,
    extra,
    quotaSnapshot: {
      primary: {
        usedPercent: numericOrNull(extra.codex_5h_used_percent),
        resetAfterSeconds: numericOrNull(extra.codex_5h_reset_after_seconds),
        resetAt: extra.codex_5h_reset_at || null,
        windowMinutes: numericOrNull(extra.codex_5h_window_minutes),
      },
      secondary: {
        usedPercent: numericOrNull(extra.codex_7d_used_percent),
        resetAfterSeconds: numericOrNull(extra.codex_7d_reset_after_seconds),
        resetAt: extra.codex_7d_reset_at || null,
        windowMinutes: numericOrNull(extra.codex_7d_window_minutes),
      },
      source: 'sub2api-extra',
      updatedAt: extra.codex_usage_updated_at || null,
    },
    password: credentials.password || account.password || '',
    totp: credentials.totp || credentials.two_factor_secret || account.totp || '',
    mailboxUrl: credentials.mailbox_url || account.mailbox_url || '',
  };
}

function splitCredentialLine(line) {
  if (line.includes('----')) return line.split('----').map((part) => part.trim()).filter(Boolean);
  if (line.includes('|')) return line.split('|').map((part) => part.trim()).filter(Boolean);
  if (line.includes(',')) return line.split(',').map((part) => part.trim()).filter(Boolean);
  return [line.trim()].filter(Boolean);
}

function normalizeAcquireStatus(payload = {}) {
  const raw = String(payload.code || payload.state || payload.phase || (payload.ok ? 'ready' : 'failed')).toLowerCase().replace(/[\s-]+/g, '_');
  if (['phone_verification_required', 'phone_required', 'add_phone_required'].includes(raw)) return 'phone_required';
  if (['verification_required', 'browser_verification_required', 'protocol_verification_required', 'sentinel_verification_failed', 'captcha_required'].includes(raw)) return 'browser_required';
  if (['waiting_code', 'awaiting_code', 'code_required', 'waiting_verification', 'awaiting_verification', 'otp_required', 'waiting_otp', 'waiting_email', 'email_otp_required', 'email_otp_timeout', 'totp_required', 'totp_invalid'].includes(raw)) return 'waiting_code';
  if (['authenticating', 'logging_in', 'login_pending', 'pending_auth'].includes(raw)) return 'authenticating';
  if (['queued', 'pending', 'processing', 'started'].includes(raw)) return 'queued';
  if (['ready', 'completed', 'success', 'refreshed', 'download_ready'].includes(raw)) return 'ready';
  return 'failed';
}

function AcquireStatus({ state }) {
  if (!state?.status) return null;
  const labels = { queued: '等待处理', waiting_code: '等待验证码', phone_required: '需要手机号接码', browser_required: '需要浏览器验证', authenticating: '登录验证中', ready: '已更新', failed: '获取失败' };
  return <span className={`acquire-status ${state.status} ${state.loading ? 'loading' : ''}`} title={state.message || ''}><i />{labels[state.status] || '处理中'}{state.authUrl && <a className="auth-link" href={state.authUrl} target="_blank" rel="noreferrer">打开授权链接</a>}</span>;
}

function App() {
  const [view, setView] = useState('run');
  const [children, setChildren] = useState(initialChildren);
  const [mothers, setMothers] = useState(initialMothers);
  const [history, setHistory] = useState(initialHistory);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(historyPageSizeOptions[0]);
  const [historyMeta, setHistoryMeta] = useState({ page: 1, pageSize: historyPageSizeOptions[0], total: 0, totalPages: 1 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stage, setStage] = useState('monitor');
  const [progress, setProgress] = useState(0);
  const [lastSync, setLastSync] = useState('未同步');
  const [toast, setToast] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonImportChild, setJsonImportChild] = useState(null);
  const [jsonImportText, setJsonImportText] = useState('');
  const [jsonImporting, setJsonImporting] = useState(false);
  const [acquireStates, setAcquireStates] = useState({});
  const [batchAcquire, setBatchAcquire] = useState({ loading: false, result: null });
  const [showMother, setShowMother] = useState(false);
  const [editingMotherId, setEditingMotherId] = useState(null);
  const [managedMotherId, setManagedMotherId] = useState(null);
  const [managerAction, setManagerAction] = useState({ loading: false, message: '' });
  const [showBillingPreview, setShowBillingPreview] = useState(false);
  const [billingPreviewLoading, setBillingPreviewLoading] = useState(false);
  const [billingPreviewError, setBillingPreviewError] = useState('');
  const [billingPreviewData, setBillingPreviewData] = useState({ items: [], total: 0, succeeded: 0, failed: 0, expiring: 0, thresholdDays: 7, checkedAt: null });
  const [showAccount, setShowAccount] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [showTeamDetail, setShowTeamDetail] = useState(false);
  const [detailTeamId, setDetailTeamId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAgentHelp, setShowAgentHelp] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [showTaskCenter, setShowTaskCenter] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState('password-2fa');
  const [importFileName, setImportFileName] = useState('');
  const [importAccounts, setImportAccounts] = useState(null);
  const [autoRefill, setAutoRefill] = useState(true);
  const [threshold, setThreshold] = useState(10);
  const [checkInterval, setCheckInterval] = useState(60);
  const [concurrency, setConcurrency] = useState(3);
  const [kickWindow, setKickWindow] = useState('5h');
  const [kickAfterHours, setKickAfterHours] = useState(12);
  const [promoteJoinedAccounts, setPromoteJoinedAccounts] = useState(true);
  const [integrations, setIntegrations] = useState({
    sub2api: defaultSub2Api,
    sub2apis: [defaultSub2Api],
    mailbox: { serviceType: 'manual', endpoint: '', apiKey: '', enabled: false },
  });
  const [showIntegration, setShowIntegration] = useState(null);
  const [proxySettings, setProxySettings] = useState(defaultProxySettings);
  const [showProxy, setShowProxy] = useState(false);
  const [search, setSearch] = useState('');
  const [theme, setTheme] = useState(() => {
    try { return window.localStorage.getItem('quota-hub-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });

  function createTask(type, label, teamId = null, details = '') {
    const createdAt = new Date().toISOString();
    const task = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, label, teamId, details, status: 'running', progress: 8, message: '正在启动', createdAt, startedAt: createdAt, completedAt: null };
    setTasks((current) => [task, ...current].slice(0, 30));
    return task.id;
  }

  function updateTask(id, patch) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  }

  function finishTask(id, status, message, details = '') {
    updateTask(id, { status, progress: status === 'completed' ? 100 : status === 'partial' ? 100 : 0, message, details, completedAt: new Date().toISOString() });
  }

  useEffect(() => {
    const live = mothers.filter((mother) => mother.rotationProgress?.status === 'running');
    if (!live.length) return;
    setTasks((current) => current.map((task) => {
      if (task.status !== 'running') return task;
      const progress = live.find((mother) => !task.teamId || mother.id === task.teamId || mother.accountId === task.teamId || mother.team === task.teamId)?.rotationProgress;
      if (!progress) return task;
      const steps = progress.steps || [];
      const complete = steps.filter((step) => step.status === 'completed').length;
      const running = steps.find((step) => step.status === 'running');
      return { ...task, progress: Math.max(8, Math.min(96, Math.round(((complete + (running ? 0.35 : 0)) / Math.max(1, steps.length)) * 100))), message: progress.message || task.message, account: progress.account || '' };
    }));
  }, [mothers]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('quota-hub-theme', theme); } catch { /* storage may be disabled */ }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/state?includeHistory=false').then((payload) => {
      if (!cancelled) {
        applyStatePayload(payload, setChildren, setMothers);
        if (payload.settings) {
          setAutoRefill(payload.settings.autoRefill !== false);
          setThreshold(Number(payload.settings.threshold) || 10);
          setCheckInterval(Number(payload.settings.checkInterval) || 60);
          setConcurrency(Math.min(10, Math.max(1, Number(payload.settings.concurrency) || 3)));
          setKickWindow(['5h', '7d', 'time'].includes(payload.settings.kickWindow) ? payload.settings.kickWindow : '5h');
          setKickAfterHours(Math.min(720, Math.max(1, Number(payload.settings.kickAfterHours) || 12)));
          setPromoteJoinedAccounts(payload.settings.promoteJoinedAccounts !== false);
          setIntegrations((current) => mergedIntegrations(current, payload.settings.integrations));
          setProxySettings((current) => ({ ...current, ...(payload.settings.proxy || {}), entries: Array.isArray(payload.settings.proxy?.entries) ? payload.settings.proxy.entries : current.entries }));
          setIsRunning(Boolean(payload.mothers?.length) && payload.settings.autoRefill !== false);
        }
      }
    }).catch(() => {
      if (!cancelled) notify('无法连接服务端，当前保持空状态', 'error');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (view !== 'history') return undefined;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError('');
    const query = new URLSearchParams({ page: String(historyPage), pageSize: String(historyPageSize) });
    apiRequest(`/api/history?${query.toString()}`).then((payload) => {
      if (cancelled) return;
      const sourceItems = Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload?.history) ? payload.history : []));
      const nextPageSize = Number(payload?.pageSize) || historyPageSize;
      const total = Number.isFinite(Number(payload?.total)) ? Math.max(0, Number(payload.total)) : sourceItems.length;
      const totalPages = Math.max(1, Number(payload?.totalPages) || Math.ceil(total / nextPageSize));
      const nextPage = Math.min(totalPages, Math.max(1, Number(payload?.page) || historyPage));
      const hasPaginationMetadata = !Array.isArray(payload) && (payload?.total !== undefined || payload?.totalPages !== undefined || payload?.page !== undefined);
      const items = hasPaginationMetadata ? sourceItems : sourceItems.slice((nextPage - 1) * nextPageSize, nextPage * nextPageSize);
      setHistory(items);
      setHistoryMeta({ page: nextPage, pageSize: nextPageSize, total, totalPages });
      if (nextPage !== historyPage) setHistoryPage(nextPage);
    }).catch((error) => {
      if (!cancelled) {
        setHistory([]);
        setHistoryError(error.message || '历史记录加载失败');
      }
    }).finally(() => {
      if (!cancelled) setHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [view, historyPage, historyPageSize, historyReloadKey]);

  const activeMother = mothers.find((m) => m.id === selectedTeam) || mothers[0];
  const automaticMothers = useMemo(() => mothers.filter((mother) => mother.rotationEnabled !== false), [mothers]);
  const activeChildren = children.filter((c) => activeMother && isMemberOfTeam(c, activeMother.accountId || activeMother.team) && c.status !== 'kicked');
  const trackedChildren = children.filter((c) => joinedTeamsFor(c).some((entry) => entry.status === 'active'));
  const readyChildren = children.filter((c) => c.status === 'ready');
  const exhausted = activeChildren.filter((c) => c.status === 'banned' || (c.status === 'exhausted' && c.lastProbe?.ok === true));
  const anyExhausted = children.some((c) => c.status === 'banned' || (c.status === 'exhausted' && c.lastProbe?.ok === true));
  const anyOpenSeat = mothers.some((mother) => Number.isFinite(Number(mother.seats)) && Number.isFinite(Number(mother.used)) && Number(mother.seats) > Number(mother.used));
  const lowQuota = activeChildren.filter((c) => [c.quota5h, c.quota7d].some((value) => Number.isFinite(Number(value)) && Number(value) <= Number(threshold)));
  const seatsOpen = activeMother && Number.isFinite(Number(activeMother.seats)) && Number.isFinite(Number(activeMother.used))
    ? Math.max(0, Number(activeMother.seats) - Number(activeMother.used))
    : 0;
  const accountRecords = useMemo(() => children.map((child) => ({ ...child, recordType: 'child', accountType: 'free', joinedTeams: joinedTeamsFor(child) })), [children]);
  const filteredAccounts = accountRecords.filter((c) => `${c.email} ${c.id} ${c.team || ''} ${joinedTeamsFor(c).map((entry) => entry.team).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const teamRecords = useMemo(() => mothers.map((mother) => {
    const teamId = mother.accountId || mother.team || mother.id;
    const displayName = teamDisplayName(mother);
    const snapshot = mother.seatSnapshot || mother.subscription || {};
    const ownerQuota = snapshotQuota(mother);
    const primaryOwner = teamOwnerRecordFor(mother, mother.email);
    const ownerAccount = { ...primaryOwner, email: mother.email, id: primaryOwner?.id || mother.chatgptUserId, status: mother.status, credentialsStatus: primaryOwner?.credentialsStatus || mother.credentialsStatus, sub2apiStatus: primaryOwner?.sub2apiStatus || { imported: Boolean(mother.hasAccessToken), exportable: Boolean(mother.hasAccessToken) }, joinedAt: mother.createdAt, joinedTeams: [{ team: teamId, status: 'active', joinedAt: mother.createdAt }], ...ownerQuota };
    const seatTotal = Number.isFinite(Number(mother.seats)) ? Number(mother.seats) : numericOrNull(snapshot.seatsEntitled);
    const seatUsed = Number.isFinite(Number(mother.used)) ? Number(mother.used) : numericOrNull(snapshot.seatsInUse);
    const seatTypes = seatBreakdown(snapshot);
    const teamChildren = children.filter((child) => isMemberOfTeam(child, teamId) && child.status !== 'kicked').map((child) => accountForTeam(child, teamId));
    const remoteMembers = (mother.members || []).filter((item) => (item.email || item.id) && !item.deactivated_time && !item.deactivatedTime);
    const authoritativeMembers = mother.lastMembersProbe?.ok === true;
    const memberSnapshots = authoritativeMembers ? remoteMembers : [...remoteMembers, ...teamChildren.map((child) => child.memberSnapshot)].filter(Boolean);
    const owners = normalizedOwners(authoritativeMembers ? { ...mother, email: '', ownerAccounts: [] } : mother, memberSnapshots);
    const ownerEmails = new Set(owners.map((owner) => String(owner.email || '').toLowerCase()).filter(Boolean));
    const rows = [];
    const groups = groupTeamAccounts(remoteMembers, teamChildren, { authoritativeMembers });
    for (const group of groups) {
      const { child } = group;
      const member = group.member || child?.memberSnapshot || null;
      const email = member?.email || child?.email || '';
      const isOwner = isOwnerMember(member || {}) || email.toLowerCase() === mother.email?.toLowerCase() || member?.id === mother.chatgptUserId || ownerEmails.has(email.toLowerCase());
      const ownerRecord = isOwner ? teamOwnerRecordFor(mother, email) : null;
      let account = null;
      if (child) {
        const scoped = teamScopedAccount(child, teamId, ownerRecord);
        account = {
          ...scoped,
          id: child.id,
          email: child.email || member?.email || '',
          memberId: child.memberId || member?.id || null,
          accountUserId: child.accountUserId || member?.accountUserId || member?.account_user_id || null,
          credentialsStatus: child.credentialsStatus || scoped.credentialsStatus || null,
          seatType: member?.seatType || member?.seat_type || scoped.seatType || null,
          joinedAt: scoped.joinedAt || member?.createdTime || member?.created_time || null,
        };
      } else if (ownerRecord) {
        account = {
          ...ownerRecord,
          id: ownerRecord.id || member?.id || member?.accountUserId || null,
          email: member?.email || ownerRecord.email || '',
          name: member?.name || ownerRecord.name || '',
          status: 'active',
          seatType: member?.seatType || member?.seat_type || null,
          joinedAt: member?.createdTime || member?.created_time || mother.createdAt || null,
          joinedTeams: [{ team: teamId, status: 'active', joinedAt: member?.createdTime || member?.created_time || mother.createdAt || null }],
        };
      }
      rows.push({ identityKey: group.identityKey, member, child: account, childId: child?.id || null, isOwner });
    }
    for (const owner of authoritativeMembers ? [] : (mother.ownerAccounts || [])) {
      if (!owner.email || rows.some((row) => row.child?.email?.toLowerCase() === owner.email.toLowerCase() || row.member?.email?.toLowerCase() === owner.email.toLowerCase())) continue;
      rows.push({ identityKey: `email:${owner.email.toLowerCase()}`, member: { email: owner.email, id: owner.userId || null, role: 'account-owner' }, child: { ...ownerAccount, ...teamOwnerRecordFor(mother, owner.email), id: owner.userId || `owner_${rows.length}`, email: owner.email, name: owner.name || '', status: 'active', joinedAt: mother.createdAt, joinedTeams: [{ team: teamId, status: 'active', joinedAt: mother.createdAt }] }, childId: null, isOwner: true });
    }
    if (!authoritativeMembers && !rows.some((row) => row.isOwner) && mother.email) rows.unshift({ identityKey: `email:${mother.email.toLowerCase()}`, member: { email: mother.email, id: mother.chatgptUserId || null }, child: ownerAccount, childId: null, isOwner: true });
    return {
      id: mother.id,
      teamId,
      name: displayName,
      displayName,
      mother,
      owners,
      owner: owners[0] || { email: mother.email || '', name: mother.name || '', userId: mother.chatgptUserId || null },
      seats: { used: seatUsed, total: seatTotal, open: seatUsed != null && seatTotal != null ? Math.max(0, seatTotal - seatUsed) : null, reserved: Math.max(0, Number(mother.seatClaimsCount) || 0), types: seatTypes },
      rows,
      lastSync: mother.lastWorkspaceSyncAt || mother.lastCheck || null,
    };
  }), [mothers, children]);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => {
      setProgress((value) => value >= 100 ? 4 : value + 4);
      setLastSync('刚刚');
    }, 6000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const hasActiveRotation = mothers.some((mother) => mother.rotationProgress?.status === 'running');
  const hasActiveManualKickTimers = children.some((child) => joinedTeamsFor(child).some((membership) => membership.manualKickEnabled === true));
  useEffect(() => {
    if (!isProcessing && !isRunning && !hasActiveManualKickTimers) return undefined;
    let cancelled = false;
    let loading = false;
    const refreshProgress = async () => {
      if (loading) return;
      loading = true;
      try {
        const payload = await apiRequest('/api/state?includeHistory=false');
        if (!cancelled) applyStatePayload(payload, setChildren, setMothers);
      } catch {
        // The foreground operation reports the actionable error.
      } finally {
        loading = false;
      }
    };
    void refreshProgress();
    const timer = window.setInterval(refreshProgress, isProcessing || hasActiveRotation ? 700 : 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isProcessing, isRunning, hasActiveRotation, hasActiveManualKickTimers]);

  useEffect(() => {
    const rotationTeams = automaticMothers.filter((mother) => mother.hasAccessToken && (mother.accountId || mother.team));
    if (!isRunning || rotationTeams.length < 2) return undefined;
    const timer = setInterval(() => {
      setSelectedTeam((current) => {
        const index = rotationTeams.findIndex((mother) => mother.id === current);
        return rotationTeams[(index < 0 ? 0 : index + 1) % rotationTeams.length]?.id || current;
      });
    }, 7000);
    return () => clearInterval(timer);
  }, [isRunning, automaticMothers]);

  function notify(message, type = 'success') {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3200);
  }

  async function refreshState(showError = true) {
    try {
      const payload = await apiRequest('/api/state?includeHistory=false');
      applyStatePayload(payload, setChildren, setMothers);
      setHistoryReloadKey((value) => value + 1);
      if (payload.settings) {
        setAutoRefill(payload.settings.autoRefill !== false);
        setThreshold(Number(payload.settings.threshold) || 10);
        setCheckInterval(Number(payload.settings.checkInterval) || 60);
        setConcurrency(Math.min(10, Math.max(1, Number(payload.settings.concurrency) || 3)));
        setKickWindow(['5h', '7d', 'time'].includes(payload.settings.kickWindow) ? payload.settings.kickWindow : '5h');
        setKickAfterHours(Math.min(720, Math.max(1, Number(payload.settings.kickAfterHours) || 12)));
        setPromoteJoinedAccounts(payload.settings.promoteJoinedAccounts !== false);
        setIntegrations((current) => mergedIntegrations(current, payload.settings.integrations));
        setProxySettings((current) => ({ ...current, ...(payload.settings.proxy || {}), entries: Array.isArray(payload.settings.proxy?.entries) ? payload.settings.proxy.entries : current.entries }));
        setIsRunning(Boolean(payload.mothers?.length) && payload.settings.autoRefill !== false);
      }
      return payload;
    } catch (error) {
      if (showError) notify(`同步失败：${error.message}`, 'error');
      throw error;
    }
  }

  function changeHistoryPage(nextPage) {
    const totalPages = Math.max(1, Number(historyMeta.totalPages) || 1);
    setHistoryPage(Math.min(totalPages, Math.max(1, Number(nextPage) || 1)));
  }

  function changeHistoryPageSize(nextPageSize) {
    const value = Number(nextPageSize);
    if (!historyPageSizeOptions.includes(value)) return;
    setHistoryPageSize(value);
    setHistoryPage(1);
  }

  function reloadHistory() {
    setHistoryReloadKey((value) => value + 1);
  }

  async function loadBillingPreviews() {
    if (!mothers.length) {
      setBillingPreviewError('请先添加一个 Team');
      return;
    }
    setBillingPreviewLoading(true);
    setBillingPreviewError('');
    try {
      const payload = await apiRequest('/api/teams/billing-preview', { method: 'POST', body: JSON.stringify({ thresholdDays: 7 }) });
      setBillingPreviewData({
        ...payload,
        items: Array.isArray(payload.items) ? payload.items : [],
      });
      reloadHistory();
      await refreshState(false).catch(() => {});
    } catch (error) {
      setBillingPreviewError(error.message || '临期 Team 查询失败');
    } finally {
      setBillingPreviewLoading(false);
    }
  }

  function openBillingPreviews() {
    setShowBillingPreview(true);
    void loadBillingPreviews();
  }

  async function runCheck(motherId = null) {
    if (!motherId && !mothers.length) { notify('请先添加一个 Team', 'error'); return; }
    const allTeams = !motherId;
    const taskId = createTask('check', allTeams ? `检测全部 ${mothers.length} 个 Team` : '检测 Team 额度', motherId, allTeams ? '同步所有 Team 的席位、成员和 5h / 7d 额度' : '同步席位、成员和 5h / 7d 额度');
    setStage('monitor'); setProgress(12); setIsProcessing(true); notify(allTeams ? `已启动全部 ${mothers.length} 个 Team 的额度检测` : '额度检测已启动', 'info');
    try {
      const result = await apiRequest(allTeams ? '/api/maintenance/check-all' : '/api/maintenance/check', { method: 'POST', body: JSON.stringify(allTeams ? {} : { motherId }) });
      await refreshState(false);
      setProgress(100); setLastSync('刚刚'); setStage('refill');
      const checked = result.checked ?? result.results?.length ?? 0;
      const quotaResults = allTeams
        ? (result.teams || []).flatMap((team) => team.results || [])
        : (result.results || []);
      const recoveries = quotaResults.map((item) => item.tokenRecovery).filter(Boolean);
      const recovered = quotaResults.filter((item) => item.tokenRecovery?.ok && item.ok === true).length;
      const waitingForLogin = recoveries.filter((item) => !item.ok && (item.needsInput || item.browserRequired)).length;
      const failedRecovery = recoveries.find((item) => !item.ok);
      const recoveryDetail = recovered
        ? `；已自动更新 ${recovered} 个 Team JSON`
        : waitingForLogin
          ? `；${waitingForLogin} 个账号需要完成登录验证后重试`
          : recoveries.length
            ? `；OAuth 已自动重登但未恢复${failedRecovery?.message ? `：${failedRecovery.message}` : '，请检查 Free 账号凭据'}`
            : '';
      if (result.ok === false) { const message = `${allTeams ? '多 Team 检测部分失败' : '检测部分失败'}，已检查 ${allTeams ? `${result.succeeded || 0}/${result.teamCount || mothers.length} 个 Team，` : ''}${checked} 个账号${recoveryDetail}`; finishTask(taskId, 'partial', message, result); notify(message, 'error'); }
      else { const message = `${allTeams ? `全部 ${result.teamCount || mothers.length} 个 Team` : '检测'}完成，已检查 ${checked} 个账号`; finishTask(taskId, 'completed', message, result); notify(message); }
    } catch (error) {
      finishTask(taskId, 'failed', `检测失败：${error.message}`);
      setProgress(0); notify(`额度检测失败：${error.message}`, 'error');
    } finally { setIsProcessing(false); }
  }

  async function refillSeats(motherId = null) {
    if (!motherId && !mothers.length) { notify('请先添加一个 Team', 'error'); return; }
    const allTeams = !motherId;
    const taskId = createTask('refill', allTeams ? `补满全部 ${mothers.length} 个 Team` : '补满 Team 席位', motherId, allTeams ? '按空席位从 Free 池补位' : '先同步席位，再按空席位从 Free 池补位');
    setProgress(20); setIsProcessing(true); notify(allTeams ? `正在为全部 ${mothers.length} 个 Team 移除耗尽账号并补位` : '正在移除耗尽账号并补位', 'info');
    try {
      const result = await apiRequest(allTeams ? '/api/maintenance/refill-all' : '/api/maintenance/refill', { method: 'POST', body: JSON.stringify(allTeams ? {} : { motherId }) });
      await refreshState(false);
      setStage('join'); setProgress(100);
      const message = result.ok === false ? `多 Team 补位未完全成功，已处理 ${result.teamCount || 0} 个 Team` : `${allTeams ? `全部 ${result.teamCount || mothers.length} 个 Team` : '补位'}完成：移除 ${result.kicked?.length || 0} 个，加入 ${result.joined?.length || 0} 个`;
      finishTask(taskId, result.ok === false ? 'partial' : 'completed', message, result);
      notify(message, result.ok === false ? 'error' : 'success');
    } catch (error) {
      finishTask(taskId, 'failed', `补位失败：${error.message}`);
      setProgress(0); notify(`补位失败：${error.message}`, 'error');
    } finally { setIsProcessing(false); }
  }

  async function toggleAutomation() {
    const next = !isRunning;
    setIsRunning(next);
    setAutoRefill(next);
    try {
      await apiRequest('/api/settings', { method: 'PATCH', body: JSON.stringify({ autoRefill: next }) });
      notify(next ? '自动化已恢复' : '自动化已暂停', 'info');
    } catch (error) {
      setIsRunning(!next);
      setAutoRefill(!next);
      notify(`自动化设置失败：${error.message}`, 'error');
    }
  }

  async function syncNow() {
    await runCheck();
  }

  async function saveSettings() {
    try {
      await apiRequest('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ autoRefill, promoteJoinedAccounts, threshold: Number(threshold), checkInterval: Number(checkInterval), concurrency: Number(concurrency), kickWindow, kickAfterHours: Number(kickAfterHours) }),
      });
      await refreshState(false);
      notify('自动化设置已保存');
    } catch (error) { notify(`设置保存失败：${error.message}`, 'error'); }
  }

  async function saveIntegration(type, next) {
    try {
      await apiRequest('/api/integrations', { method: 'PATCH', body: JSON.stringify(type === 'sub2api' ? { sub2apis: next } : { mailbox: next }) });
      setShowIntegration(null);
      await refreshState(false);
      notify(`${type === 'sub2api' ? 'Sub2API' : '邮箱 / 接码'}配置已保存`);
    } catch (error) { notify(`集成配置保存失败：${error.message}`, 'error'); }
  }

  async function saveProxySettings(next) {
    try {
      const payload = await apiRequest('/api/proxy', { method: 'PATCH', body: JSON.stringify({ enabled: next.enabled, strategy: next.strategy, timeoutMs: Number(next.timeoutMs), maxRetries: Number(next.maxRetries) }) });
      setProxySettings(payload.proxy || defaultProxySettings);
      setShowProxy(false);
      notify('代理设置已保存');
    } catch (error) { notify(`代理设置保存失败：${error.message}`, 'error'); }
  }

  async function addProxyEntries(values) {
    try {
      const payload = await apiRequest('/api/proxy/entries', { method: 'POST', body: JSON.stringify({ values }) });
      setProxySettings((current) => ({ ...current, ...(payload.proxy || {}), entries: Array.isArray(payload.proxy?.entries) ? payload.proxy.entries : current.entries }));
      if (payload.errors?.length) notify(`已添加 ${payload.added?.length || 0} 条，${payload.errors.length} 条格式或重复项未添加`, 'info');
      else notify(`已添加 ${payload.added?.length || values.length} 条代理`);
      return payload;
    } catch (error) {
      const errors = error.payload?.errors || [];
      notify(errors.length ? `代理未添加：${errors.map((item) => item.message).join('、')}` : `代理添加失败：${error.message}`, 'error');
      return null;
    }
  }

  async function removeProxyEntry(id) {
    try {
      const payload = await apiRequest(`/api/proxy/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setProxySettings((current) => ({ ...current, ...(payload.proxy || {}), entries: Array.isArray(payload.proxy?.entries) ? payload.proxy.entries : current.entries.filter((entry) => entry.id !== id) }));
      notify('代理已删除', 'info');
    } catch (error) { notify(`代理删除失败：${error.message}`, 'error'); }
  }

  function openJsonImport(id) {
    const child = children.find((item) => item.id === id);
    if (!child) return;
    setJsonImportChild(child);
    setJsonImportText('');
    setShowJsonImport(true);
  }

  async function acquireAccount(id, mode = 'refresh-at', credentials = {}) {
    if (!id || acquireStates[id]?.loading) return;
    setAcquireStates((current) => ({ ...current, [id]: { loading: true, status: 'queued' } }));
    try {
      const result = await apiRequest(`/api/children/${encodeURIComponent(id)}/acquire`, { method: 'POST', body: JSON.stringify({ ...credentials, mode, action: mode, format: mode === 'free-json' ? 'free-json' : 'access-token', refresh: mode === 'refresh-at' }) });
      await refreshState(false);
      const status = normalizeAcquireStatus(result);
      setAcquireStates((current) => ({ ...current, [id]: { loading: false, status, message: result.message || result.child?.login?.message || '', authUrl: result.authUrl || result.child?.login?.authUrl || '', browserRequired: Boolean(result.browserRequired || result.child?.login?.browserRequired) } }));
      if (mode === 'free-json' && status === 'ready') await downloadFreeJson(id);
      const message = status === 'phone_required' ? '账号需要手机号验证，自动登录已停止，请完成接码后重试' : status === 'browser_required' ? '需要浏览器验证，请打开授权链接' : status === 'waiting_code' ? '正在等待验证码' : status === 'failed' ? 'Free JSON 获取失败' : mode === 'free-json' ? 'Free JSON 获取完成' : 'AT 刷新完成';
      notify(message, status === 'failed' ? 'error' : ['phone_required', 'browser_required', 'waiting_code'].includes(status) ? 'info' : 'success');
    } catch (error) {
      const payload = error.payload || {};
      const status = normalizeAcquireStatus(payload);
      const authUrl = payload.authUrl || payload.child?.login?.authUrl || '';
      setAcquireStates((current) => ({ ...current, [id]: { loading: false, status, message: payload.message || payload.child?.login?.message || '', authUrl, browserRequired: Boolean(payload.browserRequired || payload.child?.login?.browserRequired) } }));
      await refreshState(false).catch(() => {});
      const message = status === 'phone_required' ? '账号需要手机号验证，自动登录已停止，请完成接码后重试' : status === 'browser_required' ? '需要浏览器验证，请打开授权链接' : status === 'waiting_code' ? '正在等待验证码' : '账号获取失败，请检查账号状态';
      notify(message, ['phone_required', 'browser_required', 'waiting_code'].includes(status) ? 'info' : 'error');
    }
  }

  async function acquireMissingFreeJson() {
    if (batchAcquire.loading) return;
    const missing = accountRecords.filter((account) => !account.sub2apiStatus?.exportable);
    if (!missing.length) {
      notify('所有 Free 账号都已有可导出的 JSON', 'info');
      return;
    }
    const missingIds = new Set(missing.map((account) => account.id));
    const taskId = createTask('acquire', `批量获取 ${missing.length} 个 Free JSON`, null, `按 ${concurrency} 并发获取 AT / RT`);
    setAcquireStates((current) => {
      const next = { ...current };
      for (const account of missing) next[account.id] = { loading: true, status: 'queued', message: '等待批量获取' };
      return next;
    });
    setBatchAcquire({ loading: true, result: { totalMissing: missing.length, concurrency } });
    try {
      const result = await apiRequest('/api/children/acquire-missing-json', { method: 'POST', body: '{}' });
      setAcquireStates((current) => {
        const next = { ...current };
        for (const item of result.results || []) {
          next[item.id] = { loading: false, status: normalizeAcquireStatus(item), message: item.message || '', browserRequired: Boolean(item.browserRequired) };
        }
        return next;
      });
      await refreshState(false);
      setBatchAcquire({ loading: false, result });
      const summary = `批量获取完成：成功 ${result.acquired || 0} 个，失败 ${result.failed || 0} 个，跳过 ${result.skipped || 0} 个`;
      finishTask(taskId, result.failed || result.skipped ? 'partial' : 'completed', summary, result);
      notify(summary, result.failed || result.skipped ? 'info' : 'success');
    } catch (error) {
      setAcquireStates((current) => {
        const next = { ...current };
        for (const id of missingIds) if (next[id]?.loading) next[id] = { loading: false, status: 'failed', message: error.message || '批量获取失败' };
        return next;
      });
      setBatchAcquire({ loading: false, result: { totalMissing: missing.length, concurrency, error: error.message || '批量获取失败' } });
      finishTask(taskId, 'failed', `批量获取失败：${error.message}`);
      notify(`批量获取 Free JSON 失败：${error.message}`, 'error');
    }
  }

  async function downloadFreeJson(id) {
    try {
      const payload = await apiRequest(`/api/children/${encodeURIComponent(id)}/export`, { method: 'POST', body: '{}' });
      const email = payload.account?.email || id;
      const blob = new Blob([JSON.stringify({ exported_at: payload.exported_at, accounts: payload.account ? [payload.account] : [] }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `free-${email.replace(/[^a-z0-9_.-]+/gi, '_')}.json`; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { notify('Free JSON 已生成，但下载失败，请使用批量导出', 'error'); }
  }

  function openAccount(account = null) {
    if (account?.recordType === 'mother') {
      const mother = mothers.find((item) => item.id === account.sourceMotherId || item.id === account.id);
      if (mother) { openMother(mother); return; }
    }
    setEditingAccountId(account?.id || null);
    setShowAccount(true);
  }

  function openTeamDetail(teamId) {
    setDetailTeamId(teamId);
    setShowTeamDetail(true);
  }

  async function saveAccount(next, sub2apiJson = '') {
    let recordSaved = false;
    let savedChildId = editingAccountId;
    try {
      const path = editingAccountId ? `/api/children/${encodeURIComponent(editingAccountId)}` : '/api/children';
      const method = editingAccountId ? 'PATCH' : 'POST';
      const saved = await apiRequest(path, { method, body: JSON.stringify(next) });
      recordSaved = true;
      const childId = editingAccountId || saved.child?.id || saved.id;
      savedChildId = childId;
      const json = String(sub2apiJson || '').trim();
      if (json) {
        if (!childId) throw new Error('账号已保存，但无法定位记录以导入 JSON');
        await apiRequest(`/api/children/${encodeURIComponent(childId)}/sub2api`, { method: 'PUT', body: JSON.stringify({ json }) });
      }
      await refreshState(false);
      setShowAccount(false);
      notify(json ? '账号和完整 Free Sub2API JSON 已保存' : editingAccountId ? '账号记录已保存' : 'Free 账号已添加');
      return true;
    } catch (error) {
      if (recordSaved) {
        await refreshState(false).catch(() => {});
        if (!editingAccountId && savedChildId) setShowAccount(false);
      }
      notify(recordSaved ? `账号凭据已保存，但 JSON 录入失败：${error.message}。可在该账号的编辑面板中重试。` : `账号保存失败：${error.message}`, 'error');
      return false;
    }
  }

  async function saveAccountAndAcquire(next) {
    try {
      const payload = await apiRequest('/api/children', { method: 'POST', body: JSON.stringify(next) });
      const id = payload.child?.id;
      if (!id) throw new Error('账号创建失败');
      setShowAccount(false);
      await refreshState(false);
      notify('Free 账号已添加，开始获取 JSON', 'info');
      await acquireAccount(id, 'free-json', next);
    } catch (error) { notify(`账号创建失败：${error.message}`, 'error'); }
  }

  async function importAccountSub2Api(id, jsonText) {
    const json = String(jsonText || '').trim();
    if (!json) { notify('请粘贴完整的 Sub2API JSON', 'error'); return false; }
    try {
      await apiRequest(`/api/children/${encodeURIComponent(id)}/sub2api`, { method: 'PUT', body: JSON.stringify({ json }) });
      await refreshState(false);
      notify('Free Sub2API JSON 已录入');
      return true;
    } catch (error) {
      notify(`Sub2API JSON 录入失败：${error.message}`, 'error');
      return false;
    }
  }

  function openMother(mother = null) {
    setEditingMotherId(mother?.id || null);
    setShowMother(true);
  }

  function openMotherManager(mother) {
    setManagedMotherId(mother.id);
    setManagerAction({ loading: false, message: '' });
  }

  async function manageMother(id, operation, fields = {}) {
    const labels = { save: '保存凭据', probe: '检测母号', recover: '恢复管理凭据' };
    setManagerAction({ loading: true, message: `正在${labels[operation]}` });
    try {
      const result = await apiRequest(`/api/mothers/${encodeURIComponent(id)}${operation === 'save' ? '' : `/${operation}`}`, {
        method: operation === 'save' ? 'PATCH' : 'POST', body: JSON.stringify(fields),
      });
      if (operation === 'save') applyStatePayload(result, setChildren, setMothers);
      await syncNow(false);
      const message = operation === 'probe'
        ? result.accountStatus === 'banned' ? `母号已封禁：${result.banReason}` : result.ok ? '母号额度正常' : `母号额度检测受阻：${result.message || result.status || '未知错误'}`
        : operation === 'recover' ? 'Team 管理凭据已恢复' : '母号凭据已保存';
      setManagerAction({ loading: false, message });
      notify(message, result.ok === false ? 'info' : 'success');
      return true;
    } catch (error) {
      await syncNow(false).catch(() => {});
      const message = `${labels[operation]}失败：${error.message}`;
      setManagerAction({ loading: false, message, authUrl: error.payload?.authUrl || '' });
      notify(message, 'error');
      return false;
    }
  }

  async function deleteMother(id) {
    const mother = mothers.find((item) => item.id === id);
    if (!mother || !window.confirm(`确认从本项目删除 ${teamDisplayName(mother)}？不会删除远端 Team、Free 账号或 Sub2API 数据。`)) return;
    setManagerAction({ loading: true, message: '正在删除本地 Team 记录' });
    try {
      const result = await apiRequest(`/api/mothers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      applyStatePayload(result.state, setChildren, setMothers);
      await syncNow(false);
      setManagedMotherId(null);
      setShowTeamDetail(false);
      if (selectedTeam === id) setSelectedTeam(null);
      notify(`Team 已从项目删除，解除 ${result.deleted?.detached || 0} 个账号关联`);
    } catch (error) {
      setManagerAction({ loading: false, message: `删除失败：${error.message}` });
      notify(`删除 Team 失败：${error.message}`, 'error');
    }
  }

  async function importChildren() {
    let items = Array.isArray(importAccounts) ? importAccounts : [];
    const source = Array.isArray(importAccounts) ? 'sub2api' : 'manual';
    if (!items.length && importText.trim()) {
      const lines = importText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      items = lines.map((line) => {
        const parts = splitCredentialLine(line);
        return importMode === 'password-2fa'
          ? { email: parts[0] || '', password: parts[1] || '', totp: parts[2] || '' }
          : { email: parts[0] || '', mailboxUrl: parts[1] || '' };
      });
    }
    if (!items.length) { notify('请先选择 Sub2API JSON 文件或粘贴账号信息', 'error'); return; }
    try {
      await apiRequest('/api/children/import', { method: 'POST', body: JSON.stringify({ items, source }) });
      await refreshState(false);
      setImportText(''); setImportAccounts(null); setImportFileName(''); setShowImport(false);
      notify(`已导入 ${items.length} 个账号`);
    } catch (error) { notify(`导入失败：${error.message}`, 'error'); }
  }

  async function importSub2ApiFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
      if (!Array.isArray(accounts)) throw new Error('JSON 中没有 accounts 数组');
      const normalized = accounts.map(normalizeSub2ApiAccount).filter((item) => item.email || item.accessToken || item.accountId);
      if (!normalized.length) throw new Error('没有可导入的账号记录');
      setImportAccounts(normalized);
      setImportText('');
      setImportFileName(`${file.name} · ${normalized.length} 个账号`);
      notify(`已读取 ${normalized.length} 个账号，请选择导入类型后确认`, 'info');
    } catch (error) { event.target.value = ''; notify(`JSON 读取失败：${error.message}`, 'error'); }
  }

  async function exportSub2Api() {
    try {
      const payload = await apiRequest('/api/sub2api/export', { method: 'POST', body: JSON.stringify({}) });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sub2api-accounts.json'; anchor.click(); URL.revokeObjectURL(url);
      notify(`已导出 ${payload.accounts?.length || 0} 个账号的 Sub2API 文件`);
    } catch (error) { notify(`导出失败：${error.message}`, 'error'); }
  }

  async function exportTeamSub2Api(motherId = null) {
    try {
      const payload = await apiRequest('/api/sub2api/team-export', { method: 'POST', body: JSON.stringify(motherId ? { motherId } : {}) });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = motherId ? 'sub2api-team-account.json' : 'sub2api-team-accounts.json'; anchor.click(); URL.revokeObjectURL(url);
      notify(`已导出 ${payload.accounts?.length || 0} 个 Team 账号的 Sub2API 文件`);
    } catch (error) { notify(`Team JSON 导出失败：${error.message}`, 'error'); }
  }

  async function pushSub2Api() {
    const target = integrations.sub2apis?.[0] || integrations.sub2api || {};
    const hasGroupId = Number.isFinite(Number(target.groupId)) && Number(target.groupId) > 0;
    if (!target.enabled || !target.baseUrl || !target.apiKeySet || (!hasGroupId && !String(target.groupName || '').trim())) {
      notify('请先在设置中配置 Sub2API 服务、密钥和同步分组名称或 ID', 'error');
      setView('settings'); setShowIntegration('sub2api');
      return;
    }
    try {
      const result = await apiRequest('/api/sub2api/push', { method: 'POST', body: JSON.stringify({}) });
      notify(result.ok === false ? `Sub2API 部分推送失败：新增 ${result.pushed?.length || 0} 个，失败 ${result.failed?.length || 0} 个` : `新增 ${result.pushed?.length || 0} 个账号，已存在跳过 ${result.skipped?.length || 0} 个`, result.ok === false ? 'error' : 'success');
      await refreshState(false);
    } catch (error) { notify(`Sub2API 推送失败：${error.message}`, 'error'); }
  }

  async function pushTeamSub2Api(motherId = null) {
    const configs = integrations.sub2apis?.length ? integrations.sub2apis : [integrations.sub2api || {}];
    const mother = motherId ? mothers.find((item) => item.id === motherId) : null;
    const targetMothers = mother ? [mother] : mothers;
    const invalidTargets = targetMothers.filter((item) => {
      const target = configs.find((config) => config.id === item.sub2apiIntegrationId) || (!item.sub2apiIntegrationId ? configs[0] : null);
      const hasGroupId = Number.isFinite(Number(target?.groupId)) && Number(target.groupId) > 0;
      return !target?.enabled || !target?.baseUrl || !target?.apiKeySet || (!hasGroupId && !String(target?.groupName || '').trim());
    });
    if (invalidTargets.length) {
      notify(`${invalidTargets.length} 个 Team 的目标 Sub2API 未配置完整，请先处理`, 'error');
      setShowTeamDetail(false);
      setView('settings');
      setShowIntegration('sub2api');
      return;
    }
    try {
      const result = await apiRequest('/api/sub2api/team-push', { method: 'POST', body: JSON.stringify(motherId ? { motherId } : {}) });
      notify(result.ok === false ? `Team 推送部分失败：新增 ${result.pushed?.length || 0} 个，跳过 ${result.skipped?.length || 0} 个，失败 ${result.failed?.length || 0} 个` : `新增 ${result.pushed?.length || 0} 个 Team 账号，已存在跳过 ${result.skipped?.length || 0} 个`, result.ok === false ? 'error' : 'success');
      await refreshState(false);
    } catch (error) { notify(`Team Sub2API 推送失败：${error.message}`, 'error'); }
  }

  async function updateMemberKickTimers(motherId, childIds, { enabled = true, durationHours = null } = {}) {
    const ids = [...new Set((childIds || []).filter(Boolean))];
    if (!motherId || !ids.length) return false;
    const actionLabel = enabled ? '启动退出倒计时' : '取消退出倒计时';
    const taskId = createTask('member-kick-timer', `${actionLabel} · ${ids.length} 个账号`, motherId, '更新 Team 成员的手动退出计划');
    try {
      updateTask(taskId, { progress: 45, message: '正在保存倒计时设置' });
      const body = { childIds: ids, enabled };
      if (enabled) body.durationHours = Number(durationHours);
      const payload = await apiRequest(`/api/mothers/${encodeURIComponent(motherId)}/member-kick-timers`, { method: 'POST', body: JSON.stringify(body) });
      applyStatePayload(payload.state || payload, setChildren, setMothers);
      await refreshState(false);
      const updatedCount = payload.updated?.length ?? ids.length;
      const skippedCount = payload.skipped?.length || 0;
      const message = `${updatedCount} 个账号已${enabled ? '开始倒计时' : '取消倒计时'}${skippedCount ? `，跳过 ${skippedCount} 个受保护或无效账号` : ''}`;
      finishTask(taskId, skippedCount ? 'partial' : 'completed', message, payload);
      notify(message, skippedCount ? 'info' : 'success');
      return true;
    } catch (error) {
      const message = `${actionLabel}失败：${error.message}`;
      finishTask(taskId, 'failed', message);
      notify(message, 'error');
      return false;
    }
  }

  async function removeChild(id) {
    const child = children.find((item) => item.id === id);
    if (!child || !child.team || child.status === 'kicked') return;
    try {
      await apiRequest(`/api/children/${encodeURIComponent(id)}/kick`, { method: 'POST', body: JSON.stringify({ reason: 'manual', retryAfter: null }) });
      await refreshState(false);
      notify('账号已移出当前 Team');
    } catch (error) { notify(`移除失败：${error.message}`, 'error'); }
  }

  async function deleteFreeAccount(id) {
    const child = children.find((item) => item.id === id);
    if (!child) return;
    const identifier = child.email || child.id;
    if (!window.confirm(`确认删除 Free 账号“${identifier}”？此操作只会删除本地记录。`)) return;
    try {
      const payload = await apiRequest(`/api/children/${encodeURIComponent(id)}`, { method: 'DELETE' });
      applyStatePayload(payload, setChildren, setMothers);
      await refreshState(false);
      notify('Free 账号已删除');
    } catch (error) {
      if (error.payload?.message === 'child_has_active_team_memberships') {
        notify('该 Free 账号仍在 Team 中，请先移出所有当前 Team 后再删除本地记录', 'error');
        return;
      }
      notify(`删除 Free 账号失败：${error.message}`, 'error');
    }
  }

  async function batchDeleteBannedAccounts(ids) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return null;
    if (!window.confirm(`确认批量删除 ${uniqueIds.length} 个封禁账号的本地记录？仍在 Team 中的账号会自动跳过。`)) return null;
    try {
      const payload = await apiRequest('/api/children/batch-delete', { method: 'POST', body: JSON.stringify({ ids: uniqueIds, bannedOnly: true }) });
      applyStatePayload(payload.state || payload, setChildren, setMothers);
      await refreshState(false);
      const deleted = payload.deleted?.length || 0;
      const skipped = payload.skipped?.length || 0;
      notify(`批量删除完成：删除 ${deleted} 个${skipped ? `，跳过 ${skipped} 个仍在 Team 或状态不匹配的账号` : ''}`, skipped ? 'info' : 'success');
      return payload;
    } catch (error) {
      notify(`批量删除封禁账号失败：${error.message}`, 'error');
      return null;
    }
  }

  async function saveMother(next) {
    if (!String(next.accountId || next.team || '').trim()) {
      notify('请填写 Team ID（chatgpt_account_id）', 'error');
      return;
    }
    try {
      const path = editingMotherId ? `/api/mothers/${encodeURIComponent(editingMotherId)}` : '/api/mothers';
      const method = editingMotherId ? 'PATCH' : 'POST';
      const teamId = next.accountId || next.team || '';
      const inviteSeatType = ['default', 'prolite'].includes(next.inviteSeatType) ? next.inviteSeatType : 'auto';
      const payload = await apiRequest(path, { method, body: JSON.stringify({ ...next, team: teamId, accountId: teamId, teamName: next.teamName || next.displayName || '', rotationMode: next.rotationMode === 'rotating' ? 'rotating' : 'fixed', inviteSeatType, primaryOwnerEmail: next.primaryOwnerEmail || next.email || '', accessToken: next.accessToken || next.token || '' }) });
      applyStatePayload(payload, setChildren, setMothers);
      reloadHistory();
      setSelectedTeam(next.id); setShowMother(false);
      notify(editingMotherId ? 'Team 配置已保存' : 'Team 已添加');
    } catch (error) { notify(`母号保存失败：${error.message}`, 'error'); }
  }

  function closeImport() {
    setShowImport(false);
    setImportText('');
    setImportAccounts(null);
    setImportFileName('');
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Zap size={17} strokeWidth={2.6} /></div><div><strong>team轮转</strong><span>TEAM AUTOMATION</span></div></div>
      <nav className="main-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}><Icon size={17} />{label}{id === 'free' && <em>{accountRecords.length}</em>}</button>)}</nav>
      <div className="top-actions"><button className="icon-button theme-toggle" title={theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'} aria-label={theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><button className="icon-button" title="Agent 接入与功能说明" aria-label="Agent 接入与功能说明" onClick={() => setShowAgentHelp(true)}><CircleHelp size={18} /></button><button className="icon-button" title="更多" aria-label="更多"><MoreHorizontal size={19} /></button><div className="avatar" title="当前用户">AL</div></div>
    </header>

    <main className={`main-content ${view === 'run' ? 'home-content' : ''}`}>
      <div className="page-heading"><div><div className="breadcrumb"><span>我的工作区</span><ChevronRight size={14} /><strong>{view === 'run' ? '首页' : navItems.find((item) => item.id === view)?.label}</strong></div><h1>{view === 'run' ? 'Team 配额自动化' : navItems.find((item) => item.id === view)?.label}</h1><p>{view === 'run' ? '持续监控 Team 席位与账号额度，自动完成移除和补位。' : view === 'teams' ? '管理 Team 所有者、席位和当前成员。' : view === 'free' ? '维护账号凭据、加入过的 Team 和 Sub2API 状态。' : '集中管理自动检测和操作记录。'}</p></div><div className="heading-actions"><span className={isRunning ? 'live-badge on' : 'live-badge'}><i />{isRunning ? 'Live' : 'Paused'}</span><button className="button ghost" onClick={toggleAutomation}>{isRunning ? <Pause size={15} /> : <Play size={15} />}{isRunning ? '暂停' : '恢复'}</button><button className="button primary" onClick={syncNow}><RefreshCw size={15} />同步进度</button></div></div>

      {view === 'run' && <RunView activeMother={activeMother} activeChildren={activeChildren} trackedChildren={trackedChildren} readyChildren={readyChildren} exhausted={exhausted} canRefillAll={anyExhausted || anyOpenSeat || kickWindow === 'time'} lowQuota={lowQuota} seatsOpen={seatsOpen} stage={stage} progress={progress} isRunning={isRunning} isProcessing={isProcessing} lastSync={lastSync} runCheck={runCheck} refillSeats={refillSeats} setShowMother={() => openMother(activeMother)} setSelectedTeam={setSelectedTeam} mothers={mothers} autoRefill={autoRefill} />}
      {view === 'teams' && <TeamManagementView teams={teamRecords} openTeam={openMother} openDetail={openTeamDetail} setShowImport={() => setShowImport(true)} exportTeamSub2Api={exportTeamSub2Api} pushTeamSub2Api={pushTeamSub2Api} openBillingPreviews={openBillingPreviews} billingPreviewLoading={billingPreviewLoading} />}
      {view === 'free' && <FreeAccountsView children={filteredAccounts} allChildren={accountRecords} mothers={mothers} search={search} setSearch={setSearch} setShowImport={() => setShowImport(true)} addAccount={() => openAccount()} exportSub2Api={exportSub2Api} pushSub2Api={pushSub2Api} removeChild={removeChild} deleteFreeAccount={deleteFreeAccount} batchDeleteBannedAccounts={batchDeleteBannedAccounts} openJsonImport={openJsonImport} editAccount={openAccount} acquireAccount={acquireAccount} acquireMissingFreeJson={acquireMissingFreeJson} acquireStates={acquireStates} batchAcquire={batchAcquire} concurrency={concurrency} />}
      {view === 'history' && <HistoryView history={history} page={historyPage} pageSize={historyPageSize} meta={historyMeta} loading={historyLoading} error={historyError} onPageChange={changeHistoryPage} onPageSizeChange={changeHistoryPageSize} onRetry={reloadHistory} onSelect={setSelectedHistory} />}
      {view === 'settings' && <SettingsView autoRefill={autoRefill} setAutoRefill={setAutoRefill} promoteJoinedAccounts={promoteJoinedAccounts} setPromoteJoinedAccounts={setPromoteJoinedAccounts} threshold={threshold} setThreshold={setThreshold} checkInterval={checkInterval} setCheckInterval={setCheckInterval} concurrency={concurrency} setConcurrency={setConcurrency} kickWindow={kickWindow} setKickWindow={setKickWindow} kickAfterHours={kickAfterHours} setKickAfterHours={setKickAfterHours} integrations={integrations} openIntegration={setShowIntegration} proxy={proxySettings} openProxy={() => setShowProxy(true)} saveSettings={saveSettings} />}
    </main>

    {showImport && <Modal title="导入账号" onClose={closeImport}><div className="modal-intro">Sub2API 混合文件会按 `plan_type` 自动分流：Team 记录合并到对应空间并保留多个所有者，Free 记录进入普通账号池。完整凭据只提交服务端，不写入浏览器存储。</div><label className="file-picker"><span>选择 Sub2API JSON</span><input type="file" accept="application/json,.json" onChange={importSub2ApiFile} /><small>{importFileName || '未选择文件'}</small></label><div className="segmented">{[['email-code', '邮箱 / 接码地址'], ['password-2fa', '邮箱 / 密码 / 2FA']].map(([id, label]) => <button key={id} className={importMode === id ? 'selected' : ''} onClick={() => setImportMode(id)}>{label}</button>)}</div><textarea className="import-area" value={importText} onChange={(event) => { setImportAccounts(null); setImportFileName(''); setImportText(event.target.value); }} placeholder={importMode === 'email-code' ? 'name@example.com | sms-provider://address\nname2@example.com | https://mailbox.example/...' : 'name@example.com----password----2fa-secret'} /><div className="modal-foot"><span className="muted">{importAccounts?.length ? `${importAccounts.length} 个 JSON 账号待导入` : '支持粘贴账号信息；不会生成演示账号。'}</span><button className="button primary" onClick={importChildren}><ArrowDownToLine size={15} />开始导入</button></div></Modal>}
    {showJsonImport && <Modal title="导入 Free Sub2API JSON" onClose={() => setShowJsonImport(false)}><div className="modal-intro">账号：<strong>{jsonImportChild?.email}</strong><br />粘贴该 Free 账号完整的 Sub2API JSON，系统会保存 AT、RT 和关联字段。Team JSON 不能录入到 Free 账号。</div><textarea className="import-area" aria-label="Free Sub2API JSON" value={jsonImportText} onChange={(event) => setJsonImportText(event.target.value)} placeholder={'粘贴完整 Sub2API JSON，例如：\n{\n  "credentials": { ... }\n}'} /><div className="modal-foot"><span className="muted">完整凭据仅提交服务端保存，不会在列表中显示。</span><button className="button primary" disabled={!jsonImportText.trim() || jsonImporting} onClick={async () => { if (!jsonImportChild) return; setJsonImporting(true); try { if (await importAccountSub2Api(jsonImportChild.id, jsonImportText)) setShowJsonImport(false); } finally { setJsonImporting(false); } }}><FileText size={15} />{jsonImporting ? '导入中' : '导入 JSON'}</button></div></Modal>}
    {showMother && <MotherModal key={editingMotherId || 'new'} mother={editingMotherId ? mothers.find((item) => item.id === editingMotherId) : null} sub2apis={integrations.sub2apis || []} onClose={() => setShowMother(false)} onSave={saveMother} />}
    {showAccount && <AccountModal account={editingAccountId ? children.find((item) => item.id === editingAccountId) : null} onClose={() => setShowAccount(false)} onSave={saveAccount} onSaveAndAcquire={saveAccountAndAcquire} onAcquire={acquireAccount} acquireState={editingAccountId ? acquireStates[editingAccountId] : null} />}
    {showIntegration === 'sub2api' && <Sub2ApiModal configs={integrations.sub2apis || []} mothers={mothers} onClose={() => setShowIntegration(null)} onSave={(next) => saveIntegration('sub2api', next)} />}
    {showIntegration === 'mailbox' && <IntegrationModal type="mailbox" config={integrations.mailbox} onClose={() => setShowIntegration(null)} onSave={(next) => saveIntegration('mailbox', next)} />}
    {showProxy && <ProxyModal proxy={proxySettings} onClose={() => setShowProxy(false)} onSave={saveProxySettings} onAdd={addProxyEntries} onRemove={removeProxyEntry} notify={notify} />}
    {showTeamDetail && <TeamDetailModal team={teamRecords.find((item) => item.id === detailTeamId) || null} onClose={() => setShowTeamDetail(false)} runCheck={runCheck} refillSeats={refillSeats} setSelectedTeam={setSelectedTeam} openTeam={openMother} manageMother={openMotherManager} exportTeamSub2Api={exportTeamSub2Api} pushTeamSub2Api={pushTeamSub2Api} updateMemberKickTimers={updateMemberKickTimers} automationEnabled={autoRefill && (teamRecords.find((item) => item.id === detailTeamId)?.mother?.rotationEnabled !== false)} kickWindow={kickWindow} kickAfterHours={kickAfterHours} />}
    {managedMotherId && <MotherManagerModal mother={mothers.find((item) => item.id === managedMotherId)} action={managerAction} onClose={() => setManagedMotherId(null)} onSave={(fields) => manageMother(managedMotherId, 'save', fields)} onProbe={() => manageMother(managedMotherId, 'probe')} onRecover={(fields) => manageMother(managedMotherId, 'recover', fields)} onDelete={() => deleteMother(managedMotherId)} />}
    {showBillingPreview && <BillingPreviewModal data={billingPreviewData} loading={billingPreviewLoading} error={billingPreviewError} onRefresh={loadBillingPreviews} onClose={() => setShowBillingPreview(false)} />}
    {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    {showAgentHelp && <AgentAccessModal onClose={() => setShowAgentHelp(false)} notify={notify} />}
    <TaskCenter tasks={tasks} open={showTaskCenter} onOpen={() => setShowTaskCenter(true)} onClose={() => setShowTaskCenter(false)} />
    {selectedHistory && <HistoryDetailModal item={selectedHistory} onClose={() => setSelectedHistory(null)} />}
    {toast && <div className={`toast ${toast.type}`}><CheckCircle2 size={18} /><span>{toast.message}</span><button onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}

function displayTime(value) {
  if (!value) return '未检测';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function teamRetryLabel(entry) {
  if (!entry?.retryAfter) return entry?.status === 'cooldown' ? '等待额度刷新' : '';
  const retryAt = Date.parse(entry.retryAfter);
  return Number.isFinite(retryAt) && retryAt <= Date.now() ? '现在可重试' : `${displayTime(entry.retryAfter)} 后可重试`;
}

function RotationCountdown({ joinedAt, hours }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!joinedAt) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [joinedAt]);
  const joinedTimestamp = Date.parse(joinedAt || '');
  const durationMs = Math.max(1, Number(hours) || 12) * 60 * 60 * 1000;
  if (!Number.isFinite(joinedTimestamp)) return <small className="muted">等待加入时间</small>;
  const remainingMs = joinedTimestamp + durationMs - Date.now();
  if (remainingMs <= 0) return <small className="rotation-countdown due">已到轮转时间</small>;
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const remainingHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const label = remainingHours ? `${remainingHours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  return <small className="rotation-countdown">剩余 {label}</small>;
}

function manualKickTimerFor(account, membership) {
  const timer = membership?.kickTimer || account?.kickTimer || {};
  const enabled = membership?.manualKickEnabled ?? account?.manualKickEnabled ?? timer.enabled ?? false;
  const kickAt = membership?.manualKickAt || account?.manualKickAt || timer.kickAt || timer.expiresAt || null;
  const startedAt = membership?.manualKickStartedAt || account?.manualKickStartedAt || timer.startedAt || null;
  const durationMinutes = membership?.manualKickDurationMinutes ?? account?.manualKickDurationMinutes ?? timer.durationMinutes ?? null;
  const parsedKickAt = Date.parse(kickAt || '');
  const expired = membership?.manualKickExpired ?? account?.manualKickExpired ?? (Number.isFinite(parsedKickAt) && parsedKickAt <= Date.now());
  return { enabled: enabled === true, kickAt, startedAt, durationMinutes, expired: Boolean(expired) };
}

function ManualKickCountdown({ timer }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timer?.enabled || !timer?.kickAt) return undefined;
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [timer?.enabled, timer?.kickAt]);
  if (!timer?.enabled) return <span className="manual-timer-empty">未设置</span>;
  const kickAt = Date.parse(timer.kickAt || '');
  if (!Number.isFinite(kickAt)) return <span className="manual-timer-state pending"><strong>已开启</strong><small>等待服务端确认时间</small></span>;
  const remainingSeconds = Math.max(0, Math.ceil((kickAt - Date.now()) / 1000));
  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor((remainingSeconds % 86400) / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const due = timer.expired || remainingSeconds <= 0;
  return <span className={`manual-timer-state ${due ? 'due' : 'running'}`}><strong>{due ? '等待移出' : `${days ? `${days}天 ` : ''}${clock}`}</strong><small>{displayTime(timer.kickAt)} 到期</small></span>;
}

function dailyRotationValues(mother = {}) {
  const usage = mother.dailyRotationUsage || {};
  const limit = Math.max(1, Number(usage.limit ?? mother.dailyRotationLimit) || 3);
  const count = Math.max(0, Number(usage.count) || 0);
  return { count, limit, remaining: Math.max(0, Number(usage.remaining ?? limit - count) || 0) };
}

function TeamRotationStatus({ mother }) {
  const enabled = mother?.rotationEnabled !== false;
  return <span className={`status-chip ${enabled ? 'active' : 'rotation-paused'}`}><i />{enabled ? '参与轮转' : '不参与轮转'}</span>;
}

function TeamHealthStatus({ mother }) {
  const account = mother?.accountStatus || (mother?.status === 'online' ? 'healthy' : mother?.status === 'banned' ? 'banned' : mother?.status === 'offline' ? 'probe_blocked' : null);
  const accountLabel = account === 'banned' ? '账号已封禁' : account === 'healthy' ? '母号额度正常' : account === 'probe_blocked' ? '额度检测受阻' : account === 'auth_required' ? '需要登录' : '未检测';
  const management = mother?.managementStatus;
  const managementLabel = management === 'ready' ? '可管理 Team' : management === 'forbidden' ? '管理权限不足' : management === 'auth_required' ? '管理凭据失效' : management === 'degraded' ? '订阅同步受阻' : management === 'blocked' ? '管理同步受阻' : '';
  return <span className="team-health-status"><span className={`status-chip ${account === 'healthy' ? 'online' : account === 'banned' ? 'banned' : account === 'probe_blocked' ? 'warning' : ''}`} title={mother?.lastProbe?.message || '母号额度接口状态'}><i />{accountLabel}</span>{managementLabel && management !== 'ready' && <span className={`status-chip ${management === 'forbidden' ? 'banned' : 'warning'}`} title={[mother?.lastMembersProbe?.message, mother?.lastSubscriptionProbe?.message].filter(Boolean).join('；')}><i />{managementLabel}</span>}</span>;
}

function TeamManagementView({ teams, openTeam, openDetail, setShowImport, exportTeamSub2Api, pushTeamSub2Api, openBillingPreviews, billingPreviewLoading }) {
  const totalSeats = teams.reduce((sum, team) => sum + (Number(team.seats.total) || 0), 0);
  const usedSeats = teams.reduce((sum, team) => sum + (Number(team.seats.used) || 0), 0);
  const openSeats = teams.reduce((sum, team) => sum + (Number(team.seats.open) || 0), 0);
  return <section className="team-management">
    <section className="metrics">
      <Metric label="Team 空间" value={teams.length} detail="当前接入的空间" icon={Users} tone="blue" />
      <Metric label="席位使用" value={`${usedSeats} / ${totalSeats || '--'}`} detail={openSeats ? `还可加入 ${openSeats} 个账号` : '当前没有空席位'} icon={LayoutDashboard} tone="green" />
      <Metric label="当前账号" value={teams.reduce((sum, team) => sum + team.rows.length, 0)} detail="已同步成员列表" icon={UserRound} tone="amber" />
      <Metric label="同步状态" value={teams.length ? '已接入' : '未配置'} detail={teams.length ? '点击管理查看额度' : '添加 Team 后开始'} icon={Activity} tone="slate" />
    </section>
    <section className="content-panel team-list-panel">
      <div className="content-toolbar"><div><h2>Team 管理</h2><p>按空间查看所有者、席位和当前成员；账号详情在管理弹窗中展示。</p></div><div className="toolbar-actions"><button className="button secondary" onClick={openBillingPreviews} disabled={!teams.length || billingPreviewLoading} title={teams.length ? '查询所有 Team 的到期时间与新增普通席位费用' : '请先添加 Team'}><Clock3 size={15} className={billingPreviewLoading ? 'button-spinner' : ''} />{billingPreviewLoading ? '查询中' : '临期 Team'}</button><button className="button ghost" onClick={() => exportTeamSub2Api()}><Download size={15} />导出 Team JSON</button><button className="button secondary" onClick={() => pushTeamSub2Api()}><ExternalLink size={15} />推送 Team</button><button className="button ghost" onClick={setShowImport}><ArrowDownToLine size={15} />导入账号</button><button className="button primary" onClick={() => openTeam()}><Plus size={15} />添加 Team</button></div></div>
      {!teams.length ? <div className="empty-state"><Users size={28} /><strong>还没有 Team 空间</strong><span>添加 Team 后会显示空间、所有者和席位。</span></div> : <div className="table-wrap team-list-wrap"><table className="data-table team-list-table"><thead><tr><th>Team 空间</th><th>所有者</th><th>席位</th><th>当前账号</th><th>今日轮转</th><th>状态</th><th>最后同步</th><th /></tr></thead><tbody>{teams.map((team) => {
        const status = team.mother.status || 'unconfigured';
        const statusLabel = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未检测';
        const daily = dailyRotationValues(team.mother);
        return <tr key={team.id}>
          <td><div className="team-list-title"><div className="team-avatar"><Users size={17} /></div><div><strong>{team.displayName}</strong><small className="team-sub2api-target">{team.mother.sub2apiIntegrationName || '未配置 Sub2API'}</small></div></div></td>
          <td><OwnerEmails owners={team.owners} /></td>
          <td><div className="table-seats"><span>{team.seats.used == null || team.seats.total == null ? '--' : `${team.seats.used}/${team.seats.total}`}</span><i><b style={{ width: `${team.seats.total ? Math.min(100, (team.seats.used || 0) / team.seats.total * 100) : 0}%` }} /></i></div>{team.seats.reserved > 0 && <small className="seat-policy-label">待核验占位 {team.seats.reserved}</small>}{team.seats.types?.length ? <div className="seat-type-list">{team.seats.types.map((seat) => <small key={seat.type}>{seat.label} {seat.used == null ? '--' : `${seat.used}/${seat.total}`}</small>)}</div> : null}<small className="seat-policy-label">补位：{inviteSeatTypeLabel(team.mother.inviteSeatType)}</small></td>
          <td>{team.rows.length} 个</td>
          <td><span className={`rotation-limit ${daily.remaining === 0 ? 'reached' : ''}`}>{daily.count} / {daily.limit}</span></td>
          <td><div className="team-status-stack"><TeamHealthStatus mother={team.mother} /><TeamRotationStatus mother={team.mother} /></div></td>
          <td>{displayTime(team.lastSync)}</td>
          <td><button className="button ghost compact-button" onClick={() => openDetail(team.id)}><Settings2 size={14} />管理</button></td>
        </tr>;
      })}</tbody></table></div>}
    </section>
  </section>;
}

function durationLabel(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return '';
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 0 : 1)}s`;
}

function RotationProgress({ progress }) {
  if (!progress?.steps?.length) return null;
  const running = progress.status === 'running';
  const stateLabel = running ? progress.message || '轮换处理中' : progress.status === 'completed' ? '最近一次轮换已完成' : progress.status === 'failed' ? '最近一次轮换失败' : '最近一次轮换部分完成';
  return <section className={`rotation-progress ${progress.status || ''}`}>
    <div className="rotation-progress-head"><div><span>ROTATION PIPELINE</span><strong>{stateLabel}</strong>{progress.account && <small>{progress.account}</small>}</div><b>{running ? '运行中' : durationLabel(progress.durationMs)}</b></div>
    <div className="rotation-progress-steps">{progress.steps.map((step) => <div className={`rotation-progress-step ${step.status}`} key={step.id}>{step.status === 'running' ? <RefreshCw size={13} /> : step.status === 'completed' ? <Check size={13} /> : step.status === 'failed' ? <AlertTriangle size={13} /> : <Clock3 size={13} />}<span>{step.label}</span>{step.durationMs != null && <small>{durationLabel(step.durationMs)}</small>}</div>)}</div>
  </section>;
}

function taskStatusLabel(status) {
  return { queued: '排队中', running: '运行中', completed: '已完成', partial: '部分完成', failed: '失败' }[status] || '未知';
}

function taskTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function TaskCenter({ tasks, open, onOpen, onClose }) {
  const active = tasks.find((task) => task.status === 'running' || task.status === 'queued');
  const recent = tasks.slice(0, 5);
  return <>
    <button className={`task-dock ${active ? 'running' : ''}`} onClick={onOpen} title="打开任务中心"><span className="task-dock-icon">{active ? <RefreshCw size={16} /> : <Clock3 size={16} />}</span><span><strong>{active ? '任务执行中' : '任务中心'}</strong><small>{active ? `${active.progress || 0}% · ${active.message || active.label}` : `${tasks.length} 条记录`}</small></span><ChevronRight size={15} /></button>
    {open && <Modal title="任务中心" onClose={onClose} className="task-center-modal"><div className="task-center-intro">查看检测、补位、定时退出和账号处理任务的实时状态、进度与执行结果。</div><div className="task-list">{recent.length ? recent.map((task) => <article className={`task-item ${task.status}`} key={task.id}><div className="task-item-head"><div><strong>{task.label}</strong><span>{taskStatusLabel(task.status)} · 创建 {taskTime(task.createdAt)}</span></div><b>{task.progress ?? 0}%</b></div><div className="task-progress"><i style={{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }} /></div><p>{task.message || task.details || '等待更新'}{task.account ? ` · 当前账号：${task.account}` : ''}</p><small>开始：{taskTime(task.startedAt)}　完成：{taskTime(task.completedAt)}</small></article>) : <div className="empty-state compact-empty"><Clock3 size={25} /><strong>暂无任务</strong><span>点击检测、补满席位、设置倒计时或批量获取后会显示进度。</span></div>}</div><div className="modal-foot"><span className="muted">任务记录保留最近 30 条</span><button className="button ghost" onClick={onClose}>关闭</button></div></Modal>}
  </>;
}

function TeamDetailModal({ team, onClose, runCheck, refillSeats, setSelectedTeam, openTeam, manageMother, exportTeamSub2Api, pushTeamSub2Api, updateMemberKickTimers, automationEnabled, kickWindow, kickAfterHours }) {
  const [selectedChildIds, setSelectedChildIds] = useState([]);
  const [showKickTimer, setShowKickTimer] = useState(false);
  const [timerHours, setTimerHours] = useState(String(Math.max(1, Number(kickAfterHours) || 12)));
  const [timerError, setTimerError] = useState('');
  const [timerSaving, setTimerSaving] = useState(false);
  const rows = team?.rows || [];
  const primaryOwnerEmail = String(team?.mother?.primaryOwnerEmail || team?.mother?.email || '').trim().toLowerCase();
  const fixedRotation = (team?.mother?.rotationMode || 'fixed') !== 'rotating';
  const rowDetails = rows.map((row, index) => {
    const account = row.child;
    const email = account?.email || row.member?.email || '未识别邮箱';
    const memberships = account?.joinedTeams || [];
    const membership = memberships.find((entry) => entry.team === team?.teamId && entry.status === 'active') || memberships.find((entry) => entry.team === team?.teamId);
    const fixedPrimary = fixedRotation && Boolean(primaryOwnerEmail) && email.trim().toLowerCase() === primaryOwnerEmail;
    const banned = account?.status === 'banned' || account?.banStatus === 'banned';
    const selectable = Boolean(row.childId) && !fixedPrimary && rows.length > 1 && account?.status !== 'kicked' && !banned;
    const disabledReason = !row.childId ? '该成员未关联到 Free 账号池' : fixedPrimary ? '固定主号不能设置退出倒计时' : rows.length <= 1 ? 'Team 至少需要保留一个账号' : account?.status === 'kicked' ? '账号已移出 Team' : banned ? '封禁账号无需设置退出倒计时' : '';
    return {
      row,
      account,
      email,
      membership,
      fixedPrimary,
      selectable,
      disabledReason,
      timer: manualKickTimerFor(account, membership),
      joinedAt: membership?.joinedAt || account?.joinedAt || row.member?.createdTime,
      memberSeatType: row.member?.seatType || account?.seatType || account?.memberSnapshot?.seatType,
      key: row.identityKey || `${email}-${row.member?.id || row.childId || index}`,
    };
  });
  const selectableIds = rowDetails.filter((item) => item.selectable).map((item) => item.row.childId);
  const selectableKey = selectableIds.join('|');
  useEffect(() => {
    setSelectedChildIds((current) => current.filter((id) => selectableIds.includes(id)));
  }, [team?.id, selectableKey]);
  if (!team) return null;

  const selectedSet = new Set(selectedChildIds);
  const allSelected = Boolean(selectableIds.length) && selectableIds.every((id) => selectedSet.has(id));
  const someSelected = selectableIds.some((id) => selectedSet.has(id));
  const activeTimerIds = rowDetails.filter((item) => item.row.childId && item.timer.enabled).map((item) => item.row.childId);
  const selectedTimerIds = selectedChildIds.filter((id) => activeTimerIds.includes(id));
  const hours = Number(timerHours);
  const validHours = Number.isFinite(hours) && hours >= (1 / 60) && hours <= 720;
  const status = team.mother.status || 'unconfigured';
  const daily = dailyRotationValues(team.mother);
  const statusLabel = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未检测';

  function toggleSelection(childId, checked) {
    setSelectedChildIds((current) => checked ? [...new Set([...current, childId])] : current.filter((id) => id !== childId));
  }

  function openTimerFor(ids = selectedChildIds) {
    const nextIds = [...new Set(ids.filter(Boolean))];
    if (!nextIds.length) return;
    setSelectedChildIds(nextIds);
    setTimerError('');
    setShowKickTimer(true);
  }

  async function saveTimer(event) {
    event?.preventDefault();
    if (!validHours) {
      setTimerError('请输入 1 分钟到 720 小时之间的时间');
      return;
    }
    setTimerSaving(true);
    const saved = await updateMemberKickTimers(team.mother.id, selectedChildIds, { enabled: true, durationHours: hours });
    setTimerSaving(false);
    if (saved) {
      setShowKickTimer(false);
      setSelectedChildIds([]);
    }
  }

  async function cancelTimers(ids = selectedTimerIds) {
    if (!ids.length) return;
    setTimerSaving(true);
    const saved = await updateMemberKickTimers(team.mother.id, ids, { enabled: false });
    setTimerSaving(false);
    if (saved) setSelectedChildIds((current) => current.filter((id) => !ids.includes(id)));
  }

  return <Modal title={`Team 账号详情 · ${team.displayName}`} onClose={onClose} className="team-detail-modal">
    <div className="team-detail-top"><div><span className="kicker">TEAM SPACE</span><strong className="team-detail-name">{team.displayName}</strong><small className="team-sub2api-target">同步到 {team.mother.sub2apiIntegrationName || '未配置 Sub2API'}</small></div><div className="team-detail-actions"><TeamRotationStatus mother={team.mother} /><TeamHealthStatus mother={team.mother} /><button className="button secondary compact-button" onClick={() => manageMother(team.mother)}><KeyRound size={14} />管理母号</button><button className="button ghost compact-button" onClick={() => { onClose(); openTeam(team.mother); }}><Settings2 size={14} />编辑 Team</button></div></div>
    <div className="team-detail-summary"><div><span>所有者</span><OwnerEmails owners={team.owners} /><small>{team.owners?.length ? `${team.owners.length} 个所有者` : '未同步所有者'}</small></div><div><span>席位</span><strong>{team.seats.used == null || team.seats.total == null ? '--' : `${team.seats.used} / ${team.seats.total}`}</strong><small>{team.seats.open == null ? '尚未检测' : team.seats.open ? `剩余 ${team.seats.open} 个` : '已满'}</small>{team.seats.reserved > 0 && <small className="seat-policy-label">待核验占位 {team.seats.reserved}</small>}{team.seats.types?.length ? <div className="seat-type-list">{team.seats.types.map((seat) => <small key={seat.type}>{seat.label} {seat.used == null ? '--' : `${seat.used}/${seat.total}`}</small>)}</div> : null}<small className="seat-policy-label">补位策略：{inviteSeatTypeLabel(team.mother.inviteSeatType)}</small></div><div><span>今日轮转</span><strong>{daily.count} / {daily.limit}</strong><small>{daily.remaining ? `还可轮转 ${daily.remaining} 个账号` : '今日已达上限'}</small></div><div><span>最后同步</span><strong>{displayTime(team.lastSync)}</strong><small>{team.rows.length} 个当前账号</small></div></div>
    <RotationProgress progress={team.mother.rotationProgress} />
    <div className="team-detail-toolbar"><div><h3>当前账号</h3><span>额度、身份和凭据状态</span></div><div className="toolbar-actions"><button className="button ghost compact-button" onClick={() => exportTeamSub2Api(team.mother.id)}><Download size={14} />导出 JSON</button><button className="button secondary compact-button" onClick={() => pushTeamSub2Api(team.mother.id)}><ExternalLink size={14} />推送 Sub2API</button><button className="button ghost compact-button" onClick={() => { setSelectedTeam(team.id); runCheck(team.mother.id); }}><RefreshCw size={14} />检测额度</button><button className="button secondary compact-button" disabled={!team.mother.accountId && !team.mother.team} title={!team.mother.accountId && !team.mother.team ? '请先配置 Team ID' : '先同步席位，再从 Free 账号池并发补满空席位'} onClick={() => { setSelectedTeam(team.id); refillSeats(team.mother.id); }}><Sparkles size={14} />补满席位</button></div></div>
    <div className="member-timer-toolbar"><span><Clock3 size={14} />已选 {selectedChildIds.length} 个{activeTimerIds.length ? ` · ${activeTimerIds.length} 个倒计时中` : ''}{!automationEnabled && activeTimerIds.length ? ' · 自动轮转已暂停' : ''}</span><div><button className="button ghost compact-button" disabled={!selectedTimerIds.length || timerSaving} onClick={() => cancelTimers()}><X size={14} />取消倒计时{selectedTimerIds.length ? ` (${selectedTimerIds.length})` : ''}</button><button className="button secondary compact-button" disabled={!selectedChildIds.length || timerSaving} title="为选中账号设置退出时间；执行时始终保留至少一个 Team 成员" onClick={() => openTimerFor()}><Clock3 size={14} />启动倒计时{selectedChildIds.length ? ` (${selectedChildIds.length})` : ''}</button></div></div>
    <div className="table-wrap team-detail-table-wrap"><table className="data-table team-detail-table"><thead><tr><th className="timer-select-cell"><input type="checkbox" aria-label="选择全部可设置倒计时的账号" checked={allSelected} disabled={!selectableIds.length} ref={(node) => { if (node) node.indeterminate = someSelected && !allSelected; }} onChange={(event) => setSelectedChildIds(event.target.checked ? selectableIds : [])} /></th><th>账号</th><th>身份</th><th>5h 剩余</th><th>7d 剩余</th><th>登录凭据</th><th>Sub2API</th><th>{kickWindow === 'time' ? '加入时间 / 全局轮转' : '加入时间'}</th><th>手动退出</th></tr></thead><tbody>{rowDetails.map((item) => {
      const { row, account, email, joinedAt, memberSeatType, timer } = item;
      return <tr key={item.key} className={timer.enabled ? 'manual-timer-row' : ''}><td className="timer-select-cell"><span title={item.disabledReason || `选择 ${email}`}><input type="checkbox" aria-label={`选择 ${email}`} checked={selectedSet.has(row.childId)} disabled={!item.selectable} onChange={(event) => toggleSelection(row.childId, event.target.checked)} /></span></td><td><div className="account-cell"><div className="queue-avatar">{email[0]?.toUpperCase() || '?'}</div><div><strong>{email}</strong><small className="mono">{row.childId || account?.id || row.member?.id || '成员快照'}</small></div></div></td><td><div className="role-stack">{row.isOwner ? <span className="role-label owner">所有者</span> : <span className="role-label">成员</span>}{item.fixedPrimary && <small className="primary-owner-label">固定主号</small>}{memberSeatType && <small className={`seat-member-label ${memberSeatType === 'prolite' ? 'premium' : ''}`}>{seatTypeLabel(memberSeatType)}</small>}{account?.status === 'banned' && <StatusBadge status="banned" />}</div></td><td><QuotaBar value={account?.quota5h} /></td><td><QuotaBar value={account?.quota7d} /></td><td><CredentialState account={account} /></td><td><span className={`sub2api-state ${account?.sub2apiStatus?.imported ? 'ready' : ''}`}>{account?.sub2apiStatus?.imported ? '已记录' : '未记录'}</span></td><td><span>{joinedAt ? displayTime(joinedAt) : <span className="muted">成员同步</span>}</span>{kickWindow === 'time' && <RotationCountdown joinedAt={joinedAt} hours={kickAfterHours} />}</td><td><div className="manual-timer-cell"><ManualKickCountdown timer={timer} /><div className="manual-timer-actions"><button className="icon-button small" title={item.disabledReason || '设置退出倒计时'} aria-label={`设置 ${email} 的退出倒计时`} disabled={!item.selectable || timerSaving} onClick={() => openTimerFor([row.childId])}><Clock3 size={14} /></button>{timer.enabled && <button className="icon-button small danger-hover" title="取消退出倒计时" aria-label={`取消 ${email} 的退出倒计时`} disabled={!row.childId || timerSaving} onClick={() => cancelTimers([row.childId])}><X size={14} /></button>}</div></div></td></tr>;
    })}</tbody></table></div>
    {showKickTimer && createPortal(<Modal title={`设置退出倒计时 · ${selectedChildIds.length} 个账号`} onClose={() => !timerSaving && setShowKickTimer(false)} className="kick-timer-modal"><form className="kick-timer-form" onSubmit={saveTimer}><label><span>倒计时</span><div className="timer-hours-control"><input autoFocus type="number" min="0.0167" max="720" step="any" value={timerHours} onChange={(event) => { setTimerHours(event.target.value); setTimerError(''); }} /><b>小时</b></div></label><div className="timer-presets">{[1, 6, 12, 24].map((value) => <button type="button" className={Number(timerHours) === value ? 'selected' : ''} key={value} onClick={() => { setTimerHours(String(value)); setTimerError(''); }}>{value}h</button>)}</div>{timerError && <span className="timer-form-error">{timerError}</span>}<div className="timer-kick-preview"><Clock3 size={15} /><span>预计退出</span><strong>{validHours ? new Date(Date.now() + hours * 60 * 60 * 1000).toLocaleString('zh-CN') : '--'}</strong></div><div className="modal-foot"><span className="muted">{automationEnabled ? '到期后进入移出与补位流程' : '自动轮转已暂停；到期后等待恢复再执行'}</span><div className="modal-foot-actions"><button type="button" className="button ghost" disabled={timerSaving} onClick={() => setShowKickTimer(false)}>取消</button><button type="submit" className="button primary" disabled={!validHours || timerSaving}><Clock3 size={15} />{timerSaving ? '保存中' : '启动倒计时'}</button></div></div></form></Modal>, document.body)}
  </Modal>;
}

function TeamMaintenanceView({ teams, runCheck, refillSeats, setSelectedTeam, openTeam, setShowImport }) {
  const totalSeats = teams.reduce((sum, team) => sum + (team.seats.total || 0), 0);
  const usedSeats = teams.reduce((sum, team) => sum + (team.seats.used || 0), 0);
  const openSeats = teams.reduce((sum, team) => sum + (team.seats.open || 0), 0);
  const accountCount = teams.reduce((sum, team) => sum + team.rows.length, 0);
  return <section className="team-maintenance">
    <section className="metrics">
      <Metric label="Team 空间" value={teams.length} detail="当前接入的 Team" icon={Users} tone="blue" />
      <Metric label="席位使用" value={`${usedSeats} / ${totalSeats || '--'}`} detail={openSeats ? `还可加入 ${openSeats} 个账号` : '当前没有空席位'} icon={LayoutDashboard} tone="green" />
      <Metric label="Team 账号" value={accountCount} detail="已同步到成员列表" icon={UserRound} tone="amber" />
      <Metric label="维护状态" value={teams.length ? '自动检测中' : '未配置'} detail={teams.length ? '按设置周期轮询额度' : '添加 Team 后开始'} icon={Activity} tone="slate" />
    </section>
    <section className="content-panel team-panel">
      <div className="content-toolbar"><div><h2>Team 维护</h2><p>每个空间集中展示所有者、席位和当前账号额度。</p></div><div className="toolbar-actions"><button className="button ghost" onClick={setShowImport}><ArrowDownToLine size={15} />导入账号</button><button className="button primary" onClick={() => openTeam()}><Plus size={15} />添加 Team</button></div></div>
      {!teams.length && <div className="empty-state"><Users size={28} /><strong>还没有 Team 空间</strong><span>添加 Team 后，这里会显示所有者、席位和账号额度。</span></div>}
      <div className="team-record-list">{teams.map((team) => <article className="team-record" key={team.id}>
        <div className="team-record-head"><div className="team-title"><div className="team-avatar"><Users size={18} /></div><div><h3>{team.displayName}</h3></div></div><span className={`status-chip ${team.mother.status || 'unconfigured'}`}><i />{team.mother.status === 'online' ? '在线' : team.mother.status === 'offline' ? '离线' : '未检测'}</span></div>
        <div className="team-meta-grid"><div><span>所有者</span><OwnerEmails owners={team.owners} /><small>{team.owners?.length ? `${team.owners.length} 个所有者` : '未同步所有者'}</small></div><div><span>席位</span><strong>{team.seats.used == null || team.seats.total == null ? '--' : `${team.seats.used} / ${team.seats.total}`}</strong><small>{team.seats.open ? `剩余 ${team.seats.open} 个` : '已满'}</small></div><div><span>今日轮转</span><strong>{dailyRotationValues(team.mother).count} / {dailyRotationValues(team.mother).limit}</strong><small>{dailyRotationValues(team.mother).remaining ? `剩余 ${dailyRotationValues(team.mother).remaining} 次` : '已达上限'}</small></div><div><span>最后同步</span><strong>{displayTime(team.lastSync)}</strong><small>{team.rows.length} 个当前成员</small></div></div>
        <div className="team-record-actions"><button className="button ghost" onClick={() => { setSelectedTeam(team.id); runCheck(team.id); }}><RefreshCw size={14} />检测额度</button><button className="button secondary" disabled={!team.mother.accountId && !team.mother.team} title={!team.mother.accountId && !team.mother.team ? '请先配置 Team ID' : '先同步席位，再从 Free 账号池并发补满空席位'} onClick={() => { setSelectedTeam(team.id); refillSeats(team.id); }}><Sparkles size={14} />补满席位</button></div>
        <div className="team-member-heading"><div><h4>当前账号</h4><span>成员额度和凭据状态</span></div><b>{team.rows.length}</b></div>
        <div className="table-wrap team-member-wrap"><table className="data-table team-member-table"><thead><tr><th>账号</th><th>身份</th><th>5h 剩余</th><th>7d 剩余</th><th>凭据</th><th>加入记录</th></tr></thead><tbody>{team.rows.map((row, index) => { const account = row.child; const email = account?.email || row.member?.email || '未识别邮箱'; return <tr key={row.identityKey || `${email}-${row.member?.id || index}`}><td><div className="account-cell"><div className="queue-avatar">{email[0]?.toUpperCase() || '?'}</div><div><strong>{email}</strong><small className="mono">{account?.id || row.member?.id || '成员快照'}</small></div></div></td><td><div className="role-stack">{row.isOwner ? <span className="role-label owner">所有者</span> : <span className="role-label">成员</span>}{account?.status === 'banned' && <StatusBadge status="banned" />}</div></td><td><QuotaBar value={account?.quota5h} /></td><td><QuotaBar value={account?.quota7d} /></td><td><CredentialState account={account} /></td><td>{account?.joinedAt ? <span>{displayTime(account.joinedAt)}<small>{account.joinedTeams?.length || account.workspaceHistory?.length || 1} 个 Team</small></span> : <span className="muted">成员同步</span>}</td></tr>; })}</tbody></table></div>
      </article>)}</div>
    </section>
  </section>;
}

function CredentialState({ account }) {
  if (!account) return <span className="muted">未关联账号</span>;
  const status = account.credentialsStatus || {};
  return <span className="credential-state"><i className={status.hasPassword ? 'set' : ''} title={status.hasPassword ? '密码已录入' : '密码未录入'}>密</i><i className={status.hasTotp ? 'set' : ''} title={status.hasTotp ? '2FA 已录入' : '2FA 未录入'}>2FA</i></span>;
}

function FreeAccountsView({ children, allChildren, mothers, search, setSearch, setShowImport, addAccount, exportSub2Api, pushSub2Api, removeChild, deleteFreeAccount, batchDeleteBannedAccounts, openJsonImport, editAccount, acquireAccount, acquireMissingFreeJson, acquireStates, batchAcquire, concurrency }) {
  const [filter, setFilter] = useState('all');
  const [selectedBannedIds, setSelectedBannedIds] = useState([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const isBanned = (account) => account.banStatus === 'banned' || account.status === 'banned';
  const hasActiveTeam = (account) => joinedTeamsFor(account).some((entry) => entry.status === 'active');
  const isCooldown = (account) => ['kicked', 'cooldown'].includes(account.status) || joinedTeamsFor(account).some((entry) => ['kicked', 'cooldown'].includes(entry.status));
  const isMissingJson = (account) => !isBanned(account) && !account.sub2apiStatus?.exportable;
  const isVerification = (account) => !isBanned(account) && ['login_pending', 'login_required', 'phone_verification_required', 'browser_verification_required', 'verification_required', 'waiting_code'].includes(account.login?.status || account.loginStatus || account.status);
  const isDeletableBanned = (account) => isBanned(account) && !hasActiveTeam(account);
  const matchesFilter = (account, id) => id === 'all'
    || (id === 'free' && !isBanned(account) && !hasActiveTeam(account))
    || (id === 'team' && hasActiveTeam(account))
    || (id === 'cooldown' && isCooldown(account))
    || (id === 'missing-json' && isMissingJson(account))
    || (id === 'verification' && isVerification(account))
    || (id === 'banned' && isBanned(account));
  const visible = children.filter((account) => matchesFilter(account, filter));
  const filterOptions = [
    ['all', '全部', allChildren.length],
    ['free', '未加入', allChildren.filter((account) => matchesFilter(account, 'free')).length],
    ['team', '已加入', allChildren.filter((account) => matchesFilter(account, 'team')).length],
    ['cooldown', '冷却', allChildren.filter((account) => matchesFilter(account, 'cooldown')).length],
    ['missing-json', '缺 JSON', allChildren.filter((account) => matchesFilter(account, 'missing-json')).length],
    ['verification', '待验证', allChildren.filter((account) => matchesFilter(account, 'verification')).length],
    ['banned', '封禁', allChildren.filter((account) => matchesFilter(account, 'banned')).length],
  ];
  const freeCount = filterOptions.find(([id]) => id === 'free')[2];
  const teamCount = filterOptions.find(([id]) => id === 'team')[2];
  const bannedCount = filterOptions.find(([id]) => id === 'banned')[2];
  const missingJsonCount = filterOptions.find(([id]) => id === 'missing-json')[2];
  const selectedSet = new Set(selectedBannedIds);
  const selectableVisibleIds = visible.filter(isDeletableBanned).map((account) => account.id);
  const allVisibleSelected = selectableVisibleIds.length > 0 && selectableVisibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected = selectableVisibleIds.some((id) => selectedSet.has(id));
  const batchResult = batchAcquire?.result;

  useEffect(() => {
    const validIds = new Set(allChildren.filter(isDeletableBanned).map((account) => account.id));
    setSelectedBannedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [allChildren]);

  const toggleVisibleSelection = (checked) => {
    setSelectedBannedIds((current) => {
      const next = new Set(current);
      selectableVisibleIds.forEach((id) => checked ? next.add(id) : next.delete(id));
      return [...next];
    });
  };

  const deleteSelected = async () => {
    setBatchDeleting(true);
    try {
      const result = await batchDeleteBannedAccounts(selectedBannedIds);
      if (result) setSelectedBannedIds([]);
    } finally {
      setBatchDeleting(false);
    }
  };

  return <section className="free-maintenance">
    <section className="metrics"><Metric label="普通账号" value={allChildren.length} detail="不含 Team 所有者" icon={Users} tone="blue" /><Metric label="未加入 Team" value={freeCount} detail="可进入补位队列" icon={UserRound} tone="green" /><Metric label="已加入 Team" value={teamCount} detail="可同时保留多个空间" icon={LayoutDashboard} tone="amber" /><Metric label="已封禁" value={bannedCount} detail="永久排除自动补位" icon={ShieldAlert} tone="slate" /></section>
    <section className="content-panel account-panel"><div className="content-toolbar"><div><h2>Free 账号维护</h2><p>只记录普通账号；这里维护邮箱、凭据、加入过的 Team 和 Sub2API，不展示额度。</p></div><div className="toolbar-actions"><button className="button ghost" onClick={exportSub2Api}><Download size={15} />导出 Sub2API</button><button className="button secondary" onClick={pushSub2Api}><ExternalLink size={15} />推送到 Sub2API</button><button className="button secondary" onClick={acquireMissingFreeJson} disabled={batchAcquire?.loading || !missingJsonCount}><CloudDownload size={15} />{batchAcquire?.loading ? '批量获取中' : `批量获取 JSON${missingJsonCount ? ` (${missingJsonCount})` : ''}`}</button><button className="button ghost" onClick={setShowImport}><ArrowDownToLine size={15} />导入账号</button><button className="button primary" onClick={addAccount}><Plus size={15} />新增账号</button></div></div>
      {(batchAcquire?.loading || batchResult) && <div className={`batch-operation ${batchResult?.error ? 'failed' : batchAcquire?.loading ? 'running' : 'complete'}`}><div className="batch-operation-icon">{batchAcquire?.loading ? <RefreshCw size={16} /> : batchResult?.error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}</div><div><strong>{batchAcquire?.loading ? `正在按 ${concurrency} 并发获取 Free JSON` : batchResult?.error ? '批量获取失败' : '批量获取已完成'}</strong><span>{batchAcquire?.loading ? `待处理 ${batchResult?.totalMissing || missingJsonCount} 个缺少 JSON 的账号` : batchResult?.error || `成功 ${batchResult?.acquired || 0} 个 · 失败 ${batchResult?.failed || 0} 个 · 跳过 ${batchResult?.skipped || 0} 个 · 并发 ${batchResult?.concurrency || concurrency}`}</span></div></div>}
      <div className="filter-row"><div className="search-box"><ListFilter size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索邮箱、账号或 Team" /></div><div className="segmented compact-segmented account-status-filters">{filterOptions.map(([id, label, count]) => <button key={id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}<small>{count}</small></button>)}</div><span className="result-count">显示 {visible.length} / {allChildren.length}</span></div>
      <div className="bulk-delete-bar"><span><ShieldAlert size={14} />只可批量删除已封禁且不在 Team 中的账号</span><button className="button danger" disabled={!selectedBannedIds.length || batchDeleting} onClick={deleteSelected}><Trash2 size={15} />{batchDeleting ? '正在删除' : `删除已选封禁 (${selectedBannedIds.length})`}</button></div>
      <div className="table-wrap"><table className="data-table account-table"><thead><tr><th className="bulk-select-cell"><input type="checkbox" aria-label="全选当前结果中的可删除封禁账号" title="全选当前筛选结果中的可删除封禁账号" checked={allVisibleSelected} disabled={!selectableVisibleIds.length} ref={(node) => { if (node) node.indeterminate = someVisibleSelected && !allVisibleSelected; }} onChange={(event) => toggleVisibleSelection(event.target.checked)} /></th><th>账号</th><th>状态</th><th>登录凭据</th><th>当前 Team</th><th>加入过的 Team</th><th>Sub2API</th><th /></tr></thead><tbody>{visible.map((account) => { const joinedTeams = joinedTeamsFor(account); const activeTeams = joinedTeams.filter((entry) => entry.status === 'active'); const historyTeams = joinedTeams.filter((entry) => entry.status !== 'active'); const acquireState = acquireStates?.[account.id]; const banned = isBanned(account); const deletable = isDeletableBanned(account); return <tr className={banned ? 'banned-account-row' : ''} key={account.id}><td className="bulk-select-cell"><span title={!banned ? '仅封禁账号可批量选择' : !deletable ? '账号仍在 Team 中，请先移出 Team' : '选择此封禁账号'}><input type="checkbox" aria-label={`选择 ${account.email || account.id}`} checked={selectedSet.has(account.id)} disabled={!deletable} onChange={(event) => setSelectedBannedIds((current) => event.target.checked ? [...new Set([...current, account.id])] : current.filter((id) => id !== account.id))} /></span></td><td><div className="account-cell"><div className="queue-avatar">{(account.email || '?')[0].toUpperCase()}</div><div><strong>{account.email || '未设置邮箱'}</strong><small className="mono">{account.id} · {account.plan || '未检测'}</small>{banned && <small className="ban-reason" title={account.banReason || ''}>{account.banReason || 'OpenAI 账号已停用'}{account.bannedAt ? ` · ${displayTime(account.bannedAt)}` : ''}</small>}</div></div></td><td><StatusBadge status={banned ? 'banned' : account.status} /></td><td><div className="account-credential-cell"><CredentialState account={account} /><AcquireStatus state={acquireState} /></div></td><td>{activeTeams.length ? <div className="team-tags">{activeTeams.map((entry) => <span key={entry.team}>{teamNameForId(mothers, entry.team)}</span>)}</div> : <span className="muted">Free 池</span>}</td><td><div className="team-history-cell"><strong>{joinedTeams.length} 个空间</strong>{historyTeams.slice(-3).map((entry) => <small key={`${entry.team}-${entry.removedAt || entry.cooldownAt || entry.joinedAt}`}>{teamNameForId(mothers, entry.team)} · {entry.status === 'kicked' ? '已移出' : entry.status === 'cooldown' ? '冷却中' : '历史'}{entry.reason === 'account_banned' ? ' · 封禁' : entry.reason === 'manual_time_elapsed' ? ` · 手动定时退出${entry.retryAfter ? ` · ${teamRetryLabel(entry)}` : ''}` : entry.reason === 'time_elapsed' ? ` · 按时间轮转${entry.retryAfter ? ` · ${teamRetryLabel(entry)}` : ''}` : entry.retryAfter ? ` · ${teamRetryLabel(entry)}` : entry.status === 'cooldown' ? ' · 等待额度刷新' : ''}</small>)}</div></td><td><span className={`sub2api-state ${account.sub2apiStatus?.imported ? 'ready' : ''}`}>{account.sub2apiStatus?.imported ? '已记录' : '未记录'}</span>{account.sub2apiStatus?.exportable && <small>可导出</small>}</td><td><div className="row-actions"><button className="icon-button small" title={banned ? '封禁账号不能再获取 Free JSON' : '获取 Free JSON'} onClick={() => acquireAccount(account.id, 'free-json')} disabled={banned || Boolean(acquireState?.loading)}><CloudDownload size={15} /></button><button className="icon-button small" title={banned ? '封禁账号不能再刷新 AT' : '刷新 AT'} onClick={() => acquireAccount(account.id, 'refresh-at')} disabled={banned || Boolean(acquireState?.loading)}><RefreshCw size={15} /></button><button className="icon-button small" title="编辑账号" onClick={() => editAccount(account)}><Settings2 size={15} /></button><button className="icon-button small" title={banned ? '封禁账号不能再导入凭据' : '导入 Free Sub2API JSON'} aria-label="导入 Free Sub2API JSON" onClick={() => openJsonImport(account.id)} disabled={banned}><FileText size={15} /></button><button className="icon-button small" title="移出当前 Team" aria-label="移出当前 Team" onClick={() => removeChild(account.id)} disabled={!account.team}><UserMinus size={15} /></button><button className="icon-button small danger-hover" title="删除 Free 账号" aria-label="删除 Free 账号" onClick={() => deleteFreeAccount(account.id)}><Trash2 size={15} /></button></div></td></tr>; })}</tbody></table></div>{!visible.length && <div className="empty-state compact-empty"><UserRound size={26} /><strong>没有匹配的账号</strong><span>可以切换状态筛选或导入新账号。</span></div>}</section>
  </section>;
}

function RunView({ activeMother, activeChildren, trackedChildren, readyChildren, exhausted, canRefillAll, lowQuota, seatsOpen, stage, progress, isRunning, isProcessing, lastSync, runCheck, refillSeats, setShowMother, setSelectedTeam, mothers, autoRefill }) {
  const automaticMothers = mothers.filter((mother) => mother.rotationEnabled !== false);
  const automaticTeamCount = automaticMothers.length;
  const activeAutomationEnabled = isRunning && activeMother?.rotationEnabled !== false;
  const steps = [{ id: 'monitor', label: '监控额度', sub: `${trackedChildren.length} 个账号 · ${automaticTeamCount} 个 Team`, icon: Activity }, { id: 'kick', label: '移除耗尽', sub: exhausted.length ? `${exhausted.length} 个待处理` : '暂无待处理', icon: Trash2 }, { id: 'join', label: '加入 Team', sub: activeMother ? (seatsOpen ? `${seatsOpen} 个空席位` : '席位已满') : '暂无空间', icon: UserRound }, { id: 'refill', label: '满额补位', sub: readyChildren.length ? `${readyChildren.length} 个可加入` : '待加入池为空', icon: RefreshCw }];
  const activeIndex = Math.max(0, steps.findIndex((step) => step.id === stage));
  const seatsUsed = Number.isFinite(Number(activeMother?.used)) ? Number(activeMother.used) : null;
  const seatsTotal = Number.isFinite(Number(activeMother?.seats)) ? Number(activeMother.seats) : null;
  const displayName = teamDisplayName(activeMother);
  const isLive = activeAutomationEnabled || isProcessing;
  const traceItems = [{ title: '监控额度', sub: `${activeChildren.length} 个子号`, state: isProcessing && stage === 'monitor' ? '执行中' : activeAutomationEnabled ? '进行中' : '已暂停', icon: Gauge, tone: 'blue', active: isLive && stage === 'monitor' }, { title: '移除耗尽账号', sub: exhausted.length ? `${exhausted.length} 个待处理` : '队列为空', state: exhausted.length ? '待处理' : '已完成', icon: Trash2, tone: exhausted.length ? 'amber' : 'muted', active: isLive && stage === 'kick' }, { title: '加入 Team', sub: `${readyChildren.length} 个候选`, state: activeMother ? (seatsOpen ? '等待中' : '已满') : '未配置', icon: UserRound, tone: 'green', active: isLive && (stage === 'join' || stage === 'refill') }];
  return <>
      <section className="metrics"><Metric label="管理 Team" value={mothers.length || '未配置'} detail={mothers.length ? `${automaticTeamCount} 个参与自动轮转` : '请先添加 Team'} icon={KeyRound} tone="blue" /><Metric label="当前席位" value={activeMother ? `${seatsUsed == null ? '--' : seatsUsed} / ${seatsTotal == null ? '--' : seatsTotal}` : '未配置'} detail={activeMother ? (seatsOpen ? `还可加入 ${seatsOpen} 个账号` : seatsTotal == null ? '尚未获取席位' : '空间已满') : '添加 Team 后开始检测'} icon={Users} tone="green" /><Metric label="额度风险" value={lowQuota.length} detail={`${exhausted.length} 个已耗尽 · 当前空间`} icon={Gauge} tone="amber" /><Metric label="下次检测" value={activeAutomationEnabled ? '自动' : '--'} detail={`上次同步 ${lastSync} · ${activeMother?.rotationEnabled === false ? '当前 Team 已停用' : `${automaticTeamCount} 个空间参与`}`} icon={Clock3} tone="slate" /></section>
     <div className="run-layout"><section className="control-panel"><div className="panel-head"><div><span className="kicker">AUTOMATION FLOW</span><h2>配额自动补位</h2><p>所有者：<strong>{activeMother?.email}</strong></p></div><button className="settings-button" title="编辑 Team 配置" onClick={() => setShowMother(true)}><Settings2 size={17} /></button></div>
       <div className={`orbit-wrap ${isLive ? 'is-running' : ''}`}><div className="orbit-starfield" aria-hidden="true" /><div className={`orbit orbit-large ${isLive ? 'is-running' : ''}`} /><div className={`orbit orbit-small ${isLive ? 'is-running' : ''}`} /><div className={`orbit-core ${isLive ? 'is-running' : ''}`}><div className="core-icon"><Bot size={25} /></div><strong>{activeMother && seatsUsed != null && seatsTotal != null && seatsUsed >= seatsTotal && exhausted.length === 0 ? '运行稳定' : '需要处理'}</strong><span>{activeMother ? `${seatsUsed == null ? '--' : seatsUsed} / ${seatsTotal == null ? '--' : seatsTotal} 席位 · ${isProcessing ? '执行中' : activeMother.rotationEnabled === false ? '不参与轮转' : activeAutomationEnabled ? automaticTeamCount > 1 ? `自动轮转 ${automaticTeamCount} 个 Team` : '自动检测中' : '已暂停'}` : '尚未配置母号'}</span><div className={`core-progress ${isLive ? 'is-running' : ''}`}><i style={{ width: `${progress}%` }} /></div></div>
      {steps.map((step, index) => { const Icon = step.icon; const current = isLive && index === activeIndex; return <div key={step.id} className={`orbit-node node-${index + 1} ${index <= activeIndex ? 'reached' : ''} ${current ? 'current' : ''}`}><div className="node-icon"><Icon size={18} /></div><div><strong>{step.label}</strong><small>{step.sub}</small></div></div>; })}</div>
       <div className="control-actions"><button className="button primary" onClick={runCheck}><RefreshCw size={15} />检测全部 Team</button><button className="button secondary" onClick={refillSeats} disabled={!canRefillAll}><Sparkles size={15} />移除并补满全部</button></div>
      <div className="team-picker"><div><span>当前管理空间</span><strong>{activeMother ? displayName : '未配置母号'}</strong></div><select disabled={!mothers.length} value={activeMother?.id || ''} onChange={(event) => setSelectedTeam(event.target.value)}>{mothers.length ? mothers.map((mother) => <option value={mother.id} key={mother.id}>{teamDisplayName(mother)}</option>) : <option value="">添加母号后可选择空间</option>}</select></div>
     </section><aside className="activity-panel"><div className="panel-head compact"><div><span className="kicker">EXECUTION</span><h2>执行轨迹</h2></div><span className="count-pill">{automaticTeamCount} 个参与</span></div><div className="trace-list">{traceItems.map((item) => { const Icon = item.icon; return <div className={`trace-item ${item.tone} ${item.active ? 'is-active' : ''}`} key={item.title}><div className="trace-icon"><Icon size={16} /></div><div className="trace-copy"><strong>{item.title}</strong><small>{item.sub}</small></div><span>{item.state}</span></div>; })}</div><div className="queue-head"><span>待拉队列</span><b>{readyChildren.length}</b></div>{readyChildren.slice(0, 3).map((child) => <div className="queue-row" key={child.id}><div className="queue-avatar">{child.email[0].toUpperCase()}</div><span>{child.email}</span><small>待加入</small></div>)}{!readyChildren.length && <div className="empty-queue"><Check size={22} /><span>队列为空，添加子号后显示</span></div>}<div className="activity-foot"><ShieldCheck size={15} /> {automaticTeamCount ? `自动轮转 ${automaticTeamCount} 个 Team` : '所有 Team 均已停用'} <button onClick={() => setShowMother(true)}>调整策略</button></div></aside></div>
  </>;
}

function Metric({ label, value, detail, icon: Icon, tone }) { return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>; }

function MothersView({ mothers, setShowMother, setShowImport }) { return <section className="content-panel"><div className="content-toolbar"><div><h2>母号与空间</h2><p>管理用于检测额度、发送邀请和补位的 Team 母号。</p></div><div className="toolbar-actions"><button className="button ghost" onClick={setShowImport}><ArrowDownToLine size={15} />导入 JSON</button><button className="button primary" onClick={() => setShowMother()}><Plus size={15} />添加母号</button></div></div><div className="mother-grid">{mothers.map((mother) => <article className="mother-card" key={mother.id}><div className="card-top"><div className="mother-avatar"><KeyRound size={18} /></div><span className={`status-chip ${mother.status || 'unconfigured'}`}><i />{mother.status === 'online' ? '在线' : mother.status === 'offline' ? '离线' : '未检测'}</span></div><h3>{mother.name || '未命名母号'}</h3><p className="mono">{mother.email || '未设置邮箱'}</p><div className="space-line"><span>{teamDisplayName(mother)}</span><strong>{Number.isFinite(Number(mother.used)) && Number.isFinite(Number(mother.seats)) ? `${mother.used} / ${mother.seats} 席位` : '席位未检测'}</strong></div><div className="seat-bar"><i style={{ width: `${mother.seats ? Math.min(100, Number(mother.used || 0) / Number(mother.seats) * 100) : 0}%` }} /></div><div className="card-meta"><span>上次检测 {mother.lastCheck || '未检测'}</span><button className="text-button" onClick={() => setShowMother(mother)}>编辑 <ArrowUpRight size={14} /></button></div></article>)}<button className="add-card" onClick={() => setShowMother()}><Plus size={20} /><strong>添加母号</strong><span>连接新的 Team 空间</span></button></div><div className="subsection"><div className="subsection-title"><div><h3>空间状态</h3><p>每个空间的席位和加入记录</p></div><button className="button ghost"><ListFilter size={15} />筛选</button></div><table className="data-table"><thead><tr><th>空间</th><th>母号</th><th>席位</th><th>最后同步</th><th>状态</th><th /></tr></thead><tbody>{mothers.map((mother) => <tr key={mother.id}><td><strong>{teamDisplayName(mother)}</strong></td><td className="mono">{mother.email || '未设置'}</td><td><div className="table-seats"><span>{Number.isFinite(Number(mother.used)) && Number.isFinite(Number(mother.seats)) ? `${mother.used}/${mother.seats}` : '--'}</span><i><b style={{ width: `${mother.seats ? Math.min(100, Number(mother.used || 0) / Number(mother.seats) * 100) : 0}%` }} /></i></div></td><td>{mother.lastCheck || '未检测'}</td><td><span className={`status-chip ${mother.status || 'unconfigured'}`}><i />{mother.status === 'online' ? '正常' : '未检测'}</span></td><td><button className="icon-button small" title="更多"><MoreHorizontal size={16} /></button></td></tr>)}</tbody></table></div></section>; }

function StatusBadge({ status }) { const labels = { active: '使用中', warning: '额度偏低', exhausted: '已耗尽', cooldown: '冷却中', ready: '待加入', kicked: '已移出', banned: '已封禁', unconfigured: '待配置', offline: '离线', login_pending: '等待验证', login_required: '需要重新登录', phone_verification_required: '需要手机号接码' }; return <span className={`status-chip ${status || 'unconfigured'}`}><i />{labels[status] || '未检测'}</span>; }
function QuotaBar({ value }) { const numeric = Number(value); const known = Number.isFinite(numeric); const tone = numeric === 0 ? 'red' : numeric <= 10 ? 'amber' : 'green'; return <div className="quota-cell"><span>{known ? `${numeric}%` : '--'}</span><i className={known ? tone : 'muted'}><b style={{ width: `${known ? Math.max(0, Math.min(100, numeric)) : 0}%` }} /></i></div>; }
function HistoryView({ history, page, pageSize, meta, loading, error, onPageChange, onPageSizeChange, onRetry, onSelect }) {
  const total = Math.max(0, Number(meta?.total) || 0);
  const totalPages = Math.max(1, Number(meta?.totalPages) || 1);
  const currentPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const firstItem = total ? (currentPage - 1) * pageSize + 1 : 0;
  const lastItem = total ? Math.min(total, currentPage * pageSize) : 0;
  return <section className="content-panel">
    <div className="content-toolbar"><div><h2>操作历史</h2><p>记录额度检测、账号移除、Team 加入和导出操作。</p></div><button className="button ghost"><CloudDownload size={15} />导出日志</button></div>
    <div className={`history-list ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
      {error ? <div className="history-state error-state"><AlertTriangle size={22} /><strong>历史记录加载失败</strong><span>{error}</span><button className="button ghost" onClick={onRetry}><RefreshCw size={14} />重试</button></div>
        : history.length ? history.map((item) => <button className="history-item" key={item.id} onClick={() => onSelect(item)}><span className={`history-icon ${item.result}`}><Check size={16} /></span><span className="history-copy"><span><strong>{item.action}</strong><span>{item.time}</span></span><span>{item.detail}</span></span><ChevronRight size={16} className="history-arrow" /></button>)
          : loading ? <div className="history-state"><RefreshCw size={21} className="history-spinner" /><span>正在加载历史记录...</span></div>
            : <div className="history-state"><Clock3 size={22} /><strong>暂无操作记录</strong><span>完成一次检测或配置操作后会显示在这里。</span></div>}
    </div>
    <div className="history-pagination" aria-label="历史记录分页">
      <span className="history-pagination-summary">{total ? `${firstItem}-${lastItem} / 共 ${total} 条` : '共 0 条'}</span>
      <div className="history-pagination-controls">
        <label className="history-page-size">每页<select className="select-control" value={pageSize} onChange={(event) => onPageSizeChange(event.target.value)}>{historyPageSizeOptions.map((option) => <option key={option} value={option}>{option} 条</option>)}</select></label>
        <button className="icon-button small" title="上一页" aria-label="上一页" onClick={() => onPageChange(currentPage - 1)} disabled={loading || currentPage <= 1}><ChevronLeft size={15} /></button>
        <span className="history-page-number">第 {currentPage} / {totalPages} 页</span>
        <button className="icon-button small" title="下一页" aria-label="下一页" onClick={() => onPageChange(currentPage + 1)} disabled={loading || currentPage >= totalPages}><ChevronRight size={15} /></button>
      </div>
    </div>
  </section>;
}

function HistoryDetailModal({ item, onClose }) {
  const flow = item.flow;
  const summary = item.summary || {};
  const failures = [...(summary.kickFailures || []), ...(summary.joinFailures || [])];
  return <Modal title={`流程日志 · ${item.action}`} onClose={onClose} className="history-detail-modal">
    <div className="history-detail-head"><div><span className={`status-chip ${item.result || 'success'}`}><i />{item.result === 'partial' ? '部分完成' : item.result === 'error' ? '失败' : '完成'}</span><strong>{item.detail}</strong></div><small>{taskTime(item.time)}</small></div>
    {flow?.steps?.length ? <><h3 className="history-detail-section-title">执行阶段</h3><div className="history-detail-steps">{flow.steps.map((step) => <div className={`history-detail-step ${step.status}`} key={step.id}><div><strong>{step.label}</strong><span>{step.status === 'completed' ? '已完成' : step.status === 'failed' ? '失败' : step.status === 'skipped' ? '已跳过' : step.status === 'running' ? '执行中' : '排队中'}</span></div><small>{step.durationMs != null ? durationLabel(step.durationMs) : '--'}</small></div>)}</div></> : <div className="history-detail-empty">该条记录没有阶段级日志，仅保留操作摘要。</div>}
    {Object.keys(summary).length > 0 && <><h3 className="history-detail-section-title">执行结果</h3><div className="history-detail-stats"><div><span>移出账号</span><strong>{summary.kicked?.length || 0}</strong></div><div><span>加入账号</span><strong>{summary.joined?.length || 0}</strong></div><div><span>推送数量</span><strong>{summary.pushed || 0}</strong></div><div><span>失败步骤</span><strong>{failures.length + (summary.pushFailed || 0)}</strong></div></div>{failures.length > 0 && <div className="history-failure-list">{failures.map((failure, index) => <div key={`${failure.id || index}-${index}`}><strong>{failure.email || failure.id || '未知账号'}</strong><span>{failure.phase || '处理'} · {failure.message || `HTTP ${failure.status || '未知'}`}</span></div>)}</div>}</>}
    <div className="modal-foot"><span className="muted">记录时间：{taskTime(item.time)}</span><button className="button ghost" onClick={onClose}>关闭</button></div>
  </Modal>;
}
function SettingsView({ autoRefill, setAutoRefill, promoteJoinedAccounts, setPromoteJoinedAccounts, threshold, setThreshold, checkInterval, setCheckInterval, concurrency, setConcurrency, kickWindow, setKickWindow, kickAfterHours, setKickAfterHours, integrations, openIntegration, proxy, openProxy, saveSettings }) {
  const sub2apis = integrations.sub2apis?.length ? integrations.sub2apis : [integrations.sub2api || defaultSub2Api];
  const readySub2Apis = sub2apis.filter((item) => item.enabled && item.baseUrl && item.apiKeySet && ((Number.isFinite(Number(item.groupId)) && Number(item.groupId) > 0) || String(item.groupName || '').trim()));
  const sub2apiReady = readySub2Apis.length > 0;
  const sub2apiTarget = `${readySub2Apis.length} / ${sub2apis.length} 个连接可用`;
  const mailboxReady = integrations.mailbox.enabled && (integrations.mailbox.endpoint || integrations.mailbox.apiKeySet || integrations.mailbox.apiKey);
  const proxyReady = proxy?.enabled && proxy?.entries?.length;
  return <section className="settings-layout">
    <section className="content-panel settings-panel">
      <div className="content-toolbar"><div><h2>自动化策略</h2><p>控制额度检测和自动补位行为。</p></div><span className={`status-chip ${autoRefill ? 'online' : 'cooldown'}`}><i />{autoRefill ? '已启用' : '已暂停'}</span></div>
      <div className="setting-row"><div><strong>自动补满席位</strong><p>检测到选定踢出条件满足时，自动移出账号并从待加入池补位。</p></div><Toggle checked={autoRefill} onChange={setAutoRefill} /></div>
      <div className="setting-row"><div><strong>加入后设置为所有者</strong><p>开启后，新补位账号会提升为所有者；关闭时保留普通成员权限。</p></div><Toggle checked={promoteJoinedAccounts} onChange={setPromoteJoinedAccounts} /></div>
      <div className="setting-row kick-window-row"><div><strong>自动踢出条件</strong><p>{kickWindow === 'time' ? `仅按加入时间踢出，额度仍会检测并更新；加入 ${kickAfterHours} 小时后轮转。` : '5h 和 7d 只能选择一个作为自动踢出条件，额度预警不会改变这个选择。'}</p></div><div className="kick-window-controls"><div className="segmented setting-segmented">{[['5h', '5h 耗尽'], ['7d', '7d 满额'], ['time', '按时间']].map(([id, label]) => <button key={id} className={kickWindow === id ? 'selected' : ''} onClick={() => setKickWindow(id)}>{label}</button>)}</div>{kickWindow === 'time' && <label className="number-input kick-hours-input"><input type="number" min="1" max="720" value={kickAfterHours} onChange={(event) => setKickAfterHours(Math.min(720, Math.max(1, Number(event.target.value) || 1)))} /><span>小时</span></label>}</div></div>
      <div className="setting-row"><div><strong>额度预警阈值</strong><p>低于此百分比时标记为“额度偏低”，但不会立即移除。</p></div><div className="number-input"><input type="number" min="1" max="50" value={threshold} onChange={(event) => setThreshold(event.target.value)} /><span>%</span></div></div>
      <div className="setting-row"><div><strong>检测周期</strong><p>自动轮询 Team 空间和所有已加入的账号。</p></div><select className="select-control" value={checkInterval} onChange={(event) => setCheckInterval(event.target.value)}><option value="30">30 秒</option><option value="60">60 秒</option><option value="300">5 分钟</option></select></div>
      <div className="setting-row"><div><strong>全局并发数</strong><p>统一限制 Free 登录、Team 检测、OAuth 刷新和 Sub2API 推送的同时请求数。</p></div><div className="number-input"><input type="number" min="1" max="10" value={concurrency} onChange={(event) => setConcurrency(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} /><span>个</span></div></div>
      <div className="save-row"><span className="muted">设置保存在服务端</span><button className="button primary" onClick={saveSettings}><Check size={15} />保存设置</button></div>
    </section>
    <section className="content-panel integration-panel">
      <div className="content-toolbar"><div><h2>集成与导出</h2><p>连接后可将已获取 AT 的账号推送到指定 Sub2API 分组。</p></div></div>
      <div className="integration-item"><div className="integration-logo sub2api">S2</div><div><strong>Sub2API</strong><span>{sub2apiTarget}</span></div><span className="connected">{sub2apiReady ? '已配置' : '未配置'}</span><button className="button ghost" onClick={() => openIntegration('sub2api')}>管理</button></div>
      <div className="integration-item"><div className="integration-logo mail"><Mail size={16} /></div><div><strong>邮箱 / 接码</strong><span>登录时获取邮箱或短信验证码</span></div><span className="connected">{mailboxReady ? '已配置' : '未配置'}</span><button className="button ghost" onClick={() => openIntegration('mailbox')}>配置</button></div>
      <div className="integration-item proxy-integration-item"><div className="integration-logo proxy"><SlidersHorizontal size={16} /></div><div><strong>代理池</strong><span>{proxy?.entries?.length ? `${proxy.entries.length} 条代理 · ${proxy.strategy === 'round_robin' ? '轮询' : '故障切换'}` : 'Team、账号和 Sub2API 请求统一经过代理'}</span></div><span className="connected">{proxyReady ? '已启用' : proxy?.entries?.length ? '未启用' : '未配置'}</span><button className="button ghost" onClick={openProxy}>配置</button></div>
      <div className="integration-note"><CircleHelp size={15} /><span>代理超时或网络错误会自动切换池中下一条代理；关闭代理池时才会直连。</span></div>
      <div className="integration-note"><CircleHelp size={15} /><span>每个 Team 可选择一个 Sub2API 连接；未选择时使用列表中的第一个。</span></div>
    </section>
  </section>;
}
function Toggle({ checked, onChange }) { return <button className={`toggle ${checked ? 'checked' : ''}`} onClick={() => onChange(!checked)} aria-label={checked ? '关闭' : '开启'}><span /></button>; }

function Modal({ title, onClose, children, className = '' }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={`modal ${className}`}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={18} /></button></div>{children}</div></div>; }

function billingDateLabel(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function billingAmountLabel(item = {}) {
  if (item.formattedAmount) return item.formattedAmount;
  const amount = Number(item.amount);
  const currency = String(item.currency || '').trim().toUpperCase();
  if (!Number.isFinite(amount) || !currency) return '--';
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function billingProliteEstimateLabel(item = {}) {
  const estimate = item.proliteEstimate && typeof item.proliteEstimate === 'object' ? item.proliteEstimate : {};
  if (estimate.formattedAmount) return estimate.formattedAmount;
  const amount = Number(estimate.amount);
  const currency = String(estimate.currency || item.currency || '').trim().toUpperCase();
  if (!Number.isFinite(amount) || !currency) return '--';
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function billingFailureLabel(item = {}) {
  if (Number(item.status) === 401) return '母号登录已失效';
  if (Number(item.status) === 403) return '母号无账单查询权限';
  if (Number(item.status) === 429) return '查询频率受限，请稍后刷新';
  const labels = {
    workspace_id_required: '未配置 Team 空间',
    billing_preview_current_seats_missing: '未返回当前计费席位',
    billing_preview_amount_missing: '未返回席位费用',
    billing_preview_currency_missing: '未返回费用币种',
    billing_preview_seat_target_mismatch: '席位数量已变化，请刷新',
    billing_preview_seats_changed_repeatedly: '席位数量持续变化，请稍后刷新',
    missing_token: '母号缺少可用的 Team Token',
    workspace_owner_token_required: '需要恢复 Team 母号登录',
    workspace_subscription_failed: '到期信息查询失败',
    network_error: '网络连接失败，请检查代理',
    timeout: '请求超时，请检查代理后重试',
  };
  return labels[item.message] || item.message || item.code || '查询失败';
}

function BillingPreviewStatus({ item }) {
  if (!item.ok && !item.partial) return <div className="billing-status-stack"><span className="billing-status failed"><AlertTriangle size={12} />查询失败</span><small title={item.message || item.code || ''}>{billingFailureLabel(item)}</small></div>;
  if (item.partial) return <div className="billing-status-stack"><span className="billing-status partial"><AlertTriangle size={12} />部分完成</span><small title={item.subscriptionMessage || item.message || ''}>费用已获取，到期信息未刷新</small>{item.activeUntilSource === 'cached' && <small className="billing-stale">到期信息为上次缓存</small>}</div>;
  const expiryLabels = {
    active: '有效',
    due_soon: '临期',
    expired: '已到期',
    cancelling: '到期不续费',
    delinquent: '欠费',
    unknown: '日期未知',
  };
  const renewalLabel = item.isDelinquent
    ? '账户欠费'
    : item.willRenew === true
      ? '自动续费'
      : item.willRenew === false
        ? '不自动续费'
        : '续费状态未知';
  return <div className="billing-status-stack"><span className={`billing-status ${item.expiryStatus || 'unknown'}`}>{item.expiryStatus === 'active' ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}{expiryLabels[item.expiryStatus] || expiryLabels.unknown}</span><small>{renewalLabel}</small>{item.subscriptionFresh === false && <small className="billing-stale">到期信息为上次缓存</small>}</div>;
}

function BillingPreviewModal({ data = {}, loading, error, onRefresh, onClose }) {
  const sourceItems = Array.isArray(data.items) ? data.items : [];
  const urgentStatuses = new Set(['due_soon', 'expired', 'cancelling', 'delinquent']);
  const items = [...sourceItems].sort((left, right) => {
    const leftGroup = left.partial ? 2 : !left.ok ? 3 : urgentStatuses.has(left.expiryStatus) ? 0 : 1;
    const rightGroup = right.partial ? 2 : !right.ok ? 3 : urgentStatuses.has(right.expiryStatus) ? 0 : 1;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    const leftTime = Date.parse(left.activeUntil || '');
    const rightTime = Date.parse(right.activeUntil || '');
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    if (Number.isFinite(leftTime) && leftTime !== rightTime) return leftTime - rightTime;
    return String(left.teamName || '').localeCompare(String(right.teamName || ''), 'zh-CN');
  });
  const total = Number.isFinite(Number(data.total)) ? Number(data.total) : items.length;
  const failed = Number.isFinite(Number(data.failed)) ? Number(data.failed) : items.filter((item) => !item.ok).length;
  const succeeded = Number.isFinite(Number(data.succeeded)) ? Number(data.succeeded) : Math.max(0, total - failed);
  const expiring = Number.isFinite(Number(data.expiring)) ? Number(data.expiring) : items.filter((item) => item.ok && urgentStatuses.has(item.expiryStatus)).length;
  const thresholdDays = Number(data.thresholdDays) || 7;

  return <Modal title="临期 Team" onClose={onClose} className="billing-preview-modal">
    <div className="billing-preview-intro"><div><strong>Team 到期与席位费用</strong><span>{thresholdDays} 天内标为临期；普通席位为账单接口返回的实时增量，高级席位按同账期普通席位费用的 5 倍估算。</span></div>{data.checkedAt && <small>查询于 {billingDateLabel(data.checkedAt)}</small>}</div>
    <div className="billing-preview-summary"><div><span>全部 Team</span><strong>{total}</strong></div><div className={expiring ? 'warning' : ''}><span>临期或异常</span><strong>{expiring}</strong></div><div><span>查询成功</span><strong>{succeeded}</strong></div><div className={failed ? 'danger' : ''}><span>查询失败</span><strong>{failed}</strong></div></div>
    {loading && <div className="billing-preview-loading" aria-live="polite"><RefreshCw size={14} />正在通过 Team 母号查询最新账期与费用...</div>}
    {error && items.length > 0 && <div className="billing-preview-error"><AlertTriangle size={15} /><span>{error}</span></div>}
    {loading && !items.length ? <div className="billing-preview-state"><RefreshCw className="billing-preview-spinner" size={28} /><strong>正在查询所有 Team</strong><span>各 Team 独立查询，失败不会阻断其他结果。</span></div> : error && !items.length ? <div className="billing-preview-state error-state"><AlertTriangle size={28} /><strong>查询失败</strong><span>{error}</span><button className="button ghost" onClick={onRefresh} disabled={loading}><RefreshCw size={14} />重新查询</button></div> : items.length ? <div className={`billing-preview-table-wrap ${loading ? 'is-loading' : ''}`}><table className="data-table billing-preview-table"><thead><tr><th>Team</th><th>当前周期截止</th><th>剩余时间</th><th>当前计费席位</th><th>新增 1 个席位</th><th>费用结算日</th><th>状态</th></tr></thead><tbody>{items.map((item, index) => {
      const remainingDays = Number(item.remainingDays);
      const hasRemainingDays = item.remainingDays !== null && item.remainingDays !== undefined && Number.isFinite(remainingDays);
      const hasLiveOrCachedExpiry = Boolean(item.activeUntil) && (item.ok || item.partial);
      const hasSeatPreview = item.ok || item.partial;
      const proliteEstimate = item.proliteEstimate && typeof item.proliteEstimate === 'object' ? item.proliteEstimate : null;
      const hasProliteEstimate = Boolean(proliteEstimate?.formattedAmount)
        || (proliteEstimate?.amount !== null && proliteEstimate?.amount !== undefined && proliteEstimate?.amount !== '' && Number.isFinite(Number(proliteEstimate.amount)));
      const remainingLabel = !hasLiveOrCachedExpiry || !hasRemainingDays
        ? '--'
        : item.expiryStatus === 'expired'
          ? remainingDays < 0 ? `已过期 ${Math.abs(remainingDays)} 天` : '已到期'
          : remainingDays === 0 ? '今天到期' : `${remainingDays} 天`;
      return <tr key={`${item.teamName || 'team'}-${index}`} className={item.partial ? 'billing-row-partial' : !item.ok ? 'billing-row-failed' : urgentStatuses.has(item.expiryStatus) ? 'billing-row-urgent' : ''}><td data-label="Team"><strong className="billing-team-name">{item.teamName || '未命名 Team'}</strong></td><td data-label="当前周期截止"><span>{hasLiveOrCachedExpiry ? billingDateLabel(item.activeUntil) : '--'}</span>{item.activeUntilSource === 'cached' && <small>缓存</small>}</td><td data-label="剩余时间"><strong className={`billing-remaining ${item.expiryStatus || ''}`}>{remainingLabel}</strong></td><td data-label="当前计费席位"><span>{hasSeatPreview && Number.isFinite(Number(item.currentSeats)) ? `${item.currentSeats} 个` : '--'}</span></td><td data-label="新增 1 个席位"><div className="billing-seat-cost"><div><span>普通</span><strong className="billing-amount">{hasSeatPreview ? billingAmountLabel(item) : '--'}</strong></div><div><span>高级 <b className="billing-estimate-chip">估算 ×5</b></span><strong className="billing-amount billing-prolite-amount">{hasSeatPreview && hasProliteEstimate ? billingProliteEstimateLabel(item) : '--'}</strong></div></div></td><td data-label="费用结算日"><span>{hasSeatPreview ? billingDateLabel(item.renewalDate) : '--'}</span></td><td data-label="状态"><BillingPreviewStatus item={item} /></td></tr>;
    })}</tbody></table></div> : <div className="billing-preview-state"><Clock3 size={28} /><strong>暂无可查询的 Team</strong><span>添加 Team 后可查询到期与席位费用。</span></div>}
    <div className="modal-foot billing-preview-foot"><span className="muted">高级费用为估算值；查询过程不会变更席位数量。</span><div className="modal-foot-actions"><button className="button ghost" onClick={onClose}>关闭</button><button className="button primary" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'button-spinner' : ''} />{loading ? '查询中' : '刷新'}</button></div></div>
  </Modal>;
}

function ProxyModal({ proxy = defaultProxySettings, onClose, onSave, onAdd, onRemove }) {
  const [form, setForm] = useState(() => ({ ...defaultProxySettings, ...proxy }));
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const entries = Array.isArray(proxy.entries) ? proxy.entries : [];
  async function addEntries() {
    const values = input.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!values.length) return;
    setAdding(true);
    const result = await onAdd(values);
    setAdding(false);
    if (result?.added?.length || result?.errors?.length) setInput('');
  }
  return <Modal title="配置代理池" onClose={onClose} className="proxy-modal">
    <div className="modal-intro">启用后，Team 检测、账号登录、空间切换和 Sub2API 请求都会经过代理。代理超时、网络错误或服务端限流时，会自动尝试池中下一条代理。</div>
    <div className="form-grid proxy-form">
      <label className="integration-enabled"><span>启用代理池</span><Toggle checked={form.enabled === true} onChange={(value) => update('enabled', value)} /></label>
      <label><span>代理策略</span><div className="segmented modal-segmented">{[['failover', '故障切换'], ['round_robin', '轮询']].map(([id, label]) => <button type="button" key={id} className={form.strategy === id ? 'selected' : ''} onClick={() => update('strategy', id)}>{label}</button>)}</div></label>
      <label><span>请求超时</span><div className="number-input"><input type="number" min="5" max="120" value={Math.round(Number(form.timeoutMs || 15000) / 1000)} onChange={(event) => update('timeoutMs', Math.min(120000, Math.max(5000, Number(event.target.value || 15) * 1000)))} /><span>秒</span></div></label>
      <label><span>最大重试次数</span><select className="select-control" value={form.maxRetries ?? 2} onChange={(event) => update('maxRetries', Number(event.target.value))}>{[0, 1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value} 次</option>)}</select></label>
    </div>
    <div className="proxy-entry-editor"><label><span>添加代理</span><small className="field-hint">每行一条，支持 HTTP / SOCKS5 / SOCKS5H、账号密码和本机代理</small></label><textarea className="proxy-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'http://127.0.0.1:7897\nsocks5h://username:password@host:3010\nsocks5h://username:password\\@host:3010\nhost:3010:username:password\nusername:password@host:3010\nhost:3010@username:password'} /><div className="proxy-entry-actions"><span className="muted">凭据仅保存在服务端，列表只显示脱敏地址</span><button className="button secondary" disabled={adding || !input.trim()} onClick={addEntries}><Plus size={15} />{adding ? '添加中…' : '添加代理'}</button></div></div>
    <div className="proxy-list"><div className="proxy-list-head"><strong>代理池</strong><span>{entries.length} 条</span></div>{entries.length ? entries.map((entry) => <div className="proxy-entry" key={entry.id}><div className="proxy-entry-status"><i className={entry.healthy === false ? 'unhealthy' : ''} /><div><strong>{entry.display}</strong><span>{entry.label || (entry.sourceType === 'local' ? '本机代理' : '家宽代理')} · {entry.protocol?.toUpperCase() || 'HTTP'}{entry.hasAuth ? ' · 已认证' : ''}</span></div></div><div className="proxy-entry-meta"><span className={entry.healthy === false ? 'proxy-health unhealthy' : 'proxy-health'}>{entry.healthy === false ? '待恢复' : '健康'}</span>{entry.failures ? <small>失败 {entry.failures} 次</small> : null}<button className="icon-button danger" title="删除代理" aria-label="删除代理" onClick={() => onRemove(entry.id)}><Trash2 size={15} /></button></div></div>) : <div className="proxy-empty"><SlidersHorizontal size={20} /><span>还没有代理，添加后启用代理池</span></div>}</div>
    <div className="modal-foot"><span className="muted">关闭代理池时，系统恢复直连。</span><button className="button primary" onClick={() => onSave({ ...form, timeoutMs: Number(form.timeoutMs) || 15000, maxRetries: Number(form.maxRetries) || 0 })}><Check size={15} />保存设置</button></div>
  </Modal>;
}

function AgentAccessModal({ onClose, notify }) {
  const httpEndpoint = `${API_BASE || window.location.origin}/mcp`;
  const httpConfig = JSON.stringify({ mcpServers: { 'team-rotation': { url: httpEndpoint } } }, null, 2);
  const stdioConfig = JSON.stringify({ mcpServers: { 'team-rotation': { command: 'npm', args: ['run', 'mcp'], cwd: 'F:/ai-work/gpt-tila-team', env: { QUOTA_HUB_MCP_URL: 'http://127.0.0.1:8786/mcp' } } } }, null, 2);
  async function copyConfig(value) {
    try {
      await navigator.clipboard.writeText(value);
      notify('MCP 配置已复制', 'info');
    } catch {
      notify('复制失败，请手动选择配置内容', 'error');
    }
  }
  const tools = [
    ['查看状态', 'get_state / list_teams / list_accounts'],
    ['查询记录', 'get_history'],
    ['检测额度', 'check_team_quota / check_all_teams'],
    ['自动补位', 'refill_team / refill_all_teams'],
    ['调整策略', 'update_settings'],
  ];
  return <Modal title="功能说明 · Agent 接入" onClose={onClose} className="agent-modal">
    <p className="modal-intro">这里是 team轮转的功能和标准 MCP 接入说明。顶部问号现在打开的就是这个窗口，Agent 可以通过 MCP 查询状态、检测额度和执行补位。</p>
    <div className="agent-feature-grid">{[['Team 自动化', '持续检测 Team 席位和 5h / 7d 额度；按策略移出耗尽账号，再从待加入池补位。'], ['Free 账号池', '维护普通账号的邮箱、密码 / 2FA 状态、Access Token 和加入过的 Team。'], ['集成与导出', '支持 Sub2API 分组推送，以及邮箱 / 接码服务配置。'], ['右上角控制', '月亮切换主题；问号查看本说明和 Agent 接入；头像显示当前用户。']].map(([title, detail]) => <div className="agent-feature" key={title}><strong>{title}</strong><span>{detail}</span></div>)}</div>
    <div className="agent-section"><div className="agent-section-title"><div><strong>HTTP MCP（推荐）</strong><span>适用于支持 Streamable HTTP 的 Agent 客户端</span></div><button className="button ghost compact-button" onClick={() => copyConfig(httpConfig)}><Copy size={14} />复制配置</button></div><div className="agent-endpoint">{httpEndpoint}</div><pre className="agent-config">{httpConfig}</pre></div>
    <div className="agent-section"><div className="agent-section-title"><div><strong>stdio MCP</strong><span>适用于只支持本地命令的客户端；先运行 `npm run server`</span></div><button className="button ghost compact-button" onClick={() => copyConfig(stdioConfig)}><Copy size={14} />复制配置</button></div><pre className="agent-config">{stdioConfig}</pre></div>
    <div className="agent-tools"><div className="agent-section-title"><div><strong>可用工具</strong><span>写操作会真实改变 Team 或账号状态，请只连接可信 Agent</span></div></div><div className="agent-tool-list">{tools.map(([title, names]) => <div key={title}><strong>{title}</strong><code>{names}</code></div>)}</div></div>
    <div className="integration-note agent-security"><ShieldCheck size={15} /><span>MCP 默认只监听本机 `127.0.0.1:8786`，响应不会返回完整密码、2FA 或 Access Token。需要让其他机器接入时，请设置 `HOST=0.0.0.0` 和 `MCP_AUTH_TOKEN`，并在客户端带上 Bearer Token。</span></div>
  </Modal>;
}

function AccountModal({ account, onClose, onSave, onSaveAndAcquire, onAcquire, acquireState }) {
  const [form, setForm] = useState(() => ({ email: account?.email || '', password: '', totp: '', mailboxUrl: account?.mailboxUrl || '' }));
  const [sub2apiJson, setSub2apiJson] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const busy = Boolean(acquireState?.loading);
  async function submit() {
    if (saving) return;
    setSaving(true);
    try { await onSave(form, sub2apiJson); } finally { setSaving(false); }
  }
  return <Modal title={account ? '编辑账号记录' : '新增 Free 账号'} onClose={onClose}>
    <div className="modal-intro">填写已完成手机号验证的 Free 账号邮箱、密码和 2FA Secret。获取 JSON 时会完成 Codex OAuth，并选择 Free 或目标 Team 空间。</div>
    <div className="form-grid"><label className="wide"><span>登录邮箱</span><input value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="name@example.com" /></label><label><span>密码</span><input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} placeholder="账号密码" /></label><label><span>2FA Secret</span><input type="password" value={form.totp} onChange={(event) => update('totp', event.target.value)} placeholder="Base32 Secret" /></label><label className="wide"><span>邮箱验证码地址</span><input value={form.mailboxUrl} onChange={(event) => update('mailboxUrl', event.target.value)} placeholder="仅异常触发邮箱验证时使用；支持 {email} 占位符" /></label></div>
    <div className="account-acquire-panel"><div className="account-acquire-copy"><strong>Free JSON 获取</strong><span>优先刷新已有 RT；重新登录时从默认 Sub2API 获取 OAuth 链接，选择 personal 空间并生成完整 JSON。</span><AcquireStatus state={acquireState} /></div><div className="account-acquire-actions"><button className="button ghost compact-button" disabled={!account?.id || busy} onClick={() => onAcquire(account.id, 'free-json', form)}><CloudDownload size={14} />获取 Free JSON</button><button className="button secondary compact-button" disabled={!account?.id || busy} onClick={() => onAcquire(account.id, 'refresh-at', form)}><RefreshCw size={14} />刷新 AT</button></div></div>
    <div className="modal-intro">可直接粘贴该 Free 账号完整的 Sub2API JSON。提交后会保存 AT、RT 及相关凭据，不能录入 Team JSON。</div><textarea className="import-area" aria-label="Sub2API JSON" value={sub2apiJson} onChange={(event) => setSub2apiJson(event.target.value)} placeholder={'粘贴完整 Sub2API JSON，例如：\n{\n  "credentials": { ... }\n}'} />
    <div className="modal-foot"><span className="muted">当前账号：{account?.email || form.email || '未设置'}</span><div className="modal-foot-actions">{!account && !sub2apiJson.trim() && <button className="button ghost" disabled={saving} onClick={() => onSaveAndAcquire(form)}><CloudDownload size={14} />保存并获取 JSON</button>}<button className="button primary" disabled={saving} onClick={submit}><Check size={15} />{saving ? '保存中' : sub2apiJson.trim() ? '保存账号和 JSON' : '保存账号'}</button></div></div>
  </Modal>;
}

function Sub2ApiModal({ configs = [], mothers = [], onClose, onSave }) {
  const initial = (configs.length ? configs : [defaultSub2Api]).map((item, index) => ({ ...defaultSub2Api, id: item.id || `sub2api_${Date.now()}_${index}`, name: item.name || `Sub2API ${index + 1}`, ...item, apiKey: '' }));
  const [forms, setForms] = useState(initial);
  const [selectedId, setSelectedId] = useState(initial[0].id);
  const [groupOptions, setGroupOptions] = useState([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError, setGroupError] = useState('');
  const selected = forms.find((item) => item.id === selectedId) || forms[0];
  const update = (key, value) => setForms((current) => current.map((item) => item.id === selected.id ? { ...item, [key]: value } : item));

  useEffect(() => {
    setGroupOptions([]);
    setGroupError('');
    if (!selected?.baseUrl || !selected?.apiKeySet) return undefined;
    let cancelled = false;
    setGroupLoading(true);
    apiRequest(`/api/integrations/sub2api/groups?integrationId=${encodeURIComponent(selected.id)}`).then((payload) => {
      if (!cancelled) {
        if (payload.ok) setGroupOptions(Array.isArray(payload.groups) ? payload.groups : []);
        else setGroupError('无法读取分组，请手动填写名称或 ID');
      }
    }).catch(() => { if (!cancelled) setGroupError('无法读取分组，请手动填写名称或 ID'); }).finally(() => { if (!cancelled) setGroupLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.baseUrl, selected?.apiKeySet]);

  function addConfig() {
    const id = `sub2api_${Date.now()}`;
    setForms((current) => [...current, { ...defaultSub2Api, id, name: `Sub2API ${current.length + 1}` }]);
    setSelectedId(id);
  }

  function removeConfig(id) {
    if (forms.length <= 1 || mothers.some((mother) => mother.sub2apiIntegrationId === id)) return;
    const next = forms.filter((item) => item.id !== id);
    setForms(next);
    if (selectedId === id) setSelectedId(next[0].id);
  }

  function submit() {
    const next = forms.map((item, index) => {
      const config = {
        ...item,
        name: String(item.name || `Sub2API ${index + 1}`).trim(),
        baseUrl: String(item.baseUrl || '').trim(),
        groupId: item.groupId === '' || item.groupId == null ? null : Number(item.groupId),
        groupName: String(item.groupName || '').trim(),
      };
      if (!config.apiKey) delete config.apiKey;
      return config;
    });
    onSave(next);
  }

  return <Modal title="管理 Sub2API 连接" onClose={onClose} className="sub2api-config-modal">
    <div className="modal-intro">正常推送按“邮箱 + Team 空间 ID”查重，已存在即跳过；额度检测遇到 401 时，只更新远端已有的同账号 Team JSON，找不到时不会新增。</div>
    <div className="sub2api-config-layout">
      <aside className="sub2api-config-list"><div className="sub2api-config-list-head"><strong>连接</strong><button className="icon-button small" title="新增 Sub2API" onClick={addConfig}><Plus size={15} /></button></div>{forms.map((item, index) => { const referencedCount = mothers.filter((mother) => mother.sub2apiIntegrationId === item.id).length; return <div className={`sub2api-config-item ${item.id === selected?.id ? 'selected' : ''}`} key={item.id}><button onClick={() => setSelectedId(item.id)}><strong>{item.name || `Sub2API ${index + 1}`}</strong><span>{referencedCount ? `${referencedCount} 个 Team 正在使用` : item.baseUrl || '未配置地址'}</span></button><button className="icon-button small danger-hover" title={referencedCount ? '请先将关联 Team 切换到其他连接' : '删除连接'} disabled={forms.length <= 1 || referencedCount > 0} onClick={() => removeConfig(item.id)}><Trash2 size={14} /></button></div>; })}</aside>
      {selected && <div className="form-grid integration-form sub2api-config-form">
        <label className="wide"><span>连接名称</span><input value={selected.name || ''} onChange={(event) => update('name', event.target.value)} placeholder="例如：主 Sub2API" /></label>
        <label className="wide"><span>服务地址</span><input value={selected.baseUrl || ''} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://sub2api.example.com" /></label>
        <label><span>同步分组名称</span><input value={selected.groupName || ''} onChange={(event) => { const value = event.target.value; const option = groupOptions.find((item) => item.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase()); update('groupName', value); update('groupId', option ? option.id : ''); }} placeholder="例如：团队账号" /><small className="field-hint integration-group-hint">{groupLoading ? '正在读取分组...' : groupError || '可填写名称，推送时精确匹配'}</small></label>
        <label><span>分组 ID（可选）</span>{groupOptions.length ? <select className="select-control integration-group-select" value={selected.groupId ?? ''} onChange={(event) => { const option = groupOptions.find((item) => String(item.id) === event.target.value); update('groupId', event.target.value); update('groupName', option?.name || ''); }}><option value="">按名称匹配</option>{groupOptions.map((group) => <option value={group.id} key={group.id}>{group.name}（#{group.id}）</option>)}</select> : <input type="number" min="1" value={selected.groupId ?? ''} onChange={(event) => update('groupId', event.target.value)} placeholder="留空则按名称匹配" />}</label>
        <label className="wide"><span>API Key / Token{selected.apiKeySet && <small className="field-hint">已保存，留空保持不变</small>}</span><input type="password" value={selected.apiKey || ''} onChange={(event) => update('apiKey', event.target.value)} placeholder={selected.apiKeySet ? '留空保持现有密钥' : '输入 API Key'} /></label>
        <label className="integration-enabled"><span>启用此连接</span><Toggle checked={selected.enabled === true} onChange={(value) => update('enabled', value)} /></label>
      </div>}
    </div>
    <div className="modal-foot"><span className="muted">列表第一项是未指定 Team 的默认连接。</span><button className="button primary" onClick={submit}><Check size={15} />保存连接</button></div>
  </Modal>;
}

function IntegrationModal({ type, config = {}, onClose, onSave }) {
  const isSub2Api = type === 'sub2api';
  const [form, setForm] = useState(() => ({ ...config, apiKey: '' }));
  const [groupOptions, setGroupOptions] = useState([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError, setGroupError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (!isSub2Api || !config.baseUrl || !config.apiKeySet) return undefined;
    let cancelled = false;
    setGroupLoading(true); setGroupError('');
    apiRequest('/api/integrations/sub2api/groups').then((payload) => {
      if (!cancelled) {
        if (payload.ok) setGroupOptions(Array.isArray(payload.groups) ? payload.groups : []);
        else setGroupError('无法读取分组，请手动填写分组 ID');
      }
    }).catch(() => { if (!cancelled) setGroupError('无法读取分组，请手动填写分组 ID'); }).finally(() => { if (!cancelled) setGroupLoading(false); });
    return () => { cancelled = true; };
  }, [isSub2Api, config.baseUrl, config.apiKeySet]);
  function submit() {
    const next = { ...form };
    if (!next.apiKey) delete next.apiKey;
    next.groupId = next.groupId === '' || next.groupId == null ? null : Number(next.groupId);
    next.groupName = String(next.groupName || '').trim();
    onSave(next);
  }
  return <Modal title={isSub2Api ? '配置 Sub2API' : '配置邮箱 / 接码'} onClose={onClose}>
    <div className="modal-intro">{isSub2Api ? '用于把已经获取 AT 的普通账号推送到 Sub2API。必须指定目标分组；未指定时不会推送到默认分组。' : '用于登录账号时获取邮箱验证码或短信验证码。它不参与额度查询，额度查询仍使用账号 AT；当前仅保存配置，自动取码需要接入对应服务商适配器。'}</div>
    <div className="form-grid integration-form">
      {isSub2Api ? <label className="wide"><span>服务地址</span><input value={form.baseUrl || ''} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://sub2api.example.com" /></label> : <label><span>服务类型</span><select className="select-control" value={form.serviceType || 'manual'} onChange={(event) => update('serviceType', event.target.value)}><option value="manual">手动接码</option><option value="email-api">邮箱 API</option><option value="sms-api">短信 API</option></select></label>}
      {!isSub2Api && <label><span>服务地址</span><input value={form.endpoint || ''} onChange={(event) => update('endpoint', event.target.value)} placeholder="https://provider.example.com" /></label>}
      {isSub2Api && <label><span>同步分组名称</span><input value={form.groupName || ''} onChange={(event) => { const value = event.target.value; const option = groupOptions.find((item) => item.name.toLocaleLowerCase() === value.trim().toLocaleLowerCase()); update('groupName', value); update('groupId', option ? option.id : ''); }} placeholder="例如：团队账号" /><small className="field-hint integration-group-hint">{groupLoading ? '正在读取分组…' : groupError || '可直接填写名称；推送时会在 Sub2API 中匹配该分组'}</small></label>}
      {isSub2Api && <label><span>分组 ID（可选）</span>{groupOptions.length ? <select className="select-control integration-group-select" value={form.groupId ?? ''} onChange={(event) => { const option = groupOptions.find((item) => String(item.id) === event.target.value); update('groupId', event.target.value); update('groupName', option?.name || ''); }}><option value="">按名称匹配</option>{groupOptions.map((group) => <option value={group.id} key={group.id}>{group.name}（#{group.id}）</option>)}</select> : <input type="number" min="1" value={form.groupId ?? ''} onChange={(event) => update('groupId', event.target.value)} placeholder="留空则按名称匹配" />}<small className="field-hint integration-group-hint">{groupError ? '分组列表读取失败，仍可保存名称并在推送时匹配' : '填写 ID 后优先使用 ID；留空时使用上面的分组名称'}</small></label>}
      <label className="wide"><span>{isSub2Api ? 'API Key / Token' : 'API Key / 密钥'}{config.apiKeySet && <small className="field-hint">已保存密钥，留空保持不变</small>}</span><input type="password" value={form.apiKey || ''} onChange={(event) => update('apiKey', event.target.value)} placeholder={config.apiKeySet ? '留空保持现有密钥' : '可选'} /></label>
      <label className="integration-enabled"><span>启用此集成</span><Toggle checked={form.enabled === true} onChange={(value) => update('enabled', value)} /></label>
    </div>
    <div className="modal-foot"><span className="muted">密钥只提交服务端，不在状态接口返回。</span><button className="button primary" onClick={submit}><Check size={15} />保存配置</button></div>
  </Modal>;
}

function MotherModal({ mother, sub2apis = [], onClose, onSave }) {
  const defaultSub2apiId = sub2apis[0]?.id || 'sub2api_default';
  const [form, setForm] = useState(() => mother
    ? { ...mother, password: '', totp: '', token: '', teamName: mother.teamName || mother.displayName || '', rotationEnabled: mother.rotationEnabled !== false, inviteSeatType: ['default', 'prolite'].includes(mother.inviteSeatType) ? mother.inviteSeatType : 'auto', primaryOwnerEmail: mother.primaryOwnerEmail || mother.email || '', sub2apiIntegrationId: mother.sub2apiIntegrationId || defaultSub2apiId }
    : { id: `mother_${Date.now()}`, email: '', name: '', password: '', totp: '', team: '', teamName: '', accountId: '', rotationEnabled: true, syncOwnerToSub2api: true, rotationMode: 'fixed', inviteSeatType: 'auto', dailyRotationLimit: 3, primaryOwnerEmail: '', sub2apiIntegrationId: defaultSub2apiId, seats: 0, used: 0, status: 'unconfigured', lastCheck: null, token: '' });
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const ownerOptions = [...[{ email: form.email, name: form.name, userId: form.chatgptUserId }], ...(mother?.ownerAccounts || [])]
    .filter((owner) => owner?.email)
    .filter((owner, index, list) => list.findIndex((item) => item.email.toLowerCase() === owner.email.toLowerCase()) === index);
  const selectedSub2ApiMissing = Boolean(form.sub2apiIntegrationId && !sub2apis.some((item) => item.id === form.sub2apiIntegrationId));
  return <Modal title={mother ? '编辑 Team' : '添加 Team'} onClose={onClose} className="mother-edit-modal"><div className="form-grid mother-edit-form">
    <label><span>所有者名称</span><input value={form.name || ''} onChange={(event) => update('name', event.target.value)} placeholder="Team 所有者" /></label>
    <label><span>所有者邮箱</span><input value={form.email || ''} onChange={(event) => update('email', event.target.value)} placeholder="owner@example.com" /></label>
    <label><span>母号密码</span><input type="password" value={form.password || ''} onChange={(event) => update('password', event.target.value)} placeholder={mother?.credentialsStatus?.hasPassword ? '留空保持现有密码' : '母号登录密码'} /></label>
    <label><span>母号 2FA Secret</span><input type="password" value={form.totp || ''} onChange={(event) => update('totp', event.target.value)} placeholder={mother?.credentialsStatus?.hasTotp ? '留空保持现有 2FA' : 'Base32 Secret'} /></label>
    <label className="wide"><span>邮箱验证码地址</span><input value={form.mailboxUrl || ''} onChange={(event) => update('mailboxUrl', event.target.value)} placeholder="仅异常触发邮箱验证时使用" /></label>
    <label className="wide"><span>Team 显示名称</span><input value={form.teamName || ''} onChange={(event) => update('teamName', event.target.value)} placeholder="例如：研发 Team" /></label>
    <label className="wide"><span>Team ID（accountId / team）</span><input value={form.accountId || form.team || ''} onChange={(event) => { update('accountId', event.target.value); update('team', event.target.value); }} placeholder="chatgpt_account_id" /></label>
    <label className="wide"><span>目标 Sub2API</span><select className="select-control" value={form.sub2apiIntegrationId || defaultSub2apiId} onChange={(event) => update('sub2apiIntegrationId', event.target.value)}>{selectedSub2ApiMissing && <option value={form.sub2apiIntegrationId}>原连接已删除，请重新选择</option>}{sub2apis.length ? sub2apis.map((item, index) => <option value={item.id} key={item.id}>{item.name || `Sub2API ${index + 1}`}{item.enabled ? '' : '（未启用）'}</option>) : <option value={defaultSub2apiId}>默认 Sub2API（未配置）</option>}</select><small className="field-hint">首次加入和 401 修复都会同步到此连接；未选择时使用第一项。</small></label>
    <div className="team-rotation-setting"><div><span>参与自动轮转</span><small>关闭后不自动检测、踢出或补位；Team 数据与手动操作仍保留。</small></div><Toggle checked={form.rotationEnabled !== false} onChange={(value) => update('rotationEnabled', value)} /></div>
    <label className="wide"><span>补位席位类型</span><div className="segmented modal-segmented seat-policy-control">{[['auto', '自动（普通优先）'], ['default', '普通席位'], ['prolite', '高级席位']].map(([id, label]) => <button type="button" key={id} className={(form.inviteSeatType || 'auto') === id ? 'selected' : ''} onClick={() => update('inviteSeatType', id)}>{label}</button>)}</div><small className="field-hint">自动模式按分类余量分配，优先使用普通席位；只有高级席位会在同意申请前调用席位设置接口。</small></label>
    <label><span>轮转方式</span><div className="segmented modal-segmented">{[['fixed', '固定主号'], ['rotating', '不固定主号']].map(([id, label]) => <button type="button" key={id} className={(form.rotationMode || 'fixed') === id ? 'selected' : ''} onClick={() => { update('rotationMode', id); if (id === 'fixed' && !form.primaryOwnerEmail) update('primaryOwnerEmail', form.email || ''); }}>{label}</button>)}</div></label>
    <label className="wide"><span>固定主号（不会被踢）</span><select className="select-control" disabled={(form.rotationMode || 'fixed') === 'rotating' || !ownerOptions.length} value={form.primaryOwnerEmail || form.email || ''} onChange={(event) => update('primaryOwnerEmail', event.target.value)}>{ownerOptions.length ? ownerOptions.map((owner) => <option value={owner.email} key={owner.email}>{owner.name ? `${owner.name} · ${owner.email}` : owner.email}</option>) : <option value="">先填写所有者邮箱</option>}</select><small className="field-hint">{form.rotationMode === 'rotating' ? '不固定主号模式下，所有者都可以轮转' : '固定模式下仅此账号不会被自动移出'}</small></label>
    <div className="team-rotation-setting"><div><span>不同步母号账号</span><small>只排除母号邮箱；其他所有者和成员正常推送。</small></div><Toggle checked={form.syncOwnerToSub2api === false} onChange={(exclude) => update('syncOwnerToSub2api', !exclude)} /></div>
    <label><span>所有者 Access Token</span><input type="password" value={form.token || ''} onChange={(event) => update('token', event.target.value)} placeholder={mother ? '留空保持现有 AT' : '粘贴所有者 AT'} /></label>
    <label><span>席位上限</span><input type="number" min="0" max="100" value={form.seats ?? 0} onChange={(event) => update('seats', Number(event.target.value))} /></label>
    <label><span>每日轮转账号上限</span><input type="number" min="1" max="100" value={form.dailyRotationLimit ?? 3} onChange={(event) => update('dailyRotationLimit', Math.min(100, Math.max(1, Number(event.target.value) || 3)))} /><small className="field-hint">按 Team 独立统计，次日自动归零</small></label>
  </div><div className="modal-foot mother-edit-foot"><span className="muted">所有者凭据用于检测 Team、发送邀请和补位。</span><button className="button primary" onClick={() => onSave(form)}><Check size={15} />保存 Team</button></div></Modal>;
}
function MotherManagerModal({ mother, action, onClose, onSave, onProbe, onRecover, onDelete }) {
  const [form, setForm] = useState(() => ({ email: mother?.email || '', name: mother?.name || '', password: '', totp: '', mailboxUrl: mother?.mailboxUrl || '' }));
  if (!mother) return null;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const fields = { email: form.email, name: form.name, password: form.password, totp: form.totp, mailboxUrl: form.mailboxUrl };
  const probes = [['额度接口', mother.lastProbe], ['成员接口', mother.lastMembersProbe], ['订阅接口', mother.lastSubscriptionProbe]];
  return <Modal title={`管理母号 · ${teamDisplayName(mother)}`} onClose={onClose} className="mother-manager-modal">
    <div className="mother-manager-head"><strong>{mother.email || '未设置母号邮箱'}</strong><TeamHealthStatus mother={mother} /></div>
    <div className="mother-health-grid">{probes.map(([label, probe]) => <div className="mother-health-item" key={label}><span>{label}</span><strong className={probe?.ok ? 'ready' : probe ? 'failed' : ''}>{probe ? probe.ok ? '正常' : probe.status ? `HTTP ${probe.status}` : '检测失败' : '未检测'}</strong><small title={probe?.message || ''}>{probe?.message || '尚无接口记录'}</small></div>)}</div>
    {mother.banReason && <div className="mother-ban-notice"><ShieldAlert size={15} />{mother.banReason}</div>}
    <div className="form-grid mother-credential-form">
      <label><span>母号邮箱</span><input value={form.email} onChange={(event) => update('email', event.target.value)} /></label>
      <label><span>名称</span><input value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label><span>登录密码</span><input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} placeholder={mother.credentialsStatus?.hasPassword ? '已保存，留空保持现有密码' : '输入母号密码'} /></label>
      <label><span>2FA Secret</span><input type="password" value={form.totp} onChange={(event) => update('totp', event.target.value)} placeholder={mother.credentialsStatus?.hasTotp ? '已保存，留空保持现有 2FA' : '输入 Base32 Secret'} /></label>
      <label className="wide"><span>邮箱验证码地址</span><input value={form.mailboxUrl} onChange={(event) => update('mailboxUrl', event.target.value)} /></label>
    </div>
    {action.message && <div className="mother-manager-action" role="status">{action.message}{action.authUrl && <a href={action.authUrl} target="_blank" rel="noreferrer">打开授权链接</a>}</div>}
    <div className="modal-foot mother-manager-foot"><button className="button ghost mother-delete-button" disabled={action.loading} onClick={onDelete}><Trash2 size={14} />从项目删除 Team</button><div className="modal-foot-actions"><button className="button ghost" disabled={action.loading} onClick={onProbe}><RefreshCw size={14} />检测母号</button><button className="button secondary" disabled={action.loading || !form.email} onClick={() => onRecover(fields)}><KeyRound size={14} />恢复管理凭据</button><button className="button primary" disabled={action.loading || !form.email} onClick={() => onSave(fields)}><Check size={14} />保存凭据</button></div></div>
  </Modal>;
}
function SettingsModal({ onClose }) { return <Modal title="快速设置" onClose={onClose}><div className="quick-setting"><Activity size={18} /><div><strong>实时监控</strong><span>每 60 秒检测一次子号额度</span></div><Toggle checked onChange={() => {}} /></div><div className="quick-setting"><ShieldCheck size={18} /><div><strong>加入前验证</strong><span>获取 AT 后先检测可用性再进入 Team</span></div><Toggle checked onChange={() => {}} /></div></Modal>; }

createRoot(document.getElementById('root')).render(<App />);
