import { CURRENT_WEB_BUILD } from '@/generated/buildVersion';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(CURRENT_WEB_BUILD, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
