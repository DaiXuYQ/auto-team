import test from 'node:test';
import assert from 'node:assert/strict';
import { isChallenge, managementHealth, quotaHealth } from '../shared/team-health.mjs';

test('a failed quota probe is not an account ban', () => {
  assert.deepEqual(quotaHealth({ ok: false, status: 403, code: 'cloudflare_challenge' }), { status: 'probe_blocked', accountStatus: 'probe_blocked' });
  assert.deepEqual(quotaHealth({ ok: false, status: 401 }), { status: 'unconfigured', accountStatus: 'auth_required' });
  assert.deepEqual(quotaHealth({ ok: false }, 'account_deactivated'), { status: 'banned', accountStatus: 'banned' });
  assert.equal(isChallenge({ code: 'cloudflare_challenge' }), true);
});

test('management permission and subscription failure remain distinct', () => {
  assert.equal(managementHealth({ ok: false, status: 403 }), 'forbidden');
  assert.equal(managementHealth({ ok: true }, { ok: false }), 'degraded');
  assert.equal(managementHealth({ ok: true }, { ok: true }), 'ready');
});
