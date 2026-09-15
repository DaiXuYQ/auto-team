import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTeamSub2ApiRecords } from './sub2api-scope.mjs';

test('excludes only the mother email, not other owners or members', () => {
  const records = [{ email: ' Owner@EXAMPLE.com ' }, { email: 'other@example.com', role: 'account-owner' }, { email: 'member@example.com' }];
  assert.deepEqual(selectTeamSub2ApiRecords(records, { email: 'owner@example.com' }, true), records.slice(1));
  assert.deepEqual(selectTeamSub2ApiRecords(records, { email: 'owner@example.com' }), records);
  assert.deepEqual(selectTeamSub2ApiRecords(records, { email: '' }, true), records);
});
