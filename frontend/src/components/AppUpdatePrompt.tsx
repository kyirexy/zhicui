'use client';

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  ArrowRight,
  Download,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import {
  checkAndroidAppUpdate,
  formatReleaseDate,
  formatReleaseSize,
  openAndroidReleaseDownload,
  type AndroidReleaseManifest,
  type RuntimeAppInfo,
} from '@/lib/appUpdate';
import { useAuth } from '@/lib/hooks/AuthContext';
import { releaseChannelLabel } from '@/lib/releaseChannel';
import styles from './AppUpdatePrompt.module.css';

const DISMISSED_BUILD_KEY = 'zhicui_update_dismissed_build';
const PERIODIC_UPDATE_CHECK_MS = 60 * 60_000;

interface AvailableUpdate {
  installed: RuntimeAppInfo;
  release: AndroidReleaseManifest;
}

const DEVELOPMENT_PREVIEW_UPDATE: AvailableUpdate = {
  installed: {
    nativeAndroid: true,
    version: '1.2.9',
    build: 21,
  },
  release: {
    schema_version: 2,
    channel: 'beta',
    availability: 'available',
    platform: 'android',
    artifact_kind: 'debug',
    version: '1.3.0',
    build: 22,
    published_at: '2026-09-01T00:00:00.000Z',
    download_url: 'https://luxai.cn/download/zhicui.apk',
    size_bytes: 10_064_176,
    mandatory: false,
    release_notes: [
      '更新弹窗改为更适合手机操作的底部面板。',
      '精简版本信息，让更新内容和主要操作更清楚。',
      '完善横屏、安全区与强制更新状态。',
    ],
  },
};

