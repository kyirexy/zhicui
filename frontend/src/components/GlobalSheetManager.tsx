'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CloudArrowDown, DeviceMobile, Sparkle } from '@phosphor-icons/react';
import { CheckCircle2, X } from 'lucide-react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import StylePicker from './StylePicker';
import BottomSheet from './BottomSheet';
import VideoAnalysisTaskList from './VideoAnalysisTaskList';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import { useCreatorSync } from '@/lib/hooks/CreatorSyncContext';
import { cancelCreatorSyncRun } from '@/lib/api';
import type { CreatorSyncRun, VideoAnalysisRun } from '@/lib/types';
import { formatPoints, runItemCount } from '@/lib/videoAnalysis';
import analysisStyles from './VideoAnalysis.module.css';

/** Keeps the mobile bottom tabs useful even when no card is currently mounted. */
export default function GlobalSheetManager() {
  const { settings, updateStyle, updateDensity } = useSettings();
  const { refreshActive, refreshRecent } = useVideoAnalysis();
  const {
    activeRuns: activeCreatorRuns,
    recentRuns: recentCreatorRuns,
    refreshActive: refreshCreatorActive,
    refreshRecent: refreshCreatorRecent,
  } = useCreatorSync();
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [analysisSheetOpen, setAnalysisSheetOpen] = useState(false);
  const [creatorSheetOpen, setCreatorSheetOpen] = useState(false);
  const [completedRun, setCompletedRun] = useState<VideoAnalysisRun | null>(null);
  const [completedCreatorRun, setCompletedCreatorRun] = useState<CreatorSyncRun | null>(null);

  useEffect(() => {
    const onStyle = () => setStyleSheetOpen(true);
    const onSettings = () => setSettingsSheetOpen(true);
    const onAnalysis = () => {
      setAnalysisSheetOpen(true);
      void refreshActive();
      void refreshRecent();
    };
    const onCreatorSync = () => {
      setCreatorSheetOpen(true);
      void refreshCreatorActive();
      void refreshCreatorRecent();
    };
    window.addEventListener('vc:open-style-sheet', onStyle);
    window.addEventListener('vc:open-settings-sheet', onSettings);
    window.addEventListener('vc:open-video-analysis-sheet', onAnalysis);
    window.addEventListener('vc:open-creator-sync-sheet', onCreatorSync);
    return () => {
      window.removeEventListener('vc:open-style-sheet', onStyle);
      window.removeEventListener('vc:open-settings-sheet', onSettings);
      window.removeEventListener('vc:open-video-analysis-sheet', onAnalysis);
      window.removeEventListener('vc:open-creator-sync-sheet', onCreatorSync);
    };
  }, [refreshActive, refreshCreatorActive, refreshCreatorRecent, refreshRecent]);

  useEffect(() => {
    let timeout: number | undefined;
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ runs?: VideoAnalysisRun[] }>).detail;
      const latest = detail?.runs?.[0];
      if (!latest) return;
      setCompletedRun(latest);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setCompletedRun(null), 10_000);
    };
    window.addEventListener('vc:video-analysis-updated', onUpdated);
    return () => {
      window.removeEventListener('vc:video-analysis-updated', onUpdated);
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    let timeout: number | undefined;
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ runs?: CreatorSyncRun[] }>).detail;
      const latest = detail?.runs?.[0];
      if (!latest) return;
      setCompletedCreatorRun(latest);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setCompletedCreatorRun(null), 10_000);
    };
    window.addEventListener('vc:creator-sync-updated', onUpdated);
    return () => {
      window.removeEventListener('vc:creator-sync-updated', onUpdated);
      window.clearTimeout(timeout);
    };
  }, []);

  return (
    <>
      <BottomSheet open={styleSheetOpen} onClose={() => setStyleSheetOpen(false)} title="全局卡片外观">
        <StylePicker
          currentStyle={settings.cardStyle}
          currentDensity={settings.density}
          onStyleChange={updateStyle}
          onDensityChange={updateDensity}
        />
        <p className="style-toolbar-note">选择会自动保存，后续生成和打开的卡片都会使用这套外观。</p>
      </BottomSheet>

      <BottomSheet open={settingsSheetOpen} onClose={() => setSettingsSheetOpen(false)} title="设置">
        <div className="global-settings-sheet">
          <div className="global-settings-card">
            <span className="global-settings-card__icon"><Sparkle size={21} weight="duotone" /></span>
            <div>
              <strong>知萃 VideoCapsule</strong>
              <p>把长内容，萃取成可以继续探索的知识卡片。</p>
            </div>
          </div>
          <div className="global-settings-card">
            <span className="global-settings-card__icon"><DeviceMobile size={21} weight="duotone" /></span>
            <div>
              <strong>移动端连接</strong>
              <p>手机与电脑处于同一网络时可连接本地服务；生产版会自动使用 luxai.cn。</p>
            </div>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet
        open={analysisSheetOpen}
        onClose={() => setAnalysisSheetOpen(false)}
        title="详细解析任务"
        desktopDialog
      >
        <VideoAnalysisTaskList />
      </BottomSheet>

      <BottomSheet
        open={creatorSheetOpen}
        onClose={() => setCreatorSheetOpen(false)}
        title="博主同步任务"
        desktopDialog
      >
        <div className="grid gap-3">
          {[...activeCreatorRuns, ...recentCreatorRuns.slice(0, 8)].length === 0 ? (
            <div className="grid min-h-28 place-items-center rounded-xl border border-dashed border-card-border px-4 text-sm text-foreground-muted">
              暂无博主同步任务
            </div>
          ) : [...activeCreatorRuns, ...recentCreatorRuns.slice(0, 8)].map((run) => (
            <article key={run.id} className="rounded-xl border border-card-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="block text-sm text-foreground">
                    {run.platform === 'douyin' ? '抖音' : run.platform === 'bilibili' ? 'B站' : '小红书'}博主同步
                  </strong>
                  <p className="mt-1 text-pretty text-xs text-foreground-muted">
                    检查 {run.checked_count}/{run.requested_limit} · 新增 {run.new_count} · 已存在 {run.reused_count} · 失败 {run.failed_count}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-foreground-muted">
                  {activeCreatorRuns.some((item) => item.id === run.id) ? '运行中' : run.status === 'succeeded' ? '已完成' : run.status === 'partial' ? '部分完成' : run.status === 'cancelled' ? '已取消' : '失败'}
                </span>
              </div>
              {activeCreatorRuns.some((item) => item.id === run.id) && (
                <button
                  type="button"
                  onClick={async () => {
                    await cancelCreatorSyncRun(run.id);
                    await refreshCreatorActive();
                  }}
                  className="mt-3 min-h-11 rounded-lg border border-card-border px-3 text-xs font-semibold text-foreground-secondary"
                >
                  取消同步
                </button>
              )}
            </article>
          ))}
        </div>
      </BottomSheet>

      {completedRun && (
        <aside className={analysisStyles.completionToast} role="status" aria-live="polite">
          <CheckCircle2 size={19} aria-hidden="true" />
          <div>
            <strong>{completedRun.status === 'partial' ? '详细解析部分完成' : '详细解析已完成'} · {runItemCount(completedRun)} 条</strong>
            <p>
              实际使用 {formatPoints(completedRun.actual_points || 0)}
              {Number(completedRun.released_points || 0) > 0 ? ` · 已释放 ${formatPoints(completedRun.released_points)}` : ''}
            </p>
            <span>
              {completedRun.trigger === 'agent' && completedRun.agent_thread_id ? (
                <Link href={`/agent?thread=${encodeURIComponent(completedRun.agent_thread_id)}`}>继续回答</Link>
              ) : (completedRun.note_ids?.[0] || completedRun.items?.[0]?.note_id) && (
                <Link href={`/notes?id=${encodeURIComponent(completedRun.note_ids?.[0] || completedRun.items?.[0]?.note_id || '')}`}>查看摘要</Link>
              )}
              <button type="button" onClick={() => {
                setCompletedRun(null);
                setAnalysisSheetOpen(true);
              }}>查看任务</button>
            </span>
          </div>
          <button type="button" onClick={() => setCompletedRun(null)} aria-label="关闭解析完成通知"><X size={15} /></button>
        </aside>
      )}

      {completedCreatorRun && (
        <aside className={analysisStyles.completionToast} role="status" aria-live="polite">
          <CloudArrowDown size={19} aria-hidden="true" />
          <div>
            <strong>{completedCreatorRun.status === 'partial' ? '博主同步部分完成' : completedCreatorRun.status === 'failed' ? '博主同步未完成' : '博主同步已完成'}</strong>
            <p>新增 {completedCreatorRun.new_count} · 已存在 {completedCreatorRun.reused_count} · 失败 {completedCreatorRun.failed_count}</p>
            <span>
              <Link href="/agent">查看视频</Link>
              <button type="button" onClick={() => {
                setCompletedCreatorRun(null);
                setCreatorSheetOpen(true);
              }}>查看任务</button>
            </span>
          </div>
          <button type="button" onClick={() => setCompletedCreatorRun(null)} aria-label="关闭博主同步通知"><X size={15} /></button>
        </aside>
      )}
    </>
  );
}
