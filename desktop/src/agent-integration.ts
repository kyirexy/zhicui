import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DesktopAgentAuthorizationStatus,
  DesktopAgentClient,
  DesktopAgentClientStatus,
  DesktopAgentIntegrationOverview,
  DesktopAgentIntegrationRequest,
  DesktopAgentIntegrationResult,
} from './contract';

const MAX_OUTPUT_BYTES = 512 * 1024;
const ACTION_TIMEOUT_MS = 120_000;
const AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;
const AGENT_DEVICE_SCOPES = [
  'library:read', 'library:write', 'ask:run', 'knowledge:read', 'knowledge:write',
  'plan:read', 'plan:write', 'creator:sync', 'local:invoke',
  'account:read', 'creator:read', 'ask:read', 'models:read',
] as const;
const CORE_AGENT_SCOPES = new Set([
  'account:read', 'library:read', 'creator:read', 'ask:read', 'ask:run',
  'knowledge:read', 'knowledge:write', 'plan:read', 'plan:write', 'models:read',
]);

type UnknownRecord = Record<string, unknown>;

interface CliProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function safeMessage(value: unknown, fallback: string): string {
  const text = String(value || '')
    .split(/\r?\n/, 1)[0]
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[本机路径]')
    .replace(/(?:zc_agent_|sk-|Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '[凭证已隐藏]')
    .replace(/\bzhc_(?:pat|access|refresh)_[A-Za-z0-9._~-]+/gi, '[凭证已隐藏]')
    .replace(/((?:cookie|jwt|api[_-]?key|(?:access_|refresh_)?token|device_code|password|secret))\s*[=:]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .slice(0, 220)
    .trim();
  return text || fallback;
}

function boolValue(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return safeMessage(value, '');
    }
  }
  return undefined;
}

function clientLabel(client: DesktopAgentClient): string {
  return client === 'codex' ? 'Codex' : 'Claude Code';
}

export function resolveBundledCliEntry(input: {
  packaged: boolean;
  resourcesPath: string;
  compiledDirectory: string;
}): string {
  return input.packaged
    ? join(input.resourcesPath, 'cli', 'index.js')
    : join(input.compiledDirectory, '..', '..', 'cli', 'dist', 'index.js');
}

function parseCliPayload(stdout: string): UnknownRecord {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return record(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return record(JSON.parse(lines[index]));
      } catch {
        // stdout 协议若损坏，只返回稳定错误，不向渲染进程透传原文。
      }
    }
    return {};
  }
}

/** 仅接受当前服务明确公开的权限；能力未知时不使用历史默认权限授权。 */
export function resolveAgentAuthorizationScopes(payload: UnknownRecord): {
  releaseProfile: 'core' | 'full';
  scopes: string[];
} {
  const data = record(payload.data ?? payload);
  const releaseProfile = data.release_profile;
  if (payload.status === 'failed' || data.feature_enabled !== true
    || (releaseProfile !== 'core' && releaseProfile !== 'full')
    || !Array.isArray(data.scopes) || data.scopes.length > 100) {
    throw new Error('无法确认当前开放的能力，请刷新 Agent 接入后重试');
  }
  const allowed = new Set<string>();
  for (const item of data.scopes) {
    const id = record(item).id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}:[a-z][a-z0-9_-]{0,39}$/.test(id)
      || /(?:admin|shell|database|cookie|jwt|api[_-]?key)/i.test(id) || allowed.has(id)
      || (releaseProfile === 'core' && !CORE_AGENT_SCOPES.has(id))) {
      throw new Error('服务返回的授权权限无法验证，请稍后重试');
    }
    allowed.add(id);
  }
  const scopes = AGENT_DEVICE_SCOPES.filter((scope) => allowed.has(scope));
  if (!scopes.length) throw new Error('当前服务没有开放可连接的权限，请稍后重试');
  return { releaseProfile, scopes };
}

