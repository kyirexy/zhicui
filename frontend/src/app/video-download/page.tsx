'use client';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import FastVideoDownload from '@/components/FastVideoDownload';
export default function VideoDownloadPage() {
  return <AuthGuard><main className="mx-auto w-full max-w-4xl space-y-5 pb-16"><nav className="text-sm"><Link href="/">首页</Link><span className="mx-2">/</span>视频下载</nav><FastVideoDownload /><p className="text-sm text-[var(--foreground-secondary)]">交给 AI Agent：<code>zhicui download &quot;视频链接&quot;</code>。<Link href="/agent-access" className="text-[var(--accent-brand)]">连接 Agent →</Link></p></main></AuthGuard>;
}
