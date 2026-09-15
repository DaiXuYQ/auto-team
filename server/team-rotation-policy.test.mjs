import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticRotationTeams, normalizeTeamRotationEnabled, teamParticipatesInRotation } from './team-rotation-policy.mjs';

test('legacy teams participate in automatic rotation by default', () => {
  assert.equal(teamParticipatesInRotation({ id: 'legacy' }), true);
  assert.equal(normalizeTeamRotationEnabled(undefined), true);
});

test('an explicitly disabled team is excluded from automatic rotation selection', () => {
  const teams = [
    { id: 'enabled', rotationEnabled: true, configured: true },
    { id: 'disabled', rotationEnabled: false, configured: true },
    { id: 'legacy', configured: true },
    { id: 'incomplete', rotationEnabled: true, configured: false },
  ];

  assert.deepEqual(
    automaticRotationTeams(teams, (team) => team.configured).map((team) => team.id),
    ['enabled', 'legacy'],
  );
});

test('normalizes boolean-like imported values', () => {
  assert.equal(normalizeTeamRotationEnabled('false'), false);
  assert.equal(normalizeTeamRotationEnabled('0'), false);
  assert.equal(normalizeTeamRotationEnabled('true'), true);
  assert.equal(normalizeTeamRotationEnabled(0), false);
});
