'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BadgeDollarSign,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  TestTube2,
  X,
} from 'lucide-react';
import {
  createAdminVideoAnalysisOffering,
  createAdminVisionProvider,
  disableAdminVideoAnalysisOffering,
  disableAdminVisionProvider,
  getAdminVideoAnalysisSettings,
  listAdminVideoAnalysisOfferings,
  listAdminVisionProviders,
  publishAdminVideoAnalysisOffering,
  putAdminVideoAnalysisSettings,
  testAdminVisionProvider,
  updateAdminVideoAnalysisOffering,
  updateAdminVisionProvider,
} from '@/lib/api';
import type {
  AdminVideoAnalysisOffering,
  AdminVideoAnalysisSettings,
  AdminVisionProvider,
  VideoAnalysisMethod,
  VideoAnalysisTrigger,
} from '@/lib/types';
import { formatPoints } from '@/lib/videoAnalysis';

type EditorTarget =
  | { kind: 'provider'; value: AdminVisionProvider | null }
  | { kind: 'offering'; value: AdminVideoAnalysisOffering | null };

const DEFAULT_SETTINGS: AdminVideoAnalysisSettings = {
  enabled: false,
  recommended_offering_id: null,
  quote_ttl_seconds: 300,
  agent_max_candidates: 3,
  user_daily_points_limit: 0,
  run_points_limit: 0,
  scene_concurrency: 1,
  vision_concurrency: 1,
  retry_count: 2,
  stale_run_minutes: 30,
  temporary_file_ttl_minutes: 60,
  provider_failure_threshold: 3,
  provider_cooldown_minutes: 15,
};

const METHOD_LABELS: Record<VideoAnalysisMethod, string> = {
  local_scene: '本地镜头结构',
  scene_frames_vlm: '关键帧图片模型',
  native_video: '原生视频模型',
};

function providerCapability(provider: AdminVisionProvider, key: string): boolean {
  const nested = provider.capabilities?.[key];
  if (typeof nested === 'boolean') return nested;
  const flat = provider[key as keyof AdminVisionProvider];
  return typeof flat === 'boolean' ? flat : false;
}

function statusLabel(value?: string): string {
  if (value === 'healthy') return '健康';
  if (value === 'unhealthy') return '测试失败';
  if (value === 'circuit_open') return '已熔断';
  if (value === 'published') return '已发布';
  if (value === 'disabled') return '已停用';
  if (value === 'draft') return '草稿';
  return '未测试';
}

