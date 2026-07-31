'use client';

import {
  CheckCircle2,
  Download,
  Globe2,
  MonitorDown,
  RefreshCw,
  RotateCw,
  Smartphone,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkAndroidAppUpdate,
  formatReleaseDate,
  formatReleaseSize,
  getRuntimeAppInfo,
  openAndroidReleaseDownload,
  type AndroidUpdateCheck,
} from '@/lib/appUpdate';
import {
  DESKTOP_DOWNLOAD_URL,
  detectDesktopRuntime,
  type DesktopRuntimeInfo,
  type DesktopUpdateResult,
} from '@/lib/desktopRuntime';

type RuntimeMode = 'loading' | 'web' | 'android' | 'desktop';

export default function AppUpdateSettingsCard() {
  const mountedRef = useRef(true);
  const [mode, setMode] = useState<RuntimeMode>('loading');
  const [androidResult, setAndroidResult] = useState<AndroidUpdateCheck | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopRuntimeInfo | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const initialize = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const runtime = await detectDesktopRuntime();
      if (runtime && window.zhicuiDesktop) {
        if (!mountedRef.current) return;
        setMode('desktop');
        setDesktopInfo(runtime);
        const updateState = await window.zhicuiDesktop.getUpdateState();
        if (!mountedRef.current) return;
        setDesktopUpdate(updateState);
        return;
      }

      const result = await checkAndroidAppUpdate();
      if (!mountedRef.current) return;
      setAndroidResult(result);
      setMode(result.status === 'unsupported' ? 'web' : 'android');
    } catch (checkError) {
      if (mountedRef.current) {
        if (window.zhicuiDesktop) {
          setMode('desktop');
        } else {
          const runtimeInfo = await getRuntimeAppInfo().catch(() => null);
          if (mountedRef.current) {
            setMode(runtimeInfo?.nativeAndroid ? 'android' : 'web');
          }
        }
        setError(
          checkError instanceof Error
            ? checkError.message
            : '暂时无法检查更新，请稍后重试',
        );
      }
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void initialize();
    const bridge = window.zhicuiDesktop;
    const unsubscribe = bridge?.onUpdateStatus((status) => {
      if (!mountedRef.current) return;
      setDesktopUpdate(status);
      setChecking(status.status === 'checking');
      if (status.status === 'error') setError(status.error || '检查更新失败');
      else setError('');
    });
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [initialize]);

  const checkForUpdate = async () => {
    setChecking(true);
    setError('');
    try {
      if (mode === 'desktop' && window.zhicuiDesktop) {
        const result = await window.zhicuiDesktop.checkForUpdates();
        setDesktopUpdate(result);
        if (result.status === 'error') setError(result.error || '检查更新失败');
        return;
      }
      const result = await checkAndroidAppUpdate();
      setAndroidResult(result);
    } catch (checkError) {
      setError(
        checkError instanceof Error
          ? checkError.message
          : '暂时无法检查更新，请稍后重试',
      );
    } finally {
      setChecking(false);
    }
  };

  const openAndroidDownload = async () => {
    if (!androidResult?.release || opening) return;
    setOpening(true);
    setError('');
    try {
      await openAndroidReleaseDownload(androidResult.release.download_url);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : '暂时无法打开下载页面，请稍后重试',
      );
    } finally {
      setOpening(false);
    }
  };

  const installDesktopUpdate = async () => {
    if (!window.zhicuiDesktop || opening) return;
    setOpening(true);
    setError('');
    try {
      const result = await window.zhicuiDesktop.installUpdate();
      if (result.status === 'error') {
        setError(result.error || '暂时无法安装，请稍后重试');
        setOpening(false);
      }
    } catch {
      setError('暂时无法安装，请稍后重试');
      setOpening(false);
    }
  };

  const androidHasUpdate = androidResult?.status === 'update-available';
  const androidCurrent = androidResult?.status === 'current';
  const desktopCurrent = desktopUpdate?.status === 'current';
  const desktopDownloaded = desktopUpdate?.status === 'downloaded';
  const desktopDownloading = desktopUpdate?.status === 'downloading';
  const progress = Math.round(desktopUpdate?.percent || 0);

  const title = mode === 'desktop'
    ? 'Windows 桌面端'
    : mode === 'android'
      ? 'Android 版本与更新'
      : mode === 'web'
        ? '获取知萃客户端'
        : '正在识别当前设备';

  return (
    <section className="rounded-2xl border border-card-border bg-card-bg p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-accent-emerald">
          {mode === 'desktop' ? (
            <MonitorDown size={21} aria-hidden="true" />
          ) : mode === 'android' ? (
            <Smartphone size={21} aria-hidden="true" />
          ) : (
            <Globe2 size={21} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground text-balance">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-foreground-muted text-pretty">
            {mode === 'desktop'
              ? `当前安装 ${desktopInfo?.version || desktopUpdate?.installedVersion || '未知版本'}，启动后会自动检查新版。`
              : mode === 'android'
                ? androidResult
                  ? `当前安装 ${androidResult.installed.version} (${androidResult.installed.build})，启动时自动检查新版。`
                  : '正在读取设备版本…'
                : mode === 'web'
                  ? '网页会自动使用线上最新版；需要本机扫码或独立使用时，可安装对应客户端。'
                  : '正在读取版本信息…'}
          </p>
        </div>
        {(androidCurrent || desktopCurrent) && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-accent-emerald">
            <CheckCircle2 size={14} aria-hidden="true" />
            已是最新版
          </span>
        )}
      </header>

      {desktopDownloading && (
        <div className="mt-4 rounded-xl border border-card-border bg-background/45 p-4" role="status">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-foreground">正在下载 {desktopUpdate.version}</span>
            <span className="tabular-nums text-foreground-muted">{progress}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-foreground/10">
            <span
              className="block h-full rounded-full bg-accent-emerald transition-[width] duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-foreground-muted">可以继续使用，下载完成后会提醒你安装。</p>
        </div>
      )}

      {desktopDownloaded && (
        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <p className="font-semibold text-foreground">知萃 {desktopUpdate.version} 已准备好</p>
          <p className="mt-1 text-sm text-foreground-muted">重启桌面端即可完成安装。</p>
        </div>
      )}

      {androidResult?.release && (
        <div className="mt-4 border-t border-card-border pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-xs text-foreground-muted">
                {androidHasUpdate ? '发现新版本' : '当前版本更新日志'}
              </p>
              <p className="mt-0.5 text-lg font-semibold text-foreground tabular-nums">
                {androidResult.release.version} ({androidResult.release.build})
              </p>
            </div>
            <p className="text-xs text-foreground-muted tabular-nums">
              {formatReleaseDate(androidResult.release.published_at)}
              {' · '}
              {formatReleaseSize(androidResult.release.size_bytes)}
            </p>
          </div>
          <div className="mt-4 rounded-xl border border-card-border bg-background/45 p-4">
            <h3 className="text-sm font-semibold text-foreground">更新日志</h3>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground-secondary">
              {androidResult.release.release_notes.map((note) => (
                <li key={note} className="flex gap-2 text-pretty">
                  <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent-emerald" aria-hidden="true" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        {(mode === 'android' || mode === 'desktop') && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-card-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={checking || desktopDownloading}
            onClick={checkForUpdate}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {checking ? '正在检查…' : desktopDownloading ? '正在下载…' : '检查更新'}
          </button>
        )}
        {androidHasUpdate && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={opening}
            onClick={openAndroidDownload}
          >
            <Download size={17} aria-hidden="true" />
            {opening ? '正在打开…' : '下载最新版'}
          </button>
        )}
        {desktopDownloaded && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
            disabled={opening}
            onClick={installDesktopUpdate}
          >
            <RotateCw size={17} aria-hidden="true" />
            {opening ? '正在重启…' : '重启并安装'}
          </button>
        )}
        {mode === 'web' && (
          <>
            <a
              href="/download/zhicui.apk"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            >
              <Smartphone size={17} aria-hidden="true" />
              下载 Android App
            </a>
            <a
              href={DESKTOP_DOWNLOAD_URL}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-card-border px-4 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-foreground/5"
            >
              <MonitorDown size={17} aria-hidden="true" />
              下载 Windows 桌面端
            </a>
          </>
        )}
      </div>
    </section>
  );
}
