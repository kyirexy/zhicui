'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useRouter } from 'next/navigation';
import { API_BASE } from '@/lib/api';

interface AdminUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

export default function AdminPage() {
  const { user, token, loading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState({ users: 0, notes: 0 });
  const [err, setErr] = useState('');

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/login?redirect=/admin'); return; }
    if (!user.is_admin) { router.replace('/'); return; }
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(`${API_BASE}/api/admin/stats`, { headers: h }).then(r => r.json()),
      fetch(`${API_BASE}/api/admin/users?per_page=100`, { headers: h }).then(r => r.json()),
    ]).then(([s, u]) => {
      if (s.success) setStats(s.data);
      if (u.success) setUsers(u.data.items);
      else setErr(u.error || '加载失败');
    }).catch(() => setErr('网络错误'));
  }, [user, token, loading, router]);

  const patch = async (id: string, body: { is_active?: boolean; is_admin?: boolean }) => {
    const r = await fetch(`${API_BASE}/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(r => r.json());
    if (r.success) setUsers(us => us.map(u => (u.id === id ? r.data : u)));
    else setErr(r.error);
  };
  const del = async (id: string) => {
    if (!confirm('确定删除该用户？')) return;
    const r = await fetch(`${API_BASE}/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json());
    if (r.success) setUsers(us => us.filter(u => u.id !== id));
    else setErr(r.error);
  };

  if (loading || !user?.is_admin) {
    return <div className="p-8 text-center text-foreground-muted">加载中…</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-5 py-8">
      <h1 className="text-2xl font-bold text-foreground mb-4">管理端</h1>
      <div className="flex gap-4 mb-6">
        <div className="glass-card p-4 flex-1">
          <div className="text-2xl font-bold text-accent-emerald">{stats.users}</div>
          <div className="text-xs text-foreground-muted">用户</div>
        </div>
        <div className="glass-card p-4 flex-1">
          <div className="text-2xl font-bold text-accent-emerald">{stats.notes}</div>
          <div className="text-xs text-foreground-muted">笔记</div>
        </div>
      </div>
      {err && (
        <p className="text-xs text-accent-rose bg-accent-rose/5 rounded-lg px-3 py-2 mb-4">{err}</p>
      )}
      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border text-foreground-muted text-xs">
              <th className="text-left p-3">用户名</th>
              <th className="text-left p-3">邮箱</th>
              <th className="text-left p-3">状态</th>
              <th className="text-left p-3">注册</th>
              <th className="text-right p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-card-border/50">
                <td className="p-3 font-medium text-foreground">
                  {u.username || '-'}
                  {u.is_admin && <span className="ml-1 text-xs text-accent-emerald">管理员</span>}
                </td>
                <td className="p-3 text-foreground-muted">{u.email}</td>
                <td className="p-3">
                  {u.is_active ? (
                    <span className="text-accent-emerald">正常</span>
                  ) : (
                    <span className="text-accent-rose">禁用</span>
                  )}
                </td>
                <td className="p-3 text-foreground-muted text-xs">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="p-3 text-right space-x-2 whitespace-nowrap">
                  <button
                    onClick={() => patch(u.id, { is_active: !u.is_active })}
                    className="text-xs px-2 py-1 rounded bg-card-bg hover:bg-card-border/30"
                  >
                    {u.is_active ? '禁用' : '启用'}
                  </button>
                  {u.id !== user.id && (
                    <button
                      onClick={() => del(u.id)}
                      className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20"
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
