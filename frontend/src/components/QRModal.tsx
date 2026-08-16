'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Globe, Smartphone } from 'lucide-react';
import NativeModal from './NativeModal';

export default function QRModal() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(window.location.origin);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.04] p-2.5 transition-colors duration-150 hover:border-white/[0.1] hover:bg-white/[0.08]"
        aria-label="手机扫码访问"
        title="手机扫码访问"
      >
        <Smartphone size={17} className="text-foreground-muted" />
      </button>

      <NativeModal open={open} onClose={() => setOpen(false)} title="手机扫码访问">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section className="rounded-xl border border-black/10 bg-white p-4 text-center">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              <Download size={11} className="mr-1 inline" />
              Android
            </h3>
            {url && (
              <QRCodeSVG
                value={`${url}/download/zhicui.apk`}
                size={168}
                level="M"
                bgColor="#ffffff"
                fgColor="#111827"
                title="Android APK 下载二维码"
                imageSettings={{ src: '/icons/icon-192.png', height: 36, width: 36, excavate: true }}
              />
            )}
            <a
              href="/download/zhicui.apk"
              download
              className="btn-primary mx-auto mt-3 inline-flex min-h-11 items-center gap-2 px-4 text-sm font-medium"
            >
              <Download size={14} />
              下载 APK
            </a>
          </section>

          <section className="flex flex-col items-center justify-center rounded-xl border border-black/10 bg-white p-4 text-center">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              <Globe size={11} className="mr-1 inline" />
              网页版
            </h3>
            {url && <QRCodeSVG value={url} size={120} level="M" bgColor="#ffffff" fgColor="#111827" title="网页版访问二维码" />}
          </section>
        </div>
      </NativeModal>
    </>
  );
}
