'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowSquareOut,
  Article,
  CaretDown,
  CaretUp,
  ChatCircleText,
  FileText,
  ListChecks,
  Sparkle,
} from '@phosphor-icons/react';
import { CARD_STYLE_CONFIG, DENSITY_CONFIG, type CardData, type CardStyle, type DensityLevel } from '@/lib/types';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import StyleToolbar from './StyleToolbar';
import ExportButton from './ExportButton';
import HeroCard from './card-styles/HeroCard';
import ContentChat from './ContentChat';
import ContentSourcePanel from './ContentSourcePanel';

function CardStyleLoading() {
  return (
    <div
      className="min-h-60 grid place-items-center rounded-[24px] border border-card-border bg-card-bg text-sm text-foreground-muted"
      role="status"
      aria-live="polite"
    >
      正在加载卡片样式…
    </div>
  );
}

const MinimalCard = dynamic(() => import('./card-styles/MinimalCard'), {
  loading: CardStyleLoading,
});
const StandardCard = dynamic(() => import('./card-styles/StandardCard'), {
  loading: CardStyleLoading,
});
const CreativeCard = dynamic(() => import('./card-styles/CreativeCard'), {
  loading: CardStyleLoading,
});
const MagazineCard = dynamic(() => import('./card-styles/MagazineCard'), {
  loading: CardStyleLoading,
});
const CompactListCard = dynamic(() => import('./card-styles/CompactListCard'), {
  loading: CardStyleLoading,
});
const AuroraCard = dynamic(() => import('./card-styles/AuroraCard'), {
  loading: CardStyleLoading,
});
const BlueprintCard = dynamic(() => import('./card-styles/BlueprintCard'), {
  loading: CardStyleLoading,
});
const PaperCard = dynamic(() => import('./card-styles/PaperCard'), {
  loading: CardStyleLoading,
});

const STYLE_COMPONENTS: Record<CardStyle, React.ComponentType<{
  cardData: CardData;
  density: DensityLevel;
  cardRef?: React.RefObject<HTMLDivElement | null>;
}>> = {
  hero: HeroCard,
  minimal: MinimalCard,
  standard: StandardCard,
  creative: CreativeCard,
  magazine: MagazineCard,
  compact: CompactListCard,
  aurora: AuroraCard,
  blueprint: BlueprintCard,
  paper: PaperCard,
};

interface CardRendererProps {
  cardData: CardData;
  showExport?: boolean;
  className?: string;
  noteId?: string;
  showToolbar?: boolean;
  showSourceOverview?: boolean;
}

type WorkspaceTab = 'card' | 'source' | 'assistant';

