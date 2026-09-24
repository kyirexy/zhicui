'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, X } from 'lucide-react';
import { downloadNoteVideo } from '@/lib/api';
import { videoDownloadFilename, type VideoDownloadProgress } from '@/lib/videoDownload';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import styles from './VideoDownloadButton.module.css';

export default function VideoDownloadButton({ noteId, title }: { noteId: string; title: string }) {
  const requestRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VideoDownloadProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useWebBuildActivity(`video-download:${noteId}`, busy);

  useEffect(() => {
    setBusy(false);
    setProgress(null);
    setNotice('');
    setError('');
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [noteId]);

  const start = async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    setProgress(null);
    let timedOut = false;
    let lastProgressAt = 0;
    let lastProgressBytes = 0;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8 * 60_000);
    try {
      const blob = await downloadNoteVideo(noteId, controller.signal, (next) => {
        const now = Date.now();
        if (requestRef.current === controller && (now - lastProgressAt >= 150 || (lastProgressBytes === 0 && next.receivedBytes > 0) || next.receivedBytes === next.totalBytes)) {
          lastProgressAt = now;
          lastProgressBytes = next.receivedBytes;
          setProgress(next);
        }
      });
      if (controller.signal.aborted) return;
      const { exportFile } = await import('@/lib/fileExport');
      if (controller.signal.aborted) return;
      const result = await exportFile(blob, videoDownloadFilename(title));
      if (requestRef.current !== controller) return;
      setNotice(result === 'cancelled' ? '已取消保存' : result === 'downloaded' ? '已交给浏览器保存，可在下载记录中查看' : '已打开系统保存面板');
    } catch (failure) {
      if (requestRef.current !== controller) return;
      if (controller.signal.aborted && !timedOut) setNotice('已取消下载');
      else setError(timedOut ? '视频准备时间较长，请稍后重新下载' : failure instanceof Error && /[\u4e00-\u9fff]/.test(failure.message) ? failure.message : '网络连接中断，请重新下载');
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  const percent = progress?.totalBytes ? Math.min(100, Math.floor(progress.receivedBytes / progress.totalBytes * 100)) : null;
  const label = !busy ? '下载视频' : !progress ? '正在准备视频' : percent !== null ? `正在下载 ${percent}%` : '正在下载视频';
  return (
    <div className={styles.root}>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void start()}>
          {busy ? <LoaderCircle size={16} className={styles.spin} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          {label}
        </button>
        {busy ? <button type="button" className={styles.cancel} onClick={() => requestRef.current?.abort()} aria-label="取消视频下载"><X size={15} aria-hidden="true" />取消</button> : null}
      </div>
      {busy && progress ? <progress className={styles.progress} max={progress.totalBytes || undefined} value={progress.totalBytes ? progress.receivedBytes : undefined} aria-label="视频下载进度" /> : null}
      {busy ? <p role="status">{progress ? `已接收 ${(progress.receivedBytes / 1024 / 1024).toFixed(1)} MB` : '正在获取视频并检查文件，请保持页面打开。'}</p> : null}
      {notice ? <p role="status"><Check size={14} aria-hidden="true" />{notice}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}
