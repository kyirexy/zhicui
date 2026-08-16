'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  Captions,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  Heart,
  Image as ImageIcon,
  LogIn,
  LoaderCircle,
  Library,
  Link2,
  NotebookPen,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Video,
} from 'lucide-react';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import {
  importPlatformLibraryItems,
  initializePlatformLibraryItem,
  listPlatformLibraryItems,
} from '@/lib/api';
import type {
  LibraryPlatformFilter,
  PlatformLibraryImportEntry,
  PlatformLibraryItem,
} from '@/lib/types';
import { useAuth } from '@/lib/hooks/AuthContext';
import type {
  PlatformAccountProvider,
  PlatformAccountSourceMode,
  PlatformAccountStage,
} from '@/lib/desktopRuntime';
import styles from './PlatformLibraryPanel.module.css';

interface PlatformLibraryPanelProps {
  search: string;
  filter: LibraryPlatformFilter;
  onFilterChange: (filter: LibraryPlatformFilter) => void;
  presentation?: 'full' | 'controls';
  managerView?: PlatformLibraryManagerView;
  onItemsChange?: (items: PlatformLibraryItem[]) => void;
  onStateChange?: (state: PlatformLibraryPanelState) => void;
}

export type PlatformLibraryManagerView = PlatformAccountProvider | 'all' | 'import' | 'hidden';

export interface PlatformLibraryPanelState {
  loading: boolean;
  error: string;
}

const FILTERS: Array<{ value: LibraryPlatformFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
  { value: 'xiaohongshu', label: '小红书' },
];

const ACCOUNT_PLATFORMS: Array<{
  platform: PlatformAccountProvider;
  label: string;
  note: string;
  beta: boolean;
}> = [
  {
    platform: 'bilibili',
    label: 'B站账号',
    note: '自动读取当前账号最近的喜欢或收藏',
    beta: false,
  },
  {
    platform: 'xiaohongshu',
    label: '小红书账号',
    note: '在官方页面进入本人主页后采集可见内容',
    beta: true,
  },
];

interface AccountConnectionState {
  connected: boolean;
  stage: PlatformAccountStage | 'idle';
  message: string;
}

type AccountConnectionMap = Record<PlatformAccountProvider, AccountConnectionState>;

const INITIAL_ACCOUNT_CONNECTIONS: AccountConnectionMap = {
  bilibili: { connected: false, stage: 'idle', message: '尚未连接' },
  xiaohongshu: { connected: false, stage: 'idle', message: '尚未连接' },
};

