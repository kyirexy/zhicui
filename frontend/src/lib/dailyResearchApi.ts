import { request } from './api';

export type ResearchPlatform = 'douyin' | 'bilibili';
export type ResearchSourceMode = 'like' | 'collect';

export interface ResearchSubscriptionInput {
  name: string;
  enabled: boolean;
  schedule_time: string;
  timezone: string;
  platforms: ResearchPlatform[];
  source_modes: ResearchSourceMode[];
  window_days: number;
  sync_limit: number;
  focus_topics: string[];
  recipient_email: string;
  instruction: string;
}

export interface ResearchSubscription extends ResearchSubscriptionInput {
  id: string;
  version: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchStatus {
  scheduler: { enabled: boolean; running: boolean };
  email: { configured: boolean; provider: string };
  desktop: { online: boolean; last_seen_at: string | null };
  limits: {
    max_subscriptions: number;
    max_manual_runs_per_ten_minutes: number;
    max_sync_limit: number;
    max_research_sources: number;
    transcript_sample_limit: number;
  };
  recipients: Array<{ email: string; verified: boolean }>;
  account_email: string;
}

export interface ResearchSource {
  video_id: string;
  note_id?: string | null;
  title: string;
  url: string;
  modes: ResearchSourceMode[];
  engagement: Partial<Record<'likes' | 'comments' | 'shares' | 'collects' | 'views', number | null>>;
  evidence_level: 'transcript' | 'metadata';
  recommendation_reason?: string;
}

export type ResearchCoverage = 'complete' | 'limited' | 'partial' | string;
export interface ResearchReport {
  title: string;
  markdown: string;
  window_start?: string;
  window_end?: string;
  source_count: number;
  transcript_count: number;
  sources: ResearchSource[];
  coverage: ResearchCoverage;
  limitations: string[];
  sync_sources?: Array<{
    platform: string;
    source_mode: string;
    coverage: ResearchCoverage;
    read: number;
    saved: number;
    failed: number;
    error?: string;
  }>;
}

export interface ResearchRun {
  id: string;
  subscription_id: string;
  trigger: string;
  status: string;
  stage: string;
  stage_message: string;
  source_count: number;
  result_text: string;
  report: ResearchReport | null;
  stats: { read: number; saved: number; created: number; reused: number; skipped: number; failed: number };
  coverage: ResearchCoverage;
  delivery_status: string;
  delivery_error: string | null;
  agent_thread_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface VerificationResult {
  email: string;
  verified: boolean;
  status?: 'sent' | 'not_configured' | 'already_verified';
  message?: string;
}

const BASE = '/api/daily-research';

/** 复用知萃统一请求及会话恢复；取消由调用方控制，避免旧响应覆盖新选择。 */
async function researchRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const result = await request<T>(`${BASE}${path}`, { cache: 'no-store', ...options });
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (!result.success || result.data === undefined) throw new Error(result.error || '每日研究暂时不可用，请稍后重试');
  return result.data;
}

export const getResearchStatus = (signal?: AbortSignal) => researchRequest<ResearchStatus>('/status', { signal });
export const listResearchSubscriptions = (signal?: AbortSignal) => researchRequest<{ items: ResearchSubscription[]; total: number }>('/subscriptions', { signal });
export const saveResearchSubscription = (value: ResearchSubscriptionInput, id?: string, signal?: AbortSignal) => researchRequest<ResearchSubscription>(id ? `/subscriptions/${encodeURIComponent(id)}` : '/subscriptions', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(value), signal });
export const patchResearchSubscription = (id: string, value: Partial<ResearchSubscriptionInput>, signal?: AbortSignal) => researchRequest<ResearchSubscription>(`/subscriptions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value), signal });
export const deleteResearchSubscription = (id: string, signal?: AbortSignal) => researchRequest<unknown>(`/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
export const startResearchRun = (id: string, signal?: AbortSignal) => researchRequest<ResearchRun>(`/subscriptions/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}', signal });
export const listResearchRuns = (subscriptionId: string, signal?: AbortSignal) => researchRequest<{ items: ResearchRun[]; total: number }>(`/runs?${new URLSearchParams({ subscription_id: subscriptionId })}`, { signal });
export const getResearchRun = (id: string, signal?: AbortSignal) => researchRequest<ResearchRun>(`/runs/${encodeURIComponent(id)}`, { signal });
export const sendResearchVerification = (email: string, signal?: AbortSignal) => researchRequest<VerificationResult>('/recipients/verify/send', { method: 'POST', body: JSON.stringify({ email }), signal });
export const confirmResearchVerification = (email: string, code: string, signal?: AbortSignal) => researchRequest<VerificationResult>('/recipients/verify/confirm', { method: 'POST', body: JSON.stringify({ email, code }), signal });
