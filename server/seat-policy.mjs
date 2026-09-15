export const INVITE_SEAT_TYPES = ['auto', 'default', 'prolite'];

export function normalizeInviteSeatType(value, fallback = 'auto') {
  const normalized = String(value || '').trim().toLowerCase();
  return INVITE_SEAT_TYPES.includes(normalized) ? normalized : fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function wholeSeatCount(value, rounding = 'floor') {
  const number = finiteNumber(value);
  if (number == null || number < 0) return null;
  return rounding === 'ceil' ? Math.ceil(number) : Math.floor(number);
}

function reservedSeatCount(reservations = {}) {
  if (!reservations || typeof reservations !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(reservations)) {
    const count = wholeSeatCount(value, 'ceil');
    if (count == null) return null;
    total += count;
  }
  return total;
}

function totalSeatAvailability(snapshot = {}, reservations = {}) {
  const entitled = wholeSeatCount(snapshot?.seatsEntitled ?? snapshot?.seats_entitled, 'floor');
  const inUse = wholeSeatCount(snapshot?.seatsInUse ?? snapshot?.seats_in_use, 'ceil');
  const reserved = reservedSeatCount(reservations);
  if (entitled == null || inUse == null || reserved == null) return null;
  return {
    entitled,
    inUse,
    reserved,
    remaining: Math.max(0, entitled - inUse - reserved),
  };
}

export function reconcileAcceptedSeatUsage({ syncedUsed, usedBeforeRefill, acceptedSeats = 0, seatsEntitled } = {}) {
  const synced = finiteNumber(syncedUsed);
  const baseline = finiteNumber(usedBeforeRefill);
  const accepted = Math.max(0, finiteNumber(acceptedSeats) || 0);
  const entitled = finiteNumber(seatsEntitled);
  const conservativeUsed = Math.max(synced || 0, (baseline || 0) + accepted);
  return entitled == null ? conservativeUsed : Math.min(Math.max(0, entitled), conservativeUsed);
}

export function seatCapacityByType(snapshot = {}, reservations = {}) {
  const capacities = Array.isArray(snapshot?.seatCapacity)
    ? snapshot.seatCapacity
    : Array.isArray(snapshot?.seat_capacity)
      ? snapshot.seat_capacity
      : [];
  const assigned = snapshot?.assigned && typeof snapshot.assigned === 'object' ? snapshot.assigned : {};
  const result = new Map();
  for (const entry of capacities) {
    const type = String(entry?.type || '').trim().toLowerCase();
    if (!['default', 'prolite'].includes(type)) continue;
    const paid = wholeSeatCount(entry?.paid ?? entry?.entitled ?? entry?.total, 'floor');
    const assignedCount = wholeSeatCount(assigned[type], 'ceil');
    const reportedAvailable = wholeSeatCount(entry?.available, 'floor');
    // Pending access requests do not consume seats. Prefer paid - assigned
    // when both values are present, then fall back to the reported remainder.
    const available = paid != null && assignedCount != null
      ? Math.max(0, paid - assignedCount)
      : reportedAvailable;
    const reserved = wholeSeatCount(reservations[type] ?? 0, 'ceil');
    result.set(type, {
      type,
      paid,
      available,
      remaining: available == null || reserved == null ? null : Math.max(0, available - reserved),
      reserved,
    });
  }
  return result;
}

export function selectInviteSeatType(mode, snapshot = {}, reservations = {}) {
  const requested = normalizeInviteSeatType(mode);
  const totalCapacity = totalSeatAvailability(snapshot, reservations);
  if (!totalCapacity) {
    return { ok: false, code: 'seat_capacity_unavailable', message: 'total_seat_capacity_unavailable', requested, seatType: requested === 'auto' ? null : requested };
  }
  if (totalCapacity.remaining < 1) {
    return { ok: false, code: 'seat_capacity_exhausted', message: 'total_seat_capacity_exhausted', requested, seatType: requested === 'auto' ? null : requested };
  }
  const capacity = seatCapacityByType(snapshot, reservations);
  if (requested !== 'auto') {
    if (!capacity.size) {
      return { ok: false, code: 'seat_capacity_unavailable', message: `${requested}_seat_capacity_unavailable`, requested, seatType: requested };
    }
    const selected = capacity.get(requested);
    if (selected && selected.remaining == null) {
      return { ok: false, code: 'seat_capacity_unavailable', message: `${requested}_seat_capacity_unavailable`, requested, seatType: requested };
    }
    if (selected && selected.remaining === 0) {
      return { ok: false, code: 'seat_type_capacity_exhausted', message: `${requested}_seat_capacity_exhausted`, requested, seatType: requested };
    }
    if (capacity.size > 0 && !selected) {
      return { ok: false, code: 'seat_type_not_entitled', message: `${requested}_seat_not_entitled`, requested, seatType: requested };
    }
    return { ok: true, requested, seatType: requested, source: 'fixed' };
  }

  if (!capacity.size) {
    return { ok: false, code: 'seat_capacity_unavailable', message: 'seat_capacity_unavailable', requested, seatType: null };
  }
  const candidates = [...capacity.values()]
    .filter((entry) => entry.remaining != null && entry.remaining > 0)
    // Preserve premium capacity while a standard seat is available.
    .sort((left, right) => left.type === right.type ? 0 : left.type === 'default' ? -1 : 1);
  if (!candidates.length) {
    return { ok: false, code: 'seat_capacity_exhausted', message: 'all_seat_capacity_exhausted', requested, seatType: null };
  }
  return { ok: true, requested, seatType: candidates[0].type, source: 'available_capacity' };
}

export function inviteApprovalPayloads(seatType, role = 'account-owner') {
  const normalizedSeatType = seatType === 'prolite' ? 'prolite' : 'default';
  const normalizedRole = role === 'standard-user' ? 'standard-user' : 'account-owner';
  return {
    seatType: normalizedSeatType,
    seatAssignment: normalizedSeatType === 'prolite' ? { seat_type: 'prolite' } : null,
    approval: { role: normalizedRole, accept_request: true },
  };
}

export function shouldRetainSeatClaim(approval = {}) {
  return approval?.acceptAttempted === true || approval?.seatAssigned === true;
}
