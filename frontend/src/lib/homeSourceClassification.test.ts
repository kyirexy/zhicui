import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHomeSourceModes,
  firstPopulatedHomeMode,
} from './homeSourceClassification.ts';

test('首页不会把未知来源或普通导入伪装成抖音作品', () => {
  assert.deepEqual(classifyHomeSourceModes('douyin', 'unknown'), []);
  assert.deepEqual(classifyHomeSourceModes('douyin', 'import'), []);
  assert.deepEqual(classifyHomeSourceModes('douyin', 'post'), ['post']);
});

test('B站第三类只接收明确的导入来源', () => {
  assert.deepEqual(classifyHomeSourceModes('bilibili', 'post'), []);
  assert.deepEqual(classifyHomeSourceModes('bilibili', 'import'), ['import']);
  assert.deepEqual(
    classifyHomeSourceModes('bilibili', 'collect', ['like', 'collect']),
    ['like', 'collect'],
  );
});

test('喜欢优先，无内容时默认喜欢，只有其他来源时展示实际存在的分类', () => {
  assert.equal(firstPopulatedHomeMode('douyin', {
    collect: 0,
    like: 0,
    post: 0,
  }), 'like');
  assert.equal(firstPopulatedHomeMode('bilibili', { collect: 49, like: 20 }), 'like');
  assert.equal(firstPopulatedHomeMode('douyin', {
    collect: 0,
    like: 7,
    post: 9,
  }), 'like');
  assert.equal(firstPopulatedHomeMode('bilibili', {
    collect: 0,
    like: 0,
    import: 4,
  }), 'import');
});
