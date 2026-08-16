'use client';

import { useEffect, useState } from 'react';
import { Check, Eye, KeyRound, RotateCcw, Server, TestTube2 } from 'lucide-react';
import {
  deleteUserVisionProvider,
  getUserVisionProvider,
  saveUserVisionProvider,
  testUserVisionProvider,
} from '@/lib/api';
import type { UserVisionProviderConfig } from '@/lib/types';
import styles from './UserAIProviderSettingsCard.module.css';

type BusyAction = 'save' | 'test' | 'reset' | '';

export default function UserVisionProviderSettingsCard() {
  const [config, setConfig] = useState<UserVisionProviderConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [providerName, setProviderName] = useState('OpenAI Compatible');
  const [driver, setDriver] = useState('openai_compatible');
  const [model, setModel] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<BusyAction>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const applyConfig = (value: UserVisionProviderConfig) => {
    setConfig(value);
    setEnabled(Boolean(value.enabled));
    setProviderName(value.provider_name || 'OpenAI Compatible');
    setDriver(value.driver || 'openai_compatible');
    setModel(value.model || '');
    setApiBase(value.api_base || '');
    setApiKey('');
  };

  useEffect(() => {
    let active = true;
    void getUserVisionProvider().then(response => {
      if (!active) return;
      if (response.success && response.data) applyConfig(response.data);
      else setError(response.error || '无法读取视觉模型配置。');
    });
    return () => {
      active = false;
    };
  }, []);

  const persist = async (nextEnabled = enabled) => {
    const response = await saveUserVisionProvider({
      enabled: nextEnabled,
      provider_name: providerName.trim(),
      driver,
      model: model.trim(),
      api_base: apiBase.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    });
    if (response.success && response.data) {
      applyConfig(response.data);
      return response.data;
    }
    setError(response.error || '视觉模型保存失败，请检查配置。');
    return null;
  };

  const save = async () => {
    if (!enabled && !config?.configured) {
      setMessage('当前未启用自有视觉模型，无需额外配置。');
      setError('');
      return;
    }
    setBusy('save');
    setMessage('');
    setError('');
    const saved = await persist();
    setBusy('');
    if (saved) {
      setMessage(saved.enabled ? '视觉模型配置已保存。' : '已停用自有视觉模型。');
    }
  };

  const test = async () => {
    setBusy('test');
    setMessage('');
    setError('');
    const saved = await persist(true);
    if (!saved) {
      setBusy('');
      return;
    }
    const response = await testUserVisionProvider();
    setBusy('');
    if (response.success && response.data && (response.data.ok ?? response.data.connected ?? true)) {
      if (response.data.config) applyConfig(response.data.config);
      setMessage(response.data.message || '真实图片测试通过，模型能够读取关键帧。');
    } else {
      setError(response.error || response.data?.message || '图片能力测试失败，请检查地址、模型和密钥。');
    }
  };

  const reset = async () => {
    setBusy('reset');
    setMessage('');
    setError('');
    const response = await deleteUserVisionProvider();
    setBusy('');
    if (response.success && response.data) {
      applyConfig(response.data);
      setMessage('已清除独立的视觉模型凭证。');
    } else {
      setError(response.error || '清除失败，请稍后重试。');
    }
  };

  const credentialsReady = Boolean(
    providerName.trim()
    && model.trim()
    && apiBase.trim()
    && (apiKey.trim() || config?.api_key_set),
  );

  return (
    <section id="vision-provider" className={styles.card} aria-labelledby="user-vision-provider-title">
      <header className={styles.header}>
        <div className={styles.identity}><Eye size={20} aria-hidden="true" /></div>
        <div>
          <h2 id="user-vision-provider-title">视频画面识别</h2>
          <p>只有详细解析视频画面时才会使用。一般情况下保持默认即可。</p>
        </div>
      </header>

      {!config ? <div className={styles.loading} aria-label="正在读取视觉模型配置" /> : (
        <>
          <div className={styles.modeGrid} role="radiogroup" aria-label="视觉模型使用方式">
            <button
              type="button"
              role="radio"
              aria-checked={!enabled}
              className={!enabled ? styles.selected : ''}
              onClick={() => setEnabled(false)}
            >
              <span className={styles.modeIcon}><Server size={18} /></span>
              <span className={styles.modeCopy}>
                <strong>使用平台能力（推荐）</strong>
                <small>无需配置，详细解析时按可用方案选择</small>
              </span>
              {!enabled ? <Check size={17} aria-hidden="true" /> : null}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={enabled}
              className={enabled ? styles.selected : ''}
              onClick={() => setEnabled(true)}
            >
              <span className={styles.modeIcon}><KeyRound size={18} /></span>
              <span className={styles.modeCopy}>
                <strong>使用我的 API Key</strong>
                <small>只适合已有视觉模型供应商账号的用户</small>
              </span>
              {enabled ? <Check size={17} aria-hidden="true" /> : null}
            </button>
          </div>

          {enabled && (
            <div className={styles.form}>
              <label>
                <span>视觉驱动</span>
                <select value={driver} onChange={event => setDriver(event.target.value)}>
                  <option value="openai_compatible">OpenAI 图片兼容接口</option>
                  <option value="litellm_image">LiteLLM 图片模型</option>
                </select>
              </label>
              <label>
                <span>供应商名称</span>
                <input value={providerName} onChange={event => setProviderName(event.target.value)} placeholder="例如：OpenAI、SiliconFlow" />
              </label>
              <label>
                <span>模型名称</span>
                <input value={model} onChange={event => setModel(event.target.value)} placeholder="例如：gpt-4.1-mini" />
              </label>
              <label>
                <span>API Base</span>
                <input value={apiBase} onChange={event => setApiBase(event.target.value)} placeholder="https://api.example.com/v1" inputMode="url" />
              </label>
              <label>
                <span>API Key {config.api_key_set ? `· 已保存 ${config.api_key_masked || ''}` : ''}</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  placeholder={config.api_key_set ? '留空则继续使用已保存密钥' : '输入视觉模型密钥'}
                  autoComplete="off"
                />
              </label>
              <aside>
                <strong>测试会发送一张真实的小尺寸测试图片</strong>
                <p>知萃不会把这套密钥用于文字问答，也不会在失败时静默切换到平台收费模型。供应商已经产生的费用无法由知萃退款。</p>
              </aside>
            </div>
          )}

          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {message ? <p className={styles.success} role="status">{message}</p> : null}

          <footer className={styles.actions}>
            {config.configured ? (
              <button type="button" className={styles.reset} onClick={() => void reset()} disabled={Boolean(busy)}>
                <RotateCcw size={16} />{busy === 'reset' ? '正在清除' : '清除视觉凭证'}
              </button>
            ) : <span />}
            <div>
              {enabled && (
                <button type="button" onClick={() => void test()} disabled={Boolean(busy) || !credentialsReady}>
                  <TestTube2 size={16} />{busy === 'test' ? '正在测试图片' : '保存并测试图片'}
                </button>
              )}
              <button
                type="button"
                className={styles.save}
                onClick={() => void save()}
                disabled={Boolean(busy) || (enabled && !credentialsReady)}
              >
                {busy === 'save' ? '正在保存' : '保存设置'}
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
