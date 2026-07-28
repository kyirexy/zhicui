'use client';

import { App } from '@capacitor/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowRight,
  Bookmark,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  CircleMinus,
  Download,
  EyeOff,
  ExternalLink,
  FileText,
  Heart,
  LoaderCircle,
  LogOut,
  QrCode,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Search,
  ServerOff,
  SlidersHorizontal,
  Sparkles,
  Square,
  UserRound,
  X,
} from 'lucide-react';
import ContentModeSwitch from '@/components/ContentModeSwitch';
import LibraryChat, { type LibraryChatSource } from '@/components/LibraryChat';
import LibraryExtractionLiveProgress from '@/components/LibraryExtractionLiveProgress';
import LibraryVideoCard, {
  type LibraryExtractState,
} from '@/components/LibraryVideoCard';
import {
  cancelDouyinLogin,
  collectDouyinLibrary,
  createDouyinLocalHandoff,
  deleteDouyinLibraryExtraction,
  disconnectDouyinLibrary,
  getDouyinBatchExtraction,
  getDouyinCollectionJob,
  getDouyinLibraryStatus,
  getDouyinLoginQr,
  getDouyinLoginStatus,
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
import { formatCollectionSyncMessage } from '@/lib/douyinSyncFeedback';
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
} from '@/lib/types';

interface ExtractProgress {
  state: LibraryExtractState;
  error?: string;
}

interface LibraryRemovalTarget {
  awemeIds: string[];
  title?: string;
  mode: 'temporary' | 'permanent';
}

