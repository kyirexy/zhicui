'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Loader2, AlertCircle, X, LogIn } from 'lucide-react';

interface InputBarProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  error?: string | null;
  /** External URL to fill into the input (e.g. from sample links). Cleared after fill. */
  fillUrl?: string | null;
  onFillComplete?: () => void;
}

export default function InputBar({ onSubmit, isLoading = false, error, fillUrl, onFillComplete }: InputBarProps) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Auto-focus on mount + restore pending URL after login
  useEffect(() => {
    inputRef.current?.focus();
    try {
      const pending = localStorage.getItem('zhicui_pending_url');
      if (pending) {
        setUrl(pending);
        localStorage.removeItem('zhicui_pending_url');
      }
    } catch {}
  }, []);

  // Fill from external source (e.g. sample link click)
  useEffect(() => {
    if (fillUrl) {
      setUrl(fillUrl);
      // Scroll input into view on mobile
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputRef.current?.focus();
      onFillComplete?.();
    }
  }, [fillUrl, onFillComplete]);

  // Paste detection
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = e.clipboardData.getData('text');
      if (pasted && isValidUrl(pasted)) {
        setUrl(pasted);
        e.preventDefault();
        onSubmit(pasted);
      }
    },
    [onSubmit],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed && !isLoading) {
      onSubmit(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleClear = () => {
    setUrl('');
    inputRef.current?.focus();
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-2 md:px-0">
      <form onSubmit={handleSubmit} className="relative">
        {/* Mobile: stacked layout (input row + button row).
            Desktop (md+): original inline layout (input + button on one row).
            We use the same outer container with `glass-input input-glow` so the
            visual frame stays consistent across breakpoints. */}
        <div className="glass-input input-glow relative overflow-hidden group">
          {/* Input row */}
          <div className="flex items-center gap-2.5 md:gap-3 px-4 py-3.5 md:px-5 md:py-4">
            {/* Inner emerald glow on focus — spans full input area */}
            <div className="absolute inset-0 bg-gradient-to-r from-accent-emerald/[0.02] via-transparent to-accent-emerald/[0.02] opacity-0 group-focus-within:opacity-100 transition-opacity duration-500 pointer-events-none" />

            <Link2
              size={18}
              className="text-foreground-muted flex-shrink-0 md:w-5 md:h-5 transition-colors duration-300 group-focus-within:text-accent-emerald/60"
            />
            <input
              ref={inputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              placeholder="粘贴视频链接，提取知识卡片..."
              className="relative flex-1 bg-transparent outline-none text-foreground placeholder:text-foreground-muted text-base min-w-0"
              style={{ fontSize: '16px' }}
              disabled={isLoading}
            />
            {url && !isLoading && (
              <button
                type="button"
                onClick={handleClear}
                className="relative p-1.5 rounded-full text-foreground-muted hover:text-foreground-secondary hover:bg-white/[0.06] transition-all duration-300 cursor-pointer flex-shrink-0"
                aria-label="清除输入"
              >
                <X size={16} />
              </button>
            )}
            {/* Desktop-only inline submit button (mobile button is below). */}
            <button
              type="submit"
              disabled={!url.trim() || isLoading}
              className="relative btn-primary btn-magnetic hidden md:flex items-center gap-2 px-4 py-2.5 md:px-5 text-sm min-h-[44px] md:min-h-[40px] flex-shrink-0"
            >
              {isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span className="hidden sm:inline">提取中</span>
                </>
              ) : (
                <span>提取</span>
              )}
            </button>
          </div>

          {/* Mobile-only full-width submit row, divided by a subtle hairline. */}
          <div className="md:hidden border-t border-card-border/40 px-2 py-2">
            <button
              type="submit"
              disabled={!url.trim() || isLoading}
              className="relative btn-primary btn-magnetic w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold min-h-[48px]"
            >
              {isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>提取中...</span>
                </>
              ) : (
                <span>提取知识卡片</span>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Error display: inline with premium treatment */}
      {error && (
        <div className="mt-4 flex items-start gap-2.5 p-4 md:p-5 rounded-xl bg-accent-rose/[0.06] border border-accent-rose/[0.12] animate-fade-in backdrop-blur-sm">
          <AlertCircle
            size={16}
            className="text-accent-rose flex-shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground-secondary leading-relaxed text-pretty">
              {error}
            </p>
            {error === '请先登录' && (
              <button
                type="button"
                onClick={() => {
                  if (url.trim()) {
                    localStorage.setItem('zhicui_pending_url', url.trim());
                  }
                  router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
                }}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent-emerald hover:underline"
              >
                <LogIn size={12} />
                登录 / 注册
              </button>
            )}
          </div>
        </div>
      )}

      {/* Supported platforms hint */}
      <p className="mt-4 md:mt-5 text-center text-foreground-muted text-xs tracking-wide">
        支持 YouTube、Bilibili、抖音、小红书等主流视频平台
      </p>
    </div>
  );
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
