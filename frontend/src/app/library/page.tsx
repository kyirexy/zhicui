'use client';

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
  FileText,
  Grid3X3,
  Heart,
  LoaderCircle,
  LogOut,
  QrCode,
  RefreshCw,
  Repeat2,
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
import LibraryVideoCard, {
  type LibraryExtractState,
} from '@/components/LibraryVideoCard';
import {
  collectDouyinLibrary,
  deleteDouyinLibraryExtraction,
  disconnectDouyinLibrary,
  extractDouyinLibraryItem,
  getDouyinCollectionJob,
  getDouyinLibraryStatus,
  getDouyinLoginQr,
  getDouyinLoginStatus,
  listDouyinLibraryItems,
  removeDouyinLibraryItems,
  startDouyinLogin,
} from '@/lib/api';
import type {
  DouyinCollectionJob,
  DouyinLibraryItem,
  DouyinLibrarySort,
  DouyinLibraryStatus,
  DouyinSourceMode,
} from '@/lib/types';

interface ExtractProgress {
  state: LibraryExtractState;
  error?: string;
}

interface LibraryRemovalTarget {
  awemeIds: string[];
  title?: string;
}

const MAX_SELECTION = 50;
const MAX_SYNC_COUNT = 100;
const ALL_LIBRARY_ITEMS = 0;
const SYNC_COUNT_OPTIONS = [50, 100] as const;
type DouyinSessionAction = 'logout' | 'rebind';
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
  const [processCount, setProcessCount] = useState(20);
  const [autoProcess, setAutoProcess] = useState(true);
  const [items, setItems] = useState<DouyinLibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extractProgress, setExtractProgress] = useState<Record<string, ExtractProgress>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [loginQr, setLoginQr] = useState('');
  const [qrPanelOpen, setQrPanelOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [batchExtracting, setBatchExtracting] = useState(false);
  const [sessionAction, setSessionAction] = useState<DouyinSessionAction | null>(null);
  const [sessionPending, setSessionPending] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [removalTarget, setRemovalTarget] = useState<LibraryRemovalTarget | null>(null);
  const [removalPending, setRemovalPending] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [aiWorkspaceOpen, setAiWorkspaceOpen] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<'idle' | 'collect' | 'extract' | 'done'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRef = useRef(true);
  const loginPollRef = useRef(0);
  const sessionDialogRef = useRef<HTMLDialogElement | null>(null);
  const removalDialogRef = useRef<HTMLDialogElement | null>(null);
  const aiLauncherRef = useRef<HTMLButtonElement | null>(null);
  const aiCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreAiLauncherFocusRef = useRef(false);
  const activeSort: DouyinLibrarySort = sourceMode === 'collect'
    ? collectionSort
    : 'published';

  const loadItems = useCallback(async (silent = false): Promise<DouyinLibraryItem[]> => {
    if (!silent) setLoading(true);
    const response = await listDouyinLibraryItems(
      ALL_LIBRARY_ITEMS,
      sourceMode,
      activeSort,
    );
    if (response.success && response.data) {
      setItems(response.data.items);
      setError('');
      if (!silent) setLoading(false);
      return response.data.items;
    }
    if (!silent) {
      setError(response.error || '无法读取视频来源');
      setLoading(false);
    }
    return [];
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
  const pendingSelected = selectedItems.filter(
    (item) => !item.extracted && item.can_extract,
  );
  const extractedCount = items.filter((item) => item.extracted).length;
  const connected = Boolean(status?.connected);
  const loggedIn = Boolean(status?.cookie_valid);
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

  const runExtraction = async (item: DouyinLibraryItem): Promise<boolean> => {
    setExtractProgress((current) => ({
      ...current,
      [item.aweme_id]: { state: 'extracting' },
    }));
    const response = await extractDouyinLibraryItem(item.aweme_id);
    if (!response.success || !response.data) {
      setExtractProgress((current) => ({
        ...current,
        [item.aweme_id]: {
          state: 'error',
          error: response.error || '提取失败',
        },
      }));
      return false;
    }

    setItems((current) => current.map((currentItem) => (
      currentItem.aweme_id === item.aweme_id
        ? {
            ...currentItem,
            extracted: true,
            extracted_note_id: response.data!.id || null,
            transcript_chars: response.data!.transcript_chars || 0,
            card_type: response.data!.card_type,
          }
        : currentItem
    )));
    setExtractProgress((current) => ({
      ...current,
      [item.aweme_id]: { state: 'done' },
    }));
    return true;
  };

  const extractItems = async (targets: DouyinLibraryItem[]): Promise<number> => {
    const pending = targets.filter((item) => !item.extracted && item.can_extract);
    if (pending.length === 0) return 0;
    setBatchExtracting(true);
    setPipelineStage('extract');
    setExtractProgress((current) => {
      const next = { ...current };
      pending.forEach((item) => {
        next[item.aweme_id] = { state: 'queued' };
      });
      return next;
    });

    let succeeded = 0;
    for (let index = 0; index < pending.length; index += 1) {
      if (!activeRef.current) break;
      setNotice(
        `自动流水线：正在提取第 ${index + 1}/${pending.length} 条完整文案并生成 AI 卡片`,
      );
      if (await runExtraction(pending[index])) succeeded += 1;
    }
    setBatchExtracting(false);
    return succeeded;
  };

  const extractSelected = async () => {
    if (pendingSelected.length === 0 || batchExtracting) return;
    const succeeded = await extractItems(pendingSelected);
    setPipelineStage('done');
    setNotice(`文案与总结完成：${succeeded}/${pendingSelected.length} 条成功`);
  };

  const refreshLoginStatus = async () => {
    const response = await getDouyinLibraryStatus();
    if (response.success && response.data) setStatus(response.data);
  };

  const closeQrLogin = () => {
    loginPollRef.current += 1;
    setScanning(false);
    setQrPanelOpen(false);
    setLoginQr('');
  };

  const startQrLogin = async () => {
    if (!connected || scanning) return;
    const pollId = loginPollRef.current + 1;
    loginPollRef.current = pollId;
    setScanning(true);
    setQrPanelOpen(true);
    setLoginQr('');
    setNotice('正在生成抖音登录二维码…');
    const start = await startDouyinLogin();
    if (!start.success) {
      setScanning(false);
      setNotice(start.error || '扫码登录启动失败');
      return;
    }
    let currentQrVersion = 0;
    for (
      let attempt = 0;
      attempt < 300 && activeRef.current && loginPollRef.current === pollId;
      attempt += 1
    ) {
      await wait(2000);
      const response = await getDouyinLoginStatus();
      if (!response.success || !response.data) continue;
      setNotice(response.data.message || '等待你使用抖音 App 扫码…');
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
        }
      }
      if (!response.data.running) {
        setScanning(false);
        setQrPanelOpen(false);
        setLoginQr('');
        await refreshLoginStatus();
        setNotice(
          response.data.error
            ? `扫码登录失败：${response.data.error}`
            : '抖音登录成功，现在可以选择来源并开始自动处理',
        );
        return;
      }
    }
    if (loginPollRef.current !== pollId) return;
    setScanning(false);
    setNotice('扫码登录等待超时，可以重新发起');
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
      setNotice(
        response.data.status === 'running'
          ? response.data.total > 0
            ? `自动流水线：正在同步${sourceLabel}，已处理 ${response.data.success}/${response.data.total}`
            : `自动流水线：正在同步最近 ${requestedCount} 条${sourceLabel}，已保存 ${response.data.success} 条`
          : `采集任务：${response.data.status}`,
      );
      if (response.data.status === 'success' || response.data.status === 'failed') {
        return response.data;
      }
    }
    return null;
  };

  const syncCollection = async () => {
    if (refreshing || batchExtracting || !loggedIn) return;
    const requestedCount = clampInteger(syncCount, 1, MAX_SYNC_COUNT);
    const requestedProcessCount = clampInteger(processCount, 0, requestedCount);
    setSyncCount(requestedCount);
    setProcessCount(requestedProcessCount);
    setRefreshing(true);
    setPipelineStage('collect');
    setNotice(`自动流水线：开始同步最近 ${requestedCount} 条${sourceLabel}`);
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
      setNotice(finalJob?.error || '采集没有完成，请稍后重试');
      return;
    }

    const refreshed = await loadItems(true);
    const targets = refreshed
      .filter((item) => item.can_extract)
      .slice(0, requestedProcessCount);
    setSelected(new Set(
      targets.slice(0, MAX_SELECTION).map((item) => item.aweme_id),
    ));
    if (!autoProcess || requestedProcessCount === 0) {
      setPipelineStage('done');
      setNotice(`同步完成：资料库现有 ${refreshed.length} 条${sourceLabel}，未运行 AI 处理`);
      return;
    }

    const pendingTargets = targets.filter((item) => !item.extracted);
    const succeeded = await extractItems(pendingTargets);
    setPipelineStage('done');
    setNotice(
      pendingTargets.length > 0
        ? `自动流水线完成：资料库现有 ${refreshed.length} 条${sourceLabel}，新增文案与 AI 总结 ${succeeded}/${pendingTargets.length} 条`
        : `自动流水线完成：资料库现有 ${refreshed.length} 条${sourceLabel}；最近 ${targets.length} 条文案均已存在`,
    );
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
    setNotice('已删除这条文案、知识卡和关联计划；原视频仍在下载器中');
  };

  const openRemovalDialog = (targetItems: DouyinLibraryItem[]) => {
    if (removalPending || targetItems.length === 0) return;
    const boundedItems = targetItems.slice(0, MAX_SELECTION);
    setRemovalTarget({
      awemeIds: boundedItems.map((item) => item.aweme_id),
      title: boundedItems.length === 1 ? boundedItems[0].title : undefined,
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
    const response = await removeDouyinLibraryItems(removalTarget.awemeIds);
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
    setRemovalPending(false);
    removalDialogRef.current?.close();
    setRemovalTarget(null);
    setNotice(
      `已从资料库移除 ${removedIds.size} 条视频；不会取消抖音收藏，已有文案和计划仍保留`,
    );
  };

  return (
    <div className={`video-library-page ${aiWorkspaceOpen ? 'is-ai-open' : ''}`}>
      <div className="library-ambient" aria-hidden="true" />

      <header className="library-page-header">
        <div>
          <span className="library-eyebrow">
            <Grid3X3 size={14} />
            视频资料库
          </span>
          <h1>把想看的视频，变成真正能用的知识</h1>
          <p>选择来源，同步后自动生成完整文案与知识卡；需要时再向整组视频提问。</p>
        </div>
        <ContentModeSwitch />
      </header>

      <div className="library-status-strip">
        <div className="library-status-copy">
          <span className={`library-status-dot ${connected ? 'is-online' : ''}`} />
          <strong>{connected ? '下载器已连接' : '下载器未连接'}</strong>
          <span>
            {connected
              ? `${loggedIn ? '抖音已登录' : '等待扫码登录'} · ${items.length} 条${sourceLabel} · ${extractedCount} 条已有文案`
              : '请先在本机启动 douyin-downloader :9000'}
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
            {scanning ? '等待扫码' : '扫码登录抖音'}
          </button>
        )}
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
          <div className="library-session-dialog-icon" aria-hidden="true">
            <CircleMinus size={20} />
          </div>
          <div>
            <h2 id="library-removal-dialog-title">
              {removalTarget?.awemeIds.length === 1
                ? '把这条视频移出资料库？'
                : `移出所选 ${removalTarget?.awemeIds.length || 0} 条视频？`}
            </h2>
            <p id="library-removal-dialog-description">
              只会改变你在知萃中的资料库视图，后续同步也不会再次显示。
              不会取消抖音收藏，也不会删除已有文案、知识卡和计划。
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
              className="is-primary"
              onClick={confirmRemoval}
              disabled={removalPending}
            >
              {removalPending && <LoaderCircle size={15} className="animate-spin" />}
              确认移出
            </button>
          </div>
        </div>
      </dialog>

      {qrPanelOpen && (
        <section className="library-qr-card" aria-live="polite" aria-label="抖音扫码登录">
          <div className="library-qr-heading">
            <div>
              <span className="library-qr-kicker">
                <QrCode size={15} />
                扫码连接收藏夹
              </span>
              <h2>使用抖音 App 扫码登录</h2>
              <p>二维码只在当前登录过程中显示，登录凭据不会发送给浏览器。</p>
            </div>
            <button type="button" onClick={closeQrLogin} aria-label="关闭扫码登录">
              <X size={18} />
            </button>
          </div>
          <div className="library-qr-body">
            <div className="library-qr-frame">
              {loginQr ? (
                <img src={loginQr} alt="抖音登录二维码" />
              ) : (
                <div className="library-qr-loading">
                  <LoaderCircle size={28} className="animate-spin" />
                  <span>正在安全获取二维码…</span>
                </div>
              )}
            </div>
            <ol>
              <li>打开抖音 App，点击右上角扫一扫</li>
              <li>扫描左侧二维码，并在手机上确认登录</li>
              <li>连接成功后，选择“收藏”并同步需要的数量</li>
            </ol>
          </div>
        </section>
      )}

      {!connected && status && (
        <div className="library-offline-note">
          <ServerOff size={17} />
          <div>
            <strong>批量视频库需要本机下载器</strong>
            <p>{status.error || '连接 http://127.0.0.1:9000 失败。单条链接提取仍可正常使用。'}</p>
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
                  ? '正在生成文案'
                  : `从抖音同步${sourceLabel}`}
            </button>
            <small>
              {autoProcess
                ? `同步最近 ${syncCount} 条；自动处理 ${processCount} 条`
                : `同步最近 ${syncCount} 条；不运行 AI 处理`}
            </small>
          </div>
        </div>

        <section className="library-processing-settings" aria-labelledby="library-processing-title">
          <div className="library-processing-heading">
            <span id="library-processing-title">
              <SlidersHorizontal size={14} />
              处理设置
            </span>
            <small>同步 {syncCount} 条 · {autoProcess ? `处理 ${processCount} 条` : '不运行 AI'}</small>
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
                        onClick={() => {
                          setSyncCount(count);
                          setProcessCount((current) => Math.min(current, count));
                        }}
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
                        setProcessCount((current) => Math.min(current, nextCount));
                      }}
                    />
                    <small>条</small>
                  </label>
                </div>
              </div>
              <label className="library-count-control">
                <span>自动处理数量</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={syncCount}
                  value={processCount}
                  onChange={(event) => setProcessCount(
                    clampInteger(Number(event.target.value), 0, syncCount),
                  )}
                />
              </label>
              <label className="library-auto-toggle">
                <input
                  type="checkbox"
                  checked={autoProcess}
                  onChange={(event) => setAutoProcess(event.target.checked)}
                />
                <span>
                  <strong>同步后生成文案与知识卡</strong>
                  <small>处理数量不会超过本次同步数量</small>
                </span>
              </label>
            </div>
          </div>
        </section>

        {sourceMode === 'collect' && (
          <p className="library-mode-warning">
            这里读取抖音默认“全部收藏”，但只同步你选择的最近 {syncCount} 条，单次最多 100 条，不会拉取全部收藏。服务器不保存视频文件，仅保存必要元数据、文案与 AI 结果；处理时临时拉流并在结束后立即清理。
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
              <span className="sr-only">视频排序</span>
              <select
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
                className="library-text-action"
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </button>
            </>
          )}
          {pendingSelected.length > 0 && (
            <button
              type="button"
              className="is-primary"
              onClick={extractSelected}
              disabled={batchExtracting}
            >
              {batchExtracting ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              生成文案 {pendingSelected.length}
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
                ? `无需勾选，已准备 ${allChatSources.length} 条完整文案；也可只问勾选视频`
                : selectedItems.length > 0
                  ? '所选视频还需要先生成文案，也可以打开工作台查看'
                  : '生成文案后，无需勾选即可向当前视频库提问'}
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
              <span>连接下载器并整理本地作品清单…</span>
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
              <FileText size={28} />
              <h2>{search ? '没有匹配的视频' : `还没有同步${sourceLabel}`}</h2>
              <p>
                {search
                  ? '换个关键词试试。'
                  : loggedIn
                    ? `点击“从抖音同步${sourceLabel}”，拉取视频并生成文案与知识卡。`
                    : '先扫码登录抖音，再开始采集。'}
              </p>
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
