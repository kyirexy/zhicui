export type CardType = 'recipe' | 'insight' | 'history' | 'product' | 'plan' | 'general';

/** Tone of the source content — drives layout density & visual weight. */
export type ContentTone = 'emotional' | 'informational' | 'hybrid';

/** Information-density preference emitted by the LLM (per-note). */
export type ContentDensity = 'low' | 'medium' | 'high';

export interface CardSection {
  title: string;
  content: string;
  /** Lucide icon key — see SectionIcon dispatcher. Falls back to emoji. */
  icon?: string;
  /** Legacy: pre-icon-system cards stored an emoji here. */
  emoji?: string;
}

export interface CardStat {
  label: string;
  value: string;
}

export interface CardData {
  id?: string;
  card_type: CardType;
  title: string;
  sections: CardSection[];
  conclusion: string;
  pitfall_rating: number;
  source_url?: string;
  video_url?: string;
  created_at?: string;
  seo_meta?: string;
  transcript_raw?: string | null;
  transcript_chars?: number;
  ai_initialized?: boolean;
  generation_status?: 'ready' | 'fallback';
  generation_error?: string;
  video_title?: string;
  video_id?: string;
  cover_url?: string;
  author_name?: string;
  platform?: string;
  source_kind?: string;
  source_recorded_at?: string;
  caption?: string;
  tags?: string[];
  media_type?: string;
  media_url?: string;
  transcript_source?: string;
  speech_ready?: boolean;
  degraded?: boolean;
  /** New adaptive-profile fields (server-side defaults keep older cards working). */
  tone?: ContentTone;
  density?: ContentDensity;
  hero_quote?: string;
  key_insight?: string;
  stats?: CardStat[];
  /** plan_id when the extract pipeline auto-created a Plan for this note. */
  plan_id?: string | null;
  /** Optional on-demand visual enrichment; ordinary extraction never creates it. */
  detailed_video_analysis?: DetailedVideoAnalysisSummary | null;
}

export interface Note {
  id: string;
  title: string;
  card_type: CardType;
  conclusion: string;
  pitfall_rating: number;
  excerpt: string;
  created_at: string;
  source_url?: string;
  cover_url?: string;
  author_name?: string;
  platform?: string;
  source_kind?: string;
  source_recorded_at?: string;
  caption?: string;
  tags?: string[];
  media_type?: string;
  media_url?: string;
  transcript_source?: string;
  speech_ready?: boolean;
  degraded?: boolean;
  transcript_chars?: number;
  ai_initialized: boolean;
  generation_status?: 'ready' | 'fallback';
  generation_error?: string;
  seo_meta?: string;
  tone?: ContentTone;
  density?: ContentDensity;
  section_count?: number;
  detailed_video_analysis?: DetailedVideoAnalysisSummary | null;
}

export interface NoteDetail extends Note {
  sections: CardSection[];
  transcript_raw?: string | null;
  video_title?: string;
  video_id?: string;
  video_url?: string;
  hero_quote?: string;
  key_insight?: string;
  stats?: CardStat[];
  plan_id?: string | null;
}

export interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: string;
  platform: string;
}

export interface ApiErrorDetails {
  code?: string;
  needs_action?: boolean;
  source_mode?: string;
  retry_after_seconds?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
  error_details?: ApiErrorDetails;
}

// ============================================================================
// On-demand detailed video analysis
// ============================================================================

export type VideoAnalysisMethod = 'local_scene' | 'scene_frames_vlm' | 'native_video';
export type VideoAnalysisTrigger = 'manual' | 'batch' | 'agent';
export type VideoAnalysisRunStatus =
  | 'quoting'
  | 'awaiting_confirmation'
  | 'prepared'
  | 'reserved'
  | 'queued'
  | 'running'
  | 'preparing'
  | 'scene_detection'
  | 'visual_analysis'
  | 'summary_update'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'reauthorization_required';
export type VideoAnalysisBillingStatus =
  | 'none'
  | 'quoted'
  | 'reserved'
  | 'captured'
  | 'released'
  | 'partially_released'
  | 'refunded'
  | 'not_billable'
  | 'reconciliation_pending';
export type VideoAnalysisItemStatus =
  | VideoAnalysisRunStatus
  | 'cached'
  | 'unsupported';

export interface VideoAnalysisOfferingLimits {
  max_duration_seconds?: number;
  max_frames?: number;
  max_model_calls?: number;
  max_provider_calls?: number;
  timeout_seconds?: number;
}

export interface VideoAnalysisOfferingPrice {
  is_free?: boolean;
  base_points?: number;
  per_minute_points?: number;
  per_frame_points?: number;
  per_media_unit_points?: number;
  byok_processing_points?: number;
  billing_unit?: 'run' | 'minute' | string;
  billing_increment_seconds?: number;
  min_points?: number;
  max_points?: number;
}

export interface VideoAnalysisOffering {
  id: string;
  code?: string;
  version?: number | string;
  version_id?: string;
  name: string;
  description?: string;
  method: VideoAnalysisMethod;
  recommended?: boolean;
  is_recommended?: boolean;
  is_free?: boolean;
  supports_byok?: boolean;
  byok_allowed?: boolean;
  byok_available?: boolean;
  provider_id?: string | null;
  provider_name?: string;
  model?: string;
  allowed_triggers?: VideoAnalysisTrigger[];
  limits?: VideoAnalysisOfferingLimits;
  price?: VideoAnalysisOfferingPrice;
  free_quota?: {
    remaining_count?: number | null;
    remaining_minutes?: number | null;
    period?: 'day' | 'month' | string;
    unit?: 'run' | 'minute' | string;
    units?: number;
    scope?: string;
  } | null;
  estimated_seconds_min?: number;
  estimated_seconds_max?: number;
}

export interface VideoAnalysisLedgerEntry {
  id: string | number;
  kind: 'grant' | 'purchase' | 'adjustment' | 'reserve' | 'capture' | 'release' | 'refund' | string;
  points: number;
  entry_type?: string;
  available_delta?: number;
  reserved_delta?: number;
  available_after?: number;
  reserved_after?: number;
  balance_after?: number;
  reason?: string;
  run_id?: string | null;
  user_id?: string;
  username?: string;
  created_at: string;
}

export interface VideoAnalysisAccount {
  available_points: number;
  reserved_points: number;
  total_points?: number;
  points_per_cny: number;
  recent_ledger?: VideoAnalysisLedgerEntry[];
}

