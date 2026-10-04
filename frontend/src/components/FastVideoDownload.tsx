'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Copy, Download, Link2, Music2, X } from 'lucide-react';
import { downloadFastVideo, resolveFastVideo, type FastVideoResult } from '@/lib/api';
import { videoDownloadFilename, type VideoDownloadProgress } from '@/lib/videoDownload';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import styles from './FastVideoDownload.module.css';

export default function FastVideoDownload() {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<FastVideoResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'resolve' | 'download'>('idle');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<VideoDownloadProgress | null>(null);
  const [kind, setKind] = useState<'video' | 'audio'>('video');
  const controller = useRef<AbortController | null>(null);
  useWebBuildActivity('fast-video-download', phase !== 'idle');
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (phase === 'idle') return;
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  const save = async (item: FastVideoResult, signal: AbortSignal) => {
    setPhase('download'); setProgress(null); setElapsed(0);
    const blob = await downloadFastVideo(item.media_id, signal, setProgress, item.kind);
    if (signal.aborted) return;
    const { exportFile } = await import('@/lib/fileExport');
    if (signal.aborted) return;
    const filename = videoDownloadFilename(item.title).replace(/\.mp4$/i, item.kind === 'audio' ? '.mp3' : '.mp4');
    const saved = await exportFile(blob, filename);
    if (!signal.aborted) setNotice(saved === 'cancelled' ? '已取消保存' : `${item.kind === 'audio' ? '原声音频' : '视频'}已交给浏览器或系统保存`);
  };
  const run = async (download: boolean, refresh = false, existing?: FastVideoResult, targetKind: 'video' | 'audio' = existing?.kind || 'video') => {
    if (controller.current) return;
    const task = new AbortController(); controller.current = task;
    setError(''); setNotice(''); setElapsed(0); setKind(targetKind);
    if (!existing) setResult(null);
    setPhase(existing ? 'download' : 'resolve');
    const timeout = window.setTimeout(() => task.abort('timeout'), existing || download ? 310_000 : 30_000);
    try {
      let item = existing;
      if (!item) {
        const response = await resolveFastVideo(url, refresh, task.signal, targetKind);
        if (!response.success || !response.data) throw new Error(response.error || '暂时无法获取视频地址');
        item = response.data;
        if (targetKind === 'audio' && item.kind !== 'audio') throw new Error('音频服务尚未更新，请稍后重试');
      }
      if (task.signal.aborted) return;
      setResult(item);
      if (download) await save(item, task.signal);
      else setNotice('下载入口已就绪');
    } catch (failure) {
      if (task.signal.aborted) setNotice(task.signal.reason === 'timeout' ? '等待超时，请重新获取链接' : '已取消');
      else setError(failure instanceof Error ? failure.message : '暂时无法完成，请重新获取链接');
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === task) { controller.current = null; setPhase('idle'); }
    }
  };
  return <section className={styles.card} aria-labelledby="fast-video-title">
    <header><span className={styles.icon}><Download size={22} aria-hidden="true" /></span><div><h2 id="fast-video-title">视频与音频下载</h2><p>粘贴抖音或 B站链接，下载视频或提取原声 MP3。无需等待文稿与 AI 分析。</p></div></header>
    <form onSubmit={(event) => { event.preventDefault(); void run(false); }}>
      <label htmlFor="fast-video-link">视频链接或完整分享文案</label>
      <textarea id="fast-video-link" value={url} disabled={phase !== 'idle'} onChange={(e) => { setUrl(e.target.value); setResult(null); setNotice(''); setError(''); }} placeholder="粘贴抖音或 B站分享链接…" maxLength={2000} required rows={3} />
      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={phase !== 'idle' || !url.trim()}><Link2 size={16} aria-hidden="true" />获取下载链接</button><button type="button" disabled={phase !== 'idle' || !url.trim()} onClick={() => void run(true)}><Download size={16} aria-hidden="true" />获取并下载</button><button type="button" disabled={phase !== 'idle' || !url.trim()} onClick={() => void run(true, false, undefined, 'audio')}><Music2 size={16} aria-hidden="true" />提取音频 MP3</button>{phase !== 'idle' && <button type="button" onClick={() => controller.current?.abort()}><X size={16} aria-hidden="true" />取消</button>}</div>
    </form>
    <div role="status" aria-live="polite" className={styles.status}>{phase === 'resolve' ? `正在获取下载地址 · ${elapsed.toFixed(1)} 秒` : phase === 'download' ? `正在下载 · ${progress ? `已接收 ${(progress.receivedBytes / 1048576).toFixed(1)} MB` : kind === 'audio' ? `正在提取原声 · ${elapsed.toFixed(1)} 秒` : '正在连接视频源'}` : notice}</div>
    {phase === 'download' && <progress aria-label="媒体下载进度" max={progress?.totalBytes || undefined} value={progress?.totalBytes ? progress.receivedBytes : undefined} />}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {result && <div className={styles.result}><h3>{result.title}</h3><p>{result.author} · {result.cache_hit ? '复用有效地址' : `解析 ${(result.resolve_ms / 1000).toFixed(2)} 秒`} · 下载入口 5 分钟有效</p><div className={styles.actions}><button type="button" className={styles.primary} disabled={phase !== 'idle'} onClick={() => void run(true, false, result)}><Download size={16} aria-hidden="true" />{result.kind === 'audio' ? '下载原声 MP3' : '下载视频'}</button>{result.media_url && <button type="button" disabled={phase !== 'idle'} onClick={() => { void navigator.clipboard.writeText(result.media_url!).then(() => setNotice('视频直链已复制')).catch(() => setError('浏览器未允许复制，请使用下载按钮')); }}><Copy size={16} aria-hidden="true" />复制直链</button>}<button type="button" disabled={phase !== 'idle'} onClick={() => void run(false, true, undefined, result.kind)}>重新获取</button></div><Link href={`/extract?url=${encodeURIComponent(url)}`} className={styles.more}>继续提取文稿与总结 <ArrowRight size={14} aria-hidden="true" /></Link></div>}
    <p className={styles.hint}>原声音频包含视频中的人声与配乐，不会单独分离背景音乐；无音轨会显示“无音频”。平台限制或链接过期时会提示重试。B站分离音视频需要合并时，请使用视频资料页下载。</p>
  </section>;
}
