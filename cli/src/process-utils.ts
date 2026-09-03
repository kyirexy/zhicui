import { spawn } from 'node:child_process';
import { CliError, EXIT_CODES } from './errors.js';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
    allowFailure?: boolean;
    maxOutputBytes?: number;
  } = {},
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 30_000);
    timer.unref?.();

    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliError('LOCAL_CAPABILITY_UNAVAILABLE', `无法启动 ${command}`, {
        exitCode: EXIT_CODES.localUnavailable,
        cause: error,
      }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (timedOut) {
        reject(new CliError('TIMEOUT', `${command} 执行超时`, {
          exitCode: EXIT_CODES.timeoutOrCanceled,
        }));
      } else if (outputBytes > maxOutputBytes) {
        reject(new CliError('REMOTE_FAILURE', `${command} 输出超过安全上限`));
      } else if (result.code !== 0 && !options.allowFailure) {
        reject(new CliError('LOCAL_CAPABILITY_UNAVAILABLE', `${command} 执行失败`, {
          exitCode: EXIT_CODES.localUnavailable,
        }));
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function redactedProcessMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer <redacted>')
    .replace(/(?:pat|token|secret|api[_-]?key)[=:]\s*\S+/giu, '<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 500);
}
