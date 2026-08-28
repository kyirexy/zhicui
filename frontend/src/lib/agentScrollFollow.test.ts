import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAgentScrollFollow } from './agentScrollFollow.ts';

test('正文增高不会被误判成读者上滑', () => {
  assert.deepEqual(resolveAgentScrollFollow({
    clientHeight: 400,
    following: true,
    observedScrollTop: 400,
    scrollHeight: 900,
    scrollTop: 400,
  }), {
    distanceFromBottom: 100,
    floor: 500,
    following: true,
    movedByReader: false,
    showBackToBottom: false,
  });
});

test('读者主动上滑会释放跟随并显示回到底部按钮', () => {
  const state = resolveAgentScrollFollow({
    clientHeight: 400,
    following: true,
    observedScrollTop: 500,
    scrollHeight: 900,
    scrollTop: 260,
  });

  assert.equal(state.movedByReader, true);
  assert.equal(state.following, false);
  assert.equal(state.showBackToBottom, true);
});

test('读者回到底部后重新取得自动跟随', () => {
  const state = resolveAgentScrollFollow({
    clientHeight: 400,
    following: false,
    observedScrollTop: 260,
    scrollHeight: 900,
    scrollTop: 500,
  });

  assert.equal(state.movedByReader, true);
  assert.equal(state.distanceFromBottom, 0);
  assert.equal(state.following, true);
  assert.equal(state.showBackToBottom, false);
});
