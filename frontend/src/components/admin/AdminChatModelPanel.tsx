'use client';

import { useEffect, useImperativeHandle, useRef, useState, forwardRef, type FormEvent, type ReactNode } from 'react';
import { Check, CircleDollarSign, Pencil, Plus, Trash2, X } from 'lucide-react';
import AIModelIcon from '@/components/AIModelIcon';
import {
  createAdminChatModel,
  deleteAdminChatModel,
  listAdminChatModels,
  updateAdminChatModel,
  type AdminChatModel,
  type AdminChatModelInput,
} from '@/lib/api';

const EMPTY_FORM: AdminChatModelInput = {
  code: '',
  name: '',
  description: '',
  provider_mode: 'platform',
  model_id: '',
  enabled: true,
  visible_to_users: true,
  is_default: false,
  is_free: true,
  free_daily_limit: 30,
  points_per_request: 0,
  supports_images: false,
  supports_tools: false,
  sort_order: 100,
};

interface Props {
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}

export interface AdminChatModelPanelHandle {
  refresh: () => Promise<void>;
}

const AdminChatModelPanel = forwardRef<AdminChatModelPanelHandle, Props>(function AdminChatModelPanel({ onMessage, onError }, ref) {
  const [items, setItems] = useState<AdminChatModel[]>([]);
  const [form, setForm] = useState<AdminChatModelInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminChatModel | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = async () => {
    setLoading(true);
    const response = await listAdminChatModels();
    setLoading(false);
    if (response.success && response.data) setItems(response.data.items);
    else onError(response.error || '聊天模型目录加载失败');
  };

  useEffect(() => { void load(); }, []);

  useImperativeHandle(ref, () => ({ refresh: load }), []);

  const update = <K extends keyof AdminChatModelInput>(key: K, value: AdminChatModelInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const startCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const startEdit = (item: AdminChatModel) => {
    setEditingId(item.id);
    setForm({
      code: item.code,
      name: item.name,
      description: item.description,
      provider_mode: item.provider_mode,
      model_id: item.model_id,
      enabled: item.enabled,
      visible_to_users: item.visible_to_users,
      is_default: item.is_default,
      is_free: item.is_free,
      free_daily_limit: item.free_daily_limit,
      points_per_request: item.points_per_request,
      supports_images: item.supports_images,
      supports_tools: item.supports_tools,
      sort_order: item.sort_order,
    });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const code = form.code.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(code)) {
      onError('模型代码只能包含小写字母、数字、下划线和短横线（至少 2 位）');
      return;
    }
    if (!form.name.trim() || !form.model_id.trim()) {
      onError('展示名称与真实模型 ID 不能为空');
      return;
    }
    if (form.model_id.trim().toLowerCase() === 'auto' || form.model_id.trim().toLowerCase().startsWith('auto/')) {
      onError('不支持智能选择（auto），请配置一个明确的模型 ID');
      return;
    }
    setSaving(true);
    const payload = {
      ...form,
      code,
      name: form.name.trim(),
      model_id: form.model_id.trim(),
      description: form.description.trim(),
      points_per_request: form.is_free ? 0 : form.points_per_request,
    };
    const response = editingId
      ? await updateAdminChatModel(editingId, payload)
      : await createAdminChatModel(payload);
    setSaving(false);
    if (!response.success || !response.data) {
      onError(response.error || '模型保存失败');
      return;
    }
    onMessage(editingId ? '聊天模型已更新' : '聊天模型已发布');
    setEditingId(response.data.id);
    await load();
  };

  const askDelete = (item: AdminChatModel) => {
    setDeleteTarget(item);
    deleteDialogRef.current?.showModal();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const response = await deleteAdminChatModel(deleteTarget.id);
    if (!response.success) {
      onError(response.error || '删除失败');
      return;
    }
    deleteDialogRef.current?.close();
    setDeleteTarget(null);
    if (editingId === deleteTarget.id) startCreate();
    onMessage('聊天模型已删除');
    await load();
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-chat-model-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="admin-chat-model-title" className="text-balance text-2xl font-bold text-foreground">聊天模型</h1>
          <p className="mt-1 max-w-2xl text-pretty text-sm text-foreground-muted">
            只发布用户真正需要的模型。普通用户看不到 Provider 密钥、API 地址和未发布模型。
          </p>
        </div>
        <button type="button" onClick={startCreate} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-brand">
          <Plus size={16} aria-hidden="true" />发布模型
        </button>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,.85fr)]">
        <div className="admin-panel overflow-x-auto">
          <table className="admin-table min-w-[760px] text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th className="p-3 text-left">展示名称</th>
                <th className="p-3 text-left">真实模型</th>
                <th className="p-3 text-left">用户价格</th>
                <th className="p-3 text-left">状态</th>
                <th className="p-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="p-8 text-center text-foreground-muted">正在读取模型目录…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={5} className="p-8 text-center text-foreground-muted">还没有模型，点击“发布模型”添加第一个模型。</td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className="border-b border-card-border/60">
                  <td className="p-3">
                    <div className="flex items-center gap-2 font-semibold text-foreground">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--admin-surface-2)]">
                        <AIModelIcon code={item.code} modelId={item.model_id} name={item.name} provider={item.provider_mode} size={18} />
                      </span>
                      {item.name}
                      {item.is_default ? <span className="rounded-md bg-accent-brand/10 px-1.5 py-0.5 text-[11px] text-accent-brand">默认</span> : null}
                    </div>
                    <small className="mt-1 block text-foreground-muted">{item.code}</small>
                  </td>
                  <td className="p-3">
                    <div className="flex max-w-56 items-center gap-2">
                      <span className="truncate" title={item.model_id}>{item.model_id}</span>
                    </div>
                    <small className="text-foreground-muted">{item.provider_mode === 'platform' ? '平台配置' : 'OmniRoute'}</small>
                  </td>
                  <td className="p-3 tabular-nums">
                    {item.is_free ? `免费 · ${item.free_daily_limit || '不限'} 次/日` : `${item.points_per_request} 萃点/次`}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      <span className={item.enabled ? 'text-foreground' : 'text-foreground-muted'}>{item.enabled ? '启用' : '停用'}</span>
                      <span className={item.visible_to_users ? 'text-accent-brand' : 'text-foreground-muted'}>{item.visible_to_users ? '用户可见' : '用户不可见'}</span>
                    </div>
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => startEdit(item)} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-foreground hover:bg-[var(--admin-surface-2)]">
                      <Pencil size={14} aria-hidden="true" />编辑
                    </button>
                    <button type="button" onClick={() => askDelete(item)} disabled={item.is_default} className="ml-1 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-accent-rose hover:bg-accent-rose/10 disabled:cursor-not-allowed disabled:opacity-35">
                      <Trash2 size={14} aria-hidden="true" />删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form ref={formRef} onSubmit={submit} className="admin-panel self-start p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-balance text-base font-semibold text-foreground">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--admin-surface-2)]">
                <AIModelIcon code={form.code} modelId={form.model_id} name={form.name} provider={form.provider_mode} size={18} />
              </span>
              {editingId ? '编辑模型' : '发布模型'}
            </h2>
            {editingId ? <button type="button" onClick={startCreate} className="inline-flex size-10 items-center justify-center rounded-lg text-foreground-muted hover:bg-[var(--admin-surface-2)]" aria-label="关闭编辑"><X size={17} /></button> : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="展示名称"><input required value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：免费模型" /></Field>
            <Field label="模型代码"><input required value={form.code} onChange={(event) => update('code', event.target.value)} placeholder="free-chat" /></Field>
            <Field label="运行来源"><select value={form.provider_mode} onChange={(event) => update('provider_mode', event.target.value as AdminChatModelInput['provider_mode'])}><option value="platform">平台 LLM 配置</option><option value="omniroute">OmniRoute</option></select></Field>
            <Field label="真实模型 ID"><input required value={form.model_id} onChange={(event) => update('model_id', event.target.value)} placeholder="禁止 auto/*" /></Field>
            <Field label="排序"><input type="number" min={0} value={form.sort_order} onChange={(event) => update('sort_order', Number(event.target.value))} /></Field>
            {form.is_free ? <Field label="每日免费次数"><input type="number" min={0} value={form.free_daily_limit} onChange={(event) => update('free_daily_limit', Number(event.target.value))} /></Field> : <Field label="每次萃点"><input type="number" min={0} value={form.points_per_request} onChange={(event) => update('points_per_request', Number(event.target.value))} /></Field>}
          </div>
          <Field label="用户说明" className="mt-3"><textarea rows={2} value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="简短说明适合什么任务" /></Field>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <CheckField checked={form.enabled} onChange={(value) => update('enabled', value)}>启用模型</CheckField>
            <CheckField checked={form.visible_to_users} onChange={(value) => update('visible_to_users', value)}>用户可见</CheckField>
            <CheckField checked={form.is_default} onChange={(value) => update('is_default', value)}>设为默认</CheckField>
            <CheckField checked={form.is_free} onChange={(value) => update('is_free', value)}>免费模型</CheckField>
            <CheckField checked={form.supports_images} onChange={(value) => update('supports_images', value)}>支持图片</CheckField>
            <CheckField checked={form.supports_tools} onChange={(value) => update('supports_tools', value)}>支持工具调用</CheckField>
          </div>

          <button type="submit" disabled={saving} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-background hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
            {saving ? '正在保存…' : <><Check size={16} aria-hidden="true" />{editingId ? '保存模型' : '发布模型'}</>}
          </button>
        </form>
      </div>

      <dialog ref={deleteDialogRef} className="feedback-dialog" aria-labelledby="delete-chat-model-title">
        <div className="p-5 sm:p-6">
          <CircleDollarSign size={24} className="text-accent-rose" aria-hidden="true" />
          <h2 id="delete-chat-model-title" className="mt-3 text-balance text-lg font-semibold text-foreground">删除“{deleteTarget?.name}”？</h2>
          <p className="mt-2 text-pretty text-sm text-foreground-muted">删除后用户不能再选择这个模型。默认模型必须先更换后才能删除。</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => deleteDialogRef.current?.close()} className="min-h-10 rounded-lg px-4 text-sm text-foreground hover:bg-[var(--admin-surface-2)]">取消</button>
            <button type="button" onClick={() => void remove()} className="min-h-10 rounded-lg bg-accent-rose px-4 text-sm font-semibold text-white hover:brightness-95">删除模型</button>
          </div>
        </div>
      </dialog>
    </section>
  );
});

export default AdminChatModelPanel;

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`grid gap-1.5 text-xs font-medium text-foreground-secondary ${className}`}><span>{label}</span><span className="[&>input]:min-h-11 [&>input]:w-full [&>input]:rounded-lg [&>input]:border [&>input]:border-card-border [&>input]:bg-[var(--admin-surface-2)] [&>input]:px-3 [&>input]:text-sm [&>input]:text-foreground [&>select]:min-h-11 [&>select]:w-full [&>select]:rounded-lg [&>select]:border [&>select]:border-card-border [&>select]:bg-[var(--admin-surface-2)] [&>select]:px-3 [&>select]:text-sm [&>select]:text-foreground [&>textarea]:w-full [&>textarea]:rounded-lg [&>textarea]:border [&>textarea]:border-card-border [&>textarea]:bg-[var(--admin-surface-2)] [&>textarea]:p-3 [&>textarea]:text-sm [&>textarea]:text-foreground">{children}</span></label>;
}

function CheckField({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-[var(--admin-surface-2)] px-3 text-sm text-foreground"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--accent-brand)]" />{children}</label>;
}
