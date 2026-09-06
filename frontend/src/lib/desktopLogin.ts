const PRODUCTION_ORIGIN = 'https://luxai.cn';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
const LOGIN_PATH = '/login';
const FRAGMENT_PREFIX = 'desktop-login=';
const PENDING_STORAGE_KEY = 'zhicui_pending_desktop_login';
const PENDING_STORAGE_VERSION = 1;
const MAX_PENDING_AGE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{20,96}$/;
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,160}$/;

type UnknownRecord = Record<string, unknown>;

export interface DesktopLoginUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  email_verified: boolean;
  agent_profile_key?: string;
  created_at: string;
}

export interface DesktopLoginAuthSession {
  token: string;
  user: DesktopLoginUser;
}

export interface DesktopLoginApprovalReference {
  sessionId: string;
  approvalToken: string;
}

export interface DesktopLoginCreateData {
  status: 'pending';
  session_id: string;
  poll_secret: string;
  approval_token: string;
  approval_url: string;
  verification_code: string;
  expires_at: string;
  poll_interval_seconds: number;
  client_name: string;
  client_type: 'windows' | 'macos' | 'web';
}

export type DesktopLoginRemoteStatus =
  | 'pending'
  | 'slow_down'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'consumed'
  | 'account_unavailable';

export type DesktopLoginPollData =
  | ({ status: 'success' } & DesktopLoginAuthSession)
  | {
      status: DesktopLoginRemoteStatus;
      poll_interval_seconds?: number;
      retry_after_seconds?: number;
    };

export interface DesktopLoginPreviewData {
  status: Exclude<DesktopLoginRemoteStatus, 'slow_down'>;
  session_id: string;
  client_name: string;
  client_type: 'windows' | 'macos' | 'web';
  verification_code: string;
  expires_at: string;
}

export interface DesktopLoginDecisionData {
  status: 'approved' | 'denied';
  session_id?: string;
}

export type DesktopLoginApiResult<T> =
  | { success: true; data: T; status: number }
  | { success: false; error: string; status?: number };

export interface ParseDesktopLoginQrOptions {
  /** Additional exact origins accepted by local integration tests. */
  allowedOrigins?: readonly string[];
}

interface StoredPendingApproval {
  version: typeof PENDING_STORAGE_VERSION;
  sessionId: string;
  approvalToken: string;
  savedAt: number;
  expiresAt: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (typeof payload.error === 'string' && payload.error) return payload.error;
    if (typeof payload.detail === 'string' && payload.detail) return payload.detail;
    if (isRecord(payload.detail) && typeof payload.detail.message === 'string') {
      return payload.detail.message;
    }
  }
  return status >= 500 ? '登录服务暂时不可用，请稍后重试' : `请求失败（${status}）`;
}