export interface VideoAnalysisCatalog {
  enabled: boolean;
  reason?: string | null;
  items: VideoAnalysisOffering[];
  offerings?: VideoAnalysisOffering[];
  recommendation?: VideoAnalysisOffering | string | null;
  recommended_offering_id?: string | null;
  account?: VideoAnalysisAccount | null;
}

export interface VideoAnalysisQuoteLine {
  label: string;
  points: number;
  note_id?: string;
  quantity?: number;
  unit?: string;
}

export interface VideoAnalysisQuote {
  id?: string;
  quote_id?: string;
  offering_id?: string;
  offering_version?: number | string;
  estimated_points: number;
  quoted_points?: number;
  max_points: number;
  max_reserved_points?: number;
  expires_at?: string;
  estimated_seconds_min?: number;
  estimated_seconds_max?: number;
  max_frames?: number;
  max_model_calls?: number;
  cached_count?: number;
  process_count?: number;
  unsupported_count?: number;
  line_items?: VideoAnalysisQuoteLine[];
}

export interface VideoAnalysisItem {
  id: string;
  run_id?: string;
  note_id: string;
  title?: string;
  status: VideoAnalysisItemStatus;
  billing_status?: VideoAnalysisBillingStatus;
  progress?: number;
  stage?: string;
  error?: string | null;
  cached?: boolean;
  supported?: boolean;
  scene_count?: number;
  frame_count?: number;
  actual_points?: number;
  reserved_points?: number;
  released_points?: number;
  analysis_id?: string | null;
  updated_at?: string;
}

export interface VideoAnalysisRun {
  id: string;
  status: VideoAnalysisRunStatus;
  billing_status?: VideoAnalysisBillingStatus;
  trigger?: VideoAnalysisTrigger;
  agent_thread_id?: string | null;
  agent_turn_id?: string | null;
  offering_id?: string;
  offering_name?: string;
  offering_version?: number | string;
  use_byok?: boolean;
  note_ids?: string[];
  source_count?: number;
  item_count?: number;
  completed_count?: number;
  failed_count?: number;
  progress?: number;
  current_stage?: string;
  estimated_points?: number;
  max_reserved_points?: number;
  actual_points?: number;
  released_points?: number;
  provider_cost_micros?: number;
  user_id?: string;
  username?: string;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
  quote?: VideoAnalysisQuote | null;
  items?: VideoAnalysisItem[];
}

export interface VideoAnalysisPrepareResult {
  run: VideoAnalysisRun;
  quote?: VideoAnalysisQuote | null;
  items: VideoAnalysisItem[];
  requires_confirmation: boolean;
  can_start?: boolean;
  can_auto_start?: boolean;
}

export interface VideoAnalysisRunResult {
  run: VideoAnalysisRun;
  items: VideoAnalysisItem[];
}

export interface VideoAnalysisRunPage {
  items: VideoAnalysisRun[];
  total: number;
  page?: number;
  per_page?: number;
}

export interface UserVisionProviderConfig {
  enabled: boolean;
  configured?: boolean;
  provider_name: string;
  driver: string;
  model: string;
  api_base: string;
  api_key_set: boolean;
  api_key_masked?: string;
  health_status?: 'untested' | 'healthy' | 'unhealthy' | string;
  health_message?: string;
  capabilities?: Record<string, boolean>;
  supported_drivers?: Array<{
    value: string;
    label: string;
    supports_images?: boolean;
    description?: string;
  }>;
  last_test_ok?: boolean | null;
  last_tested_at?: string | null;
}

