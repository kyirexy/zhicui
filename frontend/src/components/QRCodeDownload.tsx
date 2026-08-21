'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';

export default function QRCodeDownload() {
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(window.location.origin);
  }, []);

  return (
    <section className="w-full max-w-3xl mx-auto animate-fade-in px-2">
      {/* Desktop: QR code for APK download */}
      <div className="hidden md:block glass-card p-6 md:p-8">
        <div className="flex items-center gap-6 md:gap-8">
          <div className="flex-shrink-0 bg-white p-3 rounded-xl">
            {url && (
              <QRCodeSVG
                value={`${url}/download/zhicui.apk`}
                size={140}
                level="M"
                bgColor="#ffffff"
                fgColor="#111827"
              />
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-base md:text-lg font-bold text-foreground mb-2 text-balance">
              📱 扫码下载 Android 版
            </h3>
            <p className="text-sm text-foreground-secondary leading-relaxed mb-3">
              扫描二维码，直接安装 APK 到手机
            </p>
            <a
              href="/download/zhicui.apk"
              download
              className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm font-medium mb-3 min-h-[44px]"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              直接下载 APK
            </a>
            <div className="flex items-center gap-2 text-xs text-foreground-muted">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-brand" />
              <span>也可添加到主屏幕使用网页版</span>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: Direct download + Add to Home Screen */}
      <div className="md:hidden glass-card p-5">
        <h3 className="text-base font-bold text-foreground mb-3 text-balance">
          📱 获取应用
        </h3>
        <a
          href="/download/zhicui.apk"
          download
          className="btn-primary flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-medium mb-4"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          下载 Android 版 (APK)
        </a>
        <p className="text-xs text-foreground-muted text-center mb-3">或添加网页到主屏幕</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent-brand/15 text-accent-brand text-xs font-bold flex items-center justify-center">
              i
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">iPhone / iPad</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                Safari → 分享按钮 → 添加到主屏幕
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent-brand/15 text-accent-brand text-xs font-bold flex items-center justify-center">
              A
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">Android</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                Chrome → 菜单 → 添加到主屏幕
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
