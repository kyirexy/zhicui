'use client';

import { useState } from 'react';
import type { AuthUser } from '@/lib/hooks/AuthContext';

export function avatarId(user: Pick<AuthUser, 'id' | 'avatar_id'> | null) {
  if (user?.avatar_id && /^portrait-(0[1-9]|1[0-2])$/.test(user.avatar_id)) return user.avatar_id;
  const hash = Array.from(user?.id || '').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return `portrait-${String(hash % 12 + 1).padStart(2, '0')}`;
}

export default function UserAvatar({ user, size = 36 }: { user: AuthUser | null; size?: number }) {
  const id = avatarId(user);
  const [failed, setFailed] = useState<string | null>(null);
  return <span style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0, borderRadius: '50%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', background: '#eeece7' }}>
    {failed === id ? (user?.username || '知').slice(0, 1) : <img src={`/images/avatars/v1/${id}.webp`} width={size} height={size} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setFailed(id)} />}
  </span>;
}
