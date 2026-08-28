const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_SHARE_PUNCTUATION = /[。；，、,.;!！?？)\]}>）】」』]+$/u;
const SUPPORTED_SHARE_DOMAINS = [
  'douyin.com',
  'iesdouyin.com',
  'bilibili.com',
  'b23.tv',
  'xiaohongshu.com',
  'xhslink.com',
  'rednote.com',
  'mp.weixin.qq.com',
] as const;

function isSupportedShareUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return SUPPORTED_SHARE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/**
 * 将平台分享口令转换为单条解析实际提交的链接。
 * 纯链接保持不变；找不到链接时保留原文，让后端返回具体的校验提示。
 */
export function normalizeSingleLinkSubmission(value: string): string {
  const normalized = value.trim();
  const candidates = Array.from(normalized.matchAll(HTTP_URL_PATTERN), (match) => (
    match[0].replace(TRAILING_SHARE_PUNCTUATION, '')
  )).filter(Boolean);
  if (!candidates.length) return normalized;
  return candidates.find(isSupportedShareUrl) || candidates[0];
}

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
