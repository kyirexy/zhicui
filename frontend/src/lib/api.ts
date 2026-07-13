import { ApiResponse, CardData, Note, NoteDetail, PaginatedResponse, VideoInfo, PlanData, PlanStats } from './types';
export type { ApiResponse };

// In Capacitor/static-export mode, NEXT_PUBLIC_API_URL is set explicitly
// (e.g. http://localhost:8000 or http://10.60.10.75:8000).
// In dev mode it is left empty so requests go through the Next.js rewrite
// proxy (/api/* → localhost:8000/api/*), avoiding CORS issues.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

/** Attach JWT to every API call automatically. */
function authHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof window !== 'undefined') {
    try {
      const t = localStorage.getItem('zhicui_token');
      if (t) h['Authorization'] = `Bearer ${t}`;
    } catch {}
  }
  if (extra) {
    const ext = extra as Record<string, string>;
    Object.assign(h, ext);
  }
  return h;
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const { headers: _h, ...rest } = options || {};
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...rest,
      headers: authHeaders(_h),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      let msg = `Request failed with status ${response.status}`;
      if (response.status === 401) {
        msg = '请先登录';
      } else if (response.status === 422) {
        const locs = Array.isArray(errorData.detail) ? errorData.detail.map((e: any) => (e.loc || []).join('.')) : [];
        msg = locs.some((l: string) => l.includes('url')) ? '请输入有效的视频链接' : '输入有误,请检查后再试';
      } else if (typeof errorData.detail === 'string') {
        msg = errorData.detail;
      } else if (Array.isArray(errorData.detail)) {
        msg = errorData.detail.map((e: any) => e.msg || JSON.stringify(e)).join('; ');
      } else if (typeof errorData.message === 'string') {
        msg = errorData.message;
      }
      return { success: false, error: msg };
    }

    const json = await response.json();
    // Backend returns {success, data, error} envelope — unwrap it.
    if (json && typeof json === 'object' && 'success' in json) {
      return { success: json.success, data: json.data, error: json.error };
    }
    return { success: true, data: json };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function extractVideo(url: string): Promise<ApiResponse<CardData>> {
  return request<CardData>('/api/extract', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/** SSE progress event emitted by /api/extract/stream */
export interface ProgressEvent {
  step: string;
  message: string;
  status: 'active' | 'done' | 'error';
  data?: CardData;
}

/**
 * Stream-extract a video with live progress events via SSE.
 *
 * Calls ``onProgress`` for each pipeline step event.
 * Resolves with the final ``ApiResponse<CardData>`` when the stream finishes.
 */
export async function extractVideoStream(
  url: string,
  onProgress: (event: ProgressEvent) => void,
): Promise<ApiResponse<CardData>> {
  const encoded = encodeURIComponent(url);

  try {
    const sseBase = API_BASE || '';
    const response = await fetch(`${sseBase}/api/extract/stream?url=${encoded}`, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      let msg = `Request failed with status ${response.status}`;
      if (response.status === 401) {
        msg = '请先登录';
      } else if (response.status === 422) {
        const locs = Array.isArray(errorData.detail) ? errorData.detail.map((e: any) => (e.loc || []).join('.')) : [];
        msg = locs.some((l: string) => l.includes('url')) ? '请输入有效的视频链接' : '输入有误,请检查后再试';
      } else if (typeof errorData.detail === 'string') {
        msg = errorData.detail;
      } else if (Array.isArray(errorData.detail)) {
        msg = errorData.detail.map((e: any) => e.msg || JSON.stringify(e)).join('; ');
      }
      return { success: false, error: msg };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'Stream not supported' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let finalData: CardData | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep last partial line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const event: ProgressEvent = json;

          onProgress(event);

          if (event.step === 'done' && event.data) {
            finalData = event.data;
          }
          if (event.step === 'error') {
            return { success: false, error: event.message };
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    if (finalData) {
      return { success: true, data: finalData };
    }
    return { success: false, error: 'Stream ended without result' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

export async function getVideoInfo(url: string): Promise<ApiResponse<VideoInfo>> {
  return request<VideoInfo>('/api/video/info', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function listNotes(page: number = 1, perPage: number = 12): Promise<ApiResponse<PaginatedResponse<Note>>> {
  return request<PaginatedResponse<Note>>(`/api/notes?page=${page}&per_page=${perPage}`);
}

export async function getNote(id: string): Promise<ApiResponse<NoteDetail>> {
  return request<NoteDetail>(`/api/notes/${id}`);
}

// ---------------------------------------------------------------------------
// Plan API
// ---------------------------------------------------------------------------

export async function listPlans(page = 1, perPage = 20): Promise<ApiResponse<PaginatedResponse<PlanData>>> {
  return request<PaginatedResponse<PlanData>>(`/api/plans?page=${page}&per_page=${perPage}`);
}

export async function getPlan(id: string): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${id}`);
}

export async function getPlanStats(): Promise<ApiResponse<PlanStats>> {
  return request<PlanStats>('/api/plans/stats');
}

export async function togglePlanTask(planId: string, taskId: string): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks/${taskId}`, { method: 'PATCH' });
}

export async function addPlanTask(planId: string, title: string, day?: number): Promise<ApiResponse<PlanData>> {
  const body: Record<string, unknown> = { title };
  if (day !== undefined) body.day = day;
  return request<PlanData>(`/api/plans/${planId}/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deletePlanTask(planId: string, taskId: string): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks/${taskId}`, { method: 'DELETE' });
}

export async function deletePlan(planId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(`/api/plans/${planId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
export interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface AdminStats {
  users: number;
  notes: number;
  plans: number;
  recent_users: { username: string; email: string; created_at: string }[];
  type_dist: Record<string, number>;
}

export interface AdminNoteItem {
  id: string;
  video_title: string;
  card_type: string;
  author: string;
  has_transcript: boolean;
  created_at: string;
}

export interface LlmConfig {
  model: string;
  api_base: string;
  api_key_masked: string;
}

export interface AsrConfig {
  api_key_masked: string;
  api_base_url: string;
  model: string;
}

export async function getAdminStats(): Promise<ApiResponse<AdminStats>> {
  return request<AdminStats>('/api/admin/stats');
}

export async function listAdminUsers(
  page = 1,
  perPage = 20,
  q?: string,
): Promise<ApiResponse<{ items: AdminUser[]; total: number; page: number; per_page: number }>> {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (q) params.set('q', q);
  return request<{ items: AdminUser[]; total: number; page: number; per_page: number }>(`/api/admin/users?${params.toString()}`);
}

export async function patchAdminUser(
  id: string,
  body: { is_active?: boolean; is_admin?: boolean; username?: string; email?: string },
): Promise<ApiResponse<AdminUser>> {
  return request<AdminUser>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteAdminUser(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

export interface AdminUserRecentNote {
  id: string;
  video_title: string;
  card_type: string;
  created_at: string | null;
}
export interface AdminUserRecentPlan {
  id: string;
  title: string;
  status: string;
  total_days: number;
  created_at: string | null;
}
export interface AdminUserDetail extends AdminUser {
  notes_count: number;
  plans_count: number;
  recent_notes: AdminUserRecentNote[];
  recent_plans: AdminUserRecentPlan[];
}

export async function getAdminUserDetail(id: string): Promise<ApiResponse<AdminUserDetail>> {
  return request<AdminUserDetail>(`/api/admin/users/${id}`);
}

export async function resetAdminUserPassword(
  id: string,
  newPassword: string,
): Promise<ApiResponse<{ reset: boolean }>> {
  return request<{ reset: boolean }>(`/api/admin/users/${id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ new_password: newPassword }),
  });
}

export async function listAdminNotes(
  page = 1,
  perPage = 20,
  search?: string,
  cardType?: string,
): Promise<ApiResponse<{ items: AdminNoteItem[]; total: number }>> {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (search) params.set('search', search);
  if (cardType) params.set('card_type', cardType);
  return request<{ items: AdminNoteItem[]; total: number }>(`/api/admin/notes?${params.toString()}`);
}

export async function deleteAdminNote(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(`/api/admin/notes/${id}`, { method: 'DELETE' });
}

export async function reExtractNote(id: string): Promise<ApiResponse<Note>> {
  return request<Note>(`/api/admin/notes/${id}/re-extract`, { method: 'POST' });
}

export async function batchDeleteAdminNotes(ids: string[]): Promise<ApiResponse<{ deleted: number }>> {
  return request<{ deleted: number }>(`/api/admin/notes/batch-delete`, {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function getLlmConfig(): Promise<ApiResponse<LlmConfig>> {
  return request<LlmConfig>('/api/admin/llm-config');
}

export async function putLlmConfig(
  body: { model?: string; api_base?: string; api_key?: string },
): Promise<ApiResponse<LlmConfig>> {
  return request<LlmConfig>('/api/admin/llm-config', { method: 'PUT', body: JSON.stringify(body) });
}

export async function getAsrConfig(): Promise<ApiResponse<AsrConfig>> {
  return request<AsrConfig>('/api/admin/asr-config');
}

export async function putAsrConfig(
  body: { api_key?: string; api_base_url?: string; model?: string },
): Promise<ApiResponse<AsrConfig>> {
  return request<AsrConfig>('/api/admin/asr-config', { method: 'PUT', body: JSON.stringify(body) });
}

export interface AdminAuditLog {
  id: number;
  admin_user_id: string;
  admin_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export async function listAdminAuditLogs(
  page = 1,
  perPage = 20,
  action?: string,
): Promise<ApiResponse<{ items: AdminAuditLog[]; total: number; page: number; per_page: number }>> {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (action) params.set('action', action);
  return request(`/api/admin/audit-logs?${params.toString()}`);
}

export interface AdminPlanItem {
  id: string;
  title: string;
  user_id: string;
  author: string;
  status: string;
  total_days: number;
  created_at: string;
}

export async function listAdminPlans(
  page = 1,
  perPage = 20,
  q?: string,
): Promise<ApiResponse<{ items: AdminPlanItem[]; total: number; page: number; per_page: number }>> {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (q) params.set('q', q);
  return request(`/api/admin/plans?${params.toString()}`);
}

export async function deleteAdminPlan(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(`/api/admin/plans/${id}`, { method: 'DELETE' });
}

export interface ConfigTestResult {
  ok: boolean;
  error?: string;
  reply?: string;
  note?: string;
  model?: string;
  status?: number;
}

export async function testLlmConfig(): Promise<ApiResponse<ConfigTestResult>> {
  return request<ConfigTestResult>('/api/admin/llm-config/test', { method: 'POST' });
}

export async function testAsrConfig(): Promise<ApiResponse<ConfigTestResult>> {
  return request<ConfigTestResult>('/api/admin/asr-config/test', { method: 'POST' });
}

export interface SystemInfo {
  db_type: string;
  llm_model: string;
  llm_api_base: string;
  llm_key_set: boolean;
  asr_model: string;
  asr_api_base_url: string;
  asr_key_set: boolean;
  encryption_key_set: boolean;
  jwt_secret_set: boolean;
  users: number;
  notes: number;
  plans: number;
}

export async function getSystemInfo(): Promise<ApiResponse<SystemInfo>> {
  return request<SystemInfo>('/api/admin/system-info');
}

export interface AdminOps {
  table_counts: { users: number; notes: number; plans: number; audit_logs: number };
  recent_audit: AdminAuditLog[];
  keys: {
    llm_key_set: boolean;
    asr_key_set: boolean;
    encryption_key_set: boolean;
    jwt_secret_set: boolean;
  };
  db_type: string;
}

export async function getAdminOps(): Promise<ApiResponse<AdminOps>> {
  return request<AdminOps>('/api/admin/ops');
}
