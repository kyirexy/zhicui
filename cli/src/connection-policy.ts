import type { AgentCapabilities } from './types.js';

// 日常连接一次覆盖视频整理链路；具体范围仍由服务发布清单过滤并由本人确认。
export const DAILY_AGENT_SCOPES = [
  'account:read', 'library:read', 'library:write', 'creator:read',
  'ask:read', 'ask:run', 'local:invoke',
] as const;

export function grantedScopeSnapshot(capabilities: AgentCapabilities) {
  const exact = Array.isArray(capabilities.granted_scopes);
  // 旧服务的顶层 scopes 是权限目录，不能当成当前授权。已过滤的动作只能证明已知下界。
  const scopes = [...new Set(exact ? capabilities.granted_scopes!
    : capabilities.actions.flatMap(action => action.scopes))].sort();
  return { scopes, scopes_source: exact ? 'server' as const : 'authorized_actions' as const,
    scopes_complete: exact };
}

export function desktopAuthorizationUrl(status: Record<string, unknown>, origin: string, userCode: string): string | null {
  const support = status.agent_authorization as { supported?: boolean; server_origin?: string } | undefined;
  if (status.available !== true || status.zhicui_login !== 'ready' || support?.supported !== true
    || support.server_origin !== new URL(origin).origin || userCode.length !== 9
    || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(userCode)) return null;
  return `zhicui://agent-authorize?user_code=${encodeURIComponent(userCode)}`;
}
