const active = new Map<symbol, string>();
const listeners = new Set<() => void>();
let changedAt = -Infinity;
let queued = false;

function changed() {
  changedAt = Date.now();
  if (queued) return;
  queued = true;
  // React 会先释放旧 effect 再登记新 effect；同一回合内不观察中间空隙。
  queueMicrotask(() => {
    queued = false;
    listeners.forEach(listener => listener());
  });
}

/** 每个任务独立计数；同名入口并行时，一个完成不能清掉另一个。 */
export function beginWebBuildActivity(scope: string): () => void {
  const owner = Symbol(scope);
  active.set(owner, scope);
  changed();
  return () => {
    if (active.delete(owner)) changed();
  };
}

export function hasWebBuildActivity(): boolean { return active.size > 0; }
export function isWebBuildActivitySettling(now = Date.now()): boolean {
  return !active.size && now - changedAt < 15_000;
}
export function subscribeWebBuildActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
