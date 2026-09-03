'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderSync,
  ListRestart,
  LoaderCircle,
  MessageCircleQuestion,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import AuthGuard from '@/components/AuthGuard';
import {
  cancelCreatorSyncRun,
  createCreatorSyncRun,
  deleteCreatorSource,
  listCreatorSourceItems,
  listCreatorSources,
  listCreatorSyncRunItems,
  resolveCreatorSource,
  retryCreatorSyncRun,
  saveCreatorSource,
} from '@/lib/api';
import { useCreatorSync } from '@/lib/hooks/CreatorSyncContext';
import type {
  CreatorCatalogItemStatus,
  CreatorPaginatedResult,
  CreatorSource,
  CreatorSourceCatalog,
  CreatorSourceItem,
  CreatorSourcePlatform,
  CreatorSourcePreview,
  CreatorSyncOperation,
  CreatorSyncRun,
  CreatorSyncRunItem,
} from '@/lib/types';
import styles from './CreatorLibrary.module.css';

const PAGE_SIZE = 50;
const MAX_SELECTION = 50;
const HARNESS_MAX_SOURCES = 100;
const RECENT_LIMITS = [20, 50, 100] as const;
const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

const EMPTY_PAGE: CreatorPaginatedResult<CreatorSourceItem> = {
  items: [],
  page: 1,
  per_page: PAGE_SIZE,
  total: 0,
  total_pages: 0,
};

function platformLabel(platform: CreatorSourcePlatform): string {
  if (platform === 'douyin') return '抖音';
  if (platform === 'bilibili') return 'B站';
  return '小红书';
}

function operationLabel(operation: CreatorSyncOperation): string {
  if (operation === 'catalog_all') return '刷新全部清单';
  if (operation === 'selected_transcript') return '准备已选文稿';
  return '准备近期文稿';
}

function isWaitingRetry(run: CreatorSyncRun): boolean {
  return run.status === 'retry_wait'
    || (run.status === 'queued' && Boolean(run.next_retry_at));
}

function runStatusLabel(run: CreatorSyncRun): string {
  if (run.needs_action?.required) return '需要处理';
  if (run.status === 'succeeded') return '已完成';
  if (run.status === 'partial') return '部分完成';
  if (run.status === 'failed') return '失败';
  if (run.status === 'cancelled') return '已取消';
  if (isWaitingRetry(run)) return '等待重试';
  return '运行中';
}

function runProgress(run: CreatorSyncRun): string {
  if (run.needs_action?.required) return run.needs_action.message || '请处理平台验证后重试';
  if (run.operation === 'catalog_all') {
    if (!run.discovery_complete && !TERMINAL_STATUSES.has(run.status)) {
      return `正在发现全部公开作品 · 已发现 ${run.discovered_count || 0} 条`;
    }
    return `已发现 ${run.total_count ?? run.discovered_count ?? 0} 条公开作品`;
  }
  const target = run.target_count || run.requested_limit;
  return `已处理 ${run.processed_count || run.checked_count}/${target} · 新增 ${run.new_count} · 复用 ${run.reused_count} · 失败 ${run.failed_count}`;
}

function itemStatus(item: CreatorSourceItem): string {
  return item.transcript_status || item.status || 'untranscribed';
}

function itemStatusLabel(item: CreatorSourceItem): string {
  const status = itemStatus(item);
  if (!item.is_available || item.availability_status === 'unavailable') return '已不可用';
  if (status === 'imported') return '已入库';
  if (status === 'failed') return '失败';
  if (status === 'removed') return '已移除';
  return '未转写';
}

function isSelectable(item: CreatorSourceItem): boolean {
  const status = itemStatus(item);
  return item.is_available !== false
    && item.availability_status !== 'removed'
    && status !== 'imported'
    && status !== 'removed'
    && item.can_transcribe !== false;
}

