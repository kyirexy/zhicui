export const AGENT_SCROLL_FOLLOW_THRESHOLD_PX = 24;
export const AGENT_SCROLL_BUTTON_THRESHOLD_PX = 56;
const AGENT_SCROLL_LEDGER_TOLERANCE_PX = 0.5;

interface AgentScrollFollowInput {
  clientHeight: number;
  following: boolean;
  observedScrollTop: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface AgentScrollFollowState {
  distanceFromBottom: number;
  floor: number;
  following: boolean;
  movedByReader: boolean;
  showBackToBottom: boolean;
}

/**
 * 只允许读者造成的滚动偏移改变跟随所有权。正文增高、容器缩放和程序
 * 写入都会命中已记录的 scrollTop，因此不会把会话误判成“用户上滑”。
 */
export function resolveAgentScrollFollow({
  clientHeight,
  following,
  observedScrollTop,
  scrollHeight,
  scrollTop,
}: AgentScrollFollowInput): AgentScrollFollowState {
  const floor = Math.max(0, scrollHeight - clientHeight);
  const normalizedTop = Math.min(Math.max(0, scrollTop), floor);
  const deliveredTop = Math.min(Math.max(0, observedScrollTop), floor);
  const movedByReader = Math.abs(normalizedTop - deliveredTop)
    > AGENT_SCROLL_LEDGER_TOLERANCE_PX;
  const distanceFromBottom = Math.max(0, floor - normalizedTop);
  const nextFollowing = movedByReader
    ? distanceFromBottom <= AGENT_SCROLL_FOLLOW_THRESHOLD_PX
    : following;

  return {
    distanceFromBottom,
    floor,
    following: nextFollowing,
    movedByReader,
    showBackToBottom: !nextFollowing
      && distanceFromBottom > AGENT_SCROLL_BUTTON_THRESHOLD_PX,
  };
}
