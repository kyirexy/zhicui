import { CliError } from './errors.js';
import type { AgentRunEvent, JsonValue } from './types.js';

export interface OutputOptions {
  json: boolean;
  jsonl: boolean;
  quiet: boolean;
}

function safeStringify(value: unknown, pretty = false): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    return item;
  }, pretty ? 2 : 0);
}

export class ProtocolWriter {
  private lastSequence = 0;
  private terminalWritten = false;

  constructor(
    readonly options: OutputOptions,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly stderr: NodeJS.WritableStream = process.stderr,
  ) {}

  result(value: unknown): void {
    if (this.options.quiet && !this.options.json && !this.options.jsonl) return;
    this.stdout.write(`${safeStringify(
      value,
      !this.options.json && !this.options.jsonl,
    )}\n`);
  }

  event(event: AgentRunEvent | JsonValue): void {
    if (
      event
      && typeof event === 'object'
      && !Array.isArray(event)
    ) {
      const value = event as Record<string, unknown>;
      if (typeof value.sequence === 'number' && Number.isInteger(value.sequence)) {
        this.lastSequence = Math.max(this.lastSequence, value.sequence);
      }
      if (value.terminal === true) this.terminalWritten = true;
    }
    this.stdout.write(`${safeStringify(event)}\n`);
  }

  diagnostic(message: string): void {
    if (this.options.quiet) return;
    this.stderr.write(`${message.replace(/[\r\n]+$/u, '')}\n`);
  }

  error(error: CliError): void {
    if (this.options.json || this.options.jsonl) {
      if (this.options.jsonl && this.terminalWritten) return;
      const payload = {
        api_version: 'v1',
        status: 'failed',
        data: null,
        error: error.toPayload(),
      };
      if (this.options.jsonl) this.event({
        sequence: this.lastSequence + 1,
        event: 'error',
        terminal: true,
        ...payload,
      } as unknown as JsonValue);
      else this.result(payload);
      return;
    }
    this.diagnostic(`${error.code}: ${error.message}`);
  }
}
