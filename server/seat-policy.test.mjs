import assert from 'node:assert/strict';
import test from 'node:test';
import { inviteApprovalPayloads, normalizeInviteSeatType, reconcileAcceptedSeatUsage, seatCapacityByType, selectInviteSeatType, shouldRetainSeatClaim, totalSeatAvailability } from './seat-policy.mjs';

const snapshot = {
  seatsEntitled: 15,
  seatsInUse: 9,
  seatCapacity: [
    { type: 'default', paid: 10, available: 2, held: 0 },
    { type: 'prolite', paid: 5, available: 4, held: 0 },
  ],
};

test('normalizes unknown or missing invite seat policy to auto', () => {
  assert.equal(normalizeInviteSeatType(), 'auto');
  assert.equal(normalizeInviteSeatType('unknown'), 'auto');
  assert.equal(normalizeInviteSeatType('prolite'), 'prolite');
});

test('auto seat policy prefers standard capacity and then uses premium capacity', () => {
  assert.deepEqual(selectInviteSeatType('auto', snapshot).seatType, 'default');
});

test('auto seat policy switches from standard to premium after standard reservations consume its capacity', () => {
  const result = selectInviteSeatType('auto', snapshot, { default: 2, prolite: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.seatType, 'prolite');
  assert.equal(result.source, 'available_capacity');
});

test('fixed seat policy does not silently fall back when its capacity is exhausted', () => {
  const result = selectInviteSeatType('default', snapshot, { default: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_type_capacity_exhausted');
});

test('all policies stop at the authoritative total seat limit even when type capacity reports availability', () => {
  const inconsistentSnapshot = {
    seatsEntitled: 10,
    seatsInUse: 10,
    seatCapacity: [
      { type: 'default', paid: 10, available: 3, held: 0 },
      { type: 'prolite', paid: 5, available: 2, held: 0 },
    ],
  };
  for (const mode of ['auto', 'default', 'prolite']) {
    const result = selectInviteSeatType(mode, inconsistentSnapshot);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_exhausted');
    assert.equal(result.message, 'total_seat_capacity_exhausted');
  }
});

test('reservations across seat types cannot exceed the total remaining seats', () => {
  const oneSeatRemaining = {
    seatsEntitled: 10,
    seatsInUse: 9,
    seatCapacity: [
      { type: 'default', paid: 10, available: 3, held: 0 },
      { type: 'prolite', paid: 5, available: 2, held: 0 },
    ],
  };
  assert.equal(selectInviteSeatType('auto', oneSeatRemaining).ok, true);
  for (const mode of ['auto', 'default', 'prolite']) {
    const result = selectInviteSeatType(mode, oneSeatRemaining, { default: 1, prolite: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_exhausted');
  }

  const twoSeatsRemaining = { ...oneSeatRemaining, seatsInUse: 8 };
  const result = selectInviteSeatType('prolite', twoSeatsRemaining, { default: 1, prolite: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_capacity_exhausted');
});

test('held seats exhaust the total and type capacity in the subscription example', () => {
  const subscription = {
    seats_in_use: 52,
    seats_entitled: 62,
    seat_capacity: [
      { type: 'default', paid: 2, held: 0 },
      { type: 'prolite', paid: 60, held: 10 },
    ],
    assigned: { default: 2, prolite: 50 },
  };
  assert.deepEqual(totalSeatAvailability(subscription), {
    entitled: 62,
    inUse: 52,
    held: 10,
    reserved: 0,
    remaining: 0,
  });
  assert.equal(seatCapacityByType(subscription).get('prolite').remaining, 0);
  for (const mode of ['auto', 'default', 'prolite']) {
    const result = selectInviteSeatType(mode, subscription);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_exhausted');
  }
});

test('missing or empty held metadata is treated as zero', () => {
  for (const held of [undefined, null, '']) {
    const result = selectInviteSeatType('default', {
      seatsEntitled: 10,
      seatsInUse: 8,
      seatCapacity: [{ type: 'default', paid: 10, available: 2, held }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.seatType, 'default');
  }
});

test('invalid or negative held metadata blocks approval instead of over-admitting', () => {
  for (const held of ['invalid', -1, Number.POSITIVE_INFINITY]) {
    const subscription = {
      seatsEntitled: 10,
      seatsInUse: 8,
      seatCapacity: [{ type: 'default', paid: 10, available: 2, held }],
    };
    assert.equal(totalSeatAvailability(subscription), null);
    assert.equal(seatCapacityByType(subscription).get('default').remaining, null);
    assert.equal(selectInviteSeatType('default', subscription).code, 'seat_capacity_unavailable');
  }
});

test('held seats from future types consume the shared total capacity', () => {
  const subscription = {
    seatsEntitled: 10,
    seatsInUse: 9,
    seatCapacity: [
      { type: 'default', paid: 10, available: 1, held: 0 },
      { type: 'future-type', paid: 1, held: 1 },
    ],
  };
  assert.equal(totalSeatAvailability(subscription).remaining, 0);
  assert.equal(selectInviteSeatType('default', subscription).code, 'seat_capacity_exhausted');
});

test('remote held seats and local approval claims share the hard total limit', () => {
  const constrained = {
    seatsEntitled: 10,
    seatsInUse: 6,
    seatCapacity: [
      { type: 'default', paid: 10, available: 4, held: 1 },
      { type: 'prolite', paid: 5, available: 4, held: 0 },
    ],
  };
  const reservations = { default: 2, prolite: 2 };
  for (const mode of ['auto', 'default', 'prolite']) {
    const result = selectInviteSeatType(mode, constrained, reservations);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_exhausted');
    assert.equal(result.message, 'total_seat_capacity_exhausted');
  }
});

test('assigned members remain actual usage while held consumes type capacity', () => {
  const result = selectInviteSeatType('default', {
    seatsEntitled: 12,
    seatsInUse: 9,
    assigned: { default: 9 },
    seatCapacity: [{ type: 'default', paid: 10, available: null, held: 1 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_type_capacity_exhausted');
});

test('reported availability can only lower computed type capacity', () => {
  const subscription = {
    seatsEntitled: 20,
    seatsInUse: 6,
    assigned: { default: 6 },
    seatCapacity: [{ type: 'default', paid: 10, held: 1, available: 2 }],
  };
  assert.equal(seatCapacityByType(subscription).get('default').remaining, 2);
  subscription.seatCapacity[0].available = 9;
  assert.equal(seatCapacityByType(subscription).get('default').remaining, 3);
});

test('reported type availability is reduced by held when assigned is unavailable', () => {
  const subscription = {
    seatsEntitled: 10,
    seatsInUse: 5,
    seatCapacity: [{ type: 'default', paid: 10, available: 3, held: 1 }],
  };
  assert.equal(seatCapacityByType(subscription).get('default').remaining, 2);
  assert.equal(selectInviteSeatType('default', subscription, { default: 2 }).code, 'seat_type_capacity_exhausted');
});

test('reservations for any present or future seat type consume the hard total limit', () => {
  const result = selectInviteSeatType('default', {
    seatsEntitled: 10,
    seatsInUse: 8,
    seatCapacity: [
      { type: 'default', paid: 10, available: 2, held: 0 },
      { type: 'prolite', paid: 5, available: 5, held: 0 },
    ],
  }, { automation: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_capacity_exhausted');
  assert.equal(result.message, 'total_seat_capacity_exhausted');
});

test('a fractional total remainder cannot authorize a whole seat', () => {
  const result = selectInviteSeatType('default', {
    seatsEntitled: 10,
    seatsInUse: 9.5,
    seatCapacity: [{ type: 'default', paid: 10, available: 1, held: 0 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_capacity_exhausted');
});

test('a fractional type remainder cannot authorize a whole seat', () => {
  const result = selectInviteSeatType('default', {
    seatsEntitled: 10,
    seatsInUse: 8,
    seatCapacity: [{ type: 'default', paid: 10, available: 0.5, held: 0 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_type_capacity_exhausted');
});

test('auto seat policy blocks approval when capacity details are unavailable', () => {
  const result = selectInviteSeatType('auto', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_capacity_unavailable');
});

test('all policies block when authoritative total seat usage is unavailable', () => {
  const capacityOnlySnapshot = {
    seatCapacity: [
      { type: 'default', paid: 10, available: 2, held: 0 },
      { type: 'prolite', paid: 5, available: 4, held: 0 },
    ],
  };
  for (const mode of ['auto', 'default', 'prolite']) {
    const result = selectInviteSeatType(mode, capacityOnlySnapshot);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_unavailable');
    assert.equal(result.message, 'total_seat_capacity_unavailable');
  }
});

test('fixed seat policies block approval when capacity details are unavailable', () => {
  for (const seatType of ['default', 'prolite']) {
    const result = selectInviteSeatType(seatType, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'seat_capacity_unavailable');
    assert.equal(result.seatType, seatType);
  }
});

test('null availability is treated as unknown instead of zero capacity', () => {
  const result = selectInviteSeatType('default', {
    seatsEntitled: 10,
    seatsInUse: 0,
    seatCapacity: [{ type: 'default', paid: 10, available: null, held: 0 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'seat_capacity_unavailable');
});

test('accepted seats remain counted while the remote subscription snapshot is stale', () => {
  assert.equal(reconcileAcceptedSeatUsage({ syncedUsed: 5, usedBeforeRefill: 5, acceptedSeats: 2, seatsEntitled: 10 }), 7);
  assert.equal(reconcileAcceptedSeatUsage({ syncedUsed: 8, usedBeforeRefill: 5, acceptedSeats: 2, seatsEntitled: 10 }), 8);
  assert.equal(reconcileAcceptedSeatUsage({ syncedUsed: 9, usedBeforeRefill: 9, acceptedSeats: 2, seatsEntitled: 10 }), 10);
});

test('ordinary seats skip the seat assignment request', () => {
  const payloads = inviteApprovalPayloads('default', 'standard-user');
  assert.equal(payloads.seatAssignment, null);
  assert.deepEqual(payloads.approval, { role: 'standard-user', accept_request: true });
});

test('premium seats are assigned before approval', () => {
  const payloads = inviteApprovalPayloads('prolite');
  assert.deepEqual(payloads.seatAssignment, { seat_type: 'prolite' });
  assert.deepEqual(payloads.approval, { role: 'account-owner', accept_request: true });
});

test('an attempted approval keeps its claim until membership is verified', () => {
  assert.equal(shouldRetainSeatClaim({ acceptAttempted: true, status: 400 }), true);
  assert.equal(shouldRetainSeatClaim({ acceptAttempted: true, status: 0 }), true);
  assert.equal(shouldRetainSeatClaim({ seatAssigned: true, acceptAttempted: false }), true);
  assert.equal(shouldRetainSeatClaim({ seatAssignmentAttempted: true, seatAssigned: false, acceptAttempted: false }), false);
  assert.equal(shouldRetainSeatClaim({ approvalAttempted: false }), false);
});
