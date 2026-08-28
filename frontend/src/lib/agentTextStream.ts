export type AgentTextStreamMode = 'smooth' | 'catch-up';

export interface AgentTextStreamDrainDecision {
  mode: AgentTextStreamMode;
  characters: number;
  intervalMs: number;
}

interface AgentTextStreamPressure {
  pendingCharacters: number;
  oldestAgeMs: number;
  finishing?: boolean;
  reducedMotion?: boolean;
}

interface AgentTextStreamPumpOptions {
  onCommit: (text: string) => void;
  reducedMotion?: boolean;
  scheduleFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frameId: number) => void;
  now?: () => number;
}

// 生产 SSE 通常每 1.5–2.8 秒交付约 128 个汉字。常态以约
// 60–72 CJK 字/秒持续展开，避免每个网络分片在几十毫秒内整块闪现。
const SMOOTH_CHARACTERS_PER_COMMIT = 3;
const SMOOTH_COMMIT_INTERVAL_MS = 40;
// 只有真正的大积压才进入追赶档；单个正常 SSE 分片不会触发突发渲染。
const CATCH_UP_COMMIT_INTERVAL_MS = 24;
const CATCH_UP_DEPTH_CHARACTERS = 640;
const CATCH_UP_OLDEST_AGE_MS = 6_000;
const CATCH_UP_MIN_CHARACTERS = 16;
const CATCH_UP_MAX_CHARACTERS = 256;
const CATCH_UP_TARGET_COMMITS = 24;
export const AGENT_TEXT_STREAM_DEFAULT_DRAIN_TIMEOUT_MS = 2_500;

/**
 * 将 Codex 的平滑/追赶两档队列转换为浏览器字符提交策略。
 * 常态只提交小字符组；积压变深或变旧时加速，但任何可见帧都保持
 * 有界，避免证据段在 done 前被一次性塞进 Markdown 树。
 */
export function decideAgentTextStreamDrain({
  pendingCharacters,
  oldestAgeMs,
  finishing = false,
  reducedMotion = false,
}: AgentTextStreamPressure): AgentTextStreamDrainDecision {
  const pending = Math.max(0, Math.floor(pendingCharacters));
  if (pending === 0) {
    return {
      mode: 'smooth',
      characters: 0,
      intervalMs: SMOOTH_COMMIT_INTERVAL_MS,
    };
  }

  if (reducedMotion) {
    return {
      mode: 'catch-up',
      characters: pending,
      intervalMs: 0,
    };
  }

  if (
    finishing
    || pending >= CATCH_UP_DEPTH_CHARACTERS
    || oldestAgeMs >= CATCH_UP_OLDEST_AGE_MS
  ) {
    return {
      mode: 'catch-up',
      characters: finishing
        ? Math.min(pending, CATCH_UP_MAX_CHARACTERS)
        : Math.min(
          pending,
          CATCH_UP_MAX_CHARACTERS,
          Math.max(
            CATCH_UP_MIN_CHARACTERS,
            Math.ceil(pending / CATCH_UP_TARGET_COMMITS),
          ),
        ),
      intervalMs: CATCH_UP_COMMIT_INTERVAL_MS,
    };
  }

  return {
    mode: 'smooth',
    characters: Math.min(pending, SMOOTH_CHARACTERS_PER_COMMIT),
    intervalMs: SMOOTH_COMMIT_INTERVAL_MS,
  };
}

