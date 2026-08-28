import type { NextConfig } from 'next';

const isCapacitor = process.env.CAPACITOR_BUILD === 'true';
const backendProxyUrl = process.env.BACKEND_PROXY_URL || 'http://localhost:8000';
const isDevelopment = process.env.NODE_ENV === 'development';

const productionSecurityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https://luxai.cn wss://luxai.cn",
      "frame-src 'self' https://www.bilibili.com https://player.bilibili.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 桌面端开发窗口也保持产品态界面，不显示 Next.js 左下角调试浮标。
  // 编译与运行时错误仍会通过开发错误覆盖层正常显示。
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // 开发服务与生产构建必须使用不同目录。否则在 dev 运行期间执行
  // `next build` 会清理同一个 .next 树，破坏 Webpack/HMR 正在引用的节点。
  distDir: isDevelopment ? '.next-dev' : '.next',
  ...(isCapacitor
    ? {
        output: 'export' as const,
        images: { unoptimized: true },
      }
    : {
        async headers() {
          if (isDevelopment) return [];
          return [
            {
              source: '/:path*',
              headers: productionSecurityHeaders,
            },
          ];
        },
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: `${backendProxyUrl}/api/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;
