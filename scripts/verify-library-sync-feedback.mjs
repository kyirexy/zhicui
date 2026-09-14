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
  '正在同步最近 50 条收藏…',
  '未知总数不显示 0',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'running',
    total: 50,
    success: 12,
  }),
  '收藏同步中 · 12/50',
  '已知总数显示真实进度',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'success',
    total: 50,
    success: 50,
  }),
  '收藏已同步 50 条',
  '成功显示真实数量',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'success',
    total: 0,
    success: 0,
  }),
  '还没有同步到收藏，请在抖音确认列表后重试。',
  '真实空结果给出账号建议',
);
check(
  formatCollectionSyncMessage({
    ...base,
    status: 'failed',
    error: '抖音会话已失效',
  }),
  '请重新登录抖音后同步收藏。',
  '失败优先显示任务错误',
);
