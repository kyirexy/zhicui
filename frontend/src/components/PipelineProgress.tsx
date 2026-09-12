'use client';

import { Check, Loader2, AlertCircle, Circle } from 'lucide-react';

import type { StepState } from '@/lib/hooks/ExtractionContext';

interface PipelineProgressProps {
  steps: StepState[];
}

export default function PipelineProgress({ steps }: PipelineProgressProps) {
  // Filter out internal steps like error that aren't part of normal flow timeline
  // 'done' will already be marked on individual steps.
  const displaySteps = steps.filter((step) => step.key !== 'error');

  return (
    <div className="w-full max-w-md mx-auto animate-fade-in">
      {/* Timeline */}
      <div className="relative">
        {displaySteps.map((step, i) => {
          const status = step.status;
          const message = status === 'error'
            ? '处理暂未完成，请重试。'
            : status === 'active' ? '请稍候…' : '';
          const isLast = i === displaySteps.length - 1;

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
                {message && (
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

              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
