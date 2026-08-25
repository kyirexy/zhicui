'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  CircleDot,
  CloudCog,
  ExternalLink,
  Loader2,
  PlugZap,
  RefreshCw,
  Rocket,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import AIModelIcon from '@/components/AIModelIcon';
import {
  createAdminChatModel,
  getAdminOmniRouteConfig,
  getAdminOmniRouteWorkspace,
  putAdminOmniRouteConfig,
  testAdminOmniRoute,
  type AIRoutingWorkspace,
  type AIRoutingWorkspaceModel,
  type OmniRouteAdminConfig,
  type OmniRouteAdminTest,
} from '@/lib/api';

const EMPTY_FORM = { api_base: '', api_key: '', model: '', dashboard_url: '' };

interface Props {
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onPublished?: () => void;
}

export default function AdminOmniroutePanel({ onMessage, onError, onPublished }: Props) {
  const [config, setConfig] = useState<OmniRouteAdminConfig | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OmniRouteAdminTest | null>(null);
  const [workspace, setWorkspace] = useState<AIRoutingWorkspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const refreshTimer = useRef<number | null>(null);

  const loadConfig = async () => {
    const result = await getAdminOmniRouteConfig();
    if (result.success && result.data) {
      setConfig(result.data);
      setForm({
        api_base: result.data.api_base,
        api_key: '',
        model: result.data.model,
        dashboard_url: result.data.dashboard_url,
      });
    } else {
      onError(result.error || 'OmniRoute 配置加载失败');
    }
  };

  const loadWorkspace = async (refresh = false) => {
    setWorkspaceLoading(true);
    const result = await getAdminOmniRouteWorkspace(refresh);
    setWorkspaceLoading(false);
    if (result.success && result.data) {
      setWorkspace(result.data);
    } else {
      setWorkspace(null);
      if (refresh) onError(result.error || '无法连接 OmniRoute 网关');
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    if (config?.configured) void loadWorkspace(false);
    else setWorkspace(null);
  }, [config?.configured]);

  useEffect(() => () => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
  }, []);

  const freeModels = useMemo(() => (
    (workspace?.models ?? []).filter((model) => model.free && model.available)
  ), [workspace]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setTestResult(null);
    const result = await putAdminOmniRouteConfig({
      api_base: form.api_base.trim(),
      api_key: form.api_key.trim(),
      model: form.model.trim() || 'auto',
      dashboard_url: form.dashboard_url.trim(),
    });
    setSaving(false);
    if (!result.success || !result.data) {
      onError(result.error || 'OmniRoute 配置保存失败');
      return;
    }
    setConfig(result.data);
    setForm((current) => ({ ...current, api_base: result.data!.api_base, api_key: '', model: result.data!.model, dashboard_url: result.data!.dashboard_url }));
    onMessage('OmniRoute 配置已保存');
    void loadWorkspace(true);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testAdminOmniRoute();
    setTesting(false);
    if (result.success && result.data) {
      setTestResult(result.data);
      void loadWorkspace(true);
    } else {
      setTestResult(null);
      onError(result.error || '连接测试失败');
    }
  };

  const refresh = async () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
    }, 1500);
    void loadWorkspace(true);
  };

  const modelCode = (model: AIRoutingWorkspaceModel): string => {
    const base = model.id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'om-model';
    const hash = Array.from(model.id).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0).toString(36).slice(0, 4);
    const code = /^[a-z0-9]/.test(base) ? base : `om-${base}`;
    return `${code}-${hash}`;
  };

  const publish = async (model: AIRoutingWorkspaceModel) => {
    if (publishing || published.has(model.id)) return;
    setPublishing(model.id);
    const capabilities = new Set(model.capabilities ?? []);
    const result = await createAdminChatModel({
      code: modelCode(model),
      name: model.name || model.id,
      description: `OmniRoute 免费模型 · ${model.provider}`,
      provider_mode: 'omniroute',
      model_id: model.id,
      enabled: true,
      visible_to_users: true,
      is_default: false,
      is_free: true,
      free_daily_limit: 30,
      points_per_request: 0,
      supports_images: capabilities.has('images'),
      supports_tools: capabilities.has('tools'),
      sort_order: 100,
    });
    setPublishing(null);
    if (result.success && result.data) {
      setPublished((current) => new Set(current).add(model.id));
      onMessage(`已发布并启用「${result.data.name}」 · 全站免费可用`);
      onPublished?.();
    } else {
      onError(result.error || `发布「${model.name}」失败`);
    }
  };

  const formatTokens = (value: number) => {
    if (!value) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
    return String(value);
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-omniroute-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="admin-omniroute-title" className="flex items-center gap-2 text-balance text-2xl font-bold text-foreground">
            <CloudCog size={22} aria-hidden="true" className="text-accent-indigo" />
            OmniRoute 智能路由
          </h1>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-foreground-muted">
            连接知萃的统一模型网关后，可浏览网关内自带额度的免费模型，一键发布到用户模型目录。密钥只在服务器存储，不会下发给用户。
          </p>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,.85fr)]">
        <div className="space-y-4">
          <form onSubmit={save} className="admin-panel self-start p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">网关接入</h2>
              <span className={config?.configured ? 'inline-flex items-center gap-1.5 rounded-full bg-accent-brand/10 px-3 py-1 text-xs font-semibold text-accent-brand' : 'inline-flex items-center gap-1.5 rounded-full bg-[var(--admin-surface-2)] px-3 py-1 text-xs font-semibold text-foreground-muted'}>
                <CircleDot size={12} aria-hidden="true" />
                {config?.configured ? '已配置' : '未配置'}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="API Base"><input required value={form.api_base} onChange={(event) => setForm((c) => ({ ...c, api_base: event.target.value }))} placeholder="https://…/v1" /></Field>
              <Field label="API Key"><input type="password" autoComplete="off" value={form.api_key} onChange={(event) => setForm((c) => ({ ...c, api_key: event.target.value }))} placeholder={config?.api_key_masked ? `已保存 ${config.api_key_masked}，留空不改` : 'sk-…'} /></Field>
              <Field label="默认路由模型"><input value={form.model} onChange={(event) => setForm((c) => ({ ...c, model: event.target.value }))} placeholder="auto" /></Field>
              <Field label="高级控制台地址（可选）"><input value={form.dashboard_url} onChange={(event) => setForm((c) => ({ ...c, dashboard_url: event.target.value }))} placeholder="https://…" /></Field>
            </div>

            {config?.dashboard_url && (
              <a
                href={config.dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-indigo hover:underline"
              >
                打开 OmniRoute 高级控制台 <ExternalLink size={13} aria-hidden="true" />
              </a>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              <button type="submit" disabled={saving || testing} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-50">
                {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {saving ? '正在保存…' : '保存配置'}
              </button>
              <button type="button" onClick={() => void test()} disabled={testing || saving} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--admin-surface-2)] px-4 text-sm font-semibold text-foreground hover:bg-[var(--admin-line)] disabled:cursor-wait disabled:opacity-50">
                {testing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <PlugZap size={16} aria-hidden="true" />}
                {testing ? '正在测试…' : '测试连接'}
              </button>
            </div>

            {testResult && (
              <div role="status" className={`mt-3 rounded-lg border px-4 py-3 text-sm ${testResult.online ? 'border-accent-brand/25 bg-accent-brand/8 text-accent-brand' : 'border-accent-rose/25 bg-accent-rose/8 text-accent-rose'}`}>
                <span className="font-semibold">{testResult.online ? '连接成功' : '连接失败'}</span>
                <span className="ml-2 text-foreground-muted">{testResult.message} · {testResult.model_count} 个模型 · {testResult.latency_ms}ms</span>
              </div>
            )}
          </form>

          <div className="admin-panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-card-border p-4 sm:p-5">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <Sparkles size={18} aria-hidden="true" className="text-accent-indigo" />
                  免费模型
                </h2>
                <p className="mt-1 text-xs text-foreground-muted">只显示当前在线、可用的免费模型。发布后仍需在下方勾选「用户可见」。</p>
              </div>
              <button type="button" onClick={() => void refresh()} disabled={workspaceLoading} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-card-border px-3 text-xs font-semibold text-foreground-muted hover:bg-[var(--admin-surface-2)] disabled:opacity-50">
                <RefreshCw size={14} aria-hidden="true" className={workspaceLoading ? 'animate-spin' : ''} />
                刷新
              </button>
            </div>

            {workspaceLoading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-foreground-muted"><Loader2 size={16} className="animate-spin" aria-hidden="true" />正在同步网关目录…</div>
            ) : !config?.configured ? (
              <div className="p-8 text-center text-sm text-foreground-muted">请先填写并保存左侧的 OmniRoute 网关接入信息。</div>
            ) : !workspace?.status.online ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-foreground-muted"><TriangleAlert size={16} className="text-accent-rose" aria-hidden="true" />{workspace?.status.message || '网关暂时无法连接'}</div>
            ) : freeModels.length === 0 ? (
              <div className="p-8 text-center text-sm text-foreground-muted">当前网关没有返回可用的免费模型。</div>
            ) : (
              <ul className="divide-y divide-card-border/60">
                {freeModels.slice(0, 60).map((model) => {
                  const busy = publishing === model.id;
                  const done = published.has(model.id);
                  return (
                    <li key={model.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--admin-surface-2)]">
                        <AIModelIcon modelId={model.id} name={model.name} provider={model.provider} size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 font-semibold text-foreground">
                          <span className="truncate">{model.name || model.id}</span>
                          <span className="rounded-md bg-accent-brand/10 px-1.5 py-0.5 text-[11px] text-accent-brand">免费</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-foreground-muted" title={model.id}>{model.id}</div>
                      </div>
                      <div className="hidden text-right text-xs tabular-nums text-foreground-muted sm:block">
                        <div>月额度 {formatTokens(model.monthly_tokens)}</div>
                        <div>上下文 {model.context_length ? `${Math.round(model.context_length / 1000)}k` : '—'}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void publish(model)}
                        disabled={busy || done}
                        className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${
                          done ? 'cursor-default bg-accent-brand/10 text-accent-brand' : 'bg-foreground text-background hover:opacity-90 disabled:opacity-40'
                        }`}
                      >
                        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : done ? <Check size={14} aria-hidden="true" /> : <Rocket size={14} aria-hidden="true" />}
                        {busy ? '发布中…' : done ? '已发布' : '发布为模型'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <aside className="admin-panel self-start p-4 sm:p-5">
          <h2 className="text-base font-semibold text-foreground">使用说明</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-foreground-muted">
            <li>在「网关接入」填写 OmniRoute 的 API Base 与 API Key，保存并通过「测试连接」。</li>
            <li>在「免费模型」列表点击「发布为模型」，系统会以 OmniRoute 来源创建一条模型记录。</li>
            <li>回到下方「聊天模型」，编辑该记录并勾选「用户可见」，用户端即可选择。</li>
            <li>免费模型默认赠送 30 次/日，可在模型记录里调整额度或改为按萃点计费。</li>
          </ol>
          <div className="mt-4 rounded-lg border border-card-border bg-[var(--admin-surface-2)] p-3 text-xs leading-5 text-foreground-muted">
            OmniRoute 的实际计费与额度由已连接供应商决定。发布前建议点击「刷新」确认模型在线可用，避免用户选到失效模型。
          </div>
        </aside>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground-secondary">
      <span>{label}</span>
      <span className="[&>input]:min-h-11 [&>input]:w-full [&>input]:rounded-lg [&>input]:border [&>input]:border-card-border [&>input]:bg-[var(--admin-surface-2)] [&>input]:px-3 [&>input]:text-sm [&>input]:text-foreground [&>input:focus-visible]:outline [&>input:focus-visible]:outline-2 [&>input:focus-visible]:outline-offset-0 [&>input:focus-visible]:outline-accent-brand">{children}</span>
    </label>
  );
}
