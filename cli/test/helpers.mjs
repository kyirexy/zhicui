import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const CLI_ENTRY = resolve('dist', 'index.js');

export async function temporaryDirectory(prefix = 'zhicui-cli-test-') {
  return mkdtemp(resolve(tmpdir(), prefix));
}

export async function runCli(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: resolve('.'),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI test timed out: ${args.join(' ')}`));
    }, options.processTimeoutMs || 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
    child.stdin.end(options.input || '');
  });
}

export async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

export function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let value = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { value += chunk; });
    request.on('end', () => {
      try { resolveBody(value ? JSON.parse(value) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

export function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

export function envelope(data, overrides = {}) {
  return {
    api_version: 'v1',
    action: null,
    request_id: 'req-test',
    run_id: null,
    status: 'succeeded',
    data,
    error: null,
    meta: {},
    ...overrides,
  };
}

export function action(id, extra = {}) {
  return {
    id,
    version: '1',
    title: id,
    description: `Action ${id}`,
    input_schema: { type: 'object', additionalProperties: true },
    output_schema: { type: 'object' },
    scopes: ['library:read'],
    execution_location: 'cloud',
    run_type: 'sync',
    available: true,
    ...extra,
  };
}

export function credentialEnv(directory, url) {
  return {
    ZHICUI_CLI_DEV: '1',
    ZHICUI_API_URL: url,
    ZHICUI_CREDENTIALS_FILE: resolve(directory, 'credential.json'),
    ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1',
    ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR: resolve(directory, 'missing-bridge.json'),
  };
}
