'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import { API_BASE, getAdminCommunityQr, putAdminCommunityQr, type CommunityQrConfig } from '@/lib/api';

function dateValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

function formatExpiry(value: string | null): string {
  if (!value) return '未设置（长期有效）';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export default function AdminCommunityQrPanel() {
  const [config, setConfig] = useState<CommunityQrConfig | null>(null);
  const [expiry, setExpiry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setLoading(true);
    const result = await getAdminCommunityQr();
    if (result.success && result.data) {
      setConfig(result.data);
      setExpiry(dateValue(result.data.expires_at));
    } else {
      setMessage(result.error || '二维码配置读取失败');
    }
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  const previewUrl = useMemo(() => {
    if (!config?.available || !config.url) return '';
    return `${API_BASE}${config.url}`;
  }, [config]);

  async function save() {
    if (!file || saving) return;
    setSaving(true);
    setMessage('');
    const result = await putAdminCommunityQr(file, expiry || undefined);
    if (result.success && result.data) {
      setConfig(result.data);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      setExpiry(dateValue(result.data.expires_at));
      setMessage('群二维码已更新，社区页面会立即使用新图片。');
    } else {
      setMessage(result.error || '二维码上传失败');
    }
    setSaving(false);
  }

  return (
    <section className="admin-panel p-5 space-y-4" aria-labelledby="community-qr-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="community-qr-title" className="text-base font-semibold text-foreground">交流群二维码</h2>
          <p className="mt-1 text-xs text-foreground-muted">支持 PNG、JPG、WebP，最大 512 KB。上传后无需重新构建前端。</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || saving} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-[var(--admin-surface-2)] disabled:opacity-50">
          <RefreshCw size={14} aria-hidden="true" />刷新
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-[8rem_1fr]">
        <div className="flex min-h-32 items-center justify-center rounded-lg border border-card-border bg-[var(--admin-surface-2)] p-2">
          {previewUrl ? <img src={previewUrl} alt="当前交流群二维码" className="max-h-28 max-w-28 object-contain" /> : <span className="text-center text-xs text-foreground-muted">尚未上传</span>}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">当前状态：{config?.available ? `已配置 · ${formatExpiry(config.expires_at)}` : '未配置（社区页使用内置图片）'}</p>
          <label className="block text-sm font-medium text-foreground" htmlFor="community-qr-file">选择二维码图片</label>
          <input ref={inputRef} id="community-qr-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] || null)} className="block w-full text-sm text-foreground-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent-brand file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white" />
          <label className="block text-sm font-medium text-foreground" htmlFor="community-qr-expiry">有效期（可选）</label>
          <input id="community-qr-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} className="rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 py-2 text-sm text-foreground" />
          <button type="button" onClick={() => void save()} disabled={!file || saving} className="inline-flex items-center gap-2 rounded-lg bg-accent-brand px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            <ImageUp size={16} aria-hidden="true" />{saving ? '正在上传…' : '上传并替换'}
          </button>
          {file ? <span className="ml-2 text-xs text-foreground-muted">已选择：{file.name}</span> : null}
        </div>
      </div>
      {message ? <p role="status" className="text-sm text-foreground-muted">{message}</p> : null}
    </section>
  );
}
