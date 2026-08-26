import assert from 'node:assert/strict';
import { nativeUpdateCheckDisposition } from '../dist/update-policy.js';

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: false,
    hasInFlightCheck: false,
    status: 'idle',
  }),
  'unsupported',
  'development must never contact the native update feed',
);

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: true,
    hasInFlightCheck: true,
    status: 'checking',
  }),
  'reuse',
  'concurrent checks must share the active operation',
);

for (const status of ['downloading', 'downloaded']) {
  assert.equal(
    nativeUpdateCheckDisposition({
      packaged: true,
      hasInFlightCheck: false,
      status,
    }),
    'hold',
    `status ${status} must not start another download`,
  );
}

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: true,
    hasInFlightCheck: false,
    status: 'current',
  }),
  'check',
);

console.log('desktop update policy verification passed');
