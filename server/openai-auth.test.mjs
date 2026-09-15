import assert from 'node:assert/strict';
import test from 'node:test';
import { isOpenAiAuthFailure } from './openai-auth.mjs';

test('classifies only authentication failures for automatic credential recovery', () => {
  assert.equal(isOpenAiAuthFailure({ status: 401, message: 'unauthorized' }), true);
  assert.equal(isOpenAiAuthFailure({ status: 0, message: 'missing_token' }), true);
  assert.equal(isOpenAiAuthFailure({ status: 403, message: 'Provided authentication token is expired' }), true);
  assert.equal(isOpenAiAuthFailure({ status: 403, message: 'Encountered invalidated oauth token for user' }), true);
  assert.equal(isOpenAiAuthFailure({ status: 403, message: 'insufficient workspace permissions' }), false);
  assert.equal(isOpenAiAuthFailure({ status: 0, message: 'network_error' }), false);
});
