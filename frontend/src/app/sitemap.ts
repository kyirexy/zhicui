import type { MetadataRoute } from 'next';

const LAST_MODIFIED = '2026-08-28T00:00:00+08:00';

// Capacitor 使用 Next.js 静态导出；显式声明可静态化，避免 metadata
// route 在 output: "export" 下被当作运行时路由处理。
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://luxai.cn/', lastModified: LAST_MODIFIED, changeFrequency: 'weekly', priority: 1 },
    { url: 'https://luxai.cn/legal/terms', lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.4 },
    { url: 'https://luxai.cn/legal/privacy', lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.4 },
    { url: 'https://luxai.cn/platform-limits', lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.5 },
    { url: 'https://luxai.cn/support', lastModified: LAST_MODIFIED, changeFrequency: 'monthly', priority: 0.5 },
  ];
}