function splitAtCodePoint(value: string, characterCount: number): [string, string] {
  if (characterCount <= 0) return ['', value];
  let offset = 0;
  let consumed = 0;
  while (offset < value.length && consumed < characterCount) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    consumed += 1;
  }
  if (offset >= value.length) return [value, ''];
  return [value.slice(0, offset), value.slice(offset)];
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function defaultScheduleFrame(callback: FrameRequestCallback): number {
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(frameId: number): void {
  globalThis.cancelAnimationFrame(frameId);
}

function defaultNow(): number {
  return globalThis.performance.now();
}

/**
 * 传输事件可以任意密集地进入，但 React 最多在一个绘制帧接收一次正文更新。
 * generation 令牌保证 done/取消/卸载后的迟到帧不会覆盖 canonical 消息。
 */
export class AgentTextStreamPump {
  private readonly onCommit: (text: string) => void;
  private readonly reducedMotion: boolean;
  private readonly scheduleFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (frameId: number) => void;
  private readonly now: () => number;
  private pending = '';
  private pendingCharacters = 0;
  private pendingSince = 0;
  private frameId: number | null = null;
  private scheduleGeneration = 0;
  private lastCommitAt: number | null = null;
  private finishing = false;
  private drainWaiters = new Set<() => void>();

  constructor(options: AgentTextStreamPumpOptions) {
    this.onCommit = options.onCommit;
    this.reducedMotion = options.reducedMotion ?? false;
    this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.now = options.now ?? defaultNow;
  }

  enqueue(delta: string): void {
    if (!delta) return;
    if (!this.pending) this.pendingSince = this.now();
    this.pending += delta;
    this.pendingCharacters += countCodePoints(delta);
    this.ensureScheduled();
  }

  /** 立即提交已排队内容，用于没有 canonical 替换的手动收口。 */
  flush(): void {
    this.invalidateScheduledFrame();
    const remaining = this.pending;
    this.resetQueue();
    if (remaining) this.onCommit(remaining);
    this.resolveDrainWaiters();
  }

  /** 作废已排队内容；终态 canonical 消息将接管展示。 */
  discard(): void {
    this.invalidateScheduledFrame();
    this.resetQueue();
    this.resolveDrainWaiters();
  }

  /**
   * 等待当前可见队列按帧播放完成。终态消息必须先 drain 再接管，
   * 否则 done 会把尚未绘制的证据正文整块覆盖到界面上。
   */
  drain(maxWaitMs = AGENT_TEXT_STREAM_DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (!this.pending) return Promise.resolve();
    this.finishing = true;
    this.ensureScheduled();
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.drainWaiters.delete(finish);
        if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
        resolve();
      };
      this.drainWaiters.add(finish);
      timeoutId = globalThis.setTimeout(() => {
        // 后台标签页可能暂停 RAF；超时仅用于终态对账，页面重新可见时
        // 不会继续收到过期帧。
        this.flush();
        finish();
      }, Math.max(0, maxWaitMs));
    });
  }

  private ensureScheduled(): void {
    if (this.frameId !== null || !this.pending) return;
    const generation = this.scheduleGeneration;
    this.frameId = this.scheduleFrame((timestamp) => {
      if (generation !== this.scheduleGeneration) return;
      this.frameId = null;
      this.commitFrame(timestamp);
      this.ensureScheduled();
    });
  }

  private commitFrame(timestamp: number): void {
    if (!this.pending) return;
    const decision = decideAgentTextStreamDrain({
      pendingCharacters: this.pendingCharacters,
      oldestAgeMs: Math.max(0, timestamp - this.pendingSince),
      finishing: this.finishing,
      reducedMotion: this.reducedMotion,
    });

    if (
      this.lastCommitAt !== null
      && timestamp - this.lastCommitAt < decision.intervalMs
    ) return;

    const [visible, remaining] = splitAtCodePoint(
      this.pending,
      decision.characters,
    );
    this.pending = remaining;
    this.pendingCharacters = Math.max(
      0,
      this.pendingCharacters - decision.characters,
    );
    this.lastCommitAt = timestamp;
    if (!remaining) {
      this.pendingSince = 0;
      this.resolveDrainWaiters();
    }
    if (visible) this.onCommit(visible);
  }

  private invalidateScheduledFrame(): void {
    this.scheduleGeneration += 1;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
  }

  private resetQueue(): void {
    this.pending = '';
    this.pendingCharacters = 0;
    this.pendingSince = 0;
    this.lastCommitAt = null;
    this.finishing = false;
  }

  private resolveDrainWaiters(): void {
    if (this.pending || this.drainWaiters.size === 0) return;
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    this.finishing = false;
    waiters.forEach((resolve) => resolve());
  }
}
