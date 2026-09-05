import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT_CODES } from './errors.js';
import type { AgentActionDefinition, AgentEnvelope, JsonObject } from './types.js';

const ALLOWED_LOCAL_ACTIONS = new Set([
  'local.status',
  'local.capabilities.get',
  'local.platform.login',
  'local.platform.status',
  'local.platform.sync',
  'local.platform.collect',
  'local.platform.cancel',
  'local.platform.disconnect',
  'local.platform.logout',
  'local.platform.rebind',
  'local.media.settings.get',
  'local.media.directory.choose',
  'local.media.delete',
  'local.media.open',
  'local.client.update.check',
  'local.client.update.install',
  'local.update.check',
  'local.update.install',
]);

const EMPTY_INPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

const PLATFORM_INPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    platform: { type: 'string', enum: ['douyin', 'bilibili', 'xiaohongshu'] },
  },
  required: ['platform'],
  additionalProperties: false,
};

const COLLECT_INPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    ...(PLATFORM_INPUT_SCHEMA.properties as JsonObject),
    mode: { type: 'string', enum: ['like', 'collect', 'post'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['platform', 'mode', 'limit'],
  additionalProperties: false,
};

const MEDIA_INPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    aweme_id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9_-]+$',
    },
  },
  required: ['aweme_id'],
  additionalProperties: false,
};

/**
 * 本机工具的公开 Schema 必须与桌面桥的固定白名单保持一致，不能信任
 * 远端 capabilities 对本机 IPC 的描述。这样即使服务端版本漂移，MCP 也
 * 不会向 Agent 宣告桌面端不接受的字段（尤其是任意命令、路径或密钥）。
 */
export function trustedLocalInputSchema(actionId: string): JsonObject | null {
  if (['local.status', 'local.capabilities.get', 'local.platform.cancel',
    'local.media.settings.get', 'local.media.directory.choose',
    'local.update.check', 'local.client.update.check',
    'local.update.install', 'local.client.update.install'].includes(actionId)) {
    return EMPTY_INPUT_SCHEMA;
  }
  if (['local.platform.login', 'local.platform.status',
    'local.platform.disconnect', 'local.platform.logout',
    'local.platform.rebind'].includes(actionId)) {
    return PLATFORM_INPUT_SCHEMA;
  }
  if (['local.platform.sync', 'local.platform.collect'].includes(actionId)) {
    return COLLECT_INPUT_SCHEMA;
  }
  if (['local.media.open', 'local.media.delete'].includes(actionId)) {
    return MEDIA_INPUT_SCHEMA;
  }
  return null;
}

export function isAllowedLocalAction(actionId: string): boolean {
  return ALLOWED_LOCAL_ACTIONS.has(actionId);
}

interface DesktopBridgeDescriptor {
  api_version: 'v1';
  url: string;
  token: string;
  user_hash: string;
  expires_at: string;
}

function descriptorPath(): string {
  if (process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR) {
    return process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR;
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Zhicui', 'desktop-agent-bridge.json');
  }
  const root = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR || join(homedir(), '.cache');
  return join(root, 'Zhicui', 'desktop-agent-bridge.json');
}

function validateDescriptor(value: unknown): DesktopBridgeDescriptor {
  const item = value as Partial<DesktopBridgeDescriptor> | null;
  if (
    !item
    || item.api_version !== 'v1'
    || !item.url
    || !item.token
    || !item.user_hash
    || !/^[a-f0-9]{64}$/u.test(item.user_hash)
    || !item.expires_at
  ) {
    throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '桌面端本机能力描述无效', {
      exitCode: EXIT_CODES.localUnavailable,
    });
  }
  const url = new URL(item.url);
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '桌面端桥接地址不是受信本机地址', {
      exitCode: EXIT_CODES.localUnavailable,
    });
  }
  if (Date.parse(item.expires_at) <= Date.now()) {
    throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '桌面端桥接会话已过期', {
      exitCode: EXIT_CODES.localUnavailable,
    });
  }
  return item as DesktopBridgeDescriptor;
}

