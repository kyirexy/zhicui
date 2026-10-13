import type { ResearchRun, ResearchSubscriptionInput } from './dailyResearchApi';

export function defaultResearchSubscription(email = ''): ResearchSubscriptionInput {
  return { name: '每日视频研究', enabled: true, schedule_time: '15:00', timezone: 'Asia/Shanghai', platforms: ['douyin'], source_modes: ['like', 'collect'], window_days: 2, sync_limit: 500, focus_topics: [], recipient_email: email, instruction: '' };
}

const RUN_LABELS: Record<string, string> = {
  queued: '已排队', waiting_for_desktop: '等待电脑客户端在线', syncing: '同步喜欢与收藏',
  waiting_for_user: '需要完成平台验证', preparing: '提取视频内容', researching: '分析热度与选题',
  delivering: '正在投递邮件', completed: '研究完成', partial: '部分完成', failed: '研究失败', cancelled: '已取消',
};

export function researchRunLabel(run: Pick<ResearchRun, 'status' | 'stage' | 'delivery_status'>): string {
  if (['failed', 'cancelled', 'partial'].includes(run.status)) return RUN_LABELS[run.status];
  if (run.delivery_status === 'delivering') return RUN_LABELS.delivering;
  return RUN_LABELS[run.stage] || RUN_LABELS[run.status] || '状态待确认';
}

export function isResearchRunActive(run: Pick<ResearchRun, 'status' | 'delivery_status'>): boolean {
  return run.delivery_status === 'delivering' || ['queued', 'waiting_for_desktop', 'syncing', 'waiting_for_user', 'preparing', 'researching', 'delivering'].includes(run.status);
}

export function researchDeliveryLabel(status: string): string {
  return ({ skipped: '仅保存站内报告', sent: '邮件已发送', failed: '邮件发送失败', not_configured: '邮件服务未配置', verification_required: '收件邮箱未验证', unknown: '邮件投递状态待确认', delivering: '邮件投递中' } as Record<string, string>)[status] || '尚未投递邮件';
}

export function researchCoverageLabel(coverage: string): string {
  return ({ complete: '本次同步已读完', limited: '已达本次同步上限', partial: '仅获取部分来源' } as Record<string, string>)[coverage] || '覆盖范围待确认';
}

export function researchDate(value?: string | null): string {
  if (!value) return '尚无记录';
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function safeResearchSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function normalizeResearchTopics(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

export function validateResearchSubscription(value: ResearchSubscriptionInput, maxSyncLimit = 500): string | null {
  if (!value.name.trim()) return '请填写订阅名称';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.schedule_time)) return '请选择有效的每日执行时间';
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone }).format(); } catch { return '请填写有效时区，例如 Asia/Shanghai'; }
  if (!value.platforms.length) return '请至少选择一个视频平台';
  if (value.platforms.some((platform) => platform !== 'douyin')) return '当前每日研究仅支持抖音';
  if (!value.source_modes.length) return '请至少选择喜欢或收藏';
  if (value.window_days !== 2) return '当前研究范围为近 2 日首次发现的视频';
  if (!Number.isInteger(value.sync_limit) || value.sync_limit < 1 || value.sync_limit > maxSyncLimit) return `同步上限须为 1 至 ${maxSyncLimit} 条`;
  if (value.recipient_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.recipient_email.trim())) return '请填写有效的收件邮箱，或留空仅保存站内报告';
  return null;
}
