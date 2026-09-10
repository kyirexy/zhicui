import { readStoredToken, sessionFetch } from './authSession';

export interface DailyRecapItem {
  id: string;
  note_id: string | null;
  video_id: string;
  platform: 'douyin' | 'bilibili';
  title: string;
  cover_url: string;
  author_name?: string;
  source_url: string;
  source_modes: Array<'like' | 'collect'>;
  first_seen_at: string;
  can_extract: boolean;
  transcript_ready: boolean;
  ai_initialized: boolean;
  initial_import: boolean;
}

export interface DailyRecap {
  date: string;
  timezone: string;
  time_basis: 'first_discovered';
  time_basis_label: string;
  message: string;
  total: number;
  like_count: number;
  collect_count: number;
  ready_count: number;
  pending_count: number;
  initial_import_count: number;
  initial_import_unknown_count?: number;
  items: DailyRecapItem[];
  preview: DailyRecapItem[];
  has_more: boolean;
  ready_note_ids: string[];
}

/** 按用户时区请求昨日；不用视频发布时间或本机缓存推断点赞时间。 */
export async function getDailyRecap(timezone: string, signal?: AbortSignal, date?: string): Promise<DailyRecap> {
  const params = new URLSearchParams({ timezone });
  if (date) params.set('date', date);
  const token = readStoredToken();
  const response = await sessionFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/library/daily-recap?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success || !result.data) {
    throw new Error(typeof result?.error === 'string' ? result.error : '昨日回顾暂时未能读取，请重试');
  }
  const data = result.data as DailyRecap;
  const apiBase = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
  const normalizeItem = (item: DailyRecapItem): DailyRecapItem => ({
    ...item,
    cover_url: item.cover_url?.startsWith('/') ? `${apiBase}${item.cover_url}` : item.cover_url || '',
  });
  return {
    ...data,
    items: data.items.map(normalizeItem),
    preview: data.preview.map(normalizeItem),
  };
}

export function dailyRecapItemHref(item: Pick<DailyRecapItem, 'platform' | 'video_id' | 'note_id'>): string {
  if (item.platform === 'douyin') return `/library/detail?id=${encodeURIComponent(item.video_id)}`;
  if (item.note_id) return `/library/detail?note=${encodeURIComponent(item.note_id)}`;
  return '/library?platform=bilibili';
}

export function dailyRecapDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[2])} 月 ${Number(match[3])} 日` : '';
}

export function dailyRecapTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
  catch { return 'Asia/Shanghai'; }
}
