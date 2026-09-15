export function isChallenge(result) {
  return /cloudflare_challenge|proxy_challenge_cooldown/i.test(result?.errorCode || result?.code || '')
    || /Cloudflare.*(?:拦截|challenge)/i.test(result?.message || '');
}

export function quotaHealth(result, banReason = '') {
  if (banReason) return { status: 'banned', accountStatus: 'banned' };
  if (result?.ok) return { status: 'online', accountStatus: 'healthy' };
  if (Number(result?.status) === 401 || result?.message === 'missing_token') {
    return { status: 'unconfigured', accountStatus: 'auth_required' };
  }
  return { status: 'probe_blocked', accountStatus: 'probe_blocked' };
}

export function managementHealth(members, subscription) {
  if (members?.ok) return subscription?.ok === false ? 'degraded' : 'ready';
  if (!members) return 'unavailable';
  if (isChallenge(members)) return 'blocked';
  if (Number(members.status) === 403) return 'forbidden';
  if (Number(members.status) === 401) return 'auth_required';
  return 'blocked';
}
