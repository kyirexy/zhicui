'use client';

import { ArrowRight, Check, Download, LoaderCircle, RefreshCw, RotateCw, X } from 'lucide-react';
import { desktopUpdatePresentation } from '@/lib/desktopUpdate';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import styles from './DesktopUpdateCard.module.css';

export default function DesktopUpdateCard({ onClose, titleId = 'desktop-update-title' }: {
  onClose?: () => void;
  titleId?: string;
}) {
  const state = useDesktopUpdate();
  const view = desktopUpdatePresentation(state);
  const installed = state.runtime?.version || state.update.installedVersion;
  const Icon = view.canInstall || view.installing ? RotateCw
    : view.action === 'download' ? Download
    : state.busy || view.downloading || state.update.status === 'checking' ? LoaderCircle : RefreshCw;
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      {onClose && <button className={styles.close} type="button" aria-label="关闭更新窗口" onClick={onClose}><X size={20} aria-hidden="true" /></button>}
      <header className={styles.header}>
        <img className={styles.logo} src="/icons/icon-192.png" alt="" width={56} height={56} />
        <div>
          <h2 id={titleId}>{view.title}</h2>
          <p>{view.description}</p>
        </div>
      </header>
      <div className={styles.version}>
        <span>当前版本 <strong>{installed || '读取中'}</strong></span>
        {view.version && <><ArrowRight size={16} aria-hidden="true" /><span>新版本 <strong>{view.version}</strong></span></>}
        {!view.version && state.update.status === 'current' && <Check size={18} className={styles.current} aria-label="已是最新版" />}
      </div>
      {view.downloading && (
        <div className={styles.download}>
          <div className={styles.progressLabel}><span>下载更新</span><strong>{view.progress}%</strong></div>
          <div className={styles.progress} role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress}>
            <span style={{ transform: `scaleX(${view.progress / 100})` }} />
          </div>
        </div>
      )}
      {view.version && !view.downloading && !view.canInstall && (
        <div className={styles.notes}>
          <h3>本次更新</h3>
          <p>功能优化，使用更顺畅。</p>
        </div>
      )}
      {state.issue && <p className={styles.error} role="alert">{state.issue}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={view.disabled} onClick={() => void state.run(view.action)}>
          <Icon size={18} aria-hidden="true" className={state.busy || view.downloading || state.update.status === 'checking' ? styles.spinning : undefined} />
          {view.label}
        </button>
        {onClose && <button type="button" className={styles.secondary} onClick={onClose}>{view.downloading ? '继续使用' : '稍后再说'}</button>}
      </div>
      {state.update.status === 'error' && view.fallback && !view.manual && (
        <button type="button" className={styles.textButton} disabled={Boolean(state.busy) || state.openedVersion === state.release?.version} onClick={() => void state.run('download')}>
          {state.openedVersion === state.release?.version ? '安装包已打开，请完成下载后安装' : '更新仍未完成？重新下载'}
        </button>
      )}
      {view.alreadyOpened && <button type="button" className={styles.textButton} disabled={Boolean(state.busy)} onClick={() => void state.redownload()}>下载没有开始？重新下载</button>}
      <p className={styles.footnote}>{view.manual ? '无需卸载，直接安装即可。' : '账号和资料会保留。'}</p>
    </section>
  );
}
