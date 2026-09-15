import { readStoredToken, sessionFetch } from './authSession';
import type { KnowledgeItem } from './api';

export interface HomeVideoIdentity { platform: 'douyin' | 'bilibili'; video_id: string }
export interface HomeVideoPreference extends HomeVideoIdentity { hidden: boolean; knowledge_entry_id: string | null }
export interface HomeKnowledgeResult { entry: KnowledgeItem; created: boolean; preference: HomeVideoPreference }

function preference(value: unknown): HomeVideoPreference {
  const item = value as HomeVideoPreference;
  if (!item || !['douyin', 'bilibili'].includes(item.platform) || typeof item.video_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.video_id)
    || typeof item.hidden !== 'boolean' || (item.knowledge_entry_id !== null && typeof item.knowledge_entry_id !== 'string')) {
    throw new Error('首页视频设置暂时无法读取');
  }
  return item;
}

async function request(path: string, token: string, options: { method?: string; body?: object; signal?: AbortSignal } = {}) {
  if (!token || readStoredToken() !== token) throw new Error('账号已切换，请重新打开首页');
  const timeout = AbortSignal.timeout(15_000);
  const response = await sessionFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/home/${path}`, {
    method: options.method || 'GET', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (readStoredToken() !== token) throw new Error('账号已切换，请重新打开首页');
  const envelope = await response.json().catch(() => null);
  if (!response.ok || envelope?.success !== true || !envelope.data) throw new Error('操作暂未完成，请稍后重试');
  return envelope.data;
}

export async function listHomeVideoPreferences(token: string, signal?: AbortSignal): Promise<HomeVideoPreference[]> {
  const data = await request('video-preferences', token, { signal });
  if (!Array.isArray(data.items)) throw new Error('首页视频设置暂时无法读取');
  return data.items.map(preference);
}

export async function setHomeVideoHidden(video: HomeVideoIdentity, hidden: boolean, token: string, signal?: AbortSignal): Promise<HomeVideoPreference> {
  const data = preference(await request('video-preferences', token, { method: 'PATCH', body: { ...video, hidden }, signal }));
  if (data.platform !== video.platform || data.video_id !== video.video_id || data.hidden !== hidden) throw new Error('操作暂未完成，请稍后重试');
  return data;
}

export async function addHomeVideoToKnowledge(video: HomeVideoIdentity, token: string, signal?: AbortSignal): Promise<HomeKnowledgeResult> {
  const data = await request('knowledge', token, { method: 'POST', body: video, signal });
  const saved = preference(data.preference);
  if (saved.platform !== video.platform || saved.video_id !== video.video_id || typeof data.created !== 'boolean'
    || !data.entry || typeof data.entry.id !== 'string' || saved.knowledge_entry_id !== data.entry.id) throw new Error('操作暂未完成，请稍后重试');
  return { entry: data.entry, created: data.created, preference: saved };
}
