import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBilibiliEmbedUrl, buildVideoDetailHref, shouldOpenExtractedVideo } from './singleLinkImport.ts';

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
