'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useRouter } from 'next/navigation';
import {
  getAdminStats,
  listAdminUsers,
  patchAdminUser,
  deleteAdminUser,
  listAdminNotes,
  deleteAdminNote,
  reExtractNote,
  getLlmConfig,
  putLlmConfig,
  getAsrConfig,
  putAsrConfig,
  type AdminUser,
  type AdminStats,
  type AdminNoteItem,
  type LlmConfig,
  type AsrConfig,
} from '@/lib/api';

type Tab = 'users' | 'notes' | 'llm' | 'asr';

const CARD_TYPE_LABELS: Record<string, string> = {
  recipe: '食谱',
  insight: '洞察',
  history: '历史',
  product: '好物',
  plan: '计划',
  general: '通用',
};

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('users');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [notes, setNotes] = useState<AdminNoteItem[]>([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [asr, setAsr] = useState<AsrConfig | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/login?redirect=/admin'); return; }
    if (!user.is_admin) { router.replace('/'); return; }
    refreshStats();
    refreshUsers();
  }, [user, loading, router]);

  useEffect(() => {
    if (!user?.is_admin) return;
    if (tab === 'notes' && notes.length === 0) refreshNotes();
    if (tab === 'llm' && !llm) refreshLlm();
    if (tab === 'asr' && !asr) refreshAsr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function refreshStats() {
    const r = await getAdminStats();
    if (r.success && r.data) setStats(r.data);
  }
  async function refreshUsers() {
    const r = await listAdminUsers();
    if (r.success && r.data) setUsers(r.data.items);
    else setErr(r.error || '加载失败');
  }
  async function refreshNotes() {
    const r = await listAdminNotes();
    if (r.success && r.data) { setNotes(r.data.items); setNotesTotal(r.data.total); }
    else setErr(r.error || '加载失败');
  }
  async function refreshLlm() {
    const r = await getLlmConfig();
    if (r.success && r.data) setLlm(r.data);
  }
  async function refreshAsr() {
    const r = await getAsrConfig();
    if (r.success && r.data) setAsr(r.data);
  }

  function flash(m: string) {
    setMsg(m);
    setErr('');
    setTimeout(() => setMsg(''), 3000);
  }

  const toggleUser = async (u: AdminUser) => {
    setErr(''); setMsg('');
    const r = await patchAdminUser(u.id, { is_active: !u.is_active });
    if (r.success && r.data) {
      setUsers(us => us.map(x => (x.id === u.id ? r.data! : x)));
      flash(r.data.is_active ? '已启用' : '已禁用');
    } else setErr(r.error || '操作失败');
  };
  const removeUser = async (u: AdminUser) => {
    if (!confirm(`删除用户 ${u.username || u.email}?`)) return;
    const r = await deleteAdminUser(u.id);
    if (r.success) { setUsers(us => us.filter(x => x.id !== u.id)); refreshStats(); flash('已删除'); }
    else setErr(r.error || '删除失败');
  };

  const removeNote = async (n: AdminNoteItem) => {
    if (!confirm(`删除笔记「${n.video_title}」?`)) return;
    const r = await deleteAdminNote(n.id);
    if (r.success) { setNotes(ns => ns.filter(x => x.id !== n.id)); refreshStats(); flash('已删除'); }
    else setErr(r.error || '删除失败');
  };
  const reExtract = async (n: AdminNoteItem) => {
    if (!n.has_transcript) { setErr('该笔记无转录文本，无法重新抽取'); return; }
    setErr('正在重新抽取，请稍候…'); setMsg('');
    const r = await reExtractNote(n.id);
    if (r.success) { flash('已重新生成卡片'); refreshStats(); }
    else setErr(r.error || '重新抽取失败');
  };

  if (loading || !user?.is_admin) {
    return <div className="p-8 text-center text-foreground-muted">加载中…</div>;
  }

  const activeAdminCount = users.filter(u => u.is_admin && u.is_active).length;

  return (
    <div className="max-w-4xl mx-auto px-5 py-8">
      <h1 className="text-2xl font-bold text-foreground mb-4">管理端</h1>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="用户" value={stats?.users ?? 0} />
        <StatCard label="笔记" value={stats?.notes ?? 0} />
        <StatCard label="计划" value={stats?.plans ?? 0} />
      </div>
      {stats?.type_dist && Object.keys(stats.type_dist).length > 0 && (
        <div className="glass-card p-4 mb-4">
          <div className="text-xs text-foreground-muted mb-2">笔记类型分布</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.type_dist).map(([k, v]) => (
              <span key={k} className="text-xs px-2 py-1 rounded bg-card-bg">
                {CARD_TYPE_LABELS[k] || k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {(err || msg) && (
        <p className={`text-xs rounded-lg px-3 py-2 mb-4 ${err ? 'text-accent-rose bg-accent-rose/5' : 'text-accent-emerald bg-accent-emerald/5'}`}>
          {err || msg}
        </p>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-card-border">
        {(['users', 'notes', 'llm', 'asr'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setErr(''); setMsg(''); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-accent-emerald text-foreground' : 'border-transparent text-foreground-muted hover:text-foreground'}`}
          >
            {t === 'users' ? '用户' : t === 'notes' ? '笔记' : t === 'llm' ? 'LLM 配置' : 'ASR 配置'}
          </button>
        ))}
      </div>

      {/* User tab */}
      {tab === 'users' && (
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
              {users.map(u => {
                const isSelf = u.id === user.id;
                const isLastAdmin = u.is_admin && u.is_active && activeAdminCount <= 1;
                const disableToggle = isSelf || isLastAdmin;
                const reason = isSelf ? '不能操作自己' : isLastAdmin ? '需保留一个启用管理员' : '';
                return (
                  <tr key={u.id} className="border-b border-card-border/50">
                    <td className="p-3 font-medium text-foreground">
                      {u.username || '-'}
                      {u.is_admin && <span className="ml-1 text-xs text-accent-emerald">管理员</span>}
                    </td>
                    <td className="p-3 text-foreground-muted">{u.email}</td>
                    <td className="p-3">
                      {u.is_active ? <span className="text-accent-emerald">正常</span> : <span className="text-accent-rose">禁用</span>}
                    </td>
                    <td className="p-3 text-foreground-muted text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="p-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => toggleUser(u)}
                        disabled={disableToggle}
                        title={reason}
                        className="text-xs px-2 py-1 rounded bg-card-bg hover:bg-card-border/30 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {u.is_active ? '禁用' : '启用'}
                      </button>
                      {isSelf ? (
                        <span className="text-xs text-foreground-muted/50 ml-1">本人</span>
                      ) : (
                        <button
                          onClick={() => removeUser(u)}
                          className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20"
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Notes tab */}
      {tab === 'notes' && (
        <div className="glass-card overflow-hidden">
          <div className="px-3 py-2 text-xs text-foreground-muted border-b border-card-border">
            共 {notesTotal} 条笔记
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border text-foreground-muted text-xs">
                <th className="text-left p-3">标题</th>
                <th className="text-left p-3">类型</th>
                <th className="text-left p-3">作者</th>
                <th className="text-left p-3">创建</th>
                <th className="text-right p-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {notes.map(n => (
                <tr key={n.id} className="border-b border-card-border/50">
                  <td className="p-3 font-medium text-foreground max-w-xs truncate">{n.video_title}</td>
                  <td className="p-3 text-foreground-muted">{CARD_TYPE_LABELS[n.card_type] || n.card_type}</td>
                  <td className="p-3 text-foreground-muted">{n.author}</td>
                  <td className="p-3 text-foreground-muted text-xs">{n.created_at ? new Date(n.created_at).toLocaleDateString() : '-'}</td>
                  <td className="p-3 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => reExtract(n)}
                      disabled={!n.has_transcript}
                      title={n.has_transcript ? '用当前 LLM 配置重新生成卡片' : '无转录文本'}
                      className="text-xs px-2 py-1 rounded bg-card-bg hover:bg-card-border/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      重新抽取
                    </button>
                    <button
                      onClick={() => removeNote(n)}
                      className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {notes.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-foreground-muted text-sm">暂无笔记</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* LLM config tab */}
      {tab === 'llm' && (
        <ConfigForm
          title="LLM 配置"
          desc="管理端修改后立即生效，无需重启后端。留空表示不改。"
          fields={[
            { key: 'model', label: '模型', value: llm?.model ?? '', placeholder: 'mimo-v2.5-pro / deepseek/deepseek-chat' },
            { key: 'api_base', label: 'API Base', value: llm?.api_base ?? '', placeholder: '留空走官方' },
            { key: 'api_key', label: 'API Key', value: '', placeholder: llm?.api_key_masked ? `当前: ${llm.api_key_masked}` : '未设置', secret: true },
          ]}
          onSave={async (vals) => {
            const body: Record<string, string> = {};
            if (vals.model) body.model = vals.model;
            if (vals.api_base) body.api_base = vals.api_base;
            if (vals.api_key) body.api_key = vals.api_key;
            const r = await putLlmConfig(body);
            if (r.success && r.data) { setLlm(r.data); flash('LLM 配置已保存'); }
            else setErr(r.error || '保存失败');
          }}
        />
      )}

      {/* ASR config tab */}
      {tab === 'asr' && (
        <ConfigForm
          title="ASR 配置"
          desc="语音转文字服务（SiliconFlow）。留空表示不改。"
          fields={[
            { key: 'api_key', label: 'API Key', value: '', placeholder: asr?.api_key_masked ? `当前: ${asr.api_key_masked}` : '未设置', secret: true },
            { key: 'api_base_url', label: 'API Base URL', value: asr?.api_base_url ?? '', placeholder: 'https://api.siliconflow.cn/v1/audio/transcriptions' },
            { key: 'model', label: '模型', value: asr?.model ?? '', placeholder: 'FunAudioLLM/SenseVoiceSmall' },
          ]}
          onSave={async (vals) => {
            const body: Record<string, string> = {};
            if (vals.api_key) body.api_key = vals.api_key;
            if (vals.api_base_url) body.api_base_url = vals.api_base_url;
            if (vals.model) body.model = vals.model;
            const r = await putAsrConfig(body);
            if (r.success && r.data) { setAsr(r.data); flash('ASR 配置已保存'); }
            else setErr(r.error || '保存失败');
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="glass-card p-4">
      <div className="text-2xl font-bold text-accent-emerald">{value}</div>
      <div className="text-xs text-foreground-muted">{label}</div>
    </div>
  );
}

interface ConfigField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
}

function ConfigForm({
  title,
  desc,
  fields,
  onSave,
}: {
  title: string;
  desc: string;
  fields: ConfigField[];
  onSave: (vals: Record<string, string>) => Promise<void>;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  return (
    <div className="glass-card p-5">
      <h2 className="text-base font-semibold text-foreground mb-1">{title}</h2>
      <p className="text-xs text-foreground-muted mb-4">{desc}</p>
      <div className="space-y-3">
        {fields.map(f => (
          <div key={f.key}>
            <label className="text-xs text-foreground-muted block mb-1">{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              value={vals[f.key] ?? ''}
              onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="w-full px-3 py-2 rounded-lg bg-card-bg border border-card-border text-foreground text-sm placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-emerald/50"
            />
          </div>
        ))}
      </div>
      <button
        onClick={async () => { setSaving(true); await onSave(vals); setSaving(false); }}
        disabled={saving}
        className="mt-4 px-4 py-2 rounded-lg bg-accent-emerald text-white text-sm font-semibold hover:bg-accent-emerald/90 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}
