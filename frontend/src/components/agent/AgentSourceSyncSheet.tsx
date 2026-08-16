'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookmarkSimple,
  CloudArrowDown,
  Heart,
  LinkSimple,
  SpinnerGap,
  Trash,
  UserCirclePlus,
  X,
} from '@phosphor-icons/react';
import PlatformBrandIcon, { type PlatformBrand } from '@/components/PlatformBrandIcon';
import {
  cancelCreatorSyncRun,
  collectDouyinLibrary,
  createCreatorSyncRun,
  deleteCreatorSource,
  getCreatorSyncRun,
  getDouyinBatchExtraction,
  getDouyinCollectionJob,
  getDouyinLibraryStatus,
  importPlatformLibraryItems,
  listCreatorSources,
  listCreatorSyncRuns,
  listDouyinLibraryItems,
  resolveCreatorSource,
  saveCreatorSource,
  startDouyinBatchExtraction,
} from '@/lib/api';
import type {
  CreatorSource,
  CreatorSourceCatalog,
  CreatorSourcePreview,
  CreatorSyncRun,
} from '@/lib/types';
import { useCreatorSync } from '@/lib/hooks/CreatorSyncContext';
import styles from './AgentSourceSyncSheet.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSynced: () => void | Promise<void>;
  onManageSources: () => void;
  onBackgrounded: (message: string) => void;
  onCompleted: (message: string, success: boolean) => void;
}

const platforms: Array<{ value: PlatformBrand; label: string }> = [
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
  { value: 'xiaohongshu', label: '小红书' },
];
const syncCounts = [20, 50, 100] as const;
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const terminalCreatorStages = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function creatorProgress(run: CreatorSyncRun): string {
  if (run.status === 'queued') return '等待开始';
  if (run.status === 'resolving') return '正在确认博主';
  if (run.status === 'discovering') return `正在检查最近 ${run.requested_limit} 条`;
  if (run.status === 'importing') return `正在导入 ${run.checked_count}/${run.requested_limit}`;
  if (run.status === 'transcribing') return `正在准备文稿 · 已新增 ${run.new_count}`;
  if (run.status === 'cancelled') return '同步已取消';
  if (run.status === 'failed') return run.error_message || '同步失败';
  return `完成 · 新增 ${run.new_count} · 已存在 ${run.reused_count} · 失败 ${run.failed_count}`;
}

