import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClientManager, type AgentClientSelection } from './agent-manager.js';
import {
  AgentApiClient,
  runFromEnvelope,
  runIdOf,
} from './api-client.js';
import { parseInvocation, type GlobalOptions } from './args.js';
import { CredentialManager } from './credentials.js';
import {
  domainHelp,
  resolveDomainAction,
  USER_COMMAND_DOMAINS,
} from './domain-aliases.js';
import { CliError, EXIT_CODES, normalizeUnknownError, usageError } from './errors.js';
import { buildActionInput, readSecretFromStdin, readSecretsFromStdin } from './input.js';
import { RestrictedLocalAdapter } from './local-adapter.js';
import { StdioMcpServer } from './mcp-server.js';
import { ProtocolWriter } from './output.js';
import type {
  AgentActionDefinition,
  AgentEnvelope,
  AgentRunEvent,
  JsonObject,
  StoredCredential,
} from './types.js';
import { isTerminalStatus } from './types.js';

export const CLI_VERSION = '1.0.0';

class ReportedCliError extends CliError {}

const DEFAULT_DEVICE_SCOPES = [
  'account:read',
  'library:read',
  'creator:read',
  'ask:read',
  'knowledge:read',
  'plan:read',
  'automation:read',
  'analysis:read',
  'models:read',
  'feedback:read',
];

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeValue(args: string[], name: string): string | undefined {
  const directIndex = args.findIndex((item) => item.startsWith(`${name}=`));
  if (directIndex >= 0) {
    const [value] = args.splice(directIndex, 1);
    return value.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw usageError(`${name} 需要一个值`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`无效整数：${value}`);
  return parsed;
}

function clientSelection(value: string | undefined): AgentClientSelection {
  const selection = value || 'all';
  if (!['codex', 'claude', 'all'].includes(selection)) {
    throw usageError('--client 只支持 codex、claude 或 all');
  }
  return selection as AgentClientSelection;
}

function clientFor(options: GlobalOptions, credentials: CredentialManager): AgentApiClient {
  return new AgentApiClient({
    baseUrl: options.apiUrl,
    timeoutMs: options.timeoutMs,
    idempotencyKey: options.idempotencyKey,
    credentials,
  });
}

function helpPayload(): Record<string, unknown> {
  return {
    name: '@zhicui/cli',
    version: CLI_VERSION,
    usage: 'zhicui <domain> <command> [options]',
    domains: domainHelp(),
    generic: [
      'run <action_id>',
      'run wait|resume|get|cancel <run_id>',
      'run actions',
      'run describe <action_id>',
      'mcp serve --stdio',
      'agent setup|doctor|status|update|uninstall [--client all|codex|claude]',
      'account export --output <new-file.zip>  # password via no-echo stdin',
      'account delete                          # password + phrase via no-echo stdin',
      'models custom-create --name <name> --provider-name <provider> --model <model> --api-base <url> [--select] [--disabled] [--confirmation-id <id>]  # 先批准，再用无回显 stdin 输入 API Key',
      'models secret-update --target chat --model-id <id> [--confirmation-id <id>]  # 先批准，再用无回显 stdin 输入 API Key',
    ],
    global_flags: [
      '--json', '--jsonl', '--non-interactive', '--quiet', '--timeout',
      '--idempotency-key', '--profile',
    ],
    credential_rule: 'PAT 只能通过无回显 stdin 保存，禁止放入 argv。',
  };
}

async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
    || parsed.username
    || parsed.password
  ) {
    throw new CliError('REMOTE_FAILURE', '设备授权地址协议无效');
  }
  if (process.platform === 'win32') {
    const script = [
      '$url=[Console]::In.ReadToEnd().Trim();',
      '$info=[Diagnostics.ProcessStartInfo]::new();',
      '$info.FileName=$url;',
      '$info.UseShellExecute=$true;',
      '[Diagnostics.Process]::Start($info) | Out-Null;',
    ].join('');
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true });
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdin.end(url);
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

