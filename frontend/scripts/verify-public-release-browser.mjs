import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = (process.env.PUBLIC_RELEASE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const publicPaths = ['/', '/download', '/legal/terms', '/legal/privacy', '/support', '/platform-limits'];
const widths = [320, 390];

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const browser = candidates.find((candidate) => existsSync(candidate));
  if (!browser) throw new Error('未找到 Chrome/Edge；可通过 CHROME_PATH 指定浏览器');
  return browser;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDebugPort(profileDirectory) {
  const portFile = join(profileDirectory, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      if (port) return Number(port);
    }
    await delay(100);
  }
  throw new Error('浏览器调试端口启动超时');
}

class CdpSession {
  constructor(url) {
    this.sequence = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function navigate(session, url) {
  await session.call('Page.navigate', { url });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await session.call('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (state.result.value === 'complete') {
      await session.call('Runtime.evaluate', {
        expression: 'new Promise((resolve) => setTimeout(resolve, 350))',
        awaitPromise: true,
      });
      return;
    }
    await delay(50);
  }
  throw new Error(`页面加载超时：${url}`);
}

async function auditPage(session, path, width) {
  await session.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await navigate(session, `${baseUrl}${path}?release_contract=${Date.now()}`);
  const result = await session.call('Runtime.evaluate', {
    expression: `(() => {
      const root = document.documentElement;
      const body = document.body;
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const rectInsideViewport = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= innerWidth + 1;
      };
      const publicActions = [...document.querySelectorAll(
        'a[href="/#download"], a[href^="/api/downloads"], aside nav a, footer nav a'
      )].filter(visible);
      const unnamedControls = [...document.querySelectorAll('button, input')]
        .filter(visible)
        .filter((node) => !(
          node.getAttribute('aria-label')
          || node.getAttribute('aria-labelledby')
          || (node.id && document.querySelector('label[for="' + CSS.escape(node.id) + '"]'))
          || node.textContent?.trim()
          || node.getAttribute('placeholder')
        ));
      const download = document.querySelector('#download');
      return {
        title: document.querySelector('h1')?.textContent?.trim() || '',
        viewportWidth: innerWidth,
        documentWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
        overflowingActions: publicActions
          .filter((node) => node.getBoundingClientRect().height < 44 || !rectInsideViewport(node))
          .map((node) => ({ text: node.textContent?.trim(), rect: node.getBoundingClientRect().toJSON() })),
        unnamedControlCount: unnamedControls.length,
        downloadInside: download ? rectInsideViewport(download) : true,
      };
    })()`,
    returnByValue: true,
  });
  return result.result.value;
}

let browserProcess;
let profileDirectory;
let session;

try {
  for (const path of publicPaths) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    if (response.status >= 400) throw new Error(`${path} 返回 HTTP ${response.status}`);
  }

  profileDirectory = mkdtempSync(join(tmpdir(), 'zhicui-public-release-'));
  browserProcess = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const port = await waitForDebugPort(profileDirectory);
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await targetResponse.json();
  session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  await session.call('Page.enable');
  await session.call('Runtime.enable');

  const failures = [];
  for (const width of widths) {
    for (const path of ['/', '/legal/terms', '/legal/privacy', '/support', '/platform-limits']) {
      const audit = await auditPage(session, path, width);
      if (audit.viewportWidth !== width) failures.push(`${path}@${width}: 实际视口 ${audit.viewportWidth}`);
      if (audit.documentWidth > width + 1) failures.push(`${path}@${width}: 页面宽 ${audit.documentWidth}`);
      if (!audit.title) failures.push(`${path}@${width}: 缺少可见 H1`);
      if (!audit.downloadInside) failures.push(`${path}@${width}: 下载区超出视口`);
      if (audit.overflowingActions.length) {
        failures.push(`${path}@${width}: 操作小于 44px 或超出视口 ${JSON.stringify(audit.overflowingActions)}`);
      }
      if (audit.unnamedControlCount) failures.push(`${path}@${width}: ${audit.unnamedControlCount} 个控件缺少可访问名称`);
    }
  }
  if (failures.length) throw new Error(`真实浏览器契约失败：\n- ${failures.join('\n- ')}`);
  process.stdout.write(`真实浏览器契约通过：${widths.join('/')}px，${publicPaths.length} 个公开路由。\n`);
} finally {
  if (platform() === 'win32' && browserProcess?.pid) {
    spawnSync('taskkill', ['/PID', String(browserProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } else if (session) {
    try { await session.call('Browser.close'); } catch { /* process kill below is the fallback */ }
  }
  session?.close();
  if (browserProcess && browserProcess.exitCode === null) {
    if (platform() !== 'win32') browserProcess.kill();
    await Promise.race([
      new Promise((resolve) => browserProcess.once('exit', resolve)),
      delay(2_000),
    ]);
  }
  if (profileDirectory) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(profileDirectory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) {
          process.stderr.write(`警告：浏览器临时目录将在系统清理时移除（${error.code || 'unknown'}）。\n`);
          break;
        }
        await delay(200);
      }
    }
  }
}
