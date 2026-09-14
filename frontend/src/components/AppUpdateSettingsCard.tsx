'use client';

import { Capacitor } from '@capacitor/core';
import { Download, Globe2, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  checkAndroidAppUpdate, formatReleaseDate, formatReleaseSize, getRuntimeAppInfo,
  openAndroidReleaseDownload, type AndroidUpdateCheck,
} from '@/lib/appUpdate';
import { detectDesktopRuntime } from '@/lib/desktopRuntime';
import DesktopUpdateCard from './DesktopUpdateCard';
import styles from './DesktopUpdateCard.module.css';

type RuntimeMode = 'loading' | 'web' | 'android' | 'ios' | 'desktop';

export default function AppUpdateSettingsCard() {
  const mountedRef = useRef(false);
  const actionRef = useRef(false);
  const [mode, setMode] = useState<RuntimeMode>('loading');
  const [androidResult, setAndroidResult] = useState<AndroidUpdateCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);
  const [openedBuild, setOpenedBuild] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void (async () => {
      try {
        const runtime = await detectDesktopRuntime();
        if (!active) return;
        if (runtime || window.zhicuiDesktop) { setMode('desktop'); return; }
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') { setMode('ios'); return; }
        const installed = await getRuntimeAppInfo();
        if (!active) return;
        setMode(installed.nativeAndroid ? 'android' : 'web');
        if (installed.nativeAndroid) {
          const result = await checkAndroidAppUpdate();
          if (active) setAndroidResult(result);
        }
      } catch {
        if (active) setError('暂时无法检查更新，请稍后重试。');
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; mountedRef.current = false; };
  }, []);

  const check = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setChecking(true); setError('');
    try {
      const result = await checkAndroidAppUpdate();
      if (mountedRef.current) setAndroidResult(result);
    } catch {
      if (mountedRef.current) setError('暂时无法检查更新，请稍后重试。');
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setChecking(false);
    }
  };
  const download = async () => {
    if (actionRef.current || !androidResult?.release) return;
    actionRef.current = true;
    setOpening(true); setError('');
    try {
      // 每次主动下载重新确认当前渠道的版本，不使用过期的弹窗快照。
      const fresh = await checkAndroidAppUpdate();
      if (!mountedRef.current) return;
      setAndroidResult(fresh);
      if (fresh.status !== 'update-available') return;
      await openAndroidReleaseDownload(fresh.release.download_url);
      if (mountedRef.current) setOpenedBuild(fresh.release.build);
    } catch {
      if (mountedRef.current) setError('暂时无法打开安装包，请检查网络后重试。');
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  };

  if (mode === 'desktop') return <DesktopUpdateCard titleId="settings-desktop-update-title" />;
  const release = androidResult?.release;
  const hasUpdate = androidResult?.status === 'update-available';
  const alreadyOpened = Boolean(release && openedBuild === release.build);
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        {mode === 'web' ? <Globe2 size={28} aria-hidden="true" /> : <Smartphone size={28} aria-hidden="true" />}
        <div>
          <h2>{mode === 'web' ? '在更多设备使用知萃' : mode === 'loading' ? '正在读取版本' : '知萃版本与更新'}</h2>
          <p>{mode === 'android' ? `当前版本 ${androidResult?.installed.version || '读取中'}`
            : mode === 'ios' ? '请通过原安装方式更新，账号和资料会保留。'
            : mode === 'web' ? '安装客户端，在电脑或手机上继续使用。' : '稍等片刻。'}</p>
        </div>
      </header>
      {release && (
        <>
          <div className={styles.version}>
            <span>{hasUpdate ? '新版本' : '已是最新版'} <strong>{release.version}</strong></span>
            <span>{formatReleaseSize(release.size_bytes)} · {formatReleaseDate(release.published_at)}</span>
          </div>
          <div className={styles.notes}><h3>这次更新</h3><ul>{release.release_notes.map((note) => <li key={note}>{note}</li>)}</ul></div>
        </>
      )}
      {androidResult?.status === 'release-unavailable' && <p className={styles.footnote}>暂未发现可用更新，可以继续使用当前版本。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        {mode === 'android' && <>
          {hasUpdate && <button type="button" className={styles.primary} disabled={checking || opening || alreadyOpened} onClick={() => void download()}>
            <Download size={18} aria-hidden="true" />{opening ? '正在确认版本…' : alreadyOpened ? '已打开下载' : '下载并安装'}
          </button>}
          <button type="button" className={hasUpdate ? styles.secondary : styles.primary} disabled={checking || opening} onClick={() => void check()}><RefreshCw size={18} aria-hidden="true" />{checking ? '正在检查…' : '检查更新'}</button>
        </>}
        {mode === 'web' && <>
          <a href="/api/client-downloads/android" className={styles.primary}>下载 Android 版</a>
          <a href="/api/client-downloads/windows" className={styles.secondary}>下载 Windows 版</a>
        </>}
      </div>
      {mode === 'android' && hasUpdate && <p className={styles.footnote}>{alreadyOpened ? '请在浏览器下载中打开安装包，按系统提示完成更新。' : '下载后按 Android 系统提示安装，账号和资料会保留。'}</p>}
      {alreadyOpened && <button type="button" className={styles.textButton} disabled={opening || checking} onClick={() => void download()}>下载没有开始？重新下载</button>}
    </section>
  );
}
