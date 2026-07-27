'use client';

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

const DISMISSED_BUILD_KEY = 'zhicui_update_dismissed_build';

interface AvailableUpdate {
  installed: RuntimeAppInfo;
  release: AndroidReleaseManifest;
}

export default function AppUpdatePrompt() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
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
  }, []);

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
