import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './errors.js';

// reg.exe 使用系统代码页输出，默认 UTF-8 解码会破坏“知萃.exe”等中文路径。
// 注册表命令通过 UTF-8 Base64 传回；合并视图同时兼容当前用户与全机安装。
export async function readWindowsDesktopExecutable(): Promise<string> {
  const script = "$ErrorActionPreference='Stop';"
    + "$command=(Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\zhicui\\shell\\open\\command').GetValue('');"
    + '[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$command)))';
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 }).catch(() => null);
  const command = Buffer.from(result?.stdout.trim() || '', 'base64').toString('utf8');
  return /^\s*"([^"]+\.exe)"(?:\s|$)/i.exec(command)?.[1] || '';
}

async function installedExecutable(path: unknown): Promise<boolean> {
  return typeof path === 'string' && isAbsolute(path)
    && /^(知萃(?:公测版)?\.exe|知萃(?:公测版)?)$/u.test(basename(path))
    && Boolean(await stat(path).then((item) => item.isFile()).catch(() => false));
}

export async function findDesktopExecutable(descriptor: string): Promise<string> {
  let executable = '';
  try {
    const installed = JSON.parse(await readFile(join(dirname(descriptor), 'desktop-agent-launch.json'), 'utf8'));
    if (installed.version === 1 && installed.origin === 'https://luxai.cn'
        && await installedExecutable(installed.executable)) executable = installed.executable;
  } catch { /* 旧版尚未保存启动记录，读取已注册的协议处理程序。 */ }
  if (!executable && process.platform === 'win32') executable = await readWindowsDesktopExecutable();
  if (!await installedExecutable(executable)) {
    throw new CliError('DESKTOP_NOT_INSTALLED', '未找到知萃客户端，请从 https://luxai.cn/download 安装或打开一次新版客户端');
  }
  return executable;
}

export async function launchDesktop(descriptor: string): Promise<void> {
  if (process.env.ZHICUI_AUTO_START === '0' || process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR) {
    throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '本机自动启动已关闭，请打开知萃后继续原任务');
  }
  const executable = await findDesktopExecutable(descriptor);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--agent-background'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new CliError('DESKTOP_START_FAILED', '知萃客户端启动失败，请检查安装是否完整')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
