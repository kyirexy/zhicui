'use client';

import { useEffect, useState } from 'react';
import { Download, MessageCircle } from 'lucide-react';
import { COMMUNITY_QR_PATH, COMMUNITY_SUPPORT_EMAIL, isCommunityInviteExpired } from '@/lib/community';
import styles from './CommunityPanel.module.css';

export default function CommunityPanel() {
  const [expired, setExpired] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    const check = () => setExpired(isCommunityInviteExpired(Date.now()));
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function saveQr() {
    if (saving) return;
    if (isCommunityInviteExpired(Date.now())) { setExpired(true); return; }
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(COMMUNITY_QR_PATH);
      if (!response.ok) throw new Error('二维码加载失败');
      const blob = await response.blob();
      const { exportFile } = await import('@/lib/fileExport');
      const result = await exportFile(blob, '知萃交流群-9月14日前有效.png');
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
          <p role="status">这张群二维码已过期，请联系支持邮箱获取最新邀请。</p>
        ) : (
          <>
            <p>电脑上用微信扫码；手机上保存图片，在微信扫一扫中从相册选择。</p>
            <p className={styles.validity}>本次二维码：2026 年 9 月 14 日前有效</p>
          </>
        )}
        <div className={styles.actions}>
          {expired === false && !imageFailed ? <button type="button" disabled={saving} onClick={() => void saveQr()}><Download size={17} aria-hidden="true" />{saving ? '正在准备…' : '保存群二维码'}</button> : null}
          <a href={`mailto:${COMMUNITY_SUPPORT_EMAIL}`}>联系支持邮箱</a>
        </div>
        <p className={styles.note}>群满或无法加入时，可通过邮箱联系。请勿在群内发送密码、验证码或 API Key。</p>
        {message ? <p role="status">{message}</p> : null}
      </div>
      <div className={styles.qr}>
        {expired === false && !imageFailed ? (
          <img src={COMMUNITY_QR_PATH} width={800} height={800} alt="微信扫码加入知萃交流建议反馈群，2026年9月14日前有效" onError={() => setImageFailed(true)} />
        ) : <p role="status">{imageFailed ? '二维码加载失败，请刷新重试或联系支持邮箱。' : expired ? '等待更新群二维码' : '正在检查邀请有效期…'}</p>}
      </div>
    </div>
  );
}
