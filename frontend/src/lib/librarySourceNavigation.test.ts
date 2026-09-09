import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
const switchSource = page.slice(page.indexOf('  const switchDouyinSource ='), page.indexOf('  const switchBiliSource ='));
const switchCode = ts.transpileModule(`${switchSource}\nexports.switchSource = switchDouyinSource;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const restoreSource = page.slice(page.indexOf('    const syncPlatformFromLocation ='), page.indexOf('    syncPlatformFromLocation();'));
const restoreCode = ts.transpileModule(`${restoreSource}\nexports.restoreSource = syncPlatformFromLocation;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('首页收藏入口切换喜欢后URL同步，刷新恢复所选分类且保留其他参数与历史状态', () => {
  const historyState = { previousEntry: 'home' };
  let storedMode = 'collect';
  const historyWrites: string[] = [];
  const context = {
    exports: {} as { switchSource: (mode: string) => void; restoreSource: () => void },
    URL,
    window: {
      location: { href: 'https://luxai.cn/library?platform=douyin&mode=collect&keep=1#videos' },
      history: { state: historyState, replaceState: (state: unknown, _title: string, path: string) => {
        assert.equal(state, historyState);
        historyWrites.push(path);
        context.window.location.href = new URL(path, context.window.location.href).href;
      } },
    },
    batchExtractingRef: { current: false }, sourceModeRef: { current: 'collect' },
    setSourceMode: (mode: string) => { storedMode = mode; }, setSelected: () => {}, setPreviewTarget: () => {}, setSortMenuOpen: () => {}, setNotice: () => {},
    setPlatformFilter: () => {}, setBiliSourceMode: () => {}, setPlatformActionErrors: () => {},
    isDouyinSourceMode: (mode: string) => ['like', 'collect', 'post'].includes(mode),
    SOURCE_MODES: [{ value: 'collect', label: '收藏' }, { value: 'like', label: '喜欢' }],
  };
  vm.runInNewContext(switchCode + restoreCode, context);
  context.exports.switchSource('like');
  assert.equal(storedMode, 'like');
  assert.equal(context.sourceModeRef.current, 'like');
  assert.deepEqual(historyWrites, ['/library?platform=douyin&mode=like&keep=1#videos']);
  storedMode = 'collect';
  context.exports.restoreSource();
  assert.equal(storedMode, 'like');
  context.exports.switchSource('like');
  assert.equal(historyWrites.length, 1);
  context.batchExtractingRef.current = true;
  context.exports.switchSource('collect');
  assert.equal(historyWrites.length, 1);
});
