import type { WebBuildManifest } from './webBuildManifest';

export type WebUpdatePhase = 'idle' | 'checking' | 'preparing' | 'ready' | 'deferred' | 'error' | 'reloading';
export type WebUpdateBlock = 'task' | 'settling' | 'input' | 'interaction' | 'hidden' | 'paused' | 'already-reloaded' | '';
export interface WebUpdateSnapshot {
  phase: WebUpdatePhase;
  available: WebBuildManifest | null;
  completed: number;
  total: number;
  blocked: WebUpdateBlock;
  error: string;
}
export const INITIAL_WEB_UPDATE: WebUpdateSnapshot = {
  phase: 'idle', available: null, completed: 0, total: 0, blocked: '', error: '',
};
export function webBuildUpdatePresentation(state: WebUpdateSnapshot) {
  const preparing = state.phase === 'preparing';
  const waiting = state.blocked === 'task' || state.blocked === 'input' || state.blocked === 'settling';
  const title = preparing ? '正在准备页面更新' : state.phase === 'reloading' ? '正在更新页面'
    : state.phase === 'error' ? '页面更新暂未完成' : '新功能已准备好';
  const description = preparing
    ? (state.total ? `已准备 ${state.completed}/${state.total} 项资源` : '正在检查新版页面资源')
    : state.phase === 'error' ? state.error
    : state.blocked === 'task' ? '当前任务完成后自动更新，不会中断同步或 AI。'
    : state.blocked === 'settling' ? '任务已完成，页面空闲后自动更新。'
    : state.blocked === 'input' ? '先保存当前输入或关闭弹窗，再自动更新。'
    : state.blocked === 'paused' ? '已暂缓，可在方便时更新页面。'
    : state.blocked === 'already-reloaded' ? '自动更新已尝试一次，可稍后手动刷新。'
    : '空闲时自动更新页面，无需下载安装。';
  return { title, description, preparing, waiting,
    visible: Boolean(state.available),
    label: state.phase === 'error' ? '重试更新' : preparing ? '正在准备…' : waiting ? '等待当前操作完成' : '现在更新',
    disabled: preparing || waiting || state.phase === 'reloading' };
}
export interface WebUpdateAdapter {
  current: WebBuildManifest;
  now(): number;
  pathname(): string;
  latest(signal: AbortSignal): Promise<WebBuildManifest>;
  prepare(signal: AbortSignal, progress: (completed: number, total: number) => void,
    expected: { buildId: string; pathname: string }): Promise<void>;
  safety(): Exclude<WebUpdateBlock, 'paused' | 'already-reloaded'>;
  wasReloaded(buildId: string): boolean;
  recordReload(buildId: string): boolean;
  reload(): void;
}

