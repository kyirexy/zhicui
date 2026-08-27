import assert from 'node:assert/strict';
import {
  boundedPlatformUrls,
  hasPlatformAuthCookie,
} from '../dist/platform-account.js';
import {
  validatePlatformAccountCollectRequest,
  validatePlatformAccountRequest,
} from '../dist/security.js';

assert.deepEqual(
  validatePlatformAccountRequest({
    platform: 'bilibili',
    profileKey: 'user_123-safe',
  }),
  { platform: 'bilibili', profileKey: 'user_123-safe' },
);

assert.throws(
  () => validatePlatformAccountRequest({
    platform: 'bilibili',
    profileKey: '../escape',
  }),
  /会话标识无效/,
);

assert.deepEqual(
  validatePlatformAccountCollectRequest({
    platform: 'douyin',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 100,
  }),
  {
    platform: 'douyin',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 100,
  },
);

assert.throws(
  () => validatePlatformAccountCollectRequest({
    platform: 'bilibili',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 20,
  }),
  /不支持同步自己的作品/,
);

assert.throws(
  () => validatePlatformAccountCollectRequest({
    platform: 'xiaohongshu',
    profileKey: 'user_123-safe',
    mode: 'collect',
    limit: 101,
  }),
  /1–100/,
);

assert.equal(
  hasPlatformAuthCookie('bilibili', [
    { name: 'SESSDATA', value: 'secret', domain: '.bilibili.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('bilibili', [
    { name: 'SESSDATA', value: 'secret', domain: '.example.com' },
  ]),
  false,
);
assert.equal(
  hasPlatformAuthCookie('xiaohongshu', [
    { name: 'web_session', value: 'secret', domain: '.xiaohongshu.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('douyin', [
    { name: 'sessionid_ss', value: 'secret', domain: '.douyin.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('douyin', [
    { name: 'sessionid_ss', value: 'secret', domain: '.example.com' },
  ]),
  false,
);

assert.deepEqual(
  boundedPlatformUrls('bilibili', [
    'https://www.bilibili.com/video/BV1abc123?spm_id_from=333',
    'https://www.bilibili.com/video/BV1abc123',
    'https://example.com/video/BV1bad',
    'https://www.bilibili.com/video/BV2def456',
  ], 10),
  [
    'https://www.bilibili.com/video/BV1abc123',
    'https://www.bilibili.com/video/BV2def456',
  ],
);

assert.deepEqual(
  boundedPlatformUrls('xiaohongshu', [
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=token&foo=drop',
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=token',
    'https://www.xiaohongshu.com/explore/def456?xsec_source=pc_user',
  ], 1),
  ['https://www.xiaohongshu.com/explore/abc123?xsec_token=token'],
);

assert.deepEqual(
  boundedPlatformUrls('douyin', [
    'https://www.douyin.com/video/7672579366093622537?from_tab_name=main',
    'https://www.douyin.com/video/7672579366093622537',
    'https://example.com/video/123456789',
    'https://www.douyin.com/user/example',
    'https://www.douyin.com/video/7672579366093622538',
  ], 100),
  [
    'https://www.douyin.com/video/7672579366093622537',
    'https://www.douyin.com/video/7672579366093622538',
  ],
);

console.log('platform-account verification passed');
