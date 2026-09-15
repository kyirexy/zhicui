import type { HomeKnowledgeResult, HomeVideoIdentity, HomeVideoPreference } from './homeVideoActionsApi';

export interface HomeVideoTarget extends HomeVideoIdentity { title: string }
export function homeVideoKey(video: HomeVideoIdentity): string { return `${video.platform}:${video.video_id}`; }
export interface HomeVideoActionsSnapshot {
  ready: boolean;
  loading: boolean;
  preferences: ReadonlyMap<string, HomeVideoPreference>;
  busy: ReadonlySet<string>;
  error: string;
  notice: { message: string; undo?: HomeVideoTarget; knowledgeId?: string } | null;
}
export const EMPTY_HOME_VIDEO_ACTIONS: HomeVideoActionsSnapshot = {
  ready: false, loading: true, preferences: new Map(), busy: new Set(), error: '', notice: null,
};

/** 首页显示偏好独立于视频目录；只在服务端确认成功后更新可见性。 */
export function createHomeVideoActionsController(deps: {
  current: () => boolean;
  list: (signal: AbortSignal) => Promise<HomeVideoPreference[]>;
  hide: (video: HomeVideoIdentity, hidden: boolean, signal: AbortSignal) => Promise<HomeVideoPreference>;
  save: (video: HomeVideoIdentity, signal: AbortSignal) => Promise<HomeKnowledgeResult>;
}) {
  let snapshot = EMPTY_HOME_VIDEO_ACTIONS;
  const listeners = new Set<() => void>();
  let read: AbortController | null = null;
  const pending = new Map<string, Promise<void>>();
  const writes = new Set<AbortController>();
  let changes = 0;
  let disposed = false;
  const current = () => !disposed && deps.current();
  const publish = (patch: Partial<HomeVideoActionsSnapshot>) => {
    if (!current()) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const load = async () => {
    if (!current()) return;
    read?.abort();
    const controller = new AbortController(); read = controller;
    const revision = changes;
    publish({ loading: true, error: '' });
    try {
      const items = await deps.list(controller.signal);
      if (!current() || controller.signal.aborted || changes !== revision) return;
      publish({ preferences: new Map(items.map((item) => [homeVideoKey(item), item])), ready: true });
    } catch {
      if (!controller.signal.aborted) publish({ error: '首页视频设置暂时无法读取，请重试。' });
    } finally {
      if (read === controller) { read = null; publish({ loading: false }); }
    }
  };
  const run = (video: HomeVideoTarget, action: 'hide' | 'restore' | 'save'): Promise<void> => {
    const key = homeVideoKey(video);
    if (pending.has(key)) return pending.get(key)!;
    if (!current() || !snapshot.ready) return Promise.resolve();
    const controller = new AbortController(); writes.add(controller);
    publish({ busy: new Set([...snapshot.busy, key]), notice: null });
    const identity = { platform: video.platform, video_id: video.video_id };
    const operation = (async () => {
      const result = action === 'save' ? await deps.save(identity, controller.signal) : await deps.hide(identity, action === 'hide', controller.signal);
      if (!current() || controller.signal.aborted) return;
      const item = action === 'save' ? (result as HomeKnowledgeResult).preference : result as HomeVideoPreference;
      changes += 1;
      const preferences = new Map(snapshot.preferences); preferences.set(key, item);
      const notice = action === 'hide' ? { message: '已从首页隐藏，原视频仍保留在视频资料中。', undo: video }
        : action === 'restore' ? { message: '已恢复首页显示。' }
        : { message: (result as HomeKnowledgeResult).created ? '已加入知萃知识库。' : '这条视频已在知萃知识库。', knowledgeId: item.knowledge_entry_id! };
      publish({ preferences, notice });
    })().catch(() => {
      if (!controller.signal.aborted) publish({ notice: { message: action === 'save' ? '暂时无法加入知识库，请重试。' : '暂时无法保存隐藏设置，请重试。', ...(action === 'restore' ? { undo: video } : {}) } });
    }).finally(() => {
      pending.delete(key); writes.delete(controller);
      const busy = new Set(snapshot.busy); busy.delete(key); publish({ busy });
    });
    pending.set(key, operation);
    return operation;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load, run, dismiss: () => publish({ notice: null }),
    activate: () => { disposed = false; },
    dispose: () => { disposed = true; read?.abort(); writes.forEach((controller) => controller.abort()); listeners.clear(); },
  };
}
