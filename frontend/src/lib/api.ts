import type {
  AgentAutomation,
  AgentAutomationCreate,
  AgentAutomationList,
  AgentAutomationRun,
  AgentAutomationRunList,
  AgentAutomationUpdate,
  AgentEmailVerificationConfirmResult,
  AgentEmailVerificationSendResult,
  AgentEmailStatus,
  AgentMessage,
  AgentMessageCreate,
  AgentMessageResult,
  AgentSourceList,
  AgentSourceScope,
  AgentThread,
  AgentThreadCreate,
  AgentThreadList,
  AgentThreadUpdate,
  ApiResponse,
  CardData,
  DouyinCollectionJob,
  DouyinBatchExtractionJob,
  DouyinBatchExtractionOperation,
  DouyinLibraryItem,
  DouyinLibraryListResult,
  DouyinLocalHandoff,
  DouyinPermanentHiddenItem,
  DouyinLibrarySort,
  DouyinLibraryStatus,
  DouyinLoginStatus,
  DouyinSourceMode,
  DouyinVideoWorkspace,
  FeedbackCategory,
  FeedbackItem,
  FeedbackPage,
  FeedbackStatus,
  LibraryAskResult,
  LibraryOutputStyle,
  LibraryResearchMode,
  Note,
  NoteAskResult,
  NoteChatTurn,
  NoteDetail,
  PaginatedResponse,
  PlanData,
  PlanAgentResult,
  PlanOverview,
  PlanPriority,
  PlanStats,
  ResearchScope,
  VideoInfo,
} from './types';
export type { ApiResponse };

// In Capacitor/static-export mode, NEXT_PUBLIC_API_URL is set explicitly
// (e.g. http://localhost:8000 or http://10.60.10.75:8000).
// Development can either set a local backend URL or leave it empty to use
// the Next.js /api rewrite.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Attach JWT to every API call automatically. */
function authHeaders(extra?: HeadersInit, hasJsonBody = false): Headers {
  const headers = new Headers(extra);
  if (hasJsonBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (typeof window !== 'undefined') {
    try {
      const token = localStorage.getItem('zhicui_token');
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } catch {}
  }
  return headers;
}

function validationMessages(detail: unknown): string[] {
  if (!Array.isArray(detail)) return [];
  return detail.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.msg === 'string') return [item.msg];
    return [];
  });
}

function validationLocations(detail: unknown): string[] {
  if (!Array.isArray(detail)) return [];
  return detail.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.loc)) return [];
    return [item.loc.map(String).join('.')];
  });
}

async function responseErrorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const data = isRecord(payload) ? payload : {};

  if (response.status === 401) return '请先登录';
  if (response.status === 422) {
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    const locations = validationLocations(data.detail);
    return locations.some((location) => location.includes('url'))
      ? '请输入有效的视频链接'
      : '输入有误，请检查后再试';
  }

  if (typeof data.error === 'string' && data.error) return data.error;
  if (typeof data.detail === 'string' && data.detail) return data.detail;
  const messages = validationMessages(data.detail);
  if (messages.length > 0) return messages.join('；');
  if (typeof data.message === 'string' && data.message) return data.message;
  return `请求失败（${response.status}）`;
}

function requestFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? '请求已取消' : error.message;
  }
  return '网络连接失败';
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const { headers, ...rest } = options || {};
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...rest,
      headers: authHeaders(headers, typeof rest.body === 'string'),
    });

    if (!response.ok) {
      return { success: false, error: await responseErrorMessage(response) };
    }

    const json: unknown = await response.json().catch(() => null);
    // Backend returns {success, data, error} envelope — unwrap it.
    if (isRecord(json) && typeof json.success === 'boolean') {
      return {
        success: json.success,
        data: json.data as T | undefined,
        error: typeof json.error === 'string' ? json.error : undefined,
      };
    }
    return { success: true, data: json as T };
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export async function extractVideo(url: string): Promise<ApiResponse<CardData>> {
  return request<CardData>('/api/extract', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export interface SubmitFeedbackBody {
  category: FeedbackCategory;
  subject: string;
  content: string;
  page_path: string;
  platform: 'web' | 'android' | 'capacitor';
  user_agent: string;
  viewport: string;
  app_version: string;
}

export async function submitFeedback(
  body: SubmitFeedbackBody,
): Promise<ApiResponse<FeedbackItem>> {
  return request<FeedbackItem>('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listMyFeedback(
  page = 1,
  perPage = 10,
): Promise<ApiResponse<FeedbackPage>> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  return request<FeedbackPage>(`/api/feedback?${params.toString()}`);
}

/** Metadata carried by intermediate SSE progress events. */
export interface ProgressEventData {
  phase?: string;
  platform?: string;
  provider?: string;
  model?: string;
  elapsed_ms?: number;
  duration_ms?: number;
  transcript_chars?: number;
  fallback?: boolean;
  level?: 'info' | 'warning';
  [key: string]: unknown;
}

/** SSE progress event emitted by /api/extract/stream */
export interface ProgressEvent {
  step: string;
  message: string;
  status: 'active' | 'done' | 'error';
  data?: CardData | ProgressEventData;
}

function parseProgressEvent(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trimStart();
  if (!payload || payload === '[DONE]') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (
    !isRecord(parsed)
    || typeof parsed.step !== 'string'
    || typeof parsed.message !== 'string'
    || !['active', 'done', 'error'].includes(String(parsed.status))
  ) {
    return null;
  }
  return parsed as unknown as ProgressEvent;
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
  signal?: AbortSignal,
): Promise<ApiResponse<CardData>> {
  const encoded = encodeURIComponent(url);

  try {
    const sseBase = API_BASE || '';
    const response = await fetch(`${sseBase}/api/extract/stream?url=${encoded}`, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
      signal,
    });

    if (!response.ok) {
      return { success: false, error: await responseErrorMessage(response) };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'Stream not supported' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let finalData: CardData | undefined;

    const handleLine = (line: string): string | null => {
      const event = parseProgressEvent(line);
      if (!event) return null;

      // Consumer errors are application errors and must not be swallowed as
      // malformed SSE payloads.
      onProgress(event);
      if (event.step === 'done' && event.data) {
        finalData = event.data as CardData;
      }
      return event.step === 'error' ? event.message : null;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep last partial line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const streamError = handleLine(line);
        if (streamError) return { success: false, error: streamError };
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      const streamError = handleLine(line);
      if (streamError) return { success: false, error: streamError };
    }

    if (finalData) {
      return { success: true, data: finalData };
    }
    return { success: false, error: 'Stream ended without result' };
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export async function getVideoInfo(url: string): Promise<ApiResponse<VideoInfo>> {
  return request<VideoInfo>('/api/video/info', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function listNotes(
  page: number = 1,
  perPage: number = 12,
  query?: string,
  cardType?: Note['card_type'],
): Promise<ApiResponse<PaginatedResponse<Note>>> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  if (query?.trim()) params.set('q', query.trim());
  if (cardType) params.set('card_type', cardType);
  return request<PaginatedResponse<Note>>(`/api/notes?${params.toString()}`);
}

export async function getNote(id: string): Promise<ApiResponse<NoteDetail>> {
  return request<NoteDetail>(`/api/notes/${id}`);
}

export async function askNote(
  noteId: string,
  question: string,
  history: NoteChatTurn[] = [],
  signal?: AbortSignal,
  researchScope: ResearchScope = 'auto',
): Promise<ApiResponse<NoteAskResult>> {
  return request<NoteAskResult>(`/api/notes/${noteId}/ask`, {
    method: 'POST',
    body: JSON.stringify({
      question,
      history: history.slice(-6),
      research_scope: researchScope,
    }),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Douyin batch library API
// ---------------------------------------------------------------------------

export async function getDouyinLibraryStatus(): Promise<ApiResponse<DouyinLibraryStatus>> {
  return request<DouyinLibraryStatus>('/api/library/douyin/status');
}

export async function listDouyinLibraryItems(
  limit = 0,
  mode?: DouyinSourceMode,
  sort: DouyinLibrarySort = 'collection',
): Promise<ApiResponse<DouyinLibraryListResult>> {
  const params = new URLSearchParams({
    limit: String(Math.max(0, Math.min(limit, 10000))),
  });
  if (mode) params.set('mode', mode);
  params.set('sort', sort);
  return request<DouyinLibraryListResult>(
    `/api/library/douyin/items?${params.toString()}`,
  );
}

export async function getDouyinLibraryItem(
  awemeId: string,
): Promise<ApiResponse<DouyinVideoWorkspace>> {
  return request<DouyinVideoWorkspace>(
    `/api/library/douyin/items/${encodeURIComponent(awemeId)}`,
  );
}

export async function collectDouyinLibrary(
  count = 50,
  mode: DouyinSourceMode = 'like',
): Promise<ApiResponse<DouyinCollectionJob>> {
  const boundedCount = Math.max(1, Math.min(100, Math.trunc(count) || 50));
  return request<DouyinCollectionJob>('/api/library/douyin/collect', {
    method: 'POST',
    body: JSON.stringify({
      count: boundedCount,
      mode,
    }),
  });
}

export async function removeDouyinLibraryItems(
  awemeIds: string[],
  mode: 'temporary' | 'permanent' = 'temporary',
): Promise<ApiResponse<{
  removed: number;
  newly_removed: number;
  promoted: number;
  mode: 'temporary' | 'permanent';
  aweme_ids: string[];
}>> {
  return request('/api/library/douyin/items/remove', {
    method: 'POST',
    body: JSON.stringify({ aweme_ids: awemeIds, mode }),
  });
}

export async function listPermanentlyHiddenDouyinItems(
  limit = 100,
): Promise<ApiResponse<{
  items: DouyinPermanentHiddenItem[];
  total: number;
}>> {
  return request(`/api/library/douyin/hidden-items?limit=${Math.max(1, Math.min(limit, 1000))}`);
}

export async function restorePermanentlyHiddenDouyinItems(
  awemeIds: string[],
): Promise<ApiResponse<{
  restored: number;
  aweme_ids: string[];
}>> {
  return request('/api/library/douyin/hidden-items/restore', {
    method: 'POST',
    body: JSON.stringify({ aweme_ids: awemeIds }),
  });
}

export async function disconnectDouyinLibrary(
  action: 'logout' | 'rebind' = 'logout',
): Promise<ApiResponse<{
  disconnected: boolean;
  cookie_valid: boolean;
  cookie_count: number;
}>> {
  return request(`/api/library/douyin/${action}`, {
    method: 'POST',
  });
}

export async function startDouyinLogin(): Promise<ApiResponse<DouyinLoginStatus>> {
  return request<DouyinLoginStatus>('/api/library/douyin/login', {
    method: 'POST',
    body: JSON.stringify({ browser: 'chromium' }),
  });
}

export async function createDouyinLocalHandoff(): Promise<ApiResponse<DouyinLocalHandoff>> {
  return request<DouyinLocalHandoff>('/api/library/douyin/local-handoff', {
    method: 'POST',
  });
}

export async function getDouyinLoginStatus(): Promise<ApiResponse<DouyinLoginStatus>> {
  return request<DouyinLoginStatus>('/api/library/douyin/login');
}

export async function cancelDouyinLogin(): Promise<ApiResponse<DouyinLoginStatus & {
  cancelled: boolean;
}>> {
  return request<DouyinLoginStatus & { cancelled: boolean }>(
    '/api/library/douyin/login',
    { method: 'DELETE' },
  );
}

export async function getDouyinLoginQr(): Promise<ApiResponse<{
  image_data_url: string;
  qr_version: number;
}>> {
  return request<{
    image_data_url: string;
    qr_version: number;
  }>('/api/library/douyin/login/qr');
}

export async function getDouyinCollectionJob(
  jobId: string,
): Promise<ApiResponse<DouyinCollectionJob>> {
  return request<DouyinCollectionJob>(
    `/api/library/douyin/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function extractDouyinLibraryItem(
  awemeId: string,
  operation: DouyinBatchExtractionOperation = 'full',
): Promise<ApiResponse<CardData & { already_existed?: boolean }>> {
  return request<CardData & { already_existed?: boolean }>(
    '/api/library/douyin/extract',
    {
      method: 'POST',
      body: JSON.stringify({ aweme_id: awemeId, operation }),
    },
  );
}

export async function startDouyinBatchExtraction(
  awemeIds: string[],
  operation: DouyinBatchExtractionOperation = 'full',
): Promise<ApiResponse<DouyinBatchExtractionJob>> {
  return request<DouyinBatchExtractionJob>(
    '/api/library/douyin/extractions/batch',
    {
      method: 'POST',
      body: JSON.stringify({
        aweme_ids: awemeIds.slice(0, operation === 'transcript' ? 100 : 50),
        operation,
      }),
    },
  );
}

export async function getDouyinBatchExtraction(
  jobId: string,
): Promise<ApiResponse<DouyinBatchExtractionJob>> {
  return request<DouyinBatchExtractionJob>(
    `/api/library/douyin/extractions/batch/${encodeURIComponent(jobId)}`,
  );
}

export async function deleteDouyinLibraryExtraction(
  noteId: string,
): Promise<ApiResponse<{
  deleted: boolean;
  plans_deleted: number;
  media_preserved: boolean;
}>> {
  return request<{
    deleted: boolean;
    plans_deleted: number;
    media_preserved: boolean;
  }>(`/api/library/douyin/extractions/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  });
}

export async function askVideoLibrary(
  noteIds: string[],
  question: string,
  history: NoteChatTurn[] = [],
  signal?: AbortSignal,
  options?: {
    researchMode?: LibraryResearchMode;
    outputStyle?: LibraryOutputStyle;
    customInstruction?: string;
    webScope?: ResearchScope;
  },
): Promise<ApiResponse<LibraryAskResult>> {
  return request<LibraryAskResult>('/api/library/ask', {
    method: 'POST',
    body: JSON.stringify({
      note_ids: noteIds.slice(0, 50),
      question,
      history: history.slice(-6),
      research_mode: options?.researchMode || 'fast',
      output_style: options?.outputStyle || 'answer',
      custom_instruction: options?.customInstruction?.trim() || '',
      web_scope: options?.webScope || 'auto',
    }),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Video Agent workspace
// ---------------------------------------------------------------------------

export async function listAgentSources(
  scope: Exclude<AgentSourceScope, 'selected'> = 'all_ready',
  query = '',
): Promise<ApiResponse<AgentSourceList>> {
  const params = new URLSearchParams({ scope });
  if (query.trim()) params.set('q', query.trim());
  return request<AgentSourceList>(`/api/agent/sources?${params.toString()}`);
}

interface LegacyAgentPayload {
  answer: string;
  grounded?: boolean;
  evidence?: NonNullable<AgentMessage['evidence']>;
  follow_up_questions?: string[];
  source_context?: NonNullable<AgentMessage['source_context']>;
  web_sources?: NonNullable<AgentMessage['web_sources']>;
}

function parseJsonLike(value: string): unknown {
  let candidate = value.trim();
  if (!candidate) return null;

  const fenced = candidate.match(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
  );
  if (fenced?.[1]) candidate = fenced[1].trim();

  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        candidate = parsed.trim();
        continue;
      }
      return parsed;
    } catch {
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const objectCandidate = candidate.slice(firstBrace, lastBrace + 1);
        if (objectCandidate !== candidate) {
          candidate = objectCandidate;
          continue;
        }
      }
      return null;
    }
  }
  return null;
}

function extractLegacyJsonField(content: string, key: string): unknown {
  const marker = new RegExp(
    `"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*`,
  ).exec(content);
  if (!marker) return undefined;

  const start = marker.index + marker[0].length;
  const first = content[start];
  if (!first) return undefined;

  if (first === '"') {
    let escaped = false;
    for (let index = start + 1; index < content.length; index += 1) {
      const character = content[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(content.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  if (first === '[' || first === '{') {
    const opening = first;
    const closing = first === '[' ? ']' : '}';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          quoted = false;
        }
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === opening) depth += 1;
      if (character === closing) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(content.slice(start, index + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  const token = content.slice(start).match(/^(true|false|null|-?\d+(?:\.\d+)?)/);
  if (!token) return undefined;
  try {
    return JSON.parse(token[1]);
  } catch {
    return undefined;
  }
}

function decodeLegacyAgentPayload(content: string): LegacyAgentPayload | null {
  const parsed = parseJsonLike(content);
  const value: Record<string, unknown> = (
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  )
    ? parsed as Record<string, unknown>
    : {
      answer: extractLegacyJsonField(content, 'answer'),
      grounded: extractLegacyJsonField(content, 'grounded'),
      evidence: extractLegacyJsonField(content, 'evidence'),
      follow_up_questions:
        extractLegacyJsonField(content, 'follow_up_questions'),
      source_context: extractLegacyJsonField(content, 'source_context'),
      web_sources: extractLegacyJsonField(content, 'web_sources'),
    };

  if (typeof value.answer !== 'string' || !value.answer.trim()) {
    return null;
  }

  const evidence = Array.isArray(value.evidence)
    ? value.evidence.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (
        typeof row.note_id !== 'string'
        || typeof row.quote !== 'string'
        || !row.quote.trim()
      ) {
        return [];
      }
      return [{
        note_id: row.note_id,
        title:
          typeof row.title === 'string' && row.title.trim()
            ? row.title
            : '视频原文',
        quote: row.quote,
        source: row.source === 'summary' ? 'summary' as const : 'transcript' as const,
        position_percent:
          typeof row.position_percent === 'number'
            ? row.position_percent
            : undefined,
      }];
    })
    : undefined;

  const followUps = Array.isArray(value.follow_up_questions)
    ? value.follow_up_questions.filter(
      (item): item is string => typeof item === 'string' && Boolean(item.trim()),
    )
    : undefined;

  return {
    answer: value.answer.trim(),
    grounded: typeof value.grounded === 'boolean' ? value.grounded : undefined,
    evidence,
    follow_up_questions: followUps,
    source_context:
      value.source_context
      && typeof value.source_context === 'object'
      && !Array.isArray(value.source_context)
        ? value.source_context as NonNullable<AgentMessage['source_context']>
        : undefined,
    web_sources: Array.isArray(value.web_sources)
      ? value.web_sources as NonNullable<AgentMessage['web_sources']>
      : undefined,
  };
}

function normalizeAgentMessage(message: AgentMessage): AgentMessage {
  const legacyPayload = decodeLegacyAgentPayload(message.content);
  const result = message.result;
  return {
    ...message,
    content:
      message.role === 'assistant' && legacyPayload?.answer
        ? legacyPayload.answer
        : message.content,
    grounded:
      legacyPayload?.grounded
      ?? message.grounded
      ?? result?.grounded,
    grounding_status:
      message.grounding_status
      ?? result?.grounding_status,
    citation_coverage:
      message.citation_coverage
      ?? result?.citation_coverage,
    limitations:
      (message.limitations?.length ? message.limitations : undefined)
      ?? (result?.limitations?.length ? result.limitations : undefined)
      ?? [],
    evidence:
      (legacyPayload?.evidence?.length ? legacyPayload.evidence : undefined)
      ?? (message.evidence?.length ? message.evidence : undefined)
      ?? (result?.evidence?.length ? result.evidence : undefined)
      ?? [],
    follow_up_questions:
      (legacyPayload?.follow_up_questions?.length
        ? legacyPayload.follow_up_questions
        : undefined)
      ?? (message.follow_up_questions?.length
        ? message.follow_up_questions
        : undefined)
      ?? (result?.follow_up_questions?.length
        ? result.follow_up_questions
        : undefined)
      ?? [],
    source_context:
      message.source_context
      ?? result?.source_context
      ?? legacyPayload?.source_context
      ?? null,
    web_sources:
      (legacyPayload?.web_sources?.length ? legacyPayload.web_sources : undefined)
      ?? (message.web_sources?.length ? message.web_sources : undefined)
      ?? (result?.web_sources?.length ? result.web_sources : undefined)
      ?? [],
  };
}

function normalizeAgentThread(thread: AgentThread): AgentThread {
  const legacyPreview = thread.last_message
    ? decodeLegacyAgentPayload(thread.last_message)
    : null;
  return {
    ...thread,
    last_message: legacyPreview?.answer || thread.last_message,
    messages: thread.messages?.map(normalizeAgentMessage),
  };
}

export async function listAgentThreads(): Promise<ApiResponse<AgentThreadList>> {
  const response = await request<AgentThreadList>('/api/agent/threads');
  if (response.data) {
    response.data = {
      ...response.data,
      items: response.data.items.map(normalizeAgentThread),
    };
  }
  return response;
}

export async function createAgentThread(
  body: AgentThreadCreate,
): Promise<ApiResponse<AgentThread>> {
  const response = await request<AgentThread>('/api/agent/threads', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (response.data) response.data = normalizeAgentThread(response.data);
  return response;
}

export async function getAgentThread(
  threadId: string,
): Promise<ApiResponse<AgentThread>> {
  const response = await request<AgentThread>(
    `/api/agent/threads/${encodeURIComponent(threadId)}`,
  );
  if (response.data) response.data = normalizeAgentThread(response.data);
  return response;
}

export async function updateAgentThread(
  threadId: string,
  body: AgentThreadUpdate,
): Promise<ApiResponse<AgentThread>> {
  const response = await request<AgentThread>(
    `/api/agent/threads/${encodeURIComponent(threadId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
  if (response.data) response.data = normalizeAgentThread(response.data);
  return response;
}

export async function deleteAgentThread(
  threadId: string,
): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(
    `/api/agent/threads/${encodeURIComponent(threadId)}`,
    { method: 'DELETE' },
  );
}

export async function sendAgentMessage(
  threadId: string,
  body: AgentMessageCreate,
  signal?: AbortSignal,
): Promise<ApiResponse<AgentMessageResult>> {
  const response = await request<AgentMessageResult>(
    `/api/agent/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        content: body.content.trim(),
        custom_instruction: body.custom_instruction?.trim() || '',
      }),
      signal,
    },
  );
  if (response.data) {
    response.data = {
      ...response.data,
      thread: normalizeAgentThread(response.data.thread),
      user_message: normalizeAgentMessage(response.data.user_message),
      assistant_message: normalizeAgentMessage(response.data.assistant_message),
    };
  }
  return response;
}

export async function listAgentAutomations(): Promise<ApiResponse<AgentAutomationList>> {
  return request<AgentAutomationList>('/api/agent/automations');
}

export async function createAgentAutomation(
  body: AgentAutomationCreate,
): Promise<ApiResponse<AgentAutomation>> {
  return request<AgentAutomation>('/api/agent/automations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateAgentAutomation(
  automationId: string,
  body: AgentAutomationUpdate,
): Promise<ApiResponse<AgentAutomation>> {
  return request<AgentAutomation>(
    `/api/agent/automations/${encodeURIComponent(automationId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

export async function deleteAgentAutomation(
  automationId: string,
): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(
    `/api/agent/automations/${encodeURIComponent(automationId)}`,
    { method: 'DELETE' },
  );
}

export async function runAgentAutomation(
  automationId: string,
): Promise<ApiResponse<AgentAutomationRun>> {
  return request<AgentAutomationRun>(
    `/api/agent/automations/${encodeURIComponent(automationId)}/run`,
    {
      method: 'POST',
      body: JSON.stringify({ deliver: false }),
    },
  );
}

export async function listAgentAutomationRuns(
  automationId: string,
): Promise<ApiResponse<AgentAutomationRunList>> {
  return request<AgentAutomationRunList>(
    `/api/agent/automations/${encodeURIComponent(automationId)}/runs`,
  );
}

export async function getAgentEmailStatus(): Promise<ApiResponse<AgentEmailStatus>> {
  return request<AgentEmailStatus>('/api/agent/email/status');
}

export async function sendAgentEmailVerification(): Promise<
  ApiResponse<AgentEmailVerificationSendResult>
> {
  return request<AgentEmailVerificationSendResult>(
    '/api/agent/email/verification/send',
    { method: 'POST' },
  );
}

export async function confirmAgentEmailVerification(
  token: string,
): Promise<ApiResponse<AgentEmailVerificationConfirmResult>> {
  return request<AgentEmailVerificationConfirmResult>(
    '/api/agent/email/verification/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ token }),
    },
  );
}

export async function runNotePlanAgent(
  noteId: string,
  instruction: string,
): Promise<ApiResponse<PlanAgentResult>> {
  return request<PlanAgentResult>(`/api/notes/${encodeURIComponent(noteId)}/plan-agent`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
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

export async function getPlanOverview(): Promise<ApiResponse<PlanOverview>> {
  return request<PlanOverview>('/api/plans/overview');
}

export async function updatePlan(
  planId: string,
  updates: { title?: string; status?: 'active' | 'done' },
): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function togglePlanTask(planId: string, taskId: string): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks/${taskId}`, { method: 'PATCH' });
}

export interface PlanTaskMutation {
  title: string;
  day?: number;
  scheduled_at?: string | null;
  duration_minutes?: number | null;
  frequency?: string | null;
  priority?: PlanPriority;
}

export async function addPlanTask(planId: string, task: PlanTaskMutation): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks`, {
    method: 'POST',
    body: JSON.stringify(task),
  });
}

export async function updatePlanTask(
  planId: string,
  taskId: string,
  updates: Partial<PlanTaskMutation>,
): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
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

export interface AdminFeedbackItem extends FeedbackItem {
  client_context: {
    platform?: string | null;
    user_agent?: string | null;
    viewport?: string | null;
    app_version?: string | null;
  };
  user: {
    id: string;
    username: string | null;
    email: string;
  };
}

export interface AdminFeedbackPage {
  items: AdminFeedbackItem[];
  total: number;
  page: number;
  per_page: number;
  counts: Record<FeedbackStatus | 'total', number>;
}

export interface LlmConfig {
  provider: 'deepseek' | 'custom';
  model: string;
  api_base: string;
  api_key_masked: string;
  api_base_locked: boolean;
  available_models: string[];
}

export interface AsrConfig {
  api_key_masked: string;
  api_base_url: string;
  model: string;
}

export interface ExtractionConfig {
  asr_concurrency: number;
  llm_concurrency: number;
  max_asr_concurrency: number;
  max_llm_concurrency: number;
  max_batch_items: number;
  max_ai_batch_items: number;
  database_stores_media: false;
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

export async function listAdminFeedback(
  options: {
    page?: number;
    perPage?: number;
    status?: FeedbackStatus | '';
    category?: FeedbackCategory | '';
    q?: string;
  } = {},
): Promise<ApiResponse<AdminFeedbackPage>> {
  const params = new URLSearchParams({
    page: String(options.page || 1),
    per_page: String(options.perPage || 20),
  });
  if (options.status) params.set('status', options.status);
  if (options.category) params.set('category', options.category);
  if (options.q) params.set('q', options.q);
  return request<AdminFeedbackPage>(`/api/admin/feedback?${params.toString()}`);
}

export async function updateAdminFeedback(
  id: string,
  body: { status?: FeedbackStatus; admin_reply?: string },
): Promise<ApiResponse<AdminFeedbackItem>> {
  return request<AdminFeedbackItem>(`/api/admin/feedback/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function getLlmConfig(): Promise<ApiResponse<LlmConfig>> {
  return request<LlmConfig>('/api/admin/llm-config');
}

export async function putLlmConfig(
  body: { provider?: 'deepseek' | 'custom'; model?: string; api_base?: string; api_key?: string },
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

export async function getExtractionConfig(): Promise<ApiResponse<ExtractionConfig>> {
  return request<ExtractionConfig>('/api/admin/extraction-config');
}

export async function putExtractionConfig(
  body: { asr_concurrency: number; llm_concurrency: number },
): Promise<ApiResponse<ExtractionConfig>> {
  return request<ExtractionConfig>('/api/admin/extraction-config', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
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

export interface LlmUsageSummary {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  active_users: number;
}

export interface LlmUsageModel {
  provider: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmUsageDaily {
  date: string;
  calls: number;
  total_tokens: number;
}

export interface LlmUsageItem {
  id: number;
  user_id: string | null;
  username: string;
  provider: string;
  model: string;
  operation: string;
  request_path: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

export interface LlmUsageReport {
  summary: LlmUsageSummary;
  by_model: LlmUsageModel[];
  daily: LlmUsageDaily[];
  items: LlmUsageItem[];
  total: number;
  page: number;
  per_page: number;
  days: number;
}

export async function getLlmUsage(
  days = 30,
  page = 1,
  perPage = 20,
  model?: string,
): Promise<ApiResponse<LlmUsageReport>> {
  const params = new URLSearchParams({
    days: String(days),
    page: String(page),
    per_page: String(perPage),
  });
  if (model) params.set('model', model);
  return request<LlmUsageReport>(`/api/admin/llm-usage?${params.toString()}`);
}

export interface UserActivityItem {
  id: number;
  user_id: string | null;
  username: string;
  action: string;
  action_label: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  ip: string | null;
  detail: Record<string, string | number>;
  detail_summary: string;
  created_at: string;
}

export interface UserActivityReport {
  summary: {
    total: number;
    today: number;
    active_users: number;
    errors: number;
  };
  items: UserActivityItem[];
  actions: { value: string; label: string }[];
  users: { value: string; label: string }[];
  total: number;
  page: number;
  per_page: number;
  days: number;
}

export async function getUserActivity(
  days = 30,
  page = 1,
  perPage = 20,
  action?: string,
  userId?: string,
): Promise<ApiResponse<UserActivityReport>> {
  const params = new URLSearchParams({
    days: String(days),
    page: String(page),
    per_page: String(perPage),
  });
  if (action) params.set('action', action);
  if (userId) params.set('user_id', userId);
  return request<UserActivityReport>(`/api/admin/user-activity?${params.toString()}`);
}

export interface ApplicationErrorItem {
  id: number;
  user_id: string | null;
  username: string;
  source: string;
  severity: 'warning' | 'error' | 'critical';
  error_type: string;
  message: string;
  traceback: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  ip: string | null;
  metadata: Record<string, string>;
  created_at: string;
}

export interface ApplicationErrorReport {
  summary: {
    total: number;
    today: number;
    critical: number;
    server_errors: number;
    affected_users: number;
  };
  by_source: { source: string; count: number }[];
  items: ApplicationErrorItem[];
  sources: string[];
  severities: string[];
  total: number;
  page: number;
  per_page: number;
  days: number;
}

export async function getApplicationErrors(
  days = 30,
  page = 1,
  perPage = 20,
  source?: string,
  severity?: string,
): Promise<ApiResponse<ApplicationErrorReport>> {
  const params = new URLSearchParams({
    days: String(days),
    page: String(page),
    per_page: String(perPage),
  });
  if (source) params.set('source', source);
  if (severity) params.set('severity', severity);
  return request<ApplicationErrorReport>(`/api/admin/error-logs?${params.toString()}`);
}

export async function reportClientError(body: {
  message: string;
  stack?: string;
  path?: string;
  error_type?: string;
  environment?: 'web' | 'capacitor';
  component?: string;
  digest?: string;
}): Promise<void> {
  await request<{ accepted: boolean }>('/api/client-errors', {
    method: 'POST',
    body: JSON.stringify(body),
  });
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
  table_counts: {
    users: number;
    notes: number;
    plans: number;
    audit_logs: number;
    llm_usage_logs: number;
    user_activity_logs: number;
    application_error_logs: number;
  };
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
