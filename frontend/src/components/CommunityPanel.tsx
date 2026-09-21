'use client';

import { useEffect, useState } from 'react';
import { Download, MessageCircle } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { COMMUNITY_EXPIRES_AT, COMMUNITY_QR_PATH, isCommunityInviteExpired } from '@/lib/community';
import styles from './CommunityPanel.module.css';

export default function CommunityPanel() {
  const [expired, setExpired] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [qrPath, setQrPath] = useState(COMMUNITY_QR_PATH);
  const [expiresAt, setExpiresAt] = useState<string | null>(COMMUNITY_EXPIRES_AT);
  const [qrFilename, setQrFilename] = useState('知萃交流群二维码.png');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let configured = false;
      let effectiveExpires = '';
      try {
        const response = await fetch(`${API_BASE}/api/community/qr-info`, { cache: 'no-store' });
        const payload = await response.json() as { success?: boolean; data?: { available?: boolean; url?: string | null; expires_at?: string | null; filename?: string } };
        const data = payload.data;
        if (!cancelled && payload.success && data?.available && data.url) {
          configured = true;
          effectiveExpires = data.expires_at || '9999-12-31T00:00:00Z';
          setQrPath(`${API_BASE}${data.url}`);
          setExpiresAt(data.expires_at || null);
          setQrFilename(data.filename || '知萃交流群二维码.png');
        }
      } catch { /* fallback to the built-in image */ }
      if (cancelled) return;
      if (!configured) setExpiresAt(COMMUNITY_EXPIRES_AT);
      const check = () => setExpired(isCommunityInviteExpired(Date.now(), configured ? effectiveExpires : undefined));
      check();
      const timer = window.setInterval(check, 60_000);
      return () => window.clearInterval(timer);
    };
    let cleanup: (() => void) | undefined;
    void load().then((dispose) => { cleanup = dispose; });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  async function saveQr() {
    if (saving) return;
    const effectiveExpiry = qrPath === COMMUNITY_QR_PATH ? undefined : (expiresAt || '9999-12-31T00:00:00Z');
    if (isCommunityInviteExpired(Date.now(), effectiveExpiry)) { setExpired(true); return; }
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(qrPath);
      if (!response.ok) throw new Error('二维码加载失败');
      const blob = await response.blob();
      const { exportFile } = await import('@/lib/fileExport');
      const result = await exportFile(blob, qrFilename);
      setMessage(result === 'cancelled' ? '已取消保存。' : result === 'downloaded' ? '已开始下载，可在微信扫一扫中从相册选择。' : '可通过系统面板保存图片，再到微信扫一扫中选择。');
    } catch {
      setMessage('未能保存，可直接截图后在微信扫一扫中从相册选择。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.copy}>
        <span className={styles.icon}><MessageCircle size={24} aria-hidden="true" /></span>
        <h3>知萃交流建议反馈群</h3>
        <p>聊聊怎么用知萃，也欢迎把问题和建议告诉我们。</p>
        {expired === true ? (
          <p role="status">这张群二维码已过期，请稍后再来查看最新邀请。</p>
        ) : (
          <>
            <p>电脑上用微信扫码；手机上保存图片，在微信扫一扫中从相册选择。</p>
            <p className={styles.validity}>{expiresAt ? `本次二维码：${new Date(expiresAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}前有效` : '本次二维码长期有效'}</p>
          </>
        )}
        <div className={styles.actions}>
          {expired === false && !imageFailed ? <button type="button" disabled={saving} onClick={() => void saveQr()}><Download size={17} aria-hidden="true" />{saving ? '正在准备…' : '保存群二维码'}</button> : null}
        </div>
        <p className={styles.note}>请勿在群内发送密码、验证码或 API Key。</p>
        {message ? <p role="status">{message}</p> : null}
      </div>
      <div className={styles.qr}>
        {expired === false && !imageFailed ? (
          <img src={qrPath} width={340} height={340} alt="微信扫码加入知萃交流建议反馈群" onError={() => setImageFailed(true)} />
        ) : <p role="status">{imageFailed ? '二维码加载失败，请刷新重试。' : expired ? '等待更新群二维码' : '正在检查邀请有效期…'}</p>}
      </div>
    </div>
  );
}
