import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { resolveClientAuthPolicy } from './clientAuthPolicy.ts';

type Tree = { type: unknown; props: Record<string, unknown> };
type Runtime = {
  pathname: string;
  resolved: boolean;
  desktop: boolean;
  nativeMobile: boolean;
  loading: boolean;
  user: { id: string } | null;
  error: string | null;
};
type EffectSlot = { deps: unknown[]; cleanup?: () => void };

// 保留依赖组件的真实类型边界，只替换其内部渲染；测试真正执行 AuthGuard/HomePage。
const Landing = () => null;
const DesktopHome = () => null;
const MobileHome = () => null;
const ProtectedChild = () => null;
const protectedChild: Tree = { type: ProtectedChild, props: {} };
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function harness(componentPath: string, overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = {
    pathname: '/', resolved: false, desktop: false, nativeMobile: false,
    loading: true, user: null, error: null, ...overrides,
  };
  const slots: unknown[] = [];
  let cursor = 0;
  let pendingEffects: (() => void)[] = [];
  const redirects: string[] = [];
  const router = { replace: (href: string) => { redirects.push(href); } };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: unknown) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as EffectSlot | undefined;
      if (previous && deps.length === previous.deps.length
        && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = setup();
        slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };
  const jsx = (type: unknown, props: Tree['props']): Tree => ({ type, props });
  const exports: { default?: (props: Record<string, unknown>) => Tree } = {};
  const javascript = ts.transpileModule(read(componentPath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(javascript, {
    exports,
    process: { env: { NODE_ENV: 'production' } },
    window: { location: { search: '', hash: '' } },
    URLSearchParams,
    require(name: string) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { Fragment: 'fragment', jsx, jsxs: jsx };
      if (name === 'next/image') return 'next-image';
      if (name === 'next/navigation') return { useRouter: () => router, usePathname: () => runtime.pathname };
      if (name === '@/lib/hooks/AuthContext') return { useAuth: () => ({
        user: runtime.user, loading: runtime.loading, error: runtime.error,
      }) };
      if (name === '@/components/DesktopAppFrame') return { useDesktopApp: () => ({
        isDesktop: runtime.desktop, resolved: runtime.resolved,
      }) };
      if (name === '@/lib/douyinNative') return { isNativeMobileApp: () => runtime.nativeMobile };
      if (name === '@/lib/clientAuthPolicy') return { resolveClientAuthPolicy };
      if (name === '@/components/WebLandingPage') return Landing;
      if (name === '@/components/DesktopWorkspaceHome') return DesktopHome;
      if (name === '@/components/WorkspaceActionHome') return MobileHome;
      throw new Error(`Unexpected test import: ${name}`);
    },
  });
  return {
    runtime, redirects,
    render(props: Record<string, unknown> = {}) {
      cursor = 0;
      pendingEffects = [];
      // 故意不执行 Effect：相当于服务器/首次客户端渲染，不能靠挂载后的更新通过测试。
      return exports.default!(props);
    },
    flushEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      for (const effect of effects) effect();
    },
  };
}

function hasType(value: unknown, type: unknown): boolean {
  if (Array.isArray(value)) return value.some((child) => hasType(child, type));
  if (!value || typeof value !== 'object') return false;
  const tree = value as Tree;
  return tree.type === type || hasType(tree.props?.children, type);
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!value || typeof value !== 'object') return '';
  return textContent((value as Tree).props?.children);
}

test('运行时尚未就绪：首页在首次渲染放行公开内容，不显示启动客户端文案', () => {
  const guard = harness('../components/AuthGuard.tsx');
  const home = harness('../app/page.tsx');
  const first = guard.render({ children: home.render() });
  assert.equal(hasType(first, Landing), true);
  assert.equal(hasType(first, DesktopHome), false);
  assert.equal(hasType(first, MobileHome), false);
  assert.doesNotMatch(textContent(first), /正在启动客户端/);
  assert.deepEqual(guard.redirects, []);
});

test('运行时尚未就绪：非首页保持中性占位，不泄露任何 children', () => {
  for (const pathname of ['/admin', '/notes', '/library/detail', '/login']) {
    const guard = harness('../components/AuthGuard.tsx', { pathname, loading: false, user: { id: 'cached' } });
    const first = guard.render({ children: protectedChild });
    assert.equal(hasType(first, ProtectedChild), false, pathname);
    assert.equal(textContent(first).trim(), '', pathname);
    guard.flushEffects();
    assert.deepEqual(guard.redirects, [], pathname);
  }
});

