'use client';

import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Coins,
  KeyRound,
  RotateCcw,
  Server,
  TestTube2,
} from 'lucide-react';
import {
  getUserAIProvider,
  getUserChatModels,
  resetUserAIProvider,
  saveUserAIProvider,
  selectUserChatModel,
  testUserAIProvider,
  type UserAIProviderConfig,
  type UserChatModelCatalog,
} from '@/lib/api';
import styles from './UserAIProviderSettingsCard.module.css';

export default function UserAIProviderSettingsCard() {
  const [config, setConfig] = useState<UserAIProviderConfig | null>(null);
  const [catalog, setCatalog] = useState<UserChatModelCatalog | null>(null);
  const [mode, setMode] = useState<'platform' | 'custom'>('platform');
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [providerName, setProviderName] = useState('OpenAI Compatible');
  const [model, setModel] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'reset' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const applyConfig = (value: UserAIProviderConfig) => {
    setConfig(value);
    setMode(value.mode);
    if (value.mode === 'custom') {
      setProviderName(value.provider_name || 'OpenAI Compatible');
      setModel(value.model || '');
      setApiBase(value.api_base || '');
    }
    setApiKey('');
  };

  useEffect(() => {
    void Promise.all([getUserAIProvider(), getUserChatModels()]).then(([provider, models]) => {
      if (provider.success && provider.data) applyConfig(provider.data);
      else setError(provider.error || '无法读取 AI 服务配置。');
      if (models.success && models.data) {
        setCatalog(models.data);
        setSelectedOfferingId(models.data.selected_offering_id);
      } else if (!models.success) {
        setError(models.error || '无法读取可用模型。');
      }
      if (window.location.hash === '#ai-provider') {
        window.requestAnimationFrame(() => {
          document.getElementById('user-ai-provider-title')?.focus();
        });
      }
    });
  }, []);

  const persist = async () => {
    if (mode === 'platform') {
      const response = await selectUserChatModel(selectedOfferingId);
      if (!response.success || !response.data) {
        setError(response.error || '模型切换失败。');
        return null;
      }
      setCatalog((current) => current ? {
        ...current,
        selected_offering_id: response.data!.selected_offering_id,
      } : current);
      const provider = await getUserAIProvider();
      if (provider.success && provider.data) {
        applyConfig(provider.data);
        return provider.data;
      }
      setError(provider.error || '模型已切换，但状态刷新失败。');
      return null;
    }

    const response = await saveUserAIProvider({
      mode: 'custom',
      provider_name: providerName,
      model,
      api_base: apiBase,
      api_key: apiKey,
    });
    if (response.success && response.data) {
      applyConfig(response.data);
      return response.data;
    }
    setError(response.error || '保存失败，请检查配置。');
    return null;
  };

  const save = async () => {
    setBusy('save'); setMessage(''); setError('');
    const saved = await persist();
    setBusy('');
    if (saved) setMessage(saved.mode === 'custom' ? '已启用你的模型。' : '模型已切换。');
  };

  const test = async () => {
    setBusy('test'); setMessage(''); setError('');
    const saved = await persist();
    if (!saved) {
      setBusy('');
      return;
    }
    const response = await testUserAIProvider();
    setBusy('');
    if (response.success && response.data) setMessage(`连接成功：${response.data.model}`);
    else setError(response.error || '连接失败，请检查模型、地址和密钥。');
  };

  const reset = async () => {
    setBusy('reset'); setMessage(''); setError('');
    const response = await resetUserAIProvider();
    const models = await getUserChatModels();
    setBusy('');
    if (response.success && response.data) {
      applyConfig(response.data);
      if (models.success && models.data) {
        setCatalog(models.data);
        setSelectedOfferingId(models.data.selected_offering_id);
      }
      setMessage('已清除自定义配置并恢复默认模型。');
    } else setError(response.error || '恢复失败，请稍后重试。');
  };

  const customReady = Boolean(
    model.trim()
    && apiBase.trim()
    && (apiKey.trim() || config?.api_key_set),
  );
  const canSubmit = mode === 'platform' ? Boolean(selectedOfferingId) : customReady;

  return (
    <section id="ai-provider" className={styles.card} aria-labelledby="user-ai-provider-title">
      <header className={styles.header}>
        <div className={styles.identity}><Bot size={20} aria-hidden="true" /></div>
        <div>
          <h2 id="user-ai-provider-title" tabIndex={-1}>回答模型</h2>
          <p>选择平台模型，或使用自己的 OpenAI 兼容 API。</p>
        </div>
      </header>

      {!config || !catalog ? <div className={styles.loading} aria-label="正在读取 AI 服务配置" /> : (
        <>
          <div className={styles.modeGrid} role="radiogroup" aria-label="AI 服务来源">
            <button type="button" role="radio" aria-checked={mode === 'platform'} className={mode === 'platform' ? styles.selected : ''} onClick={() => setMode('platform')}>
              <span className={styles.modeIcon}><Server size={18} /></span>
              <span className={styles.modeCopy}><strong>知萃助手</strong><small>直接选择可用的回答助手</small></span>
              {mode === 'platform' ? <Check size={17} aria-hidden="true" /> : null}
            </button>
            <button type="button" role="radio" aria-checked={mode === 'custom'} className={mode === 'custom' ? styles.selected : ''} onClick={() => setMode('custom')}>
              <span className={styles.modeIcon}><KeyRound size={18} /></span>
              <span className={styles.modeCopy}><strong>使用我的 API Key</strong><small>自定义 OpenAI 兼容模型</small></span>
              {mode === 'custom' ? <Check size={17} aria-hidden="true" /> : null}
            </button>
          </div>

          {mode === 'custom' ? (
            <div className={styles.form}>
              <label><span>供应商名称</span><input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="例如：DeepSeek" /></label>
              <label><span>模型名称</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如：deepseek-chat" /></label>
              <label><span>API Base</span><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} placeholder="https://api.example.com/v1" inputMode="url" /></label>
              <label>
                <span>API Key {config.api_key_set ? `· 已保存 ${config.api_key_masked}` : ''}</span>
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.api_key_set ? '留空继续使用已保存密钥' : '输入 API Key'} autoComplete="off" />
              </label>
            </div>
          ) : (
            <div className={styles.modelCatalog}>
              <div className={styles.catalogMeta}>
                <span>可用模型</span>
                <strong><Coins size={15} aria-hidden="true" />{catalog.account.available_points.toLocaleString('zh-CN')} 萃点</strong>
              </div>
              <div className={styles.modelList} role="radiogroup" aria-label="平台模型">
                {catalog.items.map((item) => {
                  const selected = selectedOfferingId === item.id;
                  const price = item.is_free
                    ? item.free_daily_limit === 0
                      ? '已包含 · 不限次数'
                      : `今日可用 ${item.free_remaining_today ?? 0}/${item.free_daily_limit} 次`
                    : `${item.points_per_request} 萃点/次`;
                  return (
                    <button key={item.id} type="button" role="radio" aria-checked={selected} className={selected ? styles.selectedModel : ''} onClick={() => setSelectedOfferingId(item.id)}>
                      <span><strong>{item.name}</strong><small>{item.description || price}</small></span>
                      <em>{price}</em>
                      {selected ? <Check size={16} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {message ? <p className={styles.success} role="status">{message}</p> : null}

          <footer className={styles.actions}>
            {config.api_key_set ? <button type="button" className={styles.reset} onClick={() => void reset()} disabled={Boolean(busy)}><RotateCcw size={16} />{busy === 'reset' ? '正在恢复' : '清除自定义配置'}</button> : <span />}
            <div>
              <button type="button" onClick={() => void test()} disabled={Boolean(busy) || !canSubmit}><TestTube2 size={16} />{busy === 'test' ? '正在测试' : '保存并测试'}</button>
              <button type="button" className={styles.save} onClick={() => void save()} disabled={Boolean(busy) || !canSubmit}>{busy === 'save' ? '正在保存' : '保存设置'}</button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
