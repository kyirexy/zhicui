import { usageError } from './errors.js';

export interface GlobalOptions {
  json: boolean;
  jsonl: boolean;
  nonInteractive: boolean;
  quiet: boolean;
  timeoutMs: number;
  idempotencyKey?: string;
  apiUrl: string;
  profile: string;
}

export interface ParsedInvocation {
  options: GlobalOptions;
  command: string[];
}

const SECRET_ARG_NAMES = new Set([
  'token',
  'pat',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secret',
  'password',
  'cookie',
  'jwt',
  'authorization',
]);

const PRODUCTION_API_URL = 'https://luxai.cn';

function developerEndpointEnabled(): boolean {
  return process.env.ZHICUI_CLI_DEV === '1';
}

function isSecretArgument(value: string): boolean {
  if (!value.startsWith('--')) return false;
  const flagName = value.split('=', 1)[0].slice(2).toLowerCase().replace(/[-_]/gu, '');
  return SECRET_ARG_NAMES.has(flagName);
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/u.exec(value.trim());
  if (!match) throw usageError(`无效的 --timeout：${value}`);
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 100 || result > 86_400_000) {
    throw usageError('--timeout 必须在 100ms 到 24h 之间');
  }
  return result;
}

function readOptionValue(
  argv: string[],
  index: number,
  current: string,
): { value: string; consumed: number } {
  const equals = current.indexOf('=');
  if (equals >= 0) return { value: current.slice(equals + 1), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw usageError(`${current} 需要一个值`);
  }
  return { value, consumed: 1 };
}

export function parseInvocation(argv: string[]): ParsedInvocation {
  const configuredApiUrl = process.env.ZHICUI_API_URL || PRODUCTION_API_URL;
  const options: GlobalOptions = {
    json: false,
    jsonl: false,
    nonInteractive: false,
    quiet: false,
    timeoutMs: 120_000,
    apiUrl: configuredApiUrl,
    profile: process.env.ZHICUI_PROFILE || 'default',
  };
  const command: string[] = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (passthrough) {
      if (isSecretArgument(item)) {
        throw usageError(`${item.split('=', 1)[0]} 禁止通过命令参数传入；请使用设备授权或无回显 stdin`);
      }
      command.push(item);
      continue;
    }
    if (item === '--') {
      passthrough = true;
      continue;
    }
    const flagName = item.split('=', 1)[0];
    if (isSecretArgument(item)) {
      throw usageError(`${flagName} 禁止通过命令参数传入；请使用设备授权或无回显 stdin`);
    }
    if (item === '--json') options.json = true;
    else if (item === '--jsonl') options.jsonl = true;
    else if (item === '--non-interactive') options.nonInteractive = true;
    else if (item === '--quiet') options.quiet = true;
    else if (flagName === '--timeout') {
      const parsed = readOptionValue(argv, index, item);
      options.timeoutMs = parseDuration(parsed.value);
      index += parsed.consumed;
    } else if (flagName === '--idempotency-key') {
      const parsed = readOptionValue(argv, index, item);
      options.idempotencyKey = parsed.value.trim();
      if (!options.idempotencyKey || options.idempotencyKey.length > 200) {
        throw usageError('--idempotency-key 长度必须为 1–200');
      }
      index += parsed.consumed;
    } else if (flagName === '--api-url') {
      if (!developerEndpointEnabled()) {
        throw usageError('--api-url 仅供显式本机开发模式使用；正式 CLI 固定连接 https://luxai.cn');
      }
      const parsed = readOptionValue(argv, index, item);
      options.apiUrl = parsed.value;
      index += parsed.consumed;
    } else if (flagName === '--profile') {
      const parsed = readOptionValue(argv, index, item);
      options.profile = parsed.value;
      index += parsed.consumed;
    } else {
      command.push(item);
    }
  }

  if (options.json && options.jsonl) {
    throw usageError('--json 与 --jsonl 不能同时使用');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(options.profile)) {
    throw usageError('--profile 只允许字母、数字、点、下划线和短横线');
  }
  try {
    const url = new URL(options.apiUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password) {
      throw usageError('--api-url 不得包含用户名或密码');
    }
    if (url.search || url.hash) {
      throw usageError('--api-url 不得包含查询参数或片段');
    }
    const normalized = url.toString().replace(/\/$/u, '');
    if (normalized !== PRODUCTION_API_URL) {
      if (!developerEndpointEnabled() || !local || !['http:', 'https:'].includes(url.protocol)) {
        throw usageError('正式 CLI 只连接 https://luxai.cn；开发模式也只允许 localhost/127.0.0.1/[::1]');
      }
    }
    options.apiUrl = normalized;
  } catch (error) {
    if (error instanceof Error && error.name === 'CliError') throw error;
    throw usageError(`无效的 --api-url：${options.apiUrl}`);
  }
  return { options, command };
}
