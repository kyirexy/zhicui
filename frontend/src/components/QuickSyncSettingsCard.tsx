'use client';

import {
  ArrowsClockwise,
  BookmarkSimple,
  Check,
  Heart,
  UserCircle,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  QUICK_SYNC_CHANGED_EVENT,
  QUICK_SYNC_MAX_COUNT,
  readLibraryQuickSyncPreferences,
  requireQuickSyncConfirmation,
  saveLibraryQuickSyncPreferences,
} from '@/lib/libraryQuickSync';
import type { DouyinSourceMode } from '@/lib/types';
import styles from './QuickSyncSettingsCard.module.css';

const SOURCE_OPTIONS: Array<{
  value: DouyinSourceMode;
  label: string;
  Icon: typeof Heart;
}> = [
  { value: 'like', label: '喜欢', Icon: Heart },
  { value: 'collect', label: '收藏', Icon: BookmarkSimple },
  { value: 'post', label: '我的作品', Icon: UserCircle },
];

export default function QuickSyncSettingsCard() {
  const [configured, setConfigured] = useState(false);
  const [modes, setModes] = useState<DouyinSourceMode[]>(['collect']);
  const [count, setCount] = useState(50);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = () => {
      const preferences = readLibraryQuickSyncPreferences();
      setConfigured(preferences.configured);
      setModes(preferences.modes);
      setCount(preferences.count);
    };
    load();
    window.addEventListener(QUICK_SYNC_CHANGED_EVENT, load);
    return () => window.removeEventListener(QUICK_SYNC_CHANGED_EVENT, load);
  }, []);

  const toggleMode = (mode: DouyinSourceMode) => {
    setSaved(false);
    setModes((current) => {
      if (!current.includes(mode)) return [...current, mode];
      if (current.length === 1) return current;
      return current.filter((value) => value !== mode);
    });
  };

  const save = () => {
    const preferences = saveLibraryQuickSyncPreferences(modes, count);
    setConfigured(preferences.configured);
    setModes(preferences.modes);
    setCount(preferences.count);
    setSaved(true);
  };

  const confirmNextTime = () => {
    requireQuickSyncConfirmation();
    setConfigured(false);
    setSaved(false);
  };

  return (
    <section className={styles.card} aria-labelledby="quick-sync-settings-title">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <ArrowsClockwise size={21} weight="regular" />
        </span>
        <div>
          <h2 id="quick-sync-settings-title">首页快捷同步</h2>
          <p>保存后，首页点“同步视频”会直接执行。</p>
        </div>
        <span className={styles.status}>{configured ? '已启用' : '先确认'}</span>
      </header>

      <div className={styles.body}>
        <fieldset>
          <legend>同步内容</legend>
          <div className={styles.sources} role="group" aria-label="选择快捷同步内容">
            {SOURCE_OPTIONS.map(({ value, label, Icon }) => {
              const selected = modes.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  className={selected ? styles.selected : ''}
                  onClick={() => toggleMode(value)}
                >
                  <Icon size={17} weight={selected ? 'fill' : 'regular'} aria-hidden="true" />
                  <span>{label}</span>
                  {selected && <Check size={14} weight="bold" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className={styles.count}>
          <span><strong>每个来源</strong><small>1–{QUICK_SYNC_MAX_COUNT} 条</small></span>
          <span className={styles.countInput}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={QUICK_SYNC_MAX_COUNT}
              value={count}
              onChange={(event) => {
                setSaved(false);
                const value = Number(event.target.value);
                setCount(Number.isFinite(value)
                  ? Math.max(1, Math.min(QUICK_SYNC_MAX_COUNT, Math.trunc(value)))
                  : 1);
              }}
            />
            <small>条</small>
          </span>
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.save} onClick={save}>
            {saved ? <Check size={15} weight="bold" /> : null}
            {saved ? '已保存' : '保存并启用'}
          </button>
          <button type="button" className={styles.confirm} onClick={confirmNextTime}>
            下次先打开设置
          </button>
        </div>
      </div>
    </section>
  );
}
