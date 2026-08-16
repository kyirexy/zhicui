'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChatCircleDots,
  CircleNotch,
  Coins,
  ImageSquare,
  Gift,
  Key,
  MagnifyingGlass,
  Robot,
  Sparkle,
  Wrench,
  WarningCircle,
} from '@phosphor-icons/react';
import {
  getUserChatModels,
  selectUserChatModel,
  type UserChatModel,
  type UserChatModelCatalog,
} from '@/lib/api';
import styles from './AIRoutingWorkspace.module.css';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';

function LoadingWorkspace() {
  return (
    <main className={styles.loading} aria-label="正在读取 AI 助手">
      <div className={styles.loadingHeader} />
      <div className={styles.loadingOverview}><div /><div /></div>
      <div className={styles.loadingList}>
        {Array.from({ length: 4 }, (_, index) => <div key={index} />)}
      </div>
    </main>
  );
}

function priceLabel(model: UserChatModel) {
  if (!model.is_free) return `${model.points_per_request} 萃点/次`;
  if (model.free_daily_limit === 0) return '已包含 · 不限次数';
  return `今日可用 ${model.free_remaining_today ?? 0}/${model.free_daily_limit}`;
}

export default function AIModelsPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [catalog, setCatalog] = useState<UserChatModelCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isMobile) router.replace('/agent');
  }, [isMobile, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const response = await getUserChatModels();
    if (response.success && response.data) setCatalog(response.data);
    else setError(response.error || '模型目录暂时无法读取。');
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filteredModels = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('zh-CN');
    if (!term) return catalog?.items || [];
    return (catalog?.items || []).filter((model) => (
      `${model.name} ${model.description}`.toLocaleLowerCase('zh-CN').includes(term)
    ));
  }, [catalog?.items, query]);

  const currentModel = catalog?.items.find((model) => model.id === catalog.selected_offering_id);
  const selectModel = async (model: UserChatModel) => {
    if (savingId || model.id === catalog?.selected_offering_id) return;
    setSavingId(model.id); setError(''); setNotice('');
    const response = await selectUserChatModel(model.id);
    setSavingId('');
    if (!response.success || !response.data) {
      setError(response.error || '模型切换失败。');
      return;
    }
    setCatalog((current) => current ? {
      ...current,
      selected_offering_id: response.data!.selected_offering_id,
    } : current);
    setNotice(`已切换到 ${model.name}`);
  };

  if (loading || isMobile) return <LoadingWorkspace />;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>回答偏好</span>
          <h1>选择 AI 助手</h1>
          <p>选择适合当前任务的助手，之后提问会自动使用它。</p>
        </div>
        <Link className={styles.providerLink} href="/settings?section=ai">
          <Key size={17} weight="duotone" />连接自己的模型
        </Link>
      </header>

      <section className={styles.overview} aria-label="当前助手与使用额度">
        <article className={styles.activeModel}>
          <div className={styles.panelHeading}>
            <span className={styles.heroIcon}><Robot size={25} weight="duotone" /></span>
            <div><span className={styles.sectionLabel}>正在使用</span><h2>{currentModel?.name || '暂无可用助手'}</h2></div>
          </div>
          <dl className={styles.modelFacts}>
            <div><dt><Coins size={15} />使用额度</dt><dd>{currentModel ? priceLabel(currentModel) : '—'}</dd></div>
            <div><dt><ImageSquare size={15} />看图片</dt><dd>{currentModel?.supports_images ? '可以' : '暂不支持'}</dd></div>
            <div><dt><Wrench size={15} />用工具</dt><dd>{currentModel?.supports_tools ? '可以' : '暂不支持'}</dd></div>
          </dl>
        </article>
        <aside className={styles.routeSummary}>
          <div className={styles.balanceHeading}>
            <span className={styles.balanceIcon}><Coins size={20} weight="duotone" /></span>
            <div><span className={styles.sectionLabel}>我的额度</span><strong>{catalog?.account.available_points.toLocaleString('zh-CN') || '0'} 萃点</strong></div>
          </div>
          <div className={styles.summaryStats}>
            <div><strong>{catalog?.items.filter((item) => item.is_free).length || 0}</strong><span>已含额度</span></div>
            <div><strong>{catalog?.items.length || 0}</strong><span>可选助手</span></div>
          </div>
          <p className={styles.routeCopy}>只有成功回答才会扣除额度。</p>
        </aside>
      </section>

      {error || notice ? (
        <div className={`${styles.feedback} ${error ? styles.feedbackError : styles.feedbackSuccess}`} role={error ? 'alert' : 'status'}>
          {error ? <WarningCircle size={17} /> : <Check size={17} weight="bold" />}
          <span>{error || notice}</span>
        </div>
      ) : null}

      <section className={styles.catalog} aria-labelledby="model-list-title">
        <div className={styles.catalogHeader}>
          <div><span className={styles.sectionLabel}>AI 助手</span><h2 id="model-list-title">选择一个助手</h2></div>
          <label className={styles.searchField}>
            <MagnifyingGlass size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索助手" aria-label="搜索助手" />
          </label>
        </div>

        {filteredModels.length ? (
          <div className={styles.modelList}>
            {filteredModels.map((model) => {
              const selected = catalog?.selected_offering_id === model.id;
              const switching = savingId === model.id;
              return (
                <button key={model.id} type="button" className={selected ? styles.modelSelected : ''} onClick={() => void selectModel(model)} disabled={Boolean(savingId)} aria-pressed={selected}>
                  <span className={styles.modelMark}>
                    {model.supports_images ? <ImageSquare size={20} weight="duotone" /> : model.supports_tools ? <Wrench size={20} weight="duotone" /> : model.is_free ? <ChatCircleDots size={20} weight="duotone" /> : <Sparkle size={20} weight="duotone" />}
                  </span>
                  <span className={styles.modelCopy}><strong>{model.name}</strong><small>{model.description || '适合日常问答与资料整理'}</small></span>
                  <span className={styles.modelTraits}>
                    {model.supports_images ? <span><ImageSquare size={13} />可看图片</span> : null}
                    {model.supports_tools ? <span><Wrench size={13} />可用工具</span> : null}
                  </span>
                  <span className={styles.modelContext}><strong>{model.is_free ? <Gift size={16} weight="duotone" aria-label="已包含额度" /> : `${model.points_per_request} 萃点`}</strong><small>{model.is_free ? '已含额度' : '每次回答'}</small></span>
                  <span className={styles.priceState}>{priceLabel(model)}</span>
                  <span className={styles.selectState}>
                    {switching ? <CircleNotch size={17} /> : selected ? <Check size={16} weight="bold" /> : null}
                    {switching ? '切换中' : selected ? '使用中' : '选择'}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyState}>
            <MagnifyingGlass size={24} /><h3>没有找到助手</h3><button type="button" onClick={() => setQuery('')}>清空搜索</button>
          </div>
        )}
      </section>
    </main>
  );
}
