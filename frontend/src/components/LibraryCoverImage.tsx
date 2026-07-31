'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';

interface LibraryCoverImageProps {
  src?: string | null;
  fallbackClassName: string;
  fallbackLabel?: string;
  iconSize?: number;
}

export default function LibraryCoverImage({
  src,
  fallbackClassName,
  fallbackLabel,
  iconSize = 22,
}: LibraryCoverImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span className={fallbackClassName} aria-label={fallbackLabel || '封面暂不可用'}>
        <ImageOff size={iconSize} aria-hidden="true" />
        {fallbackLabel && <small>{fallbackLabel}</small>}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
