import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(
  path.join(root, 'frontend', 'package.json'),
);
const ts = require('typescript');
const sourcePath = path.join(
  root,
  'frontend',
  'src',
  'lib',
  'douyinSyncFeedback.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const runtimeModule = { exports: {} };
new Function('exports', 'module', compiled)(
  runtimeModule.exports,
  runtimeModule,
);
const { formatCollectionSyncMessage } = runtimeModule.exports;

function check(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\nexpected: ${expected}\nactual:   ${actual}`);
  }
  console.log(`PASS  ${label}`);
}

const base = {
  sourceLabel: '收藏',
  requestedCount: 50,
};

check(
  formatCollectionSyncMessage({
    ...base,
    status: 'running',
    total: 0,
    success: 0,
  }),
  '正在读取最近 50 条收藏，请稍候…',
  '未知总数不显示 0',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'running',
    total: 50,
    success: 12,
  }),
  '已找到 50 条收藏，正在同步 12/50',
  '已知总数显示真实进度',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'success',
    total: 50,
    success: 50,
  }),
  '已同步 50 条收藏，正在更新资料库…',
  '成功显示真实数量',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'success',
    total: 0,
    success: 0,
  }),
  '没有读取到收藏。请确认登录的是正确的抖音账号，或重新绑定后再试',
  '真实空结果给出账号建议',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'failed',
    error: '抖音会话已失效',
  }),
  '抖音会话已失效',
  '失败优先显示任务错误',
);