function formatPublishedAt(value?: string | null): string {
  if (!value) return '发布时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '发布时间未知';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDuration(value?: number | null): string {
  const seconds = Math.max(0, Math.trunc(value || 0));
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function showModal(dialog: HTMLDialogElement | null): void {
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement | null): void {
  if (dialog?.open) dialog.close();
}

interface CatalogItemRowProps {
  item: CreatorSourceItem;
  selected: boolean;
  creatorName: string;
  onToggle: (item: CreatorSourceItem) => void;
}

const CatalogItemRow = memo(function CatalogItemRow({
  item,
  selected,
  creatorName,
  onToggle,
}: CatalogItemRowProps) {
  const selectable = isSelectable(item);
  const duration = formatDuration(item.duration_seconds);
  return (
    <article data-selected={selected} data-unavailable={!item.is_available}>
      <label className={styles.itemCheck}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!selectable}
          onChange={() => onToggle(item)}
          aria-label={`选择 ${item.title || '作品'}`}
        />
        <span aria-hidden="true">{selected ? <Check size={13} /> : null}</span>
      </label>
      <div className={styles.cover}>
        <LibraryCoverImage
          src={item.cover_url}
          fallbackClassName={styles.coverFallback}
          retryable={false}
        />
        {duration ? <small>{duration}</small> : null}
      </div>
      <div className={styles.itemCopy}>
        <span data-status={itemStatus(item)}>{itemStatusLabel(item)}</span>
        <h3 title={item.title}>{item.title || '未命名作品'}</h3>
        <p>
          {item.author_name || creatorName} · {formatPublishedAt(item.published_at)}
          {item.parts && item.parts.length > 1 ? ` · ${item.parts.length}P` : ''}
        </p>
      </div>
      {item.note_id ? (
        <Link href={`/notes?id=${encodeURIComponent(item.note_id)}`}>查看文稿</Link>
      ) : (
        <a href={item.source_url} target="_blank" rel="noreferrer">原作品</a>
      )}
    </article>
  );
});

