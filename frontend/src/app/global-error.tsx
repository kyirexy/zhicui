'use client';

import { useEffect } from 'react';
import { reportBoundaryError } from '@/components/ClientErrorReporter';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportBoundaryError(error, 'global-error-boundary');
  }, [error]);

  return (
    <html lang="zh-CN">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>知萃 · 应用恢复</title>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#f6f5f2',
          color: '#20242d',
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          boxSizing: 'border-box',
        }}
      >
        <main
          style={{
            width: '100%',
            maxWidth: '30rem',
            border: '1px solid #dedbd4',
            borderRadius: '1rem',
            background: '#ffffff',
            padding: '2rem',
            boxSizing: 'border-box',
            textAlign: 'center',
            boxShadow: '0 8px 24px rgba(32, 36, 45, 0.08)',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: '3rem',
              height: '3rem',
              borderRadius: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
              background: '#eef0f7',
              color: '#44537f',
              fontSize: '1rem',
              fontWeight: 700,
            }}
          >
            知
          </div>
          <p style={{ color: '#687080', fontSize: '0.875rem', margin: 0 }}>知萃</p>
          <h1 style={{ fontSize: '1.25rem', lineHeight: 1.4, margin: '0.5rem 0 0' }}>
            应用暂时没有加载成功
          </h1>
          <p
            style={{
              color: '#687080',
              fontSize: '0.875rem',
              lineHeight: 1.7,
              margin: '0.75rem 0 1.5rem',
            }}
          >
            你的资料不会因此丢失。请重新尝试，或刷新页面恢复到最新版本。
          </p>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '0.75rem',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: '2.75rem',
                background: '#44537f',
                color: '#ffffff',
                border: '1px solid #44537f',
                padding: '0.625rem 1.25rem',
                borderRadius: '0.75rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              重新尝试
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                minHeight: '2.75rem',
                background: '#ffffff',
                color: '#20242d',
                border: '1px solid #dedbd4',
                padding: '0.625rem 1.25rem',
                borderRadius: '0.75rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
              }}
            >
              刷新页面
            </button>
          </div>

          <nav
            aria-label="应用恢复"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1.25rem',
              marginTop: '1rem',
            }}
          >
            <a
              href="/"
              style={{
                minHeight: '2.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                color: '#4f596b',
                fontSize: '0.875rem',
                textDecoration: 'none',
              }}
            >
              返回首页
            </a>
            <a
              href="/login"
              style={{
                minHeight: '2.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                color: '#4f596b',
                fontSize: '0.875rem',
                textDecoration: 'none',
              }}
            >
              前往登录
            </a>
          </nav>
        </main>
      </body>
    </html>
  );
}
