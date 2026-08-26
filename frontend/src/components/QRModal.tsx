'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Globe, QrCode, Smartphone } from 'lucide-react';
import NativeModal from './NativeModal';

const ANDROID_DOWNLOAD_URL = 'https://luxai.cn/api/client-downloads/android';

interface QRModalProps {
  triggerVariant?: 'icon' | 'sidebar';
}

export default function QRModal({ triggerVariant = 'icon' }: QRModalProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const sidebarTrigger = triggerVariant === 'sidebar';

  useEffect(() => {
    setUrl(window.location.origin);
  }, []);

  return (
    <>
      {sidebarTrigger ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="desktop-sidebar__mobile-download"
          aria-label="打开移动端下载二维码"
          title="手机扫码安装知萃"
        >
          <span className="desktop-sidebar__mobile-download-icon" aria-hidden="true">
            <Smartphone size={20} strokeWidth={1.8} />
          </span>
          <span className="desktop-sidebar__mobile-download-copy">
            <strong>下载移动端</strong>
            <small>手机扫码安装</small>
          </span>
          <QrCode size={17} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.04] p-2.5 transition-colors duration-150 hover:border-white/[0.1] hover:bg-white/[0.08]"
          aria-label="手机扫码访问"
          title="手机扫码访问"
        >
          <Smartphone size={17} className="text-foreground-muted" />
        </button>
      )}

      <NativeModal
        open={open}
        onClose={() => setOpen(false)}
        title={sidebarTrigger ? '下载移动端' : '手机扫码访问'}
      >
        {sidebarTrigger ? (
          <div className="flex flex-col items-center px-2 pb-2 text-center">
            <div className="rounded-xl bg-white p-3 ring-1 ring-black/10">
              <QRCodeSVG
                value={ANDROID_DOWNLOAD_URL}
                size={196}
                level="M"
                bgColor="#ffffff"
                fgColor="#111827"
                title="知萃 Android 下载二维码"
                imageSettings={{ src: '/icons/icon-192.png', height: 40, width: 40, excavate: true }}
              />
            </div>
            <strong className="mt-4 text-base text-foreground">用手机扫码安装 Android 版</strong>
            <p className="mt-1 max-w-sm text-sm leading-6 text-foreground-muted">
              使用手机相机或微信扫码，二维码会在手机浏览器打开安装包。
            </p>
            <a
              href={ANDROID_DOWNLOAD_URL}
              className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-card-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-background-secondary"
            >
              <Download size={15} aria-hidden="true" />
              仍要在电脑下载 APK
            </a>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <section className="rounded-xl border border-black/10 bg-white p-4 text-center">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">
                <Download size={11} className="mr-1 inline" />
                Android
              </h3>
              {url && (
                <QRCodeSVG
                  value={ANDROID_DOWNLOAD_URL}
                  size={168}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#111827"
                  title="Android APK 下载二维码"
                  imageSettings={{ src: '/icons/icon-192.png', height: 36, width: 36, excavate: true }}
                />
              )}
              <a
                href={ANDROID_DOWNLOAD_URL}
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
        )}
      </NativeModal>
    </>
  );
}
