export function normalizeDelayedKickMinutes(value, fallback = 10) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.floor(minutes))) : fallback;
}

export function clearQuotaKickDelay(membership) {
  if (!membership) return;
  membership.quotaKickExhaustedAt = null;
  membership.quotaKickPendingUntil = null;
  membership.quotaKickWindow = null;
  membership.quotaKickVerifiedAt = null;
}

export function updateQuotaKickDelay(membership, { enabled, window, minutes, probe, nowMs = Date.now() }) {
  if (!membership) return;
  if (!enabled || !['5h', '7d'].includes(window)) {
    clearQuotaKickDelay(membership);
    return;
  }
  if (membership.quotaKickWindow && membership.quotaKickWindow !== window) clearQuotaKickDelay(membership);
  const selected = window === '7d' ? probe?.secondary : probe?.primary;
  const usedPercent = selected?.usedPercent;
  if (!probe?.ok || usedPercent === null || usedPercent === undefined || usedPercent === '' || !Number.isFinite(Number(usedPercent))) {
    membership.quotaKickVerifiedAt = null;
    return;
  }
  if (Number(usedPercent) < 99.99) {
    clearQuotaKickDelay(membership);
    return;
  }
  const previousStart = membership.quotaKickWindow === window ? Date.parse(membership.quotaKickExhaustedAt || '') : NaN;
  const start = Number.isFinite(previousStart) && previousStart <= nowMs ? previousStart : nowMs;
  membership.quotaKickWindow = window;
  membership.quotaKickExhaustedAt = new Date(start).toISOString();
  membership.quotaKickPendingUntil = new Date(start + normalizeDelayedKickMinutes(minutes) * 60_000).toISOString();
  membership.quotaKickVerifiedAt = new Date(nowMs).toISOString();
}

export function quotaKickDelayDue(membership, window, nowMs = Date.now()) {
  if (!membership || membership.quotaKickWindow !== window || membership.quotaStatusWindow !== window || membership.quotaStatus !== 'exhausted') return false;
  const dueAt = Date.parse(membership.quotaKickPendingUntil || '');
  const verifiedAt = Date.parse(membership.quotaKickVerifiedAt || '');
  return Number.isFinite(dueAt) && nowMs >= dueAt && Number.isFinite(verifiedAt) && verifiedAt >= dueAt;
}
