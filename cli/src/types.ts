export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type ExecutionLocation = 'cloud' | 'local_windows';

export interface AgentErrorPayload {
  code: string;
  message: string;
  details?: JsonValue;
  retry_after_seconds?: number;
}

export interface AgentEnvelope<T extends JsonValue = JsonValue> {
  api_version?: string;
  action?: string | null;
  request_id?: string;
  run_id?: string | null;
  run?: AgentRun | null;
  status?: RunStatus | string;
  data?: T | null;
  error?: AgentErrorPayload | string | null;
  meta?: JsonObject | null;
  success?: boolean;
}

export interface AgentActionDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  input_schema: JsonObject;
  output_schema?: JsonObject;
  scopes: string[];
  execution_location: ExecutionLocation;
  run_type: 'sync' | 'stream' | 'long_task' | string;
  available: boolean;
  unavailable_reason?: string | null;
  aliases?: string[];
  risk?: JsonObject | string;
  secure_direct?: boolean;
  mcp_exposed?: boolean;
}

export interface AgentCapabilities {
  api_version: string;
  user_hash?: string | null;
  actions: AgentActionDefinition[];
  scopes?: JsonValue;
  feature_enabled?: boolean;
}

export interface AgentRun {
  id?: string;
  run_id?: string;
  action_id?: string;
  status: RunStatus | string;
  created_at?: string;
  updated_at?: string;
  result?: JsonValue;
  error?: AgentErrorPayload | string | null;
  [key: string]: JsonValue | AgentErrorPayload | undefined;
}

export interface AgentRunEvent {
  sequence: number;
  event?: string;
  type?: string;
  status?: RunStatus | string;
  run_id?: string;
  data?: JsonValue;
  error?: AgentErrorPayload | string | null;
  terminal?: boolean;
  [key: string]: JsonValue | AgentErrorPayload | undefined;
}

export interface StoredCredential {
  kind: 'pat' | 'device';
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  token_prefix?: string;
  scopes?: string[];
  server_origin?: string;
  created_at: string;
}

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'canceled',
]);

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isTerminalStatus(value: unknown): boolean {
  return typeof value === 'string'
    && TERMINAL_RUN_STATUSES.has(value as RunStatus);
}
