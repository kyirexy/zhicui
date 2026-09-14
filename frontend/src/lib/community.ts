export const COMMUNITY_QR_PATH = '/images/community/wechat-group-20260914.png';
export const COMMUNITY_EXPIRES_AT = '2026-09-21T00:00:00+08:00';

export function isCommunityInviteExpired(now: number): boolean {
  return !Number.isFinite(now) || now >= Date.parse(COMMUNITY_EXPIRES_AT);
}
