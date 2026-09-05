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
  AgentPlanChangeApplyResult,
  AgentSourceList,
  AgentSourceSearchResult,
  AgentSourceScope,
  AgentStarterQuestions,
  AgentStreamProgress,
  AgentThread,
  AgentTurn,
  AgentThreadCreate,
  AgentThreadList,
  AgentThreadUpdate,
  ApiResponse,
  CardData,
  CreatorSource,
  CreatorSourceItem,
  CreatorSourceListResult,
  CreatorSourcePlatform,
  CreatorSourcePreview,
  CreatorCatalogItemStatus,
  CreatorPaginatedResult,
  CreatorSyncOperation,
  CreatorSyncRun,
  CreatorSyncRunItem,
  DouyinCollectionJob,
  DouyinBatchExtractionJob,
  DouyinBatchExtractionOperation,
  DouyinLibraryItem,
  DouyinLibraryListResult,
  DouyinLocalSyncItem,
  DouyinLocalSyncResult,
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
  PlanCoachPreview,
  PlanOverview,
  PlanPriority,
  PlanStats,
  PlanWeeklyReview,
  PlatformLibraryImportResult,
  PlatformLibraryItem,
  PlatformLibraryListResult,
  PlatformLibraryPlatform,
  ResearchScope,
  AdminVideoAnalysisOffering,
  AdminVideoAnalysisSettings,
  AdminVideoAnalysisUsageReport,
  AdminVisionProvider,
  UserVisionProviderConfig,
  VideoAnalysisAccount,
  VideoAnalysisCatalog,
  VideoAnalysisLedgerEntry,
  VideoAnalysisPrepareResult,
  VideoAnalysisRun,
  VideoAnalysisRunPage,
  VideoAnalysisRunResult,
  VisualAskResult,
  VideoAnalysisTrigger,
  VideoInfo,
} from './types';
import { getEphemeralDouyinMediaSources } from './douyinDesktopSync';
export type { ApiResponse };

// In Capacitor/static-export mode, NEXT_PUBLIC_API_URL is set explicitly
// (e.g. http://localhost:8000 or http://10.60.10.75:8000).
// Development can either set a local backend URL or leave it empty to use
// the Next.js /api rewrite.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

function apiAssetUrl(value: string): string {
  if (!value.startsWith('/')) return value;
  return `${API_BASE.replace(/\/$/, '')}${value}`;
}

function normalizePlatformLibraryItem(item: PlatformLibraryItem): PlatformLibraryItem {
  return {
    ...item,
    cover_url: apiAssetUrl(item.cover_url || ''),
    media_url: apiAssetUrl(item.media_url || ''),
  };
}

function normalizeDouyinLibraryItem(item: DouyinLibraryItem): DouyinLibraryItem {
  return {
    ...item,
    cover_url: apiAssetUrl(item.cover_url || ''),
    cover_proxy_url: apiAssetUrl(item.cover_proxy_url || ''),
    media_url: apiAssetUrl(item.media_url || ''),
    gallery_images: item.gallery_images?.map((value) => apiAssetUrl(value)),
  };
}

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
  return responseErrorMessageFromPayload(response.status, payload);
}

function responseErrorMessageFromPayload(status: number, payload: unknown): string {
  const data = isRecord(payload) ? payload : {};

  if (status === 401) return '请先登录';
  if (status === 422) {
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    if (isRecord(data.detail) && typeof data.detail.message === 'string') {
      return data.detail.message;
    }
    const locations = validationLocations(data.detail);
    return locations.some((location) => location.includes('url'))
      ? '请输入有效的视频链接'
      : '输入有误，请检查后再试';
  }

  if (typeof data.error === 'string' && data.error) return data.error;
  if (typeof data.detail === 'string' && data.detail) return data.detail;
  if (isRecord(data.detail) && typeof data.detail.message === 'string') {
    return data.detail.message;
  }
  const messages = validationMessages(data.detail);
  if (messages.length > 0) return messages.join('；');
  if (typeof data.message === 'string' && data.message) return data.message;
  return `请求失败（${status}）`;
}

function responseErrorDetails(payload: unknown): ApiResponse<never>['error_details'] {
  const data = isRecord(payload) ? payload : {};
  const detail = isRecord(data.detail) ? data.detail : null;
  if (!detail) return undefined;
  const code = typeof detail.code === 'string' ? detail.code : undefined;
  const sourceMode = typeof detail.source_mode === 'string'
    ? detail.source_mode
    : undefined;
  const retryAfter = typeof detail.retry_after_seconds === 'number'
    ? Math.max(0, Math.min(21600, Math.trunc(detail.retry_after_seconds)))
    : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof detail.needs_action === 'boolean'
      ? { needs_action: detail.needs_action }
      : {}),
    ...(sourceMode ? { source_mode: sourceMode } : {}),
    ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
  };
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
      const payload: unknown = await response.json().catch(() => null);
      return {
        success: false,
        error: responseErrorMessageFromPayload(response.status, payload),
        status: response.status,
        error_details: responseErrorDetails(payload),
      };
    }

    const json: unknown = await response.json().catch(() => null);
    // Backend returns {success, data, error} envelope — unwrap it.
    if (isRecord(json) && typeof json.success === 'boolean') {
      return {
        success: json.success,
        data: json.data as T | undefined,
        error: typeof json.error === 'string' ? json.error : undefined,
        status: response.status,
      };
    }
    return { success: true, data: json as T, status: response.status };
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export type ZhicuiClientType = 'web' | 'windows' | 'android' | 'ios';

export interface AccountDeletionPreparation {
  confirmation_token: string;
  expires_at: string;
  confirmation_phrase: string;
  impact: string[];
}

