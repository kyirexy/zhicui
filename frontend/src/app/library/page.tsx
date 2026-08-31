'use client';

import { App } from '@capacitor/app';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow,
  Bookmark,
  Bot,
  CalendarCheck,
  Check,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  CircleMinus,
  Download,
  EyeOff,
  ExternalLink,
  FileText,
  Heart,
  Info,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  NotebookPen,
  Plus,
  QrCode,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Search,
  ServerOff,
  SlidersHorizontal,
  Square,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import CrossPlatformLibraryRow from '@/components/CrossPlatformLibraryRow';
import LibraryExtractionLiveProgress from '@/components/LibraryExtractionLiveProgress';
import MarqueeSelectionOverlay from '@/components/MarqueeSelectionOverlay';
import LibraryPreviewPane, {
  type LibraryPreviewSelection,
} from '@/components/LibraryPreviewPane';
import LibraryVideoCard, {
  type LibraryExtractState,
} from '@/components/LibraryVideoCard';
import PlatformLibraryPanel, {
  type PlatformLibraryPanelState,
} from '@/components/PlatformLibraryPanel';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import VideoAnalysisBatchAction from '@/components/VideoAnalysisBatchAction';
import VideoAnalysisBatchProgress from '@/components/VideoAnalysisBatchProgress';
import {
  cancelDouyinLogin,
  collectDouyinLibrary,
  createDouyinLocalHandoff,
  deleteDouyinLibraryExtraction,
  disconnectDouyinLibrary,
  getDouyinBatchExtraction,
  getDouyinCollectionJob,
  getDouyinLibraryItem,
  getDouyinLibraryStatus,
  getDouyinLoginQr,
  getDouyinLoginStatus,
  initializePlatformLibraryItem,
  getPlatformLibraryItem,
  ingestLocalDouyinLibrary,
  listDouyinLibraryItems,
  listPermanentlyHiddenDouyinItems,
  removeDouyinLibraryItems,
  restorePermanentlyHiddenDouyinItems,
  startDouyinBatchExtraction,
  startDouyinLogin,
  API_BASE,
} from '@/lib/api';
import {
  isNativeAndroidApp,
} from '@/lib/douyinNative';
import {
  DESKTOP_DOWNLOAD_URL,
  detectDesktopRuntime,
  openInstalledDesktopApp,
} from '@/lib/desktopRuntime';
import {
  formatCollectionSyncMessage,
  formatDouyinSyncError,
  formatMultiSourceSyncSummary,
  hasDouyinSyncFailureDiagnostic,
} from '@/lib/douyinSyncFeedback';
import {
  MIN_LOCAL_DOUYIN_DESKTOP_VERSION,
  requiresLocalDouyinDesktopUpdate,
  supportsLocalDouyinRuntime,
  toLocalDouyinSyncItems,
} from '@/lib/douyinDesktopSync';
import { useLocalStorage } from '@/lib/hooks/useLocalStorage';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useMarqueeSelection } from '@/lib/hooks/useMarqueeSelection';
import {
  QUICK_SYNC_MAX_COUNT,
  readLibraryQuickSyncPreferences,
  saveLibraryQuickSyncPreferences,
} from '@/lib/libraryQuickSync';
import { findNewLibraryItems } from '@/lib/librarySyncDiff';
import type {
  DouyinCollectionJob,
  DouyinBatchExtractionJob,
  DouyinBatchExtractionOperation,
  DouyinLibraryItem,
  DouyinLibraryListResult,
  DouyinLibrarySort,
  DouyinLibraryStatus,
  DouyinPermanentHiddenItem,
  DouyinSourceMode,
  LibraryPlatformFilter,
  PlatformLibraryItem,
} from '@/lib/types';
import styles from './LibraryWorkspace.module.css';

interface ExtractProgress {
  state: LibraryExtractState;
  error?: string;
}

interface LibraryRemovalTarget {
  awemeIds: string[];
  title?: string;
  mode: 'temporary' | 'permanent';
}

interface CollectionJobWaitResult {
  job: DouyinCollectionJob | null;
  error: string;
}

interface SyncCollectionModeResult {
  requestedMode: DouyinSourceMode;
  refreshed: DouyinLibraryItem[] | null;
  newlyVisible: DouyinLibraryItem[];
  overview: DouyinLibraryListResult | null;
  finalJob: DouyinCollectionJob | null;
  error: string;
}

interface CollectionProgressSnapshot {
  current: number;
  target: number;
  percent: number;
}

interface SourceReadabilityState {
  blockedUntil: number;
  needsAction: boolean;
}

interface ExtractionRunResult {
  success: number;
  status: 'skipped' | DouyinBatchExtractionJob['status'];
  error?: string;
  job?: DouyinBatchExtractionJob;
}

interface LibraryPreviewTarget {
  platform: 'douyin' | 'bilibili' | 'xiaohongshu';
  id: string;
}

type SourceManagerView = 'douyin' | 'bilibili' | 'xiaohongshu' | 'import';
type LibraryLayoutMode = 'list' | 'grid';

const MAX_SELECTION = 50;
const MAX_SYNC_COUNT = QUICK_SYNC_MAX_COUNT;
const DEFAULT_SOURCE_SORTS: Record<'like' | 'collect', DouyinLibrarySort> = {
  like: 'collection',
  collect: 'collection',
};
const ALL_LIBRARY_ITEMS = 0;
const SYNC_COUNT_OPTIONS = [50, 100] as const;
const QR_AUTO_RECOVERY_ATTEMPTS = 15;
const JOB_POLL_TIMEOUT_MS = 10_000;
type DouyinSessionAction = 'logout' | 'rebind';
type BindingClient = 'desktop-app' | 'desktop-web' | 'mobile-web' | 'android-app';
const SOURCE_MODE_STORAGE_KEY = 'zhicui-library-source-mode-v1';

const SOURCE_MODES: Array<{
  value: DouyinSourceMode;
  label: string;
  Icon: typeof Heart;
}> = [
  {
    value: 'like',
    label: '喜欢',
    Icon: Heart,
  },
  {
    value: 'collect',
    label: '收藏',
    Icon: Bookmark,
  },
  {
    value: 'post',
    label: '我的作品',
    Icon: UserRound,
  },
];

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function isDouyinSourceMode(value: unknown): value is DouyinSourceMode {
  return value === 'like' || value === 'collect' || value === 'post';
}

function isLibraryLayoutMode(value: unknown): value is LibraryLayoutMode {
  return value === 'list' || value === 'grid';
}

function hasReadyTranscript(item: DouyinLibraryItem): boolean {
  return Boolean(item.extracted_note_id) && item.transcript_chars > 0;
}

function getCollectionProgress(
  job: DouyinCollectionJob | null,
  requestedCount: number,
): CollectionProgressSnapshot {
  const requested = Math.max(1, Math.min(MAX_SYNC_COUNT, Math.trunc(requestedCount || 50)));
  if (!job) return { current: 0, target: requested, percent: 0 };

  const reportedTarget = nonNegativeInteger(job.target);
  const reportedProcessed = nonNegativeInteger(job.processed);
  const total = nonNegativeInteger(job.total);
  const completed = nonNegativeInteger(job.success)
    + nonNegativeInteger(job.failed)
    + nonNegativeInteger(job.skipped);
  const terminal = job.status === 'success' || job.status === 'failed';
  const target = terminal && total > 0
    ? Math.max(total, completed)
    : Math.max(reportedTarget, requested, reportedProcessed);
  const current = terminal && total > 0
    ? Math.min(target, Math.max(total, completed, reportedProcessed))
    : Math.min(target, reportedProcessed);

  return {
    current,
    target,
    percent: target > 0 ? Math.min(100, (current / target) * 100) : 0,
  };
}

const PLATFORM_TABS: Array<{
  value: LibraryPlatformFilter;
  label: string;
}> = [
  { value: 'all', label: '全部视频' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
];

const SOURCE_MANAGER_TABS: Array<{
  value: SourceManagerView;
  label: string;
}> = [
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
  { value: 'import', label: '分享链接' },
];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function friendlyLibraryError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized === 'not found' || normalized.includes('404')) {
    return '当前前端与后端版本不一致，请重启开发服务后重试。';
  }
  if (
    normalized.includes('httpconnectionpool')
    || normalized.includes('connection refused')
    || normalized.includes('winerror 10061')
    || normalized.includes('127.0.0.1')
  ) {
    return '视频连接服务暂时没有响应。你仍可使用单条链接，稍后再回来同步视频资料。';
  }
  return message.length > 180
    ? '视频资料暂时无法连接，请稍后重试。'
    : message;
}

