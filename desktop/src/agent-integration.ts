import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DesktopAgentClient,
  DesktopAgentClientStatus,
  DesktopAgentIntegrationOverview,
  DesktopAgentIntegrationRequest,
  DesktopAgentIntegrationResult,
} from './contract';

const MAX_OUTPUT_BYTES = 512 * 1024;
const ACTION_TIMEOUT_MS = 120_000;

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
    .replace(/((?:cookie|jwt|api[_-]?key|token))\s*[=:]\s*[^\s;,]+/gi, '$1=[已隐藏]')
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

function normalizeCliResult(
  request: DesktopAgentIntegrationRequest,
  processResult: CliProcessResult,
): DesktopAgentIntegrationResult {
  const payload = parseCliPayload(processResult.stdout);
  const data = record(payload.data);
  const nestedResult = record(data.result);
  const directClient = record(payload[request.client]);
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
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
      : stringValue(error.code, payload.code)
        || (success ? 'OK' : `CLI_EXIT_${processResult.exitCode}`),
    message,
    installed: boolValue(source.installed, data.installed),
    configured: boolValue(source.configured, source.connected, data.configured),
    version: stringValue(source.version, data.version),
    diagnostics,
  };
}

export class DesktopAgentIntegration {
  constructor(
    private readonly cliEntry: () => string,
    private readonly executable = process.execPath,
  ) {}

  getCliEntry(): string {
    return this.cliEntry();
  }

  isCliAvailable(): boolean {
    return existsSync(this.getCliEntry());
  }

  async status(): Promise<DesktopAgentIntegrationOverview> {
    if (!this.isCliAvailable()) {
      return {
        available: false,
        cli_available: false,
        clients: [],
        code: 'CLI_UNAVAILABLE',
        message: '当前安装包没有找到内置 CLI，请更新桌面客户端',
      };
    }
    const clients = await Promise.all(
      (['codex', 'claude'] as const).map(async (client) => {
        const result = await this.run({ client, operation: 'status' });
        return this.clientStatus(client, result);
      }),
    );
    return {
      available: true,
      cli_available: true,
      clients,
      message: clients.some((client) => client.configured)
        ? '本机 Agent 接入可用'
        : '已找到内置 CLI，尚未连接 Agent',
    };
  }

  async run(
    request: DesktopAgentIntegrationRequest,
  ): Promise<DesktopAgentIntegrationResult> {
    if (!this.isCliAvailable()) {
      return {
        success: false,
        client: request.client,
        operation: request.operation,
        code: 'CLI_UNAVAILABLE',
        message: '当前安装包没有找到内置 CLI，请更新桌面客户端',
      };
    }
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
    return normalizeCliResult(request, processResult);
  }

  private clientStatus(
    client: DesktopAgentClient,
    result: DesktopAgentIntegrationResult,
  ): DesktopAgentClientStatus {
    return {
      client,
      installed: Boolean(result.installed),
      configured: Boolean(result.configured),
      version: result.version,
      message: result.message,
    };
  }

  private execute(args: string[]): Promise<CliProcessResult> {
    return new Promise((resolve) => {
      execFile(
        this.executable,
        args,
        {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: ACTION_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NO_COLOR: '1',
          },
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
    });
  }
}
