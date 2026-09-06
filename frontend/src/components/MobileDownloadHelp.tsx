"use client";

import { useState } from 'react';
import { ArrowDown, ArrowRight, DeviceMobile, DownloadSimple, Play, ShareNetwork } from '@phosphor-icons/react';
import styles from './MobileDownloadHelp.module.css';

export default function MobileDownloadHelp({ platform, androidHref }: { platform: 'android' | 'ios' | null; androidHref: string }) {
  const [choice, setChoice] = useState<'android' | 'ios' | null>(null);
  const selected = choice ?? platform ?? 'android';
  const ios = selected === 'ios';
  return (
    <div className={styles.mobileOnly}>
      <details id="mobile-install-guide" className={styles.guide}>
        <summary><DeviceMobile size={20} aria-hidden="true" /><span>手机怎么安装？</span><ArrowDown size={16} aria-hidden="true" /></summary>
        <div className={styles.content}>
          <div className={styles.choices} role="group" aria-label="选择手机系统">
            <button type="button" aria-pressed={!ios} onClick={() => setChoice('android')}>Android</button>
            <button type="button" aria-pressed={ios} onClick={() => setChoice('ios')}>iPhone</button>
          </div>
          {ios ? <>
            <h3>把知萃官网放到主屏幕</h3>
            <ol><li>用 Safari 打开知萃官网。</li><li>点底部的分享按钮 <ShareNetwork size={16} aria-label="分享" />。</li><li>选择「添加到主屏幕」，再点「添加」。</li></ol>
            <p>这是官网快捷方式，可查看演示和下载信息。iPhone App 尚未发布，完整功能仍需客户端。</p>
          </> : <>
            <h3>下载后，跟着手机提示安装</h3>
            <ol><li>点「下载 Android」，保存安装包。</li><li>在浏览器下载列表里打开文件。</li><li>核对应用为「知萃」，按系统提示完成安装。</li></ol>
            <p>微信里下载没反应？点右上角「…」，选择「在浏览器打开」后再下载。</p>
            <a className={styles.retry} href={androidHref}>下载 Android <DownloadSimple size={17} aria-hidden="true" /></a>
          </>}
        </div>
      </details>
      <aside className={styles.dock} aria-label="手机快捷入口">
        <div className={styles.identity}><span className={styles.appIcon}><DeviceMobile size={24} aria-hidden="true" /></span><span><strong>知萃</strong><small>{ios ? '先看看，收藏怎么用' : '把收藏，随身带着'}</small></span></div>
        <a className={styles.action} href={ios ? '#demo' : androidHref}>{ios ? <Play size={17} weight="fill" aria-hidden="true" /> : <DownloadSimple size={18} aria-hidden="true" />}{ios ? '体验网页演示' : '下载 Android'}<ArrowRight size={16} aria-hidden="true" /></a>
      </aside>
    </div>
  );
}
