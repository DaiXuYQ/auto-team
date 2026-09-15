import test from 'node:test';
import assert from 'node:assert/strict';
import { managerLoginCooldown } from './team-manager-recovery.mjs';

test('only recent automatic manager login attempts are cooled down', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(managerLoginCooldown(null, 900_000, now), 0);
  assert.equal(managerLoginCooldown(new Date(now - 60_000).toISOString(), 900_000, now), 840_000);
  assert.equal(managerLoginCooldown(new Date(now - 900_000).toISOString(), 900_000, now), 0);
});
