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
    if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  return value;
}

function parseArgument(value: string, schema: JsonValue | undefined): JsonValue {
  if (!isJsonObject(schema)) return parseScalar(value);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === 'null' && types.includes('null')) return null;
  // 视频 ID、标题和问题必须保留原文，尤其不能把 19 位抖音 ID 转为浮点数。
  if (types.includes('string')) return value;
  if (types.includes('array') || types.includes('object')) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch {
      throw usageError('数组或对象参数必须是有效 JSON，也可以通过 stdin 传入完整 JSON 对象');
    }
    if (types.includes('array') && Array.isArray(parsed)) return parsed as JsonValue;
    if (types.includes('object') && isJsonObject(parsed)) return parsed;
    throw usageError('参数 JSON 类型与 Action Schema 不一致');
  }
  const parsed = parseScalar(value);
  if (types.includes('integer') && typeof parsed === 'number' && Number.isSafeInteger(parsed)) return parsed;
  if (types.includes('number') && typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  if (types.includes('boolean') && typeof parsed === 'boolean') return parsed;
  if (types.some((type) => ['integer', 'number', 'boolean', 'null'].includes(String(type)))) {
    throw usageError('参数类型与 Action Schema 不一致，整数必须在 JavaScript 安全精度范围内');
  }
  return parsed;
}

function optionKey(value: string): string {
  return value.slice(2).replace(/-/gu, '_');
}

export async function buildActionInput(
  args: string[],
  positionalKeys: string[] = [],
  schema: JsonObject = {},
): Promise<JsonObject> {
  const input = Object.create(null) as JsonObject;
  const positionals: string[] = [];
  const properties = isJsonObject(schema.properties) ? schema.properties : {};

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
      if (equals >= 0) input[key] = parseArgument(item.slice(equals + 1), properties[key]);
      else if (args[index + 1] && !args[index + 1].startsWith('--')) {
        input[key] = parseArgument(args[index + 1], properties[key]);
        index += 1;
      } else {
        const property = properties[key];
        const type = isJsonObject(property) ? property.type : undefined;
        if (type && type !== 'boolean' && !(Array.isArray(type) && type.includes('boolean'))) {
          throw usageError(`${rawName} 需要一个值`);
        }
        input[key] = true;
      }
    } else {
      positionals.push(item);
    }
  }

  const raw = !process.stdin.isTTY ? await readStdin() : '';
  if (raw.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw usageError('stdin 必须是有效 JSON');
    }
    if (!isJsonObject(parsed)) throw usageError('Action 输入必须是 JSON 对象');
    for (const [key, value] of Object.entries(parsed)) input[key] = value;
  }

  for (let index = 0; index < positionals.length; index += 1) {
    const key = positionalKeys[index];
    if (!key) throw usageError(`多余的位置参数：${positionals[index]}`);
    input[key] = parseArgument(positionals[index], properties[key]);
  }
  return input;
}
