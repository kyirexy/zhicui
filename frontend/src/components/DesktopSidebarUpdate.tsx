'use client';

import { Check, ChevronRight, CircleAlert, Download, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { currentWebBuild } from '@/lib/webBuildUpdate';
import { desktopUpdatePresentation } from '@/lib/desktopUpdate';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { useWebBuildUpdate } from '@/lib/hooks/useWebBuildUpdate';
import { webBuildUpdatePresentation } from '@/lib/webBuildUpdateFlow';
import webStyles from './WebBuildUpdatePrompt.module.css';
import DesktopUpdateCard from './DesktopUpdateCard';
import styles from './DesktopUpdateCard.module.css';

function shouldShowUpdateDialog(key: string): boolean {
  try {
    if (sessionStorage.getItem(key) === 'shown') return false;
    sessionStorage.setItem(key, 'shown');
  } catch {
    // 隐私模式禁止 sessionStorage 时仍然展示一次当前会话的更新提示。
  }
  return true;
}

export default function DesktopSidebarUpdate() {
  const state = useDesktopUpdate();
  const view = desktopUpdatePresentation(state);
  const webUpdate = useWebBuildUpdate();
  const webView = webBuildUpdatePresentation(webUpdate);
  const [open, setOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const webDialogRef = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const currentWebVersion = currentWebBuild().version;

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = webDialogRef.current;
    if (webOpen && dialog && !dialog.open) dialog.showModal();
    if (!webOpen && dialog?.open) dialog.close();
  }, [webOpen]);

  // 首次发现版本时主动打开详情；同一版本只提示一次，用户仍可从侧栏再次打开。
  useEffect(() => {
    if (!view.version || state.update.status === 'current' || typeof window === 'undefined') return;
    const key = `zhicui-desktop-update-dialog:${view.version}`;
    if (!shouldShowUpdateDialog(key)) return;
    setOpen(true);
  }, [state.update.status, view.version]);

  useEffect(() => {
    if (!webView.visible || !webUpdate.available || typeof window === 'undefined') return;
    // 原生安装包弹窗优先，避免两个更新对话框同时出现。
    if (view.version) return;
    if (!['preparing', 'ready', 'deferred', 'error'].includes(webUpdate.phase)) return;
    const key = `zhicui-web-update-dialog:${webUpdate.available.build_id}`;
    if (!shouldShowUpdateDialog(key)) return;
    setWebOpen(true);
  }, [view.version, webUpdate.available, webUpdate.phase, webView.visible]);

  const label = view.canInstall ? '重启更新' : view.downloading ? `下载更新 ${view.progress}%`
    : view.installing ? '正在重启…' : state.update.status === 'error' ? '更新暂未完成' : '发现新版本';
  const Icon = view.canInstall ? Check : view.downloading || view.installing ? LoaderCircle
    : state.update.status === 'error' ? CircleAlert : Download;
  const webLabel = webView.preparing ? '正在准备页面更新'
    : webUpdate.phase === 'error' ? '页面更新暂未完成'
    : webUpdate.phase === 'reloading' ? '正在更新页面'
    : '网页新版本已准备好';
  const webDescription = webView.preparing
    ? (webUpdate.total ? `新版页面 ${webUpdate.completed}/${webUpdate.total} 项资源` : '正在准备新版页面资源')
    : webUpdate.phase === 'error' ? webUpdate.error
    : webUpdate.phase === 'deferred' ? '当前操作完成后自动刷新，也可查看更新详情。'
    : `网页 ${webUpdate.available?.version || '新版'} · 空闲时自动刷新`;
  const webActionLabel = webUpdate.phase === 'error' ? '重试准备'
    : webUpdate.phase === 'preparing' ? '准备中…'
    : webUpdate.phase === 'reloading' ? '正在更新…' : '立即更新页面';
  const webActionDisabled = webView.preparing || webUpdate.phase === 'reloading' || webView.waiting;
  return (
    <>
      {webView.visible && (
        <div className={webStyles.sidebar} role="status">
          <button type="button" className={webStyles.sidebarButton}
            aria-label="查看网页更新详情" aria-haspopup="dialog" aria-expanded={webOpen}
            onClick={() => setWebOpen(true)}>
            {webView.preparing ? <LoaderCircle className={webStyles.spin} size={18} aria-hidden="true" />
              : webUpdate.phase === 'error' ? <CircleAlert size={18} aria-hidden="true" />
              : <Download size={18} aria-hidden="true" />}
            <span><strong>{webLabel}</strong><small>{webDescription}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
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
      <dialog ref={webDialogRef} className={webStyles.dialog} data-web-update-dialog
        aria-labelledby="desktop-web-update-title" aria-describedby="desktop-web-update-description"
        onCancel={(event) => { event.preventDefault(); setWebOpen(false); }}
        onClick={(event) => { if (event.target === event.currentTarget) setWebOpen(false); }}>
        <section className={webStyles.updatePanel}>
          <button type="button" className={webStyles.close} aria-label="稍后更新页面" onClick={() => setWebOpen(false)}>
            <X size={18} aria-hidden="true" />
          </button>
          <header className={webStyles.updateHeader}>
            <span className={webStyles.updateIcon} aria-hidden="true"><Sparkles size={22} /></span>
            <div>
              <h2 id="desktop-web-update-title">{webLabel}</h2>
              <p id="desktop-web-update-description">网页更新不需要重新下载安装包，当前账号和资料会保留。</p>
            </div>
          </header>
          <div className={webStyles.updateVersions} aria-label="网页版本信息">
            <span>当前页面 <strong>{currentWebVersion}</strong></span>
            <ChevronRight size={16} aria-hidden="true" />
            <span>新版本 <strong>{webUpdate.available?.version || '读取中'}</strong></span>
          </div>
          <p className={webStyles.updateDescription}>{webDescription}</p>
          {webView.preparing && (
            <div className={webStyles.updateProgress}>
              <div className={webStyles.progressLabel}>
                <span>准备新版资源</span>
                <strong>{webUpdate.total ? `${webUpdate.completed}/${webUpdate.total}` : '准备中…'}</strong>
              </div>
              {webUpdate.total > 0
                ? <progress className={webStyles.progress} aria-label="新版页面资源准备进度" value={webUpdate.completed} max={webUpdate.total} />
                : <div className={webStyles.indeterminate} aria-label="正在准备新版页面资源" />}
            </div>
          )}
          {webUpdate.phase === 'ready' && <p className={webStyles.ready} role="status">新版资源已准备完成，点击“立即更新页面”即可刷新到新版本。</p>}
          {webUpdate.phase === 'deferred' && <p className={webStyles.ready} role="status">当前操作结束后会自动刷新；也可以先关闭此窗口继续使用。</p>}
          {webUpdate.phase === 'error' && <p className={webStyles.error} role="alert">{webUpdate.error || '页面资源准备失败，请重试。'}</p>}
          <footer className={webStyles.updateActions}>
            <button type="button" className={webStyles.later} onClick={() => setWebOpen(false)}>稍后更新</button>
            <button type="button" className={webStyles.refresh} disabled={webActionDisabled}
              onClick={() => { if (webUpdate.phase === 'error') void webUpdate.retry(); else void webUpdate.refresh(); }}>
              {webView.preparing || webUpdate.phase === 'reloading'
                ? <LoaderCircle className={webStyles.spin} size={17} aria-hidden="true" />
                : <RefreshCw size={17} aria-hidden="true" />}
              {webActionLabel}
            </button>
          </footer>
        </section>
      </dialog>
    </>
  );
}