const MAX_SELECTION = 50;
const MAX_SYNC_COUNT = 100;
const ALL_LIBRARY_ITEMS = 0;
const SYNC_COUNT_OPTIONS = [50, 100] as const;
const QR_AUTO_RECOVERY_ATTEMPTS = 15;
type DouyinSessionAction = 'logout' | 'rebind';
type BindingClient = 'desktop-web' | 'mobile-web' | 'android-app';
const SOURCE_MODES: Array<{
  value: DouyinSourceMode;
  label: string;
  description: string;
  Icon: typeof Heart;
}> = [
  {
    value: 'like',
    label: '喜欢',
    description: '点过红心的作品',
    Icon: Heart,
  },
  {
    value: 'collect',
    label: '收藏',
    description: '全部收藏，包含未分组',
    Icon: Bookmark,
  },
  {
    value: 'post',
    label: '我的作品',
    description: '当前账号发布的视频',
    Icon: UserRound,
  },
];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export default function VideoLibraryPage() {
  const [status, setStatus] = useState<DouyinLibraryStatus | null>(null);
  const [collectionJob, setCollectionJob] = useState<DouyinCollectionJob | null>(null);
  const [sourceMode, setSourceMode] = useState<DouyinSourceMode>('collect');
  const [collectionSort, setCollectionSort] = useState<DouyinLibrarySort>('collection');
  const [syncCount, setSyncCount] = useState(50);
  const [items, setItems] = useState<DouyinLibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extractProgress, setExtractProgress] = useState<Record<string, ExtractProgress>>({});
  const [search, setSearch] = useState('');
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
  const [aiWorkspaceOpen, setAiWorkspaceOpen] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<'idle' | 'collect' | 'extract' | 'done'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRef = useRef(true);
  const loginPollRef = useRef(0);
  const sessionDialogRef = useRef<HTMLDialogElement | null>(null);
  const removalDialogRef = useRef<HTMLDialogElement | null>(null);
  const hiddenManagerDialogRef = useRef<HTMLDialogElement | null>(null);
  const aiLauncherRef = useRef<HTMLButtonElement | null>(null);
  const aiCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreAiLauncherFocusRef = useRef(false);
  const activeSort: DouyinLibrarySort = sourceMode === 'collect'
    ? collectionSort
    : 'published';

  const loadItems = useCallback(async (
    silent = false,
  ): Promise<DouyinLibraryListResult | null> => {
    if (!silent) setLoading(true);
    const response = await listDouyinLibraryItems(
      ALL_LIBRARY_ITEMS,
      sourceMode,
      activeSort,
    );
    if (response.success && response.data) {
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
    if (!silent) {
      setError(response.error || '无法读取视频来源');
      setLoading(false);
    }
    return null;
  }, [activeSort, sourceMode]);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    const [statusResponse, itemsResponse] = await Promise.all([
      getDouyinLibraryStatus(),
      listDouyinLibraryItems(ALL_LIBRARY_ITEMS, sourceMode, activeSort),
    ]);
    if (statusResponse.success && statusResponse.data) {
      setStatus(statusResponse.data);
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
    activeRef.current = true;
    setSelected(new Set());
    void loadLibrary();
    return () => {
      activeRef.current = false;
    };
  }, [loadLibrary]);

  useEffect(() => {
    if (isNativeAndroidApp()) {
      setBindingClient('android-app');
      return;
    }
    const mobileBrowser = (
      window.matchMedia('(max-width: 767px)').matches
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
    setBindingClient(mobileBrowser ? 'mobile-web' : 'desktop-web');
  }, []);

  const closeAiWorkspace = useCallback(() => {
    restoreAiLauncherFocusRef.current = true;
    setAiWorkspaceOpen(false);
  }, []);

  useEffect(() => {
    if (!aiWorkspaceOpen) {
      if (restoreAiLauncherFocusRef.current) {
        restoreAiLauncherFocusRef.current = false;
        aiLauncherRef.current?.focus();
      }
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const isCompactViewport = window.matchMedia('(max-width: 1023px)').matches;
    if (isCompactViewport) document.body.style.overflow = 'hidden';

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAiWorkspace();
    };
    window.addEventListener('keydown', closeOnEscape);
    window.requestAnimationFrame(() => aiCloseRef.current?.focus());

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      if (isCompactViewport) document.body.style.overflow = previousOverflow;
    };
  }, [aiWorkspaceOpen, closeAiWorkspace]);

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

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.aweme_id)),
    [items, selected],
  );
  const selectedChatSources = useMemo<LibraryChatSource[]>(
    () => selectedItems.flatMap((item) => (
      item.extracted && item.extracted_note_id
        ? [{
            noteId: item.extracted_note_id,
            title: item.title,
            transcriptChars: item.transcript_chars,
          }]
        : []
    )),
    [selectedItems],
  );
  const allChatSources = useMemo<LibraryChatSource[]>(
    () => items.flatMap((item) => (
      item.extracted && item.extracted_note_id
        ? [{
            noteId: item.extracted_note_id,
            title: item.title,
            transcriptChars: item.transcript_chars,
          }]
        : []
    )).slice(0, MAX_SELECTION),
    [items],
  );
  const pendingTranscriptSelected = selectedItems.filter(
    (item) => !item.extracted && item.can_extract,
  );
  const pendingAiSelected = selectedItems.filter(
    (item) => item.extracted && !item.ai_initialized,
  );
  const extractedCount = items.filter((item) => item.extracted).length;
  const connected = Boolean(status?.connected);
  const loggedIn = Boolean(status?.cookie_valid);
  const loginBrowserMode = status?.login_browser_mode || 'unavailable';
  const localBrowserAvailable = (
    bindingClient === 'desktop-web'
    && loginBrowserMode === 'visible_chrome'
  );
  const sourceLabel = SOURCE_MODES.find((mode) => mode.value === sourceMode)?.label || '视频';

  const toggleSelection = (awemeId: string) => {
    setNotice('');
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(awemeId)) {
        next.delete(awemeId);
        return next;
      }
      if (next.size >= MAX_SELECTION) {
        setNotice(`研究 Agent 一次最多扫描 ${MAX_SELECTION} 条视频`);
        return current;
      }
      next.add(awemeId);
      return next;
    });
  };

  const selectVisible = () => {
    setSelected((current) => {
      const visibleIds = filteredItems
        .slice(0, MAX_SELECTION)
        .map((item) => item.aweme_id);
      const allVisibleSelected = visibleIds.every((id) => current.has(id));
      return allVisibleSelected ? new Set() : new Set(visibleIds);
    });
  };

  const applyExtractionJob = (job: DouyinBatchExtractionJob) => {
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
  };

  const waitForExtractionJob = async (
    initial: DouyinBatchExtractionJob,
  ): Promise<DouyinBatchExtractionJob> => {
    let current = initial;
    applyExtractionJob(current);
    for (let attempt = 0; attempt < 2400 && activeRef.current; attempt += 1) {
      if (current.status !== 'running') return current;
      setNotice(
        current.operation === 'transcript'
          ? `并发提取 ${current.total} 条完整文案：正在转写 ${current.active} 条，等待 ${current.queued} 条，已完成 ${current.success} 条`
          : `AI 初始化 ${current.total} 条：正在分析 ${current.active} 条，等待 ${current.queued} 条，已完成 ${current.success} 条`,
      );
      await wait(800);
      const response = await getDouyinBatchExtraction(current.job_id);
      if (!response.success || !response.data) continue;
      current = response.data;
      applyExtractionJob(current);
      if (current.status !== 'running') return current;
    }
    return current;
  };

  const extractItems = async (
    targets: DouyinLibraryItem[],
    operation: DouyinBatchExtractionOperation,
  ): Promise<number> => {
    const pending = targets.filter((item) => {
      if (!item.can_extract) return false;
      if (operation === 'transcript') return !item.extracted;
      if (operation === 'ai') return item.extracted && !item.ai_initialized;
      return !item.ai_initialized;
    });
    if (pending.length === 0) return 0;
    setBatchExtracting(true);
    setActiveBatchOperation(operation);
    setExtractionJob(null);
    setPipelineStage('extract');
    setExtractProgress((current) => {
      const next = { ...current };
      pending.forEach((item) => {
        next[item.aweme_id] = { state: 'queued' };
      });
      return next;
    });

    setNotice(
      operation === 'transcript'
        ? `正在同时启动 ${pending.length} 条视频的完整文案提取`
        : `正在同时启动 ${pending.length} 条视频的 AI 总结与知识卡`,
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
      setBatchExtracting(false);
      setActiveBatchOperation(null);
      setNotice(response.error || (
        operation === 'transcript'
          ? '批量文案任务启动失败'
          : '批量 AI 初始化任务启动失败'
      ));
      return 0;
    }

    const finalJob = await waitForExtractionJob(response.data);
    setBatchExtracting(false);
    setActiveBatchOperation(null);
    if (finalJob.status === 'running') {
      setNotice('批量任务仍在后台运行，刷新页面后可查看已完成的文案');
    }
    return finalJob.success;
  };

  const transcribeSelected = async () => {
    if (pendingTranscriptSelected.length === 0 || batchExtracting) return;
    const succeeded = await extractItems(
      pendingTranscriptSelected,
      'transcript',
    );
    setPipelineStage('done');
    setNotice(`完整文案完成：${succeeded}/${pendingTranscriptSelected.length} 条成功，现在可以直接问 AI`);
  };

  const initializeSelectedAi = async () => {
    if (pendingAiSelected.length === 0 || batchExtracting) return;
    const succeeded = await extractItems(pendingAiSelected, 'ai');
    setPipelineStage('done');
    setNotice(`AI 总结与知识卡完成：${succeeded}/${pendingAiSelected.length} 条成功`);
  };

  const refreshLoginStatus = useCallback(async (): Promise<DouyinLibraryStatus | null> => {
    const response = await getDouyinLibraryStatus();
    if (response.success && response.data) {
      setStatus(response.data);
      return response.data;
    }
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

  const copyDesktopBindingLink = async () => {
    try {
      await navigator.clipboard.writeText('https://luxai.cn/library');
      setQrActionMessage('电脑端地址已复制：请发送到电脑，并使用当前知萃账号登录。');
    } catch {
      setQrActionMessage('电脑端请访问 https://luxai.cn/library，并使用当前知萃账号登录。');
    }
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

  const beginLocalHandoff = async () => {
    const connectorWindow = window.open(
      'about:blank',
      'zhicui-douyin-connector',
      'popup=yes,width=720,height=640',
    );
    if (!connectorWindow) {
      setScanning(false);
      setQrPanelOpen(false);
      setLoginStatusMessage('浏览器阻止了登录窗口');
      setQrActionMessage('');
      setNotice('请允许浏览器打开登录窗口，然后重新点击“扫码登录抖音”');
      return;
    }
    connectorWindow.document.title = '正在打开抖音登录';
    connectorWindow.document.body.textContent = '正在打开抖音登录，请稍候…';

    setScanning(true);
    setQrPanelOpen(false);
    setLoginQr('');
    setQrActionMessage('');
    setBrowserOpened(false);
    setBrowserMode('local_handoff');
    setQrFallbackVisible(false);
    setLoginStatusMessage('正在打开 Chrome…');
    setNotice('正在打开 Chrome，请稍候…');

    const handoff = await createDouyinLocalHandoff();
    if (!handoff.success || !handoff.data) {
      connectorWindow.close();
      setScanning(false);
      setLoginStatusMessage('登录窗口打开失败');
      setQrActionMessage('');
      setNotice(handoff.error || '登录窗口打开失败，请重试');
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
    const connectorUrl = new URL(handoff.data.connector_url);
    connectorUrl.searchParams.set('token', handoff.data.token);
    connectorUrl.searchParams.set('callback', callbackUrl);
    connectorWindow.location.replace(connectorUrl.toString());

    const pollId = loginPollRef.current + 1;
    loginPollRef.current = pollId;
    setLoginStatusMessage('等待扫码确认…');
    setNotice('请在弹出的 Chrome 中使用手机抖音扫码');

    for (
      let attempt = 0;
      attempt < 180 && activeRef.current && loginPollRef.current === pollId;
      attempt += 1
    ) {
      await wait(2000);
      const latest = await refreshLoginStatus();
      if (latest?.cookie_valid) {
        loginPollRef.current += 1;
        setScanning(false);
        setQrPanelOpen(false);
        setLoginStatusMessage('');
        setQrActionMessage('');
        setBrowserMode('idle');
        setNotice('抖音登录成功，现在可以同步视频');
        await loadItems(true);
        return;
      }
    }
    if (loginPollRef.current !== pollId) return;
    setScanning(false);
    setLoginStatusMessage('尚未收到登录结果');
    setQrActionMessage('');
    setNotice('登录等待超时，请确认手机端已点击“确认登录”后重试');
  };

  const startQrLogin = async () => {
    if (!connected || scanning) return;
    if (bindingClient !== 'desktop-web') {
      loginPollRef.current += 1;
      setScanning(false);
      setQrPanelOpen(true);
      setLoginQr('');
      setQrActionMessage('');
      setBrowserOpened(false);
      setBrowserMode('idle');
      setQrFallbackVisible(false);
      setQrActionMessage('');
      setLoginStatusMessage('请在电脑端扫码登录抖音');
      setNotice('请在电脑端登录同一个知萃账号，再扫码登录抖音');
      return;
    }
    if (!localBrowserAvailable) {
      await beginLocalHandoff();
      return;
    }
    await beginDesktopQrLogin();
  };

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
    setNotice(action === 'rebind' ? '原抖音账号已退出，请扫码绑定新账号' : '已退出抖音，资料库内容仍会保留');
    await refreshLoginStatus();
    if (action === 'rebind') await startQrLogin();
  };

  const waitForCollectionJob = async (
    initial: DouyinCollectionJob,
    requestedCount: number,
  ): Promise<DouyinCollectionJob | null> => {
    setCollectionJob(initial);
    for (let attempt = 0; attempt < 600 && activeRef.current; attempt += 1) {
      await wait(2000);
      const response = await getDouyinCollectionJob(initial.job_id);
      if (!response.success || !response.data) continue;
      setCollectionJob(response.data);
      setNotice(formatCollectionSyncMessage({
        ...response.data,
        sourceLabel,
        requestedCount,
      }));
      if (response.data.status === 'success' || response.data.status === 'failed') {
        return response.data;
      }
    }
    return null;
  };

  const syncCollection = async () => {
    if (refreshing || batchExtracting || !loggedIn) return;
    const requestedCount = clampInteger(syncCount, 1, MAX_SYNC_COUNT);
    setSyncCount(requestedCount);
    setRefreshing(true);
    setExtractionJob(null);
    setPipelineStage('collect');
    setNotice(`开始同步最近 ${requestedCount} 条${sourceLabel}；同步后自动提取完整文案，不生成 AI 总结`);
    const response = await collectDouyinLibrary(requestedCount, sourceMode);
    if (!response.success || !response.data) {
      setRefreshing(false);
      setPipelineStage('idle');
      setNotice(response.error || `${sourceLabel}采集任务启动失败`);
      return;
    }

    const finalJob = await waitForCollectionJob(response.data, requestedCount);
    setRefreshing(false);
    if (!finalJob || finalJob.status === 'failed') {
      setPipelineStage('idle');
      setNotice(
        finalJob
          ? formatCollectionSyncMessage({
              ...finalJob,
              sourceLabel,
              requestedCount,
            })
          : '同步没有完成，请稍后重试',
      );
      return;
    }
    setNotice(formatCollectionSyncMessage({
      ...finalJob,
      sourceLabel,
      requestedCount,
    }));
    if (
      Math.max(0, Number(finalJob.total) || 0) === 0
      && Math.max(0, Number(finalJob.success) || 0) === 0
    ) {
      setPipelineStage('done');
      return;
    }

    const refreshedResult = await loadItems(true);
    const refreshed = refreshedResult?.items || [];
    setSelected(new Set());
    const transcriptTargets = refreshed
      .slice(0, requestedCount)
      .filter((item) => item.can_extract && !item.extracted);
    if (transcriptTargets.length === 0) {
      setPipelineStage('done');
      const permanentHidden = refreshedResult?.permanent_hidden_total || 0;
      const sourceTotal = refreshedResult?.source_total || finalJob.success || 0;
      if (refreshed.length === 0 && sourceTotal > 0 && permanentHidden > 0) {
        setNotice(
          `已同步 ${sourceTotal} 条${sourceLabel}，其中 ${permanentHidden} 条在“已永久隐藏”中；可以打开并恢复`,
        );
      } else {
        const restoredCopy = finalJob.temporary_restored
          ? `，${finalJob.temporary_restored} 条之前移出的视频已重新显示`
          : '';
        setNotice(
          `同步完成：资料库现有 ${refreshed.length} 条${sourceLabel}${restoredCopy}，本次范围内的完整文案均已就绪`,
        );
      }
      return;
    }

    const succeeded = await extractItems(transcriptTargets, 'transcript');
    setPipelineStage('done');
    setNotice(`同步与文案提取完成：${succeeded}/${transcriptTargets.length} 条成功。已有文案可直接问 AI；知识卡按需生成`);
  };

  const deleteExtraction = async (item: DouyinLibraryItem) => {
    const noteId = item.extracted_note_id;
    if (!noteId || deletingNoteId) return;
    setDeletingNoteId(noteId);
    const response = await deleteDouyinLibraryExtraction(noteId);
    setDeletingNoteId(null);
    if (!response.success || !response.data) {
      setNotice(response.error || '删除知识结果失败');
      return;
    }

    setItems((current) => current.map((currentItem) => (
      currentItem.aweme_id === item.aweme_id
        ? {
            ...currentItem,
            extracted: false,
            extracted_note_id: null,
            transcript_chars: 0,
            card_type: null,
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
    setNotice('已删除这条文案、知识卡和关联计划；抖音原视频不会受影响');
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
      setRemovalError(response.error || '暂时无法从资料库移除，请稍后重试');
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
    <div className={`video-library-page ${aiWorkspaceOpen ? 'is-ai-open' : ''}`}>
      <div className="library-ambient" aria-hidden="true" />

      <div className="library-compact-toolbar">
        <ContentModeSwitch />
        <div className="library-status-strip">
          <div className="library-status-copy">
            <span className={`library-status-dot ${connected ? 'is-online' : ''}`} />
            <strong>{connected ? '抖音服务正常' : '抖音服务暂不可用'}</strong>
            <span>
              {connected
                ? `${loggedIn ? '抖音已登录' : '等待扫码登录'} · ${items.length} 条${sourceLabel} · ${extractedCount} 条已有文案`
                : '抖音登录服务暂不可用，请稍后重试'}
            </span>
          </div>
          {loggedIn ? (
            <div className="library-login-actions">
              <span className="library-login-state">
                <CheckCircle2 size={15} />
                抖音已登录
              </span>
              <button
                type="button"
                className="library-session-button"
                onClick={() => openSessionDialog('rebind')}
                disabled={refreshing || batchExtracting || sessionPending}
              >
                <Repeat2 size={15} />
                换绑账号
              </button>
              <button
                type="button"
                className="library-session-button is-danger"
                onClick={() => openSessionDialog('logout')}
                disabled={refreshing || batchExtracting || sessionPending}
              >
                <LogOut size={15} />
                退出抖音
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startQrLogin}
              disabled={!connected || scanning}
              className="library-sync-button"
            >
              {scanning ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <QrCode size={15} />
              )}
              {scanning
                ? '正在登录'
                : bindingClient === 'desktop-web'
                  ? '扫码登录抖音'
                  : '去电脑端绑定'}
            </button>
          )}
        </div>
      </div>

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
                ? '会先安全退出当前账号，再立即打开新的扫码登录。已有文案、知识卡和计划不会删除。'
                : '只会清除当前抖音登录状态；已有文案、知识卡、计划和资料库记录都会保留。'}
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
                  ? '把这条视频移出资料库？'
                  : `移出所选 ${removalTarget?.awemeIds.length || 0} 条视频？`}
            </h2>
            <p id="library-removal-dialog-description">
              {removalTarget?.mode === 'permanent'
                ? '以后同步也不会再显示这些视频，除非你从“已永久隐藏”中恢复。不会取消抖音收藏，也不会删除已有文案、知识卡和计划。'
                : '只从当前资料库移出，下次同步时会重新出现。不会取消抖音收藏，也不会删除已有文案、知识卡和计划。'}
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
            <p>这些视频不会在同步后自动出现，但抖音收藏、已有文案、知识卡和计划都还在。</p>
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
                <span>普通“移出资料库”的视频会在下次同步时重新出现。</span>
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

      {qrPanelOpen && bindingClient !== 'desktop-web' && (
        <section className="library-qr-card" aria-live="polite" aria-label="抖音扫码登录">
          <div className="library-qr-heading">
            <div>
              <span className="library-qr-kicker">
                <QrCode size={15} />
                登录抖音
              </span>
              <h2>请在电脑端扫码登录抖音</h2>
              <p>登录信息会按知萃账号独立保存，不会与其他用户混用。</p>
            </div>
            <button type="button" onClick={closeQrLogin} aria-label="关闭扫码登录">
              <X size={18} />
            </button>
          </div>
          <div className="library-qr-body">
            <div className="library-qr-frame">
              <div className="library-browser-login is-open">
                <ExternalLink size={30} aria-hidden="true" />
                <strong>需要一台电脑</strong>
                <span>在电脑打开知萃视频库，登录同一个账号后点击“扫码登录抖音”。</span>
              </div>
            </div>
            <div className="library-qr-guide">
              <p
                className={`library-qr-capability is-${bindingClient}`}
                role={bindingClient === 'mobile-web' ? 'note' : undefined}
              >
                {bindingClient === 'android-app' && '手机端暂不直接发起抖音登录，请在电脑端完成一次扫码。'}
                {bindingClient === 'mobile-web' && '手机浏览器暂不直接发起抖音登录，请在电脑端使用同一个知萃账号完成一次扫码。'}
              </p>
              <ol>
                <li>在电脑打开 https://luxai.cn/library</li>
                <li>登录与当前 App 完全相同的知萃账号</li>
                <li>点击“扫码登录抖音”，在弹出的 Chrome 中扫码确认</li>
                <li>回到 App，系统会自动检查登录结果</li>
              </ol>
              <div className="library-qr-actions">
                <button
                  type="button"
                  onClick={() => void copyDesktopBindingLink()}
                >
                  <Download size={17} />
                  复制电脑端地址
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void checkDesktopBinding()}
                  disabled={bindingCheckPending}
                >
                  {bindingCheckPending
                    ? <LoaderCircle size={17} className="animate-spin" />
                    : <RefreshCw size={17} />}
                  检查登录结果
                </button>
              </div>
              {qrActionMessage && (
                <p className="library-qr-action-message" role="status">
                  {qrActionMessage}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {!connected && status && (
        <div className="library-offline-note">
          <ServerOff size={17} />
          <div>
            <strong>抖音视频库暂时无法连接</strong>
            <p>请稍后重试；单条链接提取仍可正常使用。</p>
          </div>
        </div>
      )}

      <section className="library-source-panel" aria-label="选择抖音内容来源">
        <div className="library-source-main">
          <div className="library-source-modes">
            {SOURCE_MODES.map(({ value, label, description, Icon }) => (
              <button
                type="button"
                key={value}
                className={sourceMode === value ? 'is-active' : ''}
                onClick={() => setSourceMode(value)}
              >
                <Icon size={16} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="library-pipeline-action">
            <button
              type="button"
              onClick={syncCollection}
              disabled={!connected || !loggedIn || refreshing || batchExtracting}
              className="library-pipeline-button"
            >
              {refreshing || batchExtracting ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              {pipelineStage === 'collect'
                ? '正在从抖音同步'
                : pipelineStage === 'extract'
                  ? activeBatchOperation === 'ai'
                    ? '正在生成 AI 总结'
                    : '正在提取完整文案'
                  : `从抖音同步${sourceLabel}`}
            </button>
            <small>同步最近 {syncCount} 条并自动提取文案，不自动生成 AI 总结</small>
          </div>
        </div>

        <section className="library-processing-settings" aria-labelledby="library-processing-title">
          <div className="library-processing-heading">
            <span id="library-processing-title">
              <SlidersHorizontal size={14} />
              同步设置
            </span>
            <small>完整文案自动提取 · AI 总结按需生成</small>
          </div>
          <div className="library-advanced-body">
            <div className="library-auto-controls">
              <div className="library-count-control is-sync-count">
                <span>同步范围</span>
                <div className="library-sync-count-inputs">
                  <span className="library-count-options" aria-label="选择同步数量">
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
                  </span>
                  <label className="library-custom-count">
                    <span className="sr-only">自定义同步数量，1 到 100 条</span>
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
        </section>

        {sourceMode === 'collect' && (
          <p className="library-mode-warning">
            每次只同步最近 {syncCount} 条收藏，最多可选 100 条，不会一次搬走整个收藏夹。同步后会自动整理出完整文案，你可以直接提问；知识卡想用时再生成。视频不会保存到知萃服务器。
          </p>
        )}
        {collectionJob && (refreshing || batchExtracting) && (
          <div className="library-pipeline-progress">
            <span style={{
              width: `${Math.min(100, Math.max(
                8,
                collectionJob.total > 0
                  ? (collectionJob.success / collectionJob.total) * 100
                  : pipelineStage === 'extract' ? 72 : 22,
              ))}%`,
            }} />
          </div>
        )}
      </section>

      <div className="library-toolbar">
        <label className="library-search">
          <Search size={16} />
          <span className="sr-only">搜索视频</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`搜索${sourceLabel}的标题、作者或标签`}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="清空搜索">
              <X size={14} />
            </button>
          )}
        </label>

        <div className="library-selection-actions">
          {sourceMode === 'collect' ? (
            <label className="library-sort-picker">
              <ArrowDownWideNarrow size={14} />
              <span className="library-sort-picker-value" aria-hidden="true">
                {collectionSort === 'collection' ? '最近收藏' : '发布时间'}
              </span>
              <select
                aria-label="视频排序"
                value={collectionSort}
                onChange={(event) => {
                  setCollectionSort(event.target.value as DouyinLibrarySort);
                  setSelected(new Set());
                }}
              >
                <option value="collection">最近收藏</option>
                <option value="published">发布时间</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          ) : (
            <span className="library-sort-state">
              <ArrowDownWideNarrow size={14} />
              发布时间 · 新到旧
            </span>
          )}
          <button
            type="button"
            className="library-hidden-manager-button"
            onClick={openHiddenManager}
            aria-label={`管理已永久隐藏的 ${libraryOverview.permanentHidden} 条视频`}
          >
            <EyeOff size={15} />
            已永久隐藏
            <span>{libraryOverview.permanentHidden}</span>
          </button>
          <button
            type="button"
            className="library-text-action"
            onClick={selectVisible}
            disabled={filteredItems.length === 0}
          >
            {selected.size > 0 ? <CheckSquare2 size={15} /> : <Square size={15} />}
            全选当前
          </button>
          {selected.size > 0 && (
            <>
              <span className="library-selected-count">已选 {selected.size}</span>
              <button
                type="button"
                className="is-danger"
                onClick={() => openRemovalDialog(selectedItems)}
                disabled={removalPending || batchExtracting || refreshing}
              >
                <CircleMinus size={15} />
                批量移出
              </button>
              <button
                type="button"
                className="is-danger is-permanent"
                onClick={() => openRemovalDialog(selectedItems, 'permanent')}
                disabled={removalPending || batchExtracting || refreshing}
              >
                <EyeOff size={15} />
                永久隐藏
              </button>
              <button
                type="button"
                className="library-text-action"
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </button>
            </>
          )}
          {pendingTranscriptSelected.length > 0 && (
            <button
              type="button"
              className="is-primary"
              onClick={transcribeSelected}
              disabled={batchExtracting}
            >
              {batchExtracting ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <FileText size={15} />
              )}
              补提完整文案 · {pendingTranscriptSelected.length}
            </button>
          )}
          {pendingAiSelected.length > 0 && (
            <button
              type="button"
              className="is-primary"
              onClick={initializeSelectedAi}
              disabled={batchExtracting}
            >
              {batchExtracting ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              AI 总结与知识卡 · {pendingAiSelected.length}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="library-notice" role="status">
          <Sparkles size={14} />
          {notice}
        </div>
      )}

      {batchExtracting && extractionJob && (
        <LibraryExtractionLiveProgress
          job={extractionJob}
          items={items}
        />
      )}

      {!aiWorkspaceOpen && (
        <button
          ref={aiLauncherRef}
          type="button"
          className="library-ai-launcher"
          aria-expanded="false"
          aria-controls="library-ai-workspace"
          onClick={() => setAiWorkspaceOpen(true)}
        >
          <span className="library-ai-launcher-mark" aria-hidden="true">
            <Sparkles size={19} />
          </span>
          <span className="library-ai-launcher-copy">
            <strong>向视频问 AI</strong>
            <small>
              {allChatSources.length > 0
                ? `无需知识卡，已准备 ${allChatSources.length} 条完整文案；也可只问勾选视频`
                : selectedItems.length > 0
                  ? '所选视频的文案仍在提取，可稍后直接提问'
                  : '同步后会自动提取完整文案，文案就绪即可提问'}
            </small>
          </span>
          <span className="library-ai-launcher-action">
            打开问答
            <ArrowRight size={16} />
          </span>
        </button>
      )}

      <div className={`library-workspace ${aiWorkspaceOpen ? 'is-ai-open' : ''}`}>
        <section className="library-grid-region" aria-label={`${sourceLabel}视频列表`}>
          {loading ? (
            <div className="library-loading">
              <LoaderCircle size={22} className="animate-spin" />
              <strong>正在读取{sourceLabel}</strong>
              <span>正在整理视频列表…</span>
            </div>
          ) : error ? (
            <div className="library-empty-state">
              <ServerOff size={28} />
              <h2>暂时无法读取视频库</h2>
              <p>{error}</p>
              <button type="button" onClick={() => void loadLibrary()}>
                <RefreshCw size={15} />
                重新连接
              </button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="library-empty-state">
              {libraryOverview.permanentHidden > 0 && !search
                ? <EyeOff size={28} />
                : <FileText size={28} />}
              <h2>
                {search
                  ? '没有匹配的视频'
                  : libraryOverview.sourceTotal > 0 && libraryOverview.permanentHidden > 0
                    ? '同步的视频都在“已永久隐藏”中'
                    : `还没有同步${sourceLabel}`}
              </h2>
              <p>
                {search
                  ? '换个关键词试试。'
                  : libraryOverview.sourceTotal > 0 && libraryOverview.permanentHidden > 0
                    ? `已同步 ${libraryOverview.sourceTotal} 条${sourceLabel}，你可以打开列表选择恢复。`
                  : loggedIn
                    ? `点击“从抖音同步${sourceLabel}”更新清单并自动提取完整文案。`
                    : '先扫码登录抖音，再开始采集。'}
              </p>
              {!search && libraryOverview.permanentHidden > 0 && (
                <button type="button" onClick={openHiddenManager}>
                  <EyeOff size={15} />
                  查看已永久隐藏
                </button>
              )}
            </div>
          ) : (
            <div className="library-video-grid">
              {filteredItems.map((item) => (
                <LibraryVideoCard
                  key={item.aweme_id}
                  item={item}
                  selected={selected.has(item.aweme_id)}
                  extractState={extractProgress[item.aweme_id]?.state}
                  extractError={extractProgress[item.aweme_id]?.error}
                  deleting={deletingNoteId === item.extracted_note_id}
                  removing={Boolean(
                    removalPending
                    && removalTarget?.awemeIds.includes(item.aweme_id)
                  )}
                  onToggle={toggleSelection}
                  onDelete={(target) => void deleteExtraction(target)}
                  onRemove={(target) => openRemovalDialog([target])}
                  onHidePermanently={(target) => openRemovalDialog([target], 'permanent')}
                />
              ))}
            </div>
          )}
        </section>

        <aside
          id="library-ai-workspace"
          className="library-chat-region"
          aria-label="视频 AI 问答工作台"
          hidden={!aiWorkspaceOpen}
        >
          <button
            ref={aiCloseRef}
            type="button"
            className="library-ai-close"
            onClick={closeAiWorkspace}
            aria-label="关闭 AI 问答工作台"
            title="关闭问答工作台（Esc）"
          >
            <X size={17} />
          </button>
          <LibraryChat
            allSources={allChatSources}
            selectedSources={selectedChatSources}
            selectedCount={selectedItems.length}
          />
        </aside>
      </div>
    </div>
  );
}
