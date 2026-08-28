import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: [
        '/',
        '/download',
        '/legal/terms',
        '/legal/privacy',
        '/platform-limits',
        '/support',
      ],
      disallow: [
        '/admin',
        '/api',
        '/harness',
        '/library',
        '/notes',
        '/plans',
        '/process',
        '/extract',
        '/settings',
        '/ai-routing',
      ],
    },
    sitemap: 'https://luxai.cn/sitemap.xml',
    host: 'https://luxai.cn',
  };
}
