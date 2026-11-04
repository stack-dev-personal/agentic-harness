import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalFixturePath } from './helpers/fixture-path.mjs';

test('fixture canonicalization keeps native Windows long-name expansion when available', () => {
  assert.equal(canonicalFixturePath('short-path', {
    nativeRealpath: (value) => { assert.equal(value, 'short-path'); return 'expanded-path'; },
    realpath: () => assert.fail('the fallback must not replace native canonicalization'),
  }), 'expanded-path');
});

test('fixture canonicalization uses the standard resolver when native resolution is unavailable', () => {
  for (const code of ['EPERM', 'ENOSYS']) {
    assert.equal(canonicalFixturePath('fixture-path', {
      nativeRealpath: () => { throw Object.assign(new Error('native resolver unavailable'), { code }); },
      realpath: (value) => { assert.equal(value, 'fixture-path'); return 'canonical-fixture-path'; },
    }), 'canonical-fixture-path');
  }
});

test('fixture canonicalization preserves missing-path errors and fallback errors', () => {
  const missing = Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
  assert.throws(() => canonicalFixturePath('missing', {
    nativeRealpath: () => { throw missing; },
    realpath: () => assert.fail('a missing fixture must remain a failure'),
  }), (error) => error === missing);
  assert.throws(() => canonicalFixturePath('missing', {
    nativeRealpath: () => { throw Object.assign(new Error('native unavailable'), { code: 'EPERM' }); },
    realpath: () => { throw missing; },
  }), (error) => error === missing);
});
