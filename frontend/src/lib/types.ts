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
  video_title?: string;
  video_id?: string;
  cover_url?: string;
  author_name?: string;
  platform?: string;
  source_kind?: string;
  source_recorded_at?: string;
  /** New adaptive-profile fields (server-side defaults keep older cards working). */
  tone?: ContentTone;
  density?: ContentDensity;
  hero_quote?: string;
  key_insight?: string;
  stats?: CardStat[];
  /** plan_id when the extract pipeline auto-created a Plan for this note. */
  plan_id?: string | null;
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
  transcript_chars?: number;
  ai_initialized: boolean;
  seo_meta?: string;
  tone?: ContentTone;
  density?: ContentDensity;
  section_count?: number;
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

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
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

export type NoteEvidenceSource = 'transcript' | 'summary';
export type ResearchScope = 'auto' | 'video_only';

export interface NoteEvidence {
  quote: string;
  source: NoteEvidenceSource;
  position_percent?: number;
}

export type NoteTranscriptMode = 'full' | 'retrieved' | 'none';
export type NoteAnswerMode = 'grounded' | 'creative';

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
  stage: 'plan' | 'retrieve' | 'web' | 'map' | 'synthesize';
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

export interface DouyinLibraryStatus {
  connected: boolean;
  base_url: string;
  cookie_valid: boolean;
  cookie_count: number;
  storage_mode?: 'metadata_only' | 'local_media' | 'unknown';
  login_browser_mode?: 'visible_chrome' | 'remote_capture' | 'headless' | 'unavailable' | string;
  max_sync_count?: number;
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
  error?: string | null;
  mode?: DouyinSourceMode | null;
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
  source_mode: DouyinSourceMode | 'unknown';
  source_url: string;
  media_url: string;
  cover_url: string;
  cover_proxy_url?: string;
  can_extract: boolean;
  extracted: boolean;
  extracted_note_id?: string | null;
  transcript_chars: number;
  ai_initialized: boolean;
  card_type?: CardType | null;
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

export interface LibrarySourceContext {
  note_count: number;
  transcript_chars: number;
  scanned_chunks: number;
  selected_chunks: number;
  ai_summary_count: number;
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

export type LibraryResearchMode = 'fast' | 'deep';
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
export type AgentThreadStatus = 'ready' | 'running' | 'failed' | 'archived';
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
  first_seen_at?: string | null;
  source_added_at?: string | null;
}

export interface AgentSourceList {
  items: AgentSource[];
  total: number;
  ready_count?: number;
  scope?: Exclude<AgentSourceScope, 'selected'>;
  source_scope?: Exclude<AgentSourceScope, 'selected'>;
  scope_type?: Exclude<AgentSourceScope, 'selected'>;
  scope_label?: string;
  max_sources?: number;
  truncated?: boolean;
  database_stores_media?: false;
  as_of?: string | null;
}

export interface AgentMessage {
  id: string;
  thread_id: string;
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
  };
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
}

export interface AgentThreadUpdate {
  title: string;
}

export interface AgentMessageCreate {
  content: string;
  research_mode?: LibraryResearchMode;
  output_style?: LibraryOutputStyle;
  custom_instruction?: string;
  web_scope?: ResearchScope;
}

export interface AgentMessageResult {
  thread: AgentThread;
  user_message: AgentMessage;
  assistant_message: AgentMessage;
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
  insight: { emoji: '💡', label: '洞察', accent: '#10b981' },
  history: { emoji: '📚', label: '历史', accent: '#f59e0b' },
  product: { emoji: '🛒', label: '产品', accent: '#f43f5e' },
  plan: { emoji: '📋', label: '计划', accent: '#6366f1' },
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
}

export interface PlanOverview {
  summary: PlanStats;
  today: PlanFocusTask[];
  overdue: PlanFocusTask[];
  upcoming: PlanFocusTask[];
}


/** Day/progress helpers for PlanData. */
export function getPlanCurrentDay(plan: PlanData): number {
  if (!plan.created_at) return 1;
  const start = new Date(plan.created_at);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - start.getTime()) / 86400000);
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

/** User settings shape persisted to localStorage */
export interface UserSettings {
  cardStyle: CardStyle;
  density: DensityLevel;
  theme: AppTheme;
  desktopSidebar?: DesktopSidebarAppearance;
  desktopDensity: DesktopLayoutDensity;
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
};
