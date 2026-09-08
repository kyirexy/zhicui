'use client';

import { useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import UserAvatar, { avatarId } from './UserAvatar';
import styles from './AvatarPicker.module.css';

const names = ['圆框眼镜', '齐肩短发', '卷发青年', '高马尾', '清爽寸头', '波浪长发', '银发女士', '灰发先生', '短卷发', '休闲短发', '双丸子头', '微卷偏分'];

export default function AvatarPicker() {
  const { user, token, acceptSession } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  if (!user || !token) return null;
  async function select(id: string) {
    if (saving || !user || !token) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/avatar`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ avatar_id: id }), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '头像保存失败，请重试');
      acceptSession({ token, user: result.data });
      setMessage('头像已保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : '头像保存失败，请重试'); }
    finally { setSaving(false); }
  }
  return <section className={styles.root} aria-label="个人头像">
    <button className={styles.trigger} type="button" aria-expanded={open} aria-controls="avatar-choices" onClick={() => setOpen(!open)}>
      <UserAvatar user={user} size={52} /><span><strong>个人头像</strong><small>选择喜欢的卡通人像</small></span><b>{open ? '收起' : '更换头像'}</b>
    </button>
    <div id="avatar-choices" hidden={!open}>
      <div className={styles.grid} aria-label="可选头像" aria-busy={saving}>
        {names.map((name, index) => {
          const id = `portrait-${String(index + 1).padStart(2, '0')}`;
          return <button type="button" key={id} title={name} aria-label={name} aria-pressed={avatarId(user) === id} disabled={saving} onClick={() => void select(id)}>
            <UserAvatar user={{ ...user, avatar_id: id }} size={64} />
          </button>;
        })}
      </div>
    </div>
    <p className={styles.status} role="status">{saving ? '正在保存…' : message}</p>
  </section>;
}
