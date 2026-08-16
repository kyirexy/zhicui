'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { Search, Copy, Check, FileText } from 'lucide-react';

interface TranscriptViewerProps {
  transcript: string;
  className?: string;
}

export default function TranscriptViewer({ transcript, className = '' }: TranscriptViewerProps) {
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyResetTimer = useRef<number | null>(null);

  const lines = useMemo(() => transcript.split('\n'), [transcript]);

  const filteredLines = useMemo(() => {
    if (!search.trim()) return lines;
    const lower = search.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(lower));
  }, [lines, search]);

  useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
  }, []);

  const markCopied = () => {
    setCopied(true);
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopied(false);
      copyResetTimer.current = null;
    }, 2000);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      markCopied();
    } catch {
      // Fallback for older browsers / non-HTTPS contexts.
      const ta = document.createElement('textarea');
      ta.value = transcript;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      markCopied();
    }
  };

  const charCount = transcript.length;
  const lineCount = lines.length;

  function highlightMatches(text: string): React.ReactNode {
    if (!search.trim()) return text;
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === search.toLowerCase() ? (
        <mark
          key={i}
          className="bg-accent-amber/30 text-foreground rounded-sm px-0.5"
        >
          {part}
        </mark>
      ) : (
        part
      ),
    );
  }

  return (
    <div className={`transcript-viewer ${className}`}>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
        <div className="relative flex-1 w-full">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted pointer-events-none"
          />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索文案内容…"
            aria-label="搜索完整文稿"
            className="transcript-search w-full pl-9 pr-3 py-2 text-sm rounded-lg
                       bg-card-bg border border-card-border text-foreground
                       placeholder:text-foreground-muted
                       focus:outline-none focus:border-accent-emerald focus:ring-1 focus:ring-accent-emerald/30
                       transition-colors duration-200"
          />
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-foreground-muted tabular-nums whitespace-nowrap">
            <FileText size={12} className="inline mr-1" />
            {lineCount} 行 · {charCount} 字
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium
                       rounded-lg border border-card-border bg-card-bg
                       text-foreground-secondary hover:text-foreground
                       hover:border-accent-emerald/30 transition-colors duration-200"
          >
            {copied ? (
              <>
                <Check size={13} className="text-accent-emerald" />
                已复制
              </>
            ) : (
              <>
                <Copy size={13} />
                复制全文
              </>
            )}
          </button>
        </div>
      </div>

      {/* Transcript text */}
      <div className="transcript-body rounded-xl bg-card-bg border border-card-border p-4 md:p-5 max-h-[60vh] overflow-y-auto">
        {filteredLines.length > 0 ? (
          <div className="space-y-1.5">
            {filteredLines.map((line, i) => (
              <p
                key={i}
                className="text-sm text-foreground-secondary leading-relaxed text-pretty"
              >
                {highlightMatches(line) || ' '}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-foreground-muted text-center py-8">
            没有匹配的结果
          </p>
        )}
      </div>
    </div>
  );
}
