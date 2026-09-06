export const CURRENT_LEGAL_VERSIONS = {
  terms: '2026-08-28',
  privacy: '2026-09-06',
  platformLimits: '2026-09-06',
  support: '2026-09-06',
} as const;

export const LEGAL_EFFECTIVE_DATE = '2026 年 8 月 28 日';
export const PRIVACY_EFFECTIVE_DATE = '2026 年 9 月 6 日';

export const PUBLIC_INFORMATION_LINKS = [
  { href: '/legal/terms', label: '用户协议' },
  { href: '/legal/privacy', label: '隐私政策' },
  { href: '/platform-limits', label: '平台与客户端限制' },
  { href: '/support', label: '支持与投诉' },
] as const;
