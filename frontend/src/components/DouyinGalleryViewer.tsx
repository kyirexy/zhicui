'use client';

import { ChevronLeft, ChevronRight, Images, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface DouyinGalleryViewerProps {
  images: string[];
  fallbackImage?: string;
  title: string;
}

type GalleryOrientation = 'unknown' | 'portrait' | 'square' | 'landscape';

function getGalleryOrientation(width: number, height: number): GalleryOrientation {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (ratio < 0.85) return 'portrait';
  if (ratio <= 1.18) return 'square';
  return 'landscape';
}

export default function DouyinGalleryViewer({
  images,
  fallbackImage = '',
  title,
}: DouyinGalleryViewerProps) {
  const sources = useMemo(
    () => images.length > 0 ? images : fallbackImage ? [fallbackImage] : [],
    [fallbackImage, images],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [orientation, setOrientation] = useState<GalleryOrientation>('unknown');
  const [loadedSource, setLoadedSource] = useState('');

  useEffect(() => {
    setActiveIndex(0);
    setFailed(false);
    setOrientation('unknown');
    setLoadedSource('');
  }, [images, fallbackImage]);

  const activeSource = sources[activeIndex] || '';

  useEffect(() => {
    if (sources.length < 2 || loadedSource !== activeSource) return;
    const neighborIndexes = [
      (activeIndex + 1) % sources.length,
      (activeIndex - 1 + sources.length) % sources.length,
    ];
    const preloaders = [...new Set(neighborIndexes)]
      .filter(index => index !== activeIndex)
      .map((index) => {
        const image = new Image();
        image.decoding = 'async';
        image.src = sources[index];
        return image;
      });
    return () => {
      preloaders.forEach((image) => {
        image.src = '';
      });
    };
  }, [activeIndex, activeSource, loadedSource, sources]);

  const move = (offset: number) => {
    if (sources.length < 2) return;
    setFailed(false);
    setOrientation('unknown');
    setLoadedSource('');
    setActiveIndex((current) => (
      (current + offset + sources.length) % sources.length
    ));
  };

  if (sources.length === 0) return null;

  return (
    <div className="video-gallery-viewer" data-orientation={orientation}>
      <div className="video-gallery-canvas">
        {fallbackImage && activeIndex === 0 && loadedSource !== activeSource && (
          <img
            className="video-gallery-placeholder"
            src={fallbackImage}
            alt=""
            aria-hidden="true"
            decoding="async"
          />
        )}
        {!failed ? (
          <img
            key={activeSource}
            className={`video-gallery-image ${loadedSource === activeSource ? 'is-ready' : ''}`}
            src={activeSource}
            alt={`${title} · 第 ${activeIndex + 1} 张`}
            decoding="async"
            fetchPriority="high"
            onLoad={(event) => {
              const image = event.currentTarget;
              setOrientation(getGalleryOrientation(image.naturalWidth, image.naturalHeight));
              setLoadedSource(activeSource);
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <button type="button" onClick={() => setFailed(false)}>
            <RotateCcw size={18} />
            重新读取这张图片
          </button>
        )}
        <span className="video-gallery-kind"><Images size={14} />抖音图文</span>
        {sources.length > 1 && (
          <>
            <button
              type="button"
              className="video-gallery-nav is-prev"
              onClick={() => move(-1)}
              aria-label="上一张图片"
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              className="video-gallery-nav is-next"
              onClick={() => move(1)}
              aria-label="下一张图片"
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>
      <div className="video-gallery-footer">
        <span>{activeIndex + 1} / {sources.length}</span>
        {sources.length > 1 && (
          <div className="video-gallery-thumbs" aria-label="选择图片">
            {sources.map((source, index) => (
              <button
                type="button"
                key={`${source}-${index}`}
                className={index === activeIndex ? 'is-active' : ''}
                aria-label={`查看第 ${index + 1} 张图片`}
                aria-pressed={index === activeIndex}
                onClick={() => {
                  setFailed(false);
                  setOrientation('unknown');
                  setLoadedSource('');
                  setActiveIndex(index);
                }}
              >
                <span>{index + 1}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
