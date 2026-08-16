'use client';

import {
  Check,
  FolderOpen,
  HardDrive,
  PlayCircle,
  ShieldCheck,
  SpinnerGap,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import {
  supportsDesktopMediaLibrary,
  type DesktopMediaSettings,
} from '@/lib/desktopRuntime';
import styles from './DesktopMediaSettingsCard.module.css';

export default function DesktopMediaSettingsCard() {
  const { isDesktop, resolved } = useDesktopApp();
  const [settings, setSettings] = useState<DesktopMediaSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'toggle' | 'directory' | 'open' | ''>('');
  const [error, setError] = useState('');

  const loadSettings = useCallback(async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setSettings(await bridge.getMediaSettings());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : '暂时无法读取本地媒体设置',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!resolved || !isDesktop) {
      setLoading(false);
      return;
    }
    void loadSettings();
  }, [isDesktop, loadSettings, resolved]);

  if (!resolved || !isDesktop) return null;
  if (!loading && !settings && !supportsDesktopMediaLibrary()) return null;

  const toggleAutoSave = async () => {
    const bridge = window.zhicuiDesktop;
    if (!settings || !supportsDesktopMediaLibrary(bridge) || busy) return;
    setBusy('toggle');
    setError('');
    try {
      setSettings(
        await bridge.setMediaAutoSave(!settings.autoSaveOnPlay),
      );
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : '设置没有保存，请重试',
      );
    } finally {
      setBusy('');
    }
  };

  const chooseDirectory = async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge) || busy) return;
    setBusy('directory');
    setError('');
    try {
      setSettings(await bridge.chooseMediaDirectory());
    } catch (directoryError) {
      setError(
        directoryError instanceof Error
          ? directoryError.message
          : '暂时无法选择目录',
      );
    } finally {
      setBusy('');
    }
  };

  const openDirectory = async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge) || busy) return;
    setBusy('open');
    setError('');
    try {
      const opened = await bridge.openMediaDirectory();
      if (!opened) setError('目录没有打开，请重新选择保存位置');
    } catch {
      setError('目录没有打开，请重新选择保存位置');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className={styles.card} aria-labelledby="desktop-media-settings-title">
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          <HardDrive size={23} weight="duotone" />
        </span>
        <div>
          <h2 id="desktop-media-settings-title">视频文件保存</h2>
          <p>把播放过的视频留在这台电脑，之后可以直接打开。</p>
        </div>
      </header>

      {loading && !settings ? (
        <div className={styles.loading} role="status">
          <SpinnerGap size={18} className={styles.spin} aria-hidden="true" />
          正在读取本地设置
        </div>
      ) : settings ? (
        <div className={styles.body}>
          <div className={styles.modeRow}>
            <span className={styles.modeIcon} aria-hidden="true">
              <PlayCircle size={21} weight="duotone" />
            </span>
            <div className={styles.modeCopy}>
              <strong>自动保存播放过的视频</strong>
              <span>
                {settings.autoSaveOnPlay
                  ? '已开启，第一次播放时保存到下方目录'
                  : '已关闭，只在你手动选择时保存'}
              </span>
            </div>
            <button
              type="button"
              className={`${styles.switch} ${
                settings.autoSaveOnPlay ? styles.switchActive : ''
              }`}
              role="switch"
              aria-checked={settings.autoSaveOnPlay}
              aria-label="播放时自动保存"
              disabled={Boolean(busy)}
              onClick={() => void toggleAutoSave()}
            >
              <span>
                {settings.autoSaveOnPlay && <Check size={12} weight="bold" />}
              </span>
            </button>
          </div>

          <div className={styles.directory}>
            <div className={styles.directoryTop}>
              <div>
                <span>保存位置</span>
                <strong title={settings.directory}>{settings.directory}</strong>
              </div>
              <ShieldCheck size={19} weight="duotone" aria-hidden="true" />
            </div>
            <p>更换目录只影响以后保存的视频，已经保存的文件不会被移动。</p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={Boolean(busy)}
                onClick={() => void chooseDirectory()}
              >
                {busy === 'directory' ? (
                  <SpinnerGap size={16} className={styles.spin} />
                ) : (
                  <FolderOpen size={16} />
                )}
                选择目录
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                disabled={Boolean(busy)}
                onClick={() => void openDirectory()}
              >
                {busy === 'open' ? (
                  <SpinnerGap size={16} className={styles.spin} />
                ) : (
                  <HardDrive size={16} />
                )}
                打开目录
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error && (
        <p className={styles.error} role="alert">
          {error}
          <button type="button" onClick={() => void loadSettings()}>
            重试
          </button>
        </p>
      )}
    </section>
  );
}
