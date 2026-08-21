'use client';

import {
  ArrowClockwise,
  ArrowSquareOut,
  CloudArrowDown,
  FolderOpen,
  HardDrive,
  Play,
  SpinnerGap,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import {
  supportsDesktopMediaLibrary,
  type DesktopMediaAsset,
  type DesktopMediaSettings,
} from '@/lib/desktopRuntime';
import styles from './DesktopMediaVideoPlayer.module.css';

interface DesktopMediaVideoPlayerProps {
  awemeId: string;
  mediaUrl: string;
  coverUrl: string;
  title: string;
  sourceUrl: string;
  onRefreshMedia: () => Promise<void> | void;
}

type MediaOrientation = 'unknown' | 'portrait' | 'square' | 'landscape';

function getMediaOrientation(width: number, height: number): MediaOrientation {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (ratio < 0.85) return 'portrait';
  if (ratio <= 1.18) return 'square';
  return 'landscape';
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function DesktopMediaVideoPlayer({
  awemeId,
  mediaUrl,
  coverUrl,
  title,
  sourceUrl,
  onRefreshMedia,
}: DesktopMediaVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const startedRef = useRef(false);
  const videoDimensionsKnownRef = useRef(false);
  const [requested, setRequested] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [desktopSupported, setDesktopSupported] = useState(false);
  const [settings, setSettings] = useState<DesktopMediaSettings | null>(null);
  const [asset, setAsset] = useState<DesktopMediaAsset>({
    awemeId,
    status: 'remote',
  });
  const [activeMediaUrl, setActiveMediaUrl] = useState(mediaUrl);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [choosingDownload, setChoosingDownload] = useState(false);
  const [mediaOrientation, setMediaOrientation] = useState<MediaOrientation>('unknown');

  const applyMediaGeometry = useCallback((width: number, height: number) => {
    if (!width || !height) return;
    setMediaOrientation(getMediaOrientation(width, height));
  }, []);

  const applyAsset = useCallback((nextAsset: DesktopMediaAsset) => {
    if (nextAsset.awemeId !== awemeId) return;
    setAsset(nextAsset);
    if (
      nextAsset.status === 'cached'
      && nextAsset.videoUrl
      && !startedRef.current
    ) {
      setActiveMediaUrl(nextAsset.videoUrl);
    }
  }, [awemeId]);

  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  useEffect(() => {
    videoRef.current?.load();
  }, [activeMediaUrl]);

  useEffect(() => {
    setRequested(false);
    setStarted(false);
    startedRef.current = false;
    videoDimensionsKnownRef.current = false;
    setFailed(false);
    setConfirmingRemove(false);
    setChoosingDownload(false);
    setMediaOrientation('unknown');
    setActiveMediaUrl(mediaUrl);

    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge)) {
      setDesktopSupported(false);
      setSettings(null);
      setAsset({ awemeId, status: 'remote' });
      return;
    }

    let active = true;
    setDesktopSupported(true);
    void Promise.all([
      bridge.getMediaSettings(),
      bridge.getMediaAsset(awemeId),
    ]).then(([nextSettings, nextAsset]) => {
      if (!active) return;
      setSettings(nextSettings);
      applyAsset(nextAsset);
    }).catch(() => {
      if (active) setDesktopSupported(false);
    });

    const unsubscribe = bridge.onMediaStatus((nextAsset) => {
      if (active) applyAsset(nextAsset);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyAsset, awemeId, mediaUrl]);

  const saveToLocal = useCallback(async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge)) return;
    setConfirmingRemove(false);
    const nextAsset = await bridge.saveMedia({
      awemeId,
      title,
      mediaUrl,
      coverUrl: coverUrl || undefined,
    });
    applyAsset(nextAsset);
  }, [applyAsset, awemeId, coverUrl, mediaUrl, title]);

  const downloadToFolder = useCallback(async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge) || choosingDownload) return;
    setConfirmingRemove(false);
    setChoosingDownload(true);
    try {
      if (typeof bridge.downloadMedia === 'function') {
        const result = await bridge.downloadMedia({
          awemeId,
          title,
          mediaUrl,
          coverUrl: coverUrl || undefined,
        });
        if (result.canceled) return;
        if (result.directory) {
          setSettings((current) => current
            ? { ...current, directory: result.directory! }
            : current);
        }
        if (result.asset) applyAsset(result.asset);
        return;
      }
      await saveToLocal();
    } catch (downloadError) {
      applyAsset({
        awemeId,
        status: 'error',
        error: downloadError instanceof Error
          ? downloadError.message
          : '视频下载失败，请重试',
      });
    } finally {
      setChoosingDownload(false);
    }
  }, [applyAsset, awemeId, choosingDownload, coverUrl, mediaUrl, saveToLocal, title]);

  const startPlayback = () => {
    if (requested) return;
    setRequested(true);
    setFailed(false);
    if (
      desktopSupported
      && settings?.autoSaveOnPlay
      && asset.status !== 'cached'
      && asset.status !== 'downloading'
    ) {
      void saveToLocal();
    }
    const playback = videoRef.current?.play();
    if (playback) {
      void playback.catch(() => {
        // onError handles network failures; browser policy failures keep the
        // native control available for a second user gesture.
      });
    }
  };

  const retryPlayback = async () => {
    setRefreshing(true);
    setFailed(false);
    setRequested(false);
    setStarted(false);
    startedRef.current = false;
    setActiveMediaUrl(asset.status === 'cached' && asset.videoUrl
      ? asset.videoUrl
      : mediaUrl);
    try {
      await onRefreshMedia();
    } finally {
      setRefreshing(false);
    }
  };

  const revealMedia = async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge)) return;
    await bridge.revealMedia(awemeId);
  };

  const removeMedia = async () => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopMediaLibrary(bridge)) return;
    const nextAsset = await bridge.removeMedia(awemeId);
    setConfirmingRemove(false);
    setActiveMediaUrl(mediaUrl);
    setRequested(false);
    setStarted(false);
    startedRef.current = false;
    setFailed(false);
    applyAsset(nextAsset);
  };

  const displayCoverUrl = asset.status === 'cached' && asset.coverUrl
    ? asset.coverUrl
    : coverUrl;
  const isLocalPlayback = activeMediaUrl.startsWith('zhicui-media://');
  const progress = Math.max(0, Math.min(100, asset.percent || 0));

  return (
    <div className={styles.shell} data-orientation={mediaOrientation}>
      <div className="video-knowledge-player">
        <video
          ref={videoRef}
          src={activeMediaUrl}
          poster={displayCoverUrl || undefined}
          controls={started}
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            videoDimensionsKnownRef.current = Boolean(videoWidth && videoHeight);
            applyMediaGeometry(videoWidth, videoHeight);
          }}
          onPlaying={() => {
            setStarted(true);
            startedRef.current = true;
            setFailed(false);
          }}
          onError={() => {
            if (isLocalPlayback) {
              setActiveMediaUrl(mediaUrl);
              setRequested(false);
              setStarted(false);
              startedRef.current = false;
              videoRef.current?.load();
              return;
            }
            setFailed(true);
          }}
          aria-label={`播放视频：${title}`}
        />

        {!started && !failed && (
          <button
            type="button"
            className={`video-knowledge-play-cover ${
              requested ? 'is-requested' : ''
            }`}
            onClick={startPlayback}
            disabled={requested}
            aria-label={requested ? '正在准备视频播放' : `播放视频：${title}`}
            onLoadCapture={(event) => {
              if (videoDimensionsKnownRef.current) return;
              const image = event.target as HTMLImageElement;
              if (image.tagName !== 'IMG') return;
              applyMediaGeometry(image.naturalWidth, image.naturalHeight);
            }}
          >
            <LibraryCoverImage
              key={displayCoverUrl || awemeId}
              src={displayCoverUrl}
              fallbackClassName={styles.coverFallback}
              fallbackLabel="封面暂不可用"
              iconSize={26}
              retryable={false}
            />
            <span className="video-knowledge-play-shade" aria-hidden="true" />
            <span className="video-knowledge-play-action">
              {!requested && (
                <span className="video-knowledge-play-icon" aria-hidden="true">
                  <Play size={28} weight="fill" />
                </span>
              )}
              {requested && (
                <SpinnerGap size={25} className={styles.spin} aria-hidden="true" />
              )}
              <strong>{requested ? '正在准备视频…' : '播放视频'}</strong>
              <small>
                {isLocalPlayback ? '从这台电脑读取' : '远程按需读取'}
              </small>
            </span>
          </button>
        )}

        {failed && (
          <div className="video-knowledge-play-failure" role="alert">
            <LibraryCoverImage
              key={`failed-${displayCoverUrl || awemeId}`}
              src={displayCoverUrl}
              fallbackClassName={styles.coverFallback}
              iconSize={24}
              retryable={false}
            />
            <span>
              <WarningCircle size={21} weight="duotone" />
              <strong>视频暂时没有加载出来</strong>
              <small>可以重新获取播放地址，知识文案和计划不会受影响。</small>
              <span className={styles.failureActions}>
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void retryPlayback()}
                >
                  {refreshing ? (
                    <SpinnerGap size={14} className={styles.spin} />
                  ) : (
                    <ArrowClockwise size={14} />
                  )}
                  重新读取
                </button>
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  打开原视频
                  <ArrowSquareOut size={14} />
                </a>
              </span>
            </span>
          </div>
        )}
      </div>

      {desktopSupported && (
        <section className={styles.localBar} aria-label="本地视频状态">
          {asset.status === 'downloading' ? (
            <>
              <span className={styles.statusIcon} aria-hidden="true">
                <CloudArrowDown size={18} weight="duotone" />
              </span>
              <div className={styles.statusCopy}>
                <strong>正在保存到这台电脑</strong>
                <span>
                  {asset.totalBytes
                    ? `${formatBytes(asset.receivedBytes)} / ${formatBytes(asset.totalBytes)}`
                    : `${formatBytes(asset.receivedBytes) || '正在连接视频源'}`
                  }
                </span>
                {asset.directory && (
                  <span className={styles.directoryPath} title={asset.directory}>
                    {asset.directory}
                  </span>
                )}
                <span className={styles.progressTrack} aria-hidden="true">
                  <i style={{ width: `${progress || 4}%` }} />
                </span>
              </div>
              <b className={styles.progressValue}>
                {asset.totalBytes ? `${Math.round(progress)}%` : '…'}
              </b>
            </>
          ) : asset.status === 'cached' ? (
            <>
              <span className={`${styles.statusIcon} ${styles.statusIconCached}`} aria-hidden="true">
                <HardDrive size={18} weight="duotone" />
              </span>
              <div className={styles.statusCopy}>
                <strong>已保存在这台电脑</strong>
                <span>{formatBytes(asset.sizeBytes)} · 本地优先播放</span>
                {asset.directory && (
                  <span className={styles.directoryPath} title={asset.directory}>
                    {asset.directory}
                  </span>
                )}
              </div>
              {confirmingRemove ? (
                <div className={styles.confirmActions}>
                  <span>只删除本地文件？</span>
                  <button type="button" onClick={() => void removeMedia()}>
                    确认删除
                  </button>
                  <button type="button" onClick={() => setConfirmingRemove(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <div className={styles.localActions}>
                  <button type="button" onClick={() => void revealMedia()}>
                    <FolderOpen size={15} />
                    打开位置
                  </button>
                  <button
                    type="button"
                    className={styles.removeAction}
                    onClick={() => setConfirmingRemove(true)}
                  >
                    <Trash size={15} />
                    删除本地副本
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <span className={styles.statusIcon} aria-hidden="true">
                {asset.status === 'error' ? (
                  <WarningCircle size={18} weight="duotone" />
                ) : (
                  <HardDrive size={18} weight="duotone" />
                )}
              </span>
              <div className={styles.statusCopy}>
                <strong>
                  {asset.status === 'error' ? '这次没有保存成功' : '当前为远程播放'}
                </strong>
                <span>
                  {asset.status === 'error'
                    ? asset.error || '可以重新尝试保存'
                    : settings?.autoSaveOnPlay
                      ? '首次播放后会在后台保存到本机'
                      : '视频不会自动占用本机空间'}
                </span>
              </div>
              <button
                type="button"
                className={styles.saveAction}
                onClick={() => void downloadToFolder()}
                disabled={choosingDownload}
              >
                {choosingDownload ? (
                  <SpinnerGap size={16} className={styles.spin} />
                ) : (
                  <CloudArrowDown size={16} />
                )}
                {choosingDownload
                  ? '选择文件夹…'
                  : asset.status === 'error' ? '重新下载' : '下载视频'}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
