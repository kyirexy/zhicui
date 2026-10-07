import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './errors.js';

export async function launchDesktop(descriptor: string): Promise<void> {
  if (process.env.ZHICUI_AUTO_START === '0' || process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR) {
    throw new CliError('DESKTOP_BRIDGE_UNAVAILABLE', '本机自动启动已关闭，请打开知萃后继续原任务');
  }
  let executable = '';
  try {
    const installed = JSON.parse(await readFile(join(dirname(descriptor), 'desktop-agent-launch.json'), 'utf8'));
    if (installed.version === 1 && installed.origin === 'https://luxai.cn') executable = installed.executable;
  } catch { /* 旧版尚未保存启动记录，读取已注册的协议处理程序。 */ }
  if (!executable && process.platform === 'win32') {
    const result = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Classes\\zhicui\\shell\\open\\command', '/ve'],
      { windowsHide: true, timeout: 3000 }).catch(() => null);
    executable = /REG_SZ\s+"([^"]+\.exe)"/i.exec(result?.stdout || '')?.[1] || '';
  }
  if (!executable || !isAbsolute(executable) || !/^(知萃(?:公测版)?\.exe|知萃(?:公测版)?)$/u.test(basename(executable))) {
    throw new CliError('DESKTOP_NOT_INSTALLED', '未找到知萃客户端，请从 https://luxai.cn/download 安装或打开一次新版客户端');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--agent-background'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new CliError('DESKTOP_START_FAILED', '知萃客户端启动失败，请检查安装是否完整')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