export default function AdminVideoAnalysisPanel({
  onMessage,
  onError,
}: {
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<AdminVisionProvider[]>([]);
  const [offerings, setOfferings] = useState<AdminVideoAnalysisOffering[]>([]);
  const [settings, setSettings] = useState<AdminVideoAnalysisSettings>(DEFAULT_SETTINGS);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [workingId, setWorkingId] = useState('');
  const publishedOfferings = offerings.filter(item => item.status === 'published' || item.published);

  const load = async () => {
    setLoading(true);
    const [providerResult, offeringResult, settingsResult] = await Promise.all([
      listAdminVisionProviders(),
      listAdminVideoAnalysisOfferings(),
      getAdminVideoAnalysisSettings(),
    ]);
    setLoading(false);
    if (providerResult.success && providerResult.data) setProviders(providerResult.data.items);
    if (offeringResult.success && offeringResult.data) setOfferings(offeringResult.data.items);
    if (settingsResult.success && settingsResult.data) setSettings(settingsResult.data);
    const firstError = [providerResult, offeringResult, settingsResult].find(result => !result.success);
    if (firstError) onError(firstError.error || '详细视频解析配置读取失败');
  };

  useEffect(() => {
    void load();
    // Initial catalog recovery is intentionally one-shot on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = async () => {
    setSavingSettings(true);
    const response = await putAdminVideoAnalysisSettings({
      ...settings,
      agent_max_candidates: settings.agent_max_candidates ?? settings.agent_candidate_limit ?? 3,
    });
    setSavingSettings(false);
    if (response.success && response.data) {
      setSettings(response.data);
      onMessage('详细解析风控设置已保存');
    } else {
      onError(response.error || '详细解析设置保存失败');
    }
  };

  const testProvider = async (provider: AdminVisionProvider) => {
    setWorkingId(`test:${provider.id}`);
    const response = await testAdminVisionProvider(
      provider.id,
      provider.default_model || provider.model,
    );
    setWorkingId('');
    if (response.success && response.data?.ok) {
      if (response.data.provider) {
        setProviders(current => current.map(item => (
          item.id === provider.id ? response.data!.provider! : item
        )));
      } else {
        await load();
      }
      onMessage('真实图片能力测试通过');
    } else {
      await load();
      onError(response.error || response.data?.error || 'Provider 图片能力测试失败');
    }
  };

  const disableProvider = async (provider: AdminVisionProvider) => {
    if (!window.confirm(`停用 Provider「${provider.name}」？历史任务仍会保留引用。`)) return;
    setWorkingId(`disable:${provider.id}`);
    const response = await disableAdminVisionProvider(provider.id);
    setWorkingId('');
    if (response.success) {
      await load();
      onMessage('Provider 已停用，历史引用仍保留');
    } else onError(response.error || 'Provider 停用失败');
  };

  const publishOffering = async (offering: AdminVideoAnalysisOffering) => {
    setWorkingId(`publish:${offering.id}`);
    const response = await publishAdminVideoAnalysisOffering(offering.id);
    setWorkingId('');
    if (response.success) {
      await load();
      onMessage('方案新版本已发布；旧报价仍按原版本结算');
    } else onError(response.error || '方案发布失败');
  };

  const disableOffering = async (offering: AdminVideoAnalysisOffering) => {
    if (!window.confirm(`停用解析方案「${offering.name}」？已报价任务不受影响。`)) return;
    setWorkingId(`disable-offering:${offering.id}`);
    const response = await disableAdminVideoAnalysisOffering(offering.id);
    setWorkingId('');
    if (response.success) {
      await load();
      onMessage('解析方案已停用');
    } else onError(response.error || '解析方案停用失败');
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-video-analysis-title">
      <header className="flex flex-wrap items-start justify-between gap-4 border-t border-card-border pt-6">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-accent-brand">
            <Eye size={14} aria-hidden="true" />Video analysis
          </div>
          <h2 id="admin-video-analysis-title" className="mt-2 text-xl font-bold text-foreground">详细视频解析</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-foreground-muted">
            这是按需、高成本能力。只有管理员成功测试 Provider、发布方案并打开总开关后，用户入口才会出现；同步、普通摘要和定时任务不会触发。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-card-border px-3 text-sm text-foreground disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新
        </button>
      </header>

      <section className="admin-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 size-2.5 rounded-full ${settings.enabled ? 'bg-accent-brand' : 'bg-foreground-muted/35'}`} />
            <div>
              <h3 className="text-sm font-semibold text-foreground">功能总开关</h3>
              <p className="mt-1 text-xs leading-5 text-foreground-muted">
                默认关闭。当前有 {publishedOfferings.length} 个已发布方案；未发布方案不会出现在用户侧。
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            onClick={() => setSettings(current => ({ ...current, enabled: !current.enabled }))}
            className={`min-h-10 rounded-full px-4 text-xs font-semibold ${settings.enabled ? 'bg-accent-brand text-white' : 'bg-[var(--admin-surface-2)] text-foreground-muted'}`}
          >
            {settings.enabled ? '已开启' : '保持关闭'}
          </button>
        </div>

        {settings.enabled && publishedOfferings.length === 0 && (
          <div className="mt-4 flex gap-2 rounded-lg border border-accent-amber/25 bg-accent-amber/7 p-3 text-xs leading-5 text-accent-amber">
            <ShieldAlert size={16} className="shrink-0" />
            尚无已发布方案，用户入口仍不会出现。请先完成 Provider 测试并发布 Offering。
          </div>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <NumberField label="报价有效期（秒）" min={60} max={1800} value={settings.quote_ttl_seconds} onChange={value => setSettings(current => ({ ...current, quote_ttl_seconds: value }))} />
          <NumberField label="Agent 每轮候选" min={1} max={10} value={settings.agent_max_candidates ?? settings.agent_candidate_limit ?? 3} onChange={value => setSettings(current => ({ ...current, agent_max_candidates: value }))} />
          <NumberField label="单用户每日萃点上限" min={0} value={settings.user_daily_points_limit} onChange={value => setSettings(current => ({ ...current, user_daily_points_limit: value }))} />
          <NumberField label="单任务萃点上限" min={0} value={settings.run_points_limit} onChange={value => setSettings(current => ({ ...current, run_points_limit: value }))} />
          <NumberField label="场景检测并发（1–4）" min={1} max={4} value={settings.scene_concurrency} onChange={value => setSettings(current => ({ ...current, scene_concurrency: value }))} />
          <NumberField label="视觉模型并发（1–4）" min={1} max={4} value={settings.vision_concurrency} onChange={value => setSettings(current => ({ ...current, vision_concurrency: value }))} />
          <NumberField label="失败重试次数" min={0} max={5} value={settings.retry_count} onChange={value => setSettings(current => ({ ...current, retry_count: value }))} />
          <NumberField label="卡死释放（分钟）" min={5} max={1440} value={settings.stale_run_minutes} onChange={value => setSettings(current => ({ ...current, stale_run_minutes: value }))} />
          <NumberField label="Provider 连续失败熔断" min={1} max={20} value={settings.provider_failure_threshold ?? 3} onChange={value => setSettings(current => ({ ...current, provider_failure_threshold: value }))} />
          <NumberField label="Provider 熔断冷却（分钟）" min={1} max={1440} value={settings.provider_cooldown_minutes ?? 15} onChange={value => setSettings(current => ({ ...current, provider_cooldown_minutes: value }))} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.45fr)]">
          <label className="grid gap-1 text-xs text-foreground-muted">
            推荐方案
            <select
              value={settings.recommended_offering_id || ''}
              onChange={event => setSettings(current => ({ ...current, recommended_offering_id: event.target.value || null }))}
              className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-brand/60"
            >
              <option value="">按发布排序自动推荐</option>
              {publishedOfferings.map(offering => <option key={offering.id} value={offering.id}>{offering.name}</option>)}
            </select>
          </label>
          <NumberField label="临时文件保留上限（分钟）" min={5} max={1440} value={settings.temporary_file_ttl_minutes} onChange={value => setSettings(current => ({ ...current, temporary_file_ttl_minutes: value }))} />
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void saveSettings()}
            disabled={savingSettings}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {savingSettings && <LoaderCircle size={15} className="animate-spin" />}
            {savingSettings ? '正在保存' : '保存详细解析设置'}
          </button>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="admin-panel overflow-hidden">
          <ListHeader
            icon={ServerCog}
            title="服务接入"
            description="Provider 只能停用，不能删除历史引用"
            onAdd={() => setEditor({ kind: 'provider', value: null })}
          />
          <div className="divide-y divide-card-border">
            {providers.map(provider => (
              <article key={provider.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setEditor({ kind: 'provider', value: provider })} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-2">
                      <strong className="truncate text-sm text-foreground">{provider.name}</strong>
                      <StatusBadge value={provider.enabled ? provider.health_status : 'disabled'} />
                    </span>
                    <small className="mt-1 block truncate text-xs text-foreground-muted">
                      {provider.driver} · {provider.default_model || provider.model || '未设置模型'}
                    </small>
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      {providerCapability(provider, 'supports_images') && <Tag>图片</Tag>}
                      {providerCapability(provider, 'supports_native_video') && <Tag>原生视频</Tag>}
                      {providerCapability(provider, 'supports_ocr') && <Tag>OCR</Tag>}
                      {provider.cost_known === false && <Tag warning>成本未知</Tag>}
                      {provider.circuit_open_until && <Tag warning>熔断至 {new Date(provider.circuit_open_until).toLocaleString('zh-CN')}</Tag>}
                    </span>
                    {provider.health_message && <small className="mt-2 block text-xs text-foreground-muted">{provider.health_message}</small>}
                  </button>
                  <ChevronRight size={16} className="mt-1 shrink-0 text-foreground-muted" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void testProvider(provider)}
                    disabled={workingId === `test:${provider.id}` || !provider.enabled}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-card-border px-3 text-xs text-foreground disabled:opacity-50"
                  >
                    {workingId === `test:${provider.id}` ? <LoaderCircle size={14} className="animate-spin" /> : <TestTube2 size={14} />}
                    测试真实图片
                  </button>
                  {provider.enabled && (
                    <button type="button" onClick={() => void disableProvider(provider)} className="min-h-9 rounded-lg px-3 text-xs text-accent-rose">停用</button>
                  )}
                </div>
              </article>
            ))}
            {!providers.length && !loading && <EmptyRow text="还没有 Provider，请先接入本地或图片视觉服务。" />}
          </div>
        </section>

        <section className="admin-panel overflow-hidden">
          <ListHeader
            icon={BadgeDollarSign}
            title="用户可选方案"
            description="每次发布都会创建不可变价格版本"
            onAdd={() => setEditor({ kind: 'offering', value: null })}
          />
          <div className="divide-y divide-card-border">
            {offerings.map(offering => {
              const price = offering.pricing || offering.price || {};
              const free = offering.is_free ?? price.is_free ?? false;
              return (
                <article key={offering.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" onClick={() => setEditor({ kind: 'offering', value: offering })} className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-sm text-foreground">{offering.name}</strong>
                        <StatusBadge value={offering.status || (offering.published ? 'published' : 'draft')} />
                        {(offering.recommended || offering.is_recommended) && <Tag>推荐</Tag>}
                      </span>
                      <small className="mt-1 block text-xs text-foreground-muted">
                        {METHOD_LABELS[offering.method]} · v{offering.version || Math.max(0, Number(offering.next_version || 1) - 1)} · {free ? '0 萃点' : `基础 ${formatPoints(price.base_points || offering.base_points || 0)}`}
                      </small>
                    </button>
                    <ChevronRight size={16} className="mt-1 shrink-0 text-foreground-muted" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void publishOffering(offering)}
                      disabled={workingId === `publish:${offering.id}` || offering.status === 'disabled'}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-card-border px-3 text-xs text-foreground disabled:opacity-50"
                    >
                      {workingId === `publish:${offering.id}` ? <LoaderCircle size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                      发布新版本
                    </button>
                    {offering.status !== 'disabled' && (
                      <button type="button" onClick={() => void disableOffering(offering)} className="min-h-9 rounded-lg px-3 text-xs text-accent-rose">停用</button>
                    )}
                  </div>
                </article>
              );
            })}
            {!offerings.length && !loading && <EmptyRow text="还没有用户方案。先创建 Provider，再配置并发布 Offering。" />}
          </div>
        </section>
      </div>

      {editor?.kind === 'provider' && (
        <ProviderEditor
          key={`provider:${editor.value?.id || 'new'}`}
          value={editor.value}
          onClose={() => setEditor(null)}
          onSaved={async message => {
            setEditor(null);
            await load();
            onMessage(message);
          }}
          onError={onError}
        />
      )}
      {editor?.kind === 'offering' && (
        <OfferingEditor
          key={`offering:${editor.value?.id || 'new'}`}
          value={editor.value}
          providers={providers}
          onClose={() => setEditor(null)}
          onSaved={async message => {
            setEditor(null);
            await load();
            onMessage(message);
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

function ListHeader({ icon: Icon, title, description, onAdd }: { icon: typeof Eye; title: string; description: string; onAdd: () => void }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-card-border p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-brand/10 text-accent-brand"><Icon size={17} /></span>
        <span className="min-w-0"><strong className="block text-sm text-foreground">{title}</strong><small className="block truncate text-xs text-foreground-muted">{description}</small></span>
      </div>
      <button type="button" onClick={onAdd} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-card-border px-3 text-xs font-semibold text-foreground"><Plus size={14} />新增</button>
    </header>
  );
}

function NumberField({ label, value, min = 0, max, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1 text-xs text-foreground-muted">
      {label}
      <input type="number" min={min} max={max} value={value} onChange={event => onChange(Math.max(min, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.trunc(Number(event.target.value) || 0))))} className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm tabular-nums text-foreground outline-none focus:border-accent-brand/60" />
    </label>
  );
}

function StatusBadge({ value }: { value?: string }) {
  const positive = value === 'healthy' || value === 'published';
  const negative = value === 'unhealthy' || value === 'disabled' || value === 'circuit_open';
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${positive ? 'bg-accent-brand/10 text-accent-brand' : negative ? 'bg-accent-rose/10 text-accent-rose' : 'bg-[var(--admin-surface-2)] text-foreground-muted'}`}>{statusLabel(value)}</span>;
}

function Tag({ children, warning = false }: { children: React.ReactNode; warning?: boolean }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${warning ? 'bg-accent-amber/10 text-accent-amber' : 'bg-[var(--admin-surface-2)] text-foreground-muted'}`}>{children}</span>;
}

function EmptyRow({ text }: { text: string }) {
  return <div className="flex min-h-28 items-center justify-center px-5 text-center text-xs leading-5 text-foreground-muted">{text}</div>;
}

function EditorShell({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex justify-end" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-label={title} className="relative h-full w-full max-w-xl overflow-y-auto border-l border-card-border bg-background p-5 shadow-2xl sm:p-6">
        <header className="sticky top-0 z-10 -mx-2 flex items-start justify-between gap-3 bg-background/95 px-2 pb-4 backdrop-blur">
          <div><h3 className="text-lg font-bold text-foreground">{title}</h3><p className="mt-1 text-xs leading-5 text-foreground-muted">{description}</p></div>
          <button type="button" onClick={onClose} aria-label={`关闭${title}`} className="grid size-11 shrink-0 place-items-center rounded-lg border border-card-border text-foreground-muted"><X size={18} /></button>
        </header>
        {children}
      </aside>
    </div>
  );
}

function ProviderEditor({ value, onClose, onSaved, onError }: { value: AdminVisionProvider | null; onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState({
    code: value?.code || '', name: value?.name || '', driver: value?.driver || 'openai_compatible',
    default_model: value?.default_model || value?.model || '', api_base: value?.api_base || '', api_key: '', enabled: value?.enabled ?? false,
    supports_images: providerCapability(value || ({ capabilities: {} } as AdminVisionProvider), 'supports_images') || !value,
    supports_native_video: providerCapability(value || ({ capabilities: {} } as AdminVisionProvider), 'supports_native_video'),
    supports_ocr: providerCapability(value || ({ capabilities: {} } as AdminVisionProvider), 'supports_ocr'),
    supports_audio: providerCapability(value || ({ capabilities: {} } as AdminVisionProvider), 'supports_audio'),
    cost_class: value?.cost?.cost_class || (value?.free ? 'no_cost' : 'unknown'), micros_per_unit: Number(value?.cost?.micros_per_unit || value?.cost_per_unit_micros || 0),
    metering_unit: value?.metering?.unit || value?.metering_unit || 'image', max_images: Number(value?.limits?.max_images || value?.max_images || 8),
    max_duration_seconds: Number(value?.limits?.max_duration_seconds || value?.max_duration_seconds || 7200), max_file_bytes: Number(value?.limits?.max_file_bytes || value?.max_file_bytes || 524288000),
    timeout_seconds: Number(value?.limits?.timeout_seconds || value?.timeout_seconds || 180), max_concurrency: Number(value?.max_concurrency || value?.concurrency || 1), daily_budget_micros: Number(value?.daily_budget_micros || 0),
  });
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof typeof form>(key: K, next: (typeof form)[K]) => setForm(current => ({ ...current, [key]: next }));
  const save = async () => {
    setSaving(true);
    const body = {
      code: form.code.trim(), name: form.name.trim(), driver: form.driver, default_model: form.default_model.trim(), api_base: form.api_base.trim(),
      ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}), enabled: form.enabled,
      capabilities: { supports_images: form.supports_images, supports_native_video: form.supports_native_video, supports_ocr: form.supports_ocr, supports_audio: form.supports_audio, native_video_driver_installed: false },
      metering: { unit: form.metering_unit },
      limits: { max_images: form.max_images, max_duration_seconds: form.max_duration_seconds, max_file_bytes: form.max_file_bytes, timeout_seconds: form.timeout_seconds },
      cost: { cost_class: form.cost_class, micros_per_unit: form.micros_per_unit }, max_concurrency: form.max_concurrency, daily_budget_micros: form.daily_budget_micros,
    };
    const response = value ? await updateAdminVisionProvider(value.id, body) : await createAdminVisionProvider(body);
    setSaving(false);
    if (response.success) await onSaved(value ? 'Provider 配置已更新，请重新执行图片测试' : 'Provider 已创建，请启用后执行图片测试');
    else onError(response.error || 'Provider 保存失败');
  };
  const ready = Boolean(form.code.trim().length >= 2 && form.name.trim() && (form.driver === 'local_scene' || (form.api_base.trim() && form.default_model.trim() && (form.api_key.trim() || value?.api_key_set))));
  return (
    <EditorShell title={value ? '编辑视觉 Provider' : '新增视觉 Provider'} description="密钥加密保存；图片模型测试会发送一张真实测试图片，不保存图片内容。" onClose={onClose}>
      <div className="space-y-4">
        <EditorGroup title="连接">
          <TextField label="内部标识" value={form.code} onChange={next => update('code', next)} disabled={Boolean(value)} placeholder="例如 siliconflow_vision" />
          <TextField label="显示名称" value={form.name} onChange={next => update('name', next)} placeholder="例如 SiliconFlow 视觉" />
          <SelectField label="驱动" value={form.driver} onChange={next => update('driver', next)} options={[['local_scene', '本地 PySceneDetect'], ['openai_compatible', 'OpenAI 图片兼容'], ['litellm_image', 'LiteLLM 图片'], ['omniroute_image', 'OmniRoute 图片'], ['native_video', '原生视频适配器']]} />
          <TextField label="默认模型" value={form.default_model} onChange={next => update('default_model', next)} placeholder="例如 gpt-4.1-mini" />
          <TextField label="API Base" value={form.api_base} onChange={next => update('api_base', next)} placeholder="https://api.example.com/v1" />
          <TextField label={`API Key${value?.api_key_set ? ` · 已保存 ${value.api_key_masked || ''}` : ''}`} value={form.api_key} onChange={next => update('api_key', next)} type="password" placeholder={value?.api_key_set ? '留空不变' : '输入密钥'} />
        </EditorGroup>
        <EditorGroup title="能力声明">
          <CheckField label="图片输入" checked={form.supports_images} onChange={next => update('supports_images', next)} />
          <CheckField label="原生视频" checked={form.supports_native_video} onChange={next => update('supports_native_video', next)} />
          <CheckField label="OCR" checked={form.supports_ocr} onChange={next => update('supports_ocr', next)} />
          <CheckField label="音频理解" checked={form.supports_audio} onChange={next => update('supports_audio', next)} />
          <CheckField label="启用 Provider" checked={form.enabled} onChange={next => update('enabled', next)} />
        </EditorGroup>
        <EditorGroup title="计量、成本与限制">
          <SelectField label="成本类别" value={form.cost_class} onChange={next => update('cost_class', next)} options={[['unknown', '成本未知'], ['no_cost', '无第三方成本'], ['metered', '已知计量成本']]} />
          <TextField label="计量单位" value={form.metering_unit} onChange={next => update('metering_unit', next)} placeholder="image" />
          <NumberEditor label="每单位成本（微元）" value={form.micros_per_unit} onChange={next => update('micros_per_unit', next)} />
          <NumberEditor label="每日预算（微元）" value={form.daily_budget_micros} onChange={next => update('daily_budget_micros', next)} />
          <NumberEditor label="最大图片数" value={form.max_images} min={1} onChange={next => update('max_images', next)} />
          <NumberEditor label="最大视频时长（秒）" value={form.max_duration_seconds} min={30} onChange={next => update('max_duration_seconds', next)} />
          <NumberEditor label="最大文件字节" value={form.max_file_bytes} min={1} onChange={next => update('max_file_bytes', next)} />
          <NumberEditor label="并发" value={form.max_concurrency} min={1} max={32} onChange={next => update('max_concurrency', next)} />
          <NumberEditor label="超时（秒）" value={form.timeout_seconds} min={10} onChange={next => update('timeout_seconds', next)} />
        </EditorGroup>
        {form.driver === 'native_video' && <Warning text="首版没有已安装的原生视频适配器；测试和发布会由服务端拒绝，不会向用户展示假入口。" />}
        <EditorActions onClose={onClose} onSave={() => void save()} saving={saving} disabled={!ready} />
      </div>
    </EditorShell>
  );
}

function OfferingEditor({ value, providers, onClose, onSaved, onError }: { value: AdminVideoAnalysisOffering | null; providers: AdminVisionProvider[]; onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const existingPrice = value?.pricing || value?.price || {};
  const existingLimits = value?.limits || {};
  const [form, setForm] = useState({
    code: value?.code || '', name: value?.name || '', description: value?.description || '', method: value?.method || 'local_scene' as VideoAnalysisMethod,
    provider_id: value?.provider_id || '', model: value?.model || '', recommended: Boolean(value?.recommended ?? value?.is_recommended), sort_order: Number(value?.sort_order || 100), byok_allowed: Boolean(value?.byok_allowed ?? value?.allow_byok ?? value?.supports_byok),
    manual: value?.triggers?.includes('manual') ?? value?.allowed_triggers?.includes('manual') ?? true, batch: value?.triggers?.includes('batch') ?? value?.allowed_triggers?.includes('batch') ?? true, agent: value?.triggers?.includes('agent') ?? value?.allowed_triggers?.includes('agent') ?? true,
    max_duration_seconds: Number(existingLimits.max_duration_seconds || 7200), max_frames: Number(existingLimits.max_frames || 8), max_model_calls: Number(existingLimits.max_model_calls || 1), timeout_seconds: Number(existingLimits.timeout_seconds || 180),
    base_points: Number(existingPrice.base_points || value?.base_points || 0), per_minute_points: Number(existingPrice.per_minute_points || value?.per_minute_points || 0), per_frame_points: Number(existingPrice.per_frame_points || value?.per_frame_points || 0), per_media_unit_points: Number(existingPrice.per_media_unit_points || value?.per_media_unit_points || 0), min_points: Number(existingPrice.min_points || value?.min_points || 0), max_points: Number(existingPrice.max_points || value?.max_points || 0), byok_processing_points: Number((existingPrice as Record<string, number>).byok_processing_points || 0),
    quota_period: value?.free_quota?.period || value?.free_quota_period || '', quota_unit: (value?.free_quota as { unit?: string } | null)?.unit || 'run', quota_units: Number((value?.free_quota as { units?: number } | null)?.units || value?.free_quota_count || 0), fallback_mode: value?.fallback?.mode || 'reject',
  });
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof typeof form>(key: K, next: (typeof form)[K]) => setForm(current => ({ ...current, [key]: next }));
  const totalPrice = form.base_points + form.per_minute_points + form.per_frame_points + form.per_media_unit_points + form.min_points + form.byok_processing_points;
  const save = async () => {
    setSaving(true);
    const triggers = ([form.manual && 'manual', form.batch && 'batch', form.agent && 'agent'].filter(Boolean)) as VideoAnalysisTrigger[];
    const body = {
      code: form.code.trim(), name: form.name.trim(), description: form.description.trim(), method: form.method,
      provider_id: form.provider_id || null, model: form.model.trim(), recommended: form.recommended, sort_order: form.sort_order, byok_allowed: form.byok_allowed,
      triggers, limits: { max_duration_seconds: form.max_duration_seconds, max_frames: form.max_frames, max_model_calls: form.max_model_calls, timeout_seconds: form.timeout_seconds },
      pricing: { base_points: form.base_points, per_minute_points: form.per_minute_points, per_frame_points: form.per_frame_points, per_media_unit_points: form.per_media_unit_points, min_points: form.min_points, max_points: form.max_points, byok_processing_points: form.byok_processing_points },
      free_quota: form.quota_period && form.quota_units > 0 ? { period: form.quota_period, unit: form.quota_unit, units: form.quota_units } : {}, fallback: { mode: form.fallback_mode },
    };
    const response = value ? await updateAdminVideoAnalysisOffering(value.id, body) : await createAdminVideoAnalysisOffering(body);
    setSaving(false);
    if (response.success) await onSaved(value ? '方案草稿已更新；重新发布后才影响新报价' : '解析方案草稿已创建，请检查后发布');
    else onError(response.error || '解析方案保存失败');
  };
  const ready = form.code.trim().length >= 2 && Boolean(form.name.trim()) && (form.method === 'local_scene' || Boolean(form.provider_id)) && (form.manual || form.batch || form.agent);
  const compatibleProviders = providers.filter(provider => provider.enabled || provider.id === form.provider_id);
  return (
    <EditorShell title={value ? '编辑解析方案' : '新增解析方案'} description="修改价格或模型只更新草稿；点击发布时创建新版本，已报价任务仍使用旧快照。" onClose={onClose}>
      <div className="space-y-4">
        <EditorGroup title="用户展示与技术路线">
          <TextField label="内部标识" value={form.code} onChange={next => update('code', next)} disabled={Boolean(value)} placeholder="例如 standard_visual" />
          <TextField label="用户名称" value={form.name} onChange={next => update('name', next)} placeholder="例如 标准画面理解" />
          <TextField label="说明" value={form.description} onChange={next => update('description', next)} placeholder="告诉用户能获得什么" />
          <SelectField label="解析方式" value={form.method} onChange={next => update('method', next as VideoAnalysisMethod)} options={Object.entries(METHOD_LABELS)} />
          <SelectField label="Provider" value={form.provider_id} onChange={next => update('provider_id', next)} options={[["", form.method === 'local_scene' ? '本地，无需 Provider' : '请选择 Provider'], ...compatibleProviders.map(provider => [provider.id, provider.name] as [string, string])]} />
          <TextField label="方案模型（可覆盖 Provider 默认值）" value={form.model} onChange={next => update('model', next)} placeholder="留空使用 Provider 默认模型" />
          <NumberEditor label="展示顺序" value={form.sort_order} onChange={next => update('sort_order', next)} />
          <CheckField label="设为推荐方案" checked={form.recommended} onChange={next => update('recommended', next)} />
          <CheckField label="允许使用用户自己的视觉模型" checked={form.byok_allowed} onChange={next => update('byok_allowed', next)} />
        </EditorGroup>
        <EditorGroup title="允许触发">
          <CheckField label="单条手动" checked={form.manual} onChange={next => update('manual', next)} />
          <CheckField label="批量手动" checked={form.batch} onChange={next => update('batch', next)} />
          <CheckField label="交互式 Agent" checked={form.agent} onChange={next => update('agent', next)} />
        </EditorGroup>
        <EditorGroup title="任务上限">
          <NumberEditor label="最大时长（秒）" value={form.max_duration_seconds} min={30} onChange={next => update('max_duration_seconds', next)} />
          <NumberEditor label="最大帧数" value={form.max_frames} min={1} max={64} onChange={next => update('max_frames', next)} />
          <NumberEditor label="最大模型调用次数" value={form.max_model_calls} min={0} max={32} onChange={next => update('max_model_calls', next)} />
          <NumberEditor label="超时（秒）" value={form.timeout_seconds} min={10} onChange={next => update('timeout_seconds', next)} />
        </EditorGroup>
        <EditorGroup title="萃点价格">
          <NumberEditor label="基础萃点" value={form.base_points} onChange={next => update('base_points', next)} />
          <NumberEditor label="每计费分钟" value={form.per_minute_points} onChange={next => update('per_minute_points', next)} />
          <NumberEditor label="每帧" value={form.per_frame_points} onChange={next => update('per_frame_points', next)} />
          <NumberEditor label="每媒体单位" value={form.per_media_unit_points} onChange={next => update('per_media_unit_points', next)} />
          <NumberEditor label="单条最低" value={form.min_points} onChange={next => update('min_points', next)} />
          <NumberEditor label="单条最高（0=不另设）" value={form.max_points} onChange={next => update('max_points', next)} />
          <NumberEditor label="BYOK 平台处理费" value={form.byok_processing_points} onChange={next => update('byok_processing_points', next)} />
          <p className="col-span-full text-xs leading-5 text-foreground-muted">所有价格均为整数萃点。价格全部为 0 时才是免费方案，免费方案不会消耗统一萃点余额。</p>
        </EditorGroup>
        <EditorGroup title="免费额度与降级">
          <SelectField label="额度周期" value={form.quota_period} onChange={next => update('quota_period', next)} options={[["", '不限制独立免费额度'], ['day', '每日'], ['month', '每月'], ['lifetime', '长期总量']]} />
          <SelectField label="额度单位" value={form.quota_unit} onChange={next => update('quota_unit', next)} options={[['run', '次数'], ['minute', '视频分钟']]} />
          <NumberEditor label="额度数量" value={form.quota_units} onChange={next => update('quota_units', next)} />
          <SelectField label="Provider 不可用时" value={form.fallback_mode} onChange={next => update('fallback_mode', next)} options={[['reject', '明确不可用'], ['local_scene', '降级到本地基础解析']]} />
        </EditorGroup>
        {form.method === 'native_video' && <Warning text="原生视频方案会保留在管理端，但只有适配器安装并通过测试后才能发布，未配置时用户侧不显示。" />}
        {totalPrice === 0 && form.method !== 'local_scene' && form.fallback_mode !== 'local_scene' && <Warning text="免费视觉模型不可用时必须明确降级到本地基础解析，否则服务端会拒绝发布。" />}
        <EditorActions onClose={onClose} onSave={() => void save()} saving={saving} disabled={!ready} />
      </div>
    </EditorShell>
  );
}

function EditorGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="grid grid-cols-1 gap-3 rounded-xl border border-card-border p-4 sm:grid-cols-2"><legend className="px-1 text-xs font-semibold text-foreground">{title}</legend>{children}</fieldset>;
}

function TextField({ label, value, onChange, placeholder, type = 'text', disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; disabled?: boolean }) {
  return <label className="grid gap-1 text-xs text-foreground-muted">{label}<input type={type} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} autoComplete={type === 'password' ? 'off' : undefined} className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-brand/60 disabled:opacity-60" /></label>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label className="grid gap-1 text-xs text-foreground-muted">{label}<select value={value} onChange={event => onChange(event.target.value)} className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-brand/60">{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></label>;
}

function NumberEditor({ label, value, onChange, min = 0, max }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  return <label className="grid gap-1 text-xs text-foreground-muted">{label}<input type="number" value={value} min={min} max={max} onChange={event => onChange(Math.max(min, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.trunc(Number(event.target.value) || 0))))} className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm tabular-nums text-foreground outline-none focus:border-accent-brand/60" /></label>;
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex min-h-11 items-center gap-2 rounded-lg bg-[var(--admin-surface-2)] px-3 text-xs font-medium text-foreground"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="size-4 accent-brand-500" />{label}</label>;
}

function Warning({ text }: { text: string }) {
  return <p className="flex gap-2 rounded-lg border border-accent-amber/25 bg-accent-amber/7 p-3 text-xs leading-5 text-accent-amber"><CircleAlert size={16} className="shrink-0" />{text}</p>;
}

function EditorActions({ onClose, onSave, saving, disabled }: { onClose: () => void; onSave: () => void; saving: boolean; disabled: boolean }) {
  return <footer className="sticky bottom-0 -mx-2 flex justify-end gap-2 border-t border-card-border bg-background/95 px-2 py-4 backdrop-blur"><button type="button" onClick={onClose} disabled={saving} className="min-h-11 rounded-lg border border-card-border px-4 text-sm text-foreground">取消</button><button type="button" onClick={onSave} disabled={saving || disabled} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white disabled:opacity-50">{saving && <LoaderCircle size={15} className="animate-spin" />}{saving ? '正在保存' : '保存草稿'}</button></footer>;
}
