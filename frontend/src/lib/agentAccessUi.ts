export type AgentAccessPlatform = 'web' | 'windows' | 'android' | 'ios';

export function resolveAgentAccessPlatform(input: {
  desktop: boolean;
  android: boolean;
  ios?: boolean;
}): AgentAccessPlatform {
  if (input.android) return 'android';
  if (input.ios) return 'ios';
  return input.desktop ? 'windows' : 'web';
}

export function canRunLocalAgentActions(platform: AgentAccessPlatform): boolean {
  return platform === 'windows';
}

export function canShowAgentInstallGuide(platform: AgentAccessPlatform): boolean {
  return platform !== 'android' && platform !== 'ios';
}

export function safeAgentScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => (
    scope.length > 0
    && scope.length <= 80
    && !scope.toLowerCase().startsWith('admin:')
    && !/(?:shell|database|cookie|jwt|api[_-]?key)/i.test(scope)
  )))].sort();
}

export function agentCredentialPrefix(input: {
  prefix?: string | null;
  token_prefix?: string | null;
}): string {
  return input.prefix || input.token_prefix || 'zc_agent_…';
}

export function isActiveAgentConnection(input: {
  revoked_at: string | null;
  expires_at: string | null;
}, now = Date.now()): boolean {
  if (input.revoked_at) return false;
  if (!input.expires_at) return true;
  const expiresAt = Date.parse(input.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
