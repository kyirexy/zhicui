'use client';

import { Check, StackSimple } from '@phosphor-icons/react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import type { AgentSourceDisplayLimit } from '@/lib/types';
import styles from './AgentSourceLimitSettingsCard.module.css';

const LIMIT_OPTIONS: AgentSourceDisplayLimit[] = [100, 200, 500, 1000];

export default function AgentSourceLimitSettingsCard() {
  const { settings, updateAgentSourceDisplayLimit } = useSettings();

  return (
    <section className={styles.card} aria-labelledby="agent-source-limit-title">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <StackSimple size={21} weight="duotone" />
        </span>
        <div>
          <h2 id="agent-source-limit-title">问答列表显示数量</h2>
          <p>只影响左侧列表一次加载多少条视频。</p>
        </div>
      </header>

      <div className={styles.options} role="radiogroup" aria-label="问答资料显示数量">
        {LIMIT_OPTIONS.map((limit) => {
          const selected = settings.agentSourceDisplayLimit === limit;
          return (
            <button
              key={limit}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? styles.selected : ''}
              onClick={() => updateAgentSourceDisplayLimit(limit)}
            >
              <span>{limit.toLocaleString('zh-CN')} 条</span>
              {selected && <Check size={14} weight="bold" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <p className={styles.note}>推荐 200 条。数量越大，第一次打开列表越慢；单次仍最多选择 100 条。</p>
    </section>
  );
}
