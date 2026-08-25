export function buildVideoDetailHref(noteId: string): string {
  const normalized = noteId.trim();
  if (!normalized) return '/library';
  return `/library/detail?note=${encodeURIComponent(normalized)}`;
}

export function shouldOpenExtractedVideo(input: {
  armed: boolean;
  observedLoading: boolean;
  isLoading: boolean;
  noteId?: string | null;
}): boolean {
  return input.armed
    && input.observedLoading
    && !input.isLoading
    && Boolean(input.noteId?.trim());
}

export function buildBilibiliEmbedUrl(videoId: string): string | null {
  const normalized = videoId.trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(normalized)) return null;
  const params = new URLSearchParams({ bvid: normalized, autoplay: '0', high_quality: '1' });
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}
