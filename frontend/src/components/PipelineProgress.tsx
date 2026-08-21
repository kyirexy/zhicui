'use client';

import { Check, Loader2, AlertCircle, Circle } from 'lucide-react';

import type { StepState } from '@/lib/hooks/ExtractionContext';

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}

interface PipelineProgressProps {
  steps: StepState[];
}

export default function PipelineProgress({ steps }: PipelineProgressProps) {
  // Filter out internal steps like error that aren't part of normal flow timeline
  // 'done' will already be marked on individual steps.
  const displaySteps = steps.filter((step) => step.key !== 'error');

  return (
    <div className="w-full max-w-md mx-auto animate-fade-in">
      {/* Pulsing orb header */}
      <div className="flex items-center justify-center gap-2.5 mb-6">
        <div className="relative">
          <div className="w-2.5 h-2.5 rounded-full bg-accent-brand animate-pulse" />
          <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-accent-brand animate-ping opacity-40" />
        </div>
        <span className="text-sm font-medium text-foreground-secondary">
          AI 正在处理中...
        </span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {displaySteps.map((step, i) => {
          const status = step.status;
          const message = step.message;
          const isLast = i === displaySteps.length - 1;
          const showLogs = (status === 'active' || step.key === 'transcribe') && step.logs?.length > 1;

          return (
            <div key={step.key} className="relative flex gap-4 pb-5 last:pb-0">
              {/* Vertical connector line */}
              {!isLast && (
                <div className="absolute left-[15px] top-9 bottom-0 w-px">
                  <div
                    className={`h-full w-px transition-colors duration-500 ${
                      status === 'done'
                        ? 'bg-accent-brand/40'
                        : status === 'active'
                          ? 'bg-accent-brand/20'
                          : 'bg-card-border'
                    }`}
                  />
                </div>
              )}

              {/* Status icon */}
              <div className="relative flex-shrink-0 z-10">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500 ${
                    status === 'done'
                      ? 'bg-accent-brand/15 border border-accent-brand/30 text-accent-brand'
                      : status === 'active'
                        ? 'bg-accent-brand/10 border border-accent-brand/25 text-accent-brand'
                        : status === 'error'
                          ? 'bg-accent-rose/10 border border-accent-rose/25 text-accent-rose'
                          : 'bg-card-bg border border-card-border text-foreground-muted'
                  }`}
                >
                  {status === 'done' ? (
                    <Check size={14} />
                  ) : status === 'active' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : status === 'error' ? (
                    <AlertCircle size={14} />
                  ) : (
                    <Circle size={12} />
                  )}
                </div>
              </div>

              {/* Label + message */}
              <div className="flex-1 min-w-0 pt-0.5">
                <p
                  className={`text-sm font-medium transition-colors duration-300 ${
                    status === 'done'
                      ? 'text-foreground'
                      : status === 'active'
                        ? 'text-foreground'
                        : status === 'error'
                          ? 'text-accent-rose'
                          : 'text-foreground-muted'
                  }`}
                >
                  {step.label}
                </p>
                {message && !showLogs && (
                  <p
                    className={`text-xs mt-0.5 leading-relaxed transition-colors duration-300 ${
                      status === 'error'
                        ? 'text-accent-rose/70'
                        : 'text-foreground-muted'
                    }`}
                  >
                    {message}
                  </p>
                )}
                {showLogs && (
                  <ul className="mt-1.5 space-y-1.5">
                    {step.logs.slice(-5).map((log, logIdx) => (
                      <li key={logIdx} className={`text-[11px] leading-relaxed transition-colors duration-300 ${
                        log.level === 'warning' ? 'text-amber-500/80' :
                        log.status === 'error' ? 'text-accent-rose/80' :
                        'text-foreground-muted/80'
                      }`}>
                        {log.elapsedMs !== undefined && <span className="opacity-70 mr-1.5 inline-block w-8 font-mono">{formatElapsed(log.elapsedMs)}</span>}
                        {log.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
