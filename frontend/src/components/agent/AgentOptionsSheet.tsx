'use client';

import type { KeyboardEvent } from 'react';
import BottomSheet from '@/components/BottomSheet';
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
  { value: 'fast', label: '快速回答', description: '适合明确、直接的问题' },
  { value: 'deep', label: '深度分析', description: '阅读更多视频并交叉核对' },
];

const OUTPUT_OPTIONS: Array<{
  value: LibraryOutputStyle;
  label: string;
}> = [
  { value: 'answer', label: '直接回答' },
  { value: 'summary', label: '完整总结' },
  { value: 'comparison', label: '差异对比' },
  { value: 'action_plan', label: '行动方案' },
  { value: 'custom', label: '自定义' },
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
  onClose,
  researchMode,
  outputStyle,
  webScope,
  disabled = false,
  onResearchModeChange,
  onOutputStyleChange,
  onWebScopeChange,
}: {
  open: boolean;
  onClose: () => void;
  researchMode: LibraryResearchMode;
  outputStyle: LibraryOutputStyle;
  webScope: ResearchScope;
  disabled?: boolean;
  onResearchModeChange: (value: LibraryResearchMode) => void;
  onOutputStyleChange: (value: LibraryOutputStyle) => void;
  onWebScopeChange: (value: ResearchScope) => void;
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="回答设置"
      desktopDialog
      panelClassName="agent-options-panel"
    >
      <div className="agent-options-sheet">
        <fieldset>
          <legend>分析深度</legend>
          <div className="agent-options-sheet__grid" role="radiogroup">
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
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>回答形式</legend>
          <div className="agent-options-sheet__chips" role="radiogroup">
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
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>资料边界</legend>
          <div className="agent-options-sheet__grid" role="radiogroup">
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
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <button type="button" className="agent-options-sheet__done" onClick={onClose}>
          完成
        </button>
      </div>
    </BottomSheet>
  );
}