function normalizeCliResult(
  request: DesktopAgentIntegrationRequest,
  processResult: CliProcessResult,
): DesktopAgentIntegrationResult {
  const payload = parseCliPayload(processResult.stdout);
  const data = record(payload.data);
  const nestedResult = record(data.result);
  const directClient = record(payload[request.client]);
  const checks = Array.isArray(payload.checks) ? payload.checks : Array.isArray(data.checks) ? data.checks : [];
  const doctorCheck = record(checks.find((item) => (
    record(item).client === request.client
  )));
  const source = Object.keys(directClient).length > 0
    ? directClient
    : Object.keys(doctorCheck).length > 0
      ? doctorCheck
      : Object.keys(nestedResult).length > 0
        ? nestedResult
        : data;
  const error = record(payload.error);
  const credential = record(payload.credential || data.credential);
  const cloud = record(payload.cloud || data.cloud);
  const local = record(payload.local || data.local);
  const configured = boolValue(source.configured, data.configured);
  const managed = boolValue(source.managed);
  const skillCurrent = boolValue(source.skill_current);
  const authenticated = boolValue(source.authenticated, payload.authenticated, data.authenticated, credential.authenticated);
  const cloudAvailable = boolValue(source.cloud_available, payload.cloud_available, data.cloud_available, cloud.available);
  const mcpHealthy = boolValue(source.mcp_healthy, payload.mcp_healthy, data.mcp_healthy);
  // 旧 CLI 缺少真实验证字段时保持未就绪，不把“配置存在”提升为“可调用”。
  const ready = configured && managed && skillCurrent && authenticated && cloudAvailable && mcpHealthy
    && boolValue(source.ready, payload.ready, data.ready)
    && !['AGENT_UPDATE_REQUIRED', 'AGENT_CONFIG_CONFLICT', 'INTERFACE_DISABLED', 'ROLLOUT_RESTRICTED'].includes(String(source.code || payload.code || ''));
  const success = processResult.exitCode === 0
    && payload.status !== 'failed'
    && !processResult.timedOut;
  const fallback = processResult.timedOut
    ? '本机 Agent 操作超时，请稍后重试'
    : success
      ? `${clientLabel(request.client)} 配置已完成`
      : `${clientLabel(request.client)} 本机操作失败`;
  const message = safeMessage(
    source.message
      || data.message
      || payload.message
      || error.message
      || processResult.stderr,
    fallback,
  );
  const diagnostics = Array.isArray(source.diagnostics)
    ? source.diagnostics
      .slice(0, 12)
      .map((item) => safeMessage(item, ''))
      .filter(Boolean)
    : undefined;
  return {
    success,
    client: request.client,
    operation: request.operation,
    code: processResult.timedOut
      ? 'AGENT_ACTION_TIMEOUT'
      : stringValue(error.code, source.code, payload.code)
        || (success ? 'OK' : `CLI_EXIT_${processResult.exitCode}`),
    message,
    installed: boolValue(source.installed, data.installed),
    configured,
    managed,
    skill_current: skillCurrent,
    authenticated,
    cloud_available: cloudAvailable,
    mcp_healthy: mcpHealthy,
    ready,
    local_available: boolValue(source.local_available, local.available),
    account_binding_verified: boolValue(source.account_binding_verified, local.account_binding_verified),
    version: stringValue(source.version, data.version),
    diagnostics,
  };
}

export class DesktopAgentIntegration {
  private statusInFlight: Promise<DesktopAgentIntegrationOverview> | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private boundProfileKey: string | null = null;
  private authorizationStatus: DesktopAgentAuthorizationStatus | undefined;
  private authorization: { client: DesktopAgentClient; id: string; cancelled: boolean; child: ChildProcess | null } | null = null;

  constructor(
    private readonly cliEntry: () => string,
    private readonly executable = process.execPath,
    private readonly publishAuthorization: (status: DesktopAgentAuthorizationStatus) => void = () => {},
  ) {}

