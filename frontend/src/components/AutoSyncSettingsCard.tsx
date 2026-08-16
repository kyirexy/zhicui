'use client';

import {
  ArrowRight,
  ArrowsClockwise,
  Check,
  ClockCountdown,
  Play,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useSettings } from '@/lib/hooks/SettingsContext';
import {
  configureLibraryAutoSyncSchedule,
  readLibraryAutoSyncState,
  runLibraryAutoSync,
  subscribeLibraryAutoSyncState,
  type LibraryAutoSyncState,
} from '@/lib/libraryAutoSync';
import type { LibraryAutoSyncIntervalMinutes } from '@/lib/types';
import styles from './AutoSyncSettingsCard.module.css';

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const INTERVAL_OPTIONS: Array<{
  value: LibraryAutoSyncIntervalMinutes;
  label: string;
}> = [
  { value: 0, label: '关闭' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 180, label: '3 小时' },
  { value: 360, label: '6 小时' },
  { value: 1440, label: '每天' },
];

const PRESET_INTERVALS = new Set(INTERVAL_OPTIONS.map((option) => option.value));
type CustomUnit = 'minutes' | 'hours' | 'days';

const CUSTOM_UNITS: Array<{ value: CustomUnit; label: string; multiplier: number }> = [
  { value: 'minutes', label: '分钟', multiplier: 1 },
  { value: 'hours', label: '小时', multiplier: 60 },
  { value: 'days', label: '天', multiplier: 1440 },
];

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatInterval(minutes: number): string {
  if (minutes === 0) return '已关闭';
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

function fieldsFromMinutes(minutes: number): { amount: string; unit: CustomUnit } {
  if (minutes > 0 && minutes % 1440 === 0) {
    return { amount: String(minutes / 1440), unit: 'days' };
  }
  if (minutes > 0 && minutes % 60 === 0) {
    return { amount: String(minutes / 60), unit: 'hours' };
  }
  return { amount: String(minutes > 0 ? minutes : 45), unit: 'minutes' };
}

export default function AutoSyncSettingsCard() {
  const { user } = useAuth();
  const { settings, updateLibraryAutoSyncInterval } = useSettings();
  const intervalMinutes = settings.libraryAutoSyncIntervalMinutes;
  const initialCustomFields = fieldsFromMinutes(intervalMinutes);
  const [customAmount, setCustomAmount] = useState(initialCustomFields.amount);
  const [customUnit, setCustomUnit] = useState<CustomUnit>(initialCustomFields.unit);
  const [state, setState] = useState<LibraryAutoSyncState>(() => (
    readLibraryAutoSyncState(user?.id || '', intervalMinutes)
  ));
  const [running, setRunning] = useState(false);
  const [customScheduleOpen, setCustomScheduleOpen] = useState(
    !PRESET_INTERVALS.has(intervalMinutes),
  );

  useEffect(() => {
    if (!user?.id) return;
    const next = configureLibraryAutoSyncSchedule(user.id, intervalMinutes);
    setState(next);
    return subscribeLibraryAutoSyncState(user.id, setState);
  }, [intervalMinutes, user?.id]);

  useEffect(() => {
    if (PRESET_INTERVALS.has(intervalMinutes)) return;
    const fields = fieldsFromMinutes(intervalMinutes);
    setCustomAmount(fields.amount);
    setCustomUnit(fields.unit);
    setCustomScheduleOpen(true);
  }, [intervalMinutes]);

  const statusLabel = useMemo(() => {
    if (state.status === 'running') return '同步中';
    if (state.status === 'success') return '已完成';
    if (state.status === 'partial') return '部分完成';
    if (state.status === 'error') return '需要处理';
    return intervalMinutes > 0 ? '已安排' : '未启用';
  }, [intervalMinutes, state.status]);

  const selectedUnit = CUSTOM_UNITS.find((unit) => unit.value === customUnit) ?? CUSTOM_UNITS[0];
  const customMinutes = Math.round(Number(customAmount) * selectedUnit.multiplier);
  const customValueValid = Number.isFinite(customMinutes) && customMinutes >= MIN_INTERVAL_MINUTES;
  const boundedCustomMinutes = Math.max(
    MIN_INTERVAL_MINUTES,
    Math.min(MAX_INTERVAL_MINUTES, customMinutes || MIN_INTERVAL_MINUTES),
  );

  const selectInterval = (value: LibraryAutoSyncIntervalMinutes) => {
    updateLibraryAutoSyncInterval(value);
    if (user?.id) setState(configureLibraryAutoSyncSchedule(user.id, value));
  };

  const applyCustomInterval = () => {
    if (!customValueValid) return;
    selectInterval(boundedCustomMinutes);
    const normalized = fieldsFromMinutes(boundedCustomMinutes);
    setCustomAmount(normalized.amount);
    setCustomUnit(normalized.unit);
  };

  const runNow = async () => {
    if (!user?.id || running || state.status === 'running') return;
    setRunning(true);
    try {
      setState(await runLibraryAutoSync(user.id, intervalMinutes));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="auto-sync-settings-title">
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          <ClockCountdown size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="auto-sync-settings-title">自动同步</h2>
          <p>知萃运行时更新可自动读取的资料，并提前准备文案。</p>
        </div>
        <span className={`${styles.status} ${styles[`status_${state.status}`]}`}>
          {state.status === 'running' && <ArrowsClockwise size={14} className={styles.spin} />}
          {statusLabel}
        </span>
      </header>

      <div className={styles.body}>
        <div className={styles.scope} aria-label="同步范围">
          <div>
            <strong>自动更新</strong>
            <span>抖音收藏、喜欢和作品，每类最近 50 条</span>
          </div>
          <div>
            <strong>需要你确认</strong>
            <span>B站和小红书的收藏、喜欢，需要在官方页面确认账号</span>
            <Link href="/library">
              管理多渠道
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <fieldset>
          <legend>多久检查一次</legend>
          <div className={styles.options} role="radiogroup" aria-label="自动同步周期">
            {INTERVAL_OPTIONS.map((option) => {
              const selected = intervalMinutes === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? styles.selected : ''}
                  onClick={() => selectInterval(option.value)}
                >
                  <span>{option.label}</span>
                  {selected && <Check size={14} weight="bold" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </fieldset>

        <details
          className={`${styles.customSchedule} ${!PRESET_INTERVALS.has(intervalMinutes) ? styles.customScheduleActive : ''}`}
          open={customScheduleOpen}
          onToggle={(event) => setCustomScheduleOpen(event.currentTarget.open)}
        >
          <summary>
            <span><strong>自定义周期</strong><small>15 分钟到 7 天</small></span>
            <span>设置</span>
          </summary>
          <div className={styles.customScheduleControls}>
            <label className={styles.customAmount}>
              <span className="sr-only">同步间隔数值</span>
              <input
                type="number"
                min={1}
                step={1}
                value={customAmount}
                onChange={(event) => setCustomAmount(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyCustomInterval();
                }}
              />
            </label>
            <div className={styles.customUnits} aria-label="同步间隔单位">
              {CUSTOM_UNITS.map((unit) => (
                <button
                  key={unit.value}
                  type="button"
                  className={customUnit === unit.value ? styles.customUnitSelected : ''}
                  onClick={() => setCustomUnit(unit.value)}
                >
                  {unit.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.applyCustom}
              disabled={!customValueValid}
              onClick={applyCustomInterval}
            >
              应用
            </button>
          </div>
        </details>
        <p className={styles.currentSchedule}>当前：{formatInterval(intervalMinutes)}</p>

        <div className={styles.runtime}>
          <div>
            <span>上次执行</span>
            <strong>{formatTime(state.lastAttemptAt)}</strong>
          </div>
          <div>
            <span>下次执行</span>
            <strong>{intervalMinutes > 0 ? formatTime(state.nextRunAt) : '关闭后不再自动执行'}</strong>
          </div>
          <button
            type="button"
            disabled={!user?.id || running || state.status === 'running'}
            onClick={() => void runNow()}
          >
            {running || state.status === 'running'
              ? <ArrowsClockwise size={16} className={styles.spin} />
              : <Play size={16} weight="fill" />}
            {running || state.status === 'running' ? '正在同步' : '立即同步'}
          </button>
        </div>

        <p className={`${styles.message} ${state.status === 'error' ? styles.messageError : ''}`} role="status">
          {state.message}
        </p>
      </div>
    </section>
  );
}
