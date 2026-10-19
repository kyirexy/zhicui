export function agentKeyHandoffPrompt(key: string): string {
  return `请用下面的知萃 Agent 密钥连接当前 Agent。
使用官方知萃 CLI，把密钥通过无回显标准输入交给命令：zhicui connect --pat-stdin --client codex --non-interactive --json。当前使用 Claude Code 时，把 codex 改为 claude。
密钥只用于标准输入，不要放入命令参数、shell 脚本文本、日志、配置或项目文件，也不要回显；由 CLI 保存到系统安全存储。不能安全传入时，让我在 CLI 无回显输入一次。
这次连接不需要设备授权码。后续复用已有连接，不要重复登录；如缺少权限，报告缺项。本机操作需要知萃已启动且登录同一账号。验证完成后告诉我连接状态。

Agent 密钥（仅用于上述标准输入）：
${key}`;
}

export function agentConnectionUsage(input: {
  scopes: readonly string[];
  last_used_at: string | null;
}): string {
  if (input.scopes.includes('library:read') && input.scopes.every((scope) => scope.endsWith(':read'))) {
    return '仅可读取资料';
  }
  return input.last_used_at ? '已有使用记录' : '等待 Agent 使用';
}

export function agentCredentialLifetime(input: {
  expiry_policy?: string;
  inactivity_days?: number | null;
  expires_at: string | null;
}): string {
  if (input.expiry_policy === 'sliding_inactivity' && input.inactivity_days) {
    return `使用时自动延续，连续 ${input.inactivity_days} 天未使用后失效`;
  }
  if (!input.expires_at) return '以服务端有效期为准';
  const expires = new Date(input.expires_at);
  return Number.isNaN(expires.getTime()) ? '有效期未知' : `${expires.toLocaleDateString('zh-CN')} 到期`;
}