/** 一个页面实例共享检查、资源准备与刷新；不重复请求，也不在工作过程中刷新。 */
export function createWebBuildUpdateController(adapter: WebUpdateAdapter) {
  let snapshot = INITIAL_WEB_UPDATE;
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let operation: Promise<void> | null = null;
  let request: AbortController | null = null;
  let preparedId = '';
  let preparedPath = '';
  let pausedId = '';
  let retryAt = Infinity;
  const attempts = new Map<string, number>();
  let failures = 0;
  const publish = (next: Partial<WebUpdateSnapshot>) => {
    const value = { ...snapshot, ...next };
    if (Object.keys(value).every(key => value[key as keyof WebUpdateSnapshot] === snapshot[key as keyof WebUpdateSnapshot])) return;
    snapshot = value;
    listeners.forEach(listener => listener());
  };
  const blockedBy = (manual: boolean): WebUpdateBlock => {
    const safety = adapter.safety();
    const id = snapshot.available?.build_id || '';
    return (manual && safety === 'interaction' ? '' : safety) || (!manual && pausedId === id ? 'paused' : '')
      || (!manual && adapter.wasReloaded(id) ? 'already-reloaded' : '');
  };
  // 只由刚完成版本确认的检查调用；最后一次 await 后再次核对任务和当前路由。
  const applyVerified = (manual: boolean) => {
    if (!active || snapshot.phase === 'reloading' || !snapshot.available || preparedId !== snapshot.available.build_id
      || preparedPath !== adapter.pathname()) return;
    const id = snapshot.available.build_id;
    const blocked = blockedBy(manual);
    if (blocked) { publish({ phase: 'deferred', blocked }); return; }
    // 无法记录防循环标记时也不自动刷新；用户仍能显式点击一次刷新。
    if (!adapter.recordReload(id) && !manual) {
      publish({ phase: 'deferred', blocked: 'already-reloaded' }); return;
    }
    publish({ phase: 'reloading', blocked: '', error: '' });
    try { adapter.reload(); } catch {
      publish({ phase: 'error', error: '页面暂未刷新，请稍后重试。' });
    }
  };
  const check = (manual = false): Promise<void> => {
    if (!active || snapshot.phase === 'reloading') return Promise.resolve();
    if (operation) return operation;
    const owner = generation;
    const abort = new AbortController();
    request = abort;
    const valid = () => active && owner === generation && !abort.signal.aborted;
    const task = Promise.resolve().then(async () => {
      try {
        if (!snapshot.available) publish({ phase: 'checking', error: '' });
        let latest = await adapter.latest(abort.signal);
        if (!valid()) return;
        // 每次检查最多追赶一次新发布/路由变化，避免连续部署时无限准备。
        for (let pass = 0; pass < 2; pass++) {
          if (latest.build_id === adapter.current.build_id) {
            preparedId = ''; preparedPath = ''; failures = 0; retryAt = Infinity; publish(INITIAL_WEB_UPDATE); return;
          }
          if (snapshot.available?.build_id !== latest.build_id) failures = 0;
          if (!manual && failures >= 2 && snapshot.available?.build_id === latest.build_id) return;
          const path = adapter.pathname();
          if (preparedId === latest.build_id && preparedPath === path) {
            failures = 0; retryAt = Infinity;
            publish({ available: latest, error: '' }); applyVerified(manual); return;
          }
          const key = `${latest.build_id}:${path}`;
          if (!manual && (attempts.get(key) || 0) >= 2) throw new Error('PREPARE_LIMIT');
          if (manual) pausedId = '';
          attempts.set(key, (attempts.get(key) || 0) + 1);
          retryAt = Infinity; preparedId = ''; preparedPath = '';
          publish({ phase: 'preparing', available: latest, completed: 0, total: 0, blocked: '', error: '' });
          await adapter.prepare(abort.signal, (completed, total) => {
            if (valid()) publish({ completed, total });
          }, { buildId: latest.build_id, pathname: path });
          if (!valid()) return;
          const confirmed = await adapter.latest(abort.signal);
          if (!valid()) return;
          if (confirmed.build_id !== latest.build_id || path !== adapter.pathname()) {
            latest = confirmed;
            if (confirmed.build_id === adapter.current.build_id) {
              preparedId = ''; preparedPath = ''; failures = 0; retryAt = Infinity; publish(INITIAL_WEB_UPDATE); return;
            }
            continue;
          }
          preparedId = latest.build_id; preparedPath = path; failures = 0;
          publish({ phase: 'ready', blocked: '', error: '' });
          applyVerified(manual); return;
        }
        throw new Error('BUILD_CHANGED');
      } catch {
        if (!valid()) return;
        if (!snapshot.available) { publish(INITIAL_WEB_UPDATE); return; }
        failures++;
        retryAt = adapter.now() + 30_000;
        publish({ phase: 'error', error: failures >= 2
          ? '页面更新暂未完成，连接恢复后可点击重试。'
          : '页面更新暂未准备好，将稍后重试。', blocked: '' });
      }
    }).finally(() => {
      if (operation === task) operation = null;
      if (request === abort) request = null;
    });
    operation = task;
    return task;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate(enabled: boolean) {
      if (active === enabled) return;
      active = enabled;
      if (!enabled) {
        generation++; request?.abort(); request = null; operation = null;
        preparedId = ''; preparedPath = ''; pausedId = ''; failures = 0; retryAt = Infinity; attempts.clear(); publish(INITIAL_WEB_UPDATE);
      }
    },
    check,
    tick() {
      if (!active || operation) return;
      if (snapshot.phase === 'ready' || snapshot.phase === 'deferred') {
        const blocked = blockedBy(false);
        if (blocked) publish({ phase: 'deferred', blocked });
        else void check();
      }
      if (snapshot.phase === 'error' && snapshot.available && adapter.now() >= retryAt
        && failures < 2) void check();
    },
    refresh: () => check(true),
    retry: () => { failures = 0; return check(true); },
    pause() { pausedId = snapshot.available?.build_id || ''; if (preparedId) publish({ phase: 'deferred', blocked: 'paused' }); },
  };
}
