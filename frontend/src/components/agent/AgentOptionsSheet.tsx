'use client';

import type { KeyboardEvent } from 'react';
import { Check } from '@phosphor-icons/react';
import type {
  LibraryOutputStyle,
  LibraryResearchMode,
  ResearchScope,
} from '@/lib/types';

const RESEARCH_OPTIONS: Array<{
  value: LibraryResearchMode;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: '自动判断', description: '按问题与视频数量选择深度' },
  { value: 'fast', label: '快速回答', description: '适合明确、直接的问题' },
  { value: 'deep', label: '深度分析', description: '阅读更多视频并交叉核对' },
];

const OUTPUT_OPTIONS: Array<{
  value: LibraryOutputStyle;
  label: string;
  description: string;
}> = [
  { value: 'answer', label: '直接回答', description: '先给结论与依据' },
  { value: 'summary', label: '完整总结', description: '保留内容结构' },
  { value: 'comparison', label: '差异对比', description: '并列观点与差异' },
  { value: 'action_plan', label: '行动方案', description: '整理可执行步骤' },
  { value: 'custom', label: '自定义', description: '按你的要求输出' },
];

const WEB_OPTIONS: Array<{
  value: ResearchScope;
  label: string;
  description: string;
}> = [
  { value: 'video_only', label: '只看我的视频', description: '回答严格依据所选资料' },
  { value: 'auto', label: '需要时联网', description: '资料不足时补充公开信息' },
];

function handleRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    return;
  }
  const radios = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:not(:disabled)',
    ) ?? [],
  );
  const currentIndex = radios.indexOf(event.currentTarget);
  if (currentIndex < 0 || radios.length < 2) return;

  event.preventDefault();
  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = radios[(currentIndex + direction + radios.length) % radios.length];
  next.focus();
  next.click();
}

export default function AgentOptionsSheet({
  open,
  variant = 'popover',
  researchMode,
  outputStyle,
  webScope,
  disabled = false,
  onResearchModeChange,
  onOutputStyleChange,
  onWebScopeChange,
}: {
  open: boolean;
  variant?: 'popover' | 'sheet';
  researchMode: LibraryResearchMode;
  outputStyle: LibraryOutputStyle;
  webScope: ResearchScope;
  disabled?: boolean;
  onResearchModeChange: (value: LibraryResearchMode) => void;
  onOutputStyleChange: (value: LibraryOutputStyle) => void;
  onWebScopeChange: (value: ResearchScope) => void;
}) {
  if (!open) return null;

  return (
    <section
      className={`agent-options-menu ${variant === 'sheet' ? 'is-sheet' : ''}`}
      role={variant === 'popover' ? 'dialog' : undefined}
      aria-label="回答设置"
    >
      {variant === 'popover' && <header>
        <small>本次回答</small>
        <strong>回答设置</strong>
      </header>}
      <div className="agent-options-menu__body">
        <fieldset>
          <legend>分析深度</legend>
          <div className="agent-options-menu__list" role="radiogroup">
            {RESEARCH_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={researchMode === option.value}
                tabIndex={researchMode === option.value ? 0 : -1}
                className={researchMode === option.value ? 'is-selected' : ''}
                disabled={disabled}
                onKeyDown={handleRadioKeyDown}
                onClick={() => onResearchModeChange(option.value)}
              >
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
                {researchMode === option.value && <Check size={15} weight="bold" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>回答形式</legend>
          <div className="agent-options-menu__list" role="radiogroup">
            {OUTPUT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={outputStyle === option.value}
                tabIndex={outputStyle === option.value ? 0 : -1}
                className={outputStyle === option.value ? 'is-selected' : ''}
                disabled={disabled}
                onKeyDown={handleRadioKeyDown}
                onClick={() => onOutputStyleChange(option.value)}
              >
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
                {outputStyle === option.value && <Check size={15} weight="bold" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>资料边界</legend>
          <div className="agent-options-menu__list" role="radiogroup">
            {WEB_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={webScope === option.value}
                tabIndex={webScope === option.value ? 0 : -1}
                className={webScope === option.value ? 'is-selected' : ''}
                disabled={disabled}
                onKeyDown={handleRadioKeyDown}
                onClick={() => onWebScopeChange(option.value)}
              >
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
                {webScope === option.value && <Check size={15} weight="bold" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </fieldset>

      </div>
    </section>
  );
}
