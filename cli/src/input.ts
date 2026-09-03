import { usageError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';
import { isJsonObject } from './types.js';

export async function readStdin(maxBytes = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) throw usageError('stdin 超过安全上限');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readSecretFromStdin(
  nonInteractive: boolean,
  prompt: string,
): Promise<string> {
  if (!process.stdin.isTTY) {
    const value = (await readStdin(64 * 1024)).trim();
    if (!value) throw usageError('stdin 中没有凭据');
    return value;
  }
  if (nonInteractive) {
    throw usageError('非交互模式需要通过 stdin 提供凭据');
  }
  if (typeof process.stdin.setRawMode !== 'function') {
    throw usageError('当前终端不支持无回显输入，请通过 stdin 提供凭据');
  }
  process.stderr.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(usageError('已取消凭据输入'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          if (!value.trim()) reject(usageError('凭据不能为空'));
          else resolve(value.trim());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (value.length < 64 * 1024) {
          value += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function readSecretsFromStdin(
  nonInteractive: boolean,
  prompts: string[],
): Promise<string[]> {
  if (!process.stdin.isTTY) {
    const raw = await readStdin(64 * 1024);
    if (/^\s*[\[{]/u.test(raw)) {
      throw usageError('安全输入不接受 JSON；请按提示每行输入一个秘密值');
    }
    const values = raw.replace(/\r\n/gu, '\n').split('\n');
    while (values.length && !values[values.length - 1]) values.pop();
    if (values.length !== prompts.length || values.some((value) => !value)) {
      throw usageError(`安全输入需要恰好 ${prompts.length} 行非空内容`);
    }
    return values;
  }
  const result: string[] = [];
  for (const prompt of prompts) {
    result.push(await readSecretFromStdin(nonInteractive, prompt));
  }
  return result;
}

function parseScalar(value: string): JsonValue {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function optionKey(value: string): string {
  return value.slice(2).replace(/-/gu, '_');
}

export async function buildActionInput(
  args: string[],
  positionalKeys: string[] = [],
): Promise<JsonObject> {
  const input = Object.create(null) as JsonObject;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '--input-file' || item.startsWith('--input-file=')) {
      throw usageError('不从文件读取 Action 输入；请通过 stdin 传入 JSON');
    }
    if (item.startsWith('--')) {
      const equals = item.indexOf('=');
      const rawName = equals >= 0 ? item.slice(0, equals) : item;
      const key = optionKey(rawName);
      if (!key) throw usageError(`无效参数：${item}`);
      if (equals >= 0) input[key] = parseScalar(item.slice(equals + 1));
      else if (args[index + 1] && !args[index + 1].startsWith('--')) {
        input[key] = parseScalar(args[index + 1]);
        index += 1;
      } else input[key] = true;
    } else {
      positionals.push(item);
    }
  }

  const raw = !process.stdin.isTTY ? await readStdin() : '';
  if (raw.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw usageError('stdin/input-file 必须是有效 JSON');
    }
    if (!isJsonObject(parsed)) throw usageError('Action 输入必须是 JSON 对象');
    for (const [key, value] of Object.entries(parsed)) input[key] = value;
  }

  for (let index = 0; index < positionals.length; index += 1) {
    const key = positionalKeys[index];
    if (!key) throw usageError(`多余的位置参数：${positionals[index]}`);
    input[key] = parseScalar(positionals[index]);
  }
  return input;
}
