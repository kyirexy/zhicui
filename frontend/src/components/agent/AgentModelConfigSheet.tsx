'use client';

import {
  Check,
  FloppyDisk,
  LinkBreak,
  Plug,
  PlugsConnected,
} from '@phosphor-icons/react';

export type ModelConfigSaveResult = {
  kind: 'saved' | 'tested' | 'reset';
  label: string;
};

export interface ModelConfigDraft {
  providerName: string;
  model: string;
  apiBase: string;
  apiKey: string;
}

export default function AgentModelConfigSheet({
  open,
  busy,
  apiKeySet,
  apiKeyMasked,
  draft,
  disabled = false,
  error = '',
  success = '',
  onDraftChange,
  onSave,
  onTest,
  onReset,
  onClose,
}: {
  open: boolean;
  busy: '' | 'save' | 'test' | 'reset';
  apiKeySet: boolean;
  apiKeyMasked: string;
  draft: ModelConfigDraft;
  disabled?: boolean;
  error?: string;
  success?: string;
  onDraftChange: (patch: Partial<ModelConfigDraft>) => void;
  onSave: () => void;
  onTest: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  const canSubmit = Boolean(
    draft.model.trim()
    && draft.apiBase.trim()
    && (draft.apiKey.trim() || apiKeySet),
  );

  return (
    <section className="video-agent-model-config" role="dialog" aria-label="连接自己的模型">
      <header className="video-agent-model-config-header">
        <PlugsConnected size={18} weight="duotone" aria-hidden="true" />
        <div>
          <strong>连接自己的模型</strong>
          <small>填写 OpenAI 兼容接口，直接用你自己的额度。</small>
        </div>
        <button
          type="button"
          className="video-agent-model-config-close"
          onClick={onClose}
          aria-label="关闭模型配置"
        >
          ×
        </button>
      </header>

      <div className="video-agent-model-config-body">
        <label>
          <span>供应商</span>
          <input
            value={draft.providerName}
            disabled={disabled}
            onChange={(event) => onDraftChange({ providerName: event.target.value })}
            placeholder="例如：DeepSeek"
          />
        </label>
        <label>
          <span>模型名称</span>
          <input
            value={draft.model}
            disabled={disabled}
            onChange={(event) => onDraftChange({ model: event.target.value })}
            placeholder="例如：deepseek-chat"
          />
        </label>
        <label>
          <span>API Base</span>
          <input
            value={draft.apiBase}
            disabled={disabled}
            onChange={(event) => onDraftChange({ apiBase: event.target.value })}
            placeholder="https://api.example.com/v1"
            inputMode="url"
          />
        </label>
        <label>
          <span>{apiKeySet ? `API Key · 已保存 ${apiKeyMasked}` : 'API Key'}</span>
          <input
            type="password"
            value={draft.apiKey}
            disabled={disabled}
            onChange={(event) => onDraftChange({ apiKey: event.target.value })}
            placeholder={apiKeySet ? '留空继续使用已保存密钥' : '输入 API Key'}
            autoComplete="off"
          />
        </label>
      </div>

      {error ? <p className="video-agent-model-config-feedback is-error" role="alert">{error}</p> : null}
      {success ? <p className="video-agent-model-config-feedback" role="status">{success}</p> : null}

      <footer className="video-agent-model-config-actions">
        {apiKeySet ? (
          <button
            type="button"
            className="video-agent-model-config-reset"
            onClick={onReset}
            disabled={disabled || Boolean(busy)}
          >
            <LinkBreak size={15} aria-hidden="true" />
            {busy === 'reset' ? '正在恢复' : '恢复平台模型'}
          </button>
        ) : (
          <span />
        )}
        <span className="video-agent-model-config-cta">
          <button
            type="button"
            onClick={onTest}
            disabled={disabled || Boolean(busy) || !canSubmit}
          >
            <Plug size={15} aria-hidden="true" />
            {busy === 'test' ? '正在测试' : '保存并测试'}
          </button>
          <button
            type="button"
            className="video-agent-model-config-save"
            onClick={onSave}
            disabled={disabled || Boolean(busy) || !canSubmit}
          >
            {busy === 'save' ? <Check size={15} aria-hidden="true" /> : <FloppyDisk size={15} aria-hidden="true" />}
            {busy === 'save' ? '正在保存' : '保存'}
          </button>
        </span>
      </footer>
    </section>
  );
}
