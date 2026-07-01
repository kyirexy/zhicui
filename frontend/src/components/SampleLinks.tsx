'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Play, ExternalLink } from 'lucide-react';
import { HOME_CATEGORIES } from '@/lib/homeCategories';

interface SampleLinksProps {
  onFill: (url: string) => void;
  isLoading: boolean;
}

export default function SampleLinks({ onFill, isLoading }: SampleLinksProps) {
  const sampleGroups = useMemo(
    () => HOME_CATEGORIES.filter((category) => category.samples.length > 0),
    []
  );
  const [expanded, setExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set([0]));

  const toggleGroup = (i: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-2 md:px-0">
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-2 py-2 text-xs text-foreground-muted
                   hover:text-foreground-secondary transition-colors duration-200 group"
      >
        <span className="h-px flex-1 bg-card-border max-w-16 group-hover:max-w-24 transition-all duration-300" />
        <span className="flex items-center gap-1.5">
          按分类查看示例视频
          <ChevronDown
            size={12}
            className={`transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
        <span className="h-px flex-1 bg-card-border max-w-16 group-hover:max-w-24 transition-all duration-300" />
      </button>

      {/* Sample links panel */}
      {expanded && (
        <div className="mt-3 space-y-3 animate-fade-in">
          {sampleGroups.map((group, gi) => {
            const isGroupOpen = expandedGroups.has(gi);
            return (
              <div
                key={group.slug}
                className="rounded-xl bg-card-bg border border-card-border overflow-hidden"
              >
                {/* Group header */}
                <button
                  type="button"
                  onClick={() => toggleGroup(gi)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-left
                             hover:bg-white/[0.02] transition-colors duration-200"
                >
                  <span
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: group.accent }}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-semibold text-foreground flex-1">
                    {group.title}
                  </span>
                  <span className="text-[10px] text-foreground-muted tabular-nums">
                    {group.samples.length} 个
                  </span>
                  <ChevronDown
                    size={12}
                    className={`text-foreground-muted transition-transform duration-300 ${
                      isGroupOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {/* Group links */}
                {isGroupOpen && (
                  <div className="border-t border-card-border divide-y divide-card-border">
                    {group.samples.map((link, li) => (
                      <button
                        key={`${group.slug}-${li}`}
                        type="button"
                        disabled={isLoading}
                        onClick={() => onFill(link.url)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left
                                   hover:bg-accent-emerald/[0.04] transition-colors duration-200
                                   disabled:opacity-50 disabled:cursor-not-allowed group/link"
                      >
                        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-accent-emerald/[0.08]
                                        flex items-center justify-center
                                        group-hover/link:bg-accent-emerald/[0.15] transition-colors">
                          <Play size={11} className="text-accent-emerald" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground truncate
                                        group-hover/link:text-accent-emerald transition-colors">
                            {link.title}
                          </p>
                          <p className="text-[11px] text-foreground-muted truncate mt-0.5">
                            {link.desc}
                          </p>
                        </div>
                        <ExternalLink
                          size={11}
                          className="text-foreground-muted/40 flex-shrink-0
                                     group-hover/link:text-accent-emerald/60 transition-colors"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
