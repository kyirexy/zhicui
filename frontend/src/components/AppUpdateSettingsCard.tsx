'use client';

import {
  CheckCircle2,
  Download,
  Globe2,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkAndroidAppUpdate,
  formatReleaseDate,
  formatReleaseSize,
  openAndroidReleaseDownload,
  type AndroidUpdateCheck,
} from '@/lib/appUpdate';

export default function AppUpdateSettingsCard() {
  const mountedRef = useRef(true);
  const [result, setResult] = useState<AndroidUpdateCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const checkForUpdate = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const nextResult = await checkAndroidAppUpdate();
      if (mountedRef.current) setResult(nextResult);
    } catch (checkError) {
      if (mountedRef.current) {
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
    void checkForUpdate();
    return () => {
      mountedRef.current = false;
    };
  }, [checkForUpdate]);

  const openDownload = async () => {
    if (!result?.release || opening) return;
    setOpening(true);
    setError('');
    try {
      await openAndroidReleaseDownload(result.release.download_url);
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

  const isWeb = result?.status === 'unsupported';
  const hasUpdate = result?.status === 'update-available';

  return (
    <section className="rounded-2xl border border-card-border bg-card-bg p-5">
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-accent-emerald">
          {isWeb ? (
            <Globe2 size={20} aria-hidden="true" />
          ) : (
            <Smartphone size={20} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground text-balance">
            {isWeb ? 'Web 版' : 'Android 版本与更新'}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-foreground-muted text-pretty">
            {isWeb
              ? '网页会自动使用线上最新功能，无需下载安装更新。'
              : result
                ? `当前安装 ${result.installed.version} (${result.installed.build})`
                : '正在读取设备版本…'}
          </p>
        </div>
        {result?.status === 'current' && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-accent-emerald">
            <CheckCircle2 size={14} aria-hidden="true" />
            已是最新版
          </span>
        )}
      </header>

      {result?.release && (
        <div className="mt-4 border-t border-card-border pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-xs text-foreground-muted">
                {hasUpdate ? '发现新版本' : '当前版本更新日志'}
              </p>
              <p className="mt-0.5 text-lg font-semibold text-foreground tabular-nums">
                {result.release.version} ({result.release.build})
              </p>
            </div>
            <p className="text-xs text-foreground-muted tabular-nums">
              {formatReleaseDate(result.release.published_at)}
              {' · '}
              {formatReleaseSize(result.release.size_bytes)}
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-card-border bg-background/45 p-4">
            <h3 className="text-sm font-semibold text-foreground">更新日志</h3>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-foreground-secondary">
              {result.release.release_notes.map((note) => (
                <li key={note} className="flex gap-2 text-pretty">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-emerald" aria-hidden="true" />
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

      <div className="mt-4 flex flex-wrap gap-2">
        {!isWeb && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-card-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={checking}
            onClick={checkForUpdate}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {checking ? '正在检查…' : '检查更新'}
          </button>
        )}
        {hasUpdate && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={opening}
            onClick={openDownload}
          >
            <Download size={17} aria-hidden="true" />
            {opening ? '正在打开…' : '下载最新版'}
          </button>
        )}
        {isWeb && (
          <a
            href="/download/zhicui.apk"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
          >
            <Download size={17} aria-hidden="true" />
            下载 Android App
          </a>
        )}
      </div>
    </section>
  );
}
