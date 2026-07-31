import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import type {
  DesktopLoginRequest,
  DesktopLoginResult,
  DesktopLoginStatus,
} from './contract';
import { validateLoginRequest } from './security';

const LOGIN_URL = 'https://www.douyin.com/?showLogin=true';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const MAX_COOKIE_COUNT = 96;
const MAX_COOKIE_NAME_LENGTH = 128;
const MAX_COOKIE_VALUE_LENGTH = 4096;
const MAX_COOKIE_PAYLOAD_BYTES = 64 * 1024;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const AUTH_COOKIE_NAMES = new Set([
  'passport_auth_status',
  'passport_auth_status_ss',
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
]);

type SupportedBrowser = 'chrome' | 'msedge';
type StatusListener = (status: DesktopLoginStatus) => void;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function publicError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (/Executable doesn't exist|browserType\.launchPersistentContext/i.test(detail)) {
    return '未找到可用的 Chrome 或 Edge，请安装浏览器后重试';
  }
  if (/Target page, context or browser has been closed/i.test(detail)) {
    return '登录窗口已关闭';
  }
  return detail.split(/\r?\n/, 1)[0].slice(0, 180) || '抖音登录失败，请重试';
}

function hasAuthenticatedSession(cookies: Record<string, string>): boolean {
  return [...AUTH_COOKIE_NAMES].some((name) => Boolean(cookies[name]));
}

export function boundDouyinCookies(
  input: Array<{ name: string; value: string; domain: string }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const cookie of input) {
    if (Object.keys(result).length >= MAX_COOKIE_COUNT) break;
    const domain = String(cookie.domain || '').toLowerCase();
    if (!(domain === 'douyin.com' || domain.endsWith('.douyin.com'))) continue;
    const name = String(cookie.name || '').trim();
    const value = String(cookie.value || '');
    if (
      !name
      || name.length > MAX_COOKIE_NAME_LENGTH
      || !COOKIE_NAME_PATTERN.test(name)
      || !value
      || value.length > MAX_COOKIE_VALUE_LENGTH
    ) {
      continue;
    }
    const nextBytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes + nextBytes > MAX_COOKIE_PAYLOAD_BYTES) break;
    result[name] = value;
    totalBytes += nextBytes;
  }
  return result;
}

export class DouyinDesktopLogin {
  private activeContext: BrowserContext | null = null;
  private cancelled = false;
  private running: Promise<DesktopLoginResult> | null = null;

  constructor(private readonly notify: StatusListener) {}

  start(rawRequest: DesktopLoginRequest): Promise<DesktopLoginResult> {
    if (this.running) return this.running;
    const request = validateLoginRequest(rawRequest);
    this.cancelled = false;
    this.running = this.run(request).finally(() => {
      this.running = null;
      this.activeContext = null;
    });
    return this.running;
  }

  async cancel(): Promise<DesktopLoginResult> {
    this.cancelled = true;
    const context = this.activeContext;
    if (context) {
      await context.close().catch(() => undefined);
    }
    this.notify({
      stage: 'cancelled',
      message: '已取消抖音登录',
    });
    return { success: false, cancelled: true };
  }

  private async launchBrowser(
    profilePath: string,
  ): Promise<{ context: BrowserContext; browser: SupportedBrowser }> {
    let lastError: unknown;
    for (const browser of ['chrome', 'msedge'] as const) {
      try {
        const context = await chromium.launchPersistentContext(profilePath, {
          channel: browser,
          headless: false,
          locale: 'zh-CN',
          viewport: null,
          args: [
            '--start-maximized',
            '--disable-background-mode',
            '--no-first-run',
            '--no-default-browser-check',
          ],
        });
        return { context, browser };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('未找到可用浏览器');
  }

  private async run(
    request: DesktopLoginRequest,
  ): Promise<DesktopLoginResult> {
    const profilePath = await mkdtemp(join(tmpdir(), 'zhicui-douyin-'));
    this.notify({
      stage: 'starting',
      message: '正在打开本机浏览器…',
    });
    try {
      const launched = await this.launchBrowser(profilePath);
      this.activeContext = launched.context;
      this.notify({
        stage: 'browser-open',
        browser: launched.browser,
        message: launched.browser === 'chrome'
          ? 'Chrome 已打开，请使用手机抖音扫码'
          : 'Edge 已打开，请使用手机抖音扫码',
      });

      const pages = launched.context.pages();
      const page = pages[0] || await launched.context.newPage();
      await page.bringToFront();
      await page.goto(LOGIN_URL, {
        waitUntil: 'commit',
        timeout: 15000,
      }).catch(() => undefined);
      await page.bringToFront().catch(() => undefined);
      this.notify({
        stage: 'waiting',
        browser: launched.browser,
        message: '请在浏览器中完成验证并扫码确认',
      });

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (!this.cancelled && Date.now() < deadline) {
        const rawCookies = await launched.context.cookies();
        const cookies = boundDouyinCookies(rawCookies);
        if (hasAuthenticatedSession(cookies)) {
          this.notify({
            stage: 'submitting',
            browser: launched.browser,
            message: '抖音已确认，正在安全同步登录结果…',
          });
          const response = await fetch(request.callbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Zhicui-Desktop/1.0',
            },
            body: JSON.stringify({
              token: request.token,
              cookies,
            }),
            signal: AbortSignal.timeout(20_000),
          });
          const body = await response.json().catch(() => null) as {
            success?: boolean;
            error?: string;
          } | null;
          if (!response.ok || !body?.success) {
            throw new Error(body?.error || `登录结果同步失败（${response.status}）`);
          }
          this.notify({
            stage: 'success',
            browser: launched.browser,
            message: '抖音登录成功',
          });
          return { success: true };
        }
        await wait(POLL_INTERVAL_MS);
      }

      if (this.cancelled) {
        return { success: false, cancelled: true };
      }
      throw new Error('登录等待超时，请重新扫码');
    } catch (error) {
      if (this.cancelled) {
        return { success: false, cancelled: true };
      }
      const message = publicError(error);
      this.notify({
        stage: 'error',
        message,
      });
      return { success: false, error: message };
    } finally {
      const context = this.activeContext;
      this.activeContext = null;
      if (context) await context.close().catch(() => undefined);
      await rm(profilePath, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 250,
      }).catch(() => undefined);
    }
  }
}
