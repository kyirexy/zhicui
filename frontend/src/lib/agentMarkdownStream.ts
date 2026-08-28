import { parseMarkdownIntoBlocks } from 'streamdown';

export type AgentMarkdownBlockParser = (markdown: string) => string[];

export interface AgentMarkdownStreamSnapshot {
  /** 只追加、不再变化的 Markdown 片段；引用在下一次定稿前保持稳定。 */
  stableChunks: readonly string[];
  /** 当前仍可能被后续字符改写语义的尾部，流式阶段按纯文本显示。 */
  tail: string;
}

/**
 * Codex 式“稳定前缀 + 活动尾部”缓冲器。
 *
 * 普通字符只追加到 tail，不运行 Markdown 解析，也不复制历史块数组；
 * 只有换行可能形成新块时才解析当前尾部，并把确认稳定的前缀追加为
 * 独立 chunk。终态由完整的静态 Markdown 渲染器一次性接管。
 */
export class AgentMarkdownStreamBuffer {
  private stableChunks: readonly string[] = [];
  private tail = '';
  private boundaryPending = false;
  private readonly parseBlocks: AgentMarkdownBlockParser;

  constructor(
    initialContent = '',
    parseBlocks: AgentMarkdownBlockParser = parseMarkdownIntoBlocks,
  ) {
    this.parseBlocks = parseBlocks;
    if (initialContent) this.append(initialContent);
  }

  append(delta: string): AgentMarkdownStreamSnapshot {
    if (!delta) return this.snapshot();
    const boundaryWasPending = this.boundaryPending;
    this.tail += delta;

    // Markdown 块边界由换行形成；若上一帧刚以空行结尾，则下一字符
    // 到来时再判断前一块是否已经可以定稿。
    if (delta.includes('\n') || boundaryWasPending) {
      this.settleStablePrefix();
    }
    // 只检查固定长度的活动后缀，避免长段落每帧反向扫描全文。
    this.boundaryPending = /\n[\t ]*\n$/.test(this.tail.slice(-128));
    return this.snapshot();
  }

  snapshot(): AgentMarkdownStreamSnapshot {
    return {
      stableChunks: this.stableChunks,
      tail: this.tail,
    };
  }

  private settleStablePrefix(): void {
    const blocks = this.parseBlocks(this.tail);
    if (blocks.length <= 1) return;

    let stableLength = 0;
    for (let index = 0; index < blocks.length - 1; index += 1) {
      stableLength += blocks[index].length;
    }
    if (stableLength <= 0) return;

    const stableText = this.tail.slice(0, stableLength);
    // 纯空白只是下一个块的前导间距，跟随 tail 才不会在拆分渲染时
    // 丢失段落关系。
    if (!stableText.trim()) return;

    this.stableChunks = [...this.stableChunks, stableText];
    this.tail = this.tail.slice(stableLength);
  }
}