  bindUser(profileKey: string | null): void {
    if (profileKey !== this.boundProfileKey) this.cancelAuthorization();
    this.boundProfileKey = profileKey;
  }

  private notifyAuthorization(status: DesktopAgentAuthorizationStatus): void {
    this.authorizationStatus = status.status === 'starting' || status.status === 'waiting' ? status : undefined;
    this.publishAuthorization(status);
  }

  getCliEntry(): string {
    return this.cliEntry();
  }

  isCliAvailable(): boolean {
    return existsSync(this.getCliEntry());
  }

  async status(): Promise<DesktopAgentIntegrationOverview> {
    if (this.statusInFlight) return this.statusInFlight;
    const operation = this.readStatus();
    this.statusInFlight = operation;
    try { return await operation; }
    finally { if (this.statusInFlight === operation) this.statusInFlight = null; }
  }

  private async readStatus(): Promise<DesktopAgentIntegrationOverview> {
    const capabilities = { version: 2, supports_authorization: true, managed_updates: true } as const;
    if (!this.isCliAvailable()) {
      return {
        available: false,
        cli_available: false,
        clients: [],
        capabilities,
        code: 'CLI_UNAVAILABLE',
        message: '当前安装包没有找到内置 CLI，请更新桌面客户端',
      };
    }
    await this.mutationQueue;
    const processResult = await this.execute([this.getCliEntry(), 'agent', 'doctor', '--client', 'all', '--json', '--non-interactive']);
    const clients = (['codex', 'claude'] as const).map((client) => (
      this.clientStatus(client, normalizeCliResult({ client, operation: 'doctor' }, processResult))
    ));
    return {
      available: true,
      cli_available: true,
      clients,
      capabilities,
      setup_prompt: this.setupPrompt(),
      authorization: this.authorizationStatus,
      message: clients.some((client) => client.ready)
        ? '已验证 Agent 接入，可在重新加载工具后使用'
        : clients.some((client) => client.configured) ? '配置已安装，请完成授权和连接检查' : '已找到内置 CLI，尚未连接 Agent',
    };
  }

  private setupPrompt(): string {
    const launcher = JSON.stringify({ command: this.executable, args: [this.getCliEntry()], env: { ELECTRON_RUN_AS_NODE: '1' } }, null, 2);
    return `请帮我接入知萃。先检查当前 Agent 是否已有可用的知萃 MCP 工具；若已有，先读取能力或资料列表。\n\n若缺少接入，请使用当前安装的知萃客户端内置 CLI，不要下载其他版本。固定启动信息如下：\n${launcher}\n\n在以上 args 后追加 agent setup --client codex --json；如果当前是 Claude Code，将 codex 改为 claude。MCP 服务器实际启动参数是在同一入口后追加 mcp serve --stdio。仅更新知萃管理的配置和 Skill，遇到自定义同名配置先说明冲突，不覆盖。不要读取、复制或输出任何凭据。\n\n安装配置后运行同一入口的 agent doctor --client codex --json（Claude Code 使用 claude）。配置成功不等于已授权或服务可用；若需要授权，让我回到知萃客户端的 Agent 接入页主动确认权限，不要代替我批准。\n\n配置或内置 CLI 更新后，需要重新加载当前 Agent 的 MCP 连接或重启会话；已运行的 MCP 进程不会热替换。最后验证工具列表和一次只读调用，并分别报告已配置、已授权、云端可用、MCP 可调用的状态。`;
  }

  async reconcileManaged(): Promise<void> {
    if (!this.isCliAvailable()) return;
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const operation = this.enqueueMutation(async () => {
      await this.execute([this.getCliEntry(), 'agent', 'reconcile', '--client', 'all', '--json', '--non-interactive']);
    });
    this.reconcileInFlight = operation;
    try { await operation; }
    finally { if (this.reconcileInFlight === operation) this.reconcileInFlight = null; }
  }

