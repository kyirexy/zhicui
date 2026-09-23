import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as outcome from './libraryExtractionOutcome.ts';

const require = createRequire(import.meta.url);
const exports: { default?: React.ComponentType<Record<string, unknown>> } = {};
const source = readFileSync(new URL('../components/LibraryVideoCard.tsx', import.meta.url), 'utf8');
runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText, {
  exports,
  require(name: string) {
    if (name === '@/lib/libraryExtractionOutcome') return outcome;
    if (name === 'next/link') return ({ children, ...props }: Record<string, unknown>) => createElement('a', props, children as React.ReactNode);
    if (name === '@/components/LibraryCoverImage' || name === '@/components/PlatformBrandIcon') return () => null;
    return require(name);
  },
});

function render(extra: Record<string, unknown> = {}, state = 'error') {
  return renderToStaticMarkup(createElement(exports.default!, {
    item: { aweme_id: 'one', title: '样例视频', transcript_chars: 0, can_extract: true, ...extra },
    selected: false, extractState: state,
    extractError: '404 Client Error: Not Found for url: http://127.0.0.1:9000/private',
    onToggle: () => {}, onRetryExtraction: () => {},
  }));
}

test('实时无音频与刷新后的持久无音频都只显示中性标签、不出现错误或重试按钮', () => {
  for (const html of [render({}, 'no_audio'), render({ transcript_status: 'no_audio', can_extract: false })]) {
    assert.match(html, />无音频</);
    assert.match(html, /data-extract-state="no_audio"/);
    assert.doesNotMatch(html, /role="alert"|has-extract-error|is-error|重试|404|127\.0\.0\.1/);
  }
});

test('真实网络失败保留重试能力，正文、title 与 aria 都不暴露底层错误', () => {
  const html = render();
  assert.match(html, /资源暂不可用，请稍后重试/);
  assert.match(html, />重试</);
  assert.doesNotMatch(html, /404|127\.0\.0\.1|Client Error|无音频/);
});
