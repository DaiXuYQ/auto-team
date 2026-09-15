const MIN_DURATION_MS = 60 * 1000;
const MAX_DURATION_MS = 720 * 60 * 60 * 1000;

function supplied(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(numeric) ? numeric : null;
}

export function parseManualKickTimerInput(input = {}, currentTime = Date.now()) {
  if (input?.enabled === false) return { ok: true, enabled: false };

  const nowMs = Number(currentTime);
  if (!Number.isFinite(nowMs)) return { ok: false, code: 'manual_kick_current_time_invalid' };

  const candidates = [
    ['durationHours', input?.durationHours],
    ['durationMinutes', input?.durationMinutes],
    ['kickAt', input?.kickAt],
  ].filter(([, value]) => supplied(value));

  if (!candidates.length) return { ok: false, code: 'manual_kick_duration_required' };
  if (candidates.length > 1) return { ok: false, code: 'manual_kick_duration_ambiguous' };

  const [source, value] = candidates[0];
  let kickAtMs;
  let durationMs;
  if (source === 'kickAt') {
    kickAtMs = Date.parse(String(value));
    if (!Number.isFinite(kickAtMs)) return { ok: false, code: 'manual_kick_at_invalid' };
    durationMs = kickAtMs - nowMs;
  } else {
    const numeric = finiteNumber(value);
    if (numeric === null || numeric <= 0) return { ok: false, code: 'manual_kick_duration_invalid' };
    durationMs = numeric * (source === 'durationHours' ? 60 * 60 * 1000 : 60 * 1000);
    kickAtMs = nowMs + durationMs;
  }

  if (!Number.isFinite(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    return { ok: false, code: 'manual_kick_duration_out_of_range', minMinutes: 1, maxHours: 720 };
  }

  return {
    ok: true,
    enabled: true,
    startedAt: new Date(nowMs).toISOString(),
    kickAt: new Date(kickAtMs).toISOString(),
    durationMinutes: durationMs / (60 * 1000),
  };
}

export function manualKickTimerState(membership, currentTime = Date.now()) {
  const enabled = membership?.manualKickEnabled === true;
  const kickAtMs = Date.parse(membership?.manualKickAt || '');
  const valid = enabled && Number.isFinite(kickAtMs);
  const nowMs = Number(currentTime);
  const remainingMs = valid && Number.isFinite(nowMs) ? kickAtMs - nowMs : null;
  const storedDuration = membership?.manualKickDurationMinutes;
  const durationMinutes = storedDuration !== null && storedDuration !== undefined && storedDuration !== ''
    && Number.isFinite(Number(storedDuration)) && Number(storedDuration) > 0
    ? Number(storedDuration)
    : null;
  return {
    enabled,
    startedAt: enabled ? membership?.manualKickStartedAt || null : null,
    kickAt: valid ? new Date(kickAtMs).toISOString() : null,
    durationMinutes: enabled ? durationMinutes : null,
    expired: valid && remainingMs <= 0,
    remainingSeconds: valid ? Math.max(0, Math.ceil(remainingMs / 1000)) : null,
  };
}

export function manualKickTimerExpired(membership, currentTime = Date.now()) {
  return manualKickTimerState(membership, currentTime).expired;
}

export function manualKickCooldownAt(timer, removedTime = Date.now()) {
  const removedMs = typeof removedTime === 'number' ? removedTime : Date.parse(String(removedTime || ''));
  const configuredMinutes = Number(timer?.durationMinutes);
  let durationMs = Number.isFinite(configuredMinutes) && configuredMinutes > 0
    ? configuredMinutes * 60 * 1000
    : NaN;
  if (!Number.isFinite(durationMs)) {
    const startedMs = Date.parse(timer?.startedAt || '');
    const kickAtMs = Date.parse(timer?.kickAt || '');
    durationMs = kickAtMs - startedMs;
  }
  if (!Number.isFinite(removedMs) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return new Date(removedMs + Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, durationMs))).toISOString();
}

export function excludePreviouslyRemovedMembers(members, removedIds = new Set(), removedEmails = new Set()) {
  const idSet = new Set([...(removedIds || [])].map(String));
  const emailSet = new Set([...(removedEmails || [])].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
  return (Array.isArray(members) ? members : []).filter((member) => {
    const ids = [member?.id, member?.accountUserId].filter(Boolean).map(String);
    const email = String(member?.email || '').trim().toLowerCase();
    return !ids.some((id) => idSet.has(id)) && !(email && emailSet.has(email));
  });
}
