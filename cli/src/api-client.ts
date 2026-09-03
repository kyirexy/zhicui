import { CliError, EXIT_CODES } from './errors.js';
import { CredentialManager } from './credentials.js';
import type {
  AgentActionDefinition,
  AgentCapabilities,
  AgentEnvelope,
  AgentRun,
  AgentRunEvent,
  JsonObject,
  JsonValue,
  StoredCredential,
} from './types.js';
import { isJsonObject, isTerminalStatus } from './types.js';

const CLIENT_VERSION = '1.0.0';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeAction(value: unknown): AgentActionDefinition {
  const item = record(value);
  const id = stringValue(item.id || item.action_id);
  if (!id) throw new CliError('REMOTE_FAILURE', '能力列表包含无 ID 的 Action');
  const location = stringValue(item.execution_location, 'cloud');
  return {
    id,
    version: stringValue(item.version, '1'),
    title: stringValue(item.title || item.name, id),
    description: stringValue(item.description, ''),
    input_schema: (isJsonObject(item.input_schema)
      ? item.input_schema
      : isJsonObject(item.inputSchema)
        ? item.inputSchema
        : { type: 'object', additionalProperties: false }) as JsonObject,
    output_schema: (isJsonObject(item.output_schema)
      ? item.output_schema
      : isJsonObject(item.outputSchema)
        ? item.outputSchema
        : undefined) as JsonObject | undefined,
    scopes: stringList(item.scopes || item.required_scopes),
    execution_location: location === 'local_windows' ? 'local_windows' : 'cloud',
    run_type: stringValue(item.run_type || item.invocation_type, 'sync'),
    available: item.available !== false && item.enabled !== false,
    unavailable_reason: typeof item.unavailable_reason === 'string'
      ? item.unavailable_reason
      : null,
    aliases: stringList(item.aliases),
    risk: (item.risk || item.risk_level) as JsonObject | string | undefined,
    secure_direct: item.secure_direct === true,
    mcp_exposed: item.mcp_exposed !== false,
  };
}

function normalizeErrorPayload(value: unknown, status: number): CliError {
  const outer = record(value);
  const raw = outer.error ?? outer.detail ?? value;
  const item = record(raw);
  const statusCode = status === 401
    ? 'AUTH_REQUIRED'
    : status === 403
      ? 'FORBIDDEN'
      : status === 429
        ? 'RATE_LIMITED'
        : `HTTP_${status}`;
  const code = stringValue(item.code, statusCode);
  const message = stringValue(
    item.message || outer.message || (typeof raw === 'string' ? raw : undefined),
    `知萃服务返回 HTTP ${status}`,
  );
  return new CliError(code, message, {
    details: (item.details ?? null) as JsonValue,
    retryAfterSeconds: typeof item.retry_after_seconds === 'number'
      ? item.retry_after_seconds
      : undefined,
  });
}

function normalizeEnvelope<T extends JsonValue = JsonValue>(value: unknown): AgentEnvelope<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('REMOTE_FAILURE', '知萃服务返回了无效 JSON Envelope');
  }
  return value as AgentEnvelope<T>;
}

function throwEnvelopeError(envelope: AgentEnvelope): void {
  if (!envelope.error) return;
  if (typeof envelope.error === 'string') {
    throw new CliError('REMOTE_FAILURE', envelope.error);
  }
  throw new CliError(envelope.error.code, envelope.error.message, {
    details: envelope.error.details,
    retryAfterSeconds: envelope.error.retry_after_seconds,
  });
}

function tokenExpired(credential: StoredCredential): boolean {
  if (!credential.expires_at) return false;
  const expires = Date.parse(credential.expires_at);
  return Number.isFinite(expires) && expires <= Date.now() + 30_000;
}

function credentialMetadata(data: RecordValue): {
  expiresAt?: string;
  tokenPrefix?: string;
  scopes: string[];
} {
  const nested = record(data.credential);
  let expiresAt = stringValue(data.expires_at || nested.expires_at) || undefined;
  if (!expiresAt && typeof data.expires_in === 'number' && data.expires_in > 0) {
    expiresAt = new Date(Date.now() + data.expires_in * 1_000).toISOString();
  }
  return {
    expiresAt,
    tokenPrefix: stringValue(data.token_prefix || nested.token_prefix) || undefined,
    scopes: stringList(data.scopes || nested.scopes),
  };
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  idempotencyKey?: string;
  credentials: CredentialManager;
}

export class AgentApiClient {
  constructor(readonly options: ApiClientOptions) {}