async function authCommand(
  args: string[],
  options: GlobalOptions,
  writer: ProtocolWriter,
  credentials: CredentialManager,
  client: AgentApiClient,
): Promise<void> {
  const command = args.shift() || 'status';
  if (command === 'status') {
    const verify = takeFlag(args, '--verify');
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    const status = await credentials.status();
    if (verify && status.authenticated) {
      try {
        const capabilities = await client.capabilities();
        Object.assign(status, { valid: true, actions: capabilities.actions.length });
      } catch (error) {
        Object.assign(status, {
          valid: false,
          validation_error: normalizeUnknownError(error).code,
        });
      }
    }
    writer.result(status);
    return;
  }
  if (command === 'logout') {
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    await credentials.delete();
    writer.result({ authenticated: false, removed: true });
    return;
  }
  if (!['login', 'device', 'pat'].includes(command)) {
    throw usageError(`未知 auth 命令：${command}`);
  }
  const patMode = command === 'pat' || takeFlag(args, '--pat-stdin');
  const noOpen = takeFlag(args, '--no-open');
  const scopesValue = takeValue(args, '--scopes');
  if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
  if (patMode) {
    const token = await readSecretFromStdin(options.nonInteractive, '请输入知萃 PAT（不会回显）：');
    const previous = await credentials.load();
    const credential: StoredCredential = {
      kind: 'pat',
      access_token: token,
      token_prefix: `${token.slice(0, 6)}…`,
      created_at: new Date().toISOString(),
    };
    try {
      await credentials.save(credential);
      const capabilities = await client.capabilities();
      writer.result({
        authenticated: true,
        kind: 'pat',
        token_prefix: credential.token_prefix,
        actions: capabilities.actions.length,
        store: credentials.store.kind,
      });
    } catch (error) {
      if (previous) await credentials.save(previous);
      else await credentials.delete();
      throw error;
    }
    return;
  }

  const scopes = scopesValue
    ? scopesValue.split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_DEVICE_SCOPES;
  const started = await client.startDeviceAuthorization(scopes);
  const deviceCode = typeof started.device_code === 'string' ? started.device_code : '';
  const userCode = typeof started.user_code === 'string' ? started.user_code : '';
  const verificationUrl = typeof started.verification_uri_complete === 'string'
    ? started.verification_uri_complete
    : typeof started.verification_uri === 'string'
      ? started.verification_uri
      : '';
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new CliError('REMOTE_FAILURE', '设备授权响应字段不完整');
  }
  writer.diagnostic('请求方：知萃 CLI（当前命令行设备）');
  writer.diagnostic(`请求权限：${scopes.join(', ')}`);
  writer.diagnostic(`请在浏览器确认知萃授权，验证码：${userCode}`);
  writer.diagnostic(`授权地址：${verificationUrl}`);
  if (!noOpen) await openBrowser(verificationUrl).catch(() => undefined);
  let intervalMs = Math.max(1_000, Number(started.interval || 5) * 1_000);
  const serverExpiry = Math.max(10_000, Number(started.expires_in || 600) * 1_000);
  const deadline = Date.now() + Math.min(serverExpiry, options.timeoutMs);
  while (Date.now() < deadline) {
    await delay(intervalMs);
    try {
      const data = await client.pollDeviceAuthorization(deviceCode);
      const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
      if (!accessToken) throw new CliError('REMOTE_FAILURE', '授权完成响应缺少 access_token');
      const publicCredential = data.credential && typeof data.credential === 'object'
        ? data.credential as Record<string, unknown>
        : {};
      const expiresAt = typeof data.expires_at === 'string'
        ? data.expires_at
        : typeof publicCredential.expires_at === 'string'
          ? publicCredential.expires_at
          : typeof data.expires_in === 'number' && data.expires_in > 0
            ? new Date(Date.now() + data.expires_in * 1_000).toISOString()
            : undefined;
      const returnedScopes = Array.isArray(data.scopes)
        ? data.scopes
        : Array.isArray(publicCredential.scopes)
          ? publicCredential.scopes
          : scopes;
      const credential: StoredCredential = {
        kind: 'device',
        access_token: accessToken,
        refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expires_at: expiresAt,
        token_prefix: typeof data.token_prefix === 'string'
          ? data.token_prefix
          : typeof publicCredential.token_prefix === 'string'
            ? publicCredential.token_prefix
          : `${accessToken.slice(0, 6)}…`,
        scopes: returnedScopes.filter((scope): scope is string => typeof scope === 'string'),
        created_at: new Date().toISOString(),
      };
      await credentials.save(credential);
      writer.result({
        authenticated: true,
        kind: 'device',
        token_prefix: credential.token_prefix,
        expires_at: credential.expires_at || null,
        scopes: credential.scopes,
        store: credentials.store.kind,
      });
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error);
      if (normalized.code === 'AUTHORIZATION_PENDING') continue;
      if (normalized.code === 'SLOW_DOWN') {
        intervalMs += 2_000;
        continue;
      }
      throw error;
    }
  }
  throw new CliError('TIMEOUT', '等待浏览器设备授权超时', {
    exitCode: EXIT_CODES.timeoutOrCanceled,
  });
}

