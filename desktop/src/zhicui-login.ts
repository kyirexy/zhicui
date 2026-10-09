/** 网页登录收到票据后，等待主进程持久化成功再完成交接。 */
import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type { DesktopZhicuiLoginResult, DesktopZhicuiLoginStatus, DesktopZhicuiSession } from './contract';

type StatusListener = (status: DesktopZhicuiLoginStatus) => void;
type SessionListener = (session: DesktopZhicuiSession) => Promise<void>;
interface Dependencies {
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}
interface LoginAttempt {
  cancelled: boolean;
  timer?: NodeJS.Timeout;
  wake?: () => void;
  session?: DesktopZhicuiSession;
}

export class ZhicuiWebLogin {
  private active: LoginAttempt | null = null;
  private transport: typeof fetch;
  private openExternal: (url: string) => Promise<void>;
  constructor(
    private readonly webOrigin: () => string,
    private readonly notify: StatusListener,
    private readonly onSession: SessionListener,
    private readonly dependencies: Dependencies = {},
  ) {
    this.transport = dependencies.fetch || fetch;
    this.openExternal = dependencies.openExternal || ((url) => shell.openExternal(url));
  }
  start(): Promise<DesktopZhicuiLoginResult> {
    if (this.active) return Promise.resolve({ success: false, error: '已有网页登录流程进行中' });
    const attempt: LoginAttempt = { cancelled: false };
    this.active = attempt;
    return this.run(attempt).finally(() => { if (this.active === attempt) this.active = null; });
  }
  cancel(): Promise<DesktopZhicuiLoginResult> {
    const attempt = this.active;
    if (attempt) {
      attempt.cancelled = true;
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.wake?.();
      this.active = null;
    }
    this.notify({ stage: 'cancelled', message: '已取消网页登录' });
    return Promise.resolve({ success: false, cancelled: true });
  }
  private async run(attempt: LoginAttempt): Promise<DesktopZhicuiLoginResult> {
    const origin = this.webOrigin();
    const sessionId = randomBytes(32).toString('base64url');
    try {
      this.notify({ stage: 'starting', message: '正在准备网页登录…' });
      const response = await this.transport(`${origin}/api/auth/desktop-handoff/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Zhicui-Desktop/1.0' },
        body: JSON.stringify({ session_id: sessionId }), signal: AbortSignal.timeout(15_000),
      });
      if (attempt.cancelled) return { success: false, cancelled: true };
      if (!response.ok) throw new Error(`无法发起登录（${response.status}）`);
      await this.openExternal(`${origin}/login?desktop=1&session=${sessionId}`);
      if (attempt.cancelled) return { success: false, cancelled: true };
      this.notify({ stage: 'browser-open', message: '已在浏览器中打开登录页，请完成登录' });
      this.notify({ stage: 'waiting', message: '等待网页登录完成…' });
      const deadline = Date.now() + (this.dependencies.timeoutMs ?? 5 * 60 * 1000);
      while (!attempt.cancelled && Date.now() < deadline) {
        // 票据已被服务端消费；交接暂时失败时重试同一凭据，不能重新轮询或要求用户再登录。
        if (!attempt.session) attempt.session = await this.pollOnce(sessionId, origin) || undefined;
        if (attempt.cancelled) break;
        if (attempt.session) {
          try {
            await this.onSession(attempt.session);
            if (attempt.cancelled) break;
            this.notify({ stage: 'success', message: '登录已安全保存，正在回到客户端…' });
            return { success: true };
          } catch (error) {
            if (/SESSION_(INVALID|REVOKED|EXPIRED|CHANGED)|ACCOUNT_DISABLED/.test(String(error))) throw error;
            this.notify({ stage: 'waiting', message: '网页登录已确认，正在保存客户端连接，无需再次登录…' });
          }
        }
        await this.wait(attempt, this.dependencies.pollIntervalMs ?? 1500);
      }
      if (attempt.cancelled) return { success: false, cancelled: true };
      throw new Error(attempt.session ? '网页登录已确认，客户端连接暂未保存，请稍后重试恢复' : '登录等待超时，请返回客户端重新发起');
    } catch (error) {
      if (attempt.cancelled) return { success: false, cancelled: true };
      const message = error instanceof Error ? error.message : '网页登录失败，请重试';
      this.notify({ stage: 'error', message });
      return { success: false, error: message };
    }
  }
  private async pollOnce(sessionId: string, origin: string): Promise<DesktopZhicuiSession | null> {
    let response: Response;
    try {
      response = await this.transport(`${origin}/api/auth/desktop-handoff/status/${sessionId}`, {
        headers: { 'User-Agent': 'Zhicui-Desktop/1.0' }, signal: AbortSignal.timeout(15_000),
      });
    } catch { return null; }
    if (response.status >= 500 || response.status === 429) return null;
    const payload = await response.json().catch(() => null) as {
      success?: boolean; data?: DesktopZhicuiSession & { status?: string }; error?: string; detail?: string;
    } | null;
    if (payload?.success && payload.data?.status === 'success' && payload.data.token) return payload.data;
    if (payload?.success && payload.data?.status === 'pending') return null;
    throw new Error(payload?.error || (typeof payload?.detail === 'string' ? payload.detail : '登录状态确认失败，请返回客户端重新发起'));
  }
  private wait(attempt: LoginAttempt, milliseconds: number): Promise<void> {
    if (attempt.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      attempt.wake = resolve;
      attempt.timer = setTimeout(() => { attempt.timer = undefined; attempt.wake = undefined; resolve(); }, milliseconds);
    });
  }
}