export interface AdminVisionProvider {
  id: string;
  code?: string;
  name: string;
  driver: string;
  api_base?: string;
  api_key_set?: boolean;
  api_key_masked?: string;
  model?: string;
  default_model?: string;
  enabled: boolean;
  capabilities?: {
    supports_images?: boolean;
    supports_native_video?: boolean;
    supports_ocr?: boolean;
    supports_audio?: boolean;
    native_video_driver_installed?: boolean;
    [key: string]: boolean | undefined;
  };
  metering?: {
    unit?: string;
    [key: string]: string | number | boolean | undefined;
  };
  limits?: {
    max_images?: number;
    max_duration_seconds?: number;
    max_file_bytes?: number;
    timeout_seconds?: number;
    [key: string]: string | number | boolean | undefined;
  };
  cost?: {
    cost_class?: 'unknown' | 'no_cost' | 'metered' | string;
    micros_per_unit?: number;
    [key: string]: string | number | boolean | undefined;
  };
  supports_images?: boolean;
  supports_native_video?: boolean;
  supports_ocr?: boolean;
  supports_audio?: boolean;
  supports_byok?: boolean;
  free?: boolean;
  metering_unit?: string;
  cost_known?: boolean;
  cost_per_unit_micros?: number | null;
  max_images?: number;
  max_duration_seconds?: number;
  max_file_bytes?: number;
  concurrency?: number;
  max_concurrency?: number;
  timeout_seconds?: number;
  daily_budget_micros?: number;
  health_status?: 'untested' | 'healthy' | 'unhealthy' | 'disabled' | string;
  health_message?: string;
  circuit_open_until?: string | null;
  last_test_succeeded_at?: string | null;
  last_tested_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AdminVideoAnalysisOffering extends VideoAnalysisOffering {
  enabled?: boolean;
  published?: boolean;
  status?: 'draft' | 'published' | 'disabled' | string;
  sort_order?: number;
  provider_id?: string | null;
  allow_manual?: boolean;
  allow_batch?: boolean;
  allow_agent?: boolean;
  allow_byok?: boolean;
  byok_allowed?: boolean;
  triggers?: VideoAnalysisTrigger[];
  pricing?: VideoAnalysisOfferingPrice;
  fallback?: { mode?: 'none' | 'local_scene' | string; [key: string]: unknown };
  current_version_id?: string | null;
  next_version?: number;
  free_quota_period?: 'day' | 'month' | string | null;
  free_quota_count?: number | null;
  free_quota_minutes?: number | null;
  base_points?: number;
  per_minute_points?: number;
  per_frame_points?: number;
  per_media_unit_points?: number;
  min_points?: number;
  max_points?: number;
  created_at?: string;
  updated_at?: string;
  published_at?: string | null;
}

export interface AdminVideoAnalysisSettings {
  enabled: boolean;
  recommended_offering_id?: string | null;
  quote_ttl_seconds: number;
  agent_max_candidates: number;
  agent_candidate_limit?: number;
  global_concurrency?: number;
  user_daily_points_limit: number;
  run_points_limit: number;
  scene_concurrency: number;
  vision_concurrency: number;
  retry_count: number;
  stale_run_minutes: number;
  temporary_file_ttl_minutes: number;
  provider_failure_threshold?: number;
  provider_cooldown_minutes?: number;
}

export interface AdminVideoAnalysisUsageSummary {
  runs: number;
  items: number;
  succeeded: number;
  partial: number;
  failed: number;
  cache_hits: number;
  points_captured: number;
  points_refunded: number;
  provider_cost_micros: number;
  failure_cost_micros: number;
}

export interface AdminVideoAnalysisUsageReport {
  summary?: AdminVideoAnalysisUsageSummary;
  runs?: number | VideoAnalysisRun[];
  items?: number | VideoAnalysisRun[];
  total?: number;
  page?: number;
  per_page?: number;
  days?: number;
  succeeded_runs?: number;
  partial_runs?: number;
  failed_runs?: number;
  cancelled_runs?: number;
  quoted_points?: number;
  captured_points?: number;
  released_points?: number;
  refunded_points?: number;
  platform_cost_micros?: number;
  failure_cost_micros?: number;
  active_runs?: number;
  byok_runs?: number;
  cache_hits?: number;
}

export interface DetailedVideoAnalysisSummary {
  analysis_id?: string;
  offering_name?: string;
  offering_version?: number | string;
  scene_count?: number;
  frame_count?: number;
  status?: 'succeeded' | 'partial';
  updated_at?: string;
  degraded_reason?: string | null;
  degradation_reason?: string | null;
}

export type FeedbackCategory = 'bug' | 'suggestion' | 'content' | 'account' | 'other';
export type FeedbackStatus = 'pending' | 'processing' | 'resolved' | 'closed';

export interface FeedbackItem {
  id: string;
  category: FeedbackCategory;
  subject: string;
  content: string;
  page_path?: string | null;
  status: FeedbackStatus;
  admin_reply?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackPage {
  items: FeedbackItem[];
  total: number;
  page: number;
  per_page: number;
}

export type NoteChatRole = 'user' | 'assistant';

export interface NoteChatTurn {
  role: NoteChatRole;
  content: string;
}

export type NoteEvidenceSource = 'transcript' | 'summary' | 'visual';
export type ResearchScope = 'auto' | 'video_only';

export interface NoteEvidence {
  quote: string;
  source: NoteEvidenceSource;
  position_percent?: number;
  /** Server-attached timestamp for persisted AI visual observations. */
  timestamp_ms?: number;
}

export type NoteTranscriptMode = 'full' | 'retrieved' | 'none';
export type NoteAnswerMode = 'grounded' | 'creative' | 'visual';

export interface NoteSourceContext {
  transcript_chars: number;
  transcript_mode: NoteTranscriptMode;
  scanned_chunks: number;
  selected_chunks: number;
  ai_summary_used: boolean;
  research_scope?: ResearchScope;
  web_search_used?: boolean;
  web_query_count?: number;
  web_source_count?: number;
  agent_trace?: ResearchAgentStage[];
  source_mode?: 'text' | 'visual';
  media_type?: 'gallery' | 'video';
  visual_evidence_count?: number;
}

export interface WebResearchSource {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  verified: boolean;
}

export interface ResearchAgentStage {
  stage: 'plan' | 'retrieve' | 'web' | 'map' | 'visual' | 'synthesize';
  label: string;
  detail: string;
}

export interface NoteAskResult {
  note_id: string;
  answer: string;
  answer_mode?: NoteAnswerMode;
  grounded: boolean;
  evidence: NoteEvidence[];
  follow_up_questions: string[];
  source_context?: NoteSourceContext | null;
  web_sources: WebResearchSource[];
  research_scope: ResearchScope;
  agent_trace: ResearchAgentStage[];
}

export interface VisualAskResult extends Omit<NoteAskResult, 'note_id' | 'research_scope'> {
  item_id: string;
  research_scope: 'visual_only';
}

export interface DouyinLibraryStatus {
  connected: boolean;
  base_url: string;
  cookie_valid: boolean;
  cookie_count: number;
  binding?: {
    status: 'connected' | 'pending' | 'disconnected' | string;
    cookie_count: number;
    bound_at?: string | null;
    last_verified_at?: string | null;
    last_sync_at?: string | null;
  };
  storage_mode?: 'metadata_only' | 'local_media' | 'unknown';
  login_browser_mode?: 'visible_chrome' | 'remote_capture' | 'headless' | 'unavailable' | string;
  max_sync_count?: number;
  capabilities?: string[];
  collection_resilience?: {
    enabled: boolean;
    api_first: boolean;
    browser_fallback: boolean;
    browser_headless: boolean;
    cooldown_seconds: number;
    cooldown_cap_seconds: number;
  };
  private_list_readiness?: {
    reported: boolean;
    like_ready: boolean;
    collection_ready: boolean;
    missing_requirements: Array<'authenticated_session' | 'UIFID'>;
  };
  error?: string | null;
}

export type DouyinSourceMode = 'like' | 'collect' | 'post';
export type DouyinLibrarySort = 'collection' | 'published';

export interface DouyinLoginStatus {
  running: boolean;
  message: string;
  error: string;
  started?: boolean;
  browser_opened?: boolean;
  browser_mode?: 'starting' | 'visible_chrome' | 'headless' | 'idle' | string;
  qr_ready?: boolean;
  qr_version?: number;
  observed_cookie_count?: number;
  authenticated?: boolean;
  cookie_valid?: boolean;
  cookie_count?: number;
}

export interface DouyinLocalHandoff {
  token: string;
  connector_url: string;
  expires_in: number;
}

export interface DouyinCollectionJob {
  job_id: string;
  url: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  /** Requested range for the running metadata sync. */
  target?: number;
  /** Real, de-duplicated items read so far; separate from final success. */
  processed?: number;
  error?: string | null;
  mode?: DouyinSourceMode | null;
  error_code?: '' | 'source_blocked' | 'argus_uifid_missing' | 'risk_controlled' | 'verification_required' | 'session_expired' | 'network_error' | 'connector_error';
  source_mode?: DouyinSourceMode;
  channel?: 'api' | 'browser' | 'circuit_breaker';
  fallback_attempted?: boolean;
  retry_after_seconds?: number;
  needs_action?: boolean;
  temporary_restored?: number;
}

export interface DouyinLibraryItem {
  id: string;
  aweme_id: string;
  title: string;
  caption: string;
  author_name: string;
  media_type: string;
  tags: string[];
  date: string;
  recorded_at: string;
  publish_timestamp?: number | null;
  source_rank?: number | null;
  source_synced_at?: string;
  source_mode: DouyinSourceMode | 'unknown' | 'import';
  source_url: string;
  media_url: string;
  cover_url: string;
  cover_proxy_url?: string;
  gallery_images?: string[];
  can_extract: boolean;
  extracted: boolean;
  extracted_note_id?: string | null;
  transcript_chars: number;
  ai_initialized: boolean;
  card_type?: CardType | null;
  platform?: 'douyin' | 'bilibili' | 'xiaohongshu' | string;
}

export interface DouyinLibraryListResult {
  items: DouyinLibraryItem[];
  total: number;
  source_total: number;
  hidden: {
    temporary: number;
    permanent: number;
  };
  permanent_hidden_total: number;
  catalog_warning?: string;
  catalog_channels?: {
    desktop_local: number;
    legacy_sidecar: number;
  };
}

export interface DouyinLocalSyncItem {
  video_id: string;
  source_url: string;
  title: string;
  caption: string;
  author_name: string;
  cover_url: string;
  published_at: string;
  duration_seconds: number;
  source_rank: number;
}

export interface DouyinLocalSyncResult {
  accepted: number;
  created: number;
  reused: number;
  ready: number;
  quarantined: number;
  source_mode: DouyinSourceMode;
  source_synced_at: string;
  video_ids: string[];
}

export interface DouyinPermanentHiddenItem {
  aweme_id: string;
  title: string;
  cover_url: string;
  author_name: string;
  source_mode: DouyinSourceMode | 'unknown';
  hidden_mode: 'permanent';
  hidden_at: string;
}

export type DouyinBatchExtractionOperation = 'transcript' | 'ai' | 'full';

export type DouyinBatchExtractionState =
  | 'queued'
  | 'transcribing'
  | 'analyzing'
  | 'done'
  | 'error';

export interface DouyinBatchExtractionItem {
  aweme_id: string;
  state: DouyinBatchExtractionState;
  error: string;
  note_id?: string | null;
  transcript_chars: number;
  ai_initialized: boolean;
  card_type?: CardType | null;
  already_existed: boolean;
  updated_at: string;
}

export interface DouyinBatchExtractionJob {
  job_id: string;
  operation: DouyinBatchExtractionOperation;
  status: 'running' | 'success' | 'partial' | 'failed';
  error?: string;
  created_at: string;
  started_at: string;
  finished_at?: string | null;
  concurrency: { asr: number; llm: number };
  total: number;
  success: number;
  failed: number;
  active: number;
  queued: number;
  items: DouyinBatchExtractionItem[];
  database_stores_media: false;
}

export interface DouyinVideoWorkspace {
  item: DouyinLibraryItem;
  note: NoteDetail | null;
  plan: PlanData | null;
  media_storage: {
    provider: 'douyin-downloader' | string;
    mode: 'external' | string;
    database_stores_media: false;
  };
}

export type PlatformLibraryPlatform = 'bilibili' | 'xiaohongshu';
export type LibraryPlatformFilter = 'all' | 'douyin' | PlatformLibraryPlatform;

export interface PlatformLibraryItem {
  id: string;
  video_id: string;
  title: string;
  platform: PlatformLibraryPlatform;
  caption: string;
  author_name: string;
  cover_url: string;
  source_url: string;
  media_url: string;
  media_type: 'video' | 'image' | string;
  tags: string[];
  published_at: string;
  imported_at: string;
  transcript_chars: number;
  transcript_source: 'manual-subtitle' | 'automatic-subtitle' | 'cloud-asr' | 'local-asr' | 'caption-only' | string;
  speech_ready: boolean;
  degraded: boolean;
  ai_initialized: boolean;
  card_type?: CardType | null;
  source_mode?: DouyinSourceMode | 'unknown' | 'import';
  /** 列表请求省略完整文稿；详情和导入响应才携带 Note。 */
  note?: NoteDetail;
}

export interface PlatformLibraryListResult {
  items: PlatformLibraryItem[];
  total: number;
}

export interface PlatformLibraryImportEntry {
  input: string;
  success: boolean;
  status: 'imported' | 'reused' | 'failed';
  item?: PlatformLibraryItem;
  platform?: PlatformLibraryPlatform | 'unknown';
  error?: string;
}

export interface PlatformLibraryImportResult {
  items: PlatformLibraryImportEntry[];
  total: number;
  success: number;
  failed: number;
}

export type CreatorSourcePlatform = 'douyin' | 'bilibili' | 'xiaohongshu';
export type CreatorSyncOperation =
  | 'recent_transcript'
  | 'catalog_all'
  | 'selected_transcript';
export type CreatorSyncStage =
  | 'queued'
  | 'resolving'
  | 'discovering'
  | 'importing'
  | 'transcribing'
  | 'retry_wait'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type CreatorCatalogItemStatus =
  | 'all'
  | 'untranscribed'
  | 'imported'
  | 'failed';

export interface CreatorSourceSnapshot {
  id?: string;
  platform: CreatorSourcePlatform;
  creator_id?: string;
  profile_url: string;
  display_name: string;
  avatar_url: string;
}

export interface CreatorSyncNeedsAction {
  required: boolean;
  code: string;
  message: string;
}

export interface CreatorSyncRunItem {
  id?: string;
  run_id?: string;
  source_id?: string;
  source_item_id?: string | null;
  external_id: string;
  status:
    | 'pending'
    | 'processing'
    | 'importing'
    | 'imported'
    | 'succeeded'
    | 'reused'
    | 'removed'
    | 'skipped_removed'
    | 'failed'
    | 'cancelled'
    | string;
  state?: CreatorSyncRunItem['status'];
  note_id?: string | null;
  ordinal?: number;
  attempt_count?: number;
  max_attempts?: number;
  error_code?: string;
  error_message?: string;
  next_retry_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreatorSyncRun {
  id: string;
  source_id: string;
  platform: CreatorSourcePlatform;
  status: CreatorSyncStage;
  operation: CreatorSyncOperation;
  requested_limit: 20 | 50 | 100;
  target_count: number;
  checked_count: number;
  discovered_count: number;
  processed_count: number;
  total_count: number | null;
  discovery_complete: boolean;
  new_count: number;
  reused_count: number;
  failed_count: number;
  skipped_count: number;
  results: CreatorSyncRunItem[];
  error_code: string;
  error_message: string;
  source_snapshot: CreatorSourceSnapshot;
  needs_action: CreatorSyncNeedsAction;
  attempt_count?: number;
  next_retry_at?: string | null;
  cancellation_requested: boolean;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at: string;
}

export interface CreatorSourceItemPart {
  cid: string;
  page: number;
  title: string;
  page_url: string;
  id?: string;
  url?: string;
  duration_seconds?: number | null;
}

export interface CreatorSourceItem {
  id: string;
  source_id: string;
  platform: CreatorSourcePlatform;
  external_id: string;
  source_url: string;
  canonical_url?: string;
  title: string;
  cover_url: string;
  description: string;
  author_name: string;
  published_at?: string | null;
  duration_seconds?: number | null;
  discovery_order?: number | null;
  order_index?: number | null;
  parts?: CreatorSourceItemPart[];
  last_seen_run_id?: string | null;
  is_available: boolean;
  available?: boolean;
  availability_status?: 'available' | 'unavailable' | 'removed' | string;
  transcript_status?: Exclude<CreatorCatalogItemStatus, 'all'> | string;
  status?: Exclude<CreatorCatalogItemStatus, 'all'> | 'unavailable' | string;
  note_id?: string | null;
  last_error?: string;
  error_code?: string;
  can_transcribe?: boolean;
  discovered_at?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  removed_at?: string | null;
  unavailable_at?: string | null;
  updated_at: string;
}

export interface CreatorPaginatedResult<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  next_cursor?: string | null;
}

export interface CreatorSource {
  id: string;
  platform: CreatorSourcePlatform;
  creator_id: string;
  profile_url: string;
  display_name: string;
  avatar_url: string;
  status: 'active' | 'disabled' | 'unavailable';
  last_synced_at?: string | null;
  last_success_at?: string | null;
  last_error_code: string;
  catalog_count?: number;
  available_count?: number;
  transcript_count?: number;
  catalog_counts?: {
    total: number;
    untranscribed: number;
    imported: number;
    failed: number;
  };
  created_at: string;
  updated_at: string;
  last_run?: CreatorSyncRun | null;
}

export interface CreatorSourcePreview {
  platform: CreatorSourcePlatform;
  creator_id: string;
  profile_url: string;
  display_name: string;
  avatar_url: string;
}

export interface CreatorSourceCatalog {
  enabled: boolean;
  platforms: Record<CreatorSourcePlatform, boolean>;
  catalog_operations?: {
    recent_transcript?: Partial<Record<CreatorSourcePlatform, boolean>>;
    selected_transcript?: Partial<Record<CreatorSourcePlatform, boolean>>;
    catalog_all?: Partial<Record<CreatorSourcePlatform, boolean>>;
  };
  operations?: CreatorSyncOperation[];
  catalog_platforms?: CreatorSourcePlatform[];
  limits: Array<20 | 50 | 100>;
  max_sources: number;
  max_selected_items?: number;
  catalog_page_size?: number;
}

export interface CreatorSourceListResult {
  catalog: CreatorSourceCatalog;
  items: CreatorSource[];
}

export interface PlanAgentResult {
  plan: PlanData;
  created: boolean;
  change_summary: string;
  source_context: NoteSourceContext;
}

export interface LibraryEvidence extends NoteEvidence {
  note_id: string;
  title: string;
}

export interface LibraryClaim {
  claim_id: string;
  kind: 'recurring' | 'common' | 'difference' | 'fact' | 'action' | 'uncertain' | string;
  text: string;
  explanation?: string;
  supporting_note_ids: string[];
  support_count: number;
  research_source_count: number;
  evidence: LibraryEvidence[];
}

export interface LibrarySourceContext {
  note_count: number;
  transcript_chars: number;
  scanned_chunks: number;
  selected_chunks: number;
  ai_summary_count: number;
  visual_source_count?: number;
  matched_note_count: number;
  context_note_count: number;
  research_mode: 'fast' | 'deep';
  output_style: LibraryOutputStyle;
  coverage: 'focused' | 'broad';
  map_calls: number;
  validated_map_finding_count?: number;
  web_search_attempted?: boolean;
  web_search_succeeded?: boolean;
  web_verified_source_count?: number;
  agent_trace: LibraryAgentStage[];
  sources: Array<{ note_id: string; title: string }>;
}

export type LibraryResearchMode = 'auto' | 'fast' | 'deep';
export type LibraryOutputStyle = 'answer' | 'summary' | 'comparison' | 'action_plan' | 'custom';
export type AgentGroundingStatus = 'grounded' | 'partially_grounded' | 'ungrounded';

export interface AgentCitationCoverage {
  requested: number;
  matched: number;
  verified: number;
  ratio: number;
}

export interface LibraryAgentStage {
  stage:
    | 'plan'
    | 'retrieve'
    | 'map'
    | 'planning'
    | 'scan'
    | 'rank'
    | 'web'
    | 'synthesize'
    | 'verify';
  label: string;
  detail: string;
  status?: 'completed' | 'failed' | 'skipped';
  duration_ms?: number;
  counts?: Record<string, number | boolean>;
}

export interface LibraryAskResult {
  note_ids: string[];
  answer: string;
  claims?: LibraryClaim[];
  grounded: boolean;
  grounding_status?: AgentGroundingStatus;
  citation_coverage?: AgentCitationCoverage;
  limitations?: string[];
  evidence: LibraryEvidence[];
  follow_up_questions: string[];
  source_context: LibrarySourceContext;
  web_sources: WebResearchSource[];
  web_scope: ResearchScope;
}

// ============================================================================
// Video Agent workspace
// ============================================================================

/**
 * `yesterday_new` intentionally means content first organised into Zhicui
 * yesterday. Douyin does not expose a trustworthy collection timestamp for
 * every item, so the UI must not describe this scope as the user's exact
 * collection time.
 */
export type AgentSourceScope =
  | 'all_ready'
  | 'yesterday_new'
  | 'collect'
  | 'like'
  | 'post'
  | 'selected';
export type AgentSourceMode = 'all' | DouyinSourceMode;
export type AgentThreadStatus =
  | 'ready'
  | 'running'
  | 'awaiting_approval'
  | 'running_analysis'
  | 'failed'
  | 'archived';
export type AgentDeliveryChannel = 'email';
export type AgentAutomationSourceScope = 'yesterday' | 'yesterday_new';
export type AgentAutomationStatus =
  | 'completed'
  | 'failed'
  | 'running'
  | 'cancelled';
export type AgentAutomationDeliveryStatus =
  | 'skipped'
  | 'delivering'
  | 'sent'
  | 'not_configured'
  | 'verification_required'
  | 'failed'
  | 'unknown';

export interface AgentSource {
  note_id: string;
  video_id?: string;
  platform?: 'douyin' | 'bilibili' | 'xiaohongshu' | string;
  title: string;
  author_name: string;
  cover_url: string;
  source_url?: string;
  source_mode: DouyinSourceMode | 'unknown';
  source_rank?: number | null;
  source_synced_at?: string | null;
  created_at?: string | null;
  transcript_chars: number;
  ready?: boolean;
  ai_initialized?: boolean;
  visual_analysis?: {
    status: string;
    scene_count?: number;
    frame_count?: number;
    updated_at?: string | null;
  } | null;
  first_seen_at?: string | null;
  source_added_at?: string | null;
  match?: {
    rank: number;
    score: number;
    fields: Array<'title' | 'author' | 'summary' | 'transcript'>;
    snippet: string;
  };
}

export interface AgentSourceList {
  items: AgentSource[];
  included_items?: AgentSource[];
  total: number;
  ready_count?: number;
  channel_counts?: {
    collect: number;
    like: number;
    post: number;
  };
  scope?: Exclude<AgentSourceScope, 'selected'>;
  source_scope?: Exclude<AgentSourceScope, 'selected'>;
  scope_type?: Exclude<AgentSourceScope, 'selected'>;
  scope_label?: string;
  max_sources?: number;
  truncated?: boolean;
  database_stores_media?: false;
  as_of?: string | null;
}

export interface AgentStarterQuestions {
  questions: string[];
  source_count: number;
  available_count: number;
  source_scope: AgentSourceScope;
  scope_label: string;
  truncated: boolean;
}

export interface AgentSourceSearchResult extends AgentSourceList {
  query: string;
  search_mode: 'smart' | 'keyword_fallback';
  expanded_queries: string[];
  matched_count: number;
  scanned_count: number;
}

export interface AgentMessage {
  id: string;
  thread_id: string;
  turn_id?: string | null;
  role: NoteChatRole;
  content: string;
  created_at: string;
  grounded?: boolean;
  grounding_status?: AgentGroundingStatus;
  citation_coverage?: AgentCitationCoverage;
  limitations?: string[];
  evidence?: LibraryEvidence[];
  follow_up_questions?: string[];
  source_context?: LibrarySourceContext | null;
  web_sources?: WebResearchSource[];
  result?: Partial<LibraryAskResult> & {
    note_ids?: string[];
    type?:
      | 'video_analysis_approval_required'
      | 'video_analysis_analysis_started'
      | 'video_analysis_cancelled'
      | 'video_analysis_resume_failed'
      | string;
    video_analysis?: VideoAnalysisPrepareResult | VideoAnalysisRunResult | {
      run?: VideoAnalysisRun;
      quote?: VideoAnalysisQuote | null;
      items?: VideoAnalysisItem[];
      requires_confirmation?: boolean;
      can_start?: boolean;
    };
    plan_change?: PlanCoachPreview & {
      state: 'pending' | 'applied';
      applied_at?: string;
      applied_plan_updated_at?: string;
    };
  };
}

export type AgentTurnStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTurn {
  id: string;
  thread_id: string;
  client_turn_id: string;
  status: AgentTurnStatus;
  phase: string;
  requested_mode: LibraryResearchMode;
  resolved_mode?: 'fast' | 'deep' | null;
  output_style: LibraryOutputStyle;
  web_scope: ResearchScope;
  attempt_count: number;
  cancellation_requested: boolean;
  source_total_count: number;
  scanned_count: number;
  mapped_count: number;
  deep_read_count: number;
  failed_source_count: number;
  claim_count: number;
  evidence_count: number;
  last_event_seq: number;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at: string;
}

export interface AgentThread {
  id: string;
  title: string;
  status: AgentThreadStatus;
  source_scope: AgentSourceScope;
  scope_type?: AgentSourceScope;
  source_ids: string[];
  source_count: number;
  message_count: number;
  last_message?: string | null;
  messages?: AgentMessage[];
  sources?: AgentSource[];
  active_turn?: AgentTurn | null;
  context_type?: 'video' | 'plan';
  context_id?: string | null;
  context?: {
    type: 'plan';
    id: string;
    title: string;
    available: boolean;
    plan?: PlanData | null;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface AgentThreadList {
  items: AgentThread[];
  total: number;
}

export interface AgentThreadCreate {
  title?: string;
  source_scope: AgentSourceScope;
  source_ids?: string[];
  context_type?: 'video' | 'plan';
  context_id?: string;
}

export interface AgentPlanChangeApplyResult {
  plan: PlanData;
  message: AgentMessage;
}

export interface AgentThreadUpdate {
  title: string;
}

export interface AgentMessageCreate {
  content: string;
  client_turn_id?: string;
  research_mode?: LibraryResearchMode;
  output_style?: LibraryOutputStyle;
  custom_instruction?: string;
  web_scope?: ResearchScope;
}

export interface AgentMessageResult {
  thread: AgentThread;
  user_message: AgentMessage;
  assistant_message: AgentMessage;
  turn?: AgentTurn;
  terminal?: 'approval_required' | 'analysis_started' | 'done' | 'cancelled';
  video_analysis?: VideoAnalysisPrepareResult | VideoAnalysisRunResult | Record<string, unknown>;
}

export type AgentStreamStage =
  | 'queued'
  | 'reading'
  | 'planning'
  | 'scanning'
  | 'ranking'
  | 'researching'
  | 'web'
  | 'synthesizing'
  | 'verifying'
  | 'finalizing'
  | 'completed';

export interface AgentStreamProgress {
  stage: AgentStreamStage;
  message: string;
  event_type?: string;
  source_count?: number;
  matched_source_count?: number;
  selected_chunk_count?: number;
  context_source_count?: number;
  evidence_count?: number;
  web_source_count?: number;
  turn_id?: string;
  event_seq?: number;
  resolved_mode?: 'fast' | 'deep';
  source_total_count?: number;
  scanned_count?: number;
  mapped_count?: number;
  deep_read_count?: number;
  claim_count?: number;
  batch_index?: number;
  batch_total?: number;
  batch_source_count?: number;
  completed_batch_count?: number;
  failed_batch_count?: number;
  failed_source_count?: number;
  finding_count?: number;
  duration_ms?: number;
  tool_name?: string;
  call_index?: number;
  streaming?: boolean;
}

export interface AgentAutomation {
  id: string;
  name: string;
  enabled: boolean;
  timezone: string;
  schedule_time: string;
  source_scope: AgentAutomationSourceScope;
  source_mode: AgentSourceMode;
  instruction: string;
  channel: AgentDeliveryChannel;
  recipient_email: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentAutomationList {
  items: AgentAutomation[];
  total: number;
}

export interface AgentAutomationCreate {
  name: string;
  enabled?: boolean;
  timezone: string;
  schedule_time: string;
  source_scope: AgentAutomationSourceScope;
  source_mode: AgentSourceMode;
  instruction: string;
  channel: AgentDeliveryChannel;
  recipient_email: string;
}

export type AgentAutomationUpdate = Partial<AgentAutomationCreate>;

export interface AgentAutomationRun {
  id: string;
  automation_id: string;
  trigger: 'scheduled' | 'manual';
  status: AgentAutomationStatus;
  source_count: number;
  ready_count?: number;
  result_text?: string;
  result?: Record<string, unknown>;
  delivery_status: AgentAutomationDeliveryStatus;
  delivery_error: string;
  agent_thread_id?: string | null;
  scheduled_for?: string | null;
  subject?: string | null;
  summary?: string | null;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
}

export interface AgentAutomationRunList {
  items: AgentAutomationRun[];
  total: number;
}

export interface AgentEmailDeliveryStatus {
  configured: boolean;
  provider: 'smtp' | 'preview' | string;
  from_name: string;
}

export interface AgentEmailStatus {
  account_email: string;
  email_verified: boolean;
  delivery: AgentEmailDeliveryStatus;
}

export type AgentEmailVerificationSendResult =
  | { email_verified: true; status: 'already_verified' }
  | { email_verified: false; status: 'submitted' };

export type AgentEmailVerificationConfirmResult = {
  email_verified: true;
  status: 'verified' | 'already_verified';
};

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export const CARD_TYPE_CONFIG: Record<CardType, { emoji: string; label: string; accent: string }> = {
  recipe: { emoji: '🍳', label: '食谱', accent: '#f97316' },
  insight: { emoji: '💡', label: '洞察', accent: '#2563eb' },
  history: { emoji: '📚', label: '历史', accent: '#f59e0b' },
  product: { emoji: '🛒', label: '产品', accent: '#f43f5e' },
  plan: { emoji: '📋', label: '计划', accent: '#4f5bd5' },
  general: { emoji: '📝', label: '通用', accent: '#64748b' },
};

// ============================================================================
// Plan types
// ============================================================================

export type PlanPriority = 'low' | 'medium' | 'high';

export interface PlanTask {
  id: string;
  title: string;
  done: boolean;
  day?: number;
  scheduled_at?: string | null;
  reminder_at?: string | null;
  duration_minutes?: number | null;
  frequency?: string | null;
  details?: PlanField[];
  priority?: PlanPriority;
  position?: number;
  focus_date?: string | null;
  focus_order?: number | null;
  completed_at?: string | null;
}

export interface PlanField {
  name: string;
  label: string;
  type: string;
  value?: unknown;
  group?: string;
}

export interface PlanDay {
  day: number;
  label: string;
  date?: string | null;
  focus?: string | null;
  tasks: PlanTask[];
}

export interface PlanData {
  id: string;
  note_id?: string | null;
  title: string;
  schema_version: number;
  fields: PlanField[];
  tasks: PlanTask[];
  days: PlanDay[];
  status: 'draft' | 'active' | 'done';
  start_date?: string | null;
  completed_at?: string | null;
  total_days?: number;
  created_at?: string;
  updated_at?: string;
}

export interface PlanFocusTask {
  plan_id: string;
  plan_title: string;
  task_id: string;
  title: string;
  day?: number | null;
  scheduled_at?: string | null;
  duration_minutes?: number | null;
  frequency?: string | null;
  priority: PlanPriority;
  position?: number;
  focus_date?: string | null;
  focus_order?: number | null;
  recommendation_reason?: string | null;
  note_id?: string | null;
}

export interface PlanOverview {
  summary: PlanStats;
  date: string;
  focus: PlanFocusTask[];
  suggestions: PlanFocusTask[];
  today: PlanFocusTask[];
  overdue: PlanFocusTask[];
  upcoming: PlanFocusTask[];
  unscheduled: PlanFocusTask[];
}

export interface PlanWeeklyReviewSummary {
  completed_tasks: number;
  scheduled_tasks: number;
  carried_over_tasks: number;
  overdue_tasks: number;
  completed_plans: number;
}

export interface PlanWeeklyReviewRow {
  plan_id: string;
  plan_title: string;
  completed: number;
  scheduled: number;
  carried_over: number;
  overdue: number;
  open: number;
}

export interface PlanWeeklyReview {
  week_start: string;
  week_end: string;
  summary: PlanWeeklyReviewSummary;
  plans: PlanWeeklyReviewRow[];
  partial_history: boolean;
  history_started_at?: string | null;
  history_note: string;
}

export interface PlanCoachDiff {
  additions: Array<{ task_id: string; title: string }>;
  modifications: Array<{
    task_id: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }>;
  removals: Array<{ task_id: string; title: string }>;
  completed_tasks_preserved: number;
}

export interface PlanCoachPreview {
  plan_id: string;
  base_updated_at: string;
  change_summary: string;
  diff: PlanCoachDiff;
  operations: Array<Record<string, unknown>>;
  preview_plan: PlanData;
  source_context?: Record<string, unknown>;
}


/** Day/progress helpers for PlanData. */
export function getPlanCurrentDay(plan: PlanData): number {
  let startDate = plan.start_date;
  if (!startDate && plan.created_at) {
    startDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(plan.created_at));
  }
  if (!startDate) return 1;
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const today = new Date(`${getChinaToday()}T00:00:00+08:00`);
  const diffDays = Math.floor((today.getTime() - start.getTime()) / 86400000);
  return Math.max(1, diffDays + 1);
}

export function getPlanTasks(plan: PlanData): PlanTask[] {
  const dayTasks = plan.days?.flatMap(day =>
    day.tasks.map(task => ({ ...task, day: task.day ?? day.day }))
  ) ?? [];
  return dayTasks.length > 0 ? dayTasks : plan.tasks ?? [];
}

export function getTaskPriority(task: PlanTask): PlanPriority {
  return task.priority === 'high' || task.priority === 'low' ? task.priority : 'medium';
}

export function getChinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function formatPlanSchedule(value?: string | null): string | null {
  if (!value) return null;
  const dateValue = value.slice(0, 10);
  const timeValue = value.length >= 16 ? value.slice(11, 16) : '';
  const dateLabel = dateValue === getChinaToday()
    ? '今天'
    : dateValue.slice(5).replace('-', '/');
  return timeValue ? `${dateLabel} ${timeValue}` : dateLabel;
}

export function formatPlanDuration(value?: number | null): string | null {
  if (!value || value < 1) return null;
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export function formatPlanFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(item => formatPlanFieldValue(item)).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}：${formatPlanFieldValue(item)}`)
      .join('；');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return value == null || value === '' ? '—' : String(value);
}

export function getPlanProgress(plan: PlanData): { done: number; total: number; pct: number } {
  const all = getPlanTasks(plan);
  const total = all.length;
  const done = all.filter(t => t.done).length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export function getTodayTasks(plan: PlanData): PlanTask[] {
  const today = getChinaToday();
  const currentDay = getPlanCurrentDay(plan);
  return getPlanTasks(plan).filter(task =>
    !task.done && (
      task.scheduled_at?.startsWith(today)
      || (!task.scheduled_at && task.day === currentDay)
    )
  );
}

export function getOverdueTasks(plan: PlanData): PlanTask[] {
  const today = getChinaToday();
  return getPlanTasks(plan).filter(task =>
    !task.done && !!task.scheduled_at && task.scheduled_at.slice(0, 10) < today
  );
}

/**
 * Tasks due "today" by the plan's day calendar — i.e. the unfinished tasks on
 * the current day (derived from created_at). Unlike getTodayTasks, this works
 * for AI-generated plans whose tasks carry no scheduled_at.
 */
export function getTodayDayTasks(plan: PlanData): PlanTask[] {
  const currentDay = getPlanCurrentDay(plan);
  const todayDay = plan.days?.find(d => d.day === currentDay);
  if (!todayDay) return [];
  const today = getChinaToday();
  return todayDay.tasks.filter(task =>
    !task.done && (!task.scheduled_at || task.scheduled_at.startsWith(today))
  );
}

/** The PlanDay object for the plan's current day, or null if it doesn't exist. */
export function getTodayDay(plan: PlanData): PlanDay | null {
  const currentDay = getPlanCurrentDay(plan);
  return plan.days?.find(d => d.day === currentDay) ?? null;
}
export interface PlanStats {
  active_plans: number;
  open_tasks: number;
  due_today: number;
  overdue_tasks: number;
  focus_tasks?: number;
  unscheduled_tasks?: number;
}

// ============================================================================
// Multi-style card display system types
// ============================================================================

/** Card display style presets */
export type CardStyle =
  | 'hero'
  | 'minimal'
  | 'standard'
  | 'creative'
  | 'magazine'
  | 'compact'
  | 'aurora'
  | 'blueprint'
  | 'paper';

/** Information density levels */
export type DensityLevel = 'low' | 'medium' | 'high';

/** Global application theme shared by Web, Android, and Windows */
export type AppTheme = 'light' | 'dark' | 'system';

/** @deprecated Kept only so older local settings can be migrated safely. */
export type DesktopSidebarAppearance = AppTheme;

/** Windows desktop workspace spacing */
export type DesktopLayoutDensity = 'comfortable' | 'compact';

/** Automatic Douyin collection refresh interval on the current device, in minutes. */
export type LibraryAutoSyncIntervalMinutes = number;

/** Number of video sources loaded into the question workspace browser. */
export type AgentSourceDisplayLimit = 100 | 200 | 500 | 1000;

/** User settings shape persisted to localStorage */
export interface UserSettings {
  cardStyle: CardStyle;
  density: DensityLevel;
  theme: AppTheme;
  desktopSidebar?: DesktopSidebarAppearance;
  desktopDensity: DesktopLayoutDensity;
  localWorkspaceCache: boolean;
  libraryAutoSyncIntervalMinutes: LibraryAutoSyncIntervalMinutes;
  agentSourceDisplayLimit: AgentSourceDisplayLimit;
}

/** Per-note override (volatile component state, not persisted) */
export interface NoteOverrides {
  style: CardStyle | null;
  density: DensityLevel | null;
}

/** Metadata descriptor for each card style preset */
export interface CardStyleMeta {
  key: CardStyle;
  label: string;
  description: string;
  icon: string;
}

/** Shared props interface for all card style components */
export interface StyleCardProps {
  cardData: CardData;
  density: DensityLevel;
  cardRef?: React.RefObject<HTMLDivElement | null>;
}

export const CARD_STYLE_CONFIG: Record<CardStyle, CardStyleMeta> = {
  hero:     { key: 'hero',     label: '聚光',  description: '数字滚动·逐字浮现·进度光条',   icon: '✦' },
  minimal:  { key: 'minimal',  label: '极简',  description: '呼吸感·慢速淡入·星星弹跳',     icon: '◻' },
  standard: { key: 'standard', label: '标准',  description: '3D翻转·流光边框·弹性指示条',   icon: '🪟' },
  creative: { key: 'creative', label: '创意',  description: '霓虹脉冲·3D视差·贝塞尔粒子',   icon: '🎨' },
  magazine: { key: 'magazine', label: '杂志',  description: '双栏滑入·弹性引号·翻页节奏',   icon: '📰' },
  compact:  { key: 'compact',  label: '列表',  description: '弹性折叠·GSAP手风琴·交错展开',  icon: '📋' },
  aurora:   { key: 'aurora',   label: '流光',  description: '极光幕布·悬浮层次·柔和呼吸',     icon: '≈' },
  blueprint:{ key: 'blueprint',label: '蓝图',  description: '技术网格·编号路径·扫描线',         icon: '⌗' },
  paper:    { key: 'paper',    label: '纸感',  description: '暖白纸张·墨色层级·边注排版',       icon: '✎' },
};

export const DENSITY_CONFIG: Record<DensityLevel, { label: string; description: string }> = {
  low:    { label: '简要', description: '仅展示结论与评分' },
  medium: { label: '标准', description: '章节、结论与评分' },
  high:   { label: '详细', description: '展示全部章节与补充信息' },
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  cardStyle: 'hero',
  density: 'medium',
  theme: 'light',
  desktopDensity: 'comfortable',
  localWorkspaceCache: true,
  libraryAutoSyncIntervalMinutes: 0,
  agentSourceDisplayLimit: 200,
};
