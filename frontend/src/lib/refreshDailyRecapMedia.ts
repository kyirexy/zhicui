import { readStoredToken } from './authSession';
import type { DailyRecapItem } from './dailyRecapApi';
import { supportsPlatformAccountSync } from './desktopRuntime';
import { getEphemeralDouyinMediaSources, supportsLocalDouyinRuntime, toLocalDouyinSyncItems } from './douyinDesktopSync';
import { formatPlatformSyncError } from './platformSyncFeedback';

interface Options {
  userId: string;
  profileKey: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

function aborted(message = '已取消播放地址探测，已完成的文稿会保留'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** 只刷新本次缺文稿的临时播放地址，不重新导入或改写昨日来源记录。 */
export async function refreshDailyRecapMedia(
  items: DailyRecapItem[],
  { userId, profileKey, onProgress, signal }: Options,
): Promise<{ warnings: string[] }> {
  const token = readStoredToken();
  const ensureCurrent = () => {
    if (signal?.aborted) throw aborted();
    if (!userId || !token || token !== readStoredToken()) throw aborted('账号已切换，请重新开始回顾');
  };
  ensureCurrent();
  const targets = items.filter((item) => item.platform === 'douyin'
    && !item.transcript_ready && item.can_extract && item.transcript_status !== 'no_audio'
    && item.transcript_source !== 'no-audio');
  const targetIds = new Set(targets.map((item) => item.video_id));
  const missingIds = () => {
    const cached = new Set(getEphemeralDouyinMediaSources([...targetIds]).map((item) => item.aweme_id));
    return new Set([...targetIds].filter((id) => !cached.has(id)));
  };
  if (!missingIds().size) return { warnings: [] };

  const bridge = typeof window === 'undefined' ? undefined : window.zhicuiDesktop;
  const unavailable = '部分视频的播放地址需要更新，请在最新版桌面端同步账号后重试；本次先尝试服务端读取';
  if (!supportsPlatformAccountSync(bridge) || !profileKey || profileKey === 'guest'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(profileKey)) return { warnings: [unavailable] };
  let version: string;
  try {
    version = (await bridge.getRuntimeInfo()).version;
  } catch (error) {
    ensureCurrent();
    return { warnings: [`${unavailable}；${formatPlatformSyncError(error)}`] };
  }
  ensureCurrent();
  if (!supportsLocalDouyinRuntime(version)) return { warnings: [unavailable] };

  const warnings: string[] = [];
  for (const mode of ['collect', 'like'] as const) {
    ensureCurrent();
    const missing = missingIds();
    if (!missing.size) break;
    if (!targets.some((item) => missing.has(item.video_id)
      && (!item.source_modes.length || item.source_modes.includes(mode)))) continue;
    const label = `抖音${mode === 'collect' ? '收藏' : '喜欢'}`;
    onProgress(`正在打开浏览器检查${label}，更新 ${missing.size} 条待解析视频的播放地址…`);
    const sessionKey = crypto.randomUUID();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void bridge.cancelPlatformAccountSync?.({ sessionKey }).catch(() => undefined);
    };
    const unsubscribe = bridge.onPlatformAccountStatus((status) => {
      if (!signal?.aborted && token === readStoredToken() && status.platform === 'douyin'
        && (!status.mode || status.mode === mode) && status.message) {
        onProgress(`更新${label}播放地址 · ${status.message}`);
      }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      ensureCurrent();
      const result = await bridge.collectPlatformAccount({
        platform: 'douyin', profileKey, mode, limit: 100, interactive: true, sessionKey,
      });
      ensureCurrent();
      if (result.cancelled) throw aborted();
      if (!result.success) throw new Error(result.error || '读取未完成，请稍后重试');
      // 仅更新目标视频的内存缓存；其它作品不能进入本次回顾，也不触碰同步日期。
      toLocalDouyinSyncItems((result.items || []).filter((item) => missing.has(item.videoId)));
      onProgress(`已确认 ${targetIds.size - missingIds().size}/${targetIds.size} 条待解析视频的播放地址`);
    } catch (error) {
      ensureCurrent();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      warnings.push(`${label}：${formatPlatformSyncError(error)}`);
    } finally {
      if (signal?.aborted || token !== readStoredToken()) cancel();
      signal?.removeEventListener('abort', cancel);
      unsubscribe();
    }
  }
  ensureCurrent();
  const remaining = missingIds().size;
  if (remaining) warnings.push(`还有 ${remaining} 条视频未取得有效播放地址，本次先尝试服务端读取；若仍失败，请在同步视频中重新同步对应喜欢或收藏`);
  return { warnings };
}
