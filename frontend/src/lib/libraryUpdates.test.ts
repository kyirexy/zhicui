import assert from 'node:assert/strict';
import test from 'node:test';
import { LIBRARY_UPDATED_EVENT, notifyLibraryUpdated } from './libraryUpdates.ts';

test('同步通知先清理首页旧快照，再通知订阅者，保留其他缓存', () => {
  const target = new EventTarget();
  const data: Record<string, string> = {
    'zhicui:workspace-home:v5:user-a': 'old',
    'zhicui:workspace-home:v6:user-a': 'old',
    'unrelated-cache': 'keep',
  };
  const storage = Object.assign(data, { removeItem(key: string) { delete data[key]; } });
  let events = 0;
  target.addEventListener(LIBRARY_UPDATED_EVENT, () => {
    events += 1;
    assert.equal(data['zhicui:workspace-home:v6:user-a'], undefined);
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