async function postJson<T>(
  endpoint: string,
  body: UnknownRecord,
  options: { signal?: AbortSignal; token?: string } = {},
): Promise<DesktopLoginApiResult<T>> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || payload.success !== true) {
      return {
        success: false,
        error: apiErrorMessage(payload, response.status),
        status: response.status,
      };
    }
    return { success: true, data: payload.data as T, status: response.status };
  } catch (error) {
    return {
      success: false,
      error: timedOut
        ? '连接超时，请稍后重试'
        : error instanceof DOMException && error.name === 'AbortError'
          ? '请求已取消'
          : '网络连接失败，请检查网络后重试',
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export function createDesktopLoginSession(
  signal?: AbortSignal,
  clientType: 'windows' | 'macos' | 'web' = 'windows',
): Promise<DesktopLoginApiResult<DesktopLoginCreateData>> {
  return postJson('/api/auth/desktop-login/sessions', {
    client_type: clientType,
  }, { signal });
}

export function pollDesktopLoginSession(
  sessionId: string,
  pollSecret: string,
  signal?: AbortSignal,
): Promise<DesktopLoginApiResult<DesktopLoginPollData>> {
  return postJson(
    `/api/auth/desktop-login/sessions/${encodeURIComponent(sessionId)}/token`,
    { poll_secret: pollSecret },
    { signal },
  );
}

export function cancelDesktopLoginSession(
  sessionId: string,
  pollSecret: string,
  signal?: AbortSignal,
): Promise<DesktopLoginApiResult<{
  status: 'cancelled' | 'approved' | 'consumed' | 'denied' | 'expired';
  session_id?: string;
}>> {
  return postJson(
    `/api/auth/desktop-login/sessions/${encodeURIComponent(sessionId)}/cancel`,
    { poll_secret: pollSecret },
    { signal },
  );
}

export function previewDesktopLoginSession(
  reference: DesktopLoginApprovalReference,
  signal?: AbortSignal,
): Promise<DesktopLoginApiResult<DesktopLoginPreviewData>> {
  return postJson(
    `/api/auth/desktop-login/sessions/${encodeURIComponent(reference.sessionId)}/preview`,
    { approval_token: reference.approvalToken },
    { signal },
  );
}

export function decideDesktopLoginSession(
  reference: DesktopLoginApprovalReference,
  decision: 'approve' | 'deny',
  signal?: AbortSignal,
): Promise<DesktopLoginApiResult<DesktopLoginDecisionData>> {
  let token = '';
  if (typeof window !== 'undefined') {
    try {
      token = window.localStorage.getItem('zhicui_token') || '';
    } catch {
      token = '';
    }
  }
  return postJson(
    `/api/auth/desktop-login/sessions/${encodeURIComponent(reference.sessionId)}/decision`,
    { approval_token: reference.approvalToken, decision },
    { signal, token },
  );
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function trustedOrigins(options?: ParseDesktopLoginQrOptions): Set<string> {
  const origins = new Set<string>([PRODUCTION_ORIGIN]);
  for (const value of options?.allowedOrigins || []) {
    const normalized = normalizeOrigin(value);
    if (normalized) origins.add(normalized);
  }
  if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
    origins.add(window.location.origin);
  }
  return origins;
}

function isValidReference(
  reference: DesktopLoginApprovalReference,
): boolean {
  return SESSION_ID_PATTERN.test(reference.sessionId)
    && APPROVAL_TOKEN_PATTERN.test(reference.approvalToken);
}

/**
 * Parse only the exact fragment-based login URL issued by a trusted Zhicui
 * origin. The approval credential is never accepted from a query string.
 */
export function parseDesktopLoginQr(
  raw: string,
  options?: ParseDesktopLoginQrOptions,
): DesktopLoginApprovalReference | null {
  const value = raw.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !trustedOrigins(options).has(url.origin)
    || url.username
    || url.password
    || url.pathname.replace(/\/$/, '') !== LOGIN_PATH
    || url.search
  ) {
    return null;
  }

  let fragment = url.hash.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  if (!fragment.startsWith(FRAGMENT_PREFIX)) return null;
  const credential = fragment.slice(FRAGMENT_PREFIX.length);
  const separator = credential.indexOf('.');
  if (separator <= 0 || separator !== credential.lastIndexOf('.')) return null;

  const reference = {
    sessionId: credential.slice(0, separator),
    approvalToken: credential.slice(separator + 1),
  };
  return isValidReference(reference) ? reference : null;
}

export function buildDesktopLoginApprovalUrl(
  data: Pick<DesktopLoginCreateData, 'session_id' | 'approval_token' | 'approval_url'>,
): string {
  const reference = {
    sessionId: data.session_id,
    approvalToken: data.approval_token,
  };
  if (!isValidReference(reference)) {
    throw new Error('服务端返回的登录码格式无效');
  }

  const currentOrigin = typeof window !== 'undefined'
    ? window.location.origin
    : PRODUCTION_ORIGIN;
  const currentOriginIsTrusted = currentOrigin === PRODUCTION_ORIGIN
    || process.env.NODE_ENV === 'development';
  const allowedOrigins = trustedOrigins({
    allowedOrigins: currentOriginIsTrusted ? [currentOrigin] : [],
  });
  const serverReference = parseDesktopLoginQr(data.approval_url, {
    allowedOrigins: [...allowedOrigins],
  });
  if (
    serverReference?.sessionId === reference.sessionId
    && serverReference.approvalToken === reference.approvalToken
  ) {
    return data.approval_url;
  }

  const origin = currentOriginIsTrusted ? currentOrigin : PRODUCTION_ORIGIN;
  return `${origin}${LOGIN_PATH}#${FRAGMENT_PREFIX}${reference.sessionId}.${reference.approvalToken}`;
}

export function savePendingDesktopLoginApproval(
  reference: DesktopLoginApprovalReference,
  expiresAt?: string,
): boolean {
  if (typeof window === 'undefined' || !isValidReference(reference)) return false;
  const now = Date.now();
  const requestedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expiresAtMs = Number.isFinite(requestedExpiry)
    ? Math.min(requestedExpiry, now + MAX_PENDING_AGE_MS)
    : now + MAX_PENDING_AGE_MS;
  if (expiresAtMs <= now) return false;

  const stored: StoredPendingApproval = {
    version: PENDING_STORAGE_VERSION,
    sessionId: reference.sessionId,
    approvalToken: reference.approvalToken,
    savedAt: now,
    expiresAt: expiresAtMs,
  };
  try {
    window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function readPendingDesktopLoginApproval(): DesktopLoginApprovalReference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      clearPendingDesktopLoginApproval();
      return null;
    }
    const now = Date.now();
    const reference = {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      approvalToken: typeof parsed.approvalToken === 'string' ? parsed.approvalToken : '',
    };
    if (
      parsed.version !== PENDING_STORAGE_VERSION
      || typeof parsed.savedAt !== 'number'
      || typeof parsed.expiresAt !== 'number'
      || parsed.savedAt > now
      || now - parsed.savedAt > MAX_PENDING_AGE_MS
      || parsed.expiresAt <= now
      || !isValidReference(reference)
    ) {
      clearPendingDesktopLoginApproval();
      return null;
    }
    return reference;
  } catch {
    clearPendingDesktopLoginApproval();
    return null;
  }
}

export function clearPendingDesktopLoginApproval(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    // Session storage may be disabled; there is no persistent fallback by design.
  }
}
