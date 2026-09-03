import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AgentApiClient } from './api-client.js';
import { CliError, normalizeUnknownError } from './errors.js';
import {
  isAllowedLocalAction,
  RestrictedLocalAdapter,
  trustedLocalInputSchema,
} from './local-adapter.js';
import type { AgentActionDefinition, AgentEnvelope, JsonObject } from './types.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

const RUN_TOOL_NAMES = {
  get: 'zhicui_run_get',
  events: 'zhicui_run_events',
  cancel: 'zhicui_run_cancel',
} as const;

function runTools(includeCancel: boolean): McpTool[] {
  const runId = { type: 'string', minLength: 1, maxLength: 64 } as JsonObject;
  const tools: McpTool[] = [
    {
      name: RUN_TOOL_NAMES.get,
      title: '读取知萃运行',
      description: '读取当前账号拥有的 Product Action 长任务状态。',
      inputSchema: {
        type: 'object', properties: { run_id: runId }, required: ['run_id'], additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: RUN_TOOL_NAMES.events,
      title: '读取知萃运行事件',
      description: '从指定序号后读取当前账号拥有的 Product Action 事件，用于恢复或继续长任务。',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: runId,
          after: { type: 'integer', minimum: 0, maximum: 2147483647 },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
  if (includeCancel) tools.push({
      name: RUN_TOOL_NAMES.cancel,
      title: '取消知萃运行',
      description: '取消当前账号拥有的 Product Action 长任务。',
      inputSchema: {
        type: 'object', properties: { run_id: runId }, required: ['run_id'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  });
  return tools;
}

const FORBIDDEN_ACTION_PARTS = [
  'admin',
  'shell',
  'database',
  'cookie',
  'jwt',
  'api_key',
  'apikey',
  'internal',
  'research_tool',
];
const ALLOWED_ACTION_DOMAINS = new Set([
  'account',
  'library',
  'creator',
  'ask',
  'knowledge',
  'plan',
  'automation',
  'analysis',
  'models',
  'feedback',
  'local',
]);
const ALLOWED_SCOPES = new Set([
  'account:read',
  'account:manage',
  'library:read',
  'library:write',
  'creator:read',
  'creator:sync',
  'ask:read',
  'ask:run',
  'knowledge:read',
  'knowledge:write',
  'plan:read',
  'plan:write',
  'automation:read',
  'automation:write',
  'analysis:read',
  'analysis:run',
  'models:read',
  'models:write',
  'feedback:read',
  'feedback:write',
  'local:invoke',
]);
const SECRET_PROPERTY_NAMES = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'clientsecret',
  'cookie',
  'jwt',
  'pat',
  'secret',
  'authorization',
  'credential',
  'privatekey',
]);
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

function schemaAcceptsSecret(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => schemaAcceptsSecret(item, seen));
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, schema] of Object.entries(properties)) {
      const normalized = name.toLowerCase().replace(/[-_\s]+/gu, '');
      if (SECRET_PROPERTY_NAMES.has(normalized) || schemaAcceptsSecret(schema, seen)) return true;
    }
  }
  return [
    'allOf', 'anyOf', 'oneOf', 'items', 'prefixItems', '$defs', 'definitions',
    'dependentSchemas', 'patternProperties', 'additionalProperties', 'contains',
    'if', 'then', 'else', 'not', 'propertyNames', 'unevaluatedProperties',
  ]
    .some((key) => schemaAcceptsSecret(record[key], seen));
}

function normalizedPropertyName(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/gu, '');
}

function secretPropertyName(value: string): boolean {
  return SECRET_PROPERTY_NAMES.has(normalizedPropertyName(value));
}

function payloadContainsSecret(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => payloadContainsSecret(item, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    secretPropertyName(key) || payloadContainsSecret(item, seen)
  ));
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer <redacted>')
    .replace(/\bzhc_(?:pat|access|refresh)_[A-Za-z0-9._~-]+\b/giu, '<redacted>')
    .replace(/(?:pat|token|secret|api[_-]?key|password|cookie|jwt|authorization)\s*[=:]\s*\S+/giu, '<redacted>');
}

function redactSecretValues(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (!value || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached) return cached;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(redactSecretValues(item, seen));
    return output;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = secretPropertyName(key) ? '<redacted>' : redactSecretValues(item, seen);
  }
  return output;
}