function assertSameUser(expectedUserHash: string | null | undefined, actualUserHash: string): void {
  if (!expectedUserHash || !/^[a-f0-9]{64}$/u.test(expectedUserHash)) {
    throw new CliError('AUTHENTICATION_REQUIRED', '调用本机能力前请先登录知萃 CLI', {
      exitCode: EXIT_CODES.authentication,
    });
  }
  const expected = Buffer.from(expectedUserHash, 'ascii');
  const actual = Buffer.from(actualUserHash, 'ascii');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new CliError(
      'LOCAL_USER_MISMATCH',
      '知萃 CLI 与桌面端当前登录账号不一致，请切换为同一账号后重试',
      { exitCode: EXIT_CODES.permission },
    );
  }
}

export class RestrictedLocalAdapter {
  async status(expectedUserHash?: string | null): Promise<Record<string, unknown>> {
    if (!['win32', 'darwin'].includes(process.platform)) {
      return { available: false, code: 'UNSUPPORTED_PLATFORM', platform: process.platform };
    }
    try {
      const descriptor = await this.readDescriptor();
      if (expectedUserHash !== undefined) assertSameUser(expectedUserHash, descriptor.user_hash);
      return { available: true, api_version: descriptor.api_version };
    } catch (error) {
      const code = error instanceof CliError ? error.code : 'DESKTOP_BRIDGE_UNAVAILABLE';
      return { available: false, code, platform: process.platform };
    }
  }

  async invoke(
    action: AgentActionDefinition,
    input: JsonObject,
    timeoutMs: number,
    idempotencyKey?: string,
    expectedUserHash?: string | null,
  ): Promise<AgentEnvelope> {
    if (!isAllowedLocalAction(action.id)) {
      throw new CliError('ACTION_NOT_ALLOWED', '该本机 Action 不在知萃固定白名单中', {
        exitCode: EXIT_CODES.permission,
      });
    }
    if (!['win32', 'darwin'].includes(process.platform)) {
      throw new CliError('UNSUPPORTED_PLATFORM', '该 Action 需要知萃 Windows 或 Mac 客户端', {
        exitCode: EXIT_CODES.localUnavailable,
      });
    }
    const descriptor = await this.readDescriptor();
    assertSameUser(expectedUserHash, descriptor.user_hash);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(
        `${descriptor.url.replace(/\/$/u, '')}/v1/actions/${encodeURIComponent(action.id)}/invoke`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${descriptor.token}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        },
      );
      const payload = await response.json() as AgentEnvelope;
      if (!response.ok) {
        const error = payload.error;
        throw new CliError(
          typeof error === 'object' && error ? error.code : 'DESKTOP_BRIDGE_UNAVAILABLE',
          typeof error === 'object' && error ? error.message : '桌面端本机 Action 调用失败',
          { exitCode: EXIT_CODES.localUnavailable },
        );
      }
      if (payload.error) {
        const error = payload.error;
        throw new CliError(
          typeof error === 'object' ? error.code : 'DESKTOP_BRIDGE_UNAVAILABLE',
          typeof error === 'object' ? error.message : error,
          { exitCode: EXIT_CODES.localUnavailable },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CliError('TIMEOUT', '本机 Action 超时', {
          exitCode: EXIT_CODES.timeoutOrCanceled,
        });
      }
      throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '无法连接知萃桌面端本机能力', {
        exitCode: EXIT_CODES.localUnavailable,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readDescriptor(): Promise<DesktopBridgeDescriptor> {
    try {
      return validateDescriptor(JSON.parse(await readFile(descriptorPath(), 'utf8')));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'DESKTOP_BRIDGE_UNAVAILABLE',
        '未检测到正在运行且已登录的知萃桌面客户端',
        { exitCode: EXIT_CODES.localUnavailable, cause: error },
      );
    }
  }
}
