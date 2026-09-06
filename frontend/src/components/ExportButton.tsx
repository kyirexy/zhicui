'use client';

import { useState, useCallback } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import { exportFile } from '@/lib/fileExport';

interface ExportButtonProps {
  targetRef: React.RefObject<HTMLElement | null>;
  filename?: string;
}

export default function ExportButton({
  targetRef,
  filename = 'videocapsule-card',
}: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const handleExport = useCallback(async () => {
    if (!targetRef.current || isExporting) return;

    setIsExporting(true);
    setExportError('');
    const exportInstance = `zhicui-card-${Date.now()}`;
    targetRef.current.dataset.exportInstance = exportInstance;
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(targetRef.current, {
        backgroundColor: '#050505',
        scale: 2,
        useCORS: true,
        logging: false,
        onclone: (clonedDocument) => {
          const clonedTarget = clonedDocument.querySelector(
            `[data-export-instance="${exportInstance}"]`,
          );
          clonedTarget
            ?.closest('.card-workspace__canvas')
            ?.classList.add('is-expanded');
        },
      });

      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error('图片生成失败')), 'image/png',
      ));
      await exportFile(blob, `${filename}.png`);
    } catch {
      setExportError('导出失败，请重试');
    } finally {
      delete targetRef.current?.dataset.exportInstance;
      setIsExporting(false);
    }
  }, [targetRef, filename, isExporting]);

  return (
    <button
      onClick={handleExport}
      disabled={isExporting}
      className="card-workspace__export"
    >
      {isExporting ? (
        <>
          <div className="spinner" />
          <span>导出中...</span>
        </>
      ) : (
        <>
          <DownloadSimple size={16} weight="bold" aria-hidden />
          <span aria-live="polite">{exportError || '导出长图'}</span>
        </>
      )}
    </button>
  );
}
