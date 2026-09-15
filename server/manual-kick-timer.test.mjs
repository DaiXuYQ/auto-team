import test from 'node:test';
import assert from 'node:assert/strict';
import {
  excludePreviouslyRemovedMembers,
  manualKickCooldownAt,
  manualKickTimerExpired,
  manualKickTimerState,
  parseManualKickTimerInput,
} from './manual-kick-timer.mjs';

const NOW = Date.parse('2026-09-15T00:00:00.000Z');

test('parses hour, minute, and absolute manual kick timers', () => {
  assert.deepEqual(parseManualKickTimerInput({ durationHours: 2 }, NOW), {
    ok: true,
    enabled: true,
    startedAt: '2026-09-15T00:00:00.000Z',
    kickAt: '2026-09-15T02:00:00.000Z',
    durationMinutes: 120,
  });
  assert.equal(parseManualKickTimerInput({ durationMinutes: 1 }, NOW).kickAt, '2026-09-15T00:01:00.000Z');
  assert.equal(parseManualKickTimerInput({ kickAt: '2026-09-15T03:00:00.000Z' }, NOW).durationMinutes, 180);
});

test('rejects ambiguous, expired, non-finite, and out-of-range durations', () => {
  assert.equal(parseManualKickTimerInput({}, NOW).code, 'manual_kick_duration_required');
  assert.equal(parseManualKickTimerInput({ durationHours: 1, durationMinutes: 60 }, NOW).code, 'manual_kick_duration_ambiguous');
  assert.equal(parseManualKickTimerInput({ durationHours: 'NaN' }, NOW).code, 'manual_kick_duration_invalid');
  assert.equal(parseManualKickTimerInput({ durationHours: [2] }, NOW).code, 'manual_kick_duration_invalid');
  assert.equal(parseManualKickTimerInput({ durationMinutes: 0.5 }, NOW).code, 'manual_kick_duration_out_of_range');
  assert.equal(parseManualKickTimerInput({ durationHours: 721 }, NOW).code, 'manual_kick_duration_out_of_range');
  assert.equal(parseManualKickTimerInput({ kickAt: '2026-09-14T23:59:00.000Z' }, NOW).code, 'manual_kick_duration_out_of_range');
});

test('disabled input cancels without requiring a duration', () => {
  assert.deepEqual(parseManualKickTimerInput({ enabled: false }, NOW), { ok: true, enabled: false });
});

test('reports countdown state and expiry without mutating membership', () => {
  const membership = {
    manualKickEnabled: true,
    manualKickStartedAt: '2026-09-15T00:00:00.000Z',
    manualKickAt: '2026-09-15T01:00:00.000Z',
    manualKickDurationMinutes: 60,
  };
  assert.equal(manualKickTimerState(membership, NOW).remainingSeconds, 3600);
  assert.equal(manualKickTimerExpired(membership, NOW), false);
  assert.equal(manualKickTimerExpired(membership, NOW + 60 * 60 * 1000), true);
  assert.equal(membership.manualKickEnabled, true);
});

test('uses the original manual duration for the rejoin cooldown', () => {
  const timer = {
    startedAt: '2026-09-15T00:00:00.000Z',
    kickAt: '2026-09-15T02:00:00.000Z',
    durationMinutes: 120,
  };
  assert.equal(manualKickCooldownAt(timer, '2026-09-15T03:00:00.000Z'), '2026-09-15T05:00:00.000Z');
});

test('filters stale remote members already removed during the same rotation run', () => {
  const members = [
    { id: 'member-a', accountUserId: 'account-a', email: 'A@example.com' },
    { id: 'member-b', accountUserId: 'account-b', email: 'b@example.com' },
    { id: 'member-c', email: 'c@example.com' },
  ];
  assert.deepEqual(
    excludePreviouslyRemovedMembers(members, new Set(['member-a']), new Set(['B@EXAMPLE.COM'])),
    [{ id: 'member-c', email: 'c@example.com' }],
  );
});
