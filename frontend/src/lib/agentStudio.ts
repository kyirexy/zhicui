import type { AgentMessage, LibraryOutputStyle } from './types';

const STUDIO_RESULT_LABELS: Record<LibraryOutputStyle, string> = {
  answer: '回答摘录',
  summary: '完整总结',
  comparison: '差异对比',
  action_plan: '行动方案',
  custom: '自定义成果',
};

const OUTPUT_STYLES: ReadonlySet<LibraryOutputStyle> = new Set([
  'answer',
  'summary',
  'comparison',
  'action_plan',
  'custom',
]);

const DEFAULT_TITLE_LENGTH = 42;
const DEFAULT_PREVIEW_LENGTH = 132;

export interface AgentStudioResult {
  id: string;
  type: LibraryOutputStyle;
  label: string;
  title: string;
  preview: string;
  content: string;
  createdAt: string;
  sourceCount: number;
  evidenceCount: number;
  isArtifact: boolean;
  message: AgentMessage;
}

function isLibraryOutputStyle(value: unknown): value is LibraryOutputStyle {
  return typeof value === 'string'
    && OUTPUT_STYLES.has(value as LibraryOutputStyle);
}

function messageOutputStyle(message: AgentMessage): LibraryOutputStyle {
  const outputStyle = message.source_context?.output_style
    ?? message.result?.source_context?.output_style;

  // Messages saved before output styles were introduced remain useful as
  // ordinary answer excerpts in the studio.
  return isLibraryOutputStyle(outputStyle) ? outputStyle : 'answer';
}

function contentFrom(input: string | AgentMessage): string {
  return typeof input === 'string' ? input : input.content;
}

function truncatePlainText(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';

  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength === 1) return '…';
  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/**
 * Turns persisted Markdown into inert, single-line text for titles and list
 * previews. Markdown URLs and raw HTML are deliberately discarded rather
 * than copied into the visible summary.
 */
export function studioMarkdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s*(```+|~~~+).*$/gm, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/\\([\\`*{}\[\]()#+.!_>~-])/g, '$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function studioResultTypeLabel(type: LibraryOutputStyle): string {
  return STUDIO_RESULT_LABELS[type];
}

export function studioResultTitle(
  input: string | AgentMessage,
  type?: LibraryOutputStyle,
): string {
  const resolvedType = type
    ?? (typeof input === 'string' ? 'answer' : messageOutputStyle(input));
  const firstMeaningfulLine = contentFrom(input)
    .split(/\r?\n/)
    .map((line) => studioMarkdownToPlainText(line))
    .find(Boolean);

  return firstMeaningfulLine
    ? truncatePlainText(firstMeaningfulLine, DEFAULT_TITLE_LENGTH)
    : studioResultTypeLabel(resolvedType);
}

export function studioResultPreview(
  input: string | AgentMessage,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string {
  return truncatePlainText(
    studioMarkdownToPlainText(contentFrom(input)),
    maxLength,
  );
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function sourceCountFor(message: AgentMessage): number {
  const sourceContext = message.source_context
    ?? message.result?.source_context;
  const explicitCount = nonNegativeInteger(sourceContext?.context_note_count);
  if (explicitCount !== undefined) return explicitCount;

  if (sourceContext?.sources) return sourceContext.sources.length;
  const scannedCount = nonNegativeInteger(sourceContext?.note_count);
  if (scannedCount !== undefined) return scannedCount;
  if (message.result?.note_ids) return message.result.note_ids.length;

  const evidence = message.evidence ?? message.result?.evidence ?? [];
  return new Set(evidence.map((item) => item.note_id).filter(Boolean)).size;
}

function evidenceCountFor(message: AgentMessage): number {
  return Math.max(
    message.evidence?.length ?? 0,
    message.result?.evidence?.length ?? 0,
  );
}

function createdAtTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function deriveAgentStudioResults(
  messages: readonly AgentMessage[],
): AgentStudioResult[] {
  return messages
    .flatMap((message, index) => {
      if (message.role !== 'assistant') return [];

      const type = messageOutputStyle(message);
      return [{
        result: {
          id: message.id,
          type,
          label: studioResultTypeLabel(type),
          title: studioResultTitle(message, type),
          preview: studioResultPreview(message),
          content: message.content,
          createdAt: message.created_at,
          sourceCount: sourceCountFor(message),
          evidenceCount: evidenceCountFor(message),
          isArtifact: type !== 'answer',
          message,
        } satisfies AgentStudioResult,
        index,
      }];
    })
    .sort((left, right) => {
      const timeDifference = createdAtTimestamp(right.result.createdAt)
        - createdAtTimestamp(left.result.createdAt);
      return timeDifference || right.index - left.index;
    })
    .map(({ result }) => result);
}
