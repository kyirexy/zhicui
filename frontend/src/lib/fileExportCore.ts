export type FileExportResult = 'downloaded' | 'shared' | 'cancelled';

export function exportFilename(filename: string): string {
  return filename.replace(/[\\/\u0000-\u001f:*?"<>|]/g, '_').replace(/^\.+/, '_') || '知萃导出';
}

export async function shareTemporaryFile(
  write: () => Promise<string>,
  share: (uri: string) => Promise<unknown>,
  remove: () => Promise<unknown>,
): Promise<FileExportResult> {
  const uri = await write();
  try {
    await share(uri);
    return 'shared';
  } catch (error) {
    if (error instanceof Error && /^Share cancel(?:ed|led)$/i.test(error.message)) return 'cancelled';
    throw new Error('无法打开保存面板，请稍后重试');
  } finally {
    // 清理失败不能覆盖原本的保存结果，缓存仍受系统沙箱保护。
    await remove().catch(() => undefined);
  }
}
