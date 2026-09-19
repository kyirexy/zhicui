'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { currentWebBuild, fetchLatestWebBuild } from '../webBuildUpdate';
import { createWebBuildUpdateController, INITIAL_WEB_UPDATE } from '../webBuildUpdateFlow';
import { documentHasPendingInput, preloadWebBuildResources } from '../webBuildPreload';
import { hasWebBuildActivity, isWebBuildActivitySettling, subscribeWebBuildActivity } from '../webBuildActivity';

const RELOADED_KEY = 'zhicui-web-build-reloaded:v1';
let controller: ReturnType<typeof createWebBuildUpdateController> | null = null;
let lastInteraction = Date.now();
function reloadLedger(): string[] {
  const value = JSON.parse(sessionStorage.getItem(RELOADED_KEY) || '[]');
  return Array.isArray(value) && value.every(id => typeof id === 'string') ? value.slice(-10) : [];
}
function getController() {
  if (typeof window === 'undefined') return null;
  if (!controller) controller = createWebBuildUpdateController({
    current: currentWebBuild(), now: Date.now,
    pathname: () => window.location.pathname,
    latest: signal => fetchLatestWebBuild(AbortSignal.any([signal, AbortSignal.timeout(15_000)])),
    prepare: preloadWebBuildResources,
    safety: () => {
      if (hasWebBuildActivity()) return 'task';
      if (isWebBuildActivitySettling()) return 'settling';
      // 更新详情弹窗只展示状态，不应阻塞已准备好的网页热更新；登录、安装等业务弹窗仍会阻塞刷新。
      if (documentHasPendingInput(document) || document.querySelector('dialog[open]:not([data-web-update-dialog])')) return 'input';
      if (document.visibilityState !== 'visible') return 'hidden';
      if (Date.now() - lastInteraction < 15_000) return 'interaction';
      return '';
    },
    wasReloaded: id => { try { return reloadLedger().includes(id); } catch { return true; } },
    recordReload: id => {
      try { sessionStorage.setItem(RELOADED_KEY, JSON.stringify([...new Set([...reloadLedger(), id])].slice(-10))); return true; }
      catch { return false; }
    },
    reload: () => window.location.reload(),
  });
  return controller;
}
const subscribe = (listener: () => void) => getController()?.subscribe(listener) || (() => {});
const getSnapshot = () => getController()?.getSnapshot() || INITIAL_WEB_UPDATE;
export function useWebBuildUpdate() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => INITIAL_WEB_UPDATE);
  return { ...state, refresh: () => getController()?.refresh(), retry: () => getController()?.retry(), pause: () => getController()?.pause() };
}

/** 只在全局提示挂载一次；侧栏、提示共用同一控制器和下载进度。 */
export function useWebBuildUpdateDriver(enabled: boolean, owner: string): void {
  useEffect(() => {
    const updates = getController();
    if (!updates) return;
    updates.activate(enabled);
    if (!enabled) return;
    let lastCheck = 0;
    const check = () => {
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now(); void updates.check();
    };
    const interact = () => { lastInteraction = Date.now(); updates.tick(); };
    const focus = () => { lastInteraction = Date.now(); check(); };
    const visible = () => { if (document.visibilityState === 'visible') focus(); };
    const startup = window.setTimeout(check, 12_000);
    const interval = window.setInterval(check, 30 * 60_000);
    const idle = window.setInterval(() => updates.tick(), 1000);
    const unsubscribe = subscribeWebBuildActivity(() => updates.tick());
    for (const event of ['pointerdown', 'keydown', 'input', 'change', 'scroll']) document.addEventListener(event, interact, { passive: true, capture: true });
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(startup); window.clearInterval(interval); window.clearInterval(idle); unsubscribe();
      for (const event of ['pointerdown', 'keydown', 'input', 'change', 'scroll']) document.removeEventListener(event, interact, true);
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible);
      updates.activate(false);
    };
  }, [enabled, owner]);
}