function formatDate(value: string): string {
  if (!value) return '刚刚导入';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

function sourceLabel(item: PlatformLibraryItem): string {
  if (item.transcript_source === 'manual-subtitle') return '人工字幕';
  if (item.transcript_source === 'automatic-subtitle') return '平台 AI 字幕';
  if (item.transcript_source === 'cloud-asr' || item.transcript_source === 'local-asr') return '视频语音已提取';
  return item.media_type === 'video' ? '仅发布文案' : '图文正文';
}

function importResultLabel(entry: PlatformLibraryImportEntry): string {
  const platform = entry.item?.platform || entry.platform;
  const platformName = platform === 'bilibili'
    ? 'B站'
    : platform === 'xiaohongshu'
      ? '小红书'
      : '未知平台';
  if (entry.success && entry.item) {
    const resultState = entry.status === 'reused' ? '已在资料库' : '已导入';
    return `${platformName} · ${entry.item.title || '视频'} · ${sourceLabel(entry.item)} · ${resultState}`;
  }
  const compactInput = entry.input.length > 42 ? `${entry.input.slice(0, 42)}…` : entry.input;
  return `${platformName} · ${compactInput} · ${entry.error || '导入失败'}`;
}

export default function PlatformLibraryPanel({
  search,
  filter,
  onFilterChange,
  presentation = 'full',
  managerView = 'all',
  onItemsChange,
  onStateChange,
}: PlatformLibraryPanelProps) {
  const { user } = useAuth();
  const { isDesktop } = useDesktopApp();
  const [items, setItems] = useState<PlatformLibraryItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [initializingId, setInitializingId] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<PlatformLibraryImportEntry[]>([]);
  const [feedbackView, setFeedbackView] = useState<PlatformLibraryManagerView>('all');
  const [accountAction, setAccountAction] = useState('');
  const [accountBridgeAvailable, setAccountBridgeAvailable] = useState(false);
  const [manualImporterOpen, setManualImporterOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<PlatformAccountProvider | null>(null);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [disconnectError, setDisconnectError] = useState('');
  const disconnectDialogRef = useRef<HTMLDialogElement | null>(null);
  const onItemsChangeRef = useRef(onItemsChange);
  const onStateChangeRef = useRef(onStateChange);
  const [accountConnections, setAccountConnections] = useState<AccountConnectionMap>(
    INITIAL_ACCOUNT_CONNECTIONS,
  );
  const controlsOnly = presentation === 'controls';
  const managerHidden = controlsOnly && managerView === 'hidden';
  const selectedAccountPlatform = managerView === 'bilibili' || managerView === 'xiaohongshu'
    ? managerView
    : null;
  const visibleAccountPlatforms = selectedAccountPlatform
    ? ACCOUNT_PLATFORMS.filter(({ platform }) => platform === selectedAccountPlatform)
    : ACCOUNT_PLATFORMS;
  const showAccountSync = !controlsOnly
    || managerView === 'all'
    || selectedAccountPlatform !== null;
  const showImporter = !controlsOnly || managerView === 'all' || managerView === 'import';
  const directImporter = controlsOnly && managerView === 'import';

  useEffect(() => {
    onItemsChangeRef.current = onItemsChange;
  }, [onItemsChange]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const updateAccountConnection = useCallback((
    platform: PlatformAccountProvider,
    changes: Partial<AccountConnectionState>,
  ) => {
    setAccountConnections((current) => {
      const next = {
        ...current,
        [platform]: { ...current[platform], ...changes },
      };
      if (user?.id && typeof window !== 'undefined') {
        window.localStorage.setItem(
          `zhicui-platform-account-connections:${user.id}`,
          JSON.stringify({
            bilibili: next.bilibili.connected,
            xiaohongshu: next.xiaohongshu.connected,
          }),
        );
      }
      return next;
    });
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || typeof window === 'undefined') return;
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(
          `zhicui-platform-account-connections:${user.id}`,
        ) || '{}',
      ) as Partial<Record<PlatformAccountProvider, boolean>>;
      setAccountConnections({
        bilibili: {
          connected: Boolean(stored.bilibili),
          stage: 'idle',
          message: stored.bilibili ? '本机已连接' : '尚未连接',
        },
        xiaohongshu: {
          connected: Boolean(stored.xiaohongshu),
          stage: 'idle',
          message: stored.xiaohongshu ? '本机已连接' : '尚未连接',
        },
      });
    } catch {
      setAccountConnections(INITIAL_ACCOUNT_CONNECTIONS);
    }
  }, [user?.id]);

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.zhicuiDesktop;
    const available = Boolean(
      isDesktop
      && bridge
      && typeof bridge.loginPlatformAccount === 'function'
      && typeof bridge.collectPlatformAccount === 'function'
      && typeof bridge.onPlatformAccountStatus === 'function',
    );
    setAccountBridgeAvailable(available);
    setManualImporterOpen(!available);
    if (!available || !bridge) return;
    return bridge.onPlatformAccountStatus((status) => {
      updateAccountConnection(status.platform, {
        ...(status.stage === 'success' ? { connected: true } : {}),
        ...(status.stage === 'disconnected' ? { connected: false } : {}),
        stage: status.stage,
        message: status.message,
      });
    });
  }, [isDesktop, updateAccountConnection]);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      onStateChangeRef.current?.({ loading: true, error: '' });
    }
    const response = await listPlatformLibraryItems('all');
    if (response.success && response.data) {
      const loadedItems = response.data.items;
      setItems(loadedItems);
      onItemsChangeRef.current?.(loadedItems);
      setError('');
      onStateChangeRef.current?.({ loading: false, error: '' });
    } else {
      const message = response.status === 404
        ? '跨平台资料服务尚未连接，请重启当前开发服务后重试'
        : response.error || '暂时无法读取 B站和小红书资料';
      setError(message);
      onStateChangeRef.current?.({ loading: false, error: message });
    }
    if (!silent) setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => {
      if (filter === 'douyin') return false;
      if (filter !== 'all' && item.platform !== filter) return false;
      if (!keyword) return true;
      return [item.title, item.author_name, item.caption, ...item.tags]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(keyword);
    });
  }, [filter, items, search]);

  const submit = async () => {
    setFeedbackView('import');
    const urls = input
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (urls.length === 0 || importing) {
      setError('请粘贴至少一条 B站或小红书分享链接');
      return;
    }
    setImporting(true);
    setError('');
    setResults([]);
    const response = await importPlatformLibraryItems(urls);
    setImporting(false);
    if (!response.success || !response.data) {
      setError(response.error || '导入没有完成，请稍后重试');
      return;
    }
    setResults(response.data.items);
    if (response.data.success > 0) {
      setInput(response.data.failed > 0
        ? response.data.items.filter((entry) => !entry.success).map((entry) => entry.input).join('\n')
        : '');
      await load(true);
    }
  };

  const loginAccount = async (platform: PlatformAccountProvider) => {
    const bridge = window.zhicuiDesktop;
    if (!accountBridgeAvailable || !bridge || !user?.id || accountAction) return;
    setAccountAction(`${platform}:login`);
    updateAccountConnection(platform, {
      stage: 'starting',
      message: '正在打开官方登录页面…',
    });
    const response = await bridge.loginPlatformAccount({
      platform,
      profileKey: user.id,
    });
    setAccountAction('');
    if (response.success) {
      updateAccountConnection(platform, {
        connected: true,
        stage: 'success',
        message: platform === 'bilibili' ? 'B站连接成功' : '小红书连接成功',
      });
      return;
    }
    updateAccountConnection(platform, {
      stage: response.cancelled ? 'cancelled' : 'error',
      message: response.cancelled ? '登录已取消' : response.error || '登录失败，请重试',
    });
  };

  const syncAccount = async (
    platform: PlatformAccountProvider,
    mode: PlatformAccountSourceMode,
  ) => {
    const bridge = window.zhicuiDesktop;
    if (!accountBridgeAvailable || !bridge || !user?.id || accountAction) return;
    setFeedbackView(platform);
    setAccountAction(`${platform}:${mode}`);
    setResults([]);
    updateAccountConnection(platform, {
      stage: 'collecting',
      message: mode === 'collect' ? '正在读取最近收藏…' : '正在读取最近喜欢…',
    });
    const collected = await bridge.collectPlatformAccount({
      platform,
      profileKey: user.id,
      mode,
      limit: 10,
    });
    if (!collected.success || !collected.urls?.length) {
      setAccountAction('');
      updateAccountConnection(platform, {
        connected: collected.error?.includes('重新登录') ? false : accountConnections[platform].connected,
        stage: collected.cancelled ? 'cancelled' : 'error',
        message: collected.cancelled
          ? '同步已取消'
          : collected.error || '没有读取到可同步的作品',
      });
      return;
    }

    updateAccountConnection(platform, {
      connected: true,
      stage: 'collecting',
      message: `已读取 ${collected.urls.length} 条，正在准备文案…`,
    });
    setAccountAction(`${platform}:${mode}:import`);
    const imported = await importPlatformLibraryItems(collected.urls);
    setAccountAction('');
    if (!imported.success || !imported.data) {
      updateAccountConnection(platform, {
        stage: 'error',
        message: imported.error || '作品已读取，但导入资料失败',
      });
      return;
    }
    setResults(imported.data.items);
    updateAccountConnection(platform, {
      connected: true,
      stage: 'success',
      message: imported.data.failed > 0
        ? `已导入 ${imported.data.success} 条，${imported.data.failed} 条需要重试`
        : `已同步 ${imported.data.success} 条${mode === 'collect' ? '收藏' : '喜欢'}作品`,
    });
    if (imported.data.success > 0) await load(true);
  };

  const openDisconnectDialog = (platform: PlatformAccountProvider) => {
    if (accountAction || disconnectPending) return;
    setDisconnectTarget(platform);
    setDisconnectError('');
    disconnectDialogRef.current?.showModal();
  };

  const closeDisconnectDialog = () => {
    if (disconnectPending) return;
    disconnectDialogRef.current?.close();
    setDisconnectTarget(null);
    setDisconnectError('');
  };

  const confirmDisconnectAccount = async () => {
    const bridge = window.zhicuiDesktop;
    if (
      !disconnectTarget
      || !accountBridgeAvailable
      || !bridge
      || !user?.id
      || accountAction
      || disconnectPending
    ) return;
    const platform = disconnectTarget;
    setDisconnectPending(true);
    setDisconnectError('');
    setAccountAction(`${platform}:disconnect`);
    const response = await bridge.disconnectPlatformAccount({
      platform,
      profileKey: user.id,
    });
    setDisconnectPending(false);
    setAccountAction('');
    if (!response.success) {
      setDisconnectError(response.error || '断开失败，请稍后重试');
      return;
    }
    updateAccountConnection(platform, {
      connected: false,
      stage: 'disconnected',
      message: '本机登录已断开',
    });
    disconnectDialogRef.current?.close();
    setDisconnectTarget(null);
  };

  const cancelAccountAction = async () => {
    const bridge = window.zhicuiDesktop;
    if (!bridge || typeof bridge.cancelPlatformAccountAction !== 'function') return;
    await bridge.cancelPlatformAccountAction();
    setAccountAction('');
  };

  const initialize = async (item: PlatformLibraryItem) => {
    if (initializingId || item.ai_initialized) return;
    setInitializingId(item.id);
    setError('');
    const response = await initializePlatformLibraryItem(item.id);
    setInitializingId('');
    if (!response.success) {
      setError(response.error || '摘要笔记生成失败，请稍后重试');
      return;
    }
    await load(true);
  };

  const importer = (
    <div className={styles.importer}>
      <label htmlFor="platform-library-urls">每行粘贴一条 B站或小红书分享链接</label>
      <div className={styles.inputRow}>
        <textarea
          id="platform-library-urls"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder={'https://www.bilibili.com/video/BV...\nhttps://www.xiaohongshu.com/explore/...'}
          disabled={importing}
        />
        <button type="button" onClick={() => void submit()} disabled={importing}>
          {importing ? <LoaderCircle size={18} className="animate-spin" /> : <Plus size={18} />}
          {importing ? '正在准备文案' : '导入视频资料'}
        </button>
      </div>
    </div>
  );

  return (
    <section
      className={styles.section}
      data-presentation={presentation}
      data-manager-view={managerView}
      hidden={managerHidden}
      aria-labelledby={controlsOnly && managerView === 'import'
        ? 'platform-import-heading'
        : controlsOnly ? 'platform-account-heading' : 'platform-library-heading'}
    >
      {!controlsOnly && (
        <div className={styles.heading}>
          <div>
            <span className={styles.kicker}>跨平台导入</span>
            <h2 id="platform-library-heading">B站和小红书也放进视频资料</h2>
            <p>保留发布文案和已有字幕；视频没有字幕时再提取语音，不做 OCR。</p>
          </div>
          <div className={styles.platformMarks} aria-label="支持的平台">
            <span data-platform="bilibili">
              <PlatformBrandIcon platform="bilibili" size={14} />
              B站
            </span>
            <span data-platform="xiaohongshu">
              <PlatformBrandIcon platform="xiaohongshu" size={14} />
              小红书
            </span>
          </div>
        </div>
      )}

      {showAccountSync && (
      <div className={styles.accountSync} aria-labelledby="platform-account-heading">
        <div className={styles.accountSyncHeading}>
          <div>
            <h3 id="platform-account-heading">
              {controlsOnly ? '平台账号同步' : '连接平台账号'}
            </h3>
            {!controlsOnly && <p>登录后同步收藏或喜欢。</p>}
          </div>
          <div className={styles.localOnly}>
            <ShieldCheck size={15} aria-hidden="true" />
            <span><strong>登录仅保存在本机</strong></span>
          </div>
        </div>

        {accountBridgeAvailable ? (
          <div className={styles.accountGrid}>
            {visibleAccountPlatforms.map(({ platform, label, note, beta }) => {
              const connection = accountConnections[platform];
              const busy = accountAction.startsWith(`${platform}:`);
              const blockedByOtherAccount = Boolean(accountAction) && !busy;
              const activeAccountLabel = accountAction.startsWith('bilibili:') ? 'B站' : '小红书';
              const activeOperation = busy ? accountAction.split(':')[1] : '';
              return (
                <article
                  className={styles.accountCard}
                  key={platform}
                  data-platform={platform}
                  data-connected={connection.connected}
                  aria-busy={busy || blockedByOtherAccount}
                >
                  <header className={styles.accountCardHeader}>
                    <span className={styles.platformSymbol} aria-hidden="true">
                      <PlatformBrandIcon platform={platform} size={20} />
                    </span>
                    <div className={styles.accountIdentity}>
                      <div className={styles.accountTitleRow}>
                        <h4>{label}</h4>
                        {beta && <span className={styles.betaBadge}>Beta</span>}
                      </div>
                      <p>{note}</p>
                    </div>
                    <span className={styles.connectionState} data-connected={connection.connected}>
                      <i aria-hidden="true" />
                      {connection.connected ? '已连接' : '未连接'}
                    </span>
                  </header>

                  {(busy || blockedByOtherAccount || connection.stage !== 'idle') && (
                    <div
                      className={styles.accountStatus}
                      data-stage={connection.stage}
                      role={connection.stage === 'error' ? 'alert' : 'status'}
                      aria-live="polite"
                    >
                      {busy || blockedByOtherAccount ? (
                        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                      ) : connection.stage === 'error' ? (
                        <AlertCircle size={16} aria-hidden="true" />
                      ) : connection.connected ? (
                        <CheckCircle2 size={16} aria-hidden="true" />
                      ) : (
                        <LogIn size={16} aria-hidden="true" />
                      )}
                      <span>
                        {blockedByOtherAccount
                          ? `${activeAccountLabel}操作正在进行，完成后即可继续`
                          : connection.message}
                      </span>
                      {busy && !accountAction.endsWith(':import') && (
                        <button type="button" onClick={() => void cancelAccountAction()}>
                          取消
                        </button>
                      )}
                    </div>
                  )}

                  {connection.connected ? (
                    <div className={styles.connectedActions}>
                      <div className={styles.syncActions}>
                        <button
                          type="button"
                          className={styles.primarySyncButton}
                          onClick={() => void syncAccount(platform, 'collect')}
                          disabled={Boolean(accountAction)}
                        >
                          {activeOperation === 'collect' || activeOperation === 'import'
                            ? <LoaderCircle size={17} className="animate-spin" />
                            : <Bookmark size={17} />}
                          {activeOperation === 'collect' ? '正在读取收藏' : '同步收藏'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void syncAccount(platform, 'like')}
                          disabled={Boolean(accountAction)}
                        >
                          {activeOperation === 'like'
                            ? <LoaderCircle size={17} className="animate-spin" />
                            : <Heart size={17} />}
                          {activeOperation === 'like' ? '正在读取喜欢' : '同步喜欢'}
                        </button>
                      </div>
                      <details className={styles.accountManagementDisclosure}>
                        <summary>
                          连接设置
                          <ChevronDown size={14} aria-hidden="true" />
                        </summary>
                        <div className={styles.accountManagement} aria-label={`${label}连接管理`}>
                          <button
                            type="button"
                            onClick={() => void loginAccount(platform)}
                            disabled={Boolean(accountAction)}
                          >
                            <RefreshCw size={14} />重新登录
                          </button>
                          <button
                            type="button"
                            className={styles.disconnectButton}
                            onClick={() => openDisconnectDialog(platform)}
                            disabled={Boolean(accountAction)}
                          >
                            <Unplug size={14} />断开连接
                          </button>
                        </div>
                      </details>
                    </div>
                  ) : (
                    <div className={styles.connectAction}>
                      <button
                        type="button"
                        onClick={() => void loginAccount(platform)}
                        disabled={Boolean(accountAction)}
                      >
                        {activeOperation === 'login'
                          ? <LoaderCircle size={17} className="animate-spin" />
                          : <LogIn size={17} />}
                        {activeOperation === 'login'
                          ? '等待平台登录'
                          : `登录${platform === 'bilibili' ? ' B站' : '小红书'}`}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className={styles.accountUnavailable} role="note">
            <span className={styles.unavailableIcon}><LogIn size={19} /></span>
            <div>
              <strong>{isDesktop ? '请更新 Windows 桌面端' : '账号同步需要 Windows 桌面端'}</strong>
              <span>
                {controlsOnly
                  ? '你仍可切换到“分享链接”导入，已有功能不受影响。'
                  : '你仍可使用下方的分享链接导入，已有功能不受影响。'}
              </span>
            </div>
          </div>
        )}

      </div>
      )}

      {showImporter && (directImporter ? (
        <section className={styles.directImporter} aria-labelledby="platform-import-heading">
          <div className={styles.directImporterHeading}>
            <span className={styles.importIcon} aria-hidden="true"><Link2 size={18} /></span>
            <div>
              <h3 id="platform-import-heading">导入分享链接</h3>
              <p>无需登录，一次最多导入 10 条 B站或小红书链接。</p>
            </div>
          </div>
          {importer}
        </section>
      ) : (
        <details
          className={styles.importerDisclosure}
          open={manualImporterOpen}
          onToggle={(event) => setManualImporterOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <Plus size={17} aria-hidden="true" />
              <strong>导入分享链接</strong>
            </span>
            <ChevronDown size={17} className={styles.disclosureChevron} aria-hidden="true" />
          </summary>
          {importer}
        </details>
      ))}

      <dialog
        ref={disconnectDialogRef}
        className={styles.disconnectDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="platform-disconnect-title"
        aria-describedby="platform-disconnect-description"
        onCancel={(event) => {
          if (disconnectPending) {
            event.preventDefault();
            return;
          }
          closeDisconnectDialog();
        }}
      >
        <div className={styles.disconnectDialogCard}>
          <span className={styles.disconnectDialogIcon} aria-hidden="true"><Unplug size={20} /></span>
          <div>
            <h2 id="platform-disconnect-title">
              断开{disconnectTarget === 'bilibili' ? 'B站' : '小红书'}本机连接？
            </h2>
            <p id="platform-disconnect-description">
              只会删除这台电脑上的平台登录态，已经导入的视频资料、文案和摘要都会保留。
            </p>
          </div>
          {disconnectError && <p className={styles.disconnectError} role="alert">{disconnectError}</p>}
          <div className={styles.disconnectDialogActions}>
            <button type="button" onClick={closeDisconnectDialog} disabled={disconnectPending}>取消</button>
            <button
              type="button"
              className={styles.confirmDisconnectButton}
              onClick={() => void confirmDisconnectAccount()}
              disabled={disconnectPending}
            >
              {disconnectPending && <LoaderCircle size={16} className="animate-spin" />}
              确认断开
            </button>
          </div>
        </div>
      </dialog>

      {error && (!controlsOnly || managerView === 'all' || feedbackView === managerView) && (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" />
            {loading ? '正在加载' : '重新加载'}
          </button>
        </div>
      )}
      {results.length > 0
        && (!controlsOnly || managerView === 'all' || feedbackView === managerView) && (
        <ul className={styles.results} aria-label="导入结果">
          {results.map((entry, index) => (
            <li key={`${entry.input}-${index}`} data-success={entry.success}>
              {entry.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
              <span title={entry.success ? undefined : entry.input}>{importResultLabel(entry)}</span>
            </li>
          ))}
        </ul>
      )}

      {!controlsOnly && (
        <>
          <div className={styles.filters} role="group" aria-label="按平台筛选视频资料">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                data-active={filter === option.value}
                onClick={() => onFilterChange(option.value)}
              >
                {option.value === 'all' ? (
                  <Library size={15} aria-hidden="true" />
                ) : (
                  <PlatformBrandIcon platform={option.value} size={14} />
                )}
                {option.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className={styles.skeletons} aria-label="正在读取跨平台资料">
              <span /><span /><span />
            </div>
          ) : filteredItems.length > 0 ? (
            <div className={styles.grid}>
              {filteredItems.map((item) => (
                <article className={styles.card} key={item.id}>
                  <Link
                    href={`/library/detail?note=${encodeURIComponent(item.id)}`}
                    className={styles.cover}
                    aria-label={`打开视频资料：${item.title}`}
                  >
                    {item.cover_url ? (
                      <img src={item.cover_url} alt="" loading="lazy" />
                    ) : (
                      <span>{item.media_type === 'video' ? <Video size={24} /> : <ImageIcon size={24} />}</span>
                    )}
                    <b data-platform={item.platform}>
                      <PlatformBrandIcon platform={item.platform} size={13} />
                      {item.platform === 'bilibili' ? 'B站' : '小红书'}
                    </b>
                  </Link>
                  <div className={styles.cardBody}>
                    <div className={styles.cardMeta}>
                      <span>{item.author_name || '作者暂不可用'}</span>
                      <span>{formatDate(item.published_at || item.imported_at)}</span>
                    </div>
                    <h3 title={item.title}>{item.title}</h3>
                    <p>{item.caption || (item.speech_ready ? '视频语音已整理' : '发布文案暂不可用')}</p>
                    <div className={styles.readiness} data-ready={item.speech_ready}>
                      <Captions size={14} />
                      <span>{sourceLabel(item)}</span>
                      <b>{item.transcript_chars.toLocaleString('zh-CN')} 字</b>
                    </div>
                    <div className={styles.actions}>
                      <Link href={`/library/detail?note=${encodeURIComponent(item.id)}`}>
                        打开完整文案
                      </Link>
                      {!item.ai_initialized ? (
                        <button
                          type="button"
                          onClick={() => void initialize(item)}
                          disabled={Boolean(initializingId)}
                        >
                          {initializingId === item.id
                            ? <LoaderCircle size={15} className="animate-spin" />
                            : <NotebookPen size={15} />}
                          生成摘要
                        </button>
                      ) : (
                        <Link href={`/notes?id=${encodeURIComponent(item.id)}`}>
                          查看摘要
                        </Link>
                      )}
                      <a href={item.source_url} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} />来源
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : filter !== 'douyin' && (
            <div className={styles.empty}>
              <FileText size={22} />
              <strong>{search ? '没有匹配的跨平台资料' : '还没有 B站或小红书资料'}</strong>
              <span>{search ? '换个关键词，或切换平台筛选。' : '在“添加 / 同步”中导入分享链接。'}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
