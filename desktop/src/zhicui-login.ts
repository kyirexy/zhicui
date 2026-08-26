/**
 * 知萃账号 桌面端 ↔ Web 联动登录协调器。
 *
 * 流程：
 *  1. 本地生成一次性随机票据 session_id，向后端登记；
 *  2. 用系统默认浏览器打开 `{webOrigin}/login?desktop=1&session=…`；
 *  3. 网页登录成功后向后端 claim；
 *  4. 本模块轮询 status，拿到已声明的票据后换取 JWT；
 *  5. 通过 onSession 回调把会话交给主进程，注入渲染进程完成登录。
 */

import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type {
  DesktopZhicuiLoginResult,
  DesktopZhicuiLoginStatus,
  DesktopZhicuiSession,
  DesktopZhicuiUser,
} from './contract';

const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type StatusListener = (status: DesktopZhicuiLoginStatus) => void;
type SessionListener = (session: DesktopZhicuiSession) => void;

export class ZhicuiWebLogin {
  private running = false;
  private cancelled = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly webOrigin: () => string,
    private readonly notify: StatusListener,
    private readonly onSession: SessionListener,
  ) {}

  start(): Promise<DesktopZhicuiLoginResult> {
    if (this.running) {
      return Promise.resolve({ success: false, error: '已有网页登录流程进行中' });
    }
    this.running = true;
    this.cancelled = false;
    return this.run();
  }

  cancel(): Promise<DesktopZhicuiLoginResult> {
    this.cancelled = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    this.notify({ stage: 'cancelled', message: '已取消网页登录' });
    return Promise.resolve({ success: false, cancelled: true });
  }

  private async run(): Promise<DesktopZhicuiLoginResult> {
    const origin = this.webOrigin();
    // 与抖音登录一致：统一走前端源，/api 由 Next 代理到后端（dev）或同源 nginx（prod）。
    const apiBase = origin;
    const sessionId = randomBytes(32).toString('base64url');
    try {
      this.notify({ stage: 'starting', message: '正在准备网页登录…' });

      const requestRes = await fetch(
        `${apiBase}/api/auth/desktop-handoff/request`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Zhicui-Desktop/1.0',
          },
          body: JSON.stringify({ session_id: sessionId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!requestRes.ok) {
        throw new Error(`无法发起登录（${requestRes.status}）`);
      }

      const loginUrl = `${origin}/login?desktop=1&session=${sessionId}`;
      await shell.openExternal(loginUrl);
      this.notify({
        stage: 'browser-open',
        message: '已在浏览器中打开登录页，请完成登录',
      });
      this.notify({ stage: 'waiting', message: '等待网页登录完成…' });

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (!this.cancelled && Date.now() < deadline) {
        const outcome = await this.pollOnce(sessionId, apiBase);
        if (outcome === 'retry') {
          await this.wait(POLL_INTERVAL_MS);
          continue;
        }
        this.running = false;
        if (outcome === 'success') {
          return { success: true };
        }
        this.notify({ stage: 'error', message: outcome });
        return { success: false, error: outcome };
      }

      this.running = false;
      if (this.cancelled) {
        return { success: false, cancelled: true };
      }
      this.notify({ stage: 'error', message: '登录等待超时，请返回客户端重新发起' });
      return { success: false, error: '登录等待超时，请返回客户端重新发起' };
    } catch (error) {
      this.running = false;
      const message = error instanceof Error ? error.message : '网页登录失败，请重试';
      this.notify({ stage: 'error', message });
      return { success: false, error: message };
    }
  }

  private async pollOnce(
    sessionId: string,
    apiBase: string,
  ): Promise<'retry' | 'success' | string> {
    try {
      const response = await fetch(
        `${apiBase}/api/auth/desktop-handoff/status/${sessionId}`,
        {
          headers: { 'User-Agent': 'Zhicui-Desktop/1.0' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        data?: {
          status?: string;
          token?: string;
          user?: DesktopZhicuiUser | null;
        };
        error?: string;
        detail?: string;
      } | null;
      if (payload?.success && payload.data?.status === 'success' && payload.data.token) {
        this.notify({ stage: 'success', message: '网页登录成功，正在回到客户端…' });
        this.onSession({
          token: payload.data.token,
          user: payload.data.user ?? {
            id: '',
            email: '',
            username: null,
            is_active: true,
            is_admin: false,
          },
        });
        return 'success';
      }
      if (payload?.success) {
        return 'retry'; // 仍是 pending
      }
      return payload?.error
        || payload?.detail
        || (response.status >= 500
          ? '登录服务暂时异常，请重新发起登录'
          : '登录状态确认失败，请返回客户端重新发起');
    } catch {
      return 'retry'; // 网络抖动，继续轮询
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.pollTimer = setTimeout(resolve, milliseconds) as unknown as NodeJS.Timeout;
    });
  }
}
