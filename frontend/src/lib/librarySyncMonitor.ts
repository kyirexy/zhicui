import type { LibrarySyncRun } from './types';
import type { PlatformAccountStatus } from './desktopRuntime';

export interface LibraryCaptureState {
  platform: string;
  mode?: string;
  stage: PlatformAccountStatus['stage'];
  observedAt: number;
  awaitingSave: boolean;
}
export interface LibrarySyncState {
  runs: LibrarySyncRun[];
  capture: LibraryCaptureState | null;
  offline: boolean;
}

export const emptyLibrarySyncState = (): LibrarySyncState => ({ runs: [], capture: null, offline: false });

export function syncRunVersion(run: LibrarySyncRun): string {
  return [run.id, run.status, run.accepted, run.created, run.reused, run.failed_count,
    run.skipped, run.pending_count, run.updated_at, run.finished_at].join(':');
}

/** 只观察已由用户或 Agent 发起的任务；不会启动采集、提取或重新提交失败任务。 */
export function watchLibrarySync(options: {
  read: (signal: AbortSignal) => Promise<LibrarySyncRun[]>;
  subscribeCapture: (listener: (status: PlatformAccountStatus) => void) => (() => void);
  subscribeWake: (listener: () => void) => (() => void);
  visible: () => boolean;
  onState: (state: LibrarySyncState) => void;
  onSaved: () => void;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: typeof clearTimeout;
}): () => void {
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const unschedule = options.unschedule || clearTimeout;
  let state = emptyLibrarySyncState();
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rerun = false;
  const versions = new Map<string, string>();
  const publish = () => { if (!stopped) options.onState({ ...state }); };

  const refresh = async () => {
    if (stopped || !options.visible()) return;
    if (controller) { rerun = true; return; }
    unschedule(timer);
    controller = new AbortController();
    try {
      const runs = await options.read(controller.signal);
      if (stopped) return;
      const changed = runs.some((run) => versions.get(run.id) !== syncRunVersion(run));
      versions.clear();
      runs.forEach((run) => versions.set(run.id, syncRunVersion(run)));
      let capture = state.capture;
      if (capture?.awaitingSave) {
        const saved = runs.some((run) => run.platform === capture!.platform
          && (!capture!.mode || run.source_mode === capture!.mode)
          && Date.parse(run.started_at) >= capture!.observedAt - 1_000);
        if (saved) capture = null;
      }
      // CLI 中断后不会永远显示“正在保存”；历史记录仍可查看，后台不会擅自重试。
      if (capture && now() - capture.observedAt > 5 * 60_000) capture = null;
      state = { runs, capture, offline: false };
      publish();
      if (changed) options.onSaved();
    } catch {
      if (!stopped) { state = { ...state, offline: true }; publish(); }
    } finally {
      controller = null;
      if (!stopped) {
        const busy = Boolean(state.capture?.awaitingSave)
          || state.runs.some((run) => run.status === 'running');
        const delay = rerun ? 0 : busy ? 2_000 : 10_000;
        rerun = false;
        timer = schedule(() => { void refresh(); }, delay);
      }
    }
  };
  const stopCapture = options.subscribeCapture((event) => {
    if (stopped || !['douyin', 'bilibili'].includes(event.platform) || !event.mode) return;
    // 不展示 IPC 原始异常或浏览器路径，只展示已知阶段与平台。
    const previous = state.capture;
    const ongoing = previous && previous.platform === event.platform && previous.mode === event.mode
      && !['success', 'error', 'cancelled', 'disconnected'].includes(previous.stage);
    state = { ...state, capture: {
      platform: event.platform, mode: event.mode, stage: event.stage,
      observedAt: ongoing ? previous.observedAt : now(), awaitingSave: event.stage === 'success',
    } };
    publish();
    void refresh();
  });
  const stopWake = options.subscribeWake(() => { void refresh(); });
  void refresh();
  return () => {
    stopped = true;
    unschedule(timer);
    controller?.abort();
    stopCapture();
    stopWake();
  };
}

export function captureLabel(capture: LibraryCaptureState): string {
  const labels: Record<PlatformAccountStatus['stage'], string> = {
    starting: '正在连接平台', 'browser-open': '正在读取平台页面', waiting: '等待平台响应',
    collecting: '正在读取视频清单', 'needs-action': '请在平台窗口完成验证',
    success: '清单已读取，等待保存结果', cancelled: '同步已取消',
    disconnected: '平台连接已断开', error: '本次读取未完成，请查看平台窗口',
  };
  return labels[capture.stage] || '正在同步';
}

export function syncRunLabel(run: LibrarySyncRun): string {
  return { running: '正在保存', succeeded: '已同步', partial: '部分完成', failed: '未完成',
    rejected: '已跳过', invalid: '请求无效' }[run.status];
}
