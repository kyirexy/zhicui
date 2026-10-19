'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Play } from 'lucide-react';
import { downloadVideoCreationJob } from '@/lib/api';
import styles from './StudioWorkspace.module.css';

/** 媒体请求共用会话续期与大小校验，令牌不放入 URL。 */
export default function StudioVideoResult({ jobId }: { jobId: string }) {
  const [media, setMedia] = useState<{ blob: Blob; url: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const prepare = async () => {
    if (requestRef.current || media) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8 * 60_000);
    try {
      const blob = await downloadVideoCreationJob(jobId, controller.signal);
      if (controller.signal.aborted || requestRef.current !== controller || !mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setMedia({ blob, url });
    } catch (failure) {
      if (!mountedRef.current || requestRef.current !== controller) return;
      setError(timedOut ? '成品加载超时，请重试' : controller.signal.aborted ? '已取消加载' : failure instanceof Error ? failure.message : '成品加载失败，请重试');
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  const save = async () => {
    if (!media || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { exportFile } = await import('@/lib/fileExport');
      if (!mountedRef.current) return;
      const result = await exportFile(media.blob, `zhicui-studio-${jobId}.mp4`);
      if (mountedRef.current) setNotice(result === 'cancelled' ? '已取消保存' : result === 'downloaded' ? '已交给浏览器保存' : '已打开系统保存面板');
    } catch {
      if (mountedRef.current) setError('成品保存失败，请重试');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className={styles.result}>
      {media ? <video controls preload="metadata" src={media.url} /> : (
        <button type="button" className={styles.download} disabled={loading} onClick={() => void prepare()}>
          {loading ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {loading ? '正在加载成品…' : '加载并播放成品'}
        </button>
      )}
      {loading && <button type="button" className={styles.cancel} onClick={() => requestRef.current?.abort()}>取消加载</button>}
      {media && <button type="button" className={styles.download} disabled={saving} onClick={() => void save()}><Download size={15} aria-hidden="true" />{saving ? '正在保存…' : '下载 MP4'}</button>}
      {error && <p className={styles.errorLine} role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
