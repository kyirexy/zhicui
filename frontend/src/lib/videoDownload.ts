export type VideoDownloadProgress = {
  receivedBytes: number;
  totalBytes: number | null;
};

const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export function videoDownloadFilename(title: string): string {
  const name = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 100);
  const safeName = name && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? name : '知萃视频';
  return `${safeName.replace(/\.mp4$/i, '')}.mp4`;
}

export function videoDownloadError(status: number, payload: unknown): string {
  if (status === 401) return '登录已失效，请重新登录后下载';
  if (status === 403) return '当前账号没有这条视频的下载权限';
  if (status === 404) return '这条视频资料不存在，请重新解析链接';
  if (status === 429) return '下载请求较多，请稍后再试';
  const value = payload && typeof payload === 'object' && 'error' in payload ? payload.error : '';
  // 只显示服务端的中文提示，不把上游链接、密钥或调试堆栈带到页面。
  if (typeof value === 'string' && value.length <= 240 && /[\u4e00-\u9fff]/.test(value)
    && !/https?:\/\/|Bearer\s|zhc_pat_|traceback|Error invoking/i.test(value)) return value;
  return '视频暂时无法下载，请稍后重试';
}

/** 验证完整 MP4 后才交给保存流程，避免把错误页或中断文件保存成视频。 */
export async function readVideoDownload(
  response: Response,
  onProgress?: (progress: VideoDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!response.ok) {
    throw new Error(videoDownloadError(response.status, await response.json().catch(() => null)));
  }
  const contentType = response.headers.get('Content-Type')?.split(';')[0].trim();
  if (contentType !== 'video/mp4') {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('没有取得有效的视频文件，请稍后重试');
  }
  const length = Number(response.headers.get('Content-Length'));
  const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : null;
  if (totalBytes && totalBytes > MAX_VIDEO_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('视频超过 512 MB，暂时无法下载');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('当前浏览器无法下载视频，请使用最新版浏览器重试');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let receivedBytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  onProgress?.({ receivedBytes, totalBytes });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_VIDEO_BYTES) throw new Error('视频超过 512 MB，暂时无法下载');
      chunks.push(new Uint8Array(value));
      onProgress?.({ receivedBytes, totalBytes });
    }
    if (!receivedBytes || (totalBytes !== null && receivedBytes !== totalBytes)) {
      throw new Error('视频下载中断，文件尚未保存，请重新下载');
    }
    const blob = new Blob(chunks, { type: 'video/mp4' });
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') {
      throw new Error('视频文件校验失败，请重新下载');
    }
    signal?.throwIfAborted();
    return blob;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
