'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Download, Smartphone, Globe } from 'lucide-react';

export default function QRModal() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    setMounted(true);
    setUrl(window.location.origin);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleEsc);
    // Prevent body scroll while modal is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [open]);

  const trigger = (
    <button
      onClick={() => setOpen(true)}
      className="relative p-2.5 cursor-pointer rounded-xl bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.1] transition-all duration-300 min-w-[40px] min-h-[40px] flex items-center justify-center"
      aria-label="手机扫码访问"
      title="手机扫码访问"
    >
      <Smartphone size={17} className="text-foreground-muted" />
    </button>
  );

  const modal = open && mounted ? createPortal(
    <div className="qr-portal-root">
      {/* Backdrop */}
      <div
        className="qr-backdrop"
        onClick={() => setOpen(false)}
      />

      {/* Modal panel */}
      <div className="qr-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Smartphone size={16} className="text-accent-emerald" />
            手机扫码访问
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/8 hover:bg-white/15 transition-colors text-white/60 hover:text-white"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6 pt-3 space-y-5">
          {/* APK Download QR */}
          <div className="bg-white rounded-2xl p-5 text-center shadow-xl">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
              <Download size={11} className="inline mr-1" />
              Android APK 下载
            </p>
            <div className="inline-block">
              {url && (
                <QRCodeSVG
                  value={`${url}/download/zhicui.apk`}
                  size={180}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#111827"
                  imageSettings={{
                    src: '/icons/icon-192.png',
                    height: 36,
                    width: 36,
                    excavate: true,
                  }}
                />
              )}
            </div>
            <a
              href="/download/zhicui.apk"
              download
              className="mt-4 mx-auto btn-primary btn-magnetic inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium"
            >
              <Download size={14} />
              直接下载 APK
            </a>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-white/40">或</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* Web version QR */}
          <div className="bg-white rounded-xl p-4 text-center shadow-lg">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              <Globe size={11} className="inline mr-1" />
              网页版
            </p>
            <div className="inline-block">
              {url && (
                <QRCodeSVG
                  value={url}
                  size={120}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#111827"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {trigger}
      {modal}
    </>
  );
}
