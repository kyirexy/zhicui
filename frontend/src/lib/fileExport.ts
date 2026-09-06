import { Capacitor } from '@capacitor/core';
import { exportFilename, shareTemporaryFile, type FileExportResult } from './fileExportCore';

/** 原生客户端通过系统面板保存，网页和桌面端使用浏览器下载。 */
export async function exportFile(blob: Blob, filename: string): Promise<FileExportResult> {
  const safeName = exportFilename(filename);
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = safeName;
      anchor.click();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return 'downloaded';
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'), import('@capacitor/share'),
  ]);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取导出文件，请重试'));
    reader.readAsDataURL(blob);
  });
  const path = `zhicui-exports/${crypto.randomUUID()}/${safeName}`;
  return shareTemporaryFile(
    async () => (await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache, recursive: true })).uri,
    (uri) => Share.share({ title: safeName, files: [uri], dialogTitle: '保存或分享文件' }),
    async () => {
      await Filesystem.deleteFile({ path, directory: Directory.Cache });
      await Filesystem.rmdir({ path: path.slice(0, path.lastIndexOf('/')), directory: Directory.Cache });
    },
  );
}
