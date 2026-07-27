import type { NextConfig } from 'next';

const isCapacitor = process.env.CAPACITOR_BUILD === 'true';
const backendProxyUrl = process.env.BACKEND_PROXY_URL || 'http://localhost:8000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isCapacitor
    ? {
        output: 'export' as const,
        images: { unoptimized: true },
      }
    : {
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