function normalizeCardData(cardData: CardData): CardData {
  return {
    ...cardData,
    title: typeof cardData.title === 'string' && cardData.title.trim()
      ? cardData.title
      : '未命名卡片',
    conclusion: typeof cardData.conclusion === 'string' ? cardData.conclusion : '',
    pitfall_rating: Number.isFinite(cardData.pitfall_rating)
      ? Math.max(1, Math.min(5, Math.round(cardData.pitfall_rating)))
      : 3,
    sections: Array.isArray(cardData.sections)
      ? cardData.sections.map((section, index) => {
          const legacySection = section as typeof section & { items?: unknown };
          const itemContent = Array.isArray(legacySection.items)
            ? legacySection.items
                .map((item) => {
                  if (typeof item === 'string') return item;
                  if (!item || typeof item !== 'object') return '';
                  const record = item as { text?: unknown; content?: unknown };
                  if (typeof record.text === 'string') return record.text;
                  if (typeof record.content === 'string') return record.content;
                  return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

          return {
            ...section,
            title: typeof section.title === 'string' && section.title.trim()
              ? section.title
              : `要点 ${index + 1}`,
            content: typeof section.content === 'string'
              ? section.content
              : itemContent,
          };
        })
      : [],
  };
}

export default function CardRenderer({
  cardData,
  showExport = true,
  className = '',
  noteId,
  showToolbar = false,
  showSourceOverview = true,
}: CardRendererProps) {
  const { settings } = useSettings();
  const cardRef = useRef<HTMLDivElement>(null);
  const readerViewportRef = useRef<HTMLElement>(null);
  const cardTabRef = useRef<HTMLButtonElement>(null);
  const sourceTabRef = useRef<HTMLButtonElement>(null);
  const assistantTabRef = useRef<HTMLButtonElement>(null);
  const readerViewportId = useId();
  const workspaceId = readerViewportId.replace(/[^a-zA-Z0-9_-]/g, '');
  const cardTabId = `card-tab-${workspaceId}`;
  const sourceTabId = `source-tab-${workspaceId}`;
  const assistantTabId = `assistant-tab-${workspaceId}`;
  const cardPanelId = `card-panel-${workspaceId}`;
  const sourcePanelId = `source-panel-${workspaceId}`;
  const assistantPanelId = `assistant-panel-${workspaceId}`;
  const isMobileWorkspace = useMediaQuery('(max-width: 1079px)');
  const safeCardData = useMemo(() => normalizeCardData(cardData), [cardData]);
  const cardPresentationData = useMemo(
    () => ({ ...safeCardData, transcript_raw: null }),
    [safeCardData],
  );
  const overrideScope = noteId ?? safeCardData.id ?? safeCardData.video_id ?? safeCardData.title;

  // Scope volatile overrides to the current card without a prop-to-state effect.
  const [styleSelection, setStyleSelection] = useState<{
    scope: string;
    value: CardStyle | null;
  }>({ scope: overrideScope, value: null });
  const [densitySelection, setDensitySelection] = useState<{
    scope: string;
    value: DensityLevel | null;
  }>({ scope: overrideScope, value: null });
  const styleOverride = styleSelection.scope === overrideScope ? styleSelection.value : null;
  const densityOverride = densitySelection.scope === overrideScope ? densitySelection.value : null;
  const [readerSelection, setReaderSelection] = useState<{
    scope: string;
    expanded: boolean;
  }>({ scope: overrideScope, expanded: false });
  const [overflowSelection, setOverflowSelection] = useState<{
    scope: string;
    overflowing: boolean;
  }>({ scope: overrideScope, overflowing: false });
  const [workspaceTabSelection, setWorkspaceTabSelection] = useState<{
    scope: string;
    value: WorkspaceTab;
  }>({ scope: overrideScope, value: 'card' });
  const isReaderExpanded = readerSelection.scope === overrideScope
    ? readerSelection.expanded
    : false;
  const isReaderOverflowing = overflowSelection.scope === overrideScope
    ? overflowSelection.overflowing
    : false;
  const selectedWorkspaceTab: WorkspaceTab = showSourceOverview
    && workspaceTabSelection.scope === overrideScope
    ? workspaceTabSelection.value
    : 'card';
  const hasMobileAssistantTab = Boolean(showSourceOverview && noteId);
  const activeWorkspaceTab: WorkspaceTab = selectedWorkspaceTab === 'assistant'
    && !isMobileWorkspace
    ? 'card'
    : selectedWorkspaceTab;
  const setStyleOverride = useCallback((value: CardStyle | null) => {
    setStyleSelection({ scope: overrideScope, value });
  }, [overrideScope]);
  const setDensityOverride = useCallback((value: DensityLevel | null) => {
    setDensitySelection({ scope: overrideScope, value });
  }, [overrideScope]);
  const selectWorkspaceTab = useCallback((value: WorkspaceTab, moveFocus = false) => {
    setWorkspaceTabSelection({ scope: overrideScope, value });
    if (moveFocus) {
      window.requestAnimationFrame(() => {
        const targetRef = value === 'card'
          ? cardTabRef
          : value === 'source'
            ? sourceTabRef
            : assistantTabRef;
        targetRef.current?.focus();
      });
    }
  }, [overrideScope]);

  const handleWorkspaceTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const availableTabs: WorkspaceTab[] = hasMobileAssistantTab && isMobileWorkspace
      ? ['card', 'source', 'assistant']
      : ['card', 'source'];
    const currentTab: WorkspaceTab = event.currentTarget.id === cardTabId
      ? 'card'
      : event.currentTarget.id === sourceTabId
        ? 'source'
        : 'assistant';
    const currentIndex = Math.max(0, availableTabs.indexOf(currentTab));
    let nextTab: WorkspaceTab | null = null;
    if (event.key === 'ArrowLeft') {
      nextTab = availableTabs[(currentIndex - 1 + availableTabs.length) % availableTabs.length];
    }
    if (event.key === 'ArrowRight') {
      nextTab = availableTabs[(currentIndex + 1) % availableTabs.length];
    }
    if (event.key === 'Home') nextTab = availableTabs[0];
    if (event.key === 'End') nextTab = availableTabs[availableTabs.length - 1];
    if (!nextTab) return;

    event.preventDefault();
    selectWorkspaceTab(nextTab, true);
  };

  const effectiveStyle = styleOverride ?? settings.cardStyle;
  const effectiveDensity = densityOverride ?? settings.density;

  const StyleComponent = STYLE_COMPONENTS[effectiveStyle];
  const styleMeta = CARD_STYLE_CONFIG[effectiveStyle];
  const densityMeta = DENSITY_CONFIG[effectiveDensity];

  const isPlan = safeCardData.card_type === 'plan';

  useEffect(() => {
    const viewport = readerViewportRef.current;
    if (!viewport || typeof window === 'undefined' || activeWorkspaceTab !== 'card') return;

    const desktopQuery = window.matchMedia('(min-width: 1080px)');
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!desktopQuery.matches || isReaderExpanded) return;
        const readerLimit = Math.max(480, Math.min(720, window.innerHeight - 220));
        const overflowing = viewport.scrollHeight > readerLimit + 8;
        setOverflowSelection((current) => (
          current.scope === overrideScope && current.overflowing === overflowing
            ? current
            : { scope: overrideScope, overflowing }
        ));
      });
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(viewport);
    for (const child of Array.from(viewport.children)) {
      resizeObserver.observe(child);
    }
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(viewport, { childList: true, subtree: true });
    desktopQuery.addEventListener('change', measure);
    measure();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      desktopQuery.removeEventListener('change', measure);
    };
  }, [activeWorkspaceTab, effectiveDensity, effectiveStyle, isReaderExpanded, overrideScope]);

  const toggleReader = () => {
    const nextExpanded = !isReaderExpanded;
    setReaderSelection({ scope: overrideScope, expanded: nextExpanded });
    if (!nextExpanded) {
      window.requestAnimationFrame(() => {
        const viewport = readerViewportRef.current;
        if (viewport && viewport.getBoundingClientRect().top < 0) {
          viewport.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : 'smooth',
          });
        }
      });
    }
  };

  return (
    <div className={`card-workspace ${noteId ? 'has-assistant' : ''} ${className}`}>
      {/* PU9: Plan banner — shown above the card when content is plan-type */}
      {isPlan && (
        <div className="mb-4 flex items-center gap-3 p-3 md:p-4 rounded-2xl bg-accent-indigo/10 border border-accent-indigo/20">
          <span className="text-xl" aria-hidden>
            <ListChecks size={22} weight="duotone" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">已为你建立执行计划</p>
            <p className="text-xs text-foreground-muted mt-0.5">下方为知识卡片，任务清单请查看计划页面</p>
          </div>
          {safeCardData.plan_id && (
            <Link href={`/plans?id=${safeCardData.plan_id}`} className="flex-shrink-0 text-xs font-medium text-accent-indigo hover:underline px-2 py-1">
              查看计划 →
            </Link>
          )}
        </div>
      )}
      <div className="card-workspace__layout">
        <div className="card-workspace__reader">
          {showSourceOverview && (
            <div
              className="card-workspace__tabs"
              role="tablist"
              aria-label="结果内容视图"
              data-has-mobile-assistant={hasMobileAssistantTab}
            >
              <button
                ref={cardTabRef}
                id={cardTabId}
                type="button"
                role="tab"
                className="card-workspace__tab"
                aria-selected={activeWorkspaceTab === 'card'}
                aria-controls={cardPanelId}
                tabIndex={activeWorkspaceTab === 'card' ? 0 : -1}
                onClick={() => selectWorkspaceTab('card')}
                onKeyDown={handleWorkspaceTabKeyDown}
              >
                <span className="card-workspace__tab-icon" aria-hidden>
                  <Article size={19} weight="duotone" />
                </span>
                <span className="card-workspace__tab-copy">
                  <strong>知识卡片</strong>
                  <small>先看 AI 提炼结果</small>
                </span>
              </button>
              <button
                ref={sourceTabRef}
                id={sourceTabId}
                type="button"
                role="tab"
                className="card-workspace__tab"
                aria-selected={activeWorkspaceTab === 'source'}
                aria-controls={sourcePanelId}
                tabIndex={activeWorkspaceTab === 'source' ? 0 : -1}
                onClick={() => selectWorkspaceTab('source')}
                onKeyDown={handleWorkspaceTabKeyDown}
              >
                <span className="card-workspace__tab-icon" aria-hidden>
                  <FileText size={19} weight="duotone" />
                </span>
                <span className="card-workspace__tab-copy">
                  <strong>完整内容</strong>
                  <small className="tabular-nums">
                    {(safeCardData.transcript_raw?.length ?? 0).toLocaleString('zh-CN')} 字原文
                  </small>
                </span>
              </button>
              {noteId && (
                <button
                  ref={assistantTabRef}
                  id={assistantTabId}
                  type="button"
                  role="tab"
                  className="card-workspace__tab card-workspace__tab--assistant"
                  aria-selected={activeWorkspaceTab === 'assistant'}
                  aria-controls={assistantPanelId}
                  tabIndex={activeWorkspaceTab === 'assistant' ? 0 : -1}
                  onClick={() => selectWorkspaceTab('assistant')}
                  onKeyDown={handleWorkspaceTabKeyDown}
                >
                  <span className="card-workspace__tab-icon" aria-hidden>
                    <ChatCircleText size={19} weight="duotone" />
                  </span>
                  <span className="card-workspace__tab-copy">
                    <strong>AI 提问</strong>
                    <small>基于全文追问</small>
                  </span>
                </button>
              )}
            </div>
          )}

          <div
            id={cardPanelId}
            role={showSourceOverview ? 'tabpanel' : undefined}
            aria-labelledby={showSourceOverview ? cardTabId : undefined}
            hidden={showSourceOverview && activeWorkspaceTab !== 'card'}
            className="card-workspace__panel"
          >
            <section
              className="card-workspace__controls"
              aria-label="知识卡片操作与外观"
            >
              <header className="card-workspace__topbar">
                <div className="card-workspace__identity">
                  <span><Article size={19} weight="duotone" aria-hidden /></span>
                  <div>
                    <small><Sparkle size={11} weight="fill" aria-hidden /> AI 知识卡片</small>
                    <strong>{styleMeta.label}主题 · {densityMeta.label}信息量</strong>
                  </div>
                </div>
                <div className="card-workspace__actions">
                  {showExport && (
                    <ExportButton
                      targetRef={cardRef}
                      filename={`${safeCardData.title || 'videocapsule'}-card`}
                    />
                  )}
                  {noteId && (
                    <Link
                      href={`/process?id=${noteId}`}
                      className="card-workspace__source"
                      title="查看原视频、原文案与 AI 处理过程"
                    >
                      <ArrowSquareOut size={15} weight="bold" aria-hidden />
                      处理过程
                    </Link>
                  )}
                </div>
              </header>

              {showToolbar && (
                <StyleToolbar
                  styleOverride={styleOverride}
                  densityOverride={densityOverride}
                  onStyleOverride={setStyleOverride}
                  onDensityOverride={setDensityOverride}
                  cardType={safeCardData.card_type}
                />
              )}
            </section>

            <section
              ref={readerViewportRef}
              id={readerViewportId}
              className={`card-workspace__canvas ${
                isReaderExpanded ? 'is-expanded' : ''
              } ${isReaderOverflowing ? 'is-overflowing' : ''}`}
              aria-label="知识卡片内容"
            >
              <StyleComponent
                cardData={cardPresentationData}
                density={effectiveDensity}
                cardRef={showExport ? cardRef : undefined}
              />
            </section>
            {isReaderOverflowing && (
              <button
                type="button"
                className="card-workspace__reader-toggle"
                onClick={toggleReader}
                aria-expanded={isReaderExpanded}
                aria-controls={readerViewportId}
              >
                {isReaderExpanded
                  ? <CaretUp size={16} weight="bold" aria-hidden />
                  : <CaretDown size={16} weight="bold" aria-hidden />}
                <span>
                  <strong>{isReaderExpanded ? '收起完整卡片' : '展开完整卡片'}</strong>
                  <small>{isReaderExpanded ? '回到一屏重点阅读' : '当前为电脑端重点视图，不影响完整导出'}</small>
                </span>
              </button>
            )}
          </div>

          {showSourceOverview && (
            <div
              id={sourcePanelId}
              role="tabpanel"
              aria-labelledby={sourceTabId}
              hidden={activeWorkspaceTab !== 'source'}
              className="card-workspace__panel"
            >
              <ContentSourcePanel
                cardData={safeCardData}
                onShowCard={() => selectWorkspaceTab('card', true)}
              />
            </div>
          )}
        </div>

        {/* The chat stays outside cardRef so PNG exports contain only the card. */}
        {noteId && (
          <aside
            id={assistantPanelId}
            className="card-workspace__assistant"
            role={isMobileWorkspace && showSourceOverview ? 'tabpanel' : undefined}
            aria-labelledby={isMobileWorkspace && showSourceOverview ? assistantTabId : undefined}
            aria-hidden={
              isMobileWorkspace && showSourceOverview
                ? activeWorkspaceTab !== 'assistant'
                : undefined
            }
            data-mobile-visible={
              !showSourceOverview || activeWorkspaceTab === 'assistant'
            }
          >
            <ContentChat noteId={noteId} cardType={safeCardData.card_type} title={safeCardData.title} />
          </aside>
        )}
      </div>
    </div>
  );
}