export default function AgentSourceSyncSheet({
  open,
  onClose,
  onSynced,
  onManageSources,
  onBackgrounded,
  onCompleted,
}: Props) {
  const { trackRun: trackCreatorRun } = useCreatorSync();
  const [platform, setPlatform] = useState<PlatformBrand>('douyin');
  const [sourceKind, setSourceKind] = useState<'account' | 'creator'>('account');
  const [douyinMode, setDouyinMode] = useState<'collect' | 'like'>('like');
  const [syncCount, setSyncCount] = useState<(typeof syncCounts)[number]>(50);
  const [urls, setUrls] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [creatorCatalog, setCreatorCatalog] = useState<CreatorSourceCatalog | null>(null);
  const [creators, setCreators] = useState<CreatorSource[]>([]);
  const [selectedCreatorId, setSelectedCreatorId] = useState('');
  const [creatorRef, setCreatorRef] = useState('');
  const [creatorPreview, setCreatorPreview] = useState<CreatorSourcePreview | null>(null);
  const [activeCreatorRun, setActiveCreatorRun] = useState<CreatorSyncRun | null>(null);
  const runningRef = useRef(false);
  const creatorPollingRef = useRef('');

  const closeOrBackground = useCallback(() => {
    if (pending) {
      onBackgrounded(
        sourceKind === 'creator'
          ? '博主作品正在后台同步，完成后会提示'
          : '视频文稿正在后台准备，全部完成后会提示',
      );
    }
    onClose();
  }, [onBackgrounded, onClose, pending, sourceKind]);

  const loadCreatorData = useCallback(async () => {
    const response = await listCreatorSources();
    if (!response.success || !response.data) return;
    setCreatorCatalog(response.data.catalog);
    setCreators(response.data.items);
    const platformItems = response.data.items.filter((item) => item.platform === platform);
    setSelectedCreatorId((current) => (
      platformItems.some((item) => item.id === current) ? current : platformItems[0]?.id || ''
    ));
  }, [platform]);

  const pollCreatorRun = useCallback(async (runId: string) => {
    if (!runId || creatorPollingRef.current === runId) return;
    creatorPollingRef.current = runId;
    try {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const response = await getCreatorSyncRun(runId);
        if (response.success && response.data) {
          const run = response.data;
          setActiveCreatorRun(run);
          setMessage(creatorProgress(run));
          setFailed(run.status === 'failed');
          if (terminalCreatorStages.has(run.status)) {
            setPending(false);
            await loadCreatorData();
            await onSynced();
            if (run.status !== 'cancelled') {
              onCompleted(creatorProgress(run), run.status === 'succeeded' || run.status === 'partial');
            }
            return;
          }
        }
        await delay(2_000);
      }
      onCompleted('博主同步仍在后台运行，稍后可重新打开查看', true);
    } finally {
      creatorPollingRef.current = '';
    }
  }, [loadCreatorData, onCompleted, onSynced]);

  useEffect(() => {
    if (!open) return;
    void loadCreatorData();
    void listCreatorSyncRuns('active').then((response) => {
      const run = response.data?.items[0];
      if (!run) return;
      setSourceKind('creator');
      setPlatform(run.platform);
      setActiveCreatorRun(run);
      setPending(true);
      setMessage(creatorProgress(run));
      void pollCreatorRun(run.id);
    });
  }, [loadCreatorData, open, pollCreatorRun]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOrBackground();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeOrBackground, open]);

  const prepareNewTranscripts = async (mode: 'collect' | 'like', count: number) => {
    setMessage('视频列表已更新，正在检查新视频…');
    const listResponse = await listDouyinLibraryItems(count, mode, 'collection');
    if (!listResponse.success || !listResponse.data) {
      throw new Error(listResponse.error || '视频已同步，但暂时无法读取最新列表');
    }
    const targets = listResponse.data.items
      .filter((item) => item.can_extract && !item.extracted)
      .slice(0, count);
    if (targets.length === 0) {
      await onSynced();
      return { prepared: 0, total: 0 };
    }
    const started = await startDouyinBatchExtraction(
      targets.map((item) => item.aweme_id),
      'transcript',
    );
    if (!started.success || !started.data) {
      throw new Error(started.error || '视频已同步，但文稿任务没有启动');
    }
    let lastVisibleCount = -1;
    for (let attempt = 0; attempt < 720; attempt += 1) {
      await delay(2_000);
      const response = await getDouyinBatchExtraction(started.data.job_id);
      if (!response.success || !response.data) continue;
      const job = response.data;
      setMessage(`正在准备文稿 ${job.success + job.failed}/${job.total} · 已完成 ${job.success}`);
      if (job.success !== lastVisibleCount) {
        lastVisibleCount = job.success;
        await onSynced();
      }
      if (job.status !== 'running') {
        if (job.status === 'failed') throw new Error(job.error || '新视频文稿准备失败');
        return { prepared: job.success, total: job.total };
      }
    }
    throw new Error('文稿仍在后台准备，稍后重新打开即可查看');
  };

  const syncDouyin = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const modeLabel = douyinMode === 'collect' ? '收藏' : '喜欢';
    setPending(true);
    setFailed(false);
    setMessage(`正在读取最近 ${syncCount} 条${modeLabel}…`);
    try {
      const connection = await getDouyinLibraryStatus();
      if (!connection.success || !connection.data?.cookie_valid) {
        throw new Error('抖音账号连接已失效，请重新连接账号后再同步');
      }
      const started = await collectDouyinLibrary(syncCount, douyinMode);
      if (!started.success || !started.data) {
        throw new Error(started.error || '同步未能启动，请检查抖音连接');
      }
      let collectionSuccess = 0;
      let collectionFinished = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await delay(2_000);
        const response = await getDouyinCollectionJob(started.data.job_id);
        if (!response.success || !response.data) continue;
        const job = response.data;
        setMessage(job.processed
          ? `正在同步 ${job.processed}/${job.target || syncCount}`
          : `正在读取抖音${modeLabel}，首次同步可能需要 1–2 分钟…`);
        if (job.status === 'failed') throw new Error(job.error || '同步失败，请稍后重试');
        if (attempt >= 44 && !job.processed) {
          throw new Error('抖音没有返回视频，请重新连接账号后重试');
        }
        if (job.status === 'success') {
          collectionSuccess = job.success || job.total || 0;
          collectionFinished = true;
          break;
        }
      }
      if (!collectionFinished) throw new Error('抖音同步等待超时，请检查账号连接后重试');
      const prepared = await prepareNewTranscripts(douyinMode, syncCount);
      const completedMessage = prepared.total > 0
        ? `同步完成 · 更新 ${collectionSuccess} 条，新增可用 ${prepared.prepared} 条`
        : `同步完成 · 最近 ${collectionSuccess} 条已是最新`;
      setMessage(completedMessage);
      await onSynced();
      onCompleted(completedMessage, true);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : '同步失败，请稍后重试';
      setFailed(true);
      setMessage(failureMessage);
      onCompleted(failureMessage, false);
    } finally {
      runningRef.current = false;
      setPending(false);
    }
  };

  const importLinks = async () => {
    const values = urls.split(/\r?\n|\s+/).map((value) => value.trim()).filter(Boolean);
    if (!values.length) {
      setFailed(true);
      setMessage('请先粘贴视频链接');
      return;
    }
    setPending(true);
    setFailed(false);
    setMessage('正在同步视频…');
    const response = await importPlatformLibraryItems(values);
    setPending(false);
    if (!response.success || !response.data) {
      setFailed(true);
      setMessage(response.error || '同步失败，请检查链接');
      return;
    }
    setMessage(`已同步 ${response.data.success} 条，失败 ${response.data.failed} 条`);
    setUrls('');
    await onSynced();
  };

  const inspectCreator = async () => {
    if (!creatorRef.trim()) {
      setFailed(true);
      setMessage('请粘贴博主主页链接');
      return;
    }
    setPending(true);
    setFailed(false);
    setMessage('正在识别博主…');
    const response = await resolveCreatorSource(platform, creatorRef);
    setPending(false);
    if (!response.success || !response.data) {
      setFailed(true);
      setMessage(response.error || '没有识别到有效博主主页');
      return;
    }
    setCreatorPreview(response.data);
    setMessage('');
  };

  const confirmCreator = async () => {
    if (!creatorPreview) return;
    setPending(true);
    const response = await saveCreatorSource(platform, creatorPreview.profile_url);
    setPending(false);
    if (!response.success || !response.data) {
      setFailed(true);
      setMessage(response.error || '保存博主失败');
      return;
    }
    setCreatorPreview(null);
    setCreatorRef('');
    setSelectedCreatorId(response.data.item.id);
    await loadCreatorData();
    setMessage(response.data.reused ? '已恢复这个博主' : '博主已保存');
  };

  const removeCreator = async (source: CreatorSource) => {
    const confirmed = window.confirm(`移除“${source.display_name}”？已同步的视频资料会保留。`);
    if (!confirmed) return;
    const response = await deleteCreatorSource(source.id);
    if (!response.success) {
      setFailed(true);
      setMessage(response.error || '移除博主失败');
      return;
    }
    await loadCreatorData();
    setMessage('已移除博主，现有资料保持不变');
  };

  const startCreatorRun = async () => {
    if (!selectedCreatorId) {
      setFailed(true);
      setMessage('请先选择一个博主');
      return;
    }
    setPending(true);
    setFailed(false);
    setMessage('正在创建后台任务…');
    const response = await createCreatorSyncRun(selectedCreatorId, syncCount);
    if (!response.success || !response.data) {
      setPending(false);
      setFailed(true);
      setMessage(response.error || '同步任务没有启动');
      return;
    }
    const run = response.data.run;
    trackCreatorRun(run);
    setActiveCreatorRun(run);
    setMessage(creatorProgress(run));
    onBackgrounded(`正在同步该博主最近 ${syncCount} 条，完成后会提示`);
    onClose();
    void pollCreatorRun(run.id);
  };

  const cancelCreatorRun = async () => {
    if (!activeCreatorRun) return;
    const response = await cancelCreatorSyncRun(activeCreatorRun.id);
    if (!response.success || !response.data) {
      setFailed(true);
      setMessage(response.error || '取消任务失败');
      return;
    }
    setActiveCreatorRun(response.data);
    setMessage(response.data.status === 'cancelled' ? '同步已取消' : '正在停止…');
  };

  const platformCreators = creators.filter((item) => item.platform === platform);
  const selectedCreator = platformCreators.find((item) => item.id === selectedCreatorId) || null;
  const creatorPlatformEnabled = creatorCatalog?.platforms[platform] !== false;

  return (
    <div
      className={styles.overlay}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeOrBackground(); }}
    >
      <section className={styles.panel} role="dialog" aria-modal={open || undefined} aria-label="同步视频">
        <header className={styles.header}>
          <h2>同步视频</h2>
          <button type="button" className={styles.close} onClick={closeOrBackground} aria-label={pending ? '收起并后台运行' : '关闭同步视频'}><X size={18} /></button>
        </header>
        <div className={styles.content}>
          <div className={styles.tabs} role="tablist" aria-label="选择视频平台">
            {platforms.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={platform === item.value}
                aria-label={item.label}
                title={item.label}
                disabled={pending}
                onClick={() => {
                  setPlatform(item.value);
                  setCreatorPreview(null);
                  setCreatorRef('');
                  setMessage('');
                  setFailed(false);
                }}
              >
                <PlatformBrandIcon platform={item.value} size={item.value === 'xiaohongshu' ? 25 : 19} />
              </button>
            ))}
          </div>

          {creatorCatalog?.enabled && (
            <div className={styles.sourceSwitch} role="tablist" aria-label="选择同步来源">
              <button type="button" role="tab" aria-selected={sourceKind === 'account'} disabled={pending} onClick={() => { setSourceKind('account'); setMessage(''); }}>我的账号</button>
              <button type="button" role="tab" aria-selected={sourceKind === 'creator'} disabled={pending} onClick={() => { setSourceKind('creator'); setMessage(''); }}>指定博主</button>
            </div>
          )}

          <div className={styles.body}>
            {sourceKind === 'creator' && creatorCatalog?.enabled ? (
              <>
                {!creatorPlatformEnabled ? (
                  <div className={styles.creatorEmpty}>该平台连接器尚未开放</div>
                ) : (
                  <>
                    {platformCreators.length > 0 && (
                      <div className={styles.creatorList} role="radiogroup" aria-label="选择已保存博主">
                        {platformCreators.map((creator) => (
                          <div className={styles.creatorChoice} key={creator.id} data-selected={creator.id === selectedCreatorId}>
                            <button type="button" role="radio" aria-checked={creator.id === selectedCreatorId} disabled={pending} onClick={() => { setSelectedCreatorId(creator.id); setMessage(''); }}>
                              {creator.avatar_url ? <img src={creator.avatar_url} alt="" /> : <UserCirclePlus size={22} />}
                              <span><strong>{creator.display_name}</strong><small>{creator.last_success_at ? '已同步' : '尚未同步'}</small></span>
                            </button>
                            <button type="button" className={styles.removeCreator} disabled={pending} onClick={() => void removeCreator(creator)} aria-label={`移除博主 ${creator.display_name}`}><Trash size={15} /></button>
                          </div>
                        ))}
                      </div>
                    )}

                    {!creatorPreview ? (
                      <div className={styles.creatorInput}>
                        <label htmlFor="creator-profile">博主主页</label>
                        <div>
                          <LinkSimple size={17} aria-hidden="true" />
                          <input id="creator-profile" value={creatorRef} onChange={(event) => setCreatorRef(event.target.value)} placeholder="粘贴主页链接" disabled={pending} />
                          <button type="button" onClick={inspectCreator} disabled={pending || !creatorRef.trim()}>识别</button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.creatorPreview}>
                        {creatorPreview.avatar_url ? <img src={creatorPreview.avatar_url} alt="" /> : <UserCirclePlus size={24} />}
                        <span><strong>{creatorPreview.display_name}</strong><small>确认后保存到博主列表</small></span>
                        <button type="button" onClick={confirmCreator} disabled={pending}>保存</button>
                      </div>
                    )}

                    {selectedCreator && (
                      <>
                        <div className={styles.countRow}>
                          <span>检查最近</span>
                          <div role="radiogroup" aria-label="检查作品数量">
                            {syncCounts.map((count) => (
                              <button key={count} type="button" role="radio" aria-checked={syncCount === count} disabled={pending} onClick={() => setSyncCount(count)}>{count}</button>
                            ))}
                          </div>
                          <span>条</span>
                        </div>
                        <button className={styles.primary} type="button" disabled={pending} data-loading={pending} onClick={startCreatorRun}>
                          {pending ? <SpinnerGap size={18} weight="bold" aria-hidden="true" /> : <CloudArrowDown size={19} weight="bold" aria-hidden="true" />}
                          <span>{pending ? '后台同步中' : `同步该博主最近 ${syncCount} 条`}</span>
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            ) : platform === 'douyin' ? (
              <>
                <div className={styles.douyinModes} role="radiogroup" aria-label="选择抖音同步来源">
                  <button type="button" role="radio" aria-checked={douyinMode === 'like'} disabled={pending} onClick={() => { setDouyinMode('like'); setMessage(''); }}><Heart size={17} weight={douyinMode === 'like' ? 'fill' : 'regular'} />喜欢</button>
                  <button type="button" role="radio" aria-checked={douyinMode === 'collect'} disabled={pending} onClick={() => { setDouyinMode('collect'); setMessage(''); }}><BookmarkSimple size={17} weight={douyinMode === 'collect' ? 'fill' : 'regular'} />收藏</button>
                </div>
                <div className={styles.countRow}>
                  <span>同步最近</span>
                  <div role="radiogroup" aria-label="同步视频数量">
                    {syncCounts.map((count) => (
                      <button key={count} type="button" role="radio" aria-checked={syncCount === count} disabled={pending} onClick={() => setSyncCount(count)}>{count}</button>
                    ))}
                  </div>
                  <span>条</span>
                </div>
                <p>新视频会在后台准备普通文稿，不会自动分析画面。</p>
                <button className={styles.primary} type="button" disabled={pending} data-loading={pending} onClick={syncDouyin}>
                  {pending ? <SpinnerGap size={18} weight="bold" aria-hidden="true" /> : <CloudArrowDown size={19} weight="bold" aria-hidden="true" />}
                  <span>{pending ? '正在同步' : `同步抖音${douyinMode === 'collect' ? '收藏' : '喜欢'}`}</span>
                </button>
              </>
            ) : (
              <>
                <p>粘贴{platform === 'bilibili' ? 'B站' : '小红书'}视频链接，每行一个，最多 10 条。</p>
                <textarea value={urls} onChange={(event) => setUrls(event.target.value)} placeholder="粘贴视频链接" />
                <button className={styles.primary} type="button" disabled={pending} data-loading={pending} onClick={importLinks}>
                  {pending ? <SpinnerGap size={18} weight="bold" aria-hidden="true" /> : <CloudArrowDown size={19} weight="bold" aria-hidden="true" />}
                  <span>{pending ? '正在同步' : '同步这些视频'}</span>
                </button>
              </>
            )}
            {message && <p className={styles.status} role="status" aria-live="polite" data-error={failed}>{message}</p>}
            {sourceKind === 'creator' && activeCreatorRun && !terminalCreatorStages.has(activeCreatorRun.status) ? (
              <button type="button" className={styles.background} onClick={cancelCreatorRun}>取消同步</button>
            ) : pending ? (
              <button type="button" className={styles.background} onClick={closeOrBackground}>收起并后台运行</button>
            ) : sourceKind === 'account' ? (
              <button type="button" className={styles.manage} onClick={onManageSources}><Trash size={15} />管理已同步视频</button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