function CreatorLibraryWorkspace() {
  const {
    activeRuns,
    recentRuns,
    lastUpdatedAt,
    refreshAll,
    trackRun,
  } = useCreatorSync();
  const [catalog, setCatalog] = useState<CreatorSourceCatalog | null>(null);
  const [sources, setSources] = useState<CreatorSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [itemsPage, setItemsPage] = useState(EMPTY_PAGE);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CreatorCatalogItemStatus>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [addPlatform, setAddPlatform] = useState<CreatorSourcePlatform>('douyin');
  const [profileRef, setProfileRef] = useState('');
  const [preview, setPreview] = useState<CreatorSourcePreview | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CreatorSource | null>(null);
  const [detailRun, setDetailRun] = useState<CreatorSyncRun | null>(null);
  const [detailItems, setDetailItems] = useState<CreatorSyncRunItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const removeDialogRef = useRef<HTMLDialogElement | null>(null);
  const taskDialogRef = useRef<HTMLDialogElement | null>(null);
  const catalogRequestRef = useRef(0);
  const incomingProfileHandledRef = useRef(false);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) || null,
    [selectedSourceId, sources],
  );
  const userActiveRun = activeRuns[0] || null;
  const sourceActiveRun = useMemo(
    () => activeRuns.find((run) => run.source_id === selectedSourceId) || null,
    [activeRuns, selectedSourceId],
  );
  const sourceRuns = useMemo(
    () => recentRuns.filter((run) => run.source_id === selectedSourceId).slice(0, 8),
    [recentRuns, selectedSourceId],
  );
  const selectedCount = selectedIds.size;
  const visibleSelectable = itemsPage.items.filter(isSelectable);
  const allVisibleSelected = visibleSelectable.length > 0
    && visibleSelectable.every((item) => selectedIds.has(item.id));
  const selectedPlatformEnabled = Boolean(
    catalog?.enabled
    && selectedSource
    && catalog.platforms[selectedSource.platform] !== false,
  );
  const selectedCatalogEnabled = Boolean(
    selectedPlatformEnabled
    && selectedSource?.platform !== 'xiaohongshu'
    && catalog?.catalog_operations?.catalog_all?.[selectedSource?.platform || 'douyin'] !== false,
  );
  const addPlatformEnabled = Boolean(
    catalog?.enabled && catalog.platforms[addPlatform] !== false,
  );

  const loadSources = useCallback(async (preferredId?: string) => {
    setLoadingSources(true);
    const response = await listCreatorSources();
    setLoadingSources(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法读取已保存博主');
      return;
    }
    setCatalog(response.data.catalog);
    setSources(response.data.items);
    setSelectedSourceId((current) => {
      const target = preferredId || current;
      return response.data?.items.some((item) => item.id === target)
        ? target
        : response.data?.items[0]?.id || '';
    });
  }, []);

  const loadItems = useCallback(async (signal?: AbortSignal) => {
    if (!selectedSourceId) {
      setItemsPage(EMPTY_PAGE);
      return;
    }
    const requestId = catalogRequestRef.current + 1;
    catalogRequestRef.current = requestId;
    setLoadingItems(true);
    const response = await listCreatorSourceItems(selectedSourceId, {
      page,
      perPage: PAGE_SIZE,
      search: debouncedSearch,
      status: statusFilter,
    }, signal);
    if (requestId !== catalogRequestRef.current || signal?.aborted) return;
    setLoadingItems(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法读取作品清单');
      return;
    }
    setItemsPage(response.data);
  }, [debouncedSearch, page, selectedSourceId, statusFilter]);

  useEffect(() => {
    void loadSources();
    void refreshAll();
  }, [loadSources, refreshAll]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    void loadItems(controller.signal);
    return () => controller.abort();
  }, [lastUpdatedAt, loadItems]);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
    setNotice('');
    setError('');
  }, [selectedSourceId]);

  useEffect(() => {
    const detailRunId = detailRun?.id;
    if (!detailRunId) return;
    const latest = activeRuns.find((run) => run.id === detailRunId)
      || recentRuns.find((run) => run.id === detailRunId);
    if (latest) setDetailRun(latest);
  }, [activeRuns, detailRun?.id, recentRuns]);

  const inspectSource = async () => {
    if (!profileRef.trim() || pendingAction) return;
    setPendingAction('resolve');
    setError('');
    const response = await resolveCreatorSource(addPlatform, profileRef);
    setPendingAction('');
    if (!response.success || !response.data) {
      setError(response.error || '没有识别到有效博主主页');
      return;
    }
    setPreview(response.data);
  };

  useEffect(() => {
    if (incomingProfileHandledRef.current) return;
    const currentUrl = new URL(window.location.href);
    const incomingProfile = currentUrl.searchParams.get('profile')?.trim();
    const incomingPlatform = currentUrl.searchParams.get('platform');
    if (!incomingProfile || !['douyin', 'bilibili', 'xiaohongshu'].includes(incomingPlatform || '')) return;

    incomingProfileHandledRef.current = true;
    const platform = incomingPlatform as CreatorSourcePlatform;
    setAddPlatform(platform);
    setProfileRef(incomingProfile);
    setPendingAction('resolve');
    setError('');
    currentUrl.searchParams.delete('profile');
    currentUrl.searchParams.delete('platform');
    window.history.replaceState(window.history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);

    void resolveCreatorSource(platform, incomingProfile).then((response) => {
      setPendingAction('');
      if (!response.success || !response.data) {
        setError(response.error || '没有识别到有效博主主页');
        return;
      }
      setPreview(response.data);
    });
  }, []);

  const saveSource = async () => {
    if (!preview || pendingAction) return;
    setPendingAction('save');
    const response = await saveCreatorSource(preview.platform, preview.profile_url);
    setPendingAction('');
    if (!response.success || !response.data) {
      setError(response.error || '保存博主失败');
      return;
    }
    setPreview(null);
    setProfileRef('');
    await loadSources(response.data.item.id);
    setNotice(response.data.reused ? '这个博主已恢复到来源列表' : '博主已保存');
  };

  const askAllCreatorVideos = async () => {
    if (!selectedSource || pendingAction) return;
    setPendingAction('ask_creator');
    setError('');
    setNotice('');

    const firstPage = await listCreatorSourceItems(selectedSource.id, {
      page: 1,
      perPage: PAGE_SIZE,
      status: 'imported',
    });
    if (!firstPage.success || !firstPage.data) {
      setPendingAction('');
      setError(firstPage.error || '暂时无法读取这个博主已入库的视频');
      return;
    }
    if (firstPage.data.total === 0) {
      setPendingAction('');
      setError('这个博主还没有可提问的文稿，请先准备近期文稿或勾选作品转写。');
      return;
    }
    if (firstPage.data.total > HARNESS_MAX_SOURCES) {
      setPendingAction('');
      setError(`这个博主已有 ${firstPage.data.total} 条可提问视频，知萃 AI 单次最多选择 ${HARNESS_MAX_SOURCES} 条。`);
      return;
    }

    const remainingPages = Array.from(
      { length: Math.max(0, firstPage.data.total_pages - 1) },
      (_, index) => index + 2,
    );
    const remainingResponses = await Promise.all(
      remainingPages.map((pageNumber) => listCreatorSourceItems(selectedSource.id, {
        page: pageNumber,
        perPage: PAGE_SIZE,
        status: 'imported',
      })),
    );
    const failedPage = remainingResponses.find((response) => !response.success || !response.data);
    if (failedPage) {
      setPendingAction('');
      setError(failedPage.error || '读取博主全部视频时中断了，请重试');
      return;
    }

    const noteIds = [
      ...firstPage.data.items,
      ...remainingResponses.flatMap((response) => response.data?.items || []),
    ].flatMap((item) => item.note_id ? [item.note_id] : []);
    const uniqueNoteIds = [...new Set(noteIds)];
    setPendingAction('');
    if (!uniqueNoteIds.length) {
      setError('这个博主还没有可提问的完整文稿。');
      return;
    }
    window.location.assign(
      `/harness?source_ids=${encodeURIComponent(uniqueNoteIds.join(','))}`,
    );
  };

  const startRun = async (
    operation: CreatorSyncOperation,
    limit?: 20 | 50 | 100,
    itemIds?: string[],
  ) => {
    if (!selectedSource || pendingAction || userActiveRun) return;
    setPendingAction(operation);
    setError('');
    const response = await createCreatorSyncRun(selectedSource.id, {
      operation,
      ...(limit ? { limit } : {}),
      ...(itemIds ? { item_ids: itemIds } : {}),
    });
    setPendingAction('');
    if (!response.success || !response.data) {
      setError(response.error || '后台任务没有启动');
      return;
    }
    trackRun(response.data.run);
    setNotice(
      operation === 'catalog_all'
        ? '正在后台刷新全部公开作品，切换页面不会中断'
        : `正在后台准备 ${response.data.run.target_count || limit || itemIds?.length || 0} 条普通文稿`,
    );
    if (operation === 'selected_transcript') setSelectedIds(new Set());
  };

  const cancelRun = async (run: CreatorSyncRun) => {
    setPendingAction(`cancel:${run.id}`);
    const response = await cancelCreatorSyncRun(run.id);
    setPendingAction('');
    if (!response.success) {
      setError(response.error || '取消任务失败');
      return;
    }
    await refreshAll();
    setNotice('已请求取消，已经入库的文稿会保留');
  };

  const retryRun = async (run: CreatorSyncRun) => {
    if (userActiveRun && userActiveRun.id !== run.id) {
      setError('另一个博主任务正在运行，请等待完成或先取消');
      return;
    }
    setPendingAction(`retry:${run.id}`);
    const response = await retryCreatorSyncRun(run.id);
    setPendingAction('');
    if (!response.success || !response.data) {
      setError(response.error || '重试任务没有启动');
      return;
    }
    trackRun(response.data.run);
    setDetailRun(response.data.run);
    setNotice('失败项目已重新进入后台队列');
  };

  const requestRemove = () => {
    if (!selectedSource) return;
    setRemoveTarget(selectedSource);
    window.requestAnimationFrame(() => showModal(removeDialogRef.current));
  };

  const confirmRemove = async () => {
    if (!removeTarget || pendingAction) return;
    setPendingAction('remove');
    const response = await deleteCreatorSource(removeTarget.id);
    setPendingAction('');
    if (!response.success) {
      setError(response.error || '移除失败；若任务仍在运行，请先取消');
      closeDialog(removeDialogRef.current);
      return;
    }
    closeDialog(removeDialogRef.current);
    setRemoveTarget(null);
    await loadSources();
    setNotice('博主来源已移除，已经入库的视频文稿保持不变');
  };

  const openRunDetail = async (run: CreatorSyncRun) => {
    setDetailRun(run);
    setDetailItems([]);
    setDetailLoading(true);
    window.requestAnimationFrame(() => showModal(taskDialogRef.current));
    const response = await listCreatorSyncRunItems(run.id, { page: 1, perPage: 50 });
    setDetailLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法读取任务明细');
      return;
    }
    setDetailItems(response.data.items);
  };

  const toggleItem = useCallback((item: CreatorSourceItem) => {
    if (!isSelectable(item)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else if (next.size < MAX_SELECTION) {
        next.add(item.id);
      } else {
        setNotice('一次最多选择 50 条作品准备文稿');
      }
      return next;
    });
  }, []);

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleSelectable.forEach((item) => next.delete(item.id));
        return next;
      }
      for (const item of visibleSelectable) {
        if (next.size >= MAX_SELECTION) break;
        next.add(item.id);
      }
      if (visibleSelectable.length + current.size > MAX_SELECTION) {
        setNotice('已选择前 50 条可转写作品');
      }
      return next;
    });
  };

  return (
    <main className={styles.page}>
      <dialog
        ref={removeDialogRef}
        className={styles.dialog}
        aria-modal="true"
        aria-labelledby="remove-creator-title"
        onCancel={(event) => {
          if (pendingAction === 'remove') event.preventDefault();
        }}
        onClose={() => setRemoveTarget(null)}
      >
        <div className={styles.dialogCard}>
          <span className={styles.dialogIcon} data-danger="true"><Trash2 size={20} /></span>
          <div>
            <h2 id="remove-creator-title">移除“{removeTarget?.display_name || '该博主'}”？</h2>
            <p>纯元数据清单将不再显示；已经准备好的视频文稿仍保留在视频资料中。</p>
          </div>
          <div className={styles.dialogActions}>
            <button type="button" onClick={() => closeDialog(removeDialogRef.current)} disabled={pendingAction === 'remove'}>取消</button>
            <button type="button" data-danger="true" onClick={() => void confirmRemove()} disabled={pendingAction === 'remove'}>
              {pendingAction === 'remove' && <LoaderCircle size={15} className="animate-spin" />}
              确认移除
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={taskDialogRef}
        className={`${styles.dialog} ${styles.taskDialog}`}
        aria-modal="true"
        aria-labelledby="creator-task-title"
        onCancel={(event) => {
          if (pendingAction.startsWith('retry:') || pendingAction.startsWith('cancel:')) {
            event.preventDefault();
          }
        }}
        onClose={() => setDetailRun(null)}
      >
        <div className={styles.dialogCard}>
          <header className={styles.taskHeading}>
            <div>
              <span>{detailRun ? operationLabel(detailRun.operation) : '任务详情'}</span>
              <h2 id="creator-task-title">{detailRun ? runStatusLabel(detailRun) : '任务详情'}</h2>
            </div>
            <button type="button" onClick={() => closeDialog(taskDialogRef.current)} aria-label="关闭任务详情"><X size={18} /></button>
          </header>
          {detailRun && (
            <>
              <p className={styles.taskSummary}>{runProgress(detailRun)}</p>
              {detailRun.needs_action?.required && (
                <div className={styles.actionRequired} role="alert">
                  <CircleAlert size={18} />
                  <span>{detailRun.needs_action.message || '平台需要重新登录或完成验证后再重试。'}</span>
                </div>
              )}
              <div className={styles.runItemList} aria-busy={detailLoading}>
                {detailLoading ? (
                  <div className={styles.emptyState}><LoaderCircle size={20} className="animate-spin" />正在读取任务明细…</div>
                ) : detailItems.length ? detailItems.map((item) => {
                  const state = item.state || item.status;
                  return (
                  <article key={item.id || item.external_id}>
                    <FileText size={16} aria-hidden="true" />
                    <div>
                      <strong>{item.external_id}</strong>
                      <small>{item.error_message || (state === 'failed' ? '处理失败，可重试' : state)}</small>
                    </div>
                    <span data-status={state}>
                      {state === 'failed'
                        ? '失败'
                        : state === 'imported' || state === 'succeeded'
                          ? '已入库'
                          : state === 'reused'
                            ? '已复用'
                            : state === 'skipped_removed'
                              ? '已跳过'
                              : state === 'cancelled'
                                ? '已取消'
                                : state === 'importing' || state === 'processing'
                                  ? '处理中'
                                  : '等待中'}
                    </span>
                  </article>
                  );
                }) : (
                  <div className={styles.emptyState}>目录扫描不复制逐条任务明细</div>
                )}
              </div>
              <div className={styles.dialogActions}>
                {!TERMINAL_STATUSES.has(detailRun.status) && (
                  <button
                    type="button"
                    onClick={() => void cancelRun(detailRun)}
                    disabled={Boolean(pendingAction) || detailRun.cancellation_requested}
                  >
                    {detailRun.cancellation_requested ? '正在停止…' : '取消任务'}
                  </button>
                )}
                {(detailRun.status === 'failed' || detailRun.status === 'partial' || detailRun.needs_action?.required) && (
                  <button type="button" data-primary="true" onClick={() => void retryRun(detailRun)} disabled={Boolean(pendingAction)}>
                    {pendingAction === `retry:${detailRun.id}` ? <LoaderCircle size={15} className="animate-spin" /> : <ListRestart size={15} />}
                    重试失败项
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </dialog>

      <header className={styles.pageHeader}>
        <div>
          <Link href="/library" aria-label="返回视频资料"><ArrowLeft size={18} /></Link>
          <span>
            <small>视频资料 / 博主</small>
            <h1>博主作品</h1>
          </span>
        </div>
        <p>仅在点击按钮后同步；近期作品直接准备普通文稿，全部作品先同步清单再按需转写。</p>
      </header>

      {catalog && !catalog.enabled && !loadingSources && (
        <div className={styles.featureNotice} role="status">
          <CircleAlert size={18} />
          <span>博主同步功能当前由管理员关闭。连接器通过健康检查后才能启动新任务。</span>
        </div>
      )}
      {error && !selectedSource && (
        <div className={styles.featureNotice} data-error="true" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.workspace}>
        <aside className={styles.sourceRail} aria-label="已保存博主">
          <section className={styles.addSource}>
            <div>
              <strong>添加博主</strong>
              <small>{sources.length}/{catalog?.max_sources || 0}</small>
            </div>
            <div className={styles.platformSwitch} role="radiogroup" aria-label="博主平台">
              {(['douyin', 'bilibili'] as const).map((platform) => (
                <button key={platform} type="button" role="radio" aria-checked={addPlatform === platform} onClick={() => { setAddPlatform(platform); setPreview(null); setError(''); }}>
                  <PlatformBrandIcon platform={platform} size={15} />
                  {platformLabel(platform)}
                </button>
              ))}
            </div>
            {!addPlatformEnabled && catalog?.enabled ? (
              <p className={styles.addSourceStatus} role="status">
                {platformLabel(addPlatform)}连接器还未通过真实博主主页测试。管理员验证后即可添加，已有资料不受影响。
              </p>
            ) : null}
            <label>
              <span className="sr-only">博主主页链接</span>
              <input value={profileRef} onChange={(event) => { setProfileRef(event.target.value); setPreview(null); }} placeholder="粘贴博主主页链接" disabled={!addPlatformEnabled || Boolean(pendingAction)} />
              <button type="button" onClick={() => void inspectSource()} disabled={!addPlatformEnabled || !profileRef.trim() || Boolean(pendingAction)}>
                {pendingAction === 'resolve' ? <LoaderCircle size={16} className="animate-spin" /> : <Plus size={16} />}
                识别
              </button>
            </label>
            {preview && (
              <div className={styles.previewCard}>
                <span className={styles.avatar}>{preview.avatar_url ? <img src={preview.avatar_url} alt="" /> : <UserRound size={18} />}</span>
                <div><strong>{preview.display_name}</strong><small>{platformLabel(preview.platform)}博主</small></div>
                <button type="button" onClick={() => void saveSource()} disabled={Boolean(pendingAction)}>保存</button>
              </div>
            )}
          </section>

          <nav className={styles.sourceList} aria-label="选择博主">
            {loadingSources ? (
              <div className={styles.emptyState}><LoaderCircle size={20} className="animate-spin" />正在读取博主…</div>
            ) : sources.length ? sources.map((source) => (
              <button key={source.id} type="button" aria-current={source.id === selectedSourceId ? 'true' : undefined} onClick={() => setSelectedSourceId(source.id)}>
                <span className={styles.avatar}>{source.avatar_url ? <img src={source.avatar_url} alt="" /> : <UserRound size={18} />}</span>
                <span><strong>{source.display_name}</strong><small>{platformLabel(source.platform)} · {source.last_success_at ? '已同步' : '未同步'}</small></span>
                {activeRuns.some((run) => run.source_id === source.id) && <LoaderCircle size={15} className="animate-spin" aria-label="任务运行中" />}
              </button>
            )) : (
              <div className={styles.emptyState}><UserRound size={22} />粘贴主页保存第一个博主</div>
            )}
          </nav>
        </aside>

        <section className={styles.catalogPane} aria-labelledby="creator-catalog-title">
          {!selectedSource ? (
            <div className={styles.catalogEmpty}><FolderSync size={30} /><h2>选择一个博主</h2><p>近期 20/50/100 条会直接准备文稿；全量刷新只保存安全元数据。</p></div>
          ) : (
            <>
              <header className={styles.creatorHeader}>
                <div>
                  <span className={styles.avatar}>{selectedSource.avatar_url ? <img src={selectedSource.avatar_url} alt="" /> : <UserRound size={20} />}</span>
                  <span>
                    <small><PlatformBrandIcon platform={selectedSource.platform} size={13} />{platformLabel(selectedSource.platform)}</small>
                    <h2 id="creator-catalog-title">{selectedSource.display_name}</h2>
                  </span>
                </div>
                <div className={styles.creatorHeaderActions}>
                  <button type="button" className={styles.askCreatorButton} onClick={() => void askAllCreatorVideos()} disabled={Boolean(pendingAction)}>
                    {pendingAction === 'ask_creator' ? <LoaderCircle size={16} className="animate-spin" /> : <MessageCircleQuestion size={16} />}
                    <span>一键提问</span>
                  </button>
                  <button type="button" className={styles.removeButton} onClick={requestRemove} disabled={Boolean(sourceActiveRun)} title={sourceActiveRun ? '请先取消当前任务' : '移除来源'}><Trash2 size={16} /><span>移除</span></button>
                </div>
              </header>

              <div className={styles.runActions}>
                <div>
                  <span>准备近期文稿</span>
                  {RECENT_LIMITS.map((limit) => (
                    <button key={limit} type="button" onClick={() => void startRun('recent_transcript', limit)} disabled={!selectedPlatformEnabled || Boolean(pendingAction) || Boolean(userActiveRun)}>{limit} 条</button>
                  ))}
                </div>
                <button type="button" data-primary="true" onClick={() => void startRun('catalog_all')} disabled={!selectedCatalogEnabled || Boolean(pendingAction) || Boolean(userActiveRun)}>
                  {pendingAction === 'catalog_all' ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  刷新全部清单
                </button>
              </div>
              {!selectedPlatformEnabled ? (
                <p className={styles.connectorNotice}>该平台连接器尚未通过健康检查，当前不能启动同步。</p>
              ) : !selectedCatalogEnabled ? (
                <p className={styles.connectorNotice}>该平台暂不开放全部作品清单，近期文稿仍可使用。</p>
              ) : userActiveRun && !sourceActiveRun ? (
                <p className={styles.connectorNotice}>另一个博主任务正在后台运行，完成或取消后可启动新任务。</p>
              ) : null}

              {sourceActiveRun && (
                <article
                  className={styles.activeRun}
                  data-indeterminate={sourceActiveRun.operation === 'catalog_all' && !sourceActiveRun.discovery_complete}
                  role="progressbar"
                  aria-label={operationLabel(sourceActiveRun.operation)}
                  aria-valuemin={0}
                  aria-valuemax={sourceActiveRun.operation === 'catalog_all'
                    ? sourceActiveRun.total_count ?? undefined
                    : sourceActiveRun.target_count || sourceActiveRun.requested_limit}
                  aria-valuenow={sourceActiveRun.operation === 'catalog_all' && !sourceActiveRun.discovery_complete
                    ? undefined
                    : sourceActiveRun.operation === 'catalog_all'
                      ? sourceActiveRun.discovered_count
                      : sourceActiveRun.processed_count || sourceActiveRun.checked_count}
                  aria-valuetext={runProgress(sourceActiveRun)}
                >
                  <span><LoaderCircle size={18} className="animate-spin" /></span>
                  <div><strong>{operationLabel(sourceActiveRun.operation)}</strong><p>{runProgress(sourceActiveRun)}</p></div>
                  <button type="button" onClick={() => void openRunDetail(sourceActiveRun)}>详情</button>
                  <i aria-hidden="true" />
                </article>
              )}

              {(notice || error) && (
                <div className={styles.inlineNotice} data-error={Boolean(error)} role={error ? 'alert' : 'status'}>
                  {error ? <CircleAlert size={16} /> : <Check size={16} />}
                  <span>{error || notice}</span>
                  <button type="button" onClick={() => { setError(''); setNotice(''); }} aria-label="关闭提示"><X size={14} /></button>
                </div>
              )}

              <div className={styles.catalogToolbar}>
                <label>
                  <Search size={16} />
                  <span className="sr-only">搜索作品</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者或简介" />
                  {search && <button type="button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={14} /></button>}
                </label>
                <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as CreatorCatalogItemStatus); setPage(1); }} aria-label="按文稿状态筛选">
                  <option value="all">全部状态</option>
                  <option value="untranscribed">未转写</option>
                  <option value="imported">已入库</option>
                  <option value="failed">失败</option>
                </select>
                <button type="button" onClick={toggleVisible} disabled={!visibleSelectable.length}>{allVisibleSelected ? '取消本页' : '选择本页'}</button>
              </div>

              {selectedCount > 0 && (
                <aside className={styles.selectionBar}>
                  <strong>已选 {selectedCount}/{MAX_SELECTION} 条</strong>
                  <span>只准备普通文稿，不自动生成 AI 卡片</span>
                  <button type="button" onClick={() => setSelectedIds(new Set())}>取消选择</button>
                  <button type="button" data-primary="true" onClick={() => void startRun('selected_transcript', undefined, Array.from(selectedIds))} disabled={!selectedPlatformEnabled || Boolean(userActiveRun) || Boolean(pendingAction)}>
                    {pendingAction === 'selected_transcript' && <LoaderCircle size={15} className="animate-spin" />}
                    准备文稿
                  </button>
                </aside>
              )}

              <div className={styles.catalogList} aria-busy={loadingItems}>
                {loadingItems ? (
                  <div className={styles.catalogEmpty}><LoaderCircle size={24} className="animate-spin" /><p>正在读取作品清单…</p></div>
                ) : itemsPage.items.length ? itemsPage.items.map((item) => (
                  <CatalogItemRow
                    key={item.id}
                    item={item}
                    selected={selectedIds.has(item.id)}
                    creatorName={selectedSource.display_name}
                    onToggle={toggleItem}
                  />
                )) : (
                  <div className={styles.catalogEmpty}><FileText size={28} /><h3>还没有符合条件的作品</h3><p>点击“刷新全部清单”发现公开作品；目录同步不会下载媒体。</p></div>
                )}
              </div>

              {itemsPage.total_pages > 1 && (
                <nav className={styles.pagination} aria-label="作品清单分页">
                  <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}><ChevronLeft size={16} />上一页</button>
                  <span>第 {page} / {itemsPage.total_pages} 页 · 共 {itemsPage.total.toLocaleString('zh-CN')} 条</span>
                  <button type="button" onClick={() => setPage((value) => Math.min(itemsPage.total_pages, value + 1))} disabled={page >= itemsPage.total_pages}>下一页<ChevronRight size={16} /></button>
                </nav>
              )}

              {sourceRuns.length > 0 && (
                <section className={styles.history}>
                  <header><strong>近期任务</strong><small>任务详情最多显示最近 50 条运行明细</small></header>
                  <div>
                    {sourceRuns.map((run) => (
                      <button key={run.id} type="button" onClick={() => void openRunDetail(run)}>
                        <span><strong>{operationLabel(run.operation)}</strong><small>{new Date(run.created_at).toLocaleString('zh-CN')}</small></span>
                        <span data-status={run.status}>{runStatusLabel(run)}</span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export default function CreatorLibraryPage() {
  return (
    <AuthGuard>
      <CreatorLibraryWorkspace />
    </AuthGuard>
  );
}
