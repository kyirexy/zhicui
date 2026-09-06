import Link from 'next/link';
import { Globe2, Monitor, Smartphone } from 'lucide-react';

const CLIENTS = [
  {
    name: 'Windows',
    channel: '公测渠道',
    detail: '平台账号连接与手动同步、分享链接导入、完整文稿、问答和计划。',
    Icon: Monitor,
  },
  {
    name: 'Mac',
    channel: '测试渠道',
    detail: '与电脑端共用资料、问答和计划，支持本机浏览器绑定与手动同步。',
    Icon: Monitor,
  },
  {
    name: 'Android',
    channel: '公测渠道',
    detail: '分享链接导入、跨端查看、问答和计划；平台账号绑定需在电脑端完成。',
    Icon: Smartphone,
  },
  {
    name: 'iPhone',
    channel: '开发测试中',
    detail: '已接入资料、问答、计划、扫码和系统分享，尚未开放公开安装。',
    Icon: Smartphone,
  },
  {
    name: 'Web',
    channel: '在线最新版',
    detail: '产品演示、客户端下载、登录授权与帮助；完整工作台请使用客户端。',
    Icon: Globe2,
  },
] as const;

export default function ClientCapabilitySettingsCard() {
  return (
    <section className="rounded-xl border border-card-border bg-card-bg p-4 sm:p-5" aria-labelledby="client-capability-title">
      <header>
        <h2 id="client-capability-title" className="text-balance text-base font-semibold text-foreground">各客户端能做什么</h2>
        <p className="mt-1 text-pretty text-sm leading-6 text-foreground-muted">
          同一账号同步资料、知识和计划；平台账号读取只在用户点击后执行。
        </p>
      </header>
      <div className="mt-4 grid gap-2">
        {CLIENTS.map(({ name, channel, detail, Icon }) => (
          <article key={name} className="grid min-h-16 grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-lg border border-card-border px-3 py-2.5">
            <span className="flex size-11 items-center justify-center rounded-lg bg-foreground/5 text-foreground-secondary" aria-hidden="true">
              <Icon size={19} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-foreground">{name}</strong>
                <span className="tabular-nums rounded-md bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground-muted">{channel}</span>
              </div>
              <p className="mt-1 text-pretty text-xs leading-5 text-foreground-muted">{detail}</p>
            </div>
          </article>
        ))}
      </div>
      <p className="mt-3 text-pretty text-xs leading-5 text-foreground-muted">
        抖音或 B站可能因登录、平台限制或连接器状态暂时降级；已有资料不会丢失。
        <Link href="/platform-limits" className="ml-1 inline-flex min-h-11 items-center text-accent-brand hover:underline">查看处理方法</Link>
      </p>
    </section>
  );
}
