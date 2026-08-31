'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleDashed,
  Cloud,
  Coins,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Server,
  TestTube2,
  Trash,
} from 'lucide-react';
import AIModelIcon from '@/components/AIModelIcon';
import {
  createUserCustomChatModel,
  deleteUserCustomChatModel,
  getUserAIProvider,
  getUserChatModels,
  listUserCustomChatModels,
  selectPlatformChatModel,
  selectUserChatModel,
  selectUserCustomChatModel,
  testUserCustomChatModel,
  updateUserCustomChatModel,
  type UserAIProviderConfig,
  type UserChatModel,
  type UserChatModelCatalog,
  type UserCustomChatModel,
} from '@/lib/api';
import styles from './UserCustomModelsSettingsCard.module.css';

interface Draft {
  id: string | null;
  name: string;
  provider_name: string;
  model: string;
  api_base: string;
  api_key: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  provider_name: '',
  model: '',
  api_base: '',
  api_key: '',
  enabled: true,
};

export default function UserCustomModelsSettingsCard() {
  const [config, setConfig] = useState<UserAIProviderConfig | null>(null);
  const [catalog, setCatalog] = useState<UserChatModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [customModels, setCustomModels] = useState<UserCustomChatModel[]>([]);
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setLoadError('');
    const [provider, models, custom] = await Promise.all([
      getUserAIProvider(),
      getUserChatModels(),
      listUserCustomChatModels(),
    ]);
    const failures: string[] = [];
    if (provider.success && provider.data) {
      setConfig(provider.data);
      setCustomModels(provider.data.custom_models ?? []);
    } else if (!provider.success) {
      failures.push(provider.error || '无法读取模型配置。');
    }
    if (models.success && models.data) {
      setCatalog(models.data);
      setSelectedOfferingId(models.data.selected_offering_id);
    } else if (!models.success) {
      setCatalog(null);
      failures.push(models.error || '无法读取可用模型。');
    }
    if (custom.success && custom.data) {
      setCustomModels(custom.data.items);
    } else if (!custom.success) {
      failures.push(custom.error || '无法读取自定义模型。');
    }
    setLoadError(failures.join('；'));
    if (showLoading) setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const beginAdd = () => {
    setMessage(''); setError(''); setShowKey(false);
    setDraft({ ...EMPTY_DRAFT });
  };

  const beginEdit = (item: UserCustomChatModel) => {
    setMessage(''); setError(''); setShowKey(false);
    setDraft({
      id: item.id,
      name: item.name,
      provider_name: item.provider_name,
      model: item.model,
      api_base: item.api_base,
      api_key: '',
      enabled: item.enabled,
    });
  };

  const cancelDraft = () => {
    setDraft(null); setError(''); setMessage(''); setShowKey(false);
  };

  const persistDraft = async () => {
    if (!draft) return null;
    setBusy(draft.id ? 'save' : 'add'); setMessage(''); setError('');
    const trimmedName = draft.name.trim();
    const trimmedProvider = draft.provider_name.trim();
    const body = {
      name: trimmedName || trimmedProvider || draft.model.trim(),
      provider_name: trimmedProvider || 'OpenAI Compatible',
      model: draft.model.trim(),
      api_base: draft.api_base.trim(),
      api_key: draft.api_key.trim() || undefined,
      enabled: draft.enabled,
    };
    const response = draft.id
      ? await updateUserCustomChatModel(draft.id, body)
      : await createUserCustomChatModel({ ...body, select: true });
    setBusy('');
    if (response.success && response.data) {
      setDraft(null);
      setShowKey(false);
      await load(false);
      setMessage(draft.id ? '模型已更新。' : '模型已保存并设为当前。');
      return response.data;
    }
    setError(response.error || '保存失败，请检查配置。');
    return null;
  };

  const remove = async (item: UserCustomChatModel) => {
    setBusy(item.id); setMessage(''); setError('');
    const response = await deleteUserCustomChatModel(item.id);
    setBusy('');
    if (response.success) {
      setPendingDeleteId('');
      await load(false);
      setMessage(response.data?.selection_reset ? '已删除，当前已切回平台模型。' : '已删除。');
    } else {
      setError(response.error || '删除失败，请稍后重试。');
    }
  };

  const activate = async (item: UserCustomChatModel) => {
    setBusy(item.id); setMessage(''); setError('');
    const response = await selectUserCustomChatModel(item.id);
    setBusy('');
    if (response.success && response.data) {
      setCustomModels(response.data.items);
      await load(false);
      setMessage(`已切换为「${item.name}」。`);
    } else {
      setError(response.error || '切换失败。');
    }
  };

  const activatePlatform = async (offeringId: string) => {
    setBusy('platform'); setMessage(''); setError('');
    const response = await selectUserChatModel(offeringId);
    if (!response.success || !response.data) {
      setBusy('');
      setError(response.error || '模型切换失败。');
      return;
    }
    const modeResponse = await selectPlatformChatModel();
    if (!modeResponse.success) {
      setBusy('');
      await load(false);
      setError(modeResponse.error || '平台模型已选择，但未能完成模式切换，请重试。');
      return;
    }
    setBusy('');
    setSelectedOfferingId(response.data.selected_offering_id);
    await load(false);
    setMessage('已切换为平台模型。');
  };

  const test = async (item: UserCustomChatModel) => {
    setBusy(item.id); setMessage(''); setError('');
    const response = await testUserCustomChatModel(item.id);
    setBusy('');
    if (response.success && response.data) setMessage(`连接成功：${response.data.model}`);
    else setError(response.error || '连接失败，请检查模型、地址和密钥。');
  };

  const draftReady = Boolean(
    draft
    && draft.model.trim()
    && draft.api_base.trim()
    && (draft.api_key.trim() || !!draft.id),
  );

  const platformMeta = (item: UserChatModel): string => {
    const price = item.is_free
      ? (item.free_daily_limit > 0
          ? `免费 · 今日剩余 ${item.free_remaining_today ?? '0'} 次`
          : '免费 · 不限次')
      : `${item.points_per_request} 萃点/次`;
    return [price, item.description].filter(Boolean).join(' · ');
  };

  const currentModelLabel = config?.mode === 'custom'
    ? customModels.find(item => item.is_selected)?.name || config.model || '自定义模型'
    : catalog?.items.find(item => item.id === selectedOfferingId)?.name
      || config?.selected_offering_name
      || '知萃平台模型';

  return (
    <section id="custom-models" className={styles.card} aria-labelledby="custom-models-title">
      <header className={styles.header}>
        <div className={styles.identity}><Cloud size={20} aria-hidden="true" /></div>
        <div className={styles.headerCopy}>
          <h2 id="custom-models-title" tabIndex={-1}>回答模型</h2>
          <p>选择知萃平台模型，或接入你自己的 OpenAI 兼容接口。</p>
        </div>
        {catalog ? (
          <div className={styles.currentState} aria-label={`当前使用：${currentModelLabel}`}>
            <span>当前使用</span>
            <strong>{currentModelLabel}</strong>
          </div>
        ) : null}
      </header>

      {loading ? (
        <div className={styles.statePanel} role="status">
          <LoaderCircle size={19} className={styles.spinner} aria-hidden="true" />
          <span>正在读取回答模型…</span>
        </div>
      ) : !catalog ? (
        <div className={styles.statePanel} data-tone="error" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <span>{loadError || '回答模型暂时无法读取。'}</span>
          <button type="button" onClick={() => void load()}>重新加载</button>
        </div>
      ) : (
        <>
          <section className={styles.group} aria-labelledby="platform-models-title">
            <header className={styles.groupHeader}>
              <div>
                <h3 id="platform-models-title"><Server size={15} aria-hidden="true" /> 知萃平台</h3>
                <p>免费额度优先使用，超出部分按萃点计费。</p>
              </div>
              <span className={styles.balance}><Coins size={14} aria-hidden="true" />可用 <strong>{catalog.account.available_points.toLocaleString('zh-CN')}</strong> 萃点</span>
            </header>
            <div className={styles.list} role="radiogroup" aria-label="平台模型">
              {catalog.items.map((item) => {
                const selected = config?.mode !== 'custom' && selectedOfferingId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`${styles.platformItem} ${selected ? styles.itemSelected : ''}`}
                    onClick={() => activatePlatform(item.id)}
                    disabled={Boolean(busy)}
                  >
                    <span className={styles.itemIcon} aria-hidden="true">
                      <AIModelIcon modelId={item.icon_key} name={item.name} size={18} />
                    </span>
                    <span className={styles.itemCopy}>
                      <span className={styles.itemTitle}>
                        <strong>{item.name}</strong>
                        {item.is_free ? <span className={styles.badgeFree}>免费</span> : null}
                        {item.is_default ? <span className={styles.badge}>默认</span> : null}
                        {selected ? <span className={styles.badgeCurrent}>当前</span> : null}
                      </span>
                      <small className={styles.itemMeta}>{platformMeta(item)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className={styles.group} aria-labelledby="custom-models-group-title">
            <header className={styles.groupHeader}>
              <div>
                <h3 id="custom-models-group-title"><KeyRound size={15} aria-hidden="true" /> 我的模型</h3>
                <p>用自己的 API Key 直接调模型，不消耗平台萃点。</p>
              </div>
              <button type="button" className={styles.addButton} onClick={beginAdd} disabled={Boolean(busy)}><Plus size={15} aria-hidden="true" />接入新模型</button>
            </header>

            {draft && (
              <div className={styles.form} role="form" aria-label={draft.id ? '编辑模型' : '接入模型'}>
                <div className={styles.formTitle}>
                  <span className={styles.formIcon} aria-hidden="true"><Plus size={16} /></span>
                  {draft.id ? '编辑模型' : '接入新模型'}
                </div>
                <div className={styles.formFields}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>显示名</span>
                    <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：深度求索" />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>供应商名称</span>
                    <input value={draft.provider_name} onChange={(event) => setDraft({ ...draft, provider_name: event.target.value })} placeholder="例如：DeepSeek" />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>模型名称</span>
                    <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="例如：deepseek-chat" />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>API Base</span>
                    <input value={draft.api_base} onChange={(event) => setDraft({ ...draft, api_base: event.target.value })} placeholder="https://api.deepseek.com/v1" inputMode="url" />
                  </label>
                  <div className={`${styles.field} ${styles.wide}`}>
                    <label className={styles.fieldLabel} htmlFor="custom-model-api-key">API Key {draft.id ? '· 留空沿用已保存密钥' : ''}</label>
                    <span className={styles.inputWrap}>
                      <input
                        id="custom-model-api-key"
                        type={showKey ? 'text' : 'password'}
                        value={draft.api_key}
                        onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                        placeholder={draft.id ? '留空沿用已保存密钥' : '输入 API Key'}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className={styles.keyToggle}
                        onClick={() => setShowKey((value) => !value)}
                        aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                      >
                        {showKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                      </button>
                    </span>
                  </div>
                  <label className={`${styles.toggleField} ${styles.wide}`}>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    <span>
                      <strong>启用这个模型</strong>
                      <small>停用后不会出现在对话模型选择中，之后仍可重新启用。</small>
                    </span>
                  </label>
                </div>
                <div className={styles.formActions}>
                  <button type="button" onClick={cancelDraft}>取消</button>
                  <button type="button" className={styles.save} onClick={() => void persistDraft()} disabled={Boolean(busy) || !draftReady}>
                    {busy === 'add' ? '正在保存' : busy === 'save' ? '正在更新' : draft.id ? '保存修改' : '保存并设为当前'}
                  </button>
                </div>
              </div>
            )}

            {customModels.length === 0 && !draft ? (
              <div className={styles.empty}>
                <CircleDashed size={26} aria-hidden="true" />
                <p>还没有自定义模型。接入一个即可在对话中直接使用你自己的余额，不再消耗平台萃点。</p>
              </div>
            ) : (
              <div className={styles.list} role="list" aria-label="自定义模型">
                {customModels.map((item) => {
                  const selected = item.is_selected;
                  return (
                    <div key={item.id} className={`${styles.customItem} ${selected ? styles.itemSelected : ''}`}>
                      <span className={styles.itemIcon} aria-hidden="true">
                        <AIModelIcon code={`custom:${item.id}`} modelId={item.model} name={item.name} provider={item.provider_name} size={18} />
                      </span>
                      <span className={styles.itemCopy}>
                        <span className={styles.itemTitle}>
                          <strong>{item.name || item.provider_name}</strong>
                          {item.enabled ? <span className={styles.badge}>已启用</span> : <span className={styles.badgeOff}>已停用</span>}
                          {selected ? <span className={styles.badgeCurrent}>当前</span> : null}
                        </span>
                        <small className={styles.itemMeta}>{item.model} · {item.api_key_set ? `密钥 ${item.api_key_masked}` : '未设置密钥'}</small>
                      </span>
                      <span className={styles.itemActions}>
                        <button type="button" className={selected ? styles.currentOn : styles.primaryGhost} onClick={() => activate(item)} disabled={Boolean(busy) || !item.enabled || selected} title={selected ? '当前使用' : '设为当前'}>
                          {selected ? <><Check size={15} aria-hidden="true" />当前使用</> : '设为当前'}
                        </button>
                        <button type="button" aria-label="测试连接" title="测试连接" onClick={() => test(item)} disabled={Boolean(busy)}><TestTube2 size={16} aria-hidden="true" /></button>
                        <button type="button" aria-label="编辑" title="编辑" onClick={() => beginEdit(item)} disabled={Boolean(busy)}><Pencil size={16} aria-hidden="true" /></button>
                        <button
                          type="button"
                          aria-label={pendingDeleteId === item.id ? `确认删除 ${item.name}` : `删除 ${item.name}`}
                          title={pendingDeleteId === item.id ? '再次点击确认删除' : '删除'}
                          className={styles.danger}
                          data-confirming={pendingDeleteId === item.id || undefined}
                          onClick={() => {
                            if (pendingDeleteId === item.id) void remove(item);
                            else {
                              setPendingDeleteId(item.id);
                              setMessage('再次点击“确认”即可删除；其他设置不会受影响。');
                              setError('');
                            }
                          }}
                          disabled={Boolean(busy)}
                        >
                          {pendingDeleteId === item.id ? <span>确认</span> : <Trash size={16} aria-hidden="true" />}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {loadError || error || message ? (
            <div
              className={styles.statusRow}
              data-tone={loadError || error ? 'error' : 'success'}
              role={loadError || error ? 'alert' : 'status'}
            >
              {loadError || error
                ? <AlertCircle size={17} aria-hidden="true" />
                : <CheckCircle2 size={17} aria-hidden="true" />}
              <span>{loadError || error || message}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
