'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowRight, Download, Globe, Smartphone } from 'lucide-react';
import NativeModal from './NativeModal';

export default function MobileDownloadButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(window.location.origin);
  }, []);

  return (
    <>
      <div className="mx-auto w-full max-w-2xl px-4 pt-5 md:pt-6">
        <button type="button" onClick={() => setOpen(true)} className="bezel-outer btn-magnetic group w-full cursor-pointer">
          <div className="bezel-inner">
            <div className="flex items-center gap-4 p-4 md:p-5">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-accent-emerald/15 bg-accent-emerald/10 transition-all duration-500 group-hover:bg-accent-emerald/20">
                <Download size={22} className="text-accent-emerald" />
              </div>
              <div className="flex-1 text-left">
                <p className="text-sm font-semibold text-foreground">下载手机客户端</p>
                <p className="mt-0.5 text-xs text-foreground-muted">扫码安装，随时整理视频资料</p>
              </div>
              <ArrowRight size={18} className="text-foreground-muted transition-transform duration-300 group-hover:translate-x-0.5" />
            </div>
          </div>
        </button>
      </div>

      <NativeModal open={open} onClose={() => setOpen(false)} title="下载知萃">
        <div className="space-y-5">
          <section className="rounded-2xl bg-emerald-50 p-5 text-center shadow-xl">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <Smartphone size={11} className="mr-1 inline" />
              手机扫码安装 Android 版
            </p>
            {url && (
              <QRCodeSVG
                value={`${url}/download/zhicui.apk`}
                size={200}
                level="M"
                bgColor="#ffffff"
                fgColor="#111827"
                imageSettings={{ src: '/icons/icon-192.png', height: 40, width: 40, excavate: true }}
              />
            )}
            <a href="/download/zhicui.apk" download className="btn-primary btn-magnetic mx-auto mt-4 inline-flex w-full items-center justify-center gap-2 px-6 py-3 text-sm font-semibold">
              <Download size={15} />
              直接下载 APK
            </a>
          </section>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">或</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <section className="rounded-xl bg-emerald-50 p-4 text-center shadow-lg">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <Globe size={11} className="mr-1 inline" />
              扫码打开网页版
            </p>
            {url && <QRCodeSVG value={url} size={120} level="M" bgColor="#ffffff" fgColor="#111827" />}
          </section>
        </div>
      </NativeModal>
    </>
  );
}
