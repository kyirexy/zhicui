import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createPhoneClaimSecret, parsePhoneLoginQr } from './phoneLogin.ts';

const url = `https://luxai.cn/login#phone-login=pls-${'a'.repeat(32)}.${'b'.repeat(43)}`;
test('手机登录码严格限制来源、路径、凭据种类和长度', () => {
  assert.ok(parsePhoneLoginQr(url));
  for (const invalid of [url.replace('luxai.cn', 'evil.example'), url.replace('/login#', '/login?x=1#'),
    url.replace('phone-login', 'desktop-login'), url.replace('pls-', 'dls-'), url + '.extra', url.slice(0, -1),
    url.replace('https://', 'https://name@')]) assert.equal(parsePhoneLoginQr(invalid), null);
});
test('手机独立生成不可预测的领取凭据', () => {
  const first = createPhoneClaimSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, createPhoneClaimSecret());
});
test('手机登录入口和电脑授权不反向，不保存领取密钥', () => {
  const phone = readFileSync(new URL('../components/PhoneQrLogin.tsx', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../components/DesktopPhoneLoginCard.tsx', import.meta.url), 'utf8');
  assert.match(phone, /label="扫码登录"/);
  assert.match(desktop, /确认登录这台手机/);
  assert.doesNotMatch(phone, /localStorage|sessionStorage|createPortal/);
  assert.match(phone, /controller\.abort\(\)/);
  assert.match(desktop, /decision: 'cancel'/);
});
test('帮助邮箱和普通用户管理入口保持正确', () => {
  const support = readFileSync(new URL('../app/support/page.tsx', import.meta.url), 'utf8');
  const header = readFileSync(new URL('../components/AppHeader.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../app/admin/[section]/page.tsx', import.meta.url), 'utf8');
  assert.match(support, /mailto:1592880030@qq\.com/);
  assert.doesNotMatch(support, /support@luxai\.cn/);
  assert.match(header, /user\.is_admin &&/);
  assert.match(admin, /if \(!user\.is_admin\)/);
});

test('扫码关闭立即通知取消，成功的内部关闭不触发取消', () => {
  const scanner = readFileSync(new URL('../components/MobileDesktopLoginScanner.tsx', import.meta.url), 'utf8');
  const close = scanner.slice(scanner.indexOf('const closeOverlay ='), scanner.indexOf('const showFailure ='));
  assert.ok(close.indexOf('if (notifyDismiss) onDismiss?.()') < close.indexOf('await stopScanner()'));
  assert.match(scanner, /await onPhoneLoginScan\(phoneReference\);[\s\S]*?await closeOverlay\(false\)/);
});

// 沿用 node:test；轻量 Hook 驱动真实组件，不引入浏览器或新的测试框架。
function phoneHarness() {
  type Tree = { type: unknown; props: Record<string, any> };
  const slots: any[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0;
  const requests: { signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  const accepted: unknown[] = [];
  const scannerType = () => null;
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useCallback(callback: unknown) { cursor++; return callback; },
    useEffect(setup: () => (() => void) | undefined, deps: unknown[]) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { deps, cleanup: setup() };
      });
    },
  };
  const moduleExports: { default?: (props: unknown) => Tree } = {};
  const source = readFileSync(new URL('../components/PhoneQrLogin.tsx', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(javascript, {
    exports: moduleExports,
    AbortController,
    setTimeout(callback: () => Promise<void>) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    require(name: string) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return {
        Fragment: 'fragment', jsx: (type: unknown, props: Tree['props']) => ({ type, props }),
        jsxs: (type: unknown, props: Tree['props']) => ({ type, props }),
      };
      if (name === '@capacitor/core') return { Capacitor: { getPlatform: () => 'android' } };
      if (name === './MobileDesktopLoginScanner') return scannerType;
      if (name.endsWith('.css')) return {};
      if (name === '@/lib/phoneLogin') return {
        createPhoneClaimSecret: () => 'local-secret', phoneLoginStatusText: () => '状态错误',
        phoneLoginRequest: (_suffix: string, _body: unknown, _auth: boolean, signal: AbortSignal) =>
          new Promise((resolve) => { requests.push({ signal, resolve }); }),
      };
      throw new Error(`Unexpected test import: ${name}`);
    },
  });
  const onSession = (value: unknown) => { accepted.push(value); };
  const render = () => {
    cursor = 0; effects = [];
    const tree = moduleExports.default!({ onSession });
    for (const effect of effects) effect();
    return tree;
  };
  const find = (tree: any, type: unknown): Tree | undefined => {
    if (!tree || typeof tree !== 'object') return;
    if (tree.type === type) return tree;
    for (const child of [tree.props?.children].flat()) {
      const found = find(child, type);
      if (found) return found;
    }
  };
  return {
    render, requests, accepted,
    scanner: (tree: Tree) => find(tree, scannerType)!,
    cancelButton: (tree: Tree) => find(tree, 'button')!,
    poll: () => {
      const entry = timers.entries().next().value;
      assert.ok(entry);
      timers.delete(entry[0]);
      return entry[1]();
    },
  };
}

const scanned = {
  status: 'scanned', session_id: 'phone-test', verification_code: '123456',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

test('关闭相机后迟到 claim 不会重新打开确认流程', async () => {
  const app = phoneHarness();
  const scanner = app.scanner(app.render());
  const claim = scanner.props.onPhoneLoginScan({ sessionId: 'phone-test', scanSecret: 'scan-secret' });
  scanner.props.onDismiss();
  assert.equal(app.requests[0].signal.aborted, true);
  // 模拟已经到达客户端、不再服从 abort 的迟到结果。
  app.requests[0].resolve(scanned);
  await claim;
  assert.ok(app.scanner(app.render()));
  assert.equal(app.accepted.length, 0);
});

test('返回账号登录后迟到 token 不会自动登录', async () => {
  const app = phoneHarness();
  const claim = app.scanner(app.render()).props.onPhoneLoginScan({ sessionId: 'phone-test', scanSecret: 'scan-secret' });
  app.requests[0].resolve(scanned);
  await claim;
  const waiting = app.render();
  const poll = app.poll();
  app.cancelButton(waiting).props.onClick();
  assert.equal(app.requests[1].signal.aborted, true);
  app.requests[1].resolve({ status: 'success', token: 'late-token', user: { id: 'test' } });
  await poll;
  assert.equal(app.accepted.length, 0);
  assert.ok(app.scanner(app.render()));
});

test('未取消的扫码仍然在电脑确认后接受一次登录会话', async () => {
  const app = phoneHarness();
  const claim = app.scanner(app.render()).props.onPhoneLoginScan({ sessionId: 'phone-test', scanSecret: 'scan-secret' });
  app.requests[0].resolve(scanned);
  await claim;
  app.render();
  const poll = app.poll();
  app.requests[1].resolve({ status: 'success', token: 'accepted-token', user: { id: 'test' } });
  await poll;
  assert.equal(app.accepted.length, 1);
});