function syntheticTerminal(envelope: AgentEnvelope, sequence: number): AgentRunEvent {
  return {
    sequence,
    event: 'run.completed',
    status: typeof envelope.status === 'string' ? envelope.status : 'succeeded',
    terminal: true,
    data: envelope as unknown as JsonObject,
  };
}

function envelopeFromEvent(runId: string, event: AgentRunEvent): AgentEnvelope {
  return {
    api_version: 'v1',
    run_id: runId,
    status: event.status || 'running',
    data: event.data ?? null,
    error: event.error ?? null,
  };
}

function runOutcomeError(envelope: AgentEnvelope): CliError | null {
  const run = runFromEnvelope(envelope);
  const status = run?.status || envelope.status;
  if (status === 'waiting_for_user') {
    return new CliError('WAITING_FOR_USER', '运行正在等待用户完成操作', {
      exitCode: EXIT_CODES.confirmationOrWaiting,
    });
  }
  if (status === 'canceled') {
    return new CliError('RUN_CANCELED', '运行已取消', {
      exitCode: EXIT_CODES.timeoutOrCanceled,
    });
  }
  if (status !== 'failed') return null;
  const raw = run?.error || envelope.error;
  if (raw && typeof raw === 'object') {
    return new CliError(raw.code, raw.message, {
      details: raw.details,
      retryAfterSeconds: raw.retry_after_seconds,
    });
  }
  return new CliError('REMOTE_FAILURE', typeof raw === 'string' ? raw : '运行失败');
}

