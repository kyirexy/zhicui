'use client';

import {
  Check,
  CircleAlert,
  Download,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DesktopUpdateResult } from '@/lib/desktopRuntime';

const INITIAL_STATE: DesktopUpdateResult = {
  status: 'idle',
  installedVersion: '',
};

export default function DesktopSidebarUpdate() {
  const [update, setUpdate] = useState<DesktopUpdateResult>(INITIAL_STATE);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const bridge = window.zhicuiDesktop;
    if (!bridge) return undefined;
    let active = true;
    const accept = (state: DesktopUpdateResult) => {
      if (active) setUpdate(state);
    };
    const unsubscribe = bridge.onUpdateStatus(accept);
    void bridge.getUpdateState().then(accept).catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const presentation = useMemo(() => {
    if (update.status === 'available') {
      return { label: '发现新版本', detail: `知萃 ${update.version || ''}`, icon: Download };
    }
    if (update.status === 'downloading') {
      const percent = Math.max(0, Math.min(100, Math.round(update.percent || 0)));
      return { label: `更新中 ${percent}%`, detail: '可以继续使用', icon: LoaderCircle, percent };
    }
    if (update.status === 'downloaded') {
      return {
        label: '重启并安装',
        detail: `知萃 ${update.version || ''} 已下载`,
        icon: Check,
      };
    }
    if (update.status === 'error') {
      return { label: '重试更新', detail: '更新服务暂时不可用', icon: CircleAlert };
    }
    return null;
  }, [update]);

  if (!presentation) return null;
  const Icon = presentation.icon;
  const actionable = update.status === 'downloaded' || update.status === 'error';

  const handleClick = async () => {
    const bridge = window.zhicuiDesktop;
    if (!bridge || !actionable || working) return;
    setWorking(true);
    try {
      const result = update.status === 'downloaded'
        ? await bridge.installUpdate()
        : await bridge.checkForUpdates();
      setUpdate(result);
      if (result.status !== 'downloaded') setWorking(false);
    } catch {
      setWorking(false);
    }
  };

  return (
    <div className="desktop-sidebar__update-shell" role="status" aria-live="polite">
      <button
        type="button"
        className={`desktop-sidebar__update ${update.status === 'downloaded' ? 'is-ready' : ''}`}
        disabled={!actionable || working}
        onClick={() => void handleClick()}
        title={presentation.detail}
      >
        <span className="desktop-sidebar__update-icon" aria-hidden="true">
          <Icon className={update.status === 'downloading' ? 'is-spinning' : ''} size={17} />
        </span>
        <span className="desktop-sidebar__update-copy">
          <strong>{working ? '正在重启…' : presentation.label}</strong>
          <small>{presentation.detail}</small>
        </span>
        {update.status === 'error' && <RefreshCw size={15} aria-hidden="true" />}
      </button>
      {'percent' in presentation && (
        <span className="desktop-sidebar__update-progress" aria-hidden="true">
          <span style={{ width: `${presentation.percent}%` }} />
        </span>
      )}
    </div>
  );
}
