/** 热更新检查的时间策略，保持为纯函数，便于独立验证。 */
export const STARTUP_CHECK_DELAY_MS = 12_000;
export const PERIODIC_CHECK_INTERVAL_MS = 60 * 60_000;
export const FOCUS_CHECK_THROTTLE_MS = 5 * 60_000;

export function shouldRunAutomaticUpdateCheck(
  now: number,
  lastCheckAt: number,
  force = false,
): boolean {
  if (force) return true;
  return now - lastCheckAt >= FOCUS_CHECK_THROTTLE_MS;
}
