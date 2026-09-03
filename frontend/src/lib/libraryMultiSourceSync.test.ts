import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isQuickSyncModeReady,
  normalizeQuickSyncModes,
  toggleQuickSyncMode,
} from './libraryQuickSync.ts';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');

test('同步范围支持多选并按界面顺序稳定保存', () => {
  assert.deepEqual(toggleQuickSyncMode(['collect'], 'like'), ['like', 'collect']);
  assert.deepEqual(toggleQuickSyncMode(['like', 'collect'], 'post'), [
    'like',
    'collect',
    'post',
  ]);
  assert.deepEqual(toggleQuickSyncMode(['like', 'collect', 'post'], 'collect'), [
    'like',
    'post',
  ]);
  assert.deepEqual(toggleQuickSyncMode(['like'], 'like'), ['like']);
  assert.deepEqual(normalizeQuickSyncModes(['post', 'like', 'post', 'collect']), [
    'like',
    'collect',
    'post',
  ]);
});

test('旧版兼容链路按真实登录条件判断各来源', () => {
  const unavailable = {
    reported: true,
    like_ready: false,
    collection_ready: false,
  };
  assert.equal(isQuickSyncModeReady('like', unavailable), false);
  assert.equal(isQuickSyncModeReady('collect', unavailable), false);
  assert.equal(isQuickSyncModeReady('post', unavailable), false);

  const collectionUnavailable = {
    reported: true,
    like_ready: true,
    collection_ready: false,
  };
  assert.equal(isQuickSyncModeReady('like', collectionUnavailable), true);
  assert.equal(isQuickSyncModeReady('collect', collectionUnavailable), false);
  assert.equal(isQuickSyncModeReady('post', collectionUnavailable), true);
});

test('同步弹窗使用多选语义且逐项等待每个来源完成', () => {
  const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
  const sequentialSync = page.slice(
    page.indexOf('const syncCollection = async'),
    page.indexOf('const syncCollectionRef = useRef'),
  );
  assert.match(page, /role="group" aria-label="选择一个或多个要同步的抖音来源"/);
  assert.match(page, /aria-pressed=\{active\}/);
  assert.match(page, /可多选，系统会按卡片顺序逐项读取/);
  assert.match(page, /return readLibraryQuickSyncPreferences\(\)\.modes;/);
  assert.doesNotMatch(page, /readLibraryQuickSyncPreferences\(\)\.modes\[0\]/);
  assert.match(page, /每项 \$\{syncCount\} 条/);
  assert.match(page, /sourceSyncQueue\.current}\/\$\{sourceSyncQueue\.total}/);
  assert.doesNotMatch(page, /role="radiogroup" aria-label="选择一个要同步的抖音来源"/);
  assert.match(
    sequentialSync,
    /for \(const \[modeIndex, requestedMode\] of modes\.entries\(\)\) \{[\s\S]*?await collectOneSource\(requestedMode, requestedCount\)/,
  );
  assert.match(sequentialSync, /try \{[\s\S]*?await collectOneSource/);
  assert.match(sequentialSync, /if \(result\.queueMayStillBeRunning\) break;/);
  assert.match(sequentialSync, /normalizeQuickSyncModes\(/);
  assert.match(sequentialSync, /sourceReadability\.collect\.blockedUntil > Date\.now\(\)/);
  assert.doesNotMatch(sequentialSync, /Promise\.all/);
});

test('补齐待整理文案不会覆盖用户的多选偏好', () => {
  const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
  const pendingTranscriptFlow = page.slice(
    page.indexOf('const preparePendingTranscripts = async'),
    page.indexOf('const deleteExtraction = async'),
  );
  assert.match(pendingTranscriptFlow, /const savedPreferences = readLibraryQuickSyncPreferences\(\);/);
  assert.match(
    pendingTranscriptFlow,
    /syncCollectionRef\.current\([\s\S]*?\[sourceMode\],[\s\S]*?savedPreferences\.modes/,
  );
  assert.doesNotMatch(
    pendingTranscriptFlow,
    /syncCollectionRef\.current\([\s\S]*?\[sourceMode\],[\s\S]*?\[sourceMode\]/,
  );
});
