'use client';

import { useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';

interface LibraryCoverImageProps {
  src?: string | null;
  fallbackClassName: string;
  fallbackLabel?: string;
  iconSize?: number;
  alt?: string;
  retryable?: boolean;
}

export default function LibraryCoverImage({
  src,
  fallbackClassName,
  fallbackLabel,
  iconSize = 22,
  alt = '',
  retryable = true,
}: LibraryCoverImageProps) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrySeed, setRetrySeed] = useState(0);

  useEffect(() => {
    setFailed(false);
    setAttempt(0);
    setRetrySeed(0);
  }, [src]);

  const displaySrc = useMemo(() => {
    if (!src || !retrySeed) return src;
    return `${src}${src.includes('?') ? '&' : '?'}zhicui_retry=${retrySeed}`;
  }, [retrySeed, src]);

  const retry = () => {
    setFailed(false);
    setAttempt((value) => value + 1);
    setRetrySeed(Date.now());
  };

  if (!displaySrc || failed) {
    const content = (
      <>
        <ImageOff size={iconSize} aria-hidden="true" />
        {fallbackLabel && (
          <small>{retryable ? `${fallbackLabel} · 点击重试` : fallbackLabel}</small>
        )}
      </>
    );
    if (!retryable || !src) {
      return (
        <span
          className={`${fallbackClassName} library-cover-image-fallback`}
          aria-label={fallbackLabel || '封面暂不可用'}
        >
          {content}
        </span>
      );
    }
    return (
      <button
        type="button"
        className={`${fallbackClassName} library-cover-image-fallback is-retryable`}
        aria-label="重新加载视频封面"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          retry();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (attempt === 0) {
          retry();
          return;
        }
        setFailed(true);
      }}
    />
  );
}
