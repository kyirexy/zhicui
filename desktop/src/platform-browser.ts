import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type BrowserContext } from 'playwright-core';

export type SupportedPlatformBrowser = 'chrome' | 'msedge';
const BROWSER_MARKER = 'ZhicuiBrowser.json';
const execute = promisify(execFile);

/** 只识别受支持的系统默认浏览器，不读取其个人资料目录或登录数据。 */
export function parseWindowsDefaultBrowser(output: string): SupportedPlatformBrowser | undefined {
  const program = /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/mi.exec(output)?.[1];
  if (/^ChromeHTML(?:\.|$)/i.test(program || '')) return 'chrome';
  if (/^MSEdgeHTM(?:\.|$)/i.test(program || '')) return 'msedge';
  return undefined;
}

export async function defaultPlatformBrowser(): Promise<SupportedPlatformBrowser | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const result = await execute('reg.exe', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v', 'ProgId',
    ], { windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024 });
    return parseWindowsDefaultBrowser(result.stdout);
  } catch { return undefined; }
}

export function platformBrowserArgs(background = false): string[] {
  return [
    background ? '--start-minimized' : '--start-maximized',
    '--disable-background-mode',
    // 切回知萃或窗口被遮挡时，官网分页和验证轮询仍需正常运行。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

async function browserCandidates(profilePath: string, preferred: () => Promise<SupportedPlatformBrowser | undefined>): Promise<SupportedPlatformBrowser[]> {
  try {
    const marker = JSON.parse(await readFile(join(profilePath, BROWSER_MARKER), 'utf8')) as { browser?: unknown };
    // 浏览器更换可能使其加密的 Cookie 不可读；已有隔离会话固定原浏览器。
    if (marker.browser === 'chrome' || marker.browser === 'msedge') return [marker.browser];
  } catch { /* 旧版或初次启动没有选择记录。 */ }
  const entries = await readdir(profilePath).catch(() => [] as string[]);
  // 旧会话沿用之前 Chrome 优先的顺序；不因用户改默认浏览器而丢掉已存登录。
  if (entries.includes('Local State') || entries.includes('Default')) return ['chrome', 'msedge'];
  return await preferred() === 'msedge' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
}

interface BrowserDependencies {
  launch?: typeof chromium.launchPersistentContext;
  preferred?: () => Promise<SupportedPlatformBrowser | undefined>;
}

/** 始终使用知萃传入的独立目录；系统偏好只决定浏览器程序，不复用个人浏览器会话。 */
export async function launchIsolatedPlatformBrowser(
  profilePath: string,
  background = false,
  dependencies: BrowserDependencies = {},
): Promise<{ context: BrowserContext; browser: SupportedPlatformBrowser }> {
  const browsers = await browserCandidates(profilePath, dependencies.preferred || defaultPlatformBrowser);
  const launch = dependencies.launch || chromium.launchPersistentContext.bind(chromium);
  let lastError: unknown;
  for (const browser of browsers) {
    try {
      const context = await launch(profilePath, {
        channel: browser, headless: false, locale: 'zh-CN', viewport: null,
        acceptDownloads: false, args: platformBrowserArgs(background),
      });
      await writeFile(join(profilePath, BROWSER_MARKER), JSON.stringify({ browser }), 'utf8').catch(() => undefined);
      return { context, browser };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('未找到可用的 Chrome 或 Edge，请安装浏览器后重试');
}
