import { ApiResponse, CardData, Note, NoteDetail, PaginatedResponse, VideoInfo, PlanData, PlanStats } from './types';

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
    const sseBase = API_BASE || 'http://localhost:8000';
    const response = await fetch(`${sseBase}/api/extract/stream?url=${encoded}`, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      let msg = `Request failed with status ${response.status}`;
      if (response.status === 401) {
        msg = '请先登录';
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