function safeAction(action: AgentActionDefinition): boolean {
  const id = action.id.toLowerCase();
  const domain = id.split(/[._]/u, 1)[0];
  const secretConfigurationAction = /^models[._](?:secret|custom|vision)[._](?:create|update|test)$/u.test(id);
  return action.mcp_exposed !== false
    && action.secure_direct !== true
    && ALLOWED_ACTION_DOMAINS.has(domain)
    && !FORBIDDEN_ACTION_PARTS.some((part) => id.includes(part))
    && !secretConfigurationAction
    && action.scopes.length > 0
    && action.scopes.every((scope) => ALLOWED_SCOPES.has(scope.toLowerCase()))
    && !schemaAcceptsSecret(action.input_schema);
}

function toolBaseName(actionId: string): string {
  const normalized = `zhicui_${actionId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_|_$/gu, '');
  return normalized.slice(0, 96) || 'zhicui_action';
}

function destructive(action: AgentActionDefinition): boolean {
  const risk = typeof action.risk === 'string'
    ? action.risk
    : JSON.stringify(action.risk || {});
  return /destructive|delete|注销|删除|install_update/iu.test(`${risk} ${action.id}`);
}

function readonly(action: AgentActionDefinition): boolean {
  return /(?:^|\.)(?:get|list|status|describe|capabilities)(?:\.|$)/u.test(action.id)
    || action.scopes.every((scope) => scope.endsWith(':read'));
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export class StdioMcpServer {
  private readonly local = new RestrictedLocalAdapter();
  private readonly processNonce = randomUUID();
  private actions = new Map<string, AgentActionDefinition>();
  private activeRunToolNames = new Set<string>();
  private currentUserHash: string | null = null;

  constructor(private readonly client: AgentApiClient) {}

  async serve(): Promise<void> {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.write(rpcError(null, -32700, 'Parse error'));
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.write(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const request = parsed as JsonRpcRequest;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        this.write(rpcError(request.id, -32600, 'Invalid Request'));
        continue;
      }
      if (request.id === undefined) {
        // MCP notifications are acknowledged by absence of a response.
        continue;
      }
      try {
        this.write(rpcResult(request.id, await this.handle(request.method, request.params, request.id)));
      } catch (error) {
        const normalized = normalizeUnknownError(error);
        const rpcCode = normalized.code === 'MCP_METHOD_NOT_FOUND'
          ? -32601
          : normalized.code === 'INVALID_INPUT'
            ? -32602
            : -32000;
        this.write(rpcError(request.id, rpcCode, normalized.message, {
          code: normalized.code,
          details: normalized.details,
        }));
      }
    }
  }

  private async handle(
    method: string,
    params: unknown,
    requestId: JsonRpcRequest['id'],
  ): Promise<unknown> {
    if (method === 'initialize') {
      const requested = typeof (params as { protocolVersion?: unknown })?.protocolVersion === 'string'
        ? (params as { protocolVersion: string }).protocolVersion
        : '2025-06-18';
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: '@zhicui/cli', version: '1.0.0' },
        instructions: '只调用知萃公开的普通用户 Action；不包含管理端、Shell、Cookie、JWT 或 API Key 工具。',
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: await this.tools() };
    if (method === 'tools/call') return this.callTool(params, requestId);
    if (method === 'resources/list') return { resources: [] };
    if (method === 'prompts/list') return { prompts: [] };
    throw new CliError('MCP_METHOD_NOT_FOUND', `不支持的 MCP 方法：${method}`);
  }

  private async tools(): Promise<McpTool[]> {
    const capabilities = await this.client.capabilities();
    this.currentUserHash = capabilities.user_hash || null;
    const localStatus = await this.local.status(this.currentUserHash);
    const localAvailable = localStatus.available === true;
    const used = new Set<string>();
    this.actions.clear();
    const tools: McpTool[] = [];
    for (const action of capabilities.actions.filter((item) =>
      safeAction(item)
      && (
        item.available
        || (
          item.execution_location === 'local_windows'
          && localAvailable
          && isAllowedLocalAction(item.id)
        )
      ),
    )) {
      const localSchema = action.execution_location === 'local_windows'
        ? trustedLocalInputSchema(action.id)
        : null;
      if (action.execution_location === 'local_windows' && !localSchema) continue;
      let name = toolBaseName(action.id);
      if (used.has(name)) {
        name = `${name.slice(0, 86)}_${createHash('sha256').update(action.id).digest('hex').slice(0, 8)}`;
      }
      used.add(name);
      this.actions.set(name, action);
      tools.push({
        name,
        title: action.title,
        description: action.description,
        inputSchema: localSchema || action.input_schema,
        annotations: {
          readOnlyHint: readonly(action),
          destructiveHint: destructive(action),
          openWorldHint: false,
        },
      });
    }
    const canCancel = Array.from(this.actions.values()).some((action) =>
      action.execution_location === 'cloud'
      && (action.run_type === 'stream' || action.run_type === 'long_task'),
    );
    const publishedRunTools = runTools(canCancel);
    this.activeRunToolNames = new Set(publishedRunTools.map((tool) => tool.name));
    return [...publishedRunTools, ...tools];
  }

  private async callTool(params: unknown, requestId: JsonRpcRequest['id']): Promise<unknown> {
    const value = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const name = typeof value.name === 'string' ? value.name : '';
    if (!name) throw new CliError('INVALID_INPUT', 'tools/call 缺少 name');
    const args = value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
      ? value.arguments as JsonObject
      : {};
    if (Object.values(RUN_TOOL_NAMES).includes(name as (typeof RUN_TOOL_NAMES)[keyof typeof RUN_TOOL_NAMES])) {
      if (!this.activeRunToolNames.has(name)) await this.tools();
      if (!this.activeRunToolNames.has(name)) {
        throw new CliError('ACTION_NOT_AVAILABLE', `当前凭证不可使用运行工具：${name}`);
      }
      return this.callRunTool(name, args);
    }
    if (!this.actions.has(name)) await this.tools();
    const action = this.actions.get(name);
    if (!action) throw new CliError('ACTION_NOT_AVAILABLE', `未知知萃工具：${name}`);
    if (!action.available && action.execution_location !== 'local_windows') {
      throw new CliError('ACTION_NOT_AVAILABLE', action.unavailable_reason || 'Action 未开放');
    }
    if (payloadContainsSecret(args)) {
      throw new CliError(
        'INVALID_INPUT',
        'MCP 工具不接受密码、Token、Cookie、JWT、API Key 或其他秘密字段',
      );
    }
    let envelope: AgentEnvelope;
    try {
      const idempotencyKey = `mcp-${createHash('sha256')
        .update(`${this.processNonce}:${String(requestId)}:${action.id}:${JSON.stringify(args)}`)
        .digest('hex')}`;
      if (action.execution_location === 'local_windows') {
        const capabilities = await this.client.capabilities();
        this.currentUserHash = capabilities.user_hash || null;
        envelope = await this.local.invoke(
          action, args, 120_000, idempotencyKey, this.currentUserHash,
        );
      } else {
        envelope = await this.client.invoke(action.id, args, idempotencyKey);
      }
    } catch (error) {
      const normalized = normalizeUnknownError(error);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(redactSecretValues({ error: normalized.toPayload() })),
        }],
        isError: true,
      };
    }
    const safeEnvelope = redactSecretValues(envelope);
    return {
      content: [{ type: 'text', text: JSON.stringify(safeEnvelope) }],
      isError: false,
      structuredContent: safeEnvelope,
    };
  }

  private async callRunTool(name: string, args: JsonObject): Promise<unknown> {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
    if (!runId || runId.length > 64) throw new CliError('INVALID_INPUT', 'run_id 格式无效');
    let envelope: AgentEnvelope;
    try {
      if (name === RUN_TOOL_NAMES.get) envelope = await this.client.getRun(runId);
      else if (name === RUN_TOOL_NAMES.events) {
        const after = typeof args.after === 'number' && Number.isInteger(args.after) && args.after >= 0
          ? args.after
          : 0;
        envelope = await this.client.listRunEvents(runId, after);
      } else if (name === RUN_TOOL_NAMES.cancel) envelope = await this.client.cancelRun(runId);
      else throw new CliError('ACTION_NOT_AVAILABLE', `未知运行工具：${name}`);
    } catch (error) {
      const normalized = normalizeUnknownError(error);
      return {
        content: [{ type: 'text', text: JSON.stringify(redactSecretValues({ error: normalized.toPayload() })) }],
        isError: true,
      };
    }
    const safeEnvelope = redactSecretValues(envelope);
    return {
      content: [{ type: 'text', text: JSON.stringify(safeEnvelope) }],
      isError: false,
      structuredContent: safeEnvelope,
    };
  }

  private write(value: object): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}