for (const client of ['desktop', 'nativeMobile'] as const) {
  test(`${client} 首页已识别但未登录：仍阻止工作台并跳转登录`, () => {
    const guard = harness('../components/AuthGuard.tsx', { resolved: true, [client]: true, loading: false });
    const first = guard.render({ children: protectedChild });
    assert.equal(hasType(first, ProtectedChild), false);
    guard.flushEffects();
    assert.deepEqual(guard.redirects, ['/login?redirect=%2F']);
  });

  test(`${client} 首页还在恢复账号时不提前放行，恢复完成才展示工作台`, () => {
    const guard = harness('../components/AuthGuard.tsx', { resolved: true, [client]: true, user: { id: 'cached' } });
    assert.equal(hasType(guard.render({ children: protectedChild }), ProtectedChild), false);
    guard.flushEffects();
    assert.deepEqual(guard.redirects, []);
    guard.runtime.loading = false;
    assert.equal(hasType(guard.render({ children: protectedChild }), ProtectedChild), true);
  });
}

test('desktopResolved 单独变为 true 时，受保护首页的登录重定向 Effect 会重新执行', () => {
  const guard = harness('../components/AuthGuard.tsx', { desktop: true, loading: false });
  guard.render({ children: protectedChild });
  guard.flushEffects();
  assert.deepEqual(guard.redirects, []);
  guard.runtime.resolved = true;
  assert.equal(hasType(guard.render({ children: protectedChild }), ProtectedChild), false);
  guard.flushEffects();
  assert.deepEqual(guard.redirects, ['/login?redirect=%2F']);
});

test('普通 Web 首页不等待账号恢复，也不会误跳客户端或登录页', () => {
  const guard = harness('../components/AuthGuard.tsx', { resolved: true });
  assert.equal(hasType(guard.render({ children: { type: Landing, props: {} } }), Landing), true);
  guard.flushEffects();
  assert.deepEqual(guard.redirects, []);
});

test('普通 Web 的客户端专属路由仍然隐藏内容并前往下载入口', () => {
  const guard = harness('../components/AuthGuard.tsx', { pathname: '/library', loading: false, user: { id: 'signed-in' } });
  assert.equal(hasType(guard.render({ children: protectedChild }), ProtectedChild), false);
  guard.flushEffects();
  assert.deepEqual(guard.redirects, []);
  guard.runtime.resolved = true;
  assert.equal(hasType(guard.render({ children: protectedChild }), ProtectedChild), false);
  guard.flushEffects();
  assert.deepEqual(guard.redirects, ['/#download']);
});

test('HomePage 无需 Effect 即渲染真实公开首屏，确认 Web 后保留 wrapper 与 Landing 类型', () => {
  const home = harness('../app/page.tsx');
  const first = home.render();
  assert.equal(hasType(first, Landing), true);
  assert.match(String(first.props.className), /\bbrowser-home-bootstrap\b/);
  assert.equal(hasType(first, DesktopHome), false);
  assert.equal(hasType(first, MobileHome), false);
  home.flushEffects();
  home.runtime.resolved = true;
  const confirmed = home.render();
  assert.equal(confirmed.type, first.type);
  assert.equal(hasType(confirmed, Landing), true);
  assert.doesNotMatch(String(confirmed.props.className), /\bbrowser-home-bootstrap\b/);
});

for (const client of ['desktop', 'nativeMobile'] as const) {
  test(`HomePage ${client} 工作台只在原生和桌面运行时都确认后呈现`, () => {
    const home = harness('../app/page.tsx', { [client]: true });
    const first = home.render();
    assert.equal(hasType(first, Landing), true);
    assert.equal(hasType(first, DesktopHome), false);
    assert.equal(hasType(first, MobileHome), false);
    home.flushEffects();
    const unresolved = home.render();
    assert.equal(hasType(unresolved, DesktopHome), false);
    assert.equal(hasType(unresolved, MobileHome), false);
    home.runtime.resolved = true;
    const confirmed = home.render();
    assert.equal(hasType(confirmed, Landing), false);
    assert.equal(hasType(confirmed, client === 'desktop' ? DesktopHome : MobileHome), true);
  });
}

test('预识别的原生和桌面端通过 CSS 隐藏临时官网内容，普通 Web 不被隐藏', () => {
  const css = read('../app/globals.css');
  for (const selector of [
    'html[data-capacitor="true"] .browser-home-bootstrap',
    'html[data-desktop-app="pending"] .browser-home-bootstrap',
    'html[data-desktop-app="true"] .browser-home-bootstrap',
  ]) assert.ok(css.includes(selector), selector);
  const rule = css.match(/[^{}]*\.browser-home-bootstrap[^{}]*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /display:\s*none/);
  assert.doesNotMatch(css, /(?:^|\})\s*\.browser-home-bootstrap\s*\{[^}]*display:\s*none/m);
  assert.doesNotMatch(read('../components/AuthGuard.tsx'), /正在启动客户端/);
});
