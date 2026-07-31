'use client';

import { RefreshCw, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { DesktopUpdateResult } from '@/lib/desktopRuntime';

const DISMISSED_VERSION_KEY = 'zhicui_desktop_update_dismissed_version';

export default function DesktopUpdatePrompt() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [update, setUpdate] = useState<DesktopUpdateResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const bridge = window.zhicuiDesktop;
    if (!bridge) return undefined;
    let active = true;

    const acceptState = (state: DesktopUpdateResult) => {
      if (!active || state.status !== 'downloaded') return;
      if (
        sessionStorage.getItem(DISMISSED_VERSION_KEY)
        === (state.version || '')
      ) {
        return;
      }
      setUpdate(state);
    };

    const unsubscribe = bridge.onUpdateStatus(acceptState);
    void bridge.getUpdateState().then(acceptState).catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (update && !dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  }, [update]);

  const dismiss = () => {
    if (update?.version) {
      sessionStorage.setItem(DISMISSED_VERSION_KEY, update.version);
    }
    dialogRef.current?.close();
    setUpdate(null);
    setError('');
  };

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) dismiss();
  };

  const install = async () => {
    if (!window.zhicuiDesktop || installing) return;
    setInstalling(true);
    setError('');
    try {
      const result = await window.zhicuiDesktop.installUpdate();
      if (result.status === 'error') {
        setError(result.error || '暂时无法安装，请稍后重试');
        setInstalling(false);
      }
    } catch {
      setError('暂时无法安装，请稍后重试');
      setInstalling(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-update-dialog"
      aria-labelledby="desktop-update-title"
      aria-describedby="desktop-update-description"
      onClick={handleBackdrop}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      {update && (
        <div className="app-update-card">
          <header className="app-update-header">
            <div className="app-update-icon" aria-hidden="true">
              <RefreshCw size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="app-update-eyebrow">新版已准备好</p>
              <h2 id="desktop-update-title" className="text-balance">
                知萃 {update.version} 已下载完成
              </h2>
            </div>
            <button
              type="button"
              className="app-update-close"
              aria-label="稍后安装"
              onClick={dismiss}
            >
              <X size={19} aria-hidden="true" />
            </button>
          </header>

          <p id="desktop-update-description" className="app-update-description text-pretty">
            重启后会自动完成安装，再回到你当前使用的知萃账号。未完成的输入请先保存。
          </p>

          <dl className="app-update-meta">
            <div>
              <dt>当前版本</dt>
              <dd className="tabular-nums">{update.installedVersion}</dd>
            </div>
            <div>
              <dt>最新版本</dt>
              <dd className="tabular-nums">{update.version}</dd>
            </div>
          </dl>

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
              disabled={installing}
              onClick={install}
            >
              <RotateCw size={18} aria-hidden="true" />
              {installing ? '正在重启…' : '重启并安装'}
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
