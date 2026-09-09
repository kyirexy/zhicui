import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../components/LibraryPreviewPane.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function platformLabel('), source.indexOf('export default function LibraryPreviewPane'));
const code = ts.transpileModule(`${helpers}\nexports.normalize = normalizeSelection;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const context = { exports: {} as { normalize: (selection: unknown) => { date: string; dateLabel: string } } };
vm.runInNewContext(code, context);

test('抖音预览明确区分发布时间和记录时间，仍优先使用原日期字段', () => {
  const item = { date: '2025-10-28', recorded_at: '2026-09-09T08:00:00Z' };
  const published = context.exports.normalize({ kind: 'douyin', item });
  assert.equal(published.date, '2025-10-28');
  assert.equal(published.dateLabel, '发布于');
  const recorded = context.exports.normalize({ kind: 'douyin', item: { ...item, date: '' } });
  assert.equal(recorded.date, item.recorded_at);
  assert.equal(recorded.dateLabel, '记录于');
});

test('跨平台预览保留发布日期优先，缺失时才显示原导入日期及其含义', () => {
  const item = { published_at: '2025-10-28', imported_at: '2026-09-09T08:00:00Z' };
  const published = context.exports.normalize({ kind: 'platform', item });
  assert.equal(published.date, item.published_at);
  assert.equal(published.dateLabel, '发布于');
  const imported = context.exports.normalize({ kind: 'platform', item: { ...item, published_at: '' } });
  assert.equal(imported.date, item.imported_at);
  assert.equal(imported.dateLabel, '导入于');
});
