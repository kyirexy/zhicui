'use client';

import {
  ArrowRight,
  HandTap,
  ShieldCheck,
} from '@phosphor-icons/react';
import Link from 'next/link';
import styles from './AutoSyncSettingsCard.module.css';

export default function AutoSyncSettingsCard() {
  return (
    <section className={styles.card} aria-labelledby="manual-sync-settings-title">
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true">
          <ShieldCheck size={22} weight="duotone" />
        </span>
        <div>
          <h2 id="manual-sync-settings-title">仅手动同步</h2>
          <p>知萃不会在启动、打开页面、恢复联网或后台定时读取平台资料。</p>
        </div>
        <span className={`${styles.status} ${styles.status_success}`}>已保护</span>
      </header>

      <div className={styles.body}>
        <div className={styles.scope} aria-label="手动同步说明">
          <div>
            <strong>何时读取</strong>
            <span>只有你选择来源和数量，并点击同步按钮后才会读取。</span>
          </div>
          <div>
            <strong>账号连接</strong>
            <span>绑定抖音或 B站 账号只更新连接状态，不会自动抓取收藏、喜欢或作品。</span>
          </div>
          <div>
            <strong>任务进度</strong>
            <span>手动任务启动后会继续显示进度；状态轮询不会创建新的同步。</span>
            <Link href="/library">
              <HandTap size={15} aria-hidden="true" />
              前往手动同步
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <p className={styles.message} role="status">
          自动同步周期已永久关闭，历史保存的周期也不会再生效，可减少连续请求带来的账号风控。
        </p>
      </div>
    </section>
  );
}