export async function downloadPersonalDataArchive(body: {
  password: string;
  client_type: ZhicuiClientType;
}): Promise<ApiResponse<{ blob: Blob; filename: string }>> {
  try {
    const response = await fetch(`${API_BASE}/api/account/data-export`, {
      method: 'POST',
      headers: authHeaders(undefined, true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return {
        success: false,
        error: await responseErrorMessage(response),
        status: response.status,
      };
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || 'zhicui-personal-data.zip';
    return {
      success: true,
      data: { blob: await response.blob(), filename },
      status: response.status,
    };
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export async function prepareAccountDeletion(body: {
  password: string;
  client_type: ZhicuiClientType;
}): Promise<ApiResponse<AccountDeletionPreparation>> {
  return request<AccountDeletionPreparation>('/api/account/deletion/prepare', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function confirmAccountDeletion(body: {
  confirmation_token: string;
  confirmation_phrase: string;
}): Promise<ApiResponse<{ deleted: boolean; audit_event_id: string }>> {
  return request<{ deleted: boolean; audit_event_id: string }>(
    '/api/account/deletion/confirm',
    { method: 'POST', body: JSON.stringify(body) },
  );
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
export interface ExtractionVideoPreview {
  title: string;
  video_id: string;
  platform: string;
  source_url: string;
  media_url: string;
  cover_url: string;
  author_name: string;
}

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
  video?: ExtractionVideoPreview;
  transcript?: string;
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

export async function askVisualLibraryItem(
  itemId: string,
  question: string,
  history: NoteChatTurn[] = [],
  signal?: AbortSignal,
): Promise<ApiResponse<VisualAskResult>> {
  return request<VisualAskResult>(
    `/api/library/douyin/items/${encodeURIComponent(itemId)}/visual-ask`,
    {
      method: 'POST',
      body: JSON.stringify({
        question,
        history: history.slice(-6),
      }),
      signal,
    },
  );
}

// ---------------------------------------------------------------------------
// On-demand detailed video analysis API
// ---------------------------------------------------------------------------

export async function getVideoAnalysisCatalog(
  noteIds: string[] = [],
  trigger: VideoAnalysisTrigger = 'manual',
): Promise<ApiResponse<VideoAnalysisCatalog>> {
  const params = new URLSearchParams();
  const cleanIds = [...new Set(noteIds.map(id => id.trim()).filter(Boolean))];
  if (cleanIds.length) params.set('note_ids', cleanIds.join(','));
  params.set('trigger', trigger);
  return request<VideoAnalysisCatalog>(
    `/api/video-analysis/catalog${params.size ? `?${params.toString()}` : ''}`,
  );
}

export async function prepareVideoAnalysis(body: {
  note_ids: string[];
  offering_id?: string;
  use_byok?: boolean;
  trigger?: VideoAnalysisTrigger;
}): Promise<ApiResponse<VideoAnalysisPrepareResult>> {
  return request<VideoAnalysisPrepareResult>('/api/video-analysis/runs/prepare', {
    method: 'POST',
    body: JSON.stringify({
      note_ids: [...new Set(body.note_ids.map(id => id.trim()).filter(Boolean))],
      ...(body.offering_id ? { offering_id: body.offering_id } : {}),
      ...(body.use_byok ? { use_byok: true } : {}),
      trigger: body.trigger || 'manual',
    }),
  });
}

export async function confirmVideoAnalysisRun(
  runId: string,
  idempotencyKey: string,
): Promise<ApiResponse<VideoAnalysisRunResult>> {
  return request<VideoAnalysisRunResult>(
    `/api/video-analysis/runs/${encodeURIComponent(runId)}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    },
  );
}

export async function getVideoAnalysisRun(
  runId: string,
): Promise<ApiResponse<VideoAnalysisRunResult>> {
  return request<VideoAnalysisRunResult>(
    `/api/video-analysis/runs/${encodeURIComponent(runId)}`,
  );
}

export async function listVideoAnalysisRuns(
  scope: 'active' | 'recent' = 'active',
  page = 1,
  perPage = 20,
): Promise<ApiResponse<VideoAnalysisRunPage>> {
  const params = new URLSearchParams({
    status: scope,
    page: String(Math.max(1, page)),
    per_page: String(Math.max(1, Math.min(perPage, 100))),
  });
  return request<VideoAnalysisRunPage>(
    `/api/video-analysis/runs?${params.toString()}`,
  );
}

export async function cancelVideoAnalysisRun(
  runId: string,
): Promise<ApiResponse<VideoAnalysisRunResult>> {
  return request<VideoAnalysisRunResult>(
    `/api/video-analysis/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  );
}

export async function getVideoAnalysisAccount(): Promise<ApiResponse<VideoAnalysisAccount>> {
  return request<VideoAnalysisAccount>('/api/user/video-analysis/account');
}

export async function getUserVisionProvider(): Promise<ApiResponse<UserVisionProviderConfig>> {
  return request<UserVisionProviderConfig>('/api/user/vision-provider');
}

export async function saveUserVisionProvider(body: {
  provider_name: string;
  driver: string;
  model: string;
  api_base: string;
  api_key?: string;
  enabled: boolean;
}): Promise<ApiResponse<UserVisionProviderConfig>> {
  return request<UserVisionProviderConfig>('/api/user/vision-provider', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteUserVisionProvider(): Promise<ApiResponse<UserVisionProviderConfig>> {
  return request<UserVisionProviderConfig>('/api/user/vision-provider', {
    method: 'DELETE',
  });
}

export async function testUserVisionProvider(
  signal?: AbortSignal,
): Promise<ApiResponse<{
  ok?: boolean;
  connected?: boolean;
  message?: string;
  provider?: string;
  model?: string;
  tested_at?: string;
  config?: UserVisionProviderConfig;
}>> {
  return request('/api/user/vision-provider/test', {
    method: 'POST',
    signal,
  });
}

// ---------------------------------------------------------------------------
// Douyin batch library API
// ---------------------------------------------------------------------------

export async function getDouyinLibraryStatus(): Promise<ApiResponse<DouyinLibraryStatus>> {
  return request<DouyinLibraryStatus>('/api/library/douyin/status');
}

export async function importPlatformLibraryItems(
  urls: string[],
  sourceMode?: 'collect' | 'like' | 'post',
): Promise<ApiResponse<PlatformLibraryImportResult>> {
  const response = await request<PlatformLibraryImportResult>('/api/library/imports', {
    method: 'POST',
    body: JSON.stringify({
      urls: urls.slice(0, 10),
      ...(sourceMode ? { source_mode: sourceMode } : {}),
    }),
  });
  if (!response.data) return response;
  return {
    ...response,
    data: {
      ...response.data,
      items: response.data.items.map((entry) => ({
        ...entry,
        item: entry.item ? normalizePlatformLibraryItem(entry.item) : undefined,
      })),
    },
  };
}

export async function listPlatformLibraryItems(
  platform: 'all' | PlatformLibraryPlatform = 'all',
): Promise<ApiResponse<PlatformLibraryListResult>> {
  const response = await request<PlatformLibraryListResult>(
    `/api/library/imports?platform=${encodeURIComponent(platform)}`,
  );
  if (!response.data) return response;
  return {
    ...response,
    data: {
      ...response.data,
      items: response.data.items.map(normalizePlatformLibraryItem),
    },
  };
}

export async function getPlatformLibraryItem(
  noteId: string,
  refreshMedia = false,
): Promise<ApiResponse<DouyinVideoWorkspace>> {
  const response = await request<DouyinVideoWorkspace>(
    `/api/library/imports/${encodeURIComponent(noteId)}${refreshMedia ? '?refresh_media=true' : ''}`,
  );
  if (!response.data) return response;
  return {
    ...response,
    data: {
      ...response.data,
      item: normalizeDouyinLibraryItem(response.data.item),
    },
  };
}

export async function initializePlatformLibraryItem(
  noteId: string,
): Promise<ApiResponse<{ note: NoteDetail; already_existed: boolean }>> {
  return request(`/api/library/imports/${encodeURIComponent(noteId)}/initialize`, {
    method: 'POST',
  });
}

export async function deletePlatformLibraryItem(
  noteId: string,
): Promise<ApiResponse<{ deleted: boolean; database_media_deleted: false }>> {
  return request(`/api/library/imports/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  });
}

export async function listCreatorSources(): Promise<ApiResponse<CreatorSourceListResult>> {
  return request<CreatorSourceListResult>('/api/creator-sources');
}

export async function resolveCreatorSource(
  platform: CreatorSourcePlatform,
  profileRef: string,
): Promise<ApiResponse<CreatorSourcePreview>> {
  return request<CreatorSourcePreview>('/api/creator-sources/resolve', {
    method: 'POST',
    body: JSON.stringify({ platform, profile_ref: profileRef.trim() }),
  });
}

export async function saveCreatorSource(
  platform: CreatorSourcePlatform,
  profileRef: string,
): Promise<ApiResponse<{ item: CreatorSource; reused: boolean }>> {
  return request('/api/creator-sources', {
    method: 'POST',
    body: JSON.stringify({ platform, profile_ref: profileRef.trim() }),
  });
}

export async function deleteCreatorSource(
  sourceId: string,
): Promise<ApiResponse<{ deleted: boolean; materials_preserved: boolean }>> {
  return request(`/api/creator-sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
  });
}

export async function createCreatorSyncRun(
  sourceId: string,
  requestBody: (20 | 50 | 100) | {
    operation: CreatorSyncOperation;
    limit?: 20 | 50 | 100;
    item_ids?: string[];
  },
): Promise<ApiResponse<{ run: CreatorSyncRun; reused: boolean }>> {
  return request(`/api/creator-sources/${encodeURIComponent(sourceId)}/runs`, {
    method: 'POST',
    body: JSON.stringify(
      typeof requestBody === 'number' ? { limit: requestBody } : requestBody,
    ),
  });
}

export async function getCreatorSource(
  sourceId: string,
): Promise<ApiResponse<CreatorSource>> {
  return request(`/api/creator-sources/${encodeURIComponent(sourceId)}`);
}

export async function listCreatorSourceItems(
  sourceId: string,
  options: {
    page?: number;
    perPage?: number;
    search?: string;
    status?: CreatorCatalogItemStatus;
  } = {},
  signal?: AbortSignal,
): Promise<ApiResponse<CreatorPaginatedResult<CreatorSourceItem>>> {
  const params = new URLSearchParams({
    page: String(Math.max(1, options.page || 1)),
    per_page: String(Math.max(1, Math.min(50, options.perPage || 50))),
    status: options.status || 'all',
  });
  if (options.search?.trim()) params.set('search', options.search.trim());
  return request(
    `/api/creator-sources/${encodeURIComponent(sourceId)}/items?${params.toString()}`,
    { signal },
  );
}

export async function listCreatorSyncRuns(
  status: 'active' | 'recent' = 'active',
): Promise<ApiResponse<{ items: CreatorSyncRun[] }>> {
  return request(`/api/creator-sync-runs?status=${status}`);
}

export async function getCreatorSyncRun(
  runId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<CreatorSyncRun>> {
  return request(`/api/creator-sync-runs/${encodeURIComponent(runId)}`, { signal });
}

export async function listCreatorSyncRunItems(
  runId: string,
  options: {
    page?: number;
    perPage?: number;
    status?: 'all' | 'pending' | 'succeeded' | 'failed';
  } = {},
  signal?: AbortSignal,
): Promise<ApiResponse<CreatorPaginatedResult<CreatorSyncRunItem>>> {
  const params = new URLSearchParams({
    page: String(Math.max(1, options.page || 1)),
    per_page: String(Math.max(1, Math.min(50, options.perPage || 50))),
    status: options.status || 'all',
  });
  return request(
    `/api/creator-sync-runs/${encodeURIComponent(runId)}/items?${params.toString()}`,
    { signal },
  );
}

export async function retryCreatorSyncRun(
  runId: string,
): Promise<ApiResponse<{ run: CreatorSyncRun; reused: boolean }>> {
  return request(`/api/creator-sync-runs/${encodeURIComponent(runId)}/retry`, {
    method: 'POST',
  });
}

export async function cancelCreatorSyncRun(
  runId: string,
): Promise<ApiResponse<CreatorSyncRun>> {
  return request(`/api/creator-sync-runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
}

export async function listDouyinLibraryItems(
  limit = 0,
  mode?: DouyinSourceMode,
  sort: DouyinLibrarySort = 'collection',
  refreshOrder = false,
  localOnly = false,
): Promise<ApiResponse<DouyinLibraryListResult>> {
  const params = new URLSearchParams({
    limit: String(Math.max(0, Math.min(limit, 10000))),
  });
  if (mode) params.set('mode', mode);
  params.set('sort', sort);
  if (refreshOrder) params.set('refresh_order', 'true');
  if (localOnly) params.set('local_only', 'true');
  const response = await request<DouyinLibraryListResult>(
    `/api/library/douyin/items?${params.toString()}`,
  );
  if (!response.data) return response;
  return {
    ...response,
    data: {
      ...response.data,
      items: response.data.items.map(normalizeDouyinLibraryItem),
    },
  };
}

export async function getDouyinLibraryItem(
  awemeId: string,
): Promise<ApiResponse<DouyinVideoWorkspace>> {
  const response = await request<DouyinVideoWorkspace>(
    `/api/library/douyin/items/${encodeURIComponent(awemeId)}`,
  );
  if (!response.data) return response;
  return {
    ...response,
    data: {
      ...response.data,
      item: normalizeDouyinLibraryItem(response.data.item),
    },
  };
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

export async function ingestLocalDouyinLibrary(
  sourceMode: DouyinSourceMode,
  items: DouyinLocalSyncItem[],
  clientVersion = '',
): Promise<ApiResponse<DouyinLocalSyncResult>> {
  return request<DouyinLocalSyncResult>('/api/library/douyin/local-sync', {
    method: 'POST',
    body: JSON.stringify({
      source_mode: sourceMode,
      items: items.slice(0, 100),
      client_version: clientVersion,
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
  signal?: AbortSignal,
): Promise<ApiResponse<DouyinCollectionJob>> {
  return request<DouyinCollectionJob>(
    `/api/library/douyin/jobs/${encodeURIComponent(jobId)}`,
    { signal },
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
      body: JSON.stringify({
        aweme_id: awemeId,
        operation,
        ephemeral_media_url: getEphemeralDouyinMediaSources([awemeId])[0]?.media_url || '',
      }),
    },
  );
}

export async function startDouyinBatchExtraction(
  awemeIds: string[],
  operation: DouyinBatchExtractionOperation = 'full',
): Promise<ApiResponse<DouyinBatchExtractionJob>> {
  const boundedIds = awemeIds.slice(0, operation === 'transcript' ? 100 : 50);
  return request<DouyinBatchExtractionJob>(
    '/api/library/douyin/extractions/batch',
    {
      method: 'POST',
      body: JSON.stringify({
        aweme_ids: boundedIds,
        operation,
        ephemeral_media_sources: getEphemeralDouyinMediaSources(boundedIds),
      }),
    },
  );
}

export async function getDouyinBatchExtraction(
  jobId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<DouyinBatchExtractionJob>> {
  return request<DouyinBatchExtractionJob>(
    `/api/library/douyin/extractions/batch/${encodeURIComponent(jobId)}`,
    { signal },
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
      research_mode: options?.researchMode || 'auto',
      output_style: options?.outputStyle || 'answer',
      custom_instruction: options?.customInstruction?.trim() || '',
      web_scope: options?.webScope || 'video_only',
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
  signal?: AbortSignal,
  includeIds: string[] = [],
  limit = 100,
): Promise<ApiResponse<AgentSourceList>> {
  const params = new URLSearchParams({
    scope,
    limit: String(Math.max(1, Math.min(1000, Math.trunc(limit)))),
  });
  if (query.trim()) params.set('q', query.trim());
  Array.from(new Set(includeIds.map((value) => value.trim()).filter(Boolean)))
    .slice(0, 100)
    .forEach((noteId) => params.append('include_id', noteId));
  return request<AgentSourceList>(`/api/agent/sources?${params.toString()}`, {
    signal,
  });
}

export async function generateAgentStarterQuestions(
  body: {
    sourceScope: AgentSourceScope;
    sourceIds?: string[];
  },
  signal?: AbortSignal,
): Promise<ApiResponse<AgentStarterQuestions>> {
  return request<AgentStarterQuestions>('/api/agent/starter-questions', {
    method: 'POST',
    body: JSON.stringify({
      source_scope: body.sourceScope,
      source_ids: Array.from(new Set(
        (body.sourceIds || []).map((value) => value.trim()).filter(Boolean),
      )).slice(0, 100),
    }),
    signal,
  });
}

export async function deleteAgentSource(
  noteId: string,
): Promise<ApiResponse<{ deleted: boolean; note_id: string; permanent: boolean }>> {
  return request(`/api/agent/sources/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  });
}

export async function deleteAgentSources(
  noteIds: string[],
): Promise<ApiResponse<{
  deleted: number;
  deleted_ids: string[];
  missing_ids: string[];
  permanent: boolean;
}>> {
  return request('/api/agent/sources/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ note_ids: [...new Set(noteIds)].slice(0, 50) }),
  });
}

export async function searchAgentSources(
  body: {
    query: string;
    scope?: Exclude<AgentSourceScope, 'selected'>;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<ApiResponse<AgentSourceSearchResult>> {
  return request<AgentSourceSearchResult>('/api/agent/source-search', {
    method: 'POST',
    body: JSON.stringify({
      query: body.query.trim(),
      scope: body.scope || 'all_ready',
      limit: body.limit || 30,
    }),
    signal,
  });
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
        source:
          row.source === 'visual'
            ? 'visual' as const
            : row.source === 'summary'
              ? 'summary' as const
              : 'transcript' as const,
        position_percent:
          typeof row.position_percent === 'number'
            ? row.position_percent
            : undefined,
        timestamp_ms:
          typeof row.timestamp_ms === 'number'
            ? Math.max(0, row.timestamp_ms)
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

export async function applyAgentPlanChange(
  messageId: string,
): Promise<ApiResponse<AgentPlanChangeApplyResult>> {
  return request<AgentPlanChangeApplyResult>(
    `/api/agent/messages/${encodeURIComponent(messageId)}/plan-change/apply`,
    { method: 'POST' },
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

export interface AgentMessageStreamCallbacks {
  onTurn?: (turnId: string) => void;
  onProgress?: (progress: AgentStreamProgress) => void;
  onAssistantStart?: (message: AgentMessage) => void;
  onDelta?: (
    delta: string,
    meta: { event_seq?: number; turn_id?: string; chunk_index?: number },
  ) => void;
  onApprovalRequired?: (data: AgentMessageResult) => void;
  onAnalysisStarted?: (data: AgentMessageResult) => void;
}

async function consumeAgentMessageStream(
  response: Response,
  callbacks: AgentMessageStreamCallbacks,
): Promise<ApiResponse<AgentMessageResult>> {
  if (!response.ok) {
    return {
      success: false,
      error: await responseErrorMessage(response),
      status: response.status,
    };
  }
  if (!response.body) {
    return { success: false, error: '浏览器没有收到回答数据流' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalData: AgentMessageResult | undefined;
  let streamError: string | undefined;
  let streamStatus: number | undefined;

  const consumeEvent = (block: string) => {
    const payloadText = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payloadText) return;
    const raw: unknown = JSON.parse(payloadText);
    if (!isRecord(raw) || typeof raw.type !== 'string') return;

    if (raw.type === 'turn' && typeof raw.turn_id === 'string') {
      callbacks.onTurn?.(raw.turn_id);
      return;
    }
    if (
      raw.type === 'progress'
      && typeof raw.stage === 'string'
      && typeof raw.message === 'string'
    ) {
      if (typeof raw.turn_id === 'string') callbacks.onTurn?.(raw.turn_id);
      callbacks.onProgress?.(raw as unknown as AgentStreamProgress);
      return;
    }
    if (raw.type === 'assistant_start' && isRecord(raw.message)) {
      callbacks.onAssistantStart?.(
        normalizeAgentMessage(raw.message as unknown as AgentMessage),
      );
      return;
    }
    if (raw.type === 'delta' && typeof raw.delta === 'string') {
      callbacks.onDelta?.(raw.delta, {
        event_seq: typeof raw.event_seq === 'number' ? raw.event_seq : undefined,
        turn_id: typeof raw.turn_id === 'string' ? raw.turn_id : undefined,
        chunk_index: typeof raw.chunk_index === 'number' ? raw.chunk_index : undefined,
      });
      return;
    }
    if (raw.type === 'done' && isRecord(raw.data)) {
      finalData = normalizedAgentMessageResult(
        raw.data as unknown as AgentMessageResult,
      );
      return;
    }
    if (
      (raw.type === 'approval_required' || raw.type === 'analysis_started')
      && isRecord(raw.data)
    ) {
      finalData = normalizedAgentMessageResult(
        raw.data as unknown as AgentMessageResult,
      );
      if (raw.type === 'approval_required') {
        callbacks.onApprovalRequired?.(finalData);
      } else {
        callbacks.onAnalysisStarted?.(finalData);
      }
      return;
    }
    if (raw.type === 'error') {
      streamError = typeof raw.message === 'string'
        ? raw.message
        : '视频 Agent 暂时没有完成回答';
      streamStatus = typeof raw.status === 'number' ? raw.status : 502;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(consumeEvent);
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);

  if (streamError) {
    return { success: false, error: streamError, status: streamStatus };
  }
  if (!finalData) {
    return { success: false, error: '回答数据流提前结束，请重新生成' };
  }
  return { success: true, data: finalData, status: response.status };
}

function normalizedAgentMessageResult(data: AgentMessageResult): AgentMessageResult {
  return {
    ...data,
    thread: normalizeAgentThread(data.thread),
    user_message: normalizeAgentMessage(data.user_message),
    assistant_message: normalizeAgentMessage(data.assistant_message),
  };
}

export async function streamAgentMessage(
  threadId: string,
  body: AgentMessageCreate,
  callbacks: AgentMessageStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<ApiResponse<AgentMessageResult>> {
  try {
    const response = await fetch(
      `${API_BASE}/api/agent/threads/${encodeURIComponent(threadId)}/messages/stream`,
      {
        method: 'POST',
        headers: authHeaders({ Accept: 'text/event-stream' }, true),
        body: JSON.stringify({
          ...body,
          content: body.content.trim(),
          client_turn_id: body.client_turn_id || crypto.randomUUID(),
          custom_instruction: body.custom_instruction?.trim() || '',
        }),
        signal,
      },
    );
    return await consumeAgentMessageStream(response, callbacks);
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export async function resumeAgentTurnStream(
  threadId: string,
  turnId: string,
  callbacks: AgentMessageStreamCallbacks = {},
  signal?: AbortSignal,
  afterEventSeq = 0,
): Promise<ApiResponse<AgentMessageResult>> {
  try {
    const query = afterEventSeq > 0
      ? `?after_seq=${encodeURIComponent(String(afterEventSeq))}`
      : '';
    const response = await fetch(
      `${API_BASE}/api/agent/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/stream${query}`,
      {
        method: 'GET',
        headers: authHeaders({ Accept: 'text/event-stream' }),
        signal,
      },
    );
    return await consumeAgentMessageStream(response, callbacks);
  } catch (error) {
    return { success: false, error: requestFailureMessage(error) };
  }
}

export async function getAgentTurn(
  threadId: string,
  turnId: string,
): Promise<ApiResponse<AgentTurn>> {
  return request<AgentTurn>(
    `/api/agent/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`,
  );
}

export async function cancelAgentTurn(
  threadId: string,
  turnId: string,
): Promise<ApiResponse<AgentTurn>> {
  return request<AgentTurn>(
    `/api/agent/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: 'POST' },
  );
}

export async function retryAgentTurn(
  threadId: string,
  turnId: string,
): Promise<ApiResponse<AgentTurn>> {
  return request<AgentTurn>(
    `/api/agent/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/retry`,
    { method: 'POST' },
  );
}

export async function decideAgentVideoAnalysis(
  threadId: string,
  runId: string,
  body: {
    action: 'approve' | 'text_only' | 'cancel' | 'reprepare';
    idempotency_key?: string;
    offering_id?: string;
    use_byok?: boolean;
  },
): Promise<ApiResponse<AgentMessageResult>> {
  const response = await request<AgentMessageResult>(
    `/api/agent/threads/${encodeURIComponent(threadId)}/video-analysis/${encodeURIComponent(runId)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  if (response.data) response.data = normalizedAgentMessageResult(response.data);
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

export interface CreatePlanMutation {
  title: string;
  start_date?: string | null;
  total_days?: number;
  first_task?: PlanTaskMutation | null;
}

export async function createPlan(input: CreatePlanMutation): Promise<ApiResponse<PlanData>> {
  return request<PlanData>('/api/plans', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getPlan(id: string): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${id}`);
}

export async function getPlanStats(): Promise<ApiResponse<PlanStats>> {
  return request<PlanStats>('/api/plans/stats');
}

export async function getPlanOverview(date?: string): Promise<ApiResponse<PlanOverview>> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<PlanOverview>(`/api/plans/overview${query}`);
}

export async function replacePlanFocus(
  date: string,
  tasks: Array<{ plan_id: string; task_id: string }>,
): Promise<ApiResponse<PlanOverview>> {
  return request<PlanOverview>('/api/plans/focus', {
    method: 'PUT',
    body: JSON.stringify({ date, tasks }),
  });
}

export async function getPlanWeeklyReview(weekStart?: string): Promise<ApiResponse<PlanWeeklyReview>> {
  const query = weekStart ? `?week_start=${encodeURIComponent(weekStart)}` : '';
  return request<PlanWeeklyReview>(`/api/plans/review${query}`);
}

export async function updatePlan(
  planId: string,
  updates: {
    title?: string;
    status?: 'active' | 'done';
    start_date?: string | null;
    total_days?: number;
  },
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

export async function reorderPlanTasks(planId: string, taskIds: string[]): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/tasks/order`, {
    method: 'PUT',
    body: JSON.stringify({ task_ids: taskIds }),
  });
}

export async function previewPlanCoaching(
  planId: string,
  instruction: string,
): Promise<ApiResponse<PlanCoachPreview>> {
  return request<PlanCoachPreview>(`/api/plans/${planId}/coach/preview`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
}

export async function applyPlanCoaching(
  planId: string,
  preview: Pick<PlanCoachPreview, 'base_updated_at' | 'operations'>,
): Promise<ApiResponse<PlanData>> {
  return request<PlanData>(`/api/plans/${planId}/coach/apply`, {
    method: 'POST',
    body: JSON.stringify(preview),
  });
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
  downloads: {
    total: number;
    today: number;
    last_7_days: number;
    by_platform: { android: number; windows: number };
    daily: { date: string; count: number }[];
  };
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
  provider: 'deepseek' | 'custom' | 'omniroute';
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

export interface CreatorSyncAdminConfig {
  enabled: boolean;
  platforms: Record<'douyin' | 'bilibili' | 'xiaohongshu', boolean>;
  concurrency: Record<'douyin' | 'bilibili' | 'xiaohongshu', number>;
  xhs_cookie_masked: string;
  last_tested_at: Record<'douyin' | 'bilibili' | 'xiaohongshu', string | null>;
}

export interface AgentV2AdminConfig {
  enabled: boolean;
  rollout_percent: number;
  allowlist: string[];
}

export async function getAdminStats(): Promise<ApiResponse<AdminStats>> {
  return request<AdminStats>('/api/admin/stats');
}

export async function listAdminVisionProviders(): Promise<ApiResponse<{ items: AdminVisionProvider[]; total: number }>> {
  const response = await request<{ items: AdminVisionProvider[]; total: number } | AdminVisionProvider[]>(
    '/api/admin/video-analysis/providers',
  );
  if (response.success && Array.isArray(response.data)) {
    return {
      ...response,
      data: { items: response.data, total: response.data.length },
    };
  }
  return response as ApiResponse<{ items: AdminVisionProvider[]; total: number }>;
}

export async function createAdminVisionProvider(
  body: Partial<AdminVisionProvider> & { name: string; driver: string; api_key?: string },
): Promise<ApiResponse<AdminVisionProvider>> {
  return request<AdminVisionProvider>('/api/admin/video-analysis/providers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateAdminVisionProvider(
  providerId: string,
  body: Partial<AdminVisionProvider> & { api_key?: string },
): Promise<ApiResponse<AdminVisionProvider>> {
  return request<AdminVisionProvider>(
    `/api/admin/video-analysis/providers/${encodeURIComponent(providerId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export async function testAdminVisionProvider(
  providerId: string,
  model?: string,
): Promise<ApiResponse<{ ok: boolean; provider?: AdminVisionProvider; error?: string }>> {
  return request(
    `/api/admin/video-analysis/providers/${encodeURIComponent(providerId)}/test`,
    {
      method: 'POST',
      body: JSON.stringify(model ? { model } : {}),
    },
  );
}

export async function disableAdminVisionProvider(
  providerId: string,
): Promise<ApiResponse<AdminVisionProvider>> {
  return request<AdminVisionProvider>(
    `/api/admin/video-analysis/providers/${encodeURIComponent(providerId)}`,
    { method: 'DELETE' },
  );
}

export async function listAdminVideoAnalysisOfferings(): Promise<ApiResponse<{ items: AdminVideoAnalysisOffering[]; total: number }>> {
  const response = await request<{ items: AdminVideoAnalysisOffering[]; total: number } | AdminVideoAnalysisOffering[]>(
    '/api/admin/video-analysis/offerings',
  );
  if (response.success && Array.isArray(response.data)) {
    return {
      ...response,
      data: { items: response.data, total: response.data.length },
    };
  }
  return response as ApiResponse<{ items: AdminVideoAnalysisOffering[]; total: number }>;
}

export async function createAdminVideoAnalysisOffering(
  body: Partial<AdminVideoAnalysisOffering> & { name: string; method: AdminVideoAnalysisOffering['method'] },
): Promise<ApiResponse<AdminVideoAnalysisOffering>> {
  return request<AdminVideoAnalysisOffering>('/api/admin/video-analysis/offerings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateAdminVideoAnalysisOffering(
  offeringId: string,
  body: Partial<AdminVideoAnalysisOffering>,
): Promise<ApiResponse<AdminVideoAnalysisOffering>> {
  return request<AdminVideoAnalysisOffering>(
    `/api/admin/video-analysis/offerings/${encodeURIComponent(offeringId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export async function publishAdminVideoAnalysisOffering(
  offeringId: string,
): Promise<ApiResponse<AdminVideoAnalysisOffering>> {
  return request<AdminVideoAnalysisOffering>(
    `/api/admin/video-analysis/offerings/${encodeURIComponent(offeringId)}/publish`,
    { method: 'POST' },
  );
}

export async function disableAdminVideoAnalysisOffering(
  offeringId: string,
): Promise<ApiResponse<AdminVideoAnalysisOffering>> {
  return request<AdminVideoAnalysisOffering>(
    `/api/admin/video-analysis/offerings/${encodeURIComponent(offeringId)}`,
    { method: 'DELETE' },
  );
}

export async function getAdminVideoAnalysisSettings(): Promise<ApiResponse<AdminVideoAnalysisSettings>> {
  return request<AdminVideoAnalysisSettings>('/api/admin/video-analysis/settings');
}

export async function putAdminVideoAnalysisSettings(
  body: Partial<AdminVideoAnalysisSettings>,
): Promise<ApiResponse<AdminVideoAnalysisSettings>> {
  return request<AdminVideoAnalysisSettings>('/api/admin/video-analysis/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function getAdminVideoAnalysisUsage(): Promise<ApiResponse<AdminVideoAnalysisUsageReport>> {
  return request<AdminVideoAnalysisUsageReport>('/api/admin/video-analysis/usage');
}

export async function listAdminVideoAnalysisRuns(filters: {
  status?: string;
  user_id?: string;
  limit?: number;
} = {}): Promise<ApiResponse<{ items: VideoAnalysisRun[]; total?: number }>> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.user_id) params.set('user_id', filters.user_id);
  if (filters.limit) params.set('limit', String(filters.limit));
  const response = await request<{ items: VideoAnalysisRun[]; total?: number } | VideoAnalysisRun[]>(
    `/api/admin/video-analysis/runs${params.size ? `?${params.toString()}` : ''}`,
  );
  if (response.success && Array.isArray(response.data)) {
    return { ...response, data: { items: response.data, total: response.data.length } };
  }
  return response as ApiResponse<{ items: VideoAnalysisRun[]; total?: number }>;
}

export async function listAdminVideoAnalysisLedger(filters: {
  user_id?: string;
  run_id?: string;
  limit?: number;
} = {}): Promise<ApiResponse<{ items: VideoAnalysisLedgerEntry[]; total?: number }>> {
  const params = new URLSearchParams();
  if (filters.user_id) params.set('user_id', filters.user_id);
  if (filters.run_id) params.set('run_id', filters.run_id);
  if (filters.limit) params.set('limit', String(filters.limit));
  const response = await request<{ items: VideoAnalysisLedgerEntry[]; total?: number } | VideoAnalysisLedgerEntry[]>(
    `/api/admin/video-analysis/ledger${params.size ? `?${params.toString()}` : ''}`,
  );
  if (response.success && Array.isArray(response.data)) {
    return { ...response, data: { items: response.data, total: response.data.length } };
  }
  return response as ApiResponse<{ items: VideoAnalysisLedgerEntry[]; total?: number }>;
}

export async function getAdminVideoAnalysisUserAccount(
  userId: string,
): Promise<ApiResponse<VideoAnalysisAccount>> {
  return request<VideoAnalysisAccount>(
    `/api/admin/video-analysis/users/${encodeURIComponent(userId)}/account`,
  );
}

export async function adjustAdminVideoAnalysisCredits(
  userId: string,
  body: {
    points: number;
    reason: string;
    entry_type?: 'grant' | 'refund' | 'adjustment' | 'purchase';
    idempotency_key?: string;
  },
): Promise<ApiResponse<VideoAnalysisAccount>> {
  return request<VideoAnalysisAccount>(
    `/api/admin/video-analysis/users/${encodeURIComponent(userId)}/credits`,
    { method: 'POST', body: JSON.stringify(body) },
  );
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
  body: { provider?: 'deepseek' | 'custom' | 'omniroute'; model?: string; api_base?: string; api_key?: string },
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

export async function getCreatorSyncAdminConfig(): Promise<ApiResponse<CreatorSyncAdminConfig>> {
  return request<CreatorSyncAdminConfig>('/api/admin/creator-sync-config');
}

export async function getAgentV2AdminConfig(): Promise<ApiResponse<AgentV2AdminConfig>> {
  return request<AgentV2AdminConfig>('/api/admin/agent-v2-config');
}

export async function putAgentV2AdminConfig(body: AgentV2AdminConfig): Promise<ApiResponse<AgentV2AdminConfig>> {
  return request<AgentV2AdminConfig>('/api/admin/agent-v2-config', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function putCreatorSyncAdminConfig(body: {
  enabled: boolean;
  xhs_cookie?: string;
  douyin_concurrency: number;
  bilibili_concurrency: number;
  xiaohongshu_concurrency: number;
}): Promise<ApiResponse<CreatorSyncAdminConfig>> {
  return request<CreatorSyncAdminConfig>('/api/admin/creator-sync-config', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function testCreatorSyncConnector(
  platform: 'douyin' | 'bilibili' | 'xiaohongshu',
  profileRef?: string,
): Promise<ApiResponse<{
  healthy: boolean;
  catalog_healthy?: boolean;
  message?: string;
  preview?: CreatorSourcePreview;
}>> {
  return request('/api/admin/creator-sync-config/test', {
    method: 'POST',
    body: JSON.stringify({ platform, profile_ref: profileRef?.trim() || null }),
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

export type ReadinessCheckStatus = 'ready' | 'degraded' | 'not_ready' | 'disabled' | 'not_applicable';

export interface AdminReadinessCheck {
  status: ReadinessCheckStatus;
  [key: string]: unknown;
}

export interface AdminReadiness {
  status: 'ready' | 'degraded' | 'not_ready';
  checked_at: string | null;
  checks: Record<string, AdminReadinessCheck>;
}

export interface OperationalAlert {
  id: string;
  category: string;
  severity: 'warning' | 'error' | 'critical' | string;
  title: string;
  message: string;
  status: 'open' | 'acknowledged' | 'resolved';
  occurrence_count: number;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export async function getAdminReadiness(refresh = false): Promise<ApiResponse<AdminReadiness>> {
  return request<AdminReadiness>(`/api/admin/readiness${refresh ? '?refresh=true' : ''}`);
}

export async function getOperationalAlerts(refresh = false): Promise<ApiResponse<{ items: OperationalAlert[] }>> {
  return request<{ items: OperationalAlert[] }>(`/api/admin/operational-alerts${refresh ? '?refresh=true' : ''}`);
}

export async function acknowledgeOperationalAlert(alertId: string): Promise<ApiResponse<{ acknowledged: boolean }>> {
  return request<{ acknowledged: boolean }>(`/api/admin/operational-alerts/${encodeURIComponent(alertId)}/acknowledge`, {
    method: 'POST',
  });
}

export type KnowledgeView = 'pages' | 'inbox';
export type KnowledgeItemKind = 'page' | 'candidate' | 'personal';
export type KnowledgeOrigin = 'manual' | 'video';

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeItemKind;
  title: string;
  summary: string;
  content: string;
  excerpt?: string;
  status: 'canonical' | string;
  origin: KnowledgeOrigin | string;
  source_label: string;
  source_note_id?: string | null;
  source_count: number;
  source_url?: string;
  content_chars?: number;
  video_id?: string;
  video_url?: string;
  cover_url?: string;
  author_name?: string;
  platform?: string;
  sections?: Array<{ title: string; content: string }>;
  conclusion?: string;
  key_insight?: string;
  section_count?: number;
  transcript_ready?: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCounts {
  pages: number;
  inbox: number;
}

export interface KnowledgePage {
  items: KnowledgeItem[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  view: KnowledgeView;
  counts: KnowledgeCounts;
}

export interface ListKnowledgeOptions {
  view?: KnowledgeView;
  page?: number;
  perPage?: number;
  query?: string;
}

export async function listKnowledge({
  view = 'pages',
  page = 1,
  perPage = 20,
  query = '',
}: ListKnowledgeOptions = {}): Promise<ApiResponse<KnowledgePage>> {
  const params = new URLSearchParams({
    view,
    page: String(page),
    per_page: String(perPage),
  });
  if (query.trim()) params.set('q', query.trim());
  return request<KnowledgePage>(`/api/knowledge?${params.toString()}`);
}

export async function getKnowledgeEntry(id: string): Promise<ApiResponse<KnowledgeItem>> {
  return request<KnowledgeItem>(`/api/knowledge/entries/${encodeURIComponent(id)}`);
}

export async function createKnowledgeEntry(body: {
  title: string;
  content: string;
  summary?: string;
  source_label?: string;
}): Promise<ApiResponse<KnowledgeItem>> {
  return request<KnowledgeItem>('/api/knowledge/entries', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateKnowledgeEntry(
  id: string,
  body: { title?: string; content?: string; summary?: string; source_label?: string },
): Promise<ApiResponse<KnowledgeItem>> {
  return request<KnowledgeItem>(`/api/knowledge/entries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteKnowledgeEntry(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request<{ deleted: boolean }>(`/api/knowledge/entries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getKnowledgeCandidate(noteId: string): Promise<ApiResponse<KnowledgeItem>> {
  return request<KnowledgeItem>(
    `/api/knowledge/candidates/${encodeURIComponent(noteId)}`,
  );
}

export async function saveKnowledgeCandidate(noteId: string): Promise<ApiResponse<KnowledgeItem>> {
  return request<KnowledgeItem>(
    `/api/knowledge/candidates/${encodeURIComponent(noteId)}/save`,
    { method: 'POST' },
  );
}

export interface UserAIProviderConfig {
  mode: 'platform' | 'custom';
  enabled: boolean;
  provider_name: string;
  model: string;
  api_base: string;
  api_key_set: boolean;
  api_key_masked: string;
  selected_offering_id: string;
  selected_offering_name: string;
  selected_custom_model_id: string | null;
  custom_models: UserCustomChatModel[];
  policy: {
    mode: string;
    label: string;
    allowance: string;
    features: string[];
    custom_unlocks: string[];
  };
}

export interface UserCustomChatModel {
  id: string;
  name: string;
  provider_name: string;
  model: string;
  api_base: string;
  api_key_set: boolean;
  api_key_masked: string;
  enabled: boolean;
  is_selected: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface UserCustomChatModels {
  items: UserCustomChatModel[];
  selected_id: string | null;
  active_selection: {
    kind: 'custom' | 'platform';
    custom_model_id: string | null;
  };
}

export interface UserCustomChatModelInput {
  name?: string;
  provider_name?: string;
  model: string;
  api_base: string;
  api_key?: string;
  enabled?: boolean;
}

export async function listUserCustomChatModels(): Promise<ApiResponse<UserCustomChatModels>> {
  return request<UserCustomChatModels>('/api/user/custom-chat-models');
}

export async function createUserCustomChatModel(body: UserCustomChatModelInput & {
  select?: boolean;
}): Promise<ApiResponse<UserCustomChatModel>> {
  return request<UserCustomChatModel>('/api/user/custom-chat-models', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateUserCustomChatModel(
  id: string,
  body: UserCustomChatModelInput,
): Promise<ApiResponse<UserCustomChatModel>> {
  return request<UserCustomChatModel>(`/api/user/custom-chat-models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteUserCustomChatModel(id: string): Promise<ApiResponse<{
  deleted: boolean;
  selection_reset: boolean;
}>> {
  return request(`/api/user/custom-chat-models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function selectUserCustomChatModel(id: string): Promise<ApiResponse<UserCustomChatModels>> {
  return request<UserCustomChatModels>(`/api/user/custom-chat-models/${encodeURIComponent(id)}/select`, {
    method: 'PUT',
  });
}

export async function selectPlatformChatModel(): Promise<ApiResponse<UserCustomChatModels>> {
  return request<UserCustomChatModels>('/api/user/custom-chat-models/select-platform', {
    method: 'PUT',
  });
}

export async function testUserCustomChatModel(id: string): Promise<ApiResponse<{
  connected: boolean;
  provider: string;
  model: string;
}>> {
  return request(`/api/user/custom-chat-models/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
}

export async function getUserAIProvider(): Promise<ApiResponse<UserAIProviderConfig>> {
  return request<UserAIProviderConfig>('/api/user/ai-provider');
}

export async function saveUserAIProvider(body: {
  mode: 'platform' | 'custom';
  provider_name?: string;
  model?: string;
  api_base?: string;
  api_key?: string;
}): Promise<ApiResponse<UserAIProviderConfig>> {
  return request<UserAIProviderConfig>('/api/user/ai-provider', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface UserChatModel {
  id: string;
  name: string;
  description: string;
  icon_key: string;
  is_default: boolean;
  is_free: boolean;
  free_daily_limit: number;
  free_used_today: number;
  free_remaining_today: number | null;
  points_per_request: number;
  supports_images: boolean;
  supports_tools: boolean;
}

export interface UserChatModelCatalog {
  items: UserChatModel[];
  selected_offering_id: string;
  account: {
    available_points: number;
    reserved_points: number;
    total_points: number;
    points_per_cny: number;
  };
}

export interface AdminChatModel {
  id: string;
  code: string;
  name: string;
  description: string;
  provider_mode: 'platform' | 'omniroute';
  model_id: string;
  enabled: boolean;
  visible_to_users: boolean;
  is_default: boolean;
  is_free: boolean;
  free_daily_limit: number;
  points_per_request: number;
  supports_images: boolean;
  supports_tools: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export type AdminChatModelInput = Omit<AdminChatModel, 'id' | 'created_at' | 'updated_at'>;

export async function getUserChatModels(): Promise<ApiResponse<UserChatModelCatalog>> {
  return request<UserChatModelCatalog>('/api/user/chat-models');
}

export async function selectUserChatModel(offeringId: string): Promise<ApiResponse<{
  selected_offering_id: string;
  item: UserChatModel;
}>> {
  return request('/api/user/chat-model', {
    method: 'PUT',
    body: JSON.stringify({ offering_id: offeringId }),
  });
}

export async function listAdminChatModels(): Promise<ApiResponse<{ items: AdminChatModel[] }>> {
  return request('/api/admin/chat-models');
}

export async function createAdminChatModel(body: AdminChatModelInput): Promise<ApiResponse<AdminChatModel>> {
  return request('/api/admin/chat-models', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateAdminChatModel(id: string, body: AdminChatModelInput): Promise<ApiResponse<AdminChatModel>> {
  return request(`/api/admin/chat-models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteAdminChatModel(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request(`/api/admin/chat-models/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface OmniRouteAdminConfig {
  configured: boolean;
  api_base: string;
  api_key_masked: string;
  model: string;
  dashboard_url: string;
}

export interface OmniRouteAdminTest {
  configured: boolean;
  online: boolean;
  message: string;
  latency_ms: number;
  model_count: number;
}

export async function getAdminOmniRouteConfig(): Promise<ApiResponse<OmniRouteAdminConfig>> {
  return request<OmniRouteAdminConfig>('/api/admin/omniroute-config');
}

export async function putAdminOmniRouteConfig(body: {
  api_base?: string;
  api_key?: string;
  model?: string;
  dashboard_url?: string;
}): Promise<ApiResponse<OmniRouteAdminConfig>> {
  return request<OmniRouteAdminConfig>('/api/admin/omniroute-config', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function getAdminOmniRouteWorkspace(
  refresh = false,
): Promise<ApiResponse<AIRoutingWorkspace>> {
  return request<AIRoutingWorkspace>(
    `/api/admin/omniroute/workspace${refresh ? '?refresh=true' : ''}`,
  );
}

export async function testAdminOmniRoute(): Promise<ApiResponse<OmniRouteAdminTest>> {
  return request<OmniRouteAdminTest>('/api/admin/omniroute/test', { method: 'POST' });
}

export async function resetUserAIProvider(): Promise<ApiResponse<UserAIProviderConfig>> {
  return request<UserAIProviderConfig>('/api/user/ai-provider', { method: 'DELETE' });
}

export async function testUserAIProvider(signal?: AbortSignal): Promise<ApiResponse<{
  connected: boolean;
  provider: string;
  model: string;
}>> {
  return request('/api/user/ai-provider/test', { method: 'POST', signal });
}

export interface AIRoutingWorkspaceModel {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  free: boolean;
  free_type: string;
  monthly_tokens: number;
  credit_tokens: number;
  context_length: number;
  capabilities: string[];
  tos?: string;
}

export interface AIRoutingWorkspaceRoute {
  id: string;
  name: string;
  candidate_count: number;
  context_length: number;
  available: boolean;
}

export interface AIRoutingWorkspaceRanking {
  id: string;
  name: string;
  category: string;
  model_count: number;
  score: number;
  top_model_id: string;
  top_model_name: string;
}

export interface AIRoutingWorkspace {
  status: {
    configured: boolean;
    online: boolean;
    partial: boolean;
    latency_ms: number;
    message: string;
  };
  models: AIRoutingWorkspaceModel[];
  routes: AIRoutingWorkspaceRoute[];
  rankings: AIRoutingWorkspaceRanking[];
  summary: {
    steady_tokens: number;
    first_month_tokens: number;
    used_this_month: number;
    remaining: number;
    provider_pools: number;
    model_count: number;
    catalog_updated_at: string;
    no_credential_providers: string[];
  };
  sections: Record<string, boolean>;
  advanced_console_url: string;
}

export async function getAIRoutingWorkspace(
  refresh = false,
): Promise<ApiResponse<AIRoutingWorkspace>> {
  return request<AIRoutingWorkspace>(
    `/api/user/ai-routing/workspace${refresh ? '?refresh=true' : ''}`,
  );
}
