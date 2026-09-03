import type { AgentErrorPayload, JsonValue } from './types.js';

export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  authentication: 3,
  permission: 4,
  confirmationOrWaiting: 5,
  rateLimited: 6,
  remoteFailure: 7,
  timeoutOrCanceled: 8,
  localUnavailable: 9,
});

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const AUTH_CODES = new Set([
  'AUTH_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'DEVICE_AUTHORIZATION_EXPIRED',
  'INVALID_CREDENTIAL',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_EXPIRED',
  'DEVICE_CODE_INVALID',
  'DEVICE_CODE_EXPIRED',
  'DEVICE_CODE_USED',
  'REFRESH_TOKEN_EXPIRED',
  'REFRESH_TOKEN_REUSED',
]);
const PERMISSION_CODES = new Set([
  'FORBIDDEN',
  'SCOPE_REQUIRED',
  'RESOURCE_NOT_OWNED',
  'ACTION_NOT_ALLOWED',
  'SCOPE_DENIED',
]);
const WAITING_CODES = new Set([
  'CONFIRMATION_REQUIRED',
  'WAITING_FOR_USER',
  'BILLING_CONFIRMATION_REQUIRED',
  'AUTHORIZATION_PENDING',
  'CONFIRMATION_NOT_FOUND',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_MISMATCH',
  'CONFIRMATION_REPLAYED',
]);
const RATE_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_REQUESTS']);
const TIMEOUT_CODES = new Set([
  'TIMEOUT',
  'REQUEST_TIMEOUT',
  'RUN_CANCELED',
  'CANCELED',
  'ABORTED',
]);
const LOCAL_CODES = new Set([
  'LOCAL_CAPABILITY_UNAVAILABLE',
  'LOCAL_ACTION_BUSY',
  'DESKTOP_NOT_INSTALLED',
  'DESKTOP_BRIDGE_UNAVAILABLE',
  'UNSUPPORTED_PLATFORM',
]);

export function exitCodeForError(code: string): ExitCode {
  const normalized = code.trim().toUpperCase();
  if (AUTH_CODES.has(normalized)) return EXIT_CODES.authentication;
  if (PERMISSION_CODES.has(normalized)) return EXIT_CODES.permission;
  if (WAITING_CODES.has(normalized)) return EXIT_CODES.confirmationOrWaiting;
  if (RATE_CODES.has(normalized)) return EXIT_CODES.rateLimited;
  if (TIMEOUT_CODES.has(normalized)) return EXIT_CODES.timeoutOrCanceled;
  if (LOCAL_CODES.has(normalized)) return EXIT_CODES.localUnavailable;
  if (
    normalized === 'USAGE_ERROR'
    || normalized === 'SCHEMA_INVALID'
    || normalized === 'INVALID_INPUT'
  ) return EXIT_CODES.usage;
  return EXIT_CODES.remoteFailure;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details?: JsonValue;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    message: string,
    options: {
      exitCode?: ExitCode;
      details?: JsonValue;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CliError';
    this.code = code;
    this.exitCode = options.exitCode ?? exitCodeForError(code);
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toPayload(): AgentErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: this.retryAfterSeconds }),
    };
  }
}

export function usageError(message: string, details?: JsonValue): CliError {
  return new CliError('USAGE_ERROR', message, {
    exitCode: EXIT_CODES.usage,
    details,
  });
}

export function normalizeUnknownError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new CliError('TIMEOUT', '操作超时或已取消', {
      exitCode: EXIT_CODES.timeoutOrCanceled,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError('REMOTE_FAILURE', message || '未知错误', {
    exitCode: EXIT_CODES.remoteFailure,
    cause: error,
  });
}