  private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.mutationQueue.then(action, action);
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async run(
    request: DesktopAgentIntegrationRequest,
  ): Promise<DesktopAgentIntegrationResult> {
    if (request.operation === 'cancel_authorization') return this.cancelAuthorization(request.client, request.authorization_id);
    if (!this.isCliAvailable()) {
      return {
        success: false,
        client: request.client,
        operation: request.operation,
        code: 'CLI_UNAVAILABLE',
        message: '当前安装包没有找到内置 CLI，请更新桌面客户端',
      };
    }
    if (request.operation === 'authorize') return this.authorize(request.client, request.authorization_id);
    if (request.operation === 'status' || request.operation === 'doctor') {
      const overview = await this.status();
      const client = overview.clients.find((item) => item.client === request.client);
      return { ...client, success: Boolean(client), client: request.client, operation: request.operation,
        code: client?.code || overview.code || 'AGENT_CHECK_FAILED', message: client?.message || overview.message || '检查未完成' };
    }
    return this.enqueueMutation(async () => {
    const cliClient = request.client === 'claude' ? 'claude' : 'codex';
    const args = [
      this.getCliEntry(),
      'agent',
      request.operation,
      '--client',
      cliClient,
      '--json',
      '--non-interactive',
    ];
    const processResult = await this.execute(args);
    const result = normalizeCliResult(request, processResult);
    if (!result.success) return result;
    const checked = await this.execute([this.getCliEntry(), 'agent', 'doctor', '--client', cliClient, '--json', '--non-interactive']);
    const status = this.clientStatus(request.client, normalizeCliResult({ client: request.client, operation: 'doctor' }, checked));
    return { ...result, ...status, success: result.success, operation: request.operation,
      message: request.operation === 'uninstall' ? '已移除知萃管理的 Agent 接入' : status.message };
    });
  }

  cancelAuthorization(client?: DesktopAgentClient, authorizationId?: string): DesktopAgentIntegrationResult {
    const current = this.authorization;
    const owner = client || current?.client || 'codex';
    if (!current || (client && (current.client !== client || current.id !== authorizationId))) {
      return { success: false, client: owner, operation: 'cancel_authorization', code: 'AUTHORIZATION_NOT_FOUND', message: '当前没有等待中的授权' };
    }
    current.cancelled = true;
    current.child?.kill();
    this.notifyAuthorization({ client: current.client, authorization_id: current.id, status: 'cancelled', code: 'AUTHORIZATION_CANCELLED', message: '已停止等待授权' });
    return { success: true, client: current.client, operation: 'cancel_authorization', code: 'AUTHORIZATION_CANCELLED', message: '已停止等待授权' };
  }