export default function AppUpdatePrompt() {
  const { user, loading: authLoading } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const isDevelopmentPreview = (
      process.env.NODE_ENV === 'development'
      && new URLSearchParams(window.location.search).get('previewUpdate') === '1'
    );
    if (!isDevelopmentPreview && (authLoading || !user)) return undefined;
    let active = true;
    if (isDevelopmentPreview) {
      setAvailable(DEVELOPMENT_PREVIEW_UPDATE);
      return () => {
        active = false;
      };
    }
    void checkAndroidAppUpdate()
      .then((result) => {
        if (!active || result.status !== 'update-available') return;
        const dismissedBuild = sessionStorage.getItem(DISMISSED_BUILD_KEY);
        if (dismissedBuild === String(result.release.build)) return;
        setAvailable({
          installed: result.installed,
          release: result.release,
        });
      })
      .catch(() => {
        // Automatic update checks must never interrupt the main product flow.
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  useEffect(() => {
    if (authLoading || !user) return undefined;
    const nativeAndroid = (
      Capacitor.isNativePlatform()
      && Capacitor.getPlatform() === 'android'
    );
    if (!nativeAndroid) return undefined;

    let disposed = false;
    const intervalId = window.setInterval(() => {
      void checkAndroidAppUpdate()
        .then((result) => {
          if (disposed || result.status !== 'update-available') return;
          const dismissedBuild = sessionStorage.getItem(DISMISSED_BUILD_KEY);
          if (dismissedBuild === String(result.release.build)) return;
          setAvailable({ installed: result.installed, release: result.release });
        })
        .catch(() => {
          // A periodic check is advisory and never blocks the current session.
        });
    }, PERIODIC_UPDATE_CHECK_MS);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [authLoading, user]);

  useEffect(() => {
    if (authLoading || !user) return undefined;
    const nativeAndroid = (
      Capacitor.isNativePlatform()
      && Capacitor.getPlatform() === 'android'
    );
    if (!nativeAndroid) return undefined;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive || disposed) return;
      void checkAndroidAppUpdate()
        .then((result) => {
          if (disposed || result.status !== 'update-available') return;
          const dismissedBuild = sessionStorage.getItem(DISMISSED_BUILD_KEY);
          if (dismissedBuild === String(result.release.build)) return;
          setAvailable({
            installed: result.installed,
            release: result.release,
          });
        })
        .catch(() => {
          // Returning to the app must stay usable when the update service is offline.
        });
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
  }, [authLoading, user]);

  useEffect(() => {
    if (available && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
      primaryActionRef.current?.focus();
    }
  }, [available]);

  const dismiss = () => {
    if (!available || available.release.mandatory) return;
    sessionStorage.setItem(
      DISMISSED_BUILD_KEY,
      String(available.release.build),
    );
    dialogRef.current?.close();
    setAvailable(null);
    setError('');
  };

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget && !available?.release.mandatory) {
      dismiss();
    }
  };

  const updateNow = async () => {
    if (!available || opening) return;
    setOpening(true);
    setError('');
    try {
      await openAndroidReleaseDownload(available.release.download_url);
      dismiss();
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

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="app-update-title"
      aria-describedby="app-update-description"
      onClick={handleBackdrop}
      onCancel={(event) => {
        event.preventDefault();
        if (!available?.release.mandatory) dismiss();
      }}
    >
      {available && (
        <div className={styles.panel}>
          <div className={styles.handle} aria-hidden="true" />

          <header className={styles.header}>
            <div className={styles.appIcon} aria-hidden="true">
              <img src="/icons/icon-192.png" alt="" width="54" height="54" />
            </div>
            <div className={styles.heading}>
              <span className={styles.channelBadge}>
                {releaseChannelLabel(available.release.channel)}
                {available.release.mandatory ? ' · 必须更新' : ''}
              </span>
              <h2 id="app-update-title">
                知萃 {available.release.version} 已就绪
              </h2>
              <p id="app-update-description">
                {available.release.mandatory
                  ? '需要完成本次更新后继续使用，账号和资料会保留。'
                  : '更新后即可使用最新功能，账号和资料会保留。'}
              </p>
            </div>
            {!available.release.mandatory && (
              <button
                type="button"
                className={styles.close}
                aria-label="稍后提醒"
                onClick={dismiss}
              >
                <X size={20} aria-hidden="true" />
              </button>
            )}
          </header>

          <div className={styles.content}>
            <section className={styles.versionCard} aria-label="版本信息">
              <div className={styles.versionItem}>
                <span>当前版本</span>
                <strong className="tabular-nums">
                  {available.installed.version}
                  <small>({available.installed.build})</small>
                </strong>
              </div>
              <ArrowRight className={styles.versionArrow} size={19} aria-hidden="true" />
              <div className={`${styles.versionItem} ${styles.latestVersion}`}>
                <span>最新版本</span>
                <strong className="tabular-nums">
                  {available.release.version}
                  <small>({available.release.build})</small>
                </strong>
              </div>
              <p className={styles.releaseMeta}>
                <span>{formatReleaseSize(available.release.size_bytes)}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={available.release.published_at}>
                  {formatReleaseDate(available.release.published_at)}
                </time>
              </p>
            </section>

            <section className={styles.notes} aria-labelledby="app-update-notes-title">
              <h3 id="app-update-notes-title">更新内容</h3>
              <ul>
                {available.release.release_notes.slice(0, 4).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              {available.release.release_notes.length > 4 && (
                <p className={styles.moreNotes}>
                  还有 {available.release.release_notes.length - 4} 项改进
                </p>
              )}
            </section>

            <div className={styles.safety}>
              <ShieldCheck size={18} aria-hidden="true" />
              <p>
                安装包来自 luxai.cn，Android 系统会在安装前再次确认。
              </p>
            </div>

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>

          <footer className={`${styles.actions} ${available.release.mandatory ? styles.mandatoryActions : ''}`}>
            {!available.release.mandatory && (
              <button type="button" className={styles.later} onClick={dismiss}>
                稍后提醒
              </button>
            )}
            <button
              ref={primaryActionRef}
              type="button"
              className={styles.primary}
              disabled={opening}
              onClick={updateNow}
            >
              {opening ? (
                <LoaderCircle className={styles.spinner} size={19} aria-hidden="true" />
              ) : (
                <Download size={19} aria-hidden="true" />
              )}
              {opening ? '正在打开…' : '下载并更新'}
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
