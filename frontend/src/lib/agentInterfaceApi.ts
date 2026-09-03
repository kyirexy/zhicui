import { API_BASE } from './api';

export const AGENT_INTERFACE_BASE = '/api/agent-interface/v1';
export const REMOTE_AGENT_MCP_URL = 'https://luxai.cn/mcp';

export type AgentInterfaceStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface AgentInterfaceErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface AgentInterfaceEnvelope<T> {
  api_version: 'v1' | string;
  action: string;
  request_id: string;
  run_id?: string | null;
  status: AgentInterfaceStatus;
  data: T | null;
  error: AgentInterfaceErrorPayload | null;
  meta?: Record<string, unknown> | null;
}

export interface AgentScopeDefinition {
  id: string;
  title: string;
  description: string;
}

export interface AgentActionDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  scopes: string[];
  available: boolean;
  execution_location: 'cloud' | 'local_windows';
  run_type: 'sync' | 'stream' | 'long_task';
  risk?: string[];
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface AgentCapabilities {
  interface_version: string;
  actions: AgentActionDefinition[];
  scopes: AgentScopeDefinition[];
  transports: {
    http?: string;
    mcp?: string;
  };
  feature_enabled: boolean;
}

export interface AgentCredential {
  id: string;
  type: 'pat' | 'device' | string;
  name: string;
  prefix?: string | null;
  token_prefix?: string | null;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AgentDeviceConnection {
  id: string;
  name: string;
  client_type: string;
  token_prefix?: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AgentRecentCall {
  id: string;
  action_id: string;
  credential_id: string | null;
  credential_prefix?: string | null;
  request_id?: string | null;
  run_id?: string | null;
  status: string;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentPendingConfirmation {
  id: string;
  action_id: string;
  action_title: string;
  action_description: string;
  risk: string[];
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'used' | string;
  expires_at: string;
  created_at: string;
  credential_name: string;
  credential_client_type: string;
  credential_prefix: string;
  confirmation_summary?: {
    operation?: string;
    target_count?: number;
    targets?: Array<{ label: string; reference: string }>;
  };
}

export interface AgentPatCreateInput {
  name: string;
  scopes: string[];
  expires_in_days: number;
}

export interface AgentPatCreateResult {
  credential: AgentCredential;
  /** 只在创建响应中出现一次；服务端列表接口不会再次返回。 */
  token: string;
}

export interface AgentDeviceApprovalResult {
  status: 'approved' | 'denied' | string;
  client_name: string;
  scopes: string[];
}

export interface AgentDeviceAuthorizationPreview {
  status: 'pending' | string;
  client_name: string;
  client_type: string;
  scopes: string[];
  expires_at: string;
}

export class AgentInterfaceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'AgentInterfaceApiError';
    this.code = code;
    this.status = status;
  }
}

function authHeaders(hasBody: boolean): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  if (hasBody) headers.set('Content-Type', 'application/json');
  if (typeof window !== 'undefined') {
    try {
      const token = window.localStorage.getItem('zhicui_token');
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } catch {
      // 浏览器禁用 storage 时由服务端返回标准登录错误。
    }
  }
  return headers;
}

async function requestAgentInterface<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const response = await fetch(`${API_BASE}${AGENT_INTERFACE_BASE}${path}`, {
    ...init,
    headers: authHeaders(hasBody),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null) as (
    AgentInterfaceEnvelope<T> | null
  );
  if (!payload || typeof payload !== 'object') {
    if (response.status === 503) {
      throw new AgentInterfaceApiError(
        'Agent 接入正在分阶段开放，当前环境尚未启用授权和调用。',
        'INTERFACE_DISABLED',
        response.status,
      );
    }
    throw new AgentInterfaceApiError(
      response.ok ? 'Agent 接入接口返回了无效数据' : `请求失败（${response.status}）`,
      'INVALID_RESPONSE',
      response.status,
    );
  }
  if (!response.ok || payload.error || payload.status === 'failed') {
    throw new AgentInterfaceApiError(
      payload.error?.message || `请求失败（${response.status}）`,
      payload.error?.code || 'REQUEST_FAILED',
      response.status,
    );
  }
  if (payload.data === null || payload.data === undefined) {
    throw new AgentInterfaceApiError('Agent 接入接口没有返回数据', 'EMPTY_RESPONSE', response.status);
  }
  return payload.data;
}

