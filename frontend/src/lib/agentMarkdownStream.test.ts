import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { parseMarkdownIntoBlocks } from 'streamdown';
import {
  AgentMarkdownStreamBuffer,
  type AgentMarkdownStreamSnapshot,
} from './agentMarkdownStream.ts';

function reconstructed(snapshot: AgentMarkdownStreamSnapshot): string {
  return `${snapshot.stableChunks.join('')}${snapshot.tail}`;
}

function separatelyRenderedBlocks(snapshot: AgentMarkdownStreamSnapshot): string[] {
  return [
    ...snapshot.stableChunks.flatMap((chunk) => parseMarkdownIntoBlocks(chunk)),
    ...parseMarkdownIntoBlocks(snapshot.tail),
  ];
}

function feedAndVerify(markdown: string): AgentMarkdownStreamSnapshot {
  const buffer = new AgentMarkdownStreamBuffer();
  let snapshot = buffer.snapshot();
  let delivered = '';

  for (const character of markdown) {
    delivered += character;
    snapshot = buffer.append(character);
    assert.equal(reconstructed(snapshot), delivered);
    assert.deepEqual(
      separatelyRenderedBlocks(snapshot),
      parseMarkdownIntoBlocks(delivered),
    );
  }
  return snapshot;
}

test('稳定前缀对 fenced code 与表格保持完整解析一致', () => {
  const markdown = [
    '# 示例',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '| 机制 | 作用 |',
    '| --- | --- |',
    '| 升级 | 提高效率 |',
    '',
    '表格后的结论。',
  ].join('\n');

  const snapshot = feedAndVerify(markdown);
  assert.ok(snapshot.stableChunks.length > 0);
});

test('未闭合粗体和链接始终留在活动尾部', () => {
  const bold = feedAndVerify('已完成段落。\n\n下一段 **仍在生成');
  assert.match(bold.tail, /\*\*仍在生成$/);

  const link = feedAndVerify(
    '已完成段落。\n\n参考 [官方说明](https://example.com/docs',
  );
  assert.match(link.tail, /\[官方说明\]\(https:\/\/example\.com\/docs$/);
});

test('普通字符帧不解析 Markdown 且复用稳定块引用', () => {
  let parseCalls = 0;
  const buffer = new AgentMarkdownStreamBuffer('', (markdown) => {
    parseCalls += 1;
    return parseMarkdownIntoBlocks(markdown);
  });
  const before = buffer.snapshot();
  const after = buffer.append('连续中文不会触发解析');

  assert.equal(parseCalls, 0);
  assert.equal(after.stableChunks, before.stableChunks);
});

test('五万字中文流只解析可定稿尾部，避免随历史长度平方增长', () => {
  const paragraph = `${'持续学习让知识逐步沉淀。'.repeat(8)}\n\n`;
  const source = paragraph.repeat(Math.ceil(50_000 / paragraph.length));
  let parseCalls = 0;
  let parsedCharacters = 0;
  const buffer = new AgentMarkdownStreamBuffer('', (markdown) => {
    parseCalls += 1;
    parsedCharacters += markdown.length;
    return parseMarkdownIntoBlocks(markdown);
  });

  const startedAt = performance.now();
  for (let offset = 0; offset < source.length; offset += 3) {
    buffer.append(source.slice(offset, offset + 3));
  }
  const elapsedMs = performance.now() - startedAt;
  const snapshot = buffer.snapshot();

  assert.equal(reconstructed(snapshot), source);
  assert.ok(source.length >= 50_000);
  assert.ok(
    parsedCharacters < source.length * 6,
    `解析字符量 ${parsedCharacters} 不应随 ${source.length} 字历史平方增长`,
  );
  assert.ok(parseCalls < source.length / 10);
  assert.ok(elapsedMs < 1_500, `五万字增量处理耗时 ${elapsedMs.toFixed(1)}ms`);
});
