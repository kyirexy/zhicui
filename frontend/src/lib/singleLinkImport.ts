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

export type HomeLinkDestination = {
  kind: 'creator' | 'video';
  url: string;
  platform?: 'douyin' | 'bilibili' | 'xiaohongshu';
};

const CREATOR_SHARE_HINT = /(?:博主|作者|个人)?主页|主页链接|个人空间/u;

/**
 * 首页统一入口的轻量分流。能够明确识别为博主主页时进入博主流程，
 * 其余链接交给单条解析，由后端继续做平台与内容校验。
 */
export function resolveHomeLinkDestination(value: string): HomeLinkDestination {
  const url = normalizeSingleLinkSubmission(value);
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const pathname = parsed.pathname.toLowerCase();
    const hintedAsCreator = CREATOR_SHARE_HINT.test(value);

    if (
      (hostname === 'space.bilibili.com' || hostname.endsWith('.space.bilibili.com'))
      || ((hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) && pathname.startsWith('/space/'))
      || ((hostname === 'b23.tv' || hostname.endsWith('.b23.tv')) && hintedAsCreator)
    ) {
      return { kind: 'creator', platform: 'bilibili', url };
    }
    if (
      (hostname === 'douyin.com' || hostname.endsWith('.douyin.com'))
      && (pathname.includes('/user/') || pathname.includes('/share/user/') || hintedAsCreator)
    ) {
      return { kind: 'creator', platform: 'douyin', url };
    }
    if (
      (hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com') || hostname === 'xhslink.com' || hostname.endsWith('.xhslink.com') || hostname === 'rednote.com' || hostname.endsWith('.rednote.com'))
      && (pathname.includes('/user/profile/') || hintedAsCreator)
    ) {
      return { kind: 'creator', platform: 'xiaohongshu', url };
    }
  } catch {
    // 非 URL 内容继续交给单条解析，以便显示后端的具体校验说明。
  }
  return { kind: 'video', url };
}

export function buildHomeLinkDestination(value: string): string {
  const destination = resolveHomeLinkDestination(value);
  if (destination.kind === 'creator' && destination.platform) {
    const params = new URLSearchParams({
      profile: destination.url,
      platform: destination.platform,
    });
    return `/library/creators?${params.toString()}`;
  }
  return `/extract?url=${encodeURIComponent(destination.url)}`;
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
