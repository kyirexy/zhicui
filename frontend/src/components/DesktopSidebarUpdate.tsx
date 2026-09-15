'use client';

import { Check, ChevronRight, CircleAlert, Download, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { desktopUpdatePresentation } from '@/lib/desktopUpdate';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { useWebBuildUpdate } from '@/lib/hooks/useWebBuildUpdate';
import { webBuildUpdatePresentation } from '@/lib/webBuildUpdateFlow';
import webStyles from './WebBuildUpdatePrompt.module.css';
import DesktopUpdateCard from './DesktopUpdateCard';
import styles from './DesktopUpdateCard.module.css';

export default function DesktopSidebarUpdate() {
  const state = useDesktopUpdate();
  const view = desktopUpdatePresentation(state);
  const webUpdate = useWebBuildUpdate();
  const webView = webBuildUpdatePresentation(webUpdate);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const label = view.canInstall ? '重启更新' : view.downloading ? `下载更新 ${view.progress}%`
    : view.installing ? '正在重启…' : state.update.status === 'error' ? '更新暂未完成' : '发现新版本';
  const Icon = view.canInstall ? Check : view.downloading || view.installing ? LoaderCircle
    : state.update.status === 'error' ? CircleAlert : Download;
  return (
    <>
      {webView.visible && (
        <div className={webStyles.sidebar} role="status">
          <button type="button" className={webStyles.sidebarButton} disabled={webView.disabled}
            aria-label={webView.label}
            onClick={() => { if (webUpdate.phase === 'error') void webUpdate.retry(); else webUpdate.refresh(); }}>
            <Download size={18} aria-hidden="true" />
            <span><strong>{webView.title}</strong><small>{webView.description}</small></span>
          </button>
          {webView.preparing && webUpdate.total > 0 && <progress className={webStyles.progress}
            aria-label="新版页面资源准备进度" value={webUpdate.completed} max={webUpdate.total} />}
        </div>
      )}
      {view.attention && (
        <div className={`${styles.sidebar} ${view.canInstall ? styles.sidebarReady : ''}`}>
          <button type="button" className={styles.sidebarButton} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
            <Icon size={18} aria-hidden="true" />
            <span><strong>{label}</strong><small>{view.version ? `知萃 ${view.version}` : '点击查看更新'}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
          {view.downloading && <div className={styles.progress} aria-hidden="true"><span style={{ transform: `scaleX(${view.progress / 100})` }} /></div>}
        </div>
      )}
      <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="desktop-sidebar-update-title"
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <DesktopUpdateCard titleId="desktop-sidebar-update-title" onClose={() => setOpen(false)} />
      </dialog>
    </>
  );
}
