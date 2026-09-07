export const COMMUNITY_QR_PATH = '/images/community/wechat-group-20260907.png';
export const COMMUNITY_EXPIRES_AT = '2026-09-14T00:00:00+08:00';
export const COMMUNITY_SUPPORT_EMAIL = '1592880030@qq.com';

export function isCommunityInviteExpired(now: number): boolean {
  return !Number.isFinite(now) || now >= Date.parse(COMMUNITY_EXPIRES_AT);
}
