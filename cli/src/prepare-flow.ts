import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError, usageError } from './errors.js';
import type { JsonObject } from './types.js';

export const VIDEO_PREPARE_SCOPES = ['account:read', 'library:read', 'library:write'];
export const PREPARE_AUTH_ERRORS = new Set(['AUTH_REQUIRED', 'AUTHENTICATION_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'INVALID_CREDENTIAL', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'REFRESH_TOKEN_EXPIRED', 'SCOPE_DENIED']);

export function normalizePrepareLink(value: string): string {
  const links = value.match(/https?:\/\/[^\s<>"「」]+/gu) || [];
  if (links.length !== 1) throw usageError('请粘贴一条抖音或 B站链接，也可以粘贴整段分享文字');
  let url: URL;
  try { url = new URL(links[0].replace(/[，。！？、；：）》】\]),.!?;]+$/u, '')); }
  catch { throw usageError('没有识别到有效的视频链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(^|\.)(douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv)$/u.test(url.hostname)) {
    throw usageError('请使用 HTTPS 抖音或 B站视频链接');
  }
  return url.href;
}

export async function prepareDestination(url: string, origin: string, profile: string, output: string | undefined, resume: boolean) {
  if (output) return { output: resolve(output), resume };
  const root = resolve('zhicui-media');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(JSON.stringify([origin, profile, url])).digest('hex').slice(0, 20);
  const directory = resolve(root, key);
  const saved = await lstat(resolve(directory, '.zhicui-prepare.json')).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  return { output: directory, resume: resume || saved };
}

export function prepareProgressLabel(stage: string, data: JsonObject): string {
  const labels: Record<string, string> = { check: '检查连接与权限', import: '1/3 识别并导入视频', transcript: '2/3 提取文稿', download: '3/3 下载视频', ready: '素材已就绪，可交给 Hypit' };
  const bytes = typeof data.bytes === 'number' ? ` · 已下载 ${(data.bytes / 1024 / 1024).toFixed(1)} MB` : '';
  const total = typeof data.total_bytes === 'number' && data.total_bytes > 0 ? ` / ${(data.total_bytes / 1024 / 1024).toFixed(1)} MB` : '';
  return `${labels[stage] || stage}${bytes}${total}`;
}

export function prepareRecovery(error: CliError, input: { url: string; output: string; resume: boolean; profile: string }): CliError {
  const auth = PREPARE_AUTH_ERRORS.has(error.code);
  const platform = error.code === 'PLATFORM_AUTH_REQUIRED';
  const instructions = auth ? '请确认浏览器授权，完成后原任务会继续。'
    : platform ? '抖音或 B站限制了这条视频的读取；账号已连接也可能遇到此限制。请在知萃检查平台连接并完成平台要求的验证，再继续原任务，暂时不要连续重试。'
    : '已完成的步骤会保留，可以继续原任务。';
  const args = ['library', 'prepare', input.url, '--output', input.output, '--profile', input.profile,
    ...(input.resume ? ['--resume'] : []), ...(auth ? ['--connect'] : [])];
  const command = `zhicui ${args.map((part) => `'${part.replace(/'/gu, "''")}'`).join(' ')}`;
  return new CliError(error.code, `${error.message}\n${instructions}\n继续任务：${command}`, {
    exitCode: error.exitCode, retryAfterSeconds: error.retryAfterSeconds,
    details: { next_step: auth ? 'authorize' : platform ? 'check_platform' : 'resume',
      help_url: platform ? 'https://luxai.cn/library?sync=1' : 'https://luxai.cn/agent-access',
      resume_command: command, resume_argv: args, directory: input.output },
  });
}
