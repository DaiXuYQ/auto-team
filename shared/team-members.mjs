function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function addAccountUserIdentity(keys, value) {
  const normalized = normalizedText(value);
  if (!normalized) return;
  keys.add(`account-user:${normalized}`);
  const [memberId] = normalized.split('__');
  if (memberId) keys.add(`member:${memberId}`);
}

/**
 * Return stable identities without treating a local `child_*` id as a remote
 * workspace member id.
 */
export function teamRecordIdentityKeys(record = {}, kind = 'member') {
  const keys = new Set();
  const snapshot = kind === 'child' && record.memberSnapshot && typeof record.memberSnapshot === 'object'
    ? record.memberSnapshot
    : {};
  const emails = [record.email, record.verifiedEmail, record.verified_email, snapshot.email, snapshot.verifiedEmail, snapshot.verified_email];
  for (const email of emails) {
    const normalized = normalizedText(email);
    if (normalized) keys.add(`email:${normalized}`);
  }

  const memberIds = kind === 'child'
    ? [record.memberId, record.member_id, record.chatgptUserId, snapshot.id, snapshot.memberId, snapshot.member_id]
    : [record.id, record.memberId, record.member_id, record.userId, record.chatgptUserId];
  for (const memberId of memberIds) {
    const normalized = normalizedText(memberId);
    if (normalized) keys.add(`member:${normalized}`);
  }

  for (const accountUserId of [record.accountUserId, record.account_user_id, snapshot.accountUserId, snapshot.account_user_id]) {
    addAccountUserIdentity(keys, accountUserId);
  }
  return keys;
}

function identitiesOverlap(left, right) {
  if (!left.size || !right.size) return false;
  for (const key of left) if (right.has(key)) return true;
  return false;
}

export function teamRecordsShareIdentity(left, right, leftKind = 'member', rightKind = 'child') {
  return identitiesOverlap(teamRecordIdentityKeys(left, leftKind), teamRecordIdentityKeys(right, rightKind));
}

function meaningful(value) {
  return value !== undefined && value !== null && value !== '';
}

function memberScore(member) {
  let score = 0;
  for (const key of ['id', 'accountUserId', 'account_user_id', 'email', 'name', 'role', 'seatType', 'seat_type', 'createdTime', 'created_time']) {
    if (meaningful(member?.[key])) score += 1;
  }
  if (!member?.deactivatedTime && !member?.deactivated_time) score += 10;
  return score;
}

function ownerRole(role) {
  return ['owner', 'account-owner'].includes(normalizedText(role).replace(/[\s_]+/g, '-'));
}

export function mergeTeamMemberSnapshots(members = []) {
  const source = members.filter(Boolean);
  if (!source.length) return null;
  const preferred = source.reduce((best, member) => memberScore(member) > memberScore(best) ? member : best, source[0]);
  const merged = {};
  for (const member of source) {
    for (const [key, value] of Object.entries(member)) if (!meaningful(merged[key]) && meaningful(value)) merged[key] = value;
  }
  Object.assign(merged, Object.fromEntries(Object.entries(preferred).filter(([, value]) => meaningful(value))));

  const role = source.find((member) => ownerRole(member.role))?.role || preferred.role || source.find((member) => meaningful(member.role))?.role;
  if (role) merged.role = role;
  const seatType = preferred.seatType || preferred.seat_type || source.find((member) => member.seatType || member.seat_type)?.seatType || source.find((member) => member.seatType || member.seat_type)?.seat_type;
  if (seatType) merged.seatType = seatType;

  const createdTimes = source.map((member) => member.createdTime || member.created_time || member.joinedAt).filter(Boolean);
  if (createdTimes.length) {
    const earliest = createdTimes.reduce((best, value) => {
      const time = Date.parse(value);
      const bestTime = Date.parse(best);
      return Number.isFinite(time) && (!Number.isFinite(bestTime) || time < bestTime) ? value : best;
    }, createdTimes[0]);
    merged.createdTime = earliest;
  }
  if (source.some((member) => !member.deactivatedTime && !member.deactivated_time)) {
    merged.deactivatedTime = null;
    delete merged.deactivated_time;
  }
  return merged;
}

function childScore(child) {
  let score = 0;
  if (child?.memberId || child?.member_id) score += 20;
  if (child?.accountUserId || child?.account_user_id) score += 20;
  if (child?.quotaSnapshot) score += 20;
  if (meaningful(child?.quota5h) && Number.isFinite(Number(child.quota5h))) score += 8;
  if (meaningful(child?.quota7d) && Number.isFinite(Number(child.quota7d))) score += 8;
  if (child?.credentialsStatus) score += 8;
  if (child?.hasAccessToken || child?.token) score += 4;
  if (child?.status) score += 2;
  return score;
}

function childFreshness(child) {
  for (const value of [child?.lastQuotaCheckAt, child?.quotaUpdatedAt, child?.updatedAt, child?.importedAt]) {
    const timestamp = Date.parse(value || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function preferredTeamChild(children = []) {
  return children.filter(Boolean).reduce((best, child) => {
    if (!best) return child;
    const score = childScore(child);
    const bestScore = childScore(best);
    if (score !== bestScore) return score > bestScore ? child : best;
    return childFreshness(child) > childFreshness(best) ? child : best;
  }, null);
}

/**
 * Coalesce remote member snapshots and local Free-account records into one
 * group per real ChatGPT account. Groups retain all source records so callers
 * can project sensitive/public fields according to their own boundary.
 */
export function groupTeamAccounts(members = [], children = [], { authoritativeMembers = false } = {}) {
  const groups = [];
  const sources = [
    ...members.filter(Boolean).map((record) => ({ kind: 'member', record })),
    ...children.filter(Boolean).map((record) => ({ kind: 'child', record })),
  ];

  for (const source of sources) {
    const keys = teamRecordIdentityKeys(source.record, source.kind);
    const matching = [];
    for (let index = 0; index < groups.length; index += 1) {
      if (identitiesOverlap(groups[index].keys, keys)) matching.push(index);
    }
    if (!matching.length) {
      groups.push({ keys, members: source.kind === 'member' ? [source.record] : [], children: source.kind === 'child' ? [source.record] : [] });
      continue;
    }

    const target = groups[matching[0]];
    for (const key of keys) target.keys.add(key);
    target[source.kind === 'member' ? 'members' : 'children'].push(source.record);
    for (let offset = matching.length - 1; offset > 0; offset -= 1) {
      const duplicate = groups[matching[offset]];
      for (const key of duplicate.keys) target.keys.add(key);
      target.members.push(...duplicate.members);
      target.children.push(...duplicate.children);
      groups.splice(matching[offset], 1);
    }
  }

  const projected = groups.map((group) => {
    const identityKey = ['account-user:', 'member:', 'email:']
      .map((prefix) => [...group.keys].find((key) => key.startsWith(prefix)))
      .find(Boolean) || '';
    return {
      identityKey,
      member: mergeTeamMemberSnapshots(group.members),
      child: preferredTeamChild(group.children),
      members: group.members,
      children: group.children,
    };
  });
  return authoritativeMembers ? projected.filter((group) => group.member) : projected;
}
