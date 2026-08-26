'use client';

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  Download,
  RefreshCw,
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
  fetchLatestAndroidRelease,
  formatReleaseDate,
  formatReleaseSize,
  openAndroidReleaseDownload,
  type AndroidReleaseManifest,
  type RuntimeAppInfo,
} from '@/lib/appUpdate';
import { useAuth } from '@/lib/hooks/AuthContext';

const DISMISSED_BUILD_KEY = 'zhicui_update_dismissed_build';
const PERIODIC_UPDATE_CHECK_MS = 60 * 60_000;

interface AvailableUpdate {
  installed: RuntimeAppInfo;
  release: AndroidReleaseManifest;
}

export default function AppUpdatePrompt() {
  const { user, loading: authLoading } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading || !user) return undefined;
    let active = true;
    const isDevelopmentPreview = (
      process.env.NODE_ENV === 'development'
      && new URLSearchParams(window.location.search).get('previewUpdate') === '1'
    );
    if (isDevelopmentPreview) {
      void fetchLatestAndroidRelease()
        .then((release) => {
          if (!active) return;
          setAvailable({
            installed: {
              nativeAndroid: true,
              version: '1.0.0',
              build: Math.max(0, release.build - 1),
            },
            release,
          });
        })
        .catch(() => {});
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
    }
  }, [available]);

  const dismiss = () => {
    if (available) {
      sessionStorage.setItem(
        DISMISSED_BUILD_KEY,
        String(available.release.build),
      );
    }
    dialogRef.current?.close();
    setAvailable(null);
    setError('');
  };

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) dismiss();
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
      className="app-update-dialog"
      aria-labelledby="app-update-title"
      aria-describedby="app-update-description"
      onClick={handleBackdrop}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      {available && (
        <div className="app-update-card">
          <header className="app-update-header">
            <div className="app-update-icon" aria-hidden="true">
              <RefreshCw size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="app-update-eyebrow">发现新版本</p>
              <h2 id="app-update-title" className="text-balance">
                知萃 {available.release.version} 可以更新
              </h2>
            </div>
            <button
              type="button"
              className="app-update-close"
              aria-label="稍后更新"
              onClick={dismiss}
            >
              <X size={19} aria-hidden="true" />
            </button>
          </header>

          <p id="app-update-description" className="app-update-description text-pretty">
            更新后即可使用本次新增功能。安装过程由系统浏览器和 Android
            安全确认完成。
          </p>

          <dl className="app-update-meta">
            <div>
              <dt>当前版本</dt>
              <dd className="tabular-nums">
                {available.installed.version} ({available.installed.build})
              </dd>
            </div>
            <div>
              <dt>最新版本</dt>
              <dd className="tabular-nums">
                {available.release.version} ({available.release.build})
              </dd>
            </div>
            <div>
              <dt>安装包</dt>
              <dd className="tabular-nums">
                {formatReleaseSize(available.release.size_bytes)}
              </dd>
            </div>
            <div>
              <dt>发布时间</dt>
              <dd>
                <time dateTime={available.release.published_at}>
                  {formatReleaseDate(available.release.published_at)}
                </time>
              </dd>
            </div>
          </dl>

          <section className="app-update-notes" aria-labelledby="app-update-notes-title">
            <h3 id="app-update-notes-title">本次更新</h3>
            <ul>
              {available.release.release_notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>

          <div className="app-update-safety">
            <ShieldCheck size={17} aria-hidden="true" />
            <p className="text-pretty">
              下载地址仅限 luxai.cn，不会在知萃数据库中保存安装包。
            </p>
          </div>

          {error && (
            <p className="app-update-error" role="alert">
              {error}
            </p>
          )}

          <footer className="app-update-actions">
            <button type="button" className="app-update-later" onClick={dismiss}>
              稍后
            </button>
            <button
              type="button"
              className="app-update-primary"
              disabled={opening}
              onClick={updateNow}
            >
              {opening ? (
                <RefreshCw size={18} aria-hidden="true" />
              ) : (
                <Download size={18} aria-hidden="true" />
              )}
              {opening ? '正在打开…' : '立即更新'}
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