  private async authorize(client: DesktopAgentClient, authorizationId?: string): Promise<DesktopAgentIntegrationResult> {
    if (!authorizationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authorizationId)) {
      return { success: false, client, operation: 'authorize', code: 'AUTHORIZATION_ID_REQUIRED', message: '授权批次标识无效，请重新连接' };
    }
    if (!this.boundProfileKey) return { success: false, client, operation: 'authorize', code: 'DESKTOP_AUTH_REQUIRED', message: '请先登录知萃客户端，再连接 Agent' };
    if (this.authorization) return { success: false, client, operation: 'authorize', code: 'AUTHORIZATION_BUSY', message: '已有授权正在等待确认' };
    const current = { client, id: authorizationId, cancelled: false, child: null as ChildProcess | null };
    this.authorization = current;
    this.notifyAuthorization({ client, authorization_id: current.id, status: 'starting', message: '正在确认当前开放的能力与权限' });
    const environment = { ...process.env };
    try {
      const capabilities = await this.execute([this.getCliEntry(), 'capabilities', '--public', '--json', '--non-interactive'], {
        environment,
        onChild: (child) => { current.child = child; if (current.cancelled) child.kill(); },
      });
      if (current.cancelled || this.authorization !== current) return { success: false, client, operation: 'authorize', code: 'AUTHORIZATION_CANCELLED', message: '已停止等待授权' };
      let selection: ReturnType<typeof resolveAgentAuthorizationScopes>;
      try {
        if (capabilities.exitCode !== 0 || capabilities.timedOut) throw new Error('暂时无法读取当前开放的能力，请检查服务后重试');
        selection = resolveAgentAuthorizationScopes(parseCliPayload(capabilities.stdout));
      } catch (error) {
        const message = safeMessage(error instanceof Error ? error.message : '', '暂时无法确认授权权限，请稍后重试');
        const code = 'AGENT_CAPABILITIES_UNAVAILABLE';
        this.notifyAuthorization({ client, authorization_id: current.id, status: 'error', code, message });
        return { success: false, client, operation: 'authorize', code, message };
      }
      const result = await this.execute([this.getCliEntry(), 'auth', 'login', '--jsonl', '--no-open', '--non-interactive', '--timeout', '10m',
        '--scopes', selection.scopes.join(',')], {
        environment,
        timeoutMs: AUTHORIZATION_TIMEOUT_MS + 5_000,
        onChild: (child) => { current.child = child; if (current.cancelled) child.kill(); },
        onEvent: (event) => {
          if (this.authorization !== current || current.cancelled || event.event !== 'device_authorization') return;
          const code = typeof event.user_code === 'string' ? event.user_code : '';
          if (!/^[A-Za-z0-9-]{4,32}$/.test(code)) return;
          const expires = typeof event.expires_at === 'string' && Number.isFinite(Date.parse(event.expires_at)) ? event.expires_at : undefined;
          this.notifyAuthorization({ client, authorization_id: current.id, status: 'waiting', user_code: code, expires_at: expires,
            scopes: selection.scopes, release_profile: selection.releaseProfile,
            message: '请在当前页面核对账号与权限，并主动确认授权' });
        },
      });
      if (current.cancelled || this.authorization !== current) return { success: false, client, operation: 'authorize', code: 'AUTHORIZATION_CANCELLED', message: '已停止等待授权' };
      const terminal = parseCliPayload(result.stdout);
      const authorized = result.exitCode === 0 && !result.timedOut && terminal.event === 'authorization_complete'
        && terminal.status === 'succeeded' && terminal.authenticated === true;
      if (!authorized) {
        const error = record(terminal.error);
        const code = result.timedOut ? 'AUTHORIZATION_TIMEOUT' : stringValue(error.code) || 'AUTHORIZATION_FAILED';
        const message = result.timedOut ? '授权等待超时，请重试' : safeMessage(error.message, '授权未完成，请重试');
        this.notifyAuthorization({ client, authorization_id: current.id, status: 'error', code, message });
        return { success: false, client, operation: 'authorize', code, message };
      }
      const checked = await this.execute([this.getCliEntry(), 'agent', 'doctor', '--client', client, '--json', '--non-interactive'], {
        environment,
        onChild: (child) => { current.child = child; if (current.cancelled) child.kill(); },
      });
      if (current.cancelled || this.authorization !== current) return { success: false, client, operation: 'authorize', code: 'AUTHORIZATION_CANCELLED', message: '已停止等待授权' };
      const status = this.clientStatus(client, normalizeCliResult({ client, operation: 'doctor' }, checked));
      this.notifyAuthorization({ client, authorization_id: current.id, status: 'success', code: status.code, message: status.message });
      return { ...status, success: true, client, operation: 'authorize', code: status.code || 'OK' };
    } finally { if (this.authorization === current) this.authorization = null; }
  }

  private clientStatus(
    client: DesktopAgentClient,
    result: DesktopAgentIntegrationResult,
  ): DesktopAgentClientStatus {
    const code = !result.success ? result.code : !result.installed ? 'AGENT_NOT_INSTALLED'
      : !result.configured ? 'AGENT_NOT_CONFIGURED' : !result.managed ? 'AGENT_CONFIG_CONFLICT'
        : !result.skill_current || result.code === 'AGENT_UPDATE_REQUIRED' ? 'AGENT_UPDATE_REQUIRED'
          : ['INTERFACE_DISABLED', 'ROLLOUT_RESTRICTED'].includes(result.code) ? result.code
            : !result.authenticated ? 'AUTH_REQUIRED'
          : !result.cloud_available ? 'CLOUD_UNAVAILABLE' : !result.mcp_healthy ? 'MCP_UNAVAILABLE'
            : result.ready ? 'READY' : 'AGENT_NOT_READY';
    const messages: Record<string, string> = { AGENT_NOT_INSTALLED: '请先安装对应的 Agent', AGENT_NOT_CONFIGURED: '尚未安装知萃 MCP 和 Skill',
      AGENT_CONFIG_CONFLICT: '检测到自定义同名配置，未做覆盖', AGENT_UPDATE_REQUIRED: '知萃接入需要更新', AUTH_REQUIRED: '配置已安装，请在客户端完成授权',
      CLOUD_UNAVAILABLE: '已配置并授权，云端接口暂不可用', INTERFACE_DISABLED: 'Agent 云端接口尚未开放，安装配置已保留', ROLLOUT_RESTRICTED: 'Agent 云端接口尚未向当前账号开放',
      MCP_UNAVAILABLE: 'MCP 尚未通过连接检查，请重新加载 Agent', READY: '已验证可用；配置更新后请重新加载 Agent 工具', AGENT_NOT_READY: '接入检查尚未完成' };
    return {
      client,
      installed: Boolean(result.installed),
      configured: Boolean(result.configured),
      managed: Boolean(result.managed),
      skill_current: Boolean(result.skill_current),
      authenticated: Boolean(result.authenticated),
      cloud_available: Boolean(result.cloud_available),
      mcp_healthy: Boolean(result.mcp_healthy),
      ready: Boolean(result.ready),
      local_available: Boolean(result.local_available),
      account_binding_verified: Boolean(result.account_binding_verified),
      code,
      version: result.version,
      message: messages[code] || result.message,
    };
  }

  private execute(args: string[], options: { timeoutMs?: number; environment?: NodeJS.ProcessEnv; onEvent?: (event: UnknownRecord) => void; onChild?: (child: ChildProcess) => void } = {}): Promise<CliProcessResult> {
    return new Promise((resolve) => {
      const childEnvironment = { ...(options.environment ?? process.env), ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' };
      // 桌面接入必须注册当前安装包，不能沿用外部终端给 CLI 设置的替代入口。
      delete (childEnvironment as NodeJS.ProcessEnv).ZHICUI_CLI_EXECUTABLE;
      const child = execFile(
        this.executable,
        args,
        {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: options.timeoutMs || ACTION_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          env: childEnvironment,
        },
        (error, stdout, stderr) => {
          const candidate = error as (NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
            signal?: string;
          }) | null;
          const numericExit = typeof candidate?.code === 'number'
            ? candidate.code
            : error
              ? 7
              : 0;
          resolve({
            exitCode: numericExit,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            timedOut: Boolean(candidate?.killed && candidate.signal),
          });
        },
      );
      options.onChild?.(child);
      if (options.onEvent) {
        let pending = '';
        child.stdout?.on('data', (chunk: string | Buffer) => {
          pending += chunk.toString();
          if (pending.length > MAX_OUTPUT_BYTES) { child.kill(); return; }
          let boundary: number;
          while ((boundary = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, boundary).trim();
            pending = pending.slice(boundary + 1);
            if (!line) continue;
            try { options.onEvent?.(record(JSON.parse(line))); } catch { /* 非协议输出不转发给页面。 */ }
          }
        });
      }
    });
  }
}
