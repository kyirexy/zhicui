import { collectDouyinLibrary, getDouyinCollectionJob, getDouyinLibraryStatus,
  importPlatformLibraryItems, ingestLocalDouyinLibrary } from './api';
import { readStoredToken } from './authSession';
import { supportsPlatformAccountSync } from './desktopRuntime';
import type { PlatformAccountStatus } from './desktopRuntime';
import { supportsLocalDouyinRuntime, toLocalDouyinSyncItems } from './douyinDesktopSync';
import { hasDouyinSyncFailureDiagnostic } from './douyinSyncFeedback';
import { capturePlatformSyncSnapshot } from './platformSyncSnapshot';
import { formatPlatformSyncError, platformSyncWarning } from './platformSyncFeedback';

interface Options {
  userId: string;
  profileKey: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}
type Source = { platform: 'douyin' | 'bilibili'; mode: 'collect' | 'like'; local: boolean };
const LIMIT = 100;

function aborted(message = '今日分析已取消'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 2_000);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** 先读取已连接账号的最新列表；来源采集串行，避免争用桌面浏览器会话。 */
export async function syncDailyAnalysisSources({ userId, profileKey, onProgress, signal }: Options): Promise<{ warnings: string[] }> {
  const token = readStoredToken();
  const ensureCurrent = () => {
    if (signal?.aborted) throw aborted();
    if (!userId || !token || token !== readStoredToken()) throw aborted('账号已切换，请重新开始今日分析');
  };
  ensureCurrent();
  onProgress('正在检查已连接的抖音、B站账号…');
  const bridge = typeof window === 'undefined' ? undefined : window.zhicuiDesktop;
  const desktop = supportsPlatformAccountSync(bridge);
  let version = '';
  let connections: Partial<Record<'douyin' | 'bilibili', boolean>> = {};
  if (desktop && profileKey && profileKey !== 'guest') {
    try {
      const profileStored = JSON.parse(window.localStorage.getItem(`zhicui-platform-account-connections:${profileKey}`) || '{}');
      const userStored = JSON.parse(window.localStorage.getItem(`zhicui-platform-account-connections:${userId}`) || '{}');
      connections = {
        douyin: profileStored?.douyin === true || userStored?.douyin === true,
        bilibili: profileStored?.bilibili === true || userStored?.bilibili === true,
      };
      version = (await bridge.getRuntimeInfo()).version;
    } catch { /* 本机状态不可用时仍可检查服务端已连接账号。 */ }
  }
  ensureCurrent();
  const localDouyin = desktop && Boolean(connections.douyin) && supportsLocalDouyinRuntime(version);
  let serverDouyin = false;
  const warnings: string[] = [];
  if (!localDouyin) {
    try {
      const status = await getDouyinLibraryStatus();
      ensureCurrent();
      serverDouyin = Boolean(status.success && status.data?.connected && status.data.cookie_valid);
    } catch (error) { ensureCurrent(); warnings.push(`抖音：${formatPlatformSyncError(error)}`); }
    if (connections.douyin && !serverDouyin) warnings.push('本机抖音连接器不可用，请更新桌面端或重新连接账号');
  }
  const sources: Source[] = [];
  for (const mode of ['collect', 'like'] as const) {
    if (localDouyin || serverDouyin) sources.push({ platform: 'douyin', mode, local: localDouyin });
    if (desktop && connections.bilibili) sources.push({ platform: 'bilibili', mode, local: true });
  }
  if (!sources.length) throw new Error(warnings.join('；') || '请先在“同步视频”中连接抖音或 B站账号，再开始今日分析');
  let successful = 0;
  for (let index = 0; index < sources.length; index += 1) {
    ensureCurrent();
    const source = sources[index];
    const label = `${source.platform === 'douyin' ? '抖音' : 'B站'}${source.mode === 'collect' ? '收藏' : '喜欢'}`;
    const progress = (message: string) => { ensureCurrent(); onProgress(`同步 ${index + 1}/${sources.length} · ${label} · ${message}`); };
    progress(`正在读取最近 ${LIMIT} 条…`);
    try {
      if (source.local && bridge) {
        const sourceSyncedAt = new Date().toISOString();
        // 批次取消属于抖音连接器；B站不接受这组参数，也不能借用全局取消。
        const sessionKey = source.platform === 'douyin' ? crypto.randomUUID() : undefined;
        const cancel = () => {
          if (sessionKey) void bridge.cancelPlatformAccountSync?.({ sessionKey }).catch(() => undefined);
        };
        const unsubscribe = bridge.onPlatformAccountStatus((status: PlatformAccountStatus) => {
          if (!signal?.aborted && token === readStoredToken() && status.platform === source.platform
            && (!status.mode || status.mode === source.mode) && status.message) progress(status.message);
        });
        signal?.addEventListener('abort', cancel, { once: true });
        let collected;
        try {
          ensureCurrent();
          collected = await bridge.collectPlatformAccount({ platform: source.platform, profileKey,
            mode: source.mode, limit: LIMIT, interactive: true,
            ...(sessionKey ? { sessionKey } : {}) });
        } finally {
          signal?.removeEventListener('abort', cancel);
          unsubscribe();
        }
        ensureCurrent();
        if (!collected.success || collected.cancelled) throw new Error(collected.error || '读取未完成，请稍后重试');
        const warning = platformSyncWarning(collected);
        const snapshot = capturePlatformSyncSnapshot(collected, sourceSyncedAt);
        const count = source.platform === 'douyin' ? collected.items?.length || 0 : collected.urls?.length || 0;
        if (!count) {
          if (collected.coverage !== 'complete' || collected.orderReliable === false) throw new Error(warning || '没有确认读取到列表，请重新连接后重试');
          progress('列表为空');
        } else if (source.platform === 'douyin') {
          progress(`正在保存 ${count} 条视频…`);
          ensureCurrent();
          const result = await ingestLocalDouyinLibrary(source.mode, toLocalDouyinSyncItems(collected.items!), version, snapshot);
          ensureCurrent();
          if (!result.success || !result.data || result.data.accepted <= result.data.quarantined) throw new Error(result.error || '视频保存失败');
          if (result.data.quarantined > 0) warnings.push(`${label}：${result.data.quarantined} 条视频未能保存`);
          progress(`已保存 ${result.data.accepted - result.data.quarantined} 条`);
        } else {
          progress(`正在导入 ${count} 条视频…`);
          ensureCurrent();
          const result = await importPlatformLibraryItems(collected.urls!, source.mode, snapshot,
            (completed, total) => { if (!signal?.aborted && token === readStoredToken()) progress(`已导入 ${completed}/${total} 条`); }, signal);
          ensureCurrent();
          if (!result.success || !result.data || result.data.success <= 0) throw new Error(result.error || '视频导入未完成');
          if (result.data.failed || result.data.pending || result.data.not_submitted || result.data.interrupted) {
            warnings.push(`${label}：已导入 ${result.data.success} 条，部分视频尚未完成`);
          }
        }
        if (warning) warnings.push(`${label}：${warning}`);
      } else {
        ensureCurrent();
        const started = await collectDouyinLibrary(LIMIT, source.mode);
        ensureCurrent();
        if (!started.success || !started.data) throw new Error(started.error || '同步任务启动失败');
        let job = started.data;
        for (let attempt = 0; job.status !== 'success' && job.status !== 'failed'; attempt += 1) {
          if (attempt >= 180) throw new Error('同步仍在后台运行，请稍后重试今日分析');
          progress(`已读取 ${job.processed ?? job.success ?? 0} 条，正在同步…`);
          await pause(signal);
          ensureCurrent();
          const response = await getDouyinCollectionJob(job.job_id, signal);
          ensureCurrent();
          if (!response.success || !response.data) throw new Error(response.error || '无法确认同步进度');
          job = response.data;
        }
        if (job.status === 'failed' || hasDouyinSyncFailureDiagnostic(job)) throw new Error(job.error || '同步未完成，请检查平台连接或验证状态');
        if (job.failed > 0) warnings.push(`${label}：${job.failed} 条视频同步失败`);
        progress(`已同步 ${job.success} 条`);
      }
      successful += 1;
    } catch (error) {
      ensureCurrent();
      warnings.push(`${label}：${formatPlatformSyncError(error)}`);
    }
  }
  ensureCurrent();
  if (!successful) throw new Error(warnings.join('；') || '同步未完成，请重试');
  onProgress(warnings.length ? `部分来源同步完成，继续分析已同步资料；${warnings.join('；')}` : '收藏和喜欢同步完成，正在读取今日新增视频…');
  return { warnings };
}
