import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataCache } from './square-cache.mjs';

test('metadata expires and is isolated by account and endpoint', async () => {
  let time = 0;
  let calls = 0;
  const cache = createMetadataCache({ ttlMs: 60, now: () => time });
  const load = () => ++calls;
  assert.equal(await cache('account-a:locations', load), 1);
  assert.equal(await cache('account-a:locations', load), 1);
  assert.equal(await cache('account-b:locations', load), 2);
  assert.equal(await cache('account-a:catalog', load), 3);
  time = 60;
  assert.equal(await cache('account-a:locations', load), 4);
});

test('failed requests are retried rather than cached', async () => {
  const cache = createMetadataCache();
  await assert.rejects(cache('a', () => { throw new Error('offline'); }));
  assert.equal(await cache('a', () => 'recovered'), 'recovered');
});