async function *waitRunEvents(
  client: AgentApiClient,
  runId: string,
  afterSequence: number,
  timeoutMs: number,
  fetchFinalRun: boolean,
): AsyncGenerator<AgentRunEvent, AgentEnvelope> {
  const deadline = Date.now() + timeoutMs;
  let lastSequence = afterSequence;
  while (Date.now() < deadline) {
    let received = false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    for await (const event of client.events(runId, lastSequence, remaining)) {
      received = true;
      if (event.sequence === lastSequence) continue;
      if (event.sequence < lastSequence) {
        throw new CliError('EVENT_ORDER_INVALID', `事件 sequence 从 ${lastSequence} 回退到 ${event.sequence}`);
      }
      lastSequence = event.sequence;
      yield event;
      if (event.status === 'waiting_for_user') {
        return envelopeFromEvent(runId, event);
      }
      if (event.terminal || isTerminalStatus(event.status)) {
        if (!fetchFinalRun) {
          return envelopeFromEvent(runId, event);
        }
        return await client.getRun(runId, Math.max(1, deadline - Date.now()));
      }
    }
    const envelope = await client.getRun(runId, Math.max(1, deadline - Date.now()));
    const run = runFromEnvelope(envelope);
    const status = run?.status || envelope.status;
    if (status === 'waiting_for_user') return envelope;
    if (isTerminalStatus(status)) {
      yield syntheticTerminal({ ...envelope, status }, lastSequence + 1);
      return envelope;
    }
    if (!received) await delay(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  throw new CliError('TIMEOUT', '等待 Run 完成超时', {
    exitCode: EXIT_CODES.timeoutOrCanceled,
  });
}

async function renderEnvelope(
  envelope: AgentEnvelope,
  client: AgentApiClient,
  writer: ProtocolWriter,
  options: GlobalOptions,
  wait: boolean,
  afterSequence = 0,
): Promise<void> {
  const run = runFromEnvelope(envelope);
  const runId = runIdOf(run);
  if (!runId) {
    if (options.jsonl) writer.event(syntheticTerminal(envelope, afterSequence + 1));
    else writer.result(envelope);
    return;
  }
  if (!wait && !options.jsonl) {
    writer.result(envelope);
    return;
  }
  let finalEnvelope: AgentEnvelope = envelope;
  const events = waitRunEvents(
    client,
    runId,
    afterSequence,
    options.timeoutMs,
    !options.jsonl,
  );
  while (true) {
    const next = await events.next();
    if (next.done) {
      finalEnvelope = next.value;
      break;
    }
    if (options.jsonl) writer.event(next.value);
    else writer.diagnostic(`Run ${runId}: ${next.value.status || next.value.event || 'running'}`);
  }
  const outcomeError = runOutcomeError(finalEnvelope);
  if (outcomeError) {
    if (options.jsonl) {
      throw new ReportedCliError(outcomeError.code, outcomeError.message, {
        exitCode: outcomeError.exitCode,
        details: outcomeError.details,
        retryAfterSeconds: outcomeError.retryAfterSeconds,
      });
    }
    if (finalEnvelope.status === 'waiting_for_user') {
      writer.result(finalEnvelope);
      throw new ReportedCliError(outcomeError.code, outcomeError.message, {
        exitCode: outcomeError.exitCode,
      });
    }
    throw outcomeError;
  }
  if (!options.jsonl) writer.result(finalEnvelope);
}

async function invokeAction(
  action: AgentActionDefinition,
  input: JsonObject,
  options: GlobalOptions,
  writer: ProtocolWriter,
  client: AgentApiClient,
  wait: boolean,
  expectedUserHash?: string | null,
): Promise<void> {
  if (action.execution_location === 'local_windows') {
    const userHash = expectedUserHash ?? (await client.capabilities()).user_hash;
    const envelope = await new RestrictedLocalAdapter().invoke(
      action,
      input,
      options.timeoutMs,
      options.idempotencyKey,
      userHash,
    );
    const run = runFromEnvelope(envelope);
    const status = run?.status || envelope.status;
    if (options.jsonl) {
      writer.event({
        sequence: 1,
        event: isTerminalStatus(status) ? 'local.run.completed' : 'local.run.accepted',
        status,
        terminal: isTerminalStatus(status),
        data: envelope as unknown as JsonObject,
      });
    } else {
      writer.result(envelope);
    }
    if (!isTerminalStatus(status) && runIdOf(run)) {
      if (action.id.startsWith('local.platform.')) {
        const platform = typeof input.platform === 'string' ? input.platform : '<platform>';
        writer.diagnostic(
          `本机任务已启动；请使用 zhicui local platform-status ${platform} 查询进度。`,
        );
      } else {
        writer.diagnostic('本机任务正在等待用户操作；请使用 zhicui local status 查询进度。');
      }
    }
    const outcomeError = runOutcomeError(envelope);
    if (outcomeError) {
      throw new ReportedCliError(outcomeError.code, outcomeError.message, {
        exitCode: outcomeError.exitCode,
        details: outcomeError.details,
        retryAfterSeconds: outcomeError.retryAfterSeconds,
      });
    }
    return;
  }
  const envelope = await client.invoke(action.id, input);
  await renderEnvelope(envelope, client, writer, options, wait);
}

async function runCommand(
  args: string[],
  options: GlobalOptions,
  writer: ProtocolWriter,
  client: AgentApiClient,
): Promise<void> {
  const command = args.shift();
  if (!command) throw usageError('run 需要 Action ID 或 wait/resume/get/cancel 子命令');
  if (command === 'actions') {
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    writer.result(await client.capabilities());
    return;
  }
  if (command === 'describe') {
    const actionId = args.shift();
    if (!actionId || args.length) throw usageError('用法：zhicui run describe <action_id>');
    writer.result(await client.describeAction(actionId));
    return;
  }
  if (['wait', 'resume', 'get', 'cancel'].includes(command)) {
    const runId = args.shift();
    if (!runId) throw usageError(`run ${command} 需要 run_id`);
    const after = positiveInteger(takeValue(args, '--after'), 0);
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    if (command === 'get') writer.result(await client.getRun(runId));
    else if (command === 'cancel') writer.result(await client.cancelRun(runId));
    else await renderEnvelope(
      await client.getRun(runId), client, writer, options, true, after,
    );
    return;
  }
  const wait = takeFlag(args, '--wait');
  const input = await buildActionInput(args);
  const action = await client.describeAction(command);
  if (!action.available && action.execution_location !== 'local_windows') {
    throw new CliError('ACTION_NOT_AVAILABLE', action.unavailable_reason || 'Action 未开放');
  }
  await invokeAction(action, input, options, writer, client, wait);
}

async function domainCommand(
  domain: string,
  args: string[],
  options: GlobalOptions,
  writer: ProtocolWriter,
  client: AgentApiClient,
  credentials: CredentialManager,
): Promise<void> {
  const defaults: Record<string, string> = {
    account: 'get',
    local: 'status',
    ask: 'conversations',
    analysis: 'catalog',
  };
  const verb = args.shift() || defaults[domain] || 'list';
  if (domain === 'account' && verb === 'export') {
    const outputValue = takeValue(args, '--output');
    if (!outputValue) throw usageError('用法：zhicui account export --output <新文件.zip>');
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    const outputPath = resolve(outputValue);
    const parent = await stat(dirname(outputPath)).catch(() => null);
    if (!parent?.isDirectory()) throw usageError('导出目标目录不存在');
    if (await stat(outputPath).then(() => true).catch(() => false)) {
      throw new CliError('OUTPUT_EXISTS', '导出目标已存在，知萃不会覆盖现有文件');
    }
    const [password] = await readSecretsFromStdin(
      options.nonInteractive,
      ['请输入当前密码（不会回显）：'],
    );
    const archive = await client.secureAccountExport(password);
    let handle;
    let created = false;
    try {
      handle = await open(outputPath, 'wx', 0o600);
      created = true;
      await handle.writeFile(archive);
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new CliError('OUTPUT_EXISTS', '导出目标已存在，知萃不会覆盖现有文件');
      }
      if (created) await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
    writer.result({
      action: 'account.data.export',
      status: 'succeeded',
      output: outputPath,
      bytes: archive.byteLength,
      sha256: createHash('sha256').update(archive).digest('hex'),
    });
    return;
  }
  if (domain === 'account' && verb === 'delete') {
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    const [password, phrase] = await readSecretsFromStdin(
      options.nonInteractive,
      [
        '请输入当前密码（不会回显）：',
        '请输入“永久注销”确认短语（不会回显）：',
      ],
    );
    const prepared = await client.secureAccountDeletePrepare(password);
    const expected = typeof prepared.confirmation_phrase === 'string'
      ? prepared.confirmation_phrase
      : '';
    const token = typeof prepared.confirmation_token === 'string'
      ? prepared.confirmation_token
      : '';
    if (!expected || !token || phrase !== expected) {
      throw new CliError('CONFIRMATION_INVALID', '注销确认短语不正确，账号数据未发生变化', {
        exitCode: EXIT_CODES.confirmationOrWaiting,
      });
    }
    const envelope = await client.secureAccountDeleteConfirm(token, phrase);
    await credentials.delete();
    writer.result(envelope);
    return;
  }
  if (domain === 'models' && ['secret-update', 'byok-update'].includes(verb)) {
    const targetValue = takeValue(args, '--target');
    const modelId = takeValue(args, '--model-id');
    const confirmationId = takeValue(args, '--confirmation-id');
    if (targetValue !== 'chat' && targetValue !== 'vision') {
      throw usageError('--target 只支持 chat 或 vision');
    }
    if (targetValue === 'chat' && !modelId) {
      throw usageError('chat 密钥更新需要 --model-id');
    }
    if (targetValue === 'vision' && modelId) {
      throw usageError('vision 密钥更新不接受 --model-id');
    }
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    if (!confirmationId) {
      writer.result(await client.prepareModelSecretUpdate(targetValue, modelId));
      return;
    }
    const [apiKey] = await readSecretsFromStdin(
      options.nonInteractive,
      ['请输入 API Key（不会回显）：'],
    );
    writer.result(await client.secureModelSecretUpdate(
      targetValue, modelId, confirmationId, apiKey,
    ));
    return;
  }
  if (domain === 'models' && verb === 'custom-create') {
    const name = takeValue(args, '--name');
    const providerName = takeValue(args, '--provider-name');
    const model = takeValue(args, '--model');
    const apiBase = takeValue(args, '--api-base');
    const confirmationId = takeValue(args, '--confirmation-id');
    const select = takeFlag(args, '--select');
    const disabled = takeFlag(args, '--disabled');
    if (!name || !providerName || !model || !apiBase) {
      throw usageError(
        '用法：zhicui models custom-create --name <名称> --provider-name <供应商> '
        + '--model <模型> --api-base <URL> [--select] [--disabled]',
      );
    }
    if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
    const metadata = {
      name,
      provider_name: providerName,
      model,
      api_base: apiBase,
      enabled: !disabled,
      select,
    };
    if (!confirmationId) {
      writer.result(await client.prepareCustomModelCreate(metadata));
      return;
    }
    const [apiKey] = await readSecretsFromStdin(
      options.nonInteractive,
      ['请输入 API Key（不会回显）：'],
    );
    writer.result(await client.secureCustomModelCreate(metadata, confirmationId, apiKey));
    return;
  }
  const wait = takeFlag(args, '--wait');
  const capabilities = await client.capabilities();
  const { action, alias } = resolveDomainAction(capabilities, domain, verb);
  const input = await buildActionInput(args, alias.positionalKeys);
  await invokeAction(action, input, options, writer, client, wait, capabilities.user_hash);
}

async function agentCommand(
  args: string[],
  options: GlobalOptions,
  writer: ProtocolWriter,
  credentials: CredentialManager,
): Promise<void> {
  const command = args.shift() || 'status';
  const selection = clientSelection(takeValue(args, '--client'));
  if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
  const manager = new AgentClientManager(options.timeoutMs);
  if (command === 'setup') writer.result(await manager.setup(selection));
  else if (command === 'update') writer.result(await manager.update(selection));
  else if (command === 'uninstall') writer.result(await manager.uninstall(selection));
  else if (command === 'status') writer.result(await manager.status(selection));
  else if (command === 'doctor') {
    const credential = await credentials.status();
    let expectedUserHash: string | null = null;
    let bindingVerified = false;
    if (credential.authenticated === true) {
      try {
        const capabilities = await clientFor(options, credentials).capabilities();
        expectedUserHash = capabilities.user_hash || null;
      } catch {
        expectedUserHash = null;
      }
    }
    bindingVerified = Boolean(expectedUserHash);
    writer.result({
      ...await manager.doctor(selection),
      credential,
      local: {
        ...await new RestrictedLocalAdapter().status(expectedUserHash),
        account_binding_verified: bindingVerified,
      },
    });
  } else throw usageError(`未知 agent 命令：${command}`);
}

export async function runCli(argv: string[]): Promise<number> {
  const machineHint = {
    json: argv.includes('--json'),
    jsonl: argv.includes('--jsonl'),
    quiet: argv.includes('--quiet'),
  };
  let writer = new ProtocolWriter(machineHint);
  try {
    const { options, command } = parseInvocation(argv);
    writer = new ProtocolWriter(options);
    const domain = command.shift();
    if (!domain || ['help', '-h', '--help'].includes(domain)) {
      writer.result(helpPayload());
      return EXIT_CODES.success;
    }
    if (domain === 'version' || domain === '-v' || domain === '--version') {
      writer.result({ name: '@zhicui/cli', version: CLI_VERSION });
      return EXIT_CODES.success;
    }
    if (!USER_COMMAND_DOMAINS.includes(domain as (typeof USER_COMMAND_DOMAINS)[number])) {
      throw usageError(`未知命令域：${domain}`);
    }
    const credentials = new CredentialManager(options.profile, options.apiUrl);
    const client = clientFor(options, credentials);
    if (domain === 'auth') await authCommand(command, options, writer, credentials, client);
    else if (domain === 'run') await runCommand(command, options, writer, client);
    else if (domain === 'mcp') {
      const subcommand = command.shift();
      if (subcommand !== 'serve' || !takeFlag(command, '--stdio') || command.length) {
        throw usageError('用法：zhicui mcp serve --stdio');
      }
      await new StdioMcpServer(client).serve();
    } else if (domain === 'agent') {
      await agentCommand(command, options, writer, credentials);
    } else {
      await domainCommand(domain, command, options, writer, client, credentials);
    }
    return EXIT_CODES.success;
  } catch (error) {
    const normalized = normalizeUnknownError(error);
    if (!(error instanceof ReportedCliError)) writer.error(normalized);
    return normalized.exitCode;
  }
}
