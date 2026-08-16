'use client';

import {
  CaretRight,
  Check,
  Lightning,
  Trash,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { clearWorkspaceSnapshots } from '@/lib/workspaceSnapshot';
import styles from './LocalDataSettingsCard.module.css';

export default function LocalDataSettingsCard() {
  const { settings, updateLocalWorkspaceCache } = useSettings();
  const [notice, setNotice] = useState('');

  const updateEnabled = () => {
    const nextEnabled = !settings.localWorkspaceCache;
    if (!nextEnabled) clearWorkspaceSnapshots();
    updateLocalWorkspaceCache(nextEnabled);
    setNotice(
      nextEnabled
        ? '已开启，首页会优先显示这台设备上的最近内容'
        : '已关闭，并清除了这台设备上的首页缓存',
    );
  };

  const clearLocalData = () => {
    const cleared = clearWorkspaceSnapshots();
    setNotice(cleared > 0 ? '这台设备上的首页缓存已清除' : '当前没有需要清除的首页缓存');
  };

  return (
    <section className={styles.card} aria-labelledby="local-data-settings-title">
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          <Lightning size={21} weight="duotone" />
        </span>
        <div>
          <h2 id="local-data-settings-title">加快首页打开速度</h2>
          <p>在这台设备保留一份最近内容，打开首页时不用重新等待。</p>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.preference}>
          <div>
            <strong>首页缓存</strong>
            <span>{settings.localWorkspaceCache ? '已开启，首页会优先显示最近内容' : '已关闭，每次打开首页都会重新读取'}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.localWorkspaceCache}
            aria-label="在当前设备保留最近内容"
            className={`${styles.switch} ${settings.localWorkspaceCache ? styles.switchActive : ''}`}
            onClick={updateEnabled}
          >
            <span>{settings.localWorkspaceCache && <Check size={12} weight="bold" />}</span>
          </button>
        </div>

        <details className={styles.details}>
          <summary>
            具体会保存什么？
            <CaretRight size={15} weight="bold" aria-hidden="true" />
          </summary>
          <div>
            <p><Check size={14} weight="bold" aria-hidden="true" />最近视频标题、摘要入口和计划进度</p>
            <p><Check size={14} weight="bold" aria-hidden="true" />不保存视频文件、完整文案、登录信息或 AI 密钥</p>
            <p>清除缓存不会删除账号里的内容，之后会从云端重新读取。</p>
          </div>
        </details>

        <div className={styles.footer}>
          <button type="button" onClick={clearLocalData}>
            <Trash size={16} weight="light" aria-hidden="true" />
            清除首页缓存
          </button>
          {notice && <span role="status">{notice}</span>}
        </div>
      </div>
    </section>
  );
}
