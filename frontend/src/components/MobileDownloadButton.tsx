'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Download, Smartphone, Globe, ArrowRight } from 'lucide-react';

export default function MobileDownloadButton() {
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
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [open]);

  const trigger = (
    <div className="w-full max-w-2xl mx-auto px-4 pt-5 md:pt-6">
      <button
        onClick={() => setOpen(true)}
        className="bezel-outer w-full btn-magnetic cursor-pointer group"
      >
        <div className="bezel-inner">
          <div className="p-4 md:p-5 flex items-center gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-accent-emerald/10 border border-accent-emerald/15 flex items-center justify-center group-hover:bg-accent-emerald/20 transition-all duration-500">
              <Download size={22} className="text-accent-emerald" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-semibold text-foreground">下载手机客户端</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                扫码安装，随时随地提取知识卡片
              </p>
            </div>
            <ArrowRight size={18} className="text-foreground-muted group-hover:translate-x-0.5 transition-transform duration-300" />
          </div>
        </div>
      </button>
    </div>
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
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Download size={16} className="text-accent-emerald" />
            下载知萃
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-100 hover:bg-slate-200 transition-colors text-slate-500 hover:text-slate-900"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-6 pt-3 space-y-5">
          {/* APK Download QR */}
          <div className="bg-emerald-50 rounded-2xl p-5 text-center shadow-xl">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
              <Smartphone size={11} className="inline mr-1" />
              手机扫码安装 Android 版
            </p>
            <div className="inline-block">
              {url && (
                <QRCodeSVG
                  value={`${url}/download/videocapsule.apk`}
                  size={200}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#111827"
                  imageSettings={{
                    src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="%2310b981"/><text x="16" y="23" font-family="system-ui,sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="%23fff">知</text></svg>',
                    height: 40,
                    width: 40,
                    excavate: true,
                  }}
                />
              )}
            </div>
            <a
              href="/download/videocapsule.apk"
              download
              className="mt-4 mx-auto btn-primary btn-magnetic inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold w-full justify-center"
            >
              <Download size={15} />
              直接下载 APK
            </a>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400">或</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          {/* Web version QR */}
          <div className="bg-emerald-50 rounded-xl p-4 text-center shadow-lg">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              <Globe size={11} className="inline mr-1" />
              扫码打开网页版
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
