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
  aliasFor,
  domainAliasEntries,
  domainHelp,
  resolveDomainAction,
  USER_COMMAND_DOMAINS,
} from './domain-aliases.js';
import { CliError, EXIT_CODES, normalizeUnknownError, usageError } from './errors.js';
import { buildActionInput, readSecretFromStdin, readSecretsFromStdin } from './input.js';
import { RestrictedLocalAdapter } from './local-adapter.js';
import { downloadLibraryFile } from './media-download.js';
import { checkPrepareCapabilities, prepareLibraryMedia } from './library-prepare.js';
import { normalizePrepareLink, prepareDestination, prepareProgressLabel, prepareRecovery, PREPARE_AUTH_ERRORS, VIDEO_PREPARE_SCOPES } from './prepare-flow.js';
import { StdioMcpServer } from './mcp-server.js';
import { ProtocolWriter } from './output.js';
import { checkRecapCapabilities, refreshRecap, RECAP_SCOPES } from './recap.js';
import type {
  AgentActionDefinition,
  AgentEnvelope,
  AgentRunEvent,
  JsonObject,
  StoredCredential,
} from './types.js';
import { isTerminalStatus } from './types.js';
import { CLI_VERSION } from './version.js';

export { CLI_VERSION } from './version.js';

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
  const domains = domainHelp();
  domains.library.push('prepare');
  return {
    name: '@zhicui/cli',
    version: CLI_VERSION,
    usage: 'zhicui <domain> <command> [options]',
    domains,
    generic: [
      'download <url-or-share-text> [--output video.mp4] [--connect]',
      'audio <url-or-share-text> [--output audio.mp3] [--connect] — 提取原声，不分离背景音乐',
      'resolve <url-or-share-text> [--refresh]',
      'recap today|yesterday [--platform douyin|bilibili|all] [--mode like|collect|all] [--limit 50] [--connect] — 先同步，再回顾',
      'run <action_id>',
      'run wait|resume|get|cancel <run_id>',
      'run actions',
      'run describe <action_id>',
      'capabilities --public',
      'library download <note_id> --output <new-file.mp4>',
      'library prepare <url-or-share-text> [--connect] [--output <new-directory>] [--resume]',
      'mcp serve --stdio',
      'agent setup|doctor|status|update|reconcile|uninstall [--client all|codex|claude]',
      'connect [--client codex|claude|all] [--no-open] — 安装连接、确认授权并检查可用工具',
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
  continuation?: { event: (value: JsonObject) => void; complete: (value: JsonObject) => void },
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
      // 校验期间若另一个进程已登录或退出，不能用旧快照覆盖它的决定。
      if (previous) await credentials.saveIfUnchanged(credential, previous);
      else await credentials.deleteIfUnchanged(credential);
      throw error;
    }
    return;
  }

  const scopes = scopesValue
    ? scopesValue.split(',').map((value) => value.trim()).filter(Boolean)
    : await client.defaultDeviceScopes(DEFAULT_DEVICE_SCOPES);
  const authorizationSession = await credentials.beginDeviceAuthorization();
  const started = await client.startDeviceAuthorization(scopes);
  const deviceCode = typeof started.device_code === 'string' ? started.device_code : '';
  const userCode = typeof started.user_code === 'string' ? started.user_code : '';
  const rawVerificationUrl = typeof started.verification_uri_complete === 'string'
    ? started.verification_uri_complete
    : typeof started.verification_uri === 'string'
      ? started.verification_uri
      : '';
  if (!deviceCode || !/^[A-Za-z0-9-]{3,64}$/u.test(userCode) || !rawVerificationUrl) {
    throw new CliError('REMOTE_FAILURE', '设备授权响应字段不完整');
  }
  let parsedVerification: URL;
  try { parsedVerification = new URL(rawVerificationUrl); }
  catch { throw new CliError('REMOTE_FAILURE', '设备授权地址无效'); }
  if (parsedVerification.origin !== new URL(options.apiUrl).origin
    || parsedVerification.username || parsedVerification.password) {
    throw new CliError('REMOTE_FAILURE', '设备授权地址不是当前知萃服务');
  }
  // 只公开用户验证码；不原样输出服务端查询串，避免意外携带机器授权码。
  const publicVerification = new URL(options.apiUrl === 'https://luxai.cn'
    ? '/agent/authorize' : parsedVerification.pathname, options.apiUrl);
  publicVerification.searchParams.set('user_code', userCode);
  const verificationUrl = publicVerification.toString();
  let intervalMs = Math.max(1_000, Math.min(60_000, Number(started.interval || 5) * 1_000));
  const serverExpiry = Math.max(1_000, Math.min(600_000, Number(started.expires_in || 600) * 1_000));
  if (!Number.isFinite(intervalMs) || !Number.isFinite(serverExpiry)) {
    throw new CliError('REMOTE_FAILURE', '设备授权有效期无效');
  }
  const deadline = Date.now() + Math.min(serverExpiry, options.timeoutMs);
  const authorizationEvent: JsonObject = {
    sequence: 1, event: 'device_authorization', status: 'waiting_for_user', terminal: false,
    verification_url: verificationUrl, user_code: userCode,
    expires_at: new Date(deadline).toISOString(), interval_seconds: intervalMs / 1_000, scopes,
  };
  if (continuation) continuation.event(authorizationEvent);
  else if (options.jsonl) writer.event(authorizationEvent);
  writer.diagnostic('请求方：知萃 CLI（当前命令行设备）');
  writer.diagnostic(`请求权限：${scopes.join(', ')}`);
  writer.diagnostic(`请在浏览器确认知萃授权，验证码：${userCode}`);
  writer.diagnostic(`授权地址：${verificationUrl}`);
  if (!noOpen) await openBrowser(verificationUrl).catch(() => undefined);
  while (Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
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
      if (!await credentials.completeDeviceAuthorization(authorizationSession, credential)) {
        throw new CliError('AUTH_REQUIRED', '授权期间登录状态已更改，请重新授权');
      }
      const publicResult = {
        authenticated: true,
        kind: 'device',
        expires_at: credential.expires_at || null,
        scopes: credential.scopes || [],
        store: credentials.store.kind,
      };
      if (continuation) continuation.complete(publicResult);
      else if (options.jsonl) writer.event({
        sequence: 2, event: 'authorization_complete', status: 'succeeded', terminal: true,
        ...publicResult,
      });
      else writer.result(publicResult);
      return;
    } catch (error) {
      const normalized = normalizeUnknownError(error);
      if (normalized.code === 'AUTHORIZATION_PENDING') continue;
      if (normalized.code === 'SLOW_DOWN') {
        intervalMs += 2_000;
        continue;
      }
      if (['HTTP_502', 'HTTP_503', 'HTTP_504', 'NETWORK_ERROR'].includes(normalized.code)) {
        writer.diagnostic('连接暂时中断，正在等待授权服务恢复；无需重新打开授权页。');
        intervalMs = Math.min(15_000, intervalMs + 2_000);
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
  const status = runFromEnvelope(envelope)?.status || envelope.status || 'succeeded';
  return {
    sequence,
    event: status === 'waiting_for_user' ? 'run.waiting_for_user' : 'run.completed',
    status,
    terminal: isTerminalStatus(status),
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
  replayEvents = false,
): Promise<void> {
  const run = runFromEnvelope(envelope);
  const runId = runIdOf(run);
  const status = run?.status || envelope.status;
  if (!runId || (isTerminalStatus(status) && !replayEvents) || status === 'waiting_for_user') {
    if (options.jsonl) writer.event(syntheticTerminal(envelope, afterSequence + 1));
    else writer.result(envelope);
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
      await client.getRun(runId), client, writer, options, true, after, command === 'resume',
    );
    return;
  }
  const wait = takeFlag(args, '--wait');
  const action = await client.describeAction(command);
  const input = await buildActionInput(args, [], action.input_schema);
  if (!action.available && action.execution_location !== 'local_windows') {
    throw new CliError('ACTION_NOT_AVAILABLE', action.unavailable_reason || 'Action 未开放');
  }
  await invokeAction(action, input, options, writer, client, wait);
}

async function fastVideoCommand(domain: string, args: string[], options: GlobalOptions,
  writer: ProtocolWriter, client: AgentApiClient, credentials: CredentialManager): Promise<void> {
  let sequence = 0;
  const complete = (data: JsonObject) => options.jsonl
    ? writer.event({ sequence: ++sequence, event: 'video.completed', terminal: true, status: 'succeeded', data })
    : writer.result(data);
  const output = takeValue(args, '--output');
  const connect = takeFlag(args, '--connect');
  const refresh = takeFlag(args, '--refresh');
  const audioFlag = takeFlag(args, '--audio');
  const kind = domain === 'audio' || audioFlag ? 'audio' : 'video';
  const linkOnly = takeFlag(args, '--link') || domain === 'resolve';
  const value = args.shift();
  if (!value || args.length) throw usageError('用法：zhicui download <链接> [--output 视频.mp4]；提取音频：zhicui audio <链接> [--output 原声.mp3]');
  const url = normalizePrepareLink(value);
  let envelope: AgentEnvelope;
  writer.diagnostic(kind === 'audio' ? '正在获取原声音频入口，不提取文稿…' : '正在获取视频下载入口，不提取文稿…');
  try { envelope = await client.invoke('library.media.resolve', { url, refresh, ...(kind === 'audio' ? {kind} : {}) }); }
  catch (error) {
    if (!connect || !(error instanceof CliError) || !PREPARE_AUTH_ERRORS.has(error.code)) throw error;
    await authCommand(['login', '--scopes', 'library:read'], options, writer, credentials, client, {
      event: (event) => { if (options.jsonl) writer.event({ ...event, sequence: ++sequence, terminal: false }); },
      complete: () => writer.diagnostic('授权完成，继续获取视频。'),
    });
    envelope = await client.invoke('library.media.resolve', { url, refresh, ...(kind === 'audio' ? {kind} : {}) });
  }
  const wrapper = envelope.data as JsonObject;
  const data = (wrapper?.result || wrapper) as JsonObject;
  if (!data || typeof data.media_id !== 'string') throw new CliError('REMOTE_FAILURE', '服务未返回有效下载入口');
  if (kind === 'audio' && data.kind !== 'audio') throw new CliError('ACTION_NOT_AVAILABLE', '当前服务器还不支持音频提取，请更新知萃服务');
  if (linkOnly) {
    complete({ ...data, download_path: `/api/agent-interface/v1/media/${encodeURIComponent(data.media_id)}`,
      authorization: 'Bearer（复用当前知萃凭证）', next_command: ['zhicui', kind === 'audio' ? 'audio' : 'download', url] });
    return;
  }
  writer.diagnostic(`入口已就绪（${data.resolve_ms} ms），${kind === 'audio' ? '正在提取原声 MP3，包含人声与配乐…' : '开始下载视频…'}`);
  const file = output || `zhicui-${String(data.video_id || Date.now()).replace(/[^A-Za-z0-9_-]/gu, '')}.${kind === 'audio' ? 'mp3' : 'mp4'}`;
  let last = 0;
  const result = await downloadLibraryFile(client, 'fast', file, (bytes, total) => {
    if (Date.now() - last < 500 && bytes !== total) return;
    last = Date.now();
    if (options.jsonl) writer.event({ sequence: ++sequence, event: 'download.progress', status: 'running', data: { bytes, total_bytes: total } });
    writer.diagnostic(`已下载 ${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`);
  }, undefined, data.media_id, kind);
  complete({ action: kind === 'audio' ? 'audio.download' : 'video.download', status: 'succeeded', kind, title: data.title, resolve_ms: data.resolve_ms, ...result });
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
    platform: 'status',
    ask: 'conversations',
    analysis: 'catalog',
  };
  const verb = args.shift() || defaults[domain] || 'list';
  if (domain === 'library' && verb === 'prepare') {
    const output = takeValue(args, '--output');
    const resume = takeFlag(args, '--resume');
    const connect = takeFlag(args, '--connect');
    const noOpen = takeFlag(args, '--no-open');
    const value = args.shift();
    if (!value || args.length) {
      throw usageError('用法：zhicui library prepare <链接或分享文字> [--connect] [--output <目录>] [--resume]');
    }
    const url = normalizePrepareLink(value);
    let sequence = 0;
    const progress = (stage: string, data: JsonObject) => {
      const message = prepareProgressLabel(stage, data);
      if (options.jsonl) writer.event({ sequence: ++sequence, event: `prepare.${stage}`, status: 'running', message, data });
      else writer.diagnostic(message);
    };
    const destination = await prepareDestination(url, options.apiUrl, options.profile, output, resume);
    try {
      progress('check', {});
      try { await checkPrepareCapabilities(client); }
      catch (error) {
        if (!connect || !(error instanceof CliError) || !PREPARE_AUTH_ERRORS.has(error.code)) throw error;
        writer.diagnostic('准备视频需要读取和整理资料的权限。请在浏览器确认一次，完成后自动继续当前任务。');
        await authCommand(['login', '--scopes', VIDEO_PREPARE_SCOPES.join(','), ...(noOpen ? ['--no-open'] : [])], options, writer, credentials, client, {
          event: (event) => { if (options.jsonl) writer.event({ ...event, sequence: ++sequence, terminal: false }); },
          complete: (data) => {
            if (options.jsonl) writer.event({ sequence: ++sequence, event: 'authorization_complete', status: 'succeeded', terminal: false, ...data });
            else writer.diagnostic('连接已完成，继续准备视频。');
          },
        });
      }
      if (destination.resume) writer.diagnostic('已找到原任务，校验并复用已完成的步骤。');
      const result = await prepareLibraryMedia(client, { url, ...destination, timeoutMs: options.timeoutMs,
        idempotencyKey: options.idempotencyKey }, progress);
      if (options.jsonl) writer.event({ sequence: ++sequence, event: 'prepare.completed', terminal: true, status: 'succeeded', data: result });
      else writer.result(result);
    } catch (error) {
      const saved = await stat(resolve(destination.output, '.zhicui-prepare.json')).then(() => true).catch(() => false);
      throw prepareRecovery(normalizeUnknownError(error), { url, output: destination.output, resume: saved, profile: options.profile });
    }
    return;
  }
  if (domain === 'library' && verb === 'download') {
    const output = takeValue(args, '--output');
    const noteId = args.shift();
    if (!noteId || !output || args.length) {
      throw usageError('用法：zhicui library download <note_id> --output <新文件.mp4>');
    }
    let lastProgress = 0;
    let sequence = 0;
    const downloaded = await downloadLibraryFile(client, noteId, output, (bytes, totalBytes) => {
      if (Date.now() - lastProgress < 1_000 && bytes !== totalBytes) return;
      lastProgress = Date.now();
      if (options.jsonl) writer.event({
        sequence: ++sequence, event: 'download.progress', status: 'running',
        data: { bytes, total_bytes: totalBytes },
      });
      else writer.diagnostic(`视频下载：${(bytes / 1024 / 1024).toFixed(1)} MB${totalBytes ? ` / ${(totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}`);
    });
    const result = { action: 'library.media.download', status: 'succeeded', note_id: noteId, ...downloaded };
    if (options.jsonl) writer.event({
      sequence: ++sequence, event: 'download.completed', terminal: true, status: 'succeeded', data: result,
    });
    else writer.result(result);
    return;
  }
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
  let resolved;
  try {
    resolved = resolveDomainAction(capabilities, domain, verb);
  } catch (error) {
    // 能力清单按凭据权限过滤；区分未开放与未授权，不把权限不足报成远端故障。
    if (error instanceof CliError && error.code === 'ACTION_NOT_AVAILABLE') {
      const candidate = aliasFor(domain, verb).candidates[0];
      const descriptor = await client.describeAction(candidate).catch(() => null);
      if (descriptor?.available && !capabilities.actions.some((item) => item.id === descriptor.id)) {
        throw new CliError('SCOPE_DENIED', `当前授权缺少 ${descriptor.title} 所需权限，请重新授权对应 scope`, {
          details: { required_scopes: descriptor.scopes },
        });
      }
    }
    throw error;
  }
  const { action, alias } = resolved;
  const input = await buildActionInput(args, alias.positionalKeys, action.input_schema);
  await invokeAction(action, input, options, writer, client, wait, capabilities.user_hash);
}

async function agentCommand(
  args: string[],
  options: GlobalOptions,
  writer: ProtocolWriter,
  credentials: CredentialManager,
  receiveResult?: (value: Record<string, unknown>) => void,
): Promise<void> {
  const command = args.shift() || 'status';
  const selection = clientSelection(takeValue(args, '--client'));
  if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
  const manager = new AgentClientManager(options.timeoutMs);
  if (command === 'setup') writer.result(await manager.setup(selection));
  else if (command === 'update') writer.result(await manager.update(selection));
  else if (command === 'reconcile') writer.result(await manager.reconcile(selection));
  else if (command === 'uninstall') writer.result(await manager.uninstall(selection));
  else if (command === 'status') writer.result(await manager.status(selection));
  else if (command === 'doctor') {
    const configuration = await manager.doctor(selection);
    const client = clientFor(options, credentials);
    let credential: Record<string, unknown>;
    let errorCode: string | null = null;
    try { credential = await credentials.status(); }
    catch (error) { credential = { authenticated: false }; errorCode = normalizeUnknownError(error).code; }
    let authenticated = false;
    let cloudAvailable = false;
    let serviceAvailable = false;
    let expectedUserHash: string | null = null;
    let actions = 0;
    let featureEnabled = false;
    if (credential.authenticated === true) {
      try {
        const capabilities = await client.capabilities();
        authenticated = true;
        serviceAvailable = true;
        featureEnabled = capabilities.feature_enabled !== false;
        cloudAvailable = featureEnabled;
        expectedUserHash = capabilities.user_hash || null;
        actions = capabilities.actions.filter((action) => action.available && action.mcp_exposed && !action.secure_direct).length;
        if (!featureEnabled) errorCode = 'INTERFACE_DISABLED';
        else if (!actions) errorCode = 'TOOLS_UNAVAILABLE';
      } catch (error) { errorCode = normalizeUnknownError(error).code; }
    } else errorCode ||= 'AUTH_REQUIRED';
    if (!serviceAvailable) serviceAvailable = await client.serviceHealth().catch(() => false);
    const mcp = authenticated && featureEnabled && actions > 0
      ? await manager.mcpHealth(options.profile, options.apiUrl)
      : { ok: false, tool_count: 0, code: 'NOT_CHECKED' };
    const checks = (configuration.checks as Record<string, unknown>[]).map((check) => {
      const configured = check.configured === true;
      const configurationReady = check.ok === true;
      const ready = configurationReady && authenticated && cloudAvailable && mcp.ok;
      const configurationCode = check.migration_available === true ? 'AGENT_UPDATE_REQUIRED'
        : check.configured === true && check.managed !== true ? 'AGENT_CONFIG_CONFLICT' : 'CONFIGURATION_REQUIRED';
      return { ...check, configured, configuration_ready: configurationReady, authenticated, cloud_available: cloudAvailable,
        mcp_healthy: mcp.ok, ready, ok: ready,
        code: ready ? 'READY' : !configurationReady ? configurationCode : errorCode || mcp.code };
    });
    const configured = checks.every((check) => check.configured);
    const configurationReady = checks.every((check) => check.configuration_ready);
    const ready = checks.every((check) => check.ready);
    const report = {
      ...configuration, checks, ok: ready, ready, configured, configuration_ready: configurationReady, authenticated,
      cloud_available: cloudAvailable, service_available: serviceAvailable, mcp_healthy: mcp.ok,
      code: ready ? 'READY' : !configurationReady ? checks.find((check) => !check.configuration_ready)?.code : errorCode || mcp.code,
      credential: { ...credential, authenticated, present: credential.authenticated === true, valid: authenticated },
      authorization: { verified: authenticated, code: errorCode },
      cloud: { available: cloudAvailable, service_available: serviceAvailable, feature_enabled: featureEnabled, actions },
      mcp,
      local: {
        ...await new RestrictedLocalAdapter().status(expectedUserHash),
        account_binding_verified: Boolean(expectedUserHash),
      },
    };
    if (receiveResult) receiveResult(report);
    else writer.result(report);
  } else throw usageError(`未知 agent 命令：${command}`);
}

async function connectCommand(args: string[], options: GlobalOptions, writer: ProtocolWriter,
  credentials: CredentialManager, client: AgentApiClient): Promise<void> {
  const selection = clientSelection(takeValue(args, '--client') || 'codex');
  const noOpen = takeFlag(args, '--no-open');
  if (args.length) throw usageError(`多余参数：${args.join(' ')}`);
  // MCP 的受管注册使用默认凭据；不把另一个 profile 的成功检查误报为默认连接成功。
  if (options.profile !== 'default') throw usageError('一键接入使用默认配置，请用 --profile default；其他配置可继续单独使用 CLI');
  let sequence = 0;
  const stage = (name: string, message: string) => {
    writer.diagnostic(message);
    if (options.jsonl) writer.event({ sequence: ++sequence, event: `connect.${name}`, status: 'running', terminal: false });
  };
  stage('setup', '1/3 安装并检查 Agent 连接…');
  const setup = await new AgentClientManager(options.timeoutMs).setup(selection);
  for (const [name, value] of Object.entries(setup)) {
    if (!(value as Record<string, unknown>).installed) {
      throw new CliError('AGENT_NOT_INSTALLED', `请先安装 ${name === 'codex' ? 'Codex' : 'Claude Code'}，然后重新运行 zhicui connect`, { exitCode: EXIT_CODES.localUnavailable });
    }
  }
  stage('authorization', '2/3 检查知萃授权…');
  try { await client.capabilities(); }
  catch (error) {
    if (!(error instanceof CliError) || !PREPARE_AUTH_ERRORS.has(error.code)) throw error;
    await authCommand(['login', '--scopes', 'account:read,library:read,ask:read,ask:run', ...(noOpen ? ['--no-open'] : [])], options, writer, credentials, client, {
      event: value => { if (options.jsonl) writer.event({ ...value, sequence: ++sequence, terminal: false }); },
      complete: () => writer.diagnostic('授权完成，继续检查。'),
    });
  }
  stage('verify', '3/3 验证云端与 MCP 工具…');
  let report: Record<string, unknown> = {};
  await agentCommand(['doctor', '--client', selection], options, writer, credentials, value => { report = value; });
  if (report.ready !== true) throw new CliError(String(report.code || 'AGENT_SETUP_FAILED'), '连接尚未就绪，请运行 zhicui agent doctor 查看具体原因');
  writer.diagnostic('连接成功。回到 Agent 重新连接知萃 MCP，即可使用视频下载和问答。');
  const result = { ...report, setup, next_command: 'zhicui download "视频链接"', reconnect_agent: true };
  if (options.jsonl) writer.event({ sequence: ++sequence, event: 'connect.completed', terminal: true, status: 'succeeded', data: result as JsonObject });
  else writer.result(result);
}

async function recapCommand(args: string[], options: GlobalOptions, writer: ProtocolWriter,
  credentials: CredentialManager, client: AgentApiClient): Promise<void> {
  const connect = takeFlag(args, '--connect');
  const noOpen = takeFlag(args, '--no-open');
  const platform = takeValue(args, '--platform') || 'all';
  const mode = takeValue(args, '--mode') || 'like';
  const timezone = takeValue(args, '--timezone') || 'Asia/Shanghai';
  const limit = positiveInteger(takeValue(args, '--limit'), 50);
  const day = args.shift() || 'yesterday';
  if (args.length || !['today', 'yesterday'].includes(day) || !['douyin', 'bilibili', 'all'].includes(platform)
      || !['like', 'collect', 'all'].includes(mode) || limit < 1 || limit > 100) {
    throw usageError('用法：zhicui recap yesterday|today --platform douyin|bilibili|all --mode like|collect|all --limit 1–100');
  }
  let sequence = 0;
  try { await checkRecapCapabilities(client); }
  catch (error) {
    if (!connect || !(error instanceof CliError) || !PREPARE_AUTH_ERRORS.has(error.code)) throw error;
    await authCommand(['login', '--scopes', RECAP_SCOPES.join(','), ...(noOpen ? ['--no-open'] : [])], options, writer, credentials, client, {
      event: event => { if (options.jsonl) writer.event({ ...event, sequence: ++sequence, terminal: false }); },
      complete: () => writer.diagnostic('授权完成，开始同步回顾。'),
    });
  }
  const data = await refreshRecap(client, { day, platform, mode, timezone, limit, timeoutMs: options.timeoutMs }, (stage, info) => {
    writer.diagnostic(`${stage} · ${info.platform || day}${info.mode ? ` · ${info.mode}` : ''}${info.message ? ` · ${info.message}` : ''}`);
    if (options.jsonl) writer.event({ sequence: ++sequence, event: stage, terminal: false,
      status: info.status === 'waiting_for_user' ? 'waiting_for_user' : 'running', data: info });
  });
  if (options.jsonl) writer.event({ sequence: ++sequence, event: 'recap.completed', terminal: true, status: 'succeeded', data });
  else writer.result(data);
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
    if (!['capabilities', 'resolve', 'download', 'audio', 'connect', 'recap'].includes(domain) && !USER_COMMAND_DOMAINS.includes(domain as (typeof USER_COMMAND_DOMAINS)[number])) {
      throw usageError(`未知命令域：${domain}`);
    }
    if (command.includes('--help') || command.includes('-h')) {
      const verb = command.find((item) => !['--help', '-h'].includes(item));
      const entries = domainAliasEntries().filter(([key]) =>
        key !== 'library.download' && key.startsWith(`${domain}.`) && (!verb || key === `${domain}.${verb}`),
      );
      writer.result({
        domain,
        commands: [...(['audio', 'download', 'resolve'].includes(domain) ? [{command: `zhicui ${domain} <链接> [--audio] [--output ${domain === 'audio' ? '原声.mp3' : '视频.mp4'}] [--connect]`, description: 'audio 提取原声 MP3，包含人声与配乐；--link 只取入口，--refresh 刷新地址。'}] : []), ...entries.map(([key, alias]) => ({
          command: `zhicui ${key.replace('.', ' ')} ${(alias.positionalKeys || []).map((value) => `<${value}>`).join(' ')}`.trim(),
          action: alias.candidates[0],
          named_inputs: alias.namedInputKeys || [],
        })), ...(domain === 'library' && (!verb || verb === 'download') ? [{
          command: 'zhicui library download <note_id> --output <new-file.mp4>',
          endpoint: 'GET /api/agent-interface/v1/library/{note_id}/media',
          scopes: ['library:read'],
          description: '流式下载到新文件；不覆盖、不跟随跳转，完成后返回大小和 SHA-256。',
        }] : []), ...(domain === 'library' && (!verb || verb === 'prepare') ? [{
          command: 'zhicui library prepare <url-or-share-text> [--connect] [--output <new-directory>] [--resume]',
          scopes: ['library:read', 'library:write'],
          description: '导入、提取文稿、下载视频并写入素材清单；--resume 接续原目录中的任务。',
        }] : [])],
        schema: '登录后可运行 zhicui run describe <action_id> --json 查看参数、权限和确认要求。',
        input: '命名参数使用 --field-name；数组/对象传入 JSON，或通过 stdin 输入完整 JSON 对象。',
        async: '长任务可加 --wait 或 --jsonl；重试同一操作时使用相同 --idempotency-key。',
        ...(!entries.length ? { help: helpPayload() } : {}),
      });
      return EXIT_CODES.success;
    }
    const credentials = new CredentialManager(options.profile, options.apiUrl);
    const client = clientFor(options, credentials);
    if (domain === 'capabilities') {
      if (!takeFlag(command, '--public') || command.length) throw usageError('用法：zhicui capabilities --public');
      writer.result(await client.publicCapabilities());
    }
    else if (domain === 'connect') await connectCommand(command, options, writer, credentials, client);
    else if (domain === 'recap') await recapCommand(command, options, writer, credentials, client);
    else if (domain === 'resolve' || domain === 'download' || domain === 'audio') await fastVideoCommand(domain, command, options, writer, client, credentials);
    else if (domain === 'auth') await authCommand(command, options, writer, credentials, client);
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
