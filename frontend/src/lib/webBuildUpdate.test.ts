import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDifferentWebBuild,
  parseWebBuildManifest,
  type WebBuildManifest,
} from './webBuildManifest.ts';

const CURRENT: WebBuildManifest = {
  schema_version: 1,
  build_id: 'abc123def456-20260826120000',
  revision: 'abc123def456',
  version: '1.1.9',
  built_at: '2026-08-26T12:00:00.000Z',
};

test('accepts a valid cache-resistant web build marker', () => {
  assert.deepEqual(parseWebBuildManifest(CURRENT), CURRENT);
});

test('rejects malformed markers instead of prompting a refresh', () => {
  assert.throws(
    () => parseWebBuildManifest({ ...CURRENT, build_id: '<script>' }),
    /格式无效/,
  );
  assert.throws(
    () => parseWebBuildManifest({ ...CURRENT, built_at: 'not-a-date' }),
    /格式无效/,
  );
});

test('only a new build id is treated as a web update', () => {
  assert.equal(isDifferentWebBuild(CURRENT, { ...CURRENT }), false);
  assert.equal(
    isDifferentWebBuild(CURRENT, {
      ...CURRENT,
      build_id: 'abc123def456-20260826120100',
    }),
    true,
  );
});
