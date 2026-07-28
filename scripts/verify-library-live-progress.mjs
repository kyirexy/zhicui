import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';

const sourcePath = path.resolve(
  'frontend/src/lib/libraryExtractionProgress.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;

const module = { exports: {} };
vm.runInNewContext(transpiled, {
  module,
  exports: module.exports,
  require: () => ({}),
});

const {
  getRecentCompletedResults,
  summarizeLibraryExtraction,
} = module.exports;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const items = [
  { aweme_id: 'a', title: '较早完成' },
  { aweme_id: 'b', title: '最新完成' },
  { aweme_id: 'c', title: '仍在转写' },
];
const job = {
  total: 3,
  success: 2,
  failed: 0,
  active: 1,
  queued: 0,
  items: [
    {
      aweme_id: 'a',
      state: 'done',
      transcript_chars: 1200,
      updated_at: '2026-07-28T10:00:00Z',
    },
    {
      aweme_id: 'b',
      state: 'done',
      transcript_chars: 800,
      updated_at: '2026-07-28T10:00:02Z',
    },
    {
      aweme_id: 'c',
      state: 'transcribing',
      transcript_chars: 0,
      updated_at: '2026-07-28T10:00:03Z',
    },
  ],
};

const summary = summarizeLibraryExtraction(job);
assert(summary.total === 3, 'total should stay stable');
assert(summary.completed === 2, 'completed count should be available before batch end');
assert(summary.active === 1, 'active count should remain visible');
assert(summary.percent === 67, 'progress should include only settled results');

const recent = getRecentCompletedResults(job, items, 4);
assert(recent.length === 2, 'only completed results should be returned');
assert(recent[0].item.aweme_id === 'b', 'newest completed result should appear first');
assert(recent[0].transcriptChars === 800, 'completed transcript metadata should be preserved');

console.log('library live progress checks passed');
