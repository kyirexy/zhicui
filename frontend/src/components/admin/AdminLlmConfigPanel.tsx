'use client';

import { useEffect, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import {
  putLlmConfig,
  testLlmConfig,
  type ConfigTestResult,
  type LlmConfig,
} from '@/lib/api';

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';

const MODEL_OPTIONS = [
  {
    value: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    description: '适合分类、摘要与高频问答，响应更快',
    icon: Zap,
  },
  {
    value: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: '适合深度研究、跨视频综合与复杂计划',
    icon: BrainCircuit,
  },
];

interface Props {
  config: LlmConfig | null;
  onConfigChange: (config: LlmConfig) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}

export default function AdminLlmConfigPanel({
  config,
  onConfigChange,
  onMessage,
  onError,
}: Props) {
  const [provider, setProvider] = useState<'deepseek' | 'custom'>('deepseek');
  const [model, setModel] = useState('deepseek-v4-flash');
  const [apiBase, setApiBase] = useState(DEEPSEEK_API_BASE);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);

  useEffect(() => {
    if (!config) return;
    setProvider(config.provider);
    setModel(config.model);
    setApiBase(
      config.api_base
      || (config.provider === 'deepseek' ? DEEPSEEK_API_BASE : ''),
    );
  }, [config]);

  const save = async () => {
    const cleanModel = model.trim();
    const cleanBase = provider === 'deepseek' ? DEEPSEEK_API_BASE : apiBase.trim();
    if (!cleanModel) {
      onError('请填写模型名称');
      return;
    }
    if (provider === 'custom' && cleanBase && !/^https?:\/\//i.test(cleanBase)) {
      onError('自定义 API 地址必须以 http:// 或 https:// 开头');
      return;
    }

    setSaving(true);
    setTestResult(null);
    const result = await putLlmConfig({
      provider,
      model: cleanModel,
      api_base: cleanBase,
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    });
    setSaving(false);
    if (result.success && result.data) {
      onConfigChange(result.data);
      setApiKey('');
      onMessage('LLM 配置已保存并立即生效');
      return;
    }
    onError(result.error || '保存失败');
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testLlmConfig();
    setTesting(false);
    if (result.success && result.data) {
      setTestResult(result.data);
      return;
    }
    setTestResult({ ok: false, error: result.error || '请求失败' });
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-accent-emerald uppercase">
          <Sparkles size={14} aria-hidden="true" />
          Runtime AI
        </div>
        <h1 className="mt-2 text-2xl font-bold text-foreground">LLM 配置</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-foreground-muted">
          DeepSeek 模式只需选择模型并填写密钥，官方兼容地址由系统管理。保存后立即作用于内容提取、视频问答和计划 Agent。
        </p>
      </div>

      <section className="admin-panel overflow-hidden">
        <div className="border-b border-card-border p-5">
          <div className="text-sm font-semibold text-foreground">服务接入方式</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => {
                setProvider('deepseek');
                setApiBase(DEEPSEEK_API_BASE);
                if (!MODEL_OPTIONS.some(option => option.value === model)) {
                  setModel('deepseek-v4-flash');
                }
              }}
              className={`min-h-20 rounded-xl border p-4 text-left transition-colors ${
                provider === 'deepseek'
                  ? 'border-accent-emerald/50 bg-accent-emerald/8'
                  : 'border-card-border bg-[var(--admin-surface-2)] hover:border-accent-emerald/25'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Sparkles size={17} className="text-accent-emerald" aria-hidden="true" />
                  DeepSeek 官方
                </span>
                {provider === 'deepseek' && <CheckCircle2 size={17} className="text-accent-emerald" aria-hidden="true" />}
              </div>
              <p className="mt-2 text-xs leading-5 text-foreground-muted">预设模型与地址，减少配置错误</p>
            </button>
            <button
              type="button"
              onClick={() => setProvider('custom')}
              className={`min-h-20 rounded-xl border p-4 text-left transition-colors ${
                provider === 'custom'
                  ? 'border-accent-indigo/50 bg-accent-indigo/8'
                  : 'border-card-border bg-[var(--admin-surface-2)] hover:border-accent-indigo/25'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Link2 size={17} className="text-accent-indigo" aria-hidden="true" />
                  自定义兼容接口
                </span>
                {provider === 'custom' && <CheckCircle2 size={17} className="text-accent-indigo" aria-hidden="true" />}
              </div>
              <p className="mt-2 text-xs leading-5 text-foreground-muted">保留现有代理和其他 OpenAI 兼容模型</p>
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {provider === 'deepseek' ? (
            <div>
              <label className="mb-2 block text-sm font-semibold text-foreground">选择模型</label>
              <div className="grid gap-2 md:grid-cols-2">
                {MODEL_OPTIONS.map(option => {
                  const Icon = option.icon;
                  const selected = model === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setModel(option.value)}
                      className={`rounded-xl border p-4 text-left transition-colors ${
                        selected
                          ? 'border-accent-emerald/50 bg-accent-emerald/8'
                          : 'border-card-border bg-[var(--admin-surface-2)] hover:border-accent-emerald/25'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 items-center justify-center rounded-lg bg-background">
                            <Icon size={17} className={selected ? 'text-accent-emerald' : 'text-foreground-muted'} aria-hidden="true" />
                          </span>
                          <span>
                            <span className="block text-sm font-semibold text-foreground">{option.name}</span>
                            <code className="text-[11px] text-foreground-muted">{option.value}</code>
                          </span>
                        </div>
                        {selected && <CheckCircle2 size={17} className="mt-1 shrink-0 text-accent-emerald" aria-hidden="true" />}
                      </div>
                      <p className="mt-3 text-xs leading-5 text-foreground-muted">{option.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="模型名称"
                value={model}
                onChange={setModel}
                placeholder="deepseek/deepseek-chat"
              />
              <Field
                label="API Base"
                value={apiBase}
                onChange={setApiBase}
                placeholder="https://example.com/v1"
              />
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-[1fr_1.25fr]">
            <div>
              <label className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <KeyRound size={16} className="text-foreground-muted" aria-hidden="true" />
                API Key
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={config?.api_key_masked ? `当前 ${config.api_key_masked}，留空不改` : '填写 DeepSeek API Key'}
                className="min-h-11 w-full rounded-xl border border-card-border bg-[var(--admin-surface-2)] px-3 text-base text-foreground outline-none placeholder:text-foreground-muted/50 focus:border-accent-emerald/50 sm:text-sm"
              />
              <p className="mt-2 flex items-center gap-1.5 text-xs text-foreground-muted">
                <ShieldCheck size={14} className="text-accent-emerald" aria-hidden="true" />
                密钥经 Fernet 加密存储，页面只返回掩码
              </p>
            </div>

            <div className="rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-foreground-muted">
                <Link2 size={14} aria-hidden="true" />
                当前调用地址
              </div>
              <code className="mt-2 block break-all text-sm font-semibold text-foreground">
                {provider === 'deepseek' ? DEEPSEEK_API_BASE : apiBase || '由模型提供商决定'}
              </code>
              <p className="mt-2 text-xs leading-5 text-foreground-muted">
                {provider === 'deepseek'
                  ? '由系统锁定为 DeepSeek OpenAI 兼容地址，无需手动维护。'
                  : '自定义模式下由管理员维护地址和模型兼容性。'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-card-border pt-4">
            <button
              type="button"
              onClick={save}
              disabled={saving || testing}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-accent-emerald px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-emerald/90 disabled:opacity-50"
            >
              {saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
              {saving ? '保存中' : '保存并应用'}
            </button>
            <button
              type="button"
              onClick={test}
              disabled={saving || testing || !config?.api_key_masked}
              title={!config?.api_key_masked ? '请先保存 API Key' : undefined}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-4 text-sm font-semibold text-foreground transition-colors hover:border-accent-emerald/35 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {testing && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
              {testing ? '测试中' : '测试当前连接'}
            </button>
            <span className="text-xs text-foreground-muted">配置更新无需重启服务</span>
          </div>

          {testResult && (
            <div className={`rounded-xl border px-4 py-3 text-sm ${
              testResult.ok
                ? 'border-accent-emerald/25 bg-accent-emerald/7 text-accent-emerald'
                : 'border-accent-rose/25 bg-accent-rose/7 text-accent-rose'
            }`}>
              {testResult.ok ? '连接成功' : testResult.error || '连接失败'}
              {testResult.model ? <span className="ml-2 text-xs opacity-75">{testResult.model}</span> : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-semibold text-foreground">{label}</label>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-11 w-full rounded-xl border border-card-border bg-[var(--admin-surface-2)] px-3 text-base text-foreground outline-none placeholder:text-foreground-muted/50 focus:border-accent-emerald/50 sm:text-sm"
      />
    </div>
  );
}
