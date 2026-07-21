'use client';

import { useState, useCallback } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';

interface ExportButtonProps {
  targetRef: React.RefObject<HTMLElement | null>;
  filename?: string;
}

export default function ExportButton({
  targetRef,
  filename = 'videocapsule-card',
}: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (!targetRef.current || isExporting) return;

    setIsExporting(true);
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

      const link = document.createElement('a');
      link.download = `${filename}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (error) {
      console.error('Export failed:', error);
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
          <span>导出长图</span>
        </>
      )}
    </button>
  );
}
