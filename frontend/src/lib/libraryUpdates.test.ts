import assert from 'node:assert/strict';
import test from 'node:test';
import { getLibraryRevision, isLibraryRevisionCurrent, LIBRARY_UPDATED_EVENT, notifyLibraryUpdated, subscribeLibraryUpdates } from './libraryUpdates.ts';

test('同步通知先清理首页旧快照，再通知订阅者，保留其他缓存', () => {
  const target = new EventTarget();
  const data: Record<string, string> = {
    'zhicui:workspace-home:v5:user-a': 'old',
    'zhicui:workspace-home:v6:user-a': 'old',
    'zhicui-library-list-v4:user-a:collect:collection': 'old',
    'zhicui-platform-library-list-v2:user-a': 'old',
    'unrelated-cache': 'keep',
  };
  const storage = Object.assign(data, { removeItem(key: string) { delete data[key]; } });
  let events = 0;
  target.addEventListener(LIBRARY_UPDATED_EVENT, () => {
    events += 1;
    assert.equal(data['zhicui:workspace-home:v6:user-a'], undefined);
    assert.equal(data['zhicui-library-list-v4:user-a:collect:collection'], undefined);
    assert.equal(data['zhicui-platform-library-list-v2:user-a'], undefined);
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: storage,
    dispatchEvent: target.dispatchEvent.bind(target),
  } });
  try {
    notifyLibraryUpdated();
    assert.equal(events, 1);
    assert.equal(data['zhicui:workspace-home:v5:user-a'], undefined);
    assert.equal(data['unrelated-cache'], 'keep');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('同步落库立即使旧请求失效，重复轮询同一终态不重复失效', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: {}, dispatchEvent() { return true; },
  } });
  try {
    const before = getLibraryRevision();
    assert.equal(isLibraryRevisionCurrent(before), true);
    notifyLibraryUpdated('test-finished-job');
    assert.equal(isLibraryRevisionCurrent(before), false);
    const after = getLibraryRevision();
    notifyLibraryUpdated('test-finished-job');
    assert.equal(getLibraryRevision(), after);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('浏览器存储被禁用时同步成功仍能通知首页刷新', () => {
  let events = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get sessionStorage() { throw new Error('存储不可用'); },
    dispatchEvent(event: Event) { if (event.type === LIBRARY_UPDATED_EVENT) events += 1; },
  } });
  try {
    assert.doesNotThrow(notifyLibraryUpdated);
    assert.equal(events, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('切回前台合并刷新事件，页面卸载会撤销待执行刷新和监听', async () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  let calls = 0;
  const unsubscribe = subscribeLibraryUpdates(() => { calls += 1; });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  try {
    win.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
    await settle();
    assert.equal(calls, 0);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    win.dispatchEvent(new Event('pageshow'));
    await settle();
    assert.equal(calls, 1);
    win.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
    unsubscribe();
    win.dispatchEvent(new Event('focus'));
    await settle();
    assert.equal(calls, 1);
  } finally {
    unsubscribe();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