function formatAccountTime(value?: string | null, emptyLabel = '暂无记录'): string {
  if (!value) return emptyLabel;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return emptyLabel;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function canStartLibraryMarquee(target: HTMLElement, container: HTMLElement): boolean {
  const selectableCard = target.closest<HTMLElement>('[data-marquee-id]');
  if (selectableCard) {
    if (target.closest([
      'button',
      'input',
      'select',
      'textarea',
      'summary',
      '[contenteditable="true"]',
      '[role="button"]',
    ].join(','))) return false;

    const anchor = target.closest<HTMLAnchorElement>('a');
    return !anchor || anchor.classList.contains('library-video-detail-link');
  }

  return target === container || target.classList.contains('library-video-grid');
}

export default function VideoLibraryPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<DouyinLibraryStatus | null>(null);
  const [collectionJob, setCollectionJob] = useState<DouyinCollectionJob | null>(null);
  const [storedSourceMode, setSourceMode] = useLocalStorage<DouyinSourceMode | string>(
    'zhicui-library-source-mode-v1',
    'collect',
  );
  const sourceMode: DouyinSourceMode = isDouyinSourceMode(storedSourceMode)
    ? storedSourceMode
    : 'collect';
  const [storedLayoutMode, setLayoutMode] = useLocalStorage<LibraryLayoutMode | string>(
    'zhicui-library-layout-mode-v1',
    'grid',
  );
  const layoutMode: LibraryLayoutMode = isLibraryLayoutMode(storedLayoutMode)
    ? storedLayoutMode
    : 'grid';
  const [sourceManagerModes, setSourceManagerModes] = useState<DouyinSourceMode[]>(
    () => readLibraryQuickSyncPreferences().modes,
  );
  const [sourceReadability, setSourceReadability] = useState<Partial<
    Record<DouyinSourceMode, SourceReadabilityState>
  >>({});
  const [sourceSorts, setSourceSorts] = useLocalStorage(
    'zhicui-library-source-sorts-v1',
    DEFAULT_SOURCE_SORTS,
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [syncCount, setSyncCount] = useState(() => readLibraryQuickSyncPreferences().count);
  const [items, setItems] = useState<DouyinLibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPlatform, setSelectedPlatform] = useState<Set<string>>(new Set());
  const [extractProgress, setExtractProgress] = useState<Record<string, ExtractProgress>>({});
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState<LibraryPlatformFilter>('all');
  const [platformItems, setPlatformItems] = useState<PlatformLibraryItem[]>([]);
  const [previewTarget, setPreviewTarget] = useState<LibraryPreviewTarget | null>(null);
  const [initializingPlatformId, setInitializingPlatformId] = useState<string | null>(null);
  const [platformActionErrors, setPlatformActionErrors] = useState<Record<string, string>>({});
  const [platformLibraryState, setPlatformLibraryState] = useState<PlatformLibraryPanelState>({
    loading: true,
    error: '',
  });

  useEffect(() => {
    const syncPlatformFromLocation = () => {
      const platform = new URL(window.location.href).searchParams.get('platform');
      const nextFilter: LibraryPlatformFilter = platform === 'douyin' || platform === 'bilibili'
        ? platform
        : 'all';
      setPlatformFilter(nextFilter);
      setPlatformActionErrors({});
      setPreviewTarget(null);
    };

    syncPlatformFromLocation();
    window.addEventListener('popstate', syncPlatformFromLocation);
    return () => window.removeEventListener('popstate', syncPlatformFromLocation);
  }, [user?.id]);

  const [platformPanelVersion, setPlatformPanelVersion] = useState(0);
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [sourceManagerView, setSourceManagerView] = useState<SourceManagerView>('douyin');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [, setLoginQr] = useState('');
  const [qrPanelOpen, setQrPanelOpen] = useState(false);
  const [qrActionMessage, setQrActionMessage] = useState('');
  const [, setLoginStatusMessage] = useState('');
  const [, setBrowserOpened] = useState(false);
  const [, setBrowserMode] = useState('idle');
  const [, setQrFallbackVisible] = useState(false);
  const [, setQrFallbackMode] = useState('remote_capture');
  const [bindingClient, setBindingClient] = useState<BindingClient>('desktop-web');
  const [desktopLocalDouyin, setDesktopLocalDouyin] = useState(false);
  const [desktopVersion, setDesktopVersion] = useState('');
  const [desktopDouyinConnected, setDesktopDouyinConnected] = useState(false);
  const [desktopDouyinStage, setDesktopDouyinStage] = useState('idle');
  const [desktopUpdateInstalling, setDesktopUpdateInstalling] = useState(false);
  const persistDesktopDouyinConnection = useCallback((connectedValue: boolean) => {
    setDesktopDouyinConnected(connectedValue);
    if (!user?.id || typeof window === 'undefined') return;
    try {
      const key = `zhicui-platform-account-connections:${user.id}`;
      const stored = JSON.parse(window.localStorage.getItem(key) || '{}') as Record<string, boolean>;
      window.localStorage.setItem(key, JSON.stringify({ ...stored, douyin: connectedValue }));
    } catch {
      // 浏览器禁用本地存储时只保留本次会话状态。
    }
  }, [user?.id]);
  const [bindingCheckPending, setBindingCheckPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [batchExtracting, setBatchExtracting] = useState(false);
  const [activeBatchOperation, setActiveBatchOperation] = useState<DouyinBatchExtractionOperation | null>(null);
  const [extractionJob, setExtractionJob] = useState<DouyinBatchExtractionJob | null>(null);
  const [sessionAction, setSessionAction] = useState<DouyinSessionAction | null>(null);
  const [sessionPending, setSessionPending] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [removalTarget, setRemovalTarget] = useState<LibraryRemovalTarget | null>(null);
  const [removalPending, setRemovalPending] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [deletionTarget, setDeletionTarget] = useState<DouyinLibraryItem | null>(null);
  const [deletionError, setDeletionError] = useState('');
  const [libraryOverview, setLibraryOverview] = useState({
    sourceTotal: 0,
    temporaryHidden: 0,
    permanentHidden: 0,
  });
  const [permanentHiddenItems, setPermanentHiddenItems] = useState<DouyinPermanentHiddenItem[]>([]);
  const [hiddenManagerLoading, setHiddenManagerLoading] = useState(false);
  const [hiddenManagerError, setHiddenManagerError] = useState('');
  const [restorePending, setRestorePending] = useState(false);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [pipelineStage, setPipelineStage] = useState<'idle' | 'collect' | 'extract' | 'done'>('idle');
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState('');
  const [sourceManagerNotice, setSourceManagerNotice] = useState('');
  const [autoSyncing, setAutoSyncing] = useState(false);
  const activeRef = useRef(true);
  const batchExtractingRef = useRef(false);
  const extractionRevisionRef = useRef('');
  const sourceModeRef = useRef<DouyinSourceMode>(sourceMode);
  sourceModeRef.current = sourceMode;
  const libraryRequestRef = useRef(0);
  const loginPollRef = useRef(0);
  const sessionDialogRef = useRef<HTMLDialogElement | null>(null);
  const removalDialogRef = useRef<HTMLDialogElement | null>(null);
  const deletionDialogRef = useRef<HTMLDialogElement | null>(null);
  const hiddenManagerDialogRef = useRef<HTMLDialogElement | null>(null);
  const sourceManagerDialogRef = useRef<HTMLDialogElement | null>(null);
  const sourceManagerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceManagerTabsRef = useRef<HTMLDivElement | null>(null);
  const sourceManagerRailRef = useRef<HTMLDivElement | null>(null);
  const librarySelectionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const sourceManagerRestoreFocusRef = useRef(true);
  const quickSyncCheckedRef = useRef(false);
  const [quickSyncRequested, setQuickSyncRequested] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeSort: DouyinLibrarySort = sourceMode === 'post'
    ? 'published'
    : sourceSorts[sourceMode] === 'published'
      ? 'published'
      : 'collection';
  const sourceOrderLabel = sourceMode === 'like' ? '最近喜欢' : '最近收藏';

  const loadItems = useCallback(async (
    silent = false,
    sortOverride?: DouyinLibrarySort,
    refreshOrder = false,
  ): Promise<DouyinLibraryListResult | null> => {
    const requestedMode = sourceMode;
    const requestId = libraryRequestRef.current + 1;
    libraryRequestRef.current = requestId;
    if (!silent) setLoading(true);
    const response = await listDouyinLibraryItems(
      ALL_LIBRARY_ITEMS,
      sourceMode,
      sortOverride ?? activeSort,
      refreshOrder,
    );
    const isCurrentRequest = (
      requestId === libraryRequestRef.current
      && requestedMode === sourceModeRef.current
    );
    if (response.success && response.data) {
      if (!isCurrentRequest) return response.data;
      setItems(response.data.items);
      setLibraryOverview({
        sourceTotal: response.data.source_total,
        temporaryHidden: response.data.hidden.temporary,
        permanentHidden: response.data.permanent_hidden_total,
      });
      setError('');
      if (!silent) setLoading(false);
      return response.data;
    }
    if (!silent && isCurrentRequest) {
      setError(response.error || '无法读取视频来源');
      setLoading(false);
    }
    return null;
  }, [activeSort, sourceMode]);

  const selectSourceSort = (nextSort: DouyinLibrarySort) => {
    if (refreshing || batchExtracting) return;
    setSortMenuOpen(false);
    setSourceSorts((current) => ({
      ...current,
      [sourceMode]: nextSort,
    }));
    setSelected(new Set());
    setNotice(nextSort === 'collection'
      ? `已按上次同步的${sourceOrderLabel}顺序展示`
      : '已按视频发布时间从新到旧展示');
  };

  const loadLibrary = useCallback(async () => {
    const requestedMode = sourceMode;
    const requestId = libraryRequestRef.current + 1;
    libraryRequestRef.current = requestId;
    setLoading(true);
    const [statusResponse, itemsResponse] = await Promise.all([
      getDouyinLibraryStatus(),
      listDouyinLibraryItems(ALL_LIBRARY_ITEMS, sourceMode, activeSort),
    ]);
    if (
      requestId !== libraryRequestRef.current
      || requestedMode !== sourceModeRef.current
    ) {
      return;
    }
    if (statusResponse.success && statusResponse.data) {
      setStatus(statusResponse.data);
      setStatusError('');
    } else {
      setStatusError(statusResponse.error || '无法检测抖音连接状态');
    }
    if (itemsResponse.success && itemsResponse.data) {
      setItems(itemsResponse.data.items);
      setLibraryOverview({
        sourceTotal: itemsResponse.data.source_total,
        temporaryHidden: itemsResponse.data.hidden.temporary,
        permanentHidden: itemsResponse.data.permanent_hidden_total,
      });
      setError('');
    } else {
      setError(itemsResponse.error || '无法读取视频来源');
    }
    setLoading(false);
  }, [activeSort, sourceMode]);

  useEffect(() => {
    if (!isDouyinSourceMode(storedSourceMode)) {
      setSourceMode('collect');
    }
  }, [setSourceMode, storedSourceMode]);

  useEffect(() => {
    if (!isLibraryLayoutMode(storedLayoutMode)) {
      setLayoutMode('grid');
    }
  }, [setLayoutMode, storedLayoutMode]);

  useEffect(() => {
    setSelected(new Set());
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSortMenuOpen(false);
        sortTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sortMenuOpen]);

  useEffect(() => {
    let active = true;
    void detectDesktopRuntime().then((runtime) => {
      if (!active) return;
      if (runtime) {
        setBindingClient('desktop-app');
        const supportsLocal = supportsLocalDouyinRuntime(runtime.version);
        setDesktopVersion(runtime.version);
        setDesktopLocalDouyin(supportsLocal);
        if (supportsLocal && user?.id) {
          try {
            const stored = JSON.parse(
              window.localStorage.getItem(`zhicui-platform-account-connections:${user.id}`) || '{}',
            ) as { douyin?: boolean };
            setDesktopDouyinConnected(Boolean(stored.douyin));
          } catch {
            setDesktopDouyinConnected(false);
          }
        }
        return;
      }
      if (isNativeAndroidApp()) {
        setBindingClient('android-app');
        return;
      }
      const mobileBrowser = (
        window.matchMedia('(max-width: 767px)').matches
        || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      );
      setBindingClient(mobileBrowser ? 'mobile-web' : 'desktop-web');
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (bindingClient !== 'desktop-app' || !window.zhicuiDesktop) return undefined;
    return window.zhicuiDesktop.onDouyinLoginStatus((nextStatus) => {
      setLoginStatusMessage(nextStatus.message);
      setNotice(nextStatus.message);
      if (nextStatus.stage === 'success') {
        setScanning(false);
        setBrowserMode('idle');
      }
      if (nextStatus.stage === 'error' || nextStatus.stage === 'cancelled') {
        setScanning(false);
        setBrowserMode('idle');
      }
    });
  }, [bindingClient]);

  useEffect(() => {
    if (!desktopLocalDouyin || !window.zhicuiDesktop) return undefined;
    return window.zhicuiDesktop.onPlatformAccountStatus((nextStatus) => {
      if (nextStatus.platform !== 'douyin') return;
      setDesktopDouyinStage(nextStatus.stage);
      setNotice(nextStatus.message);
      setSourceManagerNotice(nextStatus.message);
      if (nextStatus.stage === 'success') persistDesktopDouyinConnection(true);
      if (nextStatus.stage === 'disconnected') persistDesktopDouyinConnection(false);
    });
  }, [desktopLocalDouyin, persistDesktopDouyinConnection]);

  useEffect(() => {
    if (!qrPanelOpen || typeof window === 'undefined') return undefined;
    if (!window.matchMedia('(max-width: 767px)').matches) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [qrPanelOpen]);

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => (
      item.title.toLowerCase().includes(keyword)
      || item.caption.toLowerCase().includes(keyword)
      || item.author_name.toLowerCase().includes(keyword)
      || item.tags.some((tag) => tag.toLowerCase().includes(keyword))
    ));
  }, [items, search]);

  const filteredPlatformItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return platformItems.filter((item) => {
      if (platformFilter === 'douyin') return false;
      if (platformFilter !== 'all' && item.platform !== platformFilter) return false;
      if (!keyword) return true;
      return (
        item.title.toLowerCase().includes(keyword)
        || item.caption.toLowerCase().includes(keyword)
        || item.author_name.toLowerCase().includes(keyword)
        || item.tags.some((tag) => tag.toLowerCase().includes(keyword))
      );
    });
  }, [platformFilter, platformItems, search]);

  const platformCounts = useMemo(() => ({
    all: items.length + platformItems.length,
    douyin: items.length,
    bilibili: platformItems.filter((item) => item.platform === 'bilibili').length,
    xiaohongshu: platformItems.filter((item) => item.platform === 'xiaohongshu').length,
  }), [items.length, platformItems]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.aweme_id)),
    [items, selected],
  );
  const selectedPlatformItems = useMemo(
    () => platformItems.filter((item) => selectedPlatform.has(item.id)),
    [platformItems, selectedPlatform],
  );
  const selectedCount = selectedItems.length + selectedPlatformItems.length;
  const selectedAnalysisNoteIds = useMemo(() => [
    ...selectedItems.flatMap(item => item.extracted_note_id ? [item.extracted_note_id] : []),
    ...selectedPlatformItems.flatMap(item => item.media_type === 'video' ? [item.id] : []),
  ], [selectedItems, selectedPlatformItems]);
  const selectedAnalysisUnsupported = selectedCount - selectedAnalysisNoteIds.length;

  const previewSelection = useMemo<LibraryPreviewSelection | null>(() => {
    if (previewTarget?.platform === 'douyin') {
      const target = filteredItems.find((item) => item.aweme_id === previewTarget.id);
      if (target && (platformFilter === 'all' || platformFilter === 'douyin')) {
        return { kind: 'douyin', item: target };
      }
    } else if (previewTarget) {
      const target = filteredPlatformItems.find((item) => item.id === previewTarget.id);
      if (target) return { kind: 'platform', item: target };
    }

    const selectedItem = selectedItems.find((item) => filteredItems.includes(item));
    if (selectedItem && (platformFilter === 'all' || platformFilter === 'douyin')) {
      return { kind: 'douyin', item: selectedItem };
    }
    if ((platformFilter === 'all' || platformFilter === 'douyin') && filteredItems[0]) {
      return { kind: 'douyin', item: filteredItems[0] };
    }
    if (filteredPlatformItems[0]) {
      return { kind: 'platform', item: filteredPlatformItems[0] };
    }
    return null;
  }, [filteredItems, filteredPlatformItems, platformFilter, previewTarget, selectedItems]);
  const allVisibleSelected = useMemo(() => {
    const visibleDouyinIds = (platformFilter === 'all' || platformFilter === 'douyin')
      ? filteredItems.map(item => item.aweme_id)
      : [];
    const visiblePlatformIds = filteredPlatformItems
      .filter(item => item.media_type === 'video')
      .map(item => item.id);
    const visibleCount = visibleDouyinIds.length + visiblePlatformIds.length;
    return visibleCount > 0
      && visibleDouyinIds.every(id => selected.has(id))
      && visiblePlatformIds.every(id => selectedPlatform.has(id));
  }, [filteredItems, filteredPlatformItems, platformFilter, selected, selectedPlatform]);
  const desktopDouyinUpdateRequired = (
    bindingClient === 'desktop-app'
    && requiresLocalDouyinDesktopUpdate(desktopVersion)
  );
  const connected = desktopLocalDouyin
    || (!desktopDouyinUpdateRequired && Boolean(status?.connected));
  const loggedIn = desktopLocalDouyin
    ? desktopDouyinConnected
    : !desktopDouyinUpdateRequired && Boolean(status?.cookie_valid);
  const loginBrowserMode = status?.login_browser_mode || 'unavailable';
  const localBrowserAvailable = (
    bindingClient === 'desktop-web'
    && loginBrowserMode === 'visible_chrome'
  );
  const sourceLabel = SOURCE_MODES.find((mode) => mode.value === sourceMode)?.label || '视频';
  const sourceManagerLabel = sourceManagerModes.length === SOURCE_MODES.length
    ? '全部内容'
    : sourceManagerModes.length === 0
      ? '视频'
      : sourceManagerModes
        .map((value) => SOURCE_MODES.find((mode) => mode.value === value)?.label || '')
        .filter(Boolean)
        .join(' + ');
  const collectionReadability = sourceReadability.collect;
  const collectionRetryMinutes = collectionReadability
    ? Math.max(0, Math.ceil((collectionReadability.blockedUntil - Date.now()) / 60_000))
    : 0;
  const collectionProgress = getCollectionProgress(collectionJob, syncCount);
  const showDouyinItems = platformFilter === 'all' || platformFilter === 'douyin';
  const showPlatformItems = platformFilter !== 'douyin';
  const visibleItemCount = (showDouyinItems ? filteredItems.length : 0)
    + filteredPlatformItems.length;
  const visibleSelectableCount = (showDouyinItems ? filteredItems.length : 0)
    + filteredPlatformItems.filter(item => item.media_type === 'video').length;
  const visibleListLoading = visibleItemCount === 0 && (
    (showDouyinItems && loading)
    || (showPlatformItems && platformLibraryState.loading)
  );
  const visibleListError = platformFilter === 'douyin'
    ? error
    : platformFilter === 'bilibili' || platformFilter === 'xiaohongshu'
      ? platformLibraryState.error
      : [error, platformLibraryState.error].filter(Boolean).join('；');

  const libraryMarquee = useMarqueeSelection({
    containerRef: librarySelectionSurfaceRef,
    selectedIds: selected,
    maxSelection: Math.max(1, MAX_SELECTION - selectedPlatform.size),
    disabled: batchExtracting
      || selectedPlatform.size >= MAX_SELECTION
      || !showDouyinItems
      || filteredItems.length === 0,
    isDisabled: () => batchExtractingRef.current,
    shouldStart: canStartLibraryMarquee,
    onSelectionChange: (nextSelection) => {
      setSelected(nextSelection);
      setNotice((current) => (
        current === `一次最多选择 ${MAX_SELECTION} 条视频` ? '' : current
      ));
    },
    onCommit: ({ selectedIds: nextSelection, hitIds }) => {
      const nextPreviewId = hitIds.find((id) => nextSelection.has(id));
      if (nextPreviewId) {
        setPreviewTarget({ platform: 'douyin', id: nextPreviewId });
      }
    },
    onLimitReached: () => {
      setNotice(`一次最多选择 ${MAX_SELECTION} 条视频`);
    },
  });
  const displayedSelection = libraryMarquee.previewSelectedIds ?? selected;

  const switchPlatformFilter = (nextFilter: LibraryPlatformFilter) => {
    if (batchExtractingRef.current) return;
    setPlatformFilter(nextFilter);
    setPlatformActionErrors({});
    setPreviewTarget(null);
    const currentUrl = new URL(window.location.href);
    if (nextFilter === 'all') currentUrl.searchParams.delete('platform');
    else currentUrl.searchParams.set('platform', nextFilter);
    window.history.pushState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  };

  const initializePlatformSummary = async (item: PlatformLibraryItem) => {
    if (initializingPlatformId) return;
    setInitializingPlatformId(item.id);
    setPlatformActionErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    const response = await initializePlatformLibraryItem(item.id);
    setInitializingPlatformId(null);
    if (!response.success || !response.data) {
      setPlatformActionErrors((current) => ({
        ...current,
        [item.id]: response.error || '摘要生成失败，请稍后重试',
      }));
      return;
    }
    setPlatformItems((current) => current.map((candidate) => (
      candidate.id === item.id
        ? { ...candidate, note: response.data!.note, ai_initialized: true }
        : candidate
    )));
    setNotice(`《${item.title}》的摘要已生成`);
  };

  const toggleSelection = (awemeId: string) => {
    if (batchExtractingRef.current) return;
    setNotice('');
    setPreviewTarget({ platform: 'douyin', id: awemeId });
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(awemeId)) {
        next.delete(awemeId);
        return next;
      }
      if (next.size + selectedPlatform.size >= MAX_SELECTION) {
        setNotice(`知萃 AI 一次最多使用 ${MAX_SELECTION} 条视频`);
        return current;
      }
      next.add(awemeId);
      return next;
    });
  };

  const togglePlatformSelection = (item: PlatformLibraryItem) => {
    if (batchExtractingRef.current || item.media_type !== 'video') return;
    setNotice('');
    setPreviewTarget({ platform: item.platform, id: item.id });
    setSelectedPlatform((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
        return next;
      }
      if (next.size + selected.size >= MAX_SELECTION) {
        setNotice(`一次最多选择 ${MAX_SELECTION} 条视频`);
        return current;
      }
      next.add(item.id);
      return next;
    });
  };

  const selectVisible = () => {
    if (batchExtractingRef.current) return;
    const visibleDouyinIds = (platformFilter === 'all' || platformFilter === 'douyin')
      ? filteredItems.map(item => item.aweme_id)
      : [];
    const visiblePlatformIds = filteredPlatformItems
      .filter(item => item.media_type === 'video')
      .map(item => item.id);
    if (allVisibleSelected) {
      setSelected(current => {
        const next = new Set(current);
        visibleDouyinIds.forEach(id => next.delete(id));
        return next;
      });
      setSelectedPlatform(current => {
        const next = new Set(current);
        visiblePlatformIds.forEach(id => next.delete(id));
        return next;
      });
      return;
    }
    const combined = [
      ...visibleDouyinIds.map(id => ({ kind: 'douyin' as const, id })),
      ...visiblePlatformIds.map(id => ({ kind: 'platform' as const, id })),
    ].slice(0, MAX_SELECTION);
    setSelected(new Set(combined.filter(item => item.kind === 'douyin').map(item => item.id)));
    setSelectedPlatform(new Set(combined.filter(item => item.kind === 'platform').map(item => item.id)));
  };

  const applyExtractionJob = (job: DouyinBatchExtractionJob): boolean => {
    const revision = [
      job.job_id,
      job.status,
      job.success,
      job.failed,
      job.active,
      job.queued,
      ...job.items.map((item) => `${item.aweme_id}:${item.state}:${item.updated_at}`),
    ].join('|');
    if (revision === extractionRevisionRef.current) return false;
    extractionRevisionRef.current = revision;
    setExtractionJob(job);
    setExtractProgress((current) => {
      const next = { ...current };
      job.items.forEach((item) => {
        next[item.aweme_id] = {
          state: item.state,
          error: item.error || undefined,
        };
      });
      return next;
    });
    const completed = new Map(
      job.items
        .filter((item) => item.state === 'done')
        .map((item) => [item.aweme_id, item]),
    );
    if (completed.size > 0) {
      setItems((current) => current.map((item) => {
        const result = completed.get(item.aweme_id);
        return result
          ? {
              ...item,
              extracted: true,
              extracted_note_id: result.note_id || null,
            transcript_chars: result.transcript_chars,
            ai_initialized: result.ai_initialized,
            card_type: result.card_type || item.card_type,
            }
          : item;
      }));
    }
    return true;
  };

  const waitForExtractionJob = async (
    initial: DouyinBatchExtractionJob,
    background = false,
  ): Promise<DouyinBatchExtractionJob> => {
    let current = initial;
    let consecutiveFailures = 0;
    applyExtractionJob(current);
    const updateProgressNotice = () => {
      setNotice(
        current.operation === 'transcript'
          ? background
            ? `视频已全部同步；后台文案已完成 ${current.success}/${current.total} 条，正在处理 ${current.active} 条`
            : `并发提取 ${current.total} 条完整文案：正在转写 ${current.active} 条，等待 ${current.queued} 条，已完成 ${current.success} 条`
          : current.operation === 'full'
            ? `结构化文案 ${current.total} 条：正在整理 ${current.active} 条，等待 ${current.queued} 条，已完成 ${current.success} 条`
            : `智能分析 ${current.total} 条：处理中 ${current.active} 条，等待 ${current.queued} 条，已完成 ${current.success} 条`,
      );
    };
    updateProgressNotice();
    for (let attempt = 0; attempt < 2400 && activeRef.current; attempt += 1) {
      if (current.status !== 'running') return current;
      await wait(800);
      const controller = new AbortController();
      const timeoutId = window.setTimeout(
        () => controller.abort(),
        JOB_POLL_TIMEOUT_MS,
      );
      const response = await getDouyinBatchExtraction(current.job_id, controller.signal);
      window.clearTimeout(timeoutId);
      if (!response.success || !response.data) {
        consecutiveFailures += 1;
        if (
          response.status === 401
          || response.status === 404
          || consecutiveFailures >= 3
        ) {
          return {
            ...current,
            status: 'failed',
            error: response.status === 404
              ? '文案任务状态已中断，可能是开发服务刚刚重启；已完成的视频会保留，可以稍后补提'
              : response.error || '文案任务进度连接中断，可以稍后补提',
          };
        }
        continue;
      }
      consecutiveFailures = 0;
      current = response.data;
      if (applyExtractionJob(current)) updateProgressNotice();
      if (current.status !== 'running') return current;
    }
    return current;
  };

  const extractItems = async (
    targets: DouyinLibraryItem[],
    operation: DouyinBatchExtractionOperation,
    options: { background?: boolean } = {},
  ): Promise<ExtractionRunResult> => {
    if (batchExtractingRef.current) {
      return { success: 0, status: 'skipped', error: '已有文案任务正在处理' };
    }
    const background = options.background === true;
    const pending = targets.filter((item) => {
      if (!item.can_extract) return false;
      if (operation === 'transcript') return !hasReadyTranscript(item);
      if (operation === 'ai') return hasReadyTranscript(item) && !item.ai_initialized;
      return !hasReadyTranscript(item) || !item.ai_initialized;
    });
    if (pending.length === 0) return { success: 0, status: 'success' };
    batchExtractingRef.current = true;
    setBatchExtracting(true);
    setActiveBatchOperation(operation);
    extractionRevisionRef.current = '';
    setExtractionJob(null);
    if (!background) setPipelineStage('extract');
    setExtractProgress((current) => {
      const next = { ...current };
      pending.forEach((item) => {
        next[item.aweme_id] = { state: 'queued' };
      });
      return next;
    });

    setNotice(
      operation === 'transcript'
        ? background
          ? `视频已全部同步；正在后台启动 ${pending.length} 条完整文案提取`
          : `正在同时启动 ${pending.length} 条视频的完整文案提取`
        : operation === 'full'
          ? `正在同时提取 ${pending.length} 条视频的结构化文案`
          : `正在同时整理 ${pending.length} 条视频的摘要笔记`,
    );
    const response = await startDouyinBatchExtraction(
      pending.map((item) => item.aweme_id),
      operation,
    );
    if (!response.success || !response.data) {
      setExtractProgress((current) => {
        const next = { ...current };
        pending.forEach((item) => {
          next[item.aweme_id] = {
            state: 'error',
            error: response.error || '批量任务启动失败',
          };
        });
        return next;
      });
      batchExtractingRef.current = false;
      setBatchExtracting(false);
      setActiveBatchOperation(null);
      setNotice(background
        ? `视频已全部同步；${response.error || '后台文案任务启动失败，可以稍后批量补提'}`
        : response.error || (
          operation === 'transcript'
            ? '批量文案任务启动失败'
            : operation === 'full'
              ? '结构化文案任务启动失败'
              : '批量分析任务启动失败'
        ));
      return {
        success: 0,
        status: 'failed',
        error: response.error || '批量任务启动失败',
      };
    }

    const finalJob = await waitForExtractionJob(response.data, background);
    batchExtractingRef.current = false;
    setBatchExtracting(false);
    setActiveBatchOperation(null);
    if (finalJob.status === 'running') {
      setNotice(background
        ? '视频已全部同步；文案任务仍在后台运行，稍后回来即可查看'
        : '批量任务仍在后台运行，刷新页面后可查看已完成的文案');
    } else if (finalJob.status === 'failed') {
      const interruptedMessage = finalJob.error || '文案任务已中断，可以稍后补提';
      setExtractProgress((current) => {
        const next = { ...current };
        finalJob.items.forEach((item) => {
          if (item.state === 'done') return;
          next[item.aweme_id] = { state: 'error', error: interruptedMessage };
        });
        return next;
      });
      setNotice(background
        ? `视频已经同步；${interruptedMessage}`
        : interruptedMessage);
    }
    return {
      success: finalJob.success,
      status: finalJob.status,
      error: finalJob.error,
      job: finalJob,
    };
  };

  const extractStructuredSelected = async () => {
    if (selectedItems.length === 0 || batchExtractingRef.current) return;
    const snapshot = [...selectedItems];
    const pending = snapshot.filter(
      (item) => !item.ai_initialized || !hasReadyTranscript(item),
    );
    const ineligible = pending.filter((item) => !item.can_extract);
    if (ineligible.length > 0) {
      setNotice(`选中的 ${ineligible.length} 条视频当前没有可提取文件，未启动任务；请取消这些视频后重试`);
      return;
    }
    if (pending.length === 0) {
      setNotice(`已选 ${snapshot.length} 条视频的结构化文案都已就绪`);
      return;
    }

    const result = await extractItems(snapshot, 'full');
    if (result.status === 'success') {
      setPipelineStage('done');
      setNotice(`已选 ${snapshot.length} 条视频的结构化文案已就绪`);
      return;
    }
    if (result.status === 'partial') {
      setPipelineStage('done');
      setNotice(`结构化文案完成 ${result.success}/${pending.length} 条；失败项仍保持选中，可以直接重试`);
      return;
    }
    setPipelineStage('idle');
  };

  const openSelectedInAgent = async () => {
    if (selectedCount === 0 || batchExtractingRef.current) return;
    const snapshot = [...selectedItems];
    const platformNoteIds = selectedPlatformItems.map(item => item.id);
    const missingTranscript = snapshot.filter((item) => !hasReadyTranscript(item));
    const ineligible = missingTranscript.filter((item) => !item.can_extract);
    if (ineligible.length > 0) {
      setNotice(`选中的 ${ineligible.length} 条视频当前无法准备文稿，请取消这些视频后重试`);
      return;
    }

    const resolvedNoteIds = new Map<string, string>();
    snapshot.forEach((item) => {
      if (hasReadyTranscript(item) && item.extracted_note_id) {
        resolvedNoteIds.set(item.aweme_id, item.extracted_note_id);
      }
    });

    if (missingTranscript.length > 0) {
      setNotice(`正在为 ${missingTranscript.length} 条视频准备文稿，完成后将自动进入知萃 AI`);
      const result = await extractItems(missingTranscript, 'transcript');
      result.job?.items.forEach((item) => {
        if (item.state === 'done' && item.note_id && item.transcript_chars > 0) {
          resolvedNoteIds.set(item.aweme_id, item.note_id);
        }
      });
    }

    const noteIds = [
      ...snapshot.map((item) => resolvedNoteIds.get(item.aweme_id) || ''),
      ...platformNoteIds,
    ];
    const uniqueNoteIds = new Set(noteIds.filter(Boolean));
    if (
      noteIds.some((noteId) => !noteId)
      || uniqueNoteIds.size !== selectedCount
    ) {
      const failedCount = noteIds.filter((noteId) => !noteId).length;
      setPipelineStage('idle');
      setNotice(`有 ${Math.max(1, failedCount)} 条视频未准备完成，已保留全部选择`);
      return;
    }

    window.location.assign(
      `/harness?source_ids=${encodeURIComponent(noteIds.join(','))}`,
    );
  };

  const openLibraryInAgent = () => {
    if (selectedCount > 0) {
      void openSelectedInAgent();
      return;
    }
    window.location.assign('/harness?new=1&source_scope=all_ready');
  };

  const refreshLoginStatus = useCallback(async (): Promise<DouyinLibraryStatus | null> => {
    const response = await getDouyinLibraryStatus();
    if (response.success && response.data) {
      setStatus(response.data);
      setStatusError('');
      return response.data;
    }
    setStatusError(response.error || '无法检测抖音连接状态');
    return null;
  }, []);

  const closeQrLogin = useCallback(() => {
    const shouldCancelLogin = (
      bindingClient === 'desktop-web'
      && localBrowserAvailable
      && scanning
    );
    loginPollRef.current += 1;
    setScanning(false);
    setQrPanelOpen(false);
    setLoginQr('');
    setQrActionMessage('');
    setLoginStatusMessage('');
    setBrowserOpened(false);
    setBrowserMode('idle');
    setQrFallbackVisible(false);
    setQrFallbackMode('remote_capture');
    if (!shouldCancelLogin) return;
    void cancelDouyinLogin().then((response) => {
      if (!response.success) {
        setNotice(response.error || '扫码窗口取消失败，请稍后重试');
      }
    });
  }, [bindingClient, localBrowserAvailable, scanning]);

  const launchDesktopApp = () => {
    openInstalledDesktopApp();
    setQrActionMessage('正在打开知萃桌面端；如果没有响应，请先下载安装。');
  };

  const downloadDesktopApp = () => {
    window.location.assign(DESKTOP_DOWNLOAD_URL);
  };

  const checkDesktopBinding = async () => {
    if (bindingCheckPending) return;
    setBindingCheckPending(true);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const latest = await refreshLoginStatus();
      if (latest?.cookie_valid) {
        setBindingCheckPending(false);
        setQrPanelOpen(false);
        setScanning(false);
        setNotice('抖音登录成功，现在可以同步视频');
        return;
      }
      if (attempt < 7) await wait(1200);
    }
    setBindingCheckPending(false);
    setQrActionMessage('暂未收到登录结果，请确认已在手机抖音中点击“确认登录”，然后重试。');
  };

  const pollQrLogin = useCallback(async (
    pollId: number,
    initialQrVersion = 0,
  ) => {
    let currentQrVersion = initialQrVersion;
    let hasQrImage = initialQrVersion > 0;
    let automaticRecoveryUsed = false;
    let lastBrowserMode = 'starting';
    for (
      let attempt = 0;
      attempt < 300 && activeRef.current && loginPollRef.current === pollId;
      attempt += 1
    ) {
      await wait(2000);
      const response = await getDouyinLoginStatus();
      if (!response.success || !response.data) continue;
      const nextMessage = response.data.message || '等待你使用抖音 App 扫码…';
      setNotice(nextMessage);
      setLoginStatusMessage(nextMessage);
      setBrowserOpened(Boolean(response.data.browser_opened));
      lastBrowserMode = response.data.browser_mode || 'idle';
      setBrowserMode(lastBrowserMode);
      if (response.data.cookie_valid) {
        loginPollRef.current += 1;
        setScanning(false);
        setQrPanelOpen(false);
        setLoginQr('');
        setQrActionMessage('');
        setLoginStatusMessage('');
        setBrowserOpened(false);
        setBrowserMode('idle');
        setQrFallbackVisible(false);
        await refreshLoginStatus();
        setNotice('抖音登录成功，现在可以选择来源并开始自动处理');
        return;
      }
      if (
        response.data.qr_ready
        && response.data.qr_version
        && response.data.qr_version !== currentQrVersion
      ) {
        const qrResponse = await getDouyinLoginQr();
        const imageDataUrl = qrResponse.data?.image_data_url || '';
        if (
          qrResponse.success
          && imageDataUrl.startsWith('data:image/png;base64,')
        ) {
          setLoginQr(imageDataUrl);
          currentQrVersion = qrResponse.data?.qr_version || 0;
          hasQrImage = true;
        }
      }
      if (!response.data.running) {
        setScanning(false);
        setQrPanelOpen(false);
        setLoginQr('');
        setLoginStatusMessage('');
        setBrowserOpened(false);
        setBrowserMode('idle');
        const latestStatus = await refreshLoginStatus();
        setNotice(
          response.data.error
            ? `扫码登录失败：${response.data.error}`
            : latestStatus?.cookie_valid
              ? '抖音登录成功，现在可以选择来源并开始自动处理'
              : response.data.message || '扫码登录已结束，可以重新发起',
        );
        return;
      }
      const expectsMirroredQr = (
        bindingClient === 'desktop-web'
        && ['remote_capture', 'headless'].includes(lastBrowserMode)
      );
      if (
        expectsMirroredQr
        && !hasQrImage
        && attempt + 1 >= QR_AUTO_RECOVERY_ATTEMPTS
      ) {
        if (!automaticRecoveryUsed) {
          automaticRecoveryUsed = true;
          setQrActionMessage('二维码生成较慢，正在自动重开一次安全登录浏览器…');
          setLoginStatusMessage('正在自动恢复二维码，请稍候…');
          const cancelled = await cancelDouyinLogin();
          if (loginPollRef.current !== pollId) return;
          await wait(cancelled.data?.browser_mode === 'closing' ? 1600 : 500);

          let restarted = await startDouyinLogin();
          if (
            restarted.success
            && restarted.data?.error === 'browser_cleanup_pending'
          ) {
            await wait(1600);
            restarted = await startDouyinLogin();
          }
          const restartAccepted = Boolean(
            restarted.success
            && restarted.data
            && (
              restarted.data.started === true
              || restarted.data.running === true
            )
          );
          if (restartAccepted) {
            currentQrVersion = restarted.data?.qr_version || 0;
            hasQrImage = Boolean(restarted.data?.qr_ready);
            lastBrowserMode = restarted.data?.browser_mode || 'starting';
            setBrowserOpened(Boolean(restarted.data?.browser_opened));
            setBrowserMode(lastBrowserMode);
            setQrActionMessage('已自动重开登录浏览器，正在获取新的二维码…');
            attempt = -1;
            continue;
          }
          setNotice(restarted.error || restarted.data?.message || '二维码自动恢复失败');
        }

        await cancelDouyinLogin();
        if (loginPollRef.current !== pollId) return;
        setScanning(false);
        setLoginQr('');
        setBrowserOpened(false);
        setQrFallbackMode(lastBrowserMode);
        setQrFallbackVisible(true);
        setLoginStatusMessage('二维码仍未出现，请使用下方按钮重新尝试');
        setQrActionMessage(
          lastBrowserMode === 'visible_chrome'
            ? 'Chrome 未能正常弹出，请点击“重新弹出 Chrome”。'
            : '服务器未能生成二维码，请点击“重新生成二维码”。',
        );
        setNotice('二维码生成超时，已停止等待；你可以立即重新尝试');
        return;
      }
    }
    if (loginPollRef.current !== pollId) return;
    await cancelDouyinLogin();
    if (loginPollRef.current !== pollId) return;
    setScanning(false);
    setQrFallbackMode(lastBrowserMode);
    setQrFallbackVisible(true);
    setLoginStatusMessage('扫码登录等待超时，请使用下方按钮重新尝试');
    setNotice('扫码登录等待超时，可以重新弹出登录窗口');
  }, [bindingClient, refreshLoginStatus]);

  const recoverQrLogin = useCallback(async (confirmCompletion = false) => {
    let loginResponse: Awaited<ReturnType<typeof getDouyinLoginStatus>> | null = null;
    const attempts = confirmCompletion ? 6 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const [nextLoginResponse, statusResponse] = await Promise.all([
        getDouyinLoginStatus(),
        getDouyinLibraryStatus(),
      ]);
      if (!activeRef.current) return;
      loginResponse = nextLoginResponse;

      if (statusResponse.success && statusResponse.data) {
        setStatus(statusResponse.data);
        if (
          statusResponse.data.cookie_valid
          || nextLoginResponse.data?.cookie_valid
        ) {
          loginPollRef.current += 1;
          setScanning(false);
          setQrPanelOpen(false);
          setLoginQr('');
          setQrActionMessage('');
          setLoginStatusMessage('');
          setBrowserOpened(false);
          setBrowserMode('idle');
          setQrFallbackVisible(false);
          setQrFallbackMode('remote_capture');
          if (confirmCompletion) {
            setNotice('已确认抖音登录成功，现在可以同步视频');
          }
          return;
        }
        if (
          nextLoginResponse.data?.running
          && statusResponse.data.login_browser_mode !== 'visible_chrome'
        ) {
          loginPollRef.current += 1;
          await cancelDouyinLogin();
          setScanning(false);
          setQrPanelOpen(false);
          setLoginQr('');
          setBrowserOpened(false);
          setBrowserMode('idle');
          setNotice('旧的登录任务已停止，请重新扫码登录抖音');
          return;
        }
      }
      if (nextLoginResponse.success && nextLoginResponse.data?.running) break;
      if (attempt + 1 < attempts) {
        setNotice('抖音已确认，正在同步登录状态…');
        await wait(1200);
      }
    }

    if (!loginResponse?.success || !loginResponse.data?.running) {
      if (confirmCompletion) {
        setNotice(
          loginResponse?.data?.error
            ? `抖音绑定未完成：${loginResponse.data.error}`
            : '尚未检测到真实登录会话，请确认在抖音中点击了“确认登录”，然后重新扫码',
        );
      }
      return;
    }

    const pollId = loginPollRef.current + 1;
    loginPollRef.current = pollId;
    setScanning(true);
    setQrPanelOpen(true);
    setQrFallbackVisible(false);
    const recoveredMessage = loginResponse.data.message || '等待你使用抖音 App 扫码…';
    setNotice(recoveredMessage);
    setLoginStatusMessage(recoveredMessage);
    setBrowserOpened(Boolean(loginResponse.data.browser_opened));
    setBrowserMode(loginResponse.data.browser_mode || 'idle');

    let qrVersion = loginResponse.data.qr_version || 0;
    if (loginResponse.data.qr_ready) {
      const qrResponse = await getDouyinLoginQr();
      const imageDataUrl = qrResponse.data?.image_data_url || '';
      if (
        qrResponse.success
        && imageDataUrl.startsWith('data:image/png;base64,')
      ) {
        setLoginQr(imageDataUrl);
        qrVersion = qrResponse.data?.qr_version || qrVersion;
      }
    }
    void pollQrLogin(pollId, qrVersion);
  }, [pollQrLogin]);

  useEffect(() => {
    void recoverQrLogin();
  }, [recoverQrLogin]);

  useEffect(() => {
    if (bindingClient !== 'android-app') return undefined;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;

    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && !disposed) void recoverQrLogin(true);
    }).then((handle) => {
      if (disposed) {
        void handle.remove();
        return;
      }
      listener = handle;
    });

    return () => {
      disposed = true;
      if (listener) void listener.remove();
    };
  }, [bindingClient, recoverQrLogin]);

  const beginDesktopQrLogin = async () => {
    if (!localBrowserAvailable) {
      setScanning(false);
      setQrPanelOpen(true);
      setLoginQr('');
      setQrActionMessage(
        '登录窗口暂时无法打开，请稍后重试。',
      );
      setBrowserOpened(false);
      setBrowserMode(loginBrowserMode);
      setQrFallbackVisible(false);
      setLoginStatusMessage('异地服务器二维码已停用');
      setNotice('登录窗口暂时无法打开，请稍后重试');
      return;
    }
    const pollId = loginPollRef.current + 1;
    loginPollRef.current = pollId;
    setScanning(true);
    setQrPanelOpen(false);
    setLoginQr('');
    setQrActionMessage('');
    setBrowserOpened(false);
    setBrowserMode('starting');
    setQrFallbackVisible(false);
    setQrFallbackMode('remote_capture');
    setLoginStatusMessage('正在弹出 Chrome 抖音登录窗口…');
    setNotice('正在弹出 Chrome，请稍候…');
    let start = await startDouyinLogin();
    if (
      start.success
      && start.data?.error === 'browser_cleanup_pending'
    ) {
      setLoginStatusMessage('上一次登录窗口正在关闭，马上重试…');
      await wait(1600);
      start = await startDouyinLogin();
    }
    if (!start.success) {
      setScanning(false);
      setQrFallbackVisible(true);
      setQrFallbackMode('starting');
      setLoginStatusMessage('登录浏览器启动失败，请使用下方按钮重试');
      setBrowserOpened(false);
      setBrowserMode('idle');
      setNotice(start.error || '扫码登录启动失败');
      return;
    }
    const accepted = Boolean(
      start.data
      && (
        start.data.started === true
        || start.data.running === true
      )
    );
    if (!accepted) {
      setScanning(false);
      setQrFallbackVisible(true);
      setQrFallbackMode(start.data?.browser_mode || 'starting');
      setLoginStatusMessage(
        start.data?.message || '登录窗口仍在清理，请使用下方按钮重试',
      );
      setQrActionMessage('上一次浏览器尚未完全退出，稍等片刻后重新尝试即可。');
      return;
    }
    setBrowserOpened(Boolean(start.data?.browser_opened));
    setBrowserMode(start.data?.browser_mode || 'starting');
    await pollQrLogin(pollId);
  };

  const beginDesktopAppHandoff = async () => {
    const desktop = window.zhicuiDesktop;
    if (!desktop) {
      setScanning(false);
      setNotice('未检测到知萃桌面端，请重新打开应用后再试');
      return;
    }
    if (desktopLocalDouyin && user?.id) {
      setScanning(true);
      setQrPanelOpen(false);
      setLoginStatusMessage('正在打开抖音官方登录页面…');
      setNotice('请在抖音官方页面完成扫码登录');
      const result = await desktop.loginPlatformAccount({
        platform: 'douyin',
        profileKey: user.id,
      });
      setScanning(false);
      if (!result.success) {
        setDesktopDouyinStage(result.cancelled ? 'cancelled' : 'error');
        setNotice(result.cancelled ? '已取消抖音登录' : result.error || '抖音登录失败');
        return;
      }
      persistDesktopDouyinConnection(true);
      setDesktopDouyinStage('success');
      setNotice('抖音本机登录已保存；仅在你点击同步时读取');
      return;
    }
    setScanning(true);
    setQrPanelOpen(false);
    setLoginQr('');
    setQrActionMessage('');
    setBrowserOpened(false);
    setBrowserMode('desktop_app');
    setQrFallbackVisible(false);
    setLoginStatusMessage('正在准备本机 Chrome…');
    setNotice('正在准备本机 Chrome，请稍候…');

    const handoff = await createDouyinLocalHandoff();
    if (!handoff.success || !handoff.data) {
      setScanning(false);
      setLoginStatusMessage('登录授权创建失败');
      setQrActionMessage('');
      setNotice(handoff.error || '登录授权创建失败，请重试');
      return;
    }

    const apiOrigin = new URL(
      API_BASE || window.location.origin,
      window.location.origin,
    ).origin;
    const callbackUrl = new URL(
      '/api/library/douyin/local-handoff/complete',
      apiOrigin,
    ).toString();
    const result = await desktop.loginDouyin({
      token: handoff.data.token,
      callbackUrl,
    });
    setScanning(false);
    setBrowserMode('idle');
    if (!result.success) {
      setLoginStatusMessage(result.cancelled ? '登录已取消' : '抖音登录失败');
      setNotice(
        result.cancelled
          ? '已取消抖音登录'
          : result.error || '抖音登录失败，请重试',
      );
      return;
    }
    let latest = await refreshLoginStatus();
    if (!latest?.cookie_valid) {
      setNotice('抖音已确认，正在刷新绑定状态…');
      await wait(1200);
      latest = await refreshLoginStatus();
    }
    if (!latest?.cookie_valid) {
      setLoginStatusMessage('抖音会话尚未生效');
      setNotice('扫码已确认，但抖音会话尚未生效；请重新检测，仍未连接时再扫码一次');
      return;
    }
    setLoginStatusMessage('');
    setNotice('抖音登录成功，现在可以同步视频');
    await loadItems(true);
  };

  const startQrLogin = async () => {
    if (!connected || scanning) return;
    if (bindingClient === 'desktop-app') {
      await beginDesktopAppHandoff();
      return;
    }
    loginPollRef.current += 1;
    setScanning(false);
    setQrPanelOpen(true);
    setLoginQr('');
    setQrActionMessage('');
    setBrowserOpened(false);
    setBrowserMode('idle');
    setQrFallbackVisible(false);
    setQrActionMessage('');
    if (bindingClient === 'desktop-web') {
      setLoginStatusMessage('请使用知萃 Windows 桌面端登录抖音');
      setNotice('已安装桌面端可以直接打开；未安装请先下载');
    } else {
      setLoginStatusMessage('请在 Windows 桌面端扫码登录抖音');
      setNotice('在电脑安装知萃桌面端并登录同一个知萃账号，即可完成绑定');
    }
  };

  const refreshDouyinCover = useCallback(async (item: DouyinLibraryItem) => {
    const response = await getDouyinLibraryItem(item.aweme_id);
    if (!response.success || !response.data) {
      return [item.cover_proxy_url, item.cover_url];
    }
    const refreshed = response.data.item;
    setItems((current) => current.map((candidate) => (
      candidate.aweme_id === item.aweme_id
        ? { ...candidate, ...refreshed }
        : candidate
    )));
    return [
      refreshed.cover_proxy_url,
      refreshed.cover_url,
      item.cover_proxy_url,
      item.cover_url,
    ];
  }, []);

  const refreshPlatformCover = useCallback(async (item: PlatformLibraryItem) => {
    const response = await getPlatformLibraryItem(item.id);
    if (!response.success || !response.data) return [item.cover_url];
    const refreshed = response.data.item;
    setPlatformItems((current) => current.map((candidate) => (
      candidate.id === item.id
        ? { ...candidate, cover_url: refreshed.cover_url }
        : candidate
    )));
    return [refreshed.cover_url, item.cover_url];
  }, []);

  const refreshPreviewCover = useCallback(async (selection: LibraryPreviewSelection) => (
    selection.kind === 'douyin'
      ? refreshDouyinCover(selection.item)
      : refreshPlatformCover(selection.item)
  ), [refreshDouyinCover, refreshPlatformCover]);

  const installDesktopUpdateForDouyin = async () => {
    const bridge = window.zhicuiDesktop;
    if (!bridge || !desktopDouyinUpdateRequired || desktopUpdateInstalling) return;
    setDesktopUpdateInstalling(true);
    setNotice('正在准备重启并安装桌面更新…');
    let update = await bridge.getUpdateState();
    if (update.status !== 'downloaded') {
      update = await bridge.checkForUpdates();
    }
    if (update.status !== 'downloaded') {
      setDesktopUpdateInstalling(false);
      setNotice(
        update.status === 'error'
          ? update.error || '更新服务暂时不可用，请稍后重试'
          : '更新包仍在下载，完成后请再次点击“重启并安装”',
      );
      return;
    }
    await bridge.installUpdate();
  };

  useEffect(() => {
    if (
      bindingClient !== 'desktop-app'
      || !connected
      || loggedIn
      || scanning
      || typeof window === 'undefined'
    ) {
      return;
    }
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('desktopLogin') !== '1') return;
    currentUrl.searchParams.delete('desktopLogin');
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}`);
    void startQrLogin();
  }, [bindingClient, connected, loggedIn, scanning]);

  const openSessionDialog = (action: DouyinSessionAction) => {
    if (sessionPending) return;
    setSessionAction(action);
    setSessionError('');
    sessionDialogRef.current?.showModal();
  };

  const closeSessionDialog = () => {
    if (sessionPending) return;
    sessionDialogRef.current?.close();
    setSessionAction(null);
    setSessionError('');
  };

  const confirmSessionAction = async () => {
    if (!sessionAction || sessionPending) return;
    const action = sessionAction;
    setSessionPending(true);
    setSessionError('');
    if (desktopLocalDouyin && user?.id && window.zhicuiDesktop) {
      const localResult = await window.zhicuiDesktop.disconnectPlatformAccount({
        platform: 'douyin',
        profileKey: user.id,
      });
      if (!localResult.success) {
        setSessionPending(false);
        setSessionError(localResult.error || '无法安全断开本机抖音登录');
        return;
      }
      persistDesktopDouyinConnection(false);
      setDesktopDouyinStage('disconnected');
      setSessionPending(false);
      sessionDialogRef.current?.close();
      setSessionAction(null);
      setNotice(action === 'rebind'
        ? '原抖音本机登录已断开，请重新连接新账号'
        : '已退出抖音，视频资料仍会保留');
      if (action === 'rebind') await startQrLogin();
      return;
    }
    const response = await disconnectDouyinLibrary(action);
    if (!response.success || !response.data) {
      setSessionPending(false);
      setSessionError(response.error || '无法安全结束当前抖音会话，请稍后重试');
      return;
    }

    closeQrLogin();
    setStatus((current) => (
      current
        ? { ...current, cookie_valid: false, cookie_count: 0 }
        : current
    ));
    setSessionPending(false);
    sessionDialogRef.current?.close();
    setSessionAction(null);
    setNotice(action === 'rebind' ? '原抖音账号已退出，请扫码绑定新账号' : '已退出抖音，视频资料仍会保留');
    await refreshLoginStatus();
    if (action === 'rebind') await startQrLogin();
  };

  const publishSourceManagerNotice = (message: string) => {
    setNotice(message);
    setSourceManagerNotice(message);
  };

  const waitForCollectionJob = async (
    initial: DouyinCollectionJob,
    requestedCount: number,
    requestedSourceLabel: string,
  ): Promise<CollectionJobWaitResult> => {
    let latestJob: DouyinCollectionJob = {
      ...initial,
      target: nonNegativeInteger(initial.target) || requestedCount,
      processed: nonNegativeInteger(initial.processed),
    };
    setCollectionJob(latestJob);
    let consecutiveFailures = 0;
    let lastError = '';
    for (let attempt = 0; attempt < 240 && activeRef.current; attempt += 1) {
      await wait(500);
      const controller = new AbortController();
      const timeoutId = window.setTimeout(
        () => controller.abort(),
        JOB_POLL_TIMEOUT_MS,
      );
      const response = await getDouyinCollectionJob(initial.job_id, controller.signal);
      window.clearTimeout(timeoutId);
      if (!response.success || !response.data) {
        consecutiveFailures += 1;
        lastError = response.error || '无法读取同步进度';
        if (
          response.status === 401
          || response.status === 404
          || consecutiveFailures >= 3
        ) {
          return {
            job: null,
            error: response.status === 404
              ? '同步任务已提交，但进度已中断；任务可能仍在后台运行，请稍后再次同步该来源确认结果'
              : `同步任务已提交，但进度连接中断：${lastError}`,
          };
        }
        continue;
      }
      consecutiveFailures = 0;
      latestJob = {
        ...latestJob,
        ...response.data,
        target: nonNegativeInteger(response.data.target)
          || nonNegativeInteger(latestJob.target)
          || requestedCount,
        processed: typeof response.data.processed === 'number'
          ? nonNegativeInteger(response.data.processed)
          : nonNegativeInteger(latestJob.processed),
      };
      setCollectionJob(latestJob);
      publishSourceManagerNotice(formatCollectionSyncMessage({
        ...latestJob,
        sourceLabel: requestedSourceLabel,
        requestedCount,
      }));
      if (latestJob.status === 'success' || latestJob.status === 'failed') {
        return { job: latestJob, error: '' };
      }
    }
    return {
      job: null,
      error: lastError || '同步任务仍可能在后台运行，请稍后再次同步该来源确认结果',
    };
  };

  const collectOneSource = async (
    requestedMode: DouyinSourceMode,
    requestedCount: number,
  ): Promise<SyncCollectionModeResult> => {
    const requestedSourceLabel = SOURCE_MODES.find(
      (mode) => mode.value === requestedMode,
    )?.label || '视频';
    const requestedSort: DouyinLibrarySort = requestedMode === 'post'
      ? 'published'
      : sourceSorts[requestedMode] === 'published'
        ? 'published'
        : 'collection';
    const baselineKnown = requestedMode === sourceModeRef.current;
    let baselineItems = baselineKnown ? items : [];
    const progressPrefix = batchExtractingRef.current
      ? `正在同步${requestedSourceLabel}；已有文案任务继续在后台处理`
      : `正在同步${requestedSourceLabel}；视频会先进入视频资料`;
    publishSourceManagerNotice(progressPrefix);
    setCollectionJob(null);

    if (!baselineKnown) {
      const baselineResponse = await listDouyinLibraryItems(
        ALL_LIBRARY_ITEMS,
        requestedMode,
        requestedSort,
      );
      if (baselineResponse.success && baselineResponse.data) {
        baselineItems = baselineResponse.data.items;
      }
    }
    const previousIds = new Set(baselineItems.map((item) => item.aweme_id));

    if (desktopLocalDouyin) {
      const bridge = window.zhicuiDesktop;
      if (!bridge || !user?.id) {
        return {
          requestedMode,
          refreshed: null,
          newlyVisible: [],
          overview: null,
          finalJob: null,
          error: '未检测到可用的知萃桌面连接器',
        };
      }
      publishSourceManagerNotice(`正在本机读取抖音${requestedSourceLabel}…`);
      const collected = await bridge.collectPlatformAccount({
        platform: 'douyin',
        profileKey: user.id,
        mode: requestedMode,
        limit: requestedCount,
      });
      if (!collected.success || !collected.items?.length) {
        if (collected.error?.includes('重新登录')) {
          persistDesktopDouyinConnection(false);
        }
        return {
          requestedMode,
          refreshed: null,
          newlyVisible: [],
          overview: null,
          finalJob: null,
          error: collected.cancelled
            ? '本机读取已取消'
            : collected.error || `没有读取到抖音${requestedSourceLabel}`,
        };
      }
      publishSourceManagerNotice(
        `本机已读取 ${collected.items.length} 条${requestedSourceLabel}，正在登记公开资料…`,
      );
      const ingested = await ingestLocalDouyinLibrary(
        requestedMode,
        toLocalDouyinSyncItems(collected.items),
        desktopVersion,
      );
      if (!ingested.success || !ingested.data) {
        return {
          requestedMode,
          refreshed: null,
          newlyVisible: [],
          overview: null,
          finalJob: null,
          error: ingested.error || '本机已读取作品，但服务器登记失败',
        };
      }
      const refreshedResponse = await listDouyinLibraryItems(
        ALL_LIBRARY_ITEMS,
        requestedMode,
        requestedSort,
      );
      if (!refreshedResponse.success || !refreshedResponse.data) {
        return {
          requestedMode,
          refreshed: null,
          newlyVisible: [],
          overview: null,
          finalJob: null,
          error: `${requestedSourceLabel}已读取，但视频列表刷新失败`,
        };
      }
      const refreshed = refreshedResponse.data.items || [];
      const localJob: DouyinCollectionJob = {
        job_id: `desktop-${Date.now()}`,
        url: 'desktop-local',
        status: 'success',
        total: ingested.data.accepted,
        success: ingested.data.ready,
        failed: ingested.data.quarantined,
        skipped: 0,
        target: requestedCount,
        processed: ingested.data.accepted,
        mode: requestedMode,
        source_mode: requestedMode,
        channel: 'browser',
        fallback_attempted: false,
      };
      if (ingested.data.quarantined > 0) {
        publishSourceManagerNotice(
          `已读取 ${ingested.data.accepted} 条${requestedSourceLabel}，其中 ${ingested.data.quarantined} 条公开资料不完整，已安全隔离；请完成桌面端更新后重新同步`,
        );
      }
      return {
        requestedMode,
        refreshed,
        newlyVisible: findNewLibraryItems(refreshed, previousIds),
        overview: refreshedResponse.data,
        finalJob: localJob,
        error: '',
      };
    }

    const response = await collectDouyinLibrary(requestedCount, requestedMode);
    if (!response.success || !response.data) {
      return {
        requestedMode,
        refreshed: null,
        newlyVisible: [],
        overview: null,
        finalJob: null,
        error: formatDouyinSyncError(
          response.error || `${requestedSourceLabel}采集任务启动失败`,
          requestedSourceLabel,
          {
            error_code: response.error_details?.code,
            retry_after_seconds: response.error_details?.retry_after_seconds,
            needs_action: response.error_details?.needs_action,
          },
        ),
      };
    }

    const waitResult = await waitForCollectionJob(
      response.data,
      requestedCount,
      requestedSourceLabel,
    );
    const finalJob = waitResult.job;
    if (!finalJob && waitResult.error) {
      return {
        requestedMode,
        refreshed: null,
        newlyVisible: [],
        overview: null,
        finalJob: null,
        error: waitResult.error,
      };
    }
    const hasFailureDiagnostic = finalJob
      ? hasDouyinSyncFailureDiagnostic(finalJob)
      : false;
    const synchronizedCount = finalJob
      ? nonNegativeInteger(finalJob.success || finalJob.total)
      : 0;
    if (
      !finalJob
      || finalJob.status === 'failed'
      || hasFailureDiagnostic
      || (finalJob.status === 'success' && synchronizedCount === 0)
    ) {
      if (
        requestedMode === 'collect'
        && finalJob
        && (
          finalJob.error_code === 'source_blocked'
          || finalJob.error_code === 'risk_controlled'
          || finalJob.error_code === 'argus_uifid_missing'
          || finalJob.error_code === 'verification_required'
        )
      ) {
        setSourceReadability((current) => ({
          ...current,
          collect: {
            blockedUntil: Date.now() + nonNegativeInteger(finalJob.retry_after_seconds) * 1000,
            needsAction: Boolean(finalJob.needs_action),
          },
        }));
      }
      return {
        requestedMode,
        refreshed: null,
        newlyVisible: [],
        overview: null,
        finalJob,
        error: finalJob
          ? formatCollectionSyncMessage({
              ...finalJob,
              sourceLabel: requestedSourceLabel,
              requestedCount,
            })
          : '同步没有完成，请稍后重试',
      };
    }

    if (requestedMode === 'collect') {
      setSourceReadability((current) => {
        const next = { ...current };
        delete next.collect;
        return next;
      });
    }

    publishSourceManagerNotice(formatCollectionSyncMessage({
      ...finalJob,
      sourceLabel: requestedSourceLabel,
      requestedCount,
    }));
    const refreshedResponse = await listDouyinLibraryItems(
      ALL_LIBRARY_ITEMS,
      requestedMode,
      requestedSort,
    );
    if (!refreshedResponse.success || !refreshedResponse.data) {
      return {
        requestedMode,
        refreshed: null,
        newlyVisible: [],
        overview: null,
        finalJob,
        error: `${requestedSourceLabel}已经同步，但暂时无法刷新视频列表，请稍后重试`,
      };
    }
    const refreshedResult = refreshedResponse.data;
    const refreshed = refreshedResult.items || [];
    const newlyVisible = findNewLibraryItems(refreshed, previousIds);
    return {
      requestedMode,
      refreshed,
      newlyVisible,
      overview: refreshedResult,
      finalJob,
      error: '',
    };
  };

  const syncCollection = async (
    requestedModes: DouyinSourceMode[],
    persistedModes: DouyinSourceMode[],
    countOverride?: number,
  ): Promise<{ started: boolean }> => {
    if (desktopDouyinUpdateRequired) {
      publishSourceManagerNotice(
        `当前仍在运行知萃 ${desktopVersion}，请先重启并安装 ${MIN_LOCAL_DOUYIN_DESKTOP_VERSION} 或更高版本`,
      );
      return { started: false };
    }
    const selectedModes = requestedModes.length > 0
      ? requestedModes.slice(0, SOURCE_MODES.length)
      : [sourceModeRef.current];
    const readiness = desktopLocalDouyin
      ? undefined
      : status?.private_list_readiness;
    const blockedModes = readiness?.reported
      ? selectedModes.filter((mode) => (
          mode === 'collect' ? !readiness.collection_ready : !readiness.like_ready
        ))
      : [];
    const modes = selectedModes.filter((mode) => !blockedModes.includes(mode));
    if (blockedModes.length > 0) {
      const blockedLabels = blockedModes.map((mode) => (
        SOURCE_MODES.find((item) => item.value === mode)?.label || '该来源'
      ));
      publishSourceManagerNotice(
        `${blockedLabels.join('、')}当前不可读取，请重新连接抖音账号并等待登录确认；其他来源仍可同步。`,
      );
    }
    if (refreshing || !loggedIn || modes.length === 0) return { started: false };
    const requestedCount = clampInteger(countOverride ?? syncCount, 1, MAX_SYNC_COUNT);
    saveLibraryQuickSyncPreferences(
      requestedModes.length > 0 ? modes : persistedModes,
      requestedCount,
    );
    setSyncCount(requestedCount);
    setRefreshing(true);
    if (!batchExtractingRef.current) setExtractionJob(null);
    setPipelineStage('collect');
    publishSourceManagerNotice(
      `即将按顺序同步 ${modes.length} 个来源：${modes
        .map((value) => SOURCE_MODES.find((mode) => mode.value === value)?.label || '')
        .filter(Boolean)
        .join('、')}`,
    );

    const results: SyncCollectionModeResult[] = [];
    let failed = false;
    for (const requestedMode of modes) {
      if (!activeRef.current) return { started: true };
      const result = await collectOneSource(requestedMode, requestedCount);
      results.push(result);
      if (result.error) {
        failed = true;
        publishSourceManagerNotice(
          `${SOURCE_MODES.find((mode) => mode.value === requestedMode)?.label || '该来源'}：${result.error}`,
        );
        continue;
      }
      const refreshed = result.refreshed || [];
      const overview = result.overview;
      sourceModeRef.current = requestedMode;
      libraryRequestRef.current += 1;
      setSourceMode(requestedMode);
      setItems(refreshed);
      if (overview) {
        setLibraryOverview({
          sourceTotal: overview.source_total,
          temporaryHidden: overview.hidden.temporary,
          permanentHidden: overview.permanent_hidden_total,
        });
      }
      setSelected(new Set());
      setError('');
      setLoading(false);
      publishSourceManagerNotice(`${SOURCE_MODES.find((mode) => mode.value === requestedMode)?.label || '该来源'}已更新，视频资料现有 ${refreshed.length} 条`);
    }

    setRefreshing(false);
    setPipelineStage(failed ? 'idle' : 'done');

    const successful = results.filter((result) => !result.error && result.finalJob);
    const allRefreshed = results.filter((result) => !result.error && result.refreshed !== null);
    if (successful.length === 0) {
      const failureMessages = results
        .filter((result) => result.error)
        .map((result) => {
          const label = SOURCE_MODES.find(
            (mode) => mode.value === result.requestedMode,
          )?.label || '该来源';
          return `${label}：${result.error}`;
        });
      publishSourceManagerNotice(
        failureMessages.length > 0
          ? failureMessages.join('；')
          : '没有可同步的来源',
      );
      return { started: true };
    }
    if (modes.length === 1) {
      const result = successful[0];
      if (result) {
        const sourceLabel = SOURCE_MODES.find(
          (mode) => mode.value === result.requestedMode,
        )?.label || '视频';
        const quarantined = result.finalJob?.url === 'desktop-local'
          ? nonNegativeInteger(result.finalJob.failed)
          : 0;
        publishSourceManagerNotice(quarantined > 0
          ? `已读取 ${nonNegativeInteger(result.finalJob?.total)} 条${sourceLabel}，完整 ${nonNegativeInteger(result.finalJob?.success)} 条；另有 ${quarantined} 条公开资料不完整，已安全隔离，请更新桌面端后重新同步`
          : formatCollectionSyncMessage({
              ...result.finalJob!,
              sourceLabel,
              requestedCount,
            }));
      }
    } else {
      const summary = formatMultiSourceSyncSummary(results.map((result) => ({
          sourceLabel: SOURCE_MODES.find(
            (mode) => mode.value === result.requestedMode,
          )?.label || '该来源',
          checked: result.finalJob?.success || result.finalJob?.total || 0,
          newlyVisible: result.newlyVisible.length,
          error: result.error || undefined,
        })));
      const quarantined = successful.reduce(
        (total, result) => total + (
          result.finalJob?.url === 'desktop-local'
            ? nonNegativeInteger(result.finalJob.failed)
            : 0
        ),
        0,
      );
      publishSourceManagerNotice(
        quarantined > 0
          ? `${summary}；另有 ${quarantined} 条公开资料不完整，已安全隔离`
          : summary,
      );
    }

    const transcriptTargets = allRefreshed
      .flatMap((result) => result.newlyVisible)
      .slice(0, requestedCount * modes.length)
      .filter((item) => item.can_extract && !item.extracted);
    if (transcriptTargets.length === 0) return { started: true };
    if (batchExtractingRef.current) {
      publishSourceManagerNotice(
        `${transcriptTargets.length} 条新视频文案可稍后补提；当前文案任务仍在处理`,
      );
      return { started: true };
    }
    publishSourceManagerNotice(`${transcriptTargets.length} 条新视频文案将在后台准备`);
    void (async () => {
      await wait(700);
      if (!activeRef.current || batchExtractingRef.current) return;
      const result = await extractItems(
        transcriptTargets,
        'transcript',
        { background: true },
      );
      if (!activeRef.current) return;
      if (result.status === 'success' || result.status === 'partial') {
        publishSourceManagerNotice(
          `视频已同步，${result.success}/${transcriptTargets.length} 条文案已就绪`,
        );
      }
    })();
    return { started: true };
  };

  const syncCollectionRef = useRef(syncCollection);
  syncCollectionRef.current = syncCollection;

  const deleteExtraction = async (item: DouyinLibraryItem): Promise<boolean> => {
    const noteId = item.extracted_note_id;
    if (!noteId || deletingNoteId) return false;
    setDeletingNoteId(noteId);
    const response = await deleteDouyinLibraryExtraction(noteId);
    setDeletingNoteId(null);
    if (!response.success || !response.data) {
      setDeletionError(response.error || '删除知识结果失败');
      return false;
    }

    setItems((current) => current.map((currentItem) => (
      currentItem.aweme_id === item.aweme_id
        ? {
            ...currentItem,
            extracted: false,
            extracted_note_id: null,
            transcript_chars: 0,
            card_type: null,
            ai_initialized: false,
          }
        : currentItem
    )));
    setSelected((current) => {
      const next = new Set(current);
      next.delete(item.aweme_id);
      return next;
    });
    setExtractProgress((current) => {
      const next = { ...current };
      delete next[item.aweme_id];
      return next;
    });
    setNotice('已删除这条文案、摘要笔记和关联计划；抖音原视频不会受影响');
    return true;
  };

  const openDeletionDialog = (item: DouyinLibraryItem) => {
    if (!item.extracted_note_id || deletingNoteId) return;
    setDeletionTarget(item);
    setDeletionError('');
    deletionDialogRef.current?.showModal();
  };

  const closeDeletionDialog = () => {
    if (deletingNoteId) return;
    deletionDialogRef.current?.close();
    setDeletionTarget(null);
    setDeletionError('');
  };

  const confirmDeletion = async () => {
    if (!deletionTarget || deletingNoteId) return;
    setDeletionError('');
    const deleted = await deleteExtraction(deletionTarget);
    if (!deleted) return;
    deletionDialogRef.current?.close();
    setDeletionTarget(null);
  };

  const openSourceManager = () => {
    const dialog = sourceManagerDialogRef.current;
    if (!dialog || dialog.open) return;
    if (platformFilter !== 'all') setSourceManagerView(platformFilter);
    if (sourceManagerRailRef.current) sourceManagerRailRef.current.scrollTop = 0;
    sourceManagerRestoreFocusRef.current = true;
    setSourceManagerOpen(true);
    dialog.showModal();
    window.requestAnimationFrame(() => {
      sourceManagerTabsRef.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    });
  };

  useEffect(() => {
    if (quickSyncCheckedRef.current || typeof window === 'undefined') return;
    quickSyncCheckedRef.current = true;
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('sync') !== '1') return;
    currentUrl.searchParams.delete('sync');
    window.history.replaceState(
      {},
      '',
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    );
    setQuickSyncRequested(true);
  }, [user?.id]);

  useEffect(() => {
    if (!quickSyncRequested || loading || refreshing) return;
    setQuickSyncRequested(false);
    const preferences = readLibraryQuickSyncPreferences();
    setSourceManagerModes(preferences.modes);
    setSyncCount(preferences.count);
    if (!preferences.configured || !connected || !loggedIn) {
      openSourceManager();
      return;
    }
    setAutoSyncing(true);
    void syncCollectionRef.current(
      preferences.modes,
      preferences.modes,
      preferences.count,
    ).then((result) => {
      if (!activeRef.current) return;
      setAutoSyncing(false);
      if (!result.started) {
        openSourceManager();
        return;
      }
      void refreshLoginStatus();
    });
  }, [connected, loading, loggedIn, quickSyncRequested, refreshing, refreshLoginStatus]);

  const closeSourceManager = (restoreFocus = true) => {
    sourceManagerRestoreFocusRef.current = restoreFocus;
    sourceManagerDialogRef.current?.close();
  };

  const selectSourceManagerView = (nextView: SourceManagerView, focusTab = false) => {
    setSourceManagerView(nextView);
    window.requestAnimationFrame(() => {
      if (sourceManagerRailRef.current) sourceManagerRailRef.current.scrollTop = 0;
      if (focusTab) {
        sourceManagerTabsRef.current
          ?.querySelector<HTMLButtonElement>(`[data-source-view="${nextView}"]`)
          ?.focus();
      }
    });
  };

  const handleSourceManagerTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const currentIndex = SOURCE_MANAGER_TABS.findIndex(({ value }) => value === sourceManagerView);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % SOURCE_MANAGER_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + SOURCE_MANAGER_TABS.length) % SOURCE_MANAGER_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SOURCE_MANAGER_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextView = SOURCE_MANAGER_TABS[nextIndex].value;
    selectSourceManagerView(nextView, true);
  };

  const startQrLoginFromSourceManager = () => {
    closeSourceManager(false);
    window.requestAnimationFrame(() => void startQrLogin());
  };

  const openSessionDialogFromSourceManager = (action: DouyinSessionAction) => {
    closeSourceManager(false);
    window.requestAnimationFrame(() => openSessionDialog(action));
  };

  const openRemovalDialog = (
    targetItems: DouyinLibraryItem[],
    mode: 'temporary' | 'permanent' = 'temporary',
  ) => {
    if (removalPending || targetItems.length === 0) return;
    const boundedItems = targetItems.slice(0, MAX_SELECTION);
    setRemovalTarget({
      awemeIds: boundedItems.map((item) => item.aweme_id),
      title: boundedItems.length === 1 ? boundedItems[0].title : undefined,
      mode,
    });
    setRemovalError('');
    removalDialogRef.current?.showModal();
  };

  const closeRemovalDialog = () => {
    if (removalPending) return;
    removalDialogRef.current?.close();
    setRemovalTarget(null);
    setRemovalError('');
  };

  const confirmRemoval = async () => {
    if (!removalTarget || removalPending) return;
    setRemovalPending(true);
    setRemovalError('');
    const response = await removeDouyinLibraryItems(
      removalTarget.awemeIds,
      removalTarget.mode,
    );
    if (!response.success || !response.data) {
      setRemovalPending(false);
      setRemovalError(response.error || '暂时无法从视频资料移除，请稍后重试');
      return;
    }

    const removedIds = new Set(response.data.aweme_ids);
    setItems((current) => current.filter(
      (item) => !removedIds.has(item.aweme_id),
    ));
    setSelected((current) => {
      const next = new Set(current);
      removedIds.forEach((awemeId) => next.delete(awemeId));
      return next;
    });
    setExtractProgress((current) => {
      const next = { ...current };
      removedIds.forEach((awemeId) => delete next[awemeId]);
      return next;
    });
    const completedMode = removalTarget.mode;
    setRemovalPending(false);
    removalDialogRef.current?.close();
    setRemovalTarget(null);
    await loadItems(true);
    setNotice(
      completedMode === 'permanent'
        ? `已永久隐藏 ${removedIds.size} 条视频；可从“已永久隐藏”中恢复，抖音收藏和已有文案不受影响`
        : `已移出 ${removedIds.size} 条视频；下次同步会重新显示，抖音收藏和已有文案不受影响`,
    );
  };

  const loadPermanentHiddenItems = useCallback(async () => {
    setHiddenManagerLoading(true);
    setHiddenManagerError('');
    const response = await listPermanentlyHiddenDouyinItems(100);
    setHiddenManagerLoading(false);
    if (!response.success || !response.data) {
      setHiddenManagerError(response.error || '暂时无法读取已永久隐藏的视频');
      return;
    }
    setPermanentHiddenItems(response.data.items);
    setLibraryOverview((current) => ({
      ...current,
      permanentHidden: response.data?.total || 0,
    }));
  }, []);

  const openHiddenManager = () => {
    setHiddenManagerError('');
    hiddenManagerDialogRef.current?.showModal();
    void loadPermanentHiddenItems();
  };

  const closeHiddenManager = () => {
    if (restorePending) return;
    hiddenManagerDialogRef.current?.close();
    setHiddenManagerError('');
  };

  const restorePermanentItems = async (awemeIds: string[]) => {
    if (restorePending || awemeIds.length === 0) return;
    setRestorePending(true);
    setHiddenManagerError('');
    const targetIds = awemeIds.slice(0, MAX_SELECTION);
    const response = await restorePermanentlyHiddenDouyinItems(targetIds);
    if (!response.success || !response.data) {
      setRestorePending(false);
      setHiddenManagerError(response.error || '恢复失败，请稍后重试');
      return;
    }
    const restoredCount = response.data.restored;
    const restoredIds = new Set(response.data.aweme_ids);
    setPermanentHiddenItems((current) => current.filter(
      (item) => !restoredIds.has(item.aweme_id),
    ));
    setLibraryOverview((current) => ({
      ...current,
      permanentHidden: Math.max(0, current.permanentHidden - restoredCount),
    }));
    setRestorePending(false);
    await loadItems(true);
    setNotice(`已恢复 ${restoredCount} 条视频；如果它仍在同步范围内，现在会重新显示`);
  };

  return (
    <div
      className={`${styles.workspace} video-library-page desktop-core-page`}
      aria-busy={refreshing}
      data-has-selection={selectedCount > 0}
    >
      <div className="library-ambient" aria-hidden="true" />

      <dialog
        ref={sessionDialogRef}
        className="library-session-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="library-session-dialog-title"
        aria-describedby="library-session-dialog-description"
        onCancel={(event) => {
          if (sessionPending) {
            event.preventDefault();
            return;
          }
          setSessionAction(null);
          setSessionError('');
        }}
      >
        <div className="library-session-dialog-card">
          <div className="library-session-dialog-icon" aria-hidden="true">
            {sessionAction === 'rebind' ? <Repeat2 size={20} /> : <LogOut size={20} />}
          </div>
          <div>
            <h2 id="library-session-dialog-title">
              {sessionAction === 'rebind' ? '换绑另一个抖音账号？' : '确认退出抖音？'}
            </h2>
            <p id="library-session-dialog-description">
              {sessionAction === 'rebind'
                ? '会先安全退出当前账号，再立即打开新的扫码登录。已有文案、摘要笔记和计划不会删除。'
                : '只会清除当前抖音登录状态；已有文案、摘要笔记、计划和视频资料都会保留。'}
            </p>
          </div>
          {sessionError && (
            <p className="library-session-error" role="alert">{sessionError}</p>
          )}
          <div className="library-session-dialog-actions">
            <button type="button" onClick={closeSessionDialog} disabled={sessionPending}>
              取消
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={confirmSessionAction}
              disabled={sessionPending}
            >
              {sessionPending && <LoaderCircle size={15} className="animate-spin" />}
              {sessionAction === 'rebind' ? '退出并重新扫码' : '确认退出'}
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={deletionDialogRef}
        className="library-session-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="library-deletion-dialog-title"
        aria-describedby="library-deletion-dialog-description"
        onCancel={(event) => {
          if (deletingNoteId) {
            event.preventDefault();
            return;
          }
          setDeletionTarget(null);
          setDeletionError('');
        }}
      >
        <div className="library-session-dialog-card">
          <div className="library-session-dialog-icon is-permanent" aria-hidden="true">
            <Trash2 size={20} />
          </div>
          <div>
            <h2 id="library-deletion-dialog-title">删除这条文案与摘要？</h2>
            <p id="library-deletion-dialog-description">
              会删除知萃中的完整文案、摘要笔记和关联计划；抖音原视频仍会保留，下次需要时可重新提取。
            </p>
            {deletionTarget?.title && (
              <p className="library-removal-target" title={deletionTarget.title}>
                {deletionTarget.title}
              </p>
            )}
          </div>
          {deletionError && (
            <p className="library-session-error" role="alert">{deletionError}</p>
          )}
          <div className="library-session-dialog-actions">
            <button type="button" onClick={closeDeletionDialog} disabled={Boolean(deletingNoteId)}>
              取消
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={confirmDeletion}
              disabled={Boolean(deletingNoteId)}
            >
              {deletingNoteId && <LoaderCircle size={15} className="animate-spin" />}
              确认删除
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={removalDialogRef}
        className="library-session-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="library-removal-dialog-title"
        aria-describedby="library-removal-dialog-description"
        onCancel={(event) => {
          if (removalPending) {
            event.preventDefault();
            return;
          }
          setRemovalTarget(null);
          setRemovalError('');
        }}
      >
        <div className="library-session-dialog-card">
          <div
            className={`library-session-dialog-icon ${
              removalTarget?.mode === 'permanent' ? 'is-permanent' : 'is-temporary'
            }`}
            aria-hidden="true"
          >
            {removalTarget?.mode === 'permanent'
              ? <EyeOff size={20} />
              : <CircleMinus size={20} />}
          </div>
          <div>
            <h2 id="library-removal-dialog-title">
              {removalTarget?.mode === 'permanent'
                ? removalTarget.awemeIds.length === 1
                  ? '永久隐藏这条视频？'
                  : `永久隐藏所选 ${removalTarget.awemeIds.length} 条视频？`
                : removalTarget?.awemeIds.length === 1
                  ? '把这条视频移出视频资料？'
                  : `移出所选 ${removalTarget?.awemeIds.length || 0} 条视频？`}
            </h2>
            <p id="library-removal-dialog-description">
              {removalTarget?.mode === 'permanent'
                ? '以后同步也不会再显示这些视频，除非你从“已永久隐藏”中恢复。不会取消抖音收藏，也不会删除已有文案、摘要笔记和计划。'
                : '只从当前视频资料移出，下次同步时会重新出现。不会取消抖音收藏，也不会删除已有文案、摘要笔记和计划。'}
            </p>
            {removalTarget?.title && (
              <p className="library-removal-target" title={removalTarget.title}>
                {removalTarget.title}
              </p>
            )}
          </div>
          {removalError && (
            <p className="library-session-error" role="alert">{removalError}</p>
          )}
          <div className="library-session-dialog-actions">
            <button type="button" onClick={closeRemovalDialog} disabled={removalPending}>
              取消
            </button>
            <button
              type="button"
              className={removalTarget?.mode === 'permanent' ? 'is-danger' : 'is-confirm'}
              onClick={confirmRemoval}
              disabled={removalPending}
            >
              {removalPending && <LoaderCircle size={15} className="animate-spin" />}
              {removalTarget?.mode === 'permanent' ? '确认永久隐藏' : '确认移出'}
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={hiddenManagerDialogRef}
        className="library-session-dialog library-hidden-dialog"
        aria-modal="true"
        aria-labelledby="library-hidden-dialog-title"
        onCancel={(event) => {
          if (restorePending) {
            event.preventDefault();
            return;
          }
          setHiddenManagerError('');
        }}
      >
        <div className="library-session-dialog-card library-hidden-dialog-card">
          <div className="library-session-dialog-icon is-permanent" aria-hidden="true">
            <EyeOff size={20} />
          </div>
          <div className="library-hidden-dialog-heading">
            <span className="library-hidden-kicker">单独管理</span>
            <h2 id="library-hidden-dialog-title">
              已永久隐藏 · {libraryOverview.permanentHidden}
            </h2>
            <p>这些视频不会在同步后自动出现，但抖音收藏、已有文案、摘要笔记和计划都还在。</p>
          </div>

          <div className="library-hidden-list">
            {hiddenManagerLoading ? (
              <div className="library-hidden-state">
                <LoaderCircle size={20} className="animate-spin" />
                正在读取…
              </div>
            ) : hiddenManagerError ? (
              <p className="library-session-error" role="alert">{hiddenManagerError}</p>
            ) : permanentHiddenItems.length === 0 ? (
              <div className="library-hidden-state">
                <CheckCircle2 size={22} />
                <strong>没有永久隐藏的视频</strong>
                <span>普通“移出视频资料”的视频会在下次同步时重新出现。</span>
              </div>
            ) : (
              permanentHiddenItems.map((item) => (
                <article className="library-hidden-item" key={item.aweme_id}>
                  {item.cover_url ? (
                    <img src={item.cover_url} alt="" loading="lazy" />
                  ) : (
                    <div className="library-hidden-cover-fallback" aria-hidden="true">
                      <FileText size={18} />
                    </div>
                  )}
                  <div>
                    <span className="library-hidden-badge">
                      <EyeOff size={11} />
                      永久隐藏
                    </span>
                    <h3 title={item.title}>{item.title}</h3>
                    <p>
                      {item.author_name || '作者信息暂不可用'}
                      {' · '}
                      {new Date(item.hidden_at).toLocaleDateString('zh-CN')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void restorePermanentItems([item.aweme_id])}
                    disabled={restorePending}
                  >
                    <RotateCcw size={14} />
                    恢复
                  </button>
                </article>
              ))
            )}
          </div>

          <div className="library-session-dialog-actions">
            <button type="button" onClick={closeHiddenManager} disabled={restorePending}>
              完成
            </button>
            {permanentHiddenItems.length > 0 && (
              <button
                type="button"
                className="is-confirm"
                onClick={() => void restorePermanentItems(
                  permanentHiddenItems.slice(0, MAX_SELECTION).map((item) => item.aweme_id),
                )}
                disabled={restorePending}
              >
                {restorePending
                  ? <LoaderCircle size={15} className="animate-spin" />
                  : <RotateCcw size={15} />}
                恢复{permanentHiddenItems.length > MAX_SELECTION ? '前 50 条' : '全部'}
              </button>
            )}
          </div>
        </div>
      </dialog>

      {qrPanelOpen && bindingClient !== 'desktop-app' && (
        <section className="library-qr-card" aria-live="polite" aria-label="抖音扫码登录">
          <div className="library-qr-heading">
            <div>
              <span className="library-qr-kicker">
                <QrCode size={15} />
                登录抖音
              </span>
              <h2>
                {bindingClient === 'desktop-web'
                  ? '请使用知萃 Windows 桌面端'
                  : '请在 Windows 电脑完成一次绑定'}
              </h2>
              <p>桌面端会打开你电脑上的 Chrome，不会再跳转 localhost，也不会显示服务器 Linux 位置。</p>
            </div>
            <button type="button" onClick={closeQrLogin} aria-label="关闭扫码登录">
              <X size={18} />
            </button>
          </div>
          <div className="library-qr-body">
            <div className="library-qr-frame">
              <div className="library-browser-login is-open">
                <ExternalLink size={30} aria-hidden="true" />
                <strong>知萃 Windows 桌面端</strong>
                <span>安装一次，之后直接使用本机 Chrome 扫码登录。</span>
              </div>
            </div>
            <div className="library-qr-guide">
              <p
                className={`library-qr-capability is-${bindingClient}`}
                role={bindingClient === 'mobile-web' ? 'note' : undefined}
              >
                {bindingClient === 'desktop-web' && '已安装可直接打开；未安装请先下载 Windows 版。'}
                {bindingClient === 'android-app' && '手机端登录同一个知萃账号，电脑绑定成功后这里会自动生效。'}
                {bindingClient === 'mobile-web' && '电脑和手机登录同一个知萃账号，绑定一次即可跨端使用。'}
              </p>
              <ol>
                <li>下载并安装“知萃 Windows 桌面端”</li>
                <li>登录与当前页面完全相同的知萃账号</li>
                <li>进入视频资料并点击“扫码登录抖音”</li>
                <li>在本机 Chrome 扫码确认；绑定状态会自动更新，但不会自动抓取视频</li>
              </ol>
              <div className="library-qr-actions">
                <button
                  type="button"
                  onClick={launchDesktopApp}
                >
                  <ExternalLink size={17} />
                  打开桌面端
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={downloadDesktopApp}
                >
                  <Download size={17} />
                  下载 Windows 版
                </button>
              </div>
              {bindingClient !== 'desktop-web' && (
                <button
                  type="button"
                  className="library-qr-check-button"
                  onClick={() => void checkDesktopBinding()}
                  disabled={bindingCheckPending}
                >
                  {bindingCheckPending
                    ? <LoaderCircle size={17} className="animate-spin" />
                    : <RefreshCw size={17} />}
                  我已在电脑完成，检查结果
                </button>
              )}
              {qrActionMessage && (
                <p className="library-qr-action-message" role="status">
                  {qrActionMessage}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <dialog
        ref={sourceManagerDialogRef}
        className={styles.sourceDialog}
        aria-labelledby="library-source-heading"
        aria-describedby="library-source-description"
        onClose={() => {
          setSourceManagerOpen(false);
          if (sourceManagerRestoreFocusRef.current) {
            sourceManagerTriggerRef.current?.focus();
          }
          sourceManagerRestoreFocusRef.current = true;
        }}
      >
        <div className={styles.sourceDialogCard}>
          <header className={styles.sourceDialogHeader}>
            <div>
              <h2 id="library-source-heading">同步视频</h2>
              <span id="library-source-description">仅在点击同步按钮后读取所选来源</span>
            </div>
            <button
              type="button"
              onClick={() => closeSourceManager()}
              aria-label="关闭同步视频"
            >
              <X size={18} />
            </button>
          </header>
          <div
            ref={sourceManagerTabsRef}
            className={styles.sourceTabs}
            role="tablist"
            aria-label="选择视频来源"
          >
            {SOURCE_MANAGER_TABS.map(({ value, label }) => {
              const active = sourceManagerView === value;
              return (
                <button
                  id={`library-source-tab-${value}`}
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="library-source-active-panel"
                  tabIndex={active ? 0 : -1}
                  data-active={active}
                  data-source-view={value}
                  onClick={() => selectSourceManagerView(value)}
                  onKeyDown={handleSourceManagerTabKeyDown}
                >
                  <span className={styles.sourceTabIcon} aria-hidden="true">
                    {value === 'import'
                      ? <Link2 size={17} />
                      : <PlatformBrandIcon platform={value} size={17} />}
                  </span>
                  <span>{label}</span>
                  {value === 'xiaohongshu' && <small>Beta</small>}
                </button>
              );
            })}
          </div>
          <div ref={sourceManagerRailRef} className={styles.sourceRail}>
          <div
            id="library-source-active-panel"
            className={styles.sourceControls}
            role="tabpanel"
            aria-labelledby={`library-source-tab-${sourceManagerView}`}
            tabIndex={0}
          >

          {sourceManagerView === 'douyin' && (
          <>

          {desktopDouyinUpdateRequired && (
            <div className="library-offline-note" role="alert">
              <RefreshCw size={17} />
              <div>
                <strong>需要重启安装桌面更新</strong>
                <p>
                  当前运行的是知萃 {desktopVersion}，所以仍显示旧云端账号记录。
                  更新后将改为本机读取抖音喜欢、收藏和自己的作品。
                </p>
                <button
                  type="button"
                  className={styles.inlineRetry}
                  disabled={desktopUpdateInstalling}
                  onClick={() => void installDesktopUpdateForDouyin()}
                >
                  {desktopUpdateInstalling ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {desktopUpdateInstalling ? '正在准备更新' : '重启并安装'}
                </button>
              </div>
            </div>
          )}

          {statusError && !desktopLocalDouyin && !desktopDouyinUpdateRequired && (
            <div className="library-offline-note" role="alert">
              <ServerOff size={17} />
              <div>
                <strong>无法检测抖音连接</strong>
                <p>{friendlyLibraryError(statusError)}</p>
                <button
                  type="button"
                  className={styles.inlineRetry}
                  onClick={() => void refreshLoginStatus()}
                >
                  <RefreshCw size={14} />
                  重新检测
                </button>
              </div>
            </div>
          )}

          {!statusError && !connected && status && !desktopDouyinUpdateRequired && (
            <div className="library-offline-note">
              <ServerOff size={17} />
              <div>
                <strong>抖音视频资料暂时无法连接</strong>
                <p>请稍后重试；单条链接提取仍可正常使用。</p>
              </div>
            </div>
          )}

          <section className="library-source-panel" aria-label="选择抖音内容来源">
            <div className={styles.sourcePlatformHeading}>
              <span className={styles.sourcePlatformMark} data-platform="douyin" aria-hidden="true">
                <PlatformBrandIcon platform="douyin" size={17} />
              </span>
              <div>
                <strong>抖音账号</strong>
                <small>{desktopDouyinUpdateRequired
                  ? `需要更新 ${desktopVersion}`
                  : desktopLocalDouyin
                  ? loggedIn ? '本机登录有效' : '等待本机登录'
                  : statusError ? '连接待检测' : loggedIn ? '已连接' : '等待登录'}</small>
              </div>
              <div className={styles.sourceAccountActions}>
                {desktopDouyinUpdateRequired ? (
                  <button
                    type="button"
                    onClick={() => void installDesktopUpdateForDouyin()}
                    disabled={desktopUpdateInstalling}
                    className={styles.sourceLoginAction}
                  >
                    {desktopUpdateInstalling ? (
                      <LoaderCircle size={15} className="animate-spin" />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    {desktopUpdateInstalling ? '正在更新' : '重启并安装'}
                  </button>
                ) : loggedIn ? (
                  <details className={styles.sourceAccountMenu}>
                    <summary>
                      账号管理
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <div>
                      <button
                        type="button"
                        onClick={() => openSessionDialogFromSourceManager('rebind')}
                        disabled={refreshing || batchExtracting || sessionPending}
                      >
                        <Repeat2 size={15} />
                        换绑账号
                      </button>
                      <button
                        type="button"
                        data-danger="true"
                        onClick={() => openSessionDialogFromSourceManager('logout')}
                        disabled={refreshing || batchExtracting || sessionPending}
                      >
                        <LogOut size={15} />
                        退出抖音
                      </button>
                    </div>
                  </details>
                ) : (
                  <button
                    type="button"
                    onClick={startQrLoginFromSourceManager}
                    disabled={!connected || scanning}
                    className={styles.sourceLoginAction}
                  >
                    {scanning ? (
                      <LoaderCircle size={15} className="animate-spin" />
                    ) : (
                      <QrCode size={15} />
                    )}
                    {scanning ? '正在登录' : '登录'}
                  </button>
                )}
              </div>
            </div>
            {loggedIn && (
              <dl className={styles.sourceAccountSummary} aria-label="抖音账号连接详情">
                <div>
                  <dt>账号状态</dt>
                  <dd data-status="connected">
                    <CheckCircle2 size={14} aria-hidden="true" />
                    连接正常
                  </dd>
                </div>
                <div>
                  <dt>绑定时间</dt>
                  <dd className={styles.accountTime}>
                    {desktopLocalDouyin
                      ? '仅保存在这台电脑'
                      : formatAccountTime(status?.binding?.bound_at, '本次已连接')}
                  </dd>
                </div>
                <div>
                  <dt>最近验证</dt>
                  <dd className={styles.accountTime}>
                    {desktopLocalDouyin
                      ? desktopDouyinStage === 'needs-action' ? '需要官方验证' : '本机会话有效'
                      : formatAccountTime(status?.binding?.last_verified_at, '刚刚验证')}
                  </dd>
                </div>
                <div>
                  <dt>最近同步</dt>
                  <dd className={styles.accountTime}>
                    {desktopLocalDouyin
                      ? '仅手动触发'
                      : formatAccountTime(status?.binding?.last_sync_at)}
                  </dd>
                </div>
                {!desktopLocalDouyin && status?.private_list_readiness?.reported && (
                  <>
                    <div>
                      <dt>喜欢读取</dt>
                      <dd data-status={status.private_list_readiness.like_ready ? 'connected' : 'attention'}>
                        {status.private_list_readiness.like_ready ? '可以同步' : '需要重新连接'}
                      </dd>
                    </div>
                    <div>
                      <dt>收藏读取</dt>
                      <dd data-status={status.private_list_readiness.collection_ready ? 'connected' : 'attention'}>
                        {status.private_list_readiness.collection_ready ? '可以同步' : '登录信息不完整'}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            )}
            <div className="library-source-main">
              <div className="library-source-modes" role="group" aria-label="选择要同步的抖音来源，可多选">
                {SOURCE_MODES.map(({ value, label, Icon }) => {
                  const active = sourceManagerModes.includes(value);
                  const readinessUnavailable = !desktopLocalDouyin
                    && !desktopDouyinUpdateRequired && Boolean(
                    status?.private_list_readiness?.reported
                    && (
                      value === 'collect'
                        ? !status.private_list_readiness.collection_ready
                        : value === 'like'
                          ? !status.private_list_readiness.like_ready
                          : false
                    ),
                  );
                  const collectionUnavailable = value === 'collect' && (
                    readinessUnavailable
                    || (
                      Boolean(collectionReadability)
                      && (collectionRetryMinutes > 0 || Boolean(collectionReadability?.needsAction))
                    )
                  );
                  const sourceUnavailable = readinessUnavailable || collectionUnavailable;
                  return (
                    <button
                      type="button"
                      key={value}
                      className={active ? 'is-active' : ''}
                      data-unavailable={sourceUnavailable || undefined}
                      aria-pressed={active}
                      disabled={refreshing || batchExtracting || desktopDouyinUpdateRequired}
                      onClick={() => {
                        setSourceManagerModes((current) => {
                          const next = current.includes(value)
                            ? current.filter((mode) => mode !== value)
                            : [...current, value];
                          return next.length > 0 ? next : current;
                        });
                        setSourceManagerNotice('');
                      }}
                    >
                      <Icon size={17} />
                      <strong>{label}</strong>
                      <small>
                        {sourceUnavailable
                          ? readinessUnavailable
                            ? value === 'collect' ? '需重新连接' : '登录已失效'
                            : collectionReadability?.needsAction
                              ? '需要验证账号'
                            : `约 ${collectionRetryMinutes} 分钟后重试`
                          : active ? '已选' : '未选'}
                      </small>
                    </button>
                  );
                })}
              </div>
              <div className="library-pipeline-action">
                <button
                  type="button"
                  onClick={() => void syncCollection(sourceManagerModes, sourceManagerModes)}
                  disabled={desktopDouyinUpdateRequired || !connected || !loggedIn || refreshing || sourceManagerModes.length === 0}
                  className="library-pipeline-button"
                >
                  {refreshing ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  {pipelineStage === 'collect'
                    ? '正在从抖音同步'
                    : `同步${sourceManagerLabel}`}
                  {!refreshing && <span className={styles.syncCountBadge}>{syncCount} 条</span>}
                </button>
              </div>
            </div>

            {!desktopLocalDouyin && !desktopDouyinUpdateRequired
              && status?.private_list_readiness?.reported
              && !status.private_list_readiness.collection_ready && (
              <div className={styles.sourceNotice} role="status">
                <Info size={15} aria-hidden="true" />
                <span>
                  收藏读取条件未完成，请重新连接抖音账号并等待登录确认；喜欢和我的作品不受影响。
                </span>
              </div>
            )}

            <details className="library-processing-settings">
              <summary className="library-processing-heading">
                <span>
                  <SlidersHorizontal size={14} />
                  同步 {syncCount} 条
                </span>
                <small>调整数量</small>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="library-advanced-body">
                <div className="library-auto-controls">
                  <div className="library-count-control is-sync-count">
                    <span>最近同步</span>
                    <div className="library-sync-count-inputs">
                      <div
                        className="library-count-options"
                        role="group"
                        aria-label="选择同步数量"
                      >
                        {SYNC_COUNT_OPTIONS.map((count) => (
                          <button
                            type="button"
                            key={count}
                            className={syncCount === count ? 'is-active' : ''}
                            aria-pressed={syncCount === count}
                            onClick={() => setSyncCount(count)}
                          >
                            {count} 条
                          </button>
                        ))}
                      </div>
                      <label className="library-custom-count">
                        <span>自定义</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={MAX_SYNC_COUNT}
                          value={syncCount}
                          aria-label="自定义同步数量"
                          onChange={(event) => {
                            const nextCount = clampInteger(
                              Number(event.target.value),
                              1,
                              MAX_SYNC_COUNT,
                            );
                            setSyncCount(nextCount);
                          }}
                        />
                        <small>条</small>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </details>

            {refreshing && (
              <div className="library-sync-stage" role="status">
                <span className="library-sync-stage-icon" aria-hidden="true">
                  <LoaderCircle size={17} className="animate-spin" />
                </span>
                <span>
                  <strong>正在同步{sourceManagerLabel}</strong>
                </span>
                <b>
                  {collectionProgress.current}
                  <small>/{collectionProgress.target}</small>
                </b>
              </div>
            )}
            {collectionJob && refreshing && (
              <div
                className="library-pipeline-progress"
                role="progressbar"
                aria-label={`${sourceManagerLabel}同步进度`}
                aria-valuemin={0}
                aria-valuemax={collectionProgress.target}
                aria-valuenow={collectionProgress.current}
                aria-valuetext={`已读取 ${collectionProgress.current} / ${collectionProgress.target} 条`}
              >
                <span style={{
                  width: `${collectionProgress.percent}%`,
                }} />
              </div>
            )}
          </section>
          </>
          )}

          <PlatformLibraryPanel
            key={platformPanelVersion}
            search={search}
            filter={platformFilter}
            onFilterChange={switchPlatformFilter}
            presentation="controls"
            managerView={sourceManagerView === 'douyin' ? 'hidden' : sourceManagerView}
            onItemsChange={setPlatformItems}
            onStateChange={setPlatformLibraryState}
          />
          </div>
        </div>
        {sourceManagerNotice && sourceManagerView === 'douyin' && (
          <div className={styles.sourceNotice} role="status">
            <Info size={15} aria-hidden="true" />
            <span>{sourceManagerNotice}</span>
          </div>
        )}
        </div>
      </dialog>

      <div
        className={styles.referenceWorkspace}
        data-has-selection={selectedCount > 0}
      >

        <section className={styles.listColumn} aria-labelledby="video-library-heading">
          <header className={styles.listHeader}>
            <div>
              <h1 id="video-library-heading">视频资料</h1>
              <span>{visibleItemCount.toLocaleString('zh-CN')} 条</span>
            </div>
            <div className={styles.headerAiActions}>
              <Link
                href="/library/creators"
                className={styles.headerAiAction}
                aria-label="打开博主作品清单"
              >
                <UserRound size={17} aria-hidden="true" />
                <span>博主</span>
              </Link>
              <button
                ref={sourceManagerTriggerRef}
                type="button"
                className={styles.headerSourceAction}
                aria-haspopup="dialog"
                aria-expanded={sourceManagerOpen}
                aria-label={refreshing || autoSyncing ? '视频同步中，查看进度' : '同步视频'}
                onClick={openSourceManager}
              >
                {refreshing || autoSyncing ? (
                  <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Plus size={17} aria-hidden="true" />
                )}
                <span>{refreshing || autoSyncing ? '同步中' : '同步视频'}</span>
              </button>
              {showDouyinItems && (
                <button
                  type="button"
                  className={styles.headerAiAction}
                  aria-label={selectedCount > 0
                    ? `带已选的 ${selectedCount} 条视频进入知萃 AI`
                    : '用全部视频进入知萃 AI'}
                  onClick={openLibraryInAgent}
                >
                  <MessageSquareText size={18} aria-hidden="true" />
                  <span>去提问</span>
                </button>
              )}
              <details className={styles.headerMore}>
                <summary aria-label="更多视频资料操作">
                  <MoreHorizontal size={18} aria-hidden="true" />
                </summary>
                <div>
                  <Link href="/library/creators" aria-label="管理博主作品清单">
                    <UserRound size={16} aria-hidden="true" />
                    博主作品
                  </Link>
                  <Link href="/harness" aria-label="打开知萃 AI">
                    <Bot size={16} aria-hidden="true" />
                    知萃 AI
                  </Link>
                  {libraryOverview.permanentHidden > 0 && (
                    <button type="button" onClick={openHiddenManager}>
                      <EyeOff size={16} aria-hidden="true" />
                      已隐藏 {libraryOverview.permanentHidden}
                    </button>
                  )}
                </div>
              </details>
            </div>
          </header>

          <div className={styles.platformTabs} role="group" aria-label="按平台筛选视频资料">
            {PLATFORM_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                aria-pressed={platformFilter === tab.value}
                data-active={platformFilter === tab.value}
                onClick={() => switchPlatformFilter(tab.value)}
                disabled={batchExtracting}
              >
                {tab.value === 'all' ? (
                  <FileText size={15} aria-hidden="true" />
                ) : (
                  <PlatformBrandIcon platform={tab.value} size={14} />
                )}
                <span>{tab.label}</span>
                <b>{platformCounts[tab.value].toLocaleString('zh-CN')}</b>
              </button>
            ))}
          </div>

          <div className={`${styles.listToolbar} library-toolbar`}>
            <label className="library-search">
              <Search size={16} />
              <span className="sr-only">搜索视频</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索标题、作者、文案或标签"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="清空搜索">
                  <X size={14} />
                </button>
              )}
            </label>

            <div className="library-selection-actions">
              <div className={styles.viewSwitch} role="group" aria-label="资料布局">
                <button
                  type="button"
                  data-active={layoutMode === 'list'}
                  aria-pressed={layoutMode === 'list'}
                  aria-label="切换为列表布局"
                  title="列表布局"
                  onClick={() => setLayoutMode('list')}
                >
                  <List size={17} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  data-active={layoutMode === 'grid'}
                  aria-pressed={layoutMode === 'grid'}
                  aria-label="切换为网格布局"
                  title="网格布局"
                  onClick={() => setLayoutMode('grid')}
                >
                  <LayoutGrid size={17} aria-hidden="true" />
                </button>
              </div>
              {showDouyinItems && (
                <>
                  {sourceMode !== 'post' ? (
                    <div
                      ref={sortMenuRef}
                      className={`library-sort-picker ${sortMenuOpen ? 'is-open' : ''}`}
                    >
                      <button
                        ref={sortTriggerRef}
                        type="button"
                        className="library-sort-picker-trigger"
                        aria-label={`抖音${sourceLabel}视频排序`}
                        aria-expanded={sortMenuOpen}
                        disabled={refreshing || batchExtracting}
                        onClick={() => setSortMenuOpen((open) => !open)}
                      >
                        <ArrowDownWideNarrow size={15} aria-hidden="true" />
                        <span className="library-sort-picker-value">
                          抖音 · {activeSort === 'collection' ? sourceOrderLabel : '发布时间'}
                        </span>
                        <ChevronDown size={13} aria-hidden="true" />
                      </button>
                      {sortMenuOpen && (
                        <div className="library-sort-menu" role="group" aria-label="抖音排序方式">
                          <button
                            type="button"
                            aria-pressed={activeSort === 'collection'}
                            className={activeSort === 'collection' ? 'is-selected' : ''}
                            onClick={() => selectSourceSort('collection')}
                          >
                            <ArrowDownWideNarrow size={17} aria-hidden="true" />
                            <strong>{sourceOrderLabel}</strong>
                            {activeSort === 'collection' && <Check size={16} aria-hidden="true" />}
                          </button>
                          <button
                            type="button"
                            aria-pressed={activeSort === 'published'}
                            className={activeSort === 'published' ? 'is-selected' : ''}
                            onClick={() => selectSourceSort('published')}
                          >
                            <CalendarCheck size={17} aria-hidden="true" />
                            <strong>发布时间</strong>
                            {activeSort === 'published' && <Check size={16} aria-hidden="true" />}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="library-sort-state">
                      <ArrowDownWideNarrow size={14} />
                      抖音 · 发布时间
                    </span>
                  )}
                </>
              )}
              <button
                type="button"
                className="library-text-action"
                onClick={selectVisible}
                disabled={visibleSelectableCount === 0 || batchExtracting}
                aria-label={allVisibleSelected ? '取消选择当前显示的视频' : '选择当前显示的所有视频'}
              >
                {allVisibleSelected ? <CheckSquare2 size={15} /> : <Square size={15} />}
                {allVisibleSelected ? '取消全选' : '全选'}
              </button>
            </div>
          </div>

          {selectedCount > 0 && (
            <aside
              className={styles.batchBar}
              aria-label="已选视频的批量操作"
              aria-busy={batchExtracting}
            >
              <div className={styles.batchCount} aria-live="polite" aria-atomic="true">
                <span className={styles.batchCountIcon} aria-hidden="true">
                  <CheckSquare2 size={18} />
                </span>
                <span className={styles.batchCountCopy}>
                  <strong>已选 {selectedCount} 条</strong>
                  <small>跨平台视频</small>
                </span>
              </div>
              <div className={styles.batchActions} role="group" aria-label="已选视频操作">
                <button
                  type="button"
                  onClick={extractStructuredSelected}
                  disabled={batchExtracting || selectedItems.length === 0}
                  aria-label={`提取已选 ${selectedItems.length} 条视频的结构化文案`}
                >
                  {activeBatchOperation === 'full'
                    ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    : <NotebookPen size={15} aria-hidden="true" />}
                  {activeBatchOperation === 'full'
                    ? '正在提取结构化文案'
                    : `提取结构化文案 · ${selectedItems.length}`}
                </button>
                <button
                  type="button"
                  data-primary="true"
                  onClick={openSelectedInAgent}
                  disabled={batchExtracting}
                  aria-label={`带已选 ${selectedCount} 条视频去提问`}
                >
                  {activeBatchOperation === 'transcript'
                    ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    : <MessageSquareText size={17} aria-hidden="true" />}
                  {activeBatchOperation === 'transcript'
                    ? '正在准备资料'
                    : `去提问 · ${selectedCount}`}
                </button>
                <button
                  type="button"
                  className={styles.batchDirectRemoval}
                  data-danger="true"
                  onClick={() => openRemovalDialog(selectedItems)}
                  disabled={selectedItems.length === 0 || removalPending || batchExtracting || refreshing}
                  aria-label={`移出视频资料，${selectedItems.length} 条抖音视频`}
                >
                  <CircleMinus size={15} aria-hidden="true" />
                  移出视频资料 · {selectedItems.length}
                </button>
                <button
                  type="button"
                  className={styles.batchDirectRemoval}
                  data-danger="true"
                  onClick={() => openRemovalDialog(selectedItems, 'permanent')}
                  disabled={selectedItems.length === 0 || removalPending || batchExtracting || refreshing}
                  aria-label={`永久隐藏，${selectedItems.length} 条抖音视频`}
                >
                  <EyeOff size={15} aria-hidden="true" />
                  永久隐藏 · {selectedItems.length}
                </button>
                <details className={styles.batchMore}>
                  <summary aria-label="更多批量操作">
                    <MoreHorizontal size={17} aria-hidden="true" />
                  </summary>
                  <div>
                    <VideoAnalysisBatchAction
                      noteIds={selectedAnalysisNoteIds}
                      selectedCount={selectedCount}
                      unsupportedCount={selectedAnalysisUnsupported}
                      disabled={batchExtracting || refreshing}
                      onStarted={(cachedOnly) => {
                        setSelected(new Set());
                        setSelectedPlatform(new Set());
                        setNotice(cachedOnly
                          ? '已复用现有详细解析结果，未消耗萃点'
                          : '详细解析已进入后台，可继续浏览视频资料');
                      }}
                    />
                    <button
                      type="button"
                      className={styles.batchCompactRemoval}
                      data-danger="true"
                      onClick={() => openRemovalDialog(selectedItems)}
                      disabled={selectedItems.length === 0 || removalPending || batchExtracting || refreshing}
                      aria-label={`移出视频资料，${selectedItems.length} 条抖音视频`}
                    >
                      <CircleMinus size={15} aria-hidden="true" />
                      移出视频资料 · {selectedItems.length}
                    </button>
                    <button
                      type="button"
                      className={styles.batchCompactRemoval}
                      data-danger="true"
                      onClick={() => openRemovalDialog(selectedItems, 'permanent')}
                      disabled={selectedItems.length === 0 || removalPending || batchExtracting || refreshing}
                      aria-label={`永久隐藏，${selectedItems.length} 条抖音视频`}
                    >
                      <EyeOff size={15} aria-hidden="true" />
                      永久隐藏 · {selectedItems.length}
                    </button>
                    {selectedItems.length === 1
                      && selectedItems[0].extracted
                      && selectedItems[0].extracted_note_id && (
                      <button
                        type="button"
                        data-danger="true"
                        onClick={() => openDeletionDialog(selectedItems[0])}
                        disabled={batchExtracting || Boolean(deletingNoteId)}
                      >
                        <Trash2 size={15} />
                        删除文案与摘要
                      </button>
                    )}
                  </div>
                </details>
                <button
                  type="button"
                  className={styles.batchClose}
                  onClick={() => {
                    setSelected(new Set());
                    setSelectedPlatform(new Set());
                  }}
                  disabled={batchExtracting}
                  aria-label="取消选择"
                  title="取消选择"
                >
                  <X size={16} />
                </button>
              </div>
            </aside>
          )}

          {notice && (
            <div className="library-notice" role="status">
              <Info size={14} />
              {notice}
            </div>
          )}
          {batchExtracting && extractionJob && (
            <LibraryExtractionLiveProgress job={extractionJob} items={items} />
          )}
          <VideoAnalysisBatchProgress />

          <section
            className={styles.listSurface}
            aria-label={layoutMode === 'grid' ? '视频资料网格' : '视频资料列表'}
          >
            {search && (
              <div className={styles.listSummary}>
                <span>找到 {visibleItemCount.toLocaleString('zh-CN')} 条</span>
              </div>
            )}

            {visibleListLoading ? (
              <div className="library-loading">
                <LoaderCircle size={22} className="animate-spin" />
                <strong>
                  {platformFilter === 'douyin'
                    ? `正在读取${sourceLabel}`
                    : platformFilter === 'bilibili'
                      ? '正在读取 B站视频'
                      : platformFilter === 'xiaohongshu'
                        ? '正在读取小红书视频'
                        : '正在读取视频资料'}
                </strong>
              </div>
            ) : visibleItemCount === 0 && visibleListError ? (
              <div className="library-empty-state">
                <ServerOff size={28} />
                <h2>暂时无法读取视频资料</h2>
                <p>{friendlyLibraryError(visibleListError)}</p>
                {showDouyinItems && error && (
                  <button type="button" onClick={() => void loadLibrary()}>
                    <RefreshCw size={15} />
                    重新读取抖音
                  </button>
                )}
                {showPlatformItems && platformFilter !== 'all' && platformLibraryState.error && (
                  <button
                    type="button"
                    onClick={() => setPlatformPanelVersion((version) => version + 1)}
                  >
                    <RefreshCw size={15} />
                    重新读取 B站与小红书
                  </button>
                )}
              </div>
            ) : visibleItemCount === 0 ? (
              <div className="library-empty-state">
                {libraryOverview.permanentHidden > 0 && !search && platformFilter === 'douyin'
                  ? <EyeOff size={28} />
                  : <FileText size={28} />}
                <h2>
                  {search
                    ? '没有匹配的视频'
                    : platformFilter === 'douyin'
                      ? libraryOverview.sourceTotal > 0 && libraryOverview.permanentHidden > 0
                        ? '同步的视频都在“已永久隐藏”中'
                        : `还没有同步${sourceLabel}`
                      : platformFilter === 'bilibili'
                        ? '还没有 B站视频资料'
                        : platformFilter === 'xiaohongshu'
                          ? '还没有小红书视频资料'
                    : '还没有视频资料'}
                </h2>
                <p>
                  {search
                    ? '换个关键词或平台试试。'
                    : platformFilter === 'douyin'
                      ? loggedIn
                        ? `同步${sourceLabel}后会显示在这里。`
                        : '登录抖音后即可同步视频。'
                      : platformFilter === 'bilibili' || platformFilter === 'xiaohongshu'
                        ? '连接账号或导入视频链接。'
                        : '同步视频后会显示在这里。'}
                </p>
                {!search && platformFilter === 'douyin' && libraryOverview.permanentHidden > 0 && (
                  <button type="button" onClick={openHiddenManager}>
                    <EyeOff size={15} />
                    查看已永久隐藏
                  </button>
                )}
                {!search && !(platformFilter === 'douyin' && libraryOverview.permanentHidden > 0) && (
                  <button type="button" onClick={openSourceManager}>
                    <Plus size={15} />
                    同步视频
                  </button>
                )}
              </div>
            ) : (
              <>
                <p id="library-marquee-help" className="sr-only">
                  桌面端可用鼠标拖动框选抖音视频；按住 Ctrl 或 Command 拖动可追加选择。
                </p>
                <div
                ref={librarySelectionSurfaceRef}
                className={styles.unifiedList}
                data-layout={layoutMode}
                role="group"
                aria-label="视频资料列表"
                aria-describedby="library-marquee-help"
                {...libraryMarquee.surfaceProps}
              >
                {showDouyinItems && loading && (
                  <div className={styles.inlineLoading} role="status">
                    <LoaderCircle size={16} className="animate-spin" />
                    正在读取抖音视频…
                  </div>
                )}
                {showDouyinItems && error && (
                  <div className={styles.inlineError} role="alert">
                    <ServerOff size={15} />
                    抖音列表暂时不可用：{friendlyLibraryError(error)}
                  </div>
                )}
                {showPlatformItems && platformLibraryState.loading && (
                  <div className={styles.inlineLoading} role="status">
                    <LoaderCircle size={16} className="animate-spin" />
                    正在读取 B站和小红书资料…
                  </div>
                )}
                {showPlatformItems && platformLibraryState.error && (
                  <div className={styles.inlineError} role="alert">
                    <ServerOff size={15} />
                    <span>跨平台资料暂时不可用：{platformLibraryState.error}</span>
                    <button
                      type="button"
                      className={styles.inlineRetry}
                      onClick={() => setPlatformPanelVersion((version) => version + 1)}
                    >
                      <RefreshCw size={14} />
                      重试
                    </button>
                  </div>
                )}
                {showDouyinItems && filteredItems.length > 0 && (
                  <div className="library-video-grid">
                    {filteredItems.map((item, index) => (
                      <LibraryVideoCard
                        key={item.aweme_id}
                        item={item}
                        selected={displayedSelection.has(item.aweme_id)}
                        extractState={extractProgress[item.aweme_id]?.state}
                        extractError={extractProgress[item.aweme_id]?.error}
                        onToggle={toggleSelection}
                        selectionDisabled={batchExtracting}
                        onRefreshCover={refreshDouyinCover}
                        coverPriority={index < 6}
                      />
                    ))}
                  </div>
                )}
                {filteredPlatformItems.map((item, index) => (
                  <CrossPlatformLibraryRow
                    key={item.id}
                    item={item}
                    active={previewSelection?.kind === 'platform' && previewSelection.item.id === item.id}
                    initializing={initializingPlatformId === item.id}
                    busy={Boolean(initializingPlatformId)}
                    actionError={platformActionErrors[item.id]}
                    layout={layoutMode}
                    selected={selectedPlatform.has(item.id)}
                    selectionDisabled={batchExtracting}
                    onActivate={(target) => setPreviewTarget({
                      platform: target.platform,
                      id: target.id,
                    })}
                    onInitialize={initializePlatformSummary}
                    onToggleSelection={togglePlatformSelection}
                    onRefreshCover={refreshPlatformCover}
                    coverPriority={index < (layoutMode === 'grid' ? 6 : 2)}
                  />
                ))}
                </div>
              </>
            )}
          </section>
        </section>

        <div className={styles.previewColumn}>
          {previewSelection ? (
            <LibraryPreviewPane
              selection={previewSelection}
              onRefreshCover={refreshPreviewCover}
            />
          ) : (
            <aside className={styles.emptyPreview} aria-label="当前资料预览">
              <FileText size={24} />
              <strong>选择一条资料</strong>
            </aside>
          )}
        </div>
      </div>

      <MarqueeSelectionOverlay rect={libraryMarquee.marqueeRect} />
    </div>
  );
}
