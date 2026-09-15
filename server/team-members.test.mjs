import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTeamAccounts,
  mergeTeamMemberSnapshots,
  preferredTeamChild,
  teamRecordsShareIdentity,
} from '../shared/team-members.mjs';

test('matches a local child to a remote member by email and workspace ids', () => {
  const member = {
    id: 'user-a',
    accountUserId: 'user-a__team-1',
    email: 'Member@Example.com',
  };
  assert.equal(teamRecordsShareIdentity(member, { id: 'child-1', email: 'member@example.com' }), true);
  assert.equal(teamRecordsShareIdentity(member, { id: 'child-2', accountUserId: 'user-a__team-1' }), true);
  assert.equal(teamRecordsShareIdentity(member, { id: 'child-3', memberId: 'user-a' }), true);
});

test('coalesces duplicate member snapshots and keeps the richer child record', () => {
  const members = [
    { id: 'user-a', email: 'member@example.com', role: 'member', seatType: 'prolite', createdTime: '2026-09-10T00:00:00Z' },
    { accountUserId: 'user-a__team-1', email: 'MEMBER@example.com', role: 'account-owner', createdTime: '2026-09-09T00:00:00Z' },
  ];
  const staleChild = { id: 'child-stale', email: 'member@example.com', memberId: 'user-a', status: 'active' };
  const liveChild = {
    id: 'child-live',
    email: 'member@example.com',
    accountUserId: 'user-a__team-1',
    status: 'warning',
    quota5h: 97,
    quota7d: 4,
    quotaSnapshot: { source: 'wham/usage' },
    credentialsStatus: { hasPassword: true, hasTotp: true },
  };

  const groups = groupTeamAccounts(members, [staleChild, liveChild]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].child.id, 'child-live');
  assert.equal(groups[0].member.role, 'account-owner');
  assert.equal(groups[0].member.seatType, 'prolite');
  assert.equal(groups[0].member.createdTime, '2026-09-09T00:00:00Z');
});

test('uses a successful remote member snapshot as the authority for current seats', () => {
  const members = [
    { id: 'user-primary', email: 'primary@example.com', role: 'account-owner' },
    { id: 'user-current', email: 'current@example.com', role: 'account-owner' },
  ];
  const children = [
    { id: 'child-primary', email: 'primary@example.com', memberId: 'user-primary', quota5h: 90 },
    { id: 'child-removed', email: 'removed@example.com', memberId: 'user-removed', status: 'banned', quota5h: 0 },
  ];

  const authoritative = groupTeamAccounts(members, children, { authoritativeMembers: true });
  assert.equal(authoritative.length, 2);
  assert.equal(authoritative[0].child.id, 'child-primary');
  assert.equal(authoritative[1].member.email, 'current@example.com');
  assert.equal(authoritative[1].child, null);
  assert.equal(authoritative.some((group) => group.child?.id === 'child-removed'), false);

  const fallback = groupTeamAccounts(members, children);
  assert.equal(fallback.length, 3);
  assert.equal(fallback.some((group) => group.child?.id === 'child-removed'), true);
});

test('member and child preference helpers tolerate sparse records', () => {
  assert.equal(mergeTeamMemberSnapshots([]), null);
  assert.equal(preferredTeamChild([]), null);
  assert.equal(preferredTeamChild([{ id: 'empty', quota5h: null }, { id: 'live', quota5h: 0 }]).id, 'live');
});
