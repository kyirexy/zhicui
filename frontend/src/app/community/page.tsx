import Link from 'next/link';
import CommunityPanel from '@/components/CommunityPanel';

export default function CommunityPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 pt-6 pb-[calc(96px+env(safe-area-inset-bottom))] sm:px-8">
      <Link href="/" className="mb-4 inline-flex min-h-11 items-center text-sm text-foreground-secondary">← 返回首页</Link>
      <h1 className="text-2xl font-bold text-foreground text-balance">加入知萃交流群</h1>
      <CommunityPanel />
    </main>
  );
}
