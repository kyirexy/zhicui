/** 首页案例的公开读取与管理员编辑使用相同数据合同。 */
export interface ShowcaseCase {
  id: number;
  title: string;
  industry: string;
  person_name: string;
  role: string;
  summary: string;
  challenge: string;
  workflow: string;
  outcome: string;
  source_url: string;
  source_label: string;
  authenticity_confirmed: boolean;
  published: boolean;
  sort_order: number;
  media_url: string | null;
  preview_url?: string | null;
  poster_url: string | null;
  media_type: 'video/mp4' | 'image/gif' | null;
  media_size: number | null;
  updated_at: string;
}

export type ShowcaseCaseInput = Pick<ShowcaseCase,
  'title' | 'industry' | 'person_name' | 'role' | 'summary' | 'challenge'
  | 'workflow' | 'outcome' | 'source_url' | 'source_label'
  | 'authenticity_confirmed' | 'published' | 'sort_order'
>;

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
const ADMIN_PATH = '/api/admin/showcase-cases';
export const SHOWCASE_MP4_MAX_BYTES = 100 * 1024 * 1024;
export const SHOWCASE_GIF_MAX_BYTES = 20 * 1024 * 1024;

function adminHeaders(json = false): Headers {
  const headers = new Headers(json ? { 'Content-Type': 'application/json' } : undefined);
  let token: string | null = null;
  try {
    token = typeof window === 'undefined' ? null : window.localStorage.getItem('zhicui_token');
  } catch {
    throw new Error('无法读取登录状态，请重新登录后再试。');
  }
  if (!token) throw new Error('登录已失效，请重新登录管理端。');
  headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function responseError(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.detail === 'string' && body.detail) return body.detail;
    if (Array.isArray(body.detail)) {
      const errors = body.detail.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const message = (item as Record<string, unknown>).msg;
        return typeof message === 'string' ? [message] : [];
      });
      if (errors.length) return errors.join('；');
    }
  }
  if (status === 401) return '登录已失效，请重新登录管理端。';
  if (status === 403) return '仅管理员可以管理首页案例。';
  if (status === 413) return '文件过大，请上传 100 MB 以内的 MP4 或 20 MB 以内的 GIF。';
  return `请求未完成（${status || '网络异常'}），请稍后重试。`;
}

function unwrap<T>(payload: unknown, status: number): T {
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    if (status >= 200 && status < 300 && body.success === true && 'data' in body) {
      return body.data as T;
    }
  }
  throw new Error(responseError(payload, status));
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error('无法连接服务器，请检查网络后重试。');
  }
  const payload: unknown = await response.json().catch(() => null);
  return unwrap<T>(payload, response.status);
}

function assetUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith('/') && !value.startsWith('//') ? `${API_BASE}${value}` : value;
}

function normalize(item: ShowcaseCase): ShowcaseCase {
  if (!item || typeof item !== 'object' || typeof item.id !== 'number') {
    throw new Error('案例数据格式异常，请刷新重试。');
  }
  return {
    ...item,
    source_url: item.source_url ?? '',
    media_url: assetUrl(item.media_url),
    poster_url: assetUrl(item.poster_url),
    preview_url: assetUrl(item.preview_url),
  };
}

export async function listPublicShowcaseCases(signal?: AbortSignal): Promise<ShowcaseCase[]> {
  const items = await request<ShowcaseCase[]>('/api/showcase-cases', { signal });
  if (!Array.isArray(items)) throw new Error('案例列表格式异常，请稍后重试。');
  return items.map(normalize);
}

export async function listAdminShowcaseCases(signal?: AbortSignal): Promise<ShowcaseCase[]> {
  const items = await request<ShowcaseCase[]>(ADMIN_PATH, { headers: adminHeaders(), signal });
  if (!Array.isArray(items)) throw new Error('案例列表格式异常，请刷新重试。');
  return items.map(normalize);
}

export async function createShowcaseCase(input: Partial<ShowcaseCaseInput> = {}): Promise<ShowcaseCase> {
  return normalize(await request<ShowcaseCase>(ADMIN_PATH, {
    method: 'POST', headers: adminHeaders(true), body: JSON.stringify(input),
  }));
}

export async function updateShowcaseCase(id: number, input: Partial<ShowcaseCaseInput>): Promise<ShowcaseCase> {
  return normalize(await request<ShowcaseCase>(`${ADMIN_PATH}/${encodeURIComponent(String(id))}`, {
    method: 'PATCH', headers: adminHeaders(true), body: JSON.stringify(input),
  }));
}

export async function deleteShowcaseCase(id: number): Promise<void> {
  await request<unknown>(`${ADMIN_PATH}/${encodeURIComponent(String(id))}`, {
    method: 'DELETE', headers: adminHeaders(),
  });
}

export function validateShowcaseMedia(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mp4 = extension === 'mp4' && (!file.type || file.type === 'video/mp4');
  const gif = extension === 'gif' && (!file.type || file.type === 'image/gif');
  if (!mp4 && !gif) return '仅支持 MP4 视频或 GIF 动图，请检查文件格式。';
  if (file.size === 0) return '文件为空，请重新选择。';
  if (file.size > (mp4 ? SHOWCASE_MP4_MAX_BYTES : SHOWCASE_GIF_MAX_BYTES)) {
    return mp4 ? 'MP4 不能超过 100 MB。' : 'GIF 不能超过 20 MB。';
  }
  return null;
}

export function validateShowcasePublication(input: ShowcaseCaseInput, hasMedia: boolean): string | null {
  if (!input.title.trim()) return '发布前请填写案例标题。';
  if (!input.industry.trim()) return '发布前请填写所属行业。';
  if (!input.summary.trim()) return '发布前请填写案例简介。';
  if (!hasMedia) return '发布前请上传真实 MP4 录屏或 GIF 演示。';
  if (!input.authenticity_confirmed) return '发布前请确认案例真实，并已获得公开展示授权。';
  return null;
}

/** XHR 仅用于上传进度；凭据放在请求头，预览链接中不包含令牌。 */
export function uploadShowcaseCaseMedia(
  id: number,
  file: File,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<ShowcaseCase> {
  const validation = validateShowcaseMedia(file);
  if (validation) return Promise.reject(new Error(validation));
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'));
      return;
    }
    const headers = adminHeaders();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    xhr.open('POST', `${API_BASE}${ADMIN_PATH}/${encodeURIComponent(String(id))}/media`);
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      cleanup();
      try {
        let payload: unknown = null;
        try { payload = JSON.parse(xhr.responseText); } catch { /* 代理错误页可能不是 JSON。 */ }
        resolve(normalize(unwrap<ShowcaseCase>(payload, xhr.status)));
      } catch (error) { reject(error); }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('上传连接中断，请检查网络后重试。草稿仍会保留。')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('上传超时，请检查网络或压缩文件后重试。')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('上传已取消', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const body = new FormData();
    body.append('file', file);
    xhr.send(body);
  });
}

export async function loadAdminShowcaseCaseMedia(id: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_BASE}${ADMIN_PATH}/${encodeURIComponent(String(id))}/media`, {
    headers: adminHeaders(), signal, cache: 'no-store',
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(responseError(payload, response.status));
  }
  return response.blob();
}
