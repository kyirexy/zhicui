'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Info,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Server,
  TestTube2,
} from 'lucide-react';
import {
  deleteUserVisionProvider,
  getUserVisionProvider,
  saveUserVisionProvider,
  testUserVisionProvider,
} from '@/lib/api';
import type { UserVisionProviderConfig } from '@/lib/types';
import styles from './UserVisionProviderSettingsCard.module.css';

type BusyAction = 'save' | 'test' | 'reset' | '';

const FALLBACK_DRIVERS = [
  { value: 'openai_compatible', label: 'OpenAI 图片兼容接口' },
  { value: 'litellm_image', label: 'LiteLLM 图片模型' },
];

export default function UserVisionProviderSettingsCard() {
  const [config, setConfig] = useState<UserVisionProviderConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [providerName, setProviderName] = useState('OpenAI Compatible');
  const [driver, setDriver] = useState('openai_compatible');
  const [model, setModel] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
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
    setShowApiKey(false);
  };

  const loadConfig = async () => {
    setLoading(true);
    setLoadError('');
    const response = await getUserVisionProvider();
    if (response.success && response.data) {
      applyConfig(response.data);
    } else {
      setConfig(null);
      setLoadError(response.error || '无法读取视频画面识别配置。');
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const clearFeedback = () => {
    setMessage('');
    setError('');
  };

  const chooseMode = (nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    clearFeedback();
  };

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
    setBusy('save');
    clearFeedback();
    const saved = await persist();
    setBusy('');
    if (saved) {
      setMessage(saved.enabled ? '自定义画面识别已经启用。' : '已切换为知萃平台能力。');
    }
  };

  const test = async () => {
    setBusy('test');
    clearFeedback();
    const saved = await persist(true);
    if (!saved) {
      setBusy('');
      return;
    }
    const response = await testUserVisionProvider();
    setBusy('');
    if (response.success && response.data && (response.data.ok ?? response.data.connected ?? true)) {
      if (response.data.config) applyConfig(response.data.config);
      setMessage(response.data.message || '图片测试通过，模型可以读取视频关键帧。');
    } else {
      setError(response.error || response.data?.message || '图片测试失败，请检查地址、模型和密钥。');
    }
  };

  const reset = async () => {
    setBusy('reset');
    clearFeedback();
    const response = await deleteUserVisionProvider();
    setBusy('');
    if (response.success && response.data) {
      applyConfig(response.data);
      setMessage('自定义画面识别凭证已清除。');
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

  const isDirty = Boolean(config) && (
    enabled !== Boolean(config?.enabled)
    || (
      enabled
      && (
        providerName.trim() !== (config?.provider_name || 'OpenAI Compatible')
        || driver !== (config?.driver || 'openai_compatible')
        || model.trim() !== (config?.model || '')
        || apiBase.trim() !== (config?.api_base || '')
        || Boolean(apiKey.trim())
      )
    )
  );

  const drivers = useMemo(
    () => config?.supported_drivers?.length ? config.supported_drivers : FALLBACK_DRIVERS,
    [config?.supported_drivers],
  );

  const currentLabel = config?.enabled
    ? config.model || config.provider_name || '自定义视觉模型'
    : '知萃平台能力';

  return (
    <section id="vision-provider" className={styles.card} aria-labelledby="user-vision-provider-title">
      <header className={styles.header}>
        <div className={styles.identity}><ImageIcon size={20} aria-hidden="true" /></div>
        <div className={styles.headerCopy}>
          <h2 id="user-vision-provider-title">视频画面识别</h2>
          <p>只在详细解析视频画面时使用；普通文稿提取和问答不受影响。</p>
        </div>
        {config ? (
          <div className={styles.currentState} aria-label={`当前使用：${currentLabel}`}>
            <span>当前使用</span>
            <strong>{currentLabel}</strong>
          </div>
        ) : null}
      </header>

      {loading ? (
        <div className={styles.statePanel} role="status">
          <LoaderCircle size={19} className={styles.spinner} aria-hidden="true" />
          <span>正在读取画面识别设置…</span>
        </div>
      ) : !config ? (
        <div className={styles.statePanel} data-tone="error" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <span>{loadError || '画面识别设置暂时无法读取。'}</span>
          <button type="button" onClick={() => void loadConfig()}>重新加载</button>
        </div>
      ) : (
        <>
          <fieldset className={styles.modeFieldset}>
            <legend className="sr-only">选择视频画面识别方式</legend>
            <div className={styles.modeGrid}>
              <label className={!enabled ? styles.selected : ''}>
                <input type="radio" name="vision-provider-mode" checked={!enabled} onChange={() => chooseMode(false)} />
                <span className={styles.modeIcon}><Server size={18} aria-hidden="true" /></span>
                <span className={styles.modeCopy}>
                  <span className={styles.modeTitle}><strong>使用平台能力</strong><em>推荐</em></span>
                  <small>无需配置，详细解析时自动选择可用方案</small>
                </span>
                <span className={styles.modeCheck} aria-hidden="true">{!enabled ? <Check size={15} /> : null}</span>
              </label>
              <label className={enabled ? styles.selected : ''}>
                <input type="radio" name="vision-provider-mode" checked={enabled} onChange={() => chooseMode(true)} />
                <span className={styles.modeIcon}><KeyRound size={18} aria-hidden="true" /></span>
                <span className={styles.modeCopy}>
                  <span className={styles.modeTitle}><strong>使用我的 API Key</strong></span>
                  <small>适合已有视觉模型供应商账号的用户</small>
                </span>
                <span className={styles.modeCheck} aria-hidden="true">{enabled ? <Check size={15} /> : null}</span>
              </label>
            </div>
          </fieldset>

          {enabled ? (
            <div className={styles.formPanel}>
              <header className={styles.formHeader}>
                <span className={styles.formHeaderIcon} aria-hidden="true"><Eye size={17} /></span>
                <div>
                  <strong>自定义视觉接口</strong>
                  <p>接口需要支持图片输入；密钥只用于视频画面解析。</p>
                </div>
              </header>
              <div className={styles.formFields}>
                <label className={styles.field}>
                  <span>接口类型</span>
                  <select value={driver} onChange={event => { setDriver(event.target.value); clearFeedback(); }}>
                    {drivers.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>供应商名称</span>
                  <input value={providerName} onChange={event => { setProviderName(event.target.value); clearFeedback(); }} placeholder="例如：OpenAI、SiliconFlow" />
                </label>
                <label className={styles.field}>
                  <span>模型名称</span>
                  <input value={model} onChange={event => { setModel(event.target.value); clearFeedback(); }} placeholder="例如：gpt-4.1-mini" />
                </label>
                <label className={styles.field}>
                  <span>API Base</span>
                  <input value={apiBase} onChange={event => { setApiBase(event.target.value); clearFeedback(); }} placeholder="https://api.example.com/v1" inputMode="url" />
                </label>
                <div className={`${styles.field} ${styles.wideField}`}>
                  <label htmlFor="vision-provider-api-key">API Key {config.api_key_set ? `· 已保存 ${config.api_key_masked || ''}` : ''}</label>
                  <span className={styles.inputWrap}>
                    <input
                      id="vision-provider-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={event => { setApiKey(event.target.value); clearFeedback(); }}
                      placeholder={config.api_key_set ? '留空继续使用已保存密钥' : '输入视觉模型密钥'}
                      autoComplete="new-password"
                    />
                    <button type="button" className={styles.keyToggle} onClick={() => setShowApiKey(value => !value)} aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}>
                      {showApiKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </button>
                  </span>
                </div>
              </div>
              <aside className={styles.testNotice}>
                <Info size={17} aria-hidden="true" />
                <div>
                  <strong>测试会发送一张小尺寸图片</strong>
                  <p>供应商可能产生一次图片调用费用；失败时不会静默切换到平台收费模型。</p>
                </div>
              </aside>
            </div>
          ) : null}

          {error || message ? (
            <div className={styles.feedback} data-tone={error ? 'error' : 'success'} role={error ? 'alert' : 'status'}>
              {error ? <AlertCircle size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
              <span>{error || message}</span>
            </div>
          ) : null}

          <footer className={styles.actions}>
            <div className={styles.actionMeta}>
              {config.configured ? (
                <button type="button" className={styles.reset} onClick={() => void reset()} disabled={Boolean(busy)}>
                  <RotateCcw size={15} aria-hidden="true" />{busy === 'reset' ? '正在清除' : '清除自定义凭证'}
                </button>
              ) : null}
              <span data-dirty={isDirty || undefined}>
                {isDirty ? '有尚未保存的更改' : enabled ? '自定义画面识别已保存' : '平台能力已启用，无需额外配置'}
              </span>
            </div>
            <div className={styles.actionButtons}>
              {enabled ? (
                <button type="button" onClick={() => void test()} disabled={Boolean(busy) || !credentialsReady}>
                  <TestTube2 size={16} aria-hidden="true" />{busy === 'test' ? '正在测试图片' : '保存并测试'}
                </button>
              ) : null}
              {(enabled || isDirty) ? (
                <button type="button" className={styles.save} onClick={() => void save()} disabled={Boolean(busy) || !isDirty || (enabled && !credentialsReady)}>
                  {busy === 'save' ? '正在保存' : enabled ? '保存设置' : '切换为平台能力'}
                </button>
              ) : null}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