  private path(path: string): string {
    return `${this.options.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async credentialToken(): Promise<string | null> {
    let credential = await this.options.credentials.load();
    if (!credential) return null;
    if (tokenExpired(credential) && credential.refresh_token) {
      credential = await this.refreshSerialized(credential.refresh_token);
    }
    return credential.access_token;
  }

  private async refreshSerialized(observedRefreshToken: string): Promise<StoredCredential> {
    return this.options.credentials.withRefreshLock(async () => {
      const latest = await this.options.credentials.load();
      if (
        latest
        && latest.refresh_token
        && latest.refresh_token !== observedRefreshToken
        && !tokenExpired(latest)
      ) return latest;
      return this.refresh(observedRefreshToken);
    }, Math.min(this.options.timeoutMs, 20_000));
  }

  private async request(
    path: string,
    init: RequestInit & { authenticated?: boolean; timeoutMs?: number } = {},
    authRetried = false,
  ): Promise<unknown> {
    const {
      authenticated = true,
      timeoutMs = this.options.timeoutMs,
      ...fetchInit
    } = init;
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', `@zhicui/cli/${CLIENT_VERSION}`);
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.options.idempotencyKey && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', this.options.idempotencyKey);
    }
    if (authenticated) {
      const token = await this.credentialToken();
      if (!token) {
        throw new CliError('AUTH_REQUIRED', '尚未授权，请先运行 zhicui auth login');
      }
      headers.set('Authorization', `Bearer ${token}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(this.path(path), {
        ...fetchInit,
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 401 && authenticated && !authRetried) {
        const credential = await this.options.credentials.load();
        if (credential?.refresh_token) {
          await this.refreshSerialized(credential.refresh_token);
          return this.request(path, init, true);
        }
      }
      const text = await response.text();
      let payload: unknown = null;
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (!response.ok) throw normalizeErrorPayload({ detail: text.slice(0, 500) }, response.status);
          throw new CliError('REMOTE_FAILURE', '知萃服务返回了非 JSON 响应');
        }
      }
      if (!response.ok) throw normalizeErrorPayload(payload, response.status);
      return payload;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CliError('TIMEOUT', '请求知萃服务超时', {
          exitCode: EXIT_CODES.timeoutOrCanceled,
          cause: error,
        });
      }
      throw new CliError('REMOTE_FAILURE', '无法连接知萃服务', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async startDeviceAuthorization(scopes: string[]): Promise<RecordValue> {
    const payload = await this.request('/api/agent-interface/v1/auth/device', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({
        client_name: `@zhicui/cli ${CLIENT_VERSION}`,
        client_type: 'cli',
        scopes,
      }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return record(envelope.data ?? payload);
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<RecordValue> {
    const payload = await this.request('/api/agent-interface/v1/auth/device/token', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ device_code: deviceCode }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return record(envelope.data ?? payload);
  }

  async refresh(refreshToken: string): Promise<StoredCredential> {
    const payload = await this.request('/api/agent-interface/v1/auth/refresh', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    const data = record(envelope.data ?? payload);
    const accessToken = stringValue(data.access_token);
    if (!accessToken) throw new CliError('INVALID_TOKEN', '刷新响应缺少 access_token');
    const metadata = credentialMetadata(data);
    const credential: StoredCredential = {
      kind: 'device',
      access_token: accessToken,
      refresh_token: stringValue(data.refresh_token) || refreshToken,
      expires_at: metadata.expiresAt,
      token_prefix: metadata.tokenPrefix || `${accessToken.slice(0, 6)}…`,
      scopes: metadata.scopes,
      created_at: new Date().toISOString(),
    };
    await this.options.credentials.save(credential);
    return credential;
  }

  async capabilities(): Promise<AgentCapabilities> {
    const payload = await this.request('/api/agent-interface/v1/capabilities');
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    const data = record(envelope.data ?? payload);
    const rawActions = Array.isArray(data.actions)
      ? data.actions
      : Array.isArray(envelope.data)
        ? envelope.data
        : [];
    return {
      api_version: stringValue(data.api_version || envelope.api_version, 'v1'),
      user_hash: stringValue(data.user_hash) || null,
      actions: rawActions.map(normalizeAction),
      scopes: (data.scopes ?? null) as JsonValue,
      feature_enabled: data.feature_enabled !== false,
    };
  }

  async describeAction(actionId: string): Promise<AgentActionDefinition> {
    const payload = await this.request(
      `/api/agent-interface/v1/actions/${encodeURIComponent(actionId)}`,
    );
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    const data = record(envelope.data ?? payload);
    return normalizeAction(data.action ?? data);
  }

  async invoke(
    actionId: string,
    input: JsonObject,
    idempotencyKey?: string,
  ): Promise<AgentEnvelope> {
    const confirmationId = typeof input.confirmation_id === 'string'
      ? input.confirmation_id
      : undefined;
    const actionInput = { ...input };
    delete actionInput.confirmation_id;
    const payload = await this.request(
      `/api/agent-interface/v1/actions/${encodeURIComponent(actionId)}/invoke`,
      {
        method: 'POST',
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        body: JSON.stringify({
          input: actionInput,
          ...(confirmationId ? { confirmation_id: confirmationId } : {}),
        }),
      },
    );
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async secureAccountExport(password: string): Promise<Uint8Array> {
    const token = await this.credentialToken();
    if (!token) throw new CliError('AUTH_REQUIRED', '尚未授权，请先运行 zhicui auth login');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(this.path('/api/agent-interface/v1/secure/account/data-export'), {
        method: 'POST',
        headers: {
          Accept: 'application/zip, application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `@zhicui/cli/${CLIENT_VERSION}`,
        },
        body: JSON.stringify({ password }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        const text = await response.text();
        let payload: unknown = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { detail: text.slice(0, 500) }; }
        throw normalizeErrorPayload(payload, response.status);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/zip')) {
        throw new CliError('REMOTE_FAILURE', '个人数据导出没有返回 ZIP 归档');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 256 * 1024 * 1024) {
        throw new CliError('REMOTE_FAILURE', '个人数据归档为空或超过 256MB 安全上限');
      }
      return bytes;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CliError('TIMEOUT', '个人数据导出超时', {
          exitCode: EXIT_CODES.timeoutOrCanceled,
          cause: error,
        });
      }
      throw new CliError('REMOTE_FAILURE', '无法连接知萃服务', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async secureAccountDeletePrepare(password: string): Promise<RecordValue> {
    const payload = await this.request('/api/agent-interface/v1/secure/account/delete/prepare', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return record(envelope.data ?? payload);
  }

  async secureAccountDeleteConfirm(
    confirmationToken: string,
    confirmationPhrase: string,
  ): Promise<AgentEnvelope> {
    const payload = await this.request('/api/agent-interface/v1/secure/account/delete/confirm', {
      method: 'POST',
      body: JSON.stringify({
        confirmation_token: confirmationToken,
        confirmation_phrase: confirmationPhrase,
      }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async prepareModelSecretUpdate(
    target: 'chat' | 'vision',
    modelId: string | undefined,
  ): Promise<AgentEnvelope> {
    const payload = await this.request('/api/agent-interface/v1/secure/models/secret', {
      method: 'POST',
      body: JSON.stringify({
        target,
        ...(modelId ? { model_id: modelId } : {}),
      }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async secureModelSecretUpdate(
    target: 'chat' | 'vision',
    modelId: string | undefined,
    confirmationId: string,
    apiKey: string,
  ): Promise<AgentEnvelope> {
    const payload = await this.request('/api/agent-interface/v1/secure/models/secret', {
      method: 'POST',
      body: JSON.stringify({
        target,
        ...(modelId ? { model_id: modelId } : {}),
        confirmation_id: confirmationId,
        api_key: apiKey,
      }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async prepareCustomModelCreate(
    metadata: {
      name: string;
      provider_name: string;
      model: string;
      api_base: string;
      enabled: boolean;
      select: boolean;
    },
  ): Promise<AgentEnvelope> {
    const payload = await this.request('/api/agent-interface/v1/secure/models/custom', {
      method: 'POST',
      body: JSON.stringify(metadata),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async secureCustomModelCreate(
    metadata: {
      name: string;
      provider_name: string;
      model: string;
      api_base: string;
      enabled: boolean;
      select: boolean;
    },
    confirmationId: string,
    apiKey: string,
  ): Promise<AgentEnvelope> {
    const payload = await this.request('/api/agent-interface/v1/secure/models/custom', {
      method: 'POST',
      body: JSON.stringify({
        ...metadata,
        confirmation_id: confirmationId,
        api_key: apiKey,
      }),
    });
    const envelope = normalizeEnvelope(payload);
    throwEnvelopeError(envelope);
    return envelope;
  }

  async getRun(runId: string, timeoutMs?: number): Promise<AgentEnvelope> {
    const envelope = normalizeEnvelope(await this.request(
      `/api/agent-interface/v1/runs/${encodeURIComponent(runId)}`,
      { timeoutMs },
    ));
    throwEnvelopeError(envelope);
    return envelope;
  }

  async cancelRun(runId: string): Promise<AgentEnvelope> {
    const envelope = normalizeEnvelope(await this.request(
      `/api/agent-interface/v1/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: '{}' },
    ));
    throwEnvelopeError(envelope);
    return envelope;
  }

  async listRunEvents(runId: string, afterSequence = 0): Promise<AgentEnvelope> {
    const after = Math.max(0, Math.floor(afterSequence));
    const suffix = after > 0 ? `?after=${after}` : '';
    const envelope = normalizeEnvelope(await this.request(
      `/api/agent-interface/v1/runs/${encodeURIComponent(runId)}/events${suffix}`,
      { headers: { Accept: 'application/json' } },
    ));
    throwEnvelopeError(envelope);
    return envelope;
  }

  async *events(
    runId: string,
    afterSequence = 0,
    timeoutMs = this.options.timeoutMs,
    authRetried = false,
  ): AsyncGenerator<AgentRunEvent> {
    const startedAt = Date.now();
    const token = await this.credentialToken();
    if (!token) throw new CliError('AUTH_REQUIRED', '尚未授权，请先运行 zhicui auth login');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const url = new URL(this.path(
        `/api/agent-interface/v1/runs/${encodeURIComponent(runId)}/events`,
      ));
      if (afterSequence > 0) url.searchParams.set('after', String(afterSequence));
      const headers = new Headers({
        Accept: 'text/event-stream, application/x-ndjson, application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': `@zhicui/cli/${CLIENT_VERSION}`,
      });
      if (afterSequence > 0) headers.set('Last-Event-ID', String(afterSequence));
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 401 && !authRetried) {
        const credential = await this.options.credentials.load();
        if (credential?.refresh_token) {
          await this.refreshSerialized(credential.refresh_token);
          const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
          for await (const event of this.events(runId, afterSequence, remaining, true)) {
            yield event;
          }
          return;
        }
      }
      if (!response.ok) {
        let payload: unknown = null;
        try { payload = JSON.parse(await response.text()); } catch { /* normalized below */ }
        throw normalizeErrorPayload(payload, response.status);
      }
      if (!response.body) throw new CliError('REMOTE_FAILURE', '事件流没有响应体');
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
        const value = await response.json();
        const data = record(normalizeEnvelope(value).data ?? value);
        const events = Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.events)
            ? data.events
            : Array.isArray(value)
              ? value
              : [];
        for (const event of events) yield normalizeRunEvent(event);
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (contentType.includes('text/event-stream')) {
          const parts = buffer.split(/\r?\n\r?\n/u);
          buffer = parts.pop() || '';
          for (const part of parts) {
            const dataLines = part.split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart());
            if (!dataLines.length) continue;
            const dataText = dataLines.join('\n');
            if (dataText === '[DONE]') continue;
            yield normalizeRunEvent(JSON.parse(dataText));
          }
        } else {
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) yield normalizeRunEvent(JSON.parse(line));
          }
        }
      }
      const tail = buffer.trim();
      if (tail && !contentType.includes('text/event-stream')) {
        yield normalizeRunEvent(JSON.parse(tail));
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CliError('TIMEOUT', '等待运行事件超时', {
          exitCode: EXIT_CODES.timeoutOrCanceled,
        });
      }
      throw new CliError('REMOTE_FAILURE', '运行事件流中断', { cause: error });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

export function normalizeRunEvent(value: unknown): AgentRunEvent {
  const outer = record(value);
  const nested = record(outer.data);
  const candidate = Object.keys(nested).some((key) => [
    'sequence', 'status', 'event', 'type', 'run_id',
  ].includes(key)) ? nested : outer;
  const sequence = Number(candidate.sequence ?? candidate.id ?? 0);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new CliError('REMOTE_FAILURE', '运行事件缺少有效 sequence');
  }
  const status = stringValue(candidate.status) || undefined;
  return {
    ...(candidate as AgentRunEvent),
    sequence,
    status,
    terminal: candidate.terminal === true || isTerminalStatus(status),
  };
}

export function runFromEnvelope(envelope: AgentEnvelope): AgentRun | null {
  if (envelope.run && typeof envelope.run === 'object') return envelope.run;
  const data = record(envelope.data);
  const run = record(data.run);
  if (Object.keys(run).length) return run as AgentRun;
  if (envelope.run_id) {
    return {
      run_id: envelope.run_id,
      status: stringValue(envelope.status, 'queued'),
    };
  }
  if (data.run_id || data.id) {
    return {
      ...(data as unknown as AgentRun),
      status: stringValue(data.status || envelope.status, 'queued'),
    };
  }
  return null;
}

export function runIdOf(run: AgentRun | null): string | null {
  if (!run) return null;
  return stringValue(run.run_id || run.id) || null;
}
