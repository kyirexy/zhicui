/**
 * 平台资料只允许由用户当次明确点击触发。
 * 保留旧设置字段用于兼容已有 localStorage，但所有历史和未来值都迁移为关闭。
 */
export const MANUAL_SYNC_ONLY = true;

export function normalizeDisabledAutoSyncInterval(
  _value: unknown,
): 0 {
  return 0;
}
