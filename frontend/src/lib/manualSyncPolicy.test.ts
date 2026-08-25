import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  MANUAL_SYNC_ONLY,
  normalizeDisabledAutoSyncInterval,
} from './manualSyncPolicy.ts';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(currentDir, '..');

test('历史及未来的自动同步周期都迁移为关闭', () => {
  assert.equal(MANUAL_SYNC_ONLY, true);
  for (const value of [undefined, null, 0, 15, 30, 60, 360, 1440, '30']) {
    assert.equal(normalizeDisabledAutoSyncInterval(value), 0);
  }
});

test('全局 Provider 不再挂载自动同步调度器', () => {
  const providers = readFileSync(path.join(sourceRoot, 'app', 'Providers.tsx'), 'utf8');
  assert.doesNotMatch(providers, /LibraryAutoSyncScheduler/);
  assert.equal(
    existsSync(path.join(sourceRoot, 'components', 'LibraryAutoSyncScheduler.tsx')),
    false,
  );
});

test('设置页不再提供自动同步周期控件', () => {
  const card = readFileSync(
    path.join(sourceRoot, 'components', 'AutoSyncSettingsCard.tsx'),
    'utf8',
  );
  assert.match(card, /仅手动同步/);
  assert.doesNotMatch(card, /多久检查一次|自定义周期|runLibraryAutoSync/);
});
