import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import type { AgentApiClient } from './api-client.js';
import { CliError, usageError } from './errors.js';

/** 临时文件与目标位于同一目录，通过独占硬链接一次性发布完整文件。 */
export async function downloadLibraryFile(
  client: AgentApiClient,
  noteId: string,
  output: string,
  onProgress?: (bytes: number, totalBytes: number | null) => void,
  beforePublish?: (result: { bytes: number; sha256: string; content_type: string }) => Promise<void>,
): Promise<{ output: string; bytes: number; sha256: string; content_type: string }> {
  const outputPath = resolve(output);
  if (extname(outputPath).toLowerCase() !== '.mp4') throw usageError('下载目标必须是新的 .mp4 文件');
  if (!(await stat(dirname(outputPath)).catch(() => null))?.isDirectory()) {
    throw usageError('下载目标目录不存在，请先创建目录');
  }
  if (await lstat(outputPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) throw new CliError('OUTPUT_EXISTS', '下载目标已存在，知萃不会覆盖现有文件');
  const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.part`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  const digest = createHash('sha256');
  try {
    const downloaded = await client.downloadLibraryMedia(noteId, async (chunk) => {
      await handle.writeFile(chunk);
      digest.update(chunk);
    }, onProgress);
    await handle.sync();
    await handle.close();
    const result = { ...downloaded, sha256: digest.digest('hex') };
    await beforePublish?.(result);
    try {
      // rename 在 POSIX 会覆盖；link 在所有支持的平台均为独占创建。
      await link(temporaryPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliError('OUTPUT_EXISTS', '下载目标已存在，知萃不会覆盖现有文件');
      }
      throw new CliError('OUTPUT_UNAVAILABLE', '无法安全写入下载目标，请使用支持硬链接的本地磁盘目录');
    }
    return { output: outputPath, ...result };
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