export function getAgentCapabilities(): Promise<AgentCapabilities> {
  return requestAgentInterface<AgentCapabilities>('/capabilities');
}

export async function listAgentCredentials(): Promise<AgentCredential[]> {
  const data = await requestAgentInterface<{ items: AgentCredential[] }>('/credentials');
  return Array.isArray(data.items) ? data.items : [];
}

export function createAgentPat(input: AgentPatCreateInput): Promise<AgentPatCreateResult> {
  return requestAgentInterface<AgentPatCreateResult>('/credentials/pat', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function revokeAgentCredential(id: string): Promise<AgentCredential> {
  const data = await requestAgentInterface<{ credential: AgentCredential }>(
    `/credentials/${encodeURIComponent(id)}/revoke`,
    { method: 'POST' },
  );
  return data.credential;
}

export async function listAgentDevices(): Promise<AgentDeviceConnection[]> {
  const data = await requestAgentInterface<{ items: AgentDeviceConnection[] }>('/devices');
  return Array.isArray(data.items) ? data.items : [];
}

export function approveAgentDeviceAuthorization(
  userCode: string,
  approve: boolean,
): Promise<AgentDeviceApprovalResult> {
  return requestAgentInterface<AgentDeviceApprovalResult>('/auth/device/approve', {
    method: 'POST',
    body: JSON.stringify({ user_code: userCode.trim().toUpperCase(), approve }),
  });
}

export function getAgentDeviceAuthorizationRequest(
  userCode: string,
): Promise<AgentDeviceAuthorizationPreview> {
  const query = new URLSearchParams({ user_code: userCode.trim().toUpperCase() });
  return requestAgentInterface<AgentDeviceAuthorizationPreview>(
    `/auth/device/request?${query.toString()}`,
  );
}

export async function revokeAgentDevice(id: string): Promise<AgentDeviceConnection> {
  const data = await requestAgentInterface<{ credential: AgentDeviceConnection }>(
    `/devices/${encodeURIComponent(id)}/revoke`,
    { method: 'POST' },
  );
  return data.credential;
}

export async function listAgentRecentCalls(limit = 20): Promise<AgentRecentCall[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
  const data = await requestAgentInterface<{ items: AgentRecentCall[]; total: number }>(
    `/recent-calls?limit=${boundedLimit}`,
  );
  return Array.isArray(data.items) ? data.items : [];
}

export async function listAgentPendingConfirmations(
  limit = 20,
): Promise<AgentPendingConfirmation[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
  const data = await requestAgentInterface<{
    items: AgentPendingConfirmation[];
    total: number;
  }>(`/confirmations?limit=${boundedLimit}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function getAgentPendingConfirmation(
  id: string,
): Promise<AgentPendingConfirmation> {
  const data = await requestAgentInterface<{ confirmation: AgentPendingConfirmation }>(
    `/confirmations/${encodeURIComponent(id)}`,
  );
  return data.confirmation;
}

export async function approveAgentPendingConfirmation(
  id: string,
): Promise<AgentPendingConfirmation> {
  const data = await requestAgentInterface<{ confirmation: AgentPendingConfirmation }>(
    `/confirmations/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: JSON.stringify({ approve: true }) },
  );
  return data.confirmation;
}

export async function rejectAgentPendingConfirmation(
  id: string,
): Promise<AgentPendingConfirmation> {
  const data = await requestAgentInterface<{ confirmation: AgentPendingConfirmation }>(
    `/confirmations/${encodeURIComponent(id)}/reject`,
    { method: 'POST' },
  );
  return data.confirmation;
}
