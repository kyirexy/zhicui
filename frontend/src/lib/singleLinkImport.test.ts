import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHomeLinkDestination,
  buildBilibiliEmbedUrl,
  buildVideoDetailHref,
  normalizeSingleLinkSubmission,
  resolveHomeLinkDestination,
  shouldOpenExtractedVideo,
} from './singleLinkImport.ts';

test('routes a Douyin creator profile to the creator workspace', () => {
  assert.deepEqual(
    resolveHomeLinkDestination('https://www.douyin.com/user/MS4wLjABAAAA-demo'),
    { kind: 'creator', platform: 'douyin', url: 'https://www.douyin.com/user/MS4wLjABAAAA-demo' },
  );
});

test('routes a Bilibili space link to the creator workspace', () => {
  assert.match(
    buildHomeLinkDestination('https://space.bilibili.com/123456'),
    /^\/library\/creators\?profile=.*&platform=bilibili$/,
  );
});

test('routes a Xiaohongshu profile to the creator workspace', () => {
  assert.equal(
    resolveHomeLinkDestination('https://www.xiaohongshu.com/user/profile/abc').platform,
    'xiaohongshu',
  );
});

test('routes a single video link to single-link extraction', () => {
  assert.equal(
    buildHomeLinkDestination('https://www.douyin.com/video/7672579366093622537'),
    '/extract?url=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F7672579366093622537',
  );
});

test('uses creator wording to route a short profile share link', () => {
  assert.deepEqual(
    resolveHomeLinkDestination('复制博主主页 https://v.douyin.com/creator-demo/'),
    { kind: 'creator', platform: 'douyin', url: 'https://v.douyin.com/creator-demo/' },
  );
});

test('submits a plain video URL without changing it', () => {
  const url = 'https://www.douyin.com/video/7672579366093622537?from=copy';
  assert.equal(normalizeSingleLinkSubmission(`  ${url}  `), url);
});

test('extracts the first URL from a complete Douyin share message', () => {
  assert.equal(
    normalizeSingleLinkSubmission('3.81 复制打开抖音，看看【作者的作品】 https://v.douyin.com/AbCdEf12/ 复制此链接'),
    'https://v.douyin.com/AbCdEf12/',
  );
});

test('removes share punctuation immediately after the URL', () => {
  assert.equal(
    normalizeSingleLinkSubmission('作品链接：https://v.douyin.com/AbCdEf12/，'),
    'https://v.douyin.com/AbCdEf12/',
  );
});

test('uses the first URL when a share message contains more than one', () => {
  assert.equal(
    normalizeSingleLinkSubmission('先看 https://v.douyin.com/first/ 再看 https://v.douyin.com/second/'),
    'https://v.douyin.com/first/',
  );
});

test('prefers the supported video URL when unrelated links appear first', () => {
  assert.equal(
    normalizeSingleLinkSubmission('帮助页 https://example.com/help 作品 https://v.douyin.com/AbCdEf12/'),
    'https://v.douyin.com/AbCdEf12/',
  );
});

test('preserves non-URL input for the backend friendly validation response', () => {
  assert.equal(normalizeSingleLinkSubmission('  这是一段没有链接的分享文案  '), '这是一段没有链接的分享文案');
});

test('builds an encoded video detail route from the saved note id', () => {
  assert.equal(buildVideoDetailHref(' note / 42 '), '/library/detail?note=note%20%2F%2042');
});

test('does not navigate for a stale result that was not started on this page', () => {
  assert.equal(shouldOpenExtractedVideo({ armed: false, observedLoading: true, isLoading: false, noteId: 'old-note' }), false);
});

test('does not navigate before this page has observed the loading state', () => {
  assert.equal(shouldOpenExtractedVideo({ armed: true, observedLoading: false, isLoading: false, noteId: 'old-note' }), false);
});

test('navigates only after the armed task completes with a note id', () => {
  assert.equal(shouldOpenExtractedVideo({ armed: true, observedLoading: true, isLoading: false, noteId: 'new-note' }), true);
});

test('builds only allowlisted official Bilibili player URLs', () => {
  assert.equal(buildBilibiliEmbedUrl('not-a-bvid'), null);
  assert.match(buildBilibiliEmbedUrl('BV1Qruu6BENb') || '', /^https:\/\/player\.bilibili\.com\/player\.html\?/);
});
