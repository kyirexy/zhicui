'use client';

import { useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import {
  normalizeCoverSources,
  type CoverSource,
  withCoverRetryToken,
} from '@/lib/libraryCoverSources';

interface LibraryCoverImageProps {
  src?: string | null;
  sources?: CoverSource[];
  fallbackClassName: string;
  fallbackLabel?: string;
  iconSize?: number;
  alt?: string;
  retryable?: boolean;
  priority?: boolean;
  onRefreshSources?: () => Promise<CoverSource[] | void> | CoverSource[] | void;
}

export default function LibraryCoverImage({
  src,
  sources = [],
  fallbackClassName,
  fallbackLabel,
  iconSize = 22,
  alt = '',
  retryable = true,
  priority = false,
  onRefreshSources,
}: LibraryCoverImageProps) {
  const [failed, setFailed] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [retrySeed, setRetrySeed] = useState(0);
  const [refreshedSources, setRefreshedSources] = useState<string[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const initialSources = useMemo(
    () => normalizeCoverSources(src, ...sources),
    [sources, src],
  );
  const initialSourceKey = initialSources.join('\n');
  const candidates = refreshedSources ?? initialSources;
  const canRetry = retryable && (candidates.length > 0 || Boolean(onRefreshSources));

  useEffect(() => {
    setFailed(false);
    setSourceIndex(0);
    setRetrySeed(0);
    setRefreshedSources(null);
    setRefreshing(false);
  }, [initialSourceKey]);

  const displaySrc = useMemo(() => {
    const current = candidates[sourceIndex] || '';
    return withCoverRetryToken(current, retrySeed);
  }, [candidates, retrySeed, sourceIndex]);

  const retry = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const refreshed = await onRefreshSources?.();
      const nextSources = normalizeCoverSources(...(refreshed || []), ...initialSources);
      setRefreshedSources(nextSources.length > 0 ? nextSources : null);
      setSourceIndex(0);
      setFailed(false);
      setRetrySeed(Date.now());
    } catch {
      // A metadata refresh can fail independently of the image CDN. Still give
      // the existing candidates one clean browser request instead of leaving
      // the control stuck in its loading state.
      setSourceIndex(0);
      setFailed(false);
      setRetrySeed(Date.now());
    } finally {
      setRefreshing(false);
    }
  };

  if (!displaySrc || failed) {
    const content = (
      <>
        <ImageOff size={iconSize} aria-hidden="true" />
        {fallbackLabel && (
          <small>{canRetry ? `${fallbackLabel} · 点击重试` : fallbackLabel}</small>
        )}
      </>
    );
    if (!canRetry) {
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
        aria-label={refreshing ? '正在重新获取视频封面' : '重新获取视频封面'}
        disabled={refreshing}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void retry();
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
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (sourceIndex + 1 < candidates.length) {
          setSourceIndex((value) => value + 1);
          setRetrySeed(0);
          return;
        }
        setFailed(true);
      }}
    />
  );
}
