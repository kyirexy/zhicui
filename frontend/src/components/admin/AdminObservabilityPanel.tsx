'use client';

import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  ChevronDown,
  Clock3,
  RefreshCw,
  ServerCrash,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  getApplicationErrors,
  getLlmUsage,
  getUserActivity,
  listAdminAuditLogs,
  type AdminAuditLog,
  type ApplicationErrorReport,
  type LlmUsageReport,
  type UserActivityReport,
} from '@/lib/api';

type View = 'usage' | 'activity' | 'errors' | 'audit';

export const ADMIN_ACTION_LABELS: Record<string, string> = {
  user_enable: '启用用户',
  user_disable: '禁用用户',
  user_promote: '授权管理员',
  user_demote: '撤销管理员',
  user_delete: '删除用户',
  user_reset_password: '重置密码',
  user_edit: '编辑用户资料',
  note_delete: '删除笔记',
  note_batch_delete: '批量删除笔记',
  note_reextract: '重新抽取',
  llm_config_update: '更新 LLM 配置',
  asr_config_update: '更新 ASR 配置',
  extraction_config_update: '更新批量提取并发',
  plan_delete: '删除计划',
  llm_config_test: '测试 LLM 连接',
  asr_config_test: '测试 ASR 连接',
  feedback_update: '处理用户反馈',
};

const OPERATION_LABELS: Record<string, string> = {
  card_generation: '生成知识卡',
  note_qa: '单视频问答',
  library_research_plan: '视频库研究规划',
  library_research_map: '跨视频分批研究',
  library_qa: '视频库综合回答',
  intent_classification: '内容意图分类',
  plan_generation: '生成初始计划',
  plan_agent: '计划 Agent',
  image_card_generation: '画面知识卡',
  admin_llm_test: '管理员连接测试',
  llm_call: '通用 LLM 调用',
};

export default function AdminObservabilityPanel() {
  const [view, setView] = useState<View>('usage');
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState<LlmUsageReport | null>(null);
  const [usagePage, setUsagePage] = useState(1);
  const [activity, setActivity] = useState<UserActivityReport | null>(null);
  const [activityPage, setActivityPage] = useState(1);
  const [activityAction, setActivityAction] = useState('');
  const [activityUserId, setActivityUserId] = useState('');
  const [errorReport, setErrorReport] = useState<ApplicationErrorReport | null>(null);
  const [errorPage, setErrorPage] = useState(1);
  const [errorSource, setErrorSource] = useState('');
  const [errorSeverity, setErrorSeverity] = useState('');
  const [expandedErrorId, setExpandedErrorId] = useState<number | null>(null);
  const [audit, setAudit] = useState<AdminAuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState('');
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void refresh();
    // refresh is intentionally driven by the active report controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    days,
    usagePage,
    activityPage,
    activityAction,
    activityUserId,
    errorPage,
    errorSource,
    errorSeverity,
    auditPage,
    auditAction,
  ]);

  const refresh = async () => {
    setLoading(true);
    setError('');
    if (view === 'usage') {
      const result = await getLlmUsage(days, usagePage, 20);
      if (result.success && result.data) setUsage(result.data);
      else setError(result.error || 'Token 用量加载失败');
    } else if (view === 'activity') {
      const result = await getUserActivity(
        days,
        activityPage,
        20,
        activityAction || undefined,
        activityUserId || undefined,
      );
      if (result.success && result.data) setActivity(result.data);
      else setError(result.error || '用户操作日志加载失败');
    } else if (view === 'errors') {
      const result = await getApplicationErrors(
        days,
        errorPage,
        20,
        errorSource || undefined,
        errorSeverity || undefined,
      );
      if (result.success && result.data) setErrorReport(result.data);
      else setError(result.error || '错误日志加载失败');
    } else {
      const result = await listAdminAuditLogs(auditPage, 20, auditAction || undefined);
      if (result.success && result.data) {
        setAudit(result.data.items);
        setAuditTotal(result.data.total);
      } else {
        setError(result.error || '管理员审计加载失败');
      }
    }
    setLoading(false);
  };

  const maxDailyTokens = useMemo(
    () => Math.max(1, ...(usage?.daily.map(item => item.total_tokens) || [1])),
    [usage],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-accent-emerald uppercase">
            <Activity size={14} aria-hidden="true" />
            Observability
          </div>
          <h1 className="mt-2 text-balance text-2xl font-bold text-foreground">用量与日志</h1>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-foreground-muted">
            查看模型 Token、用户操作、脱敏后的系统错误，以及管理员的安全审计记录。
          </p>
        </div>
        {view !== 'audit' && (
          <label className="flex items-center gap-2 text-xs text-foreground-muted">
            时间范围
            <select
              value={days}
              onChange={event => {
                setDays(Number(event.target.value));
                setUsagePage(1);
                setActivityPage(1);
                setErrorPage(1);
              }}
              className="min-h-10 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
              <option value={365}>最近 1 年</option>
            </select>
          </label>
        )}
      </div>

      <div
        role="tablist"
        aria-label="日志类型"
        className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-1"
      >
        <ViewButton active={view === 'usage'} onClick={() => setView('usage')} icon={BarChart3}>
          Token 用量
        </ViewButton>
        <ViewButton active={view === 'activity'} onClick={() => setView('activity')} icon={Users}>
          用户操作
        </ViewButton>
        <ViewButton active={view === 'errors'} onClick={() => setView('errors')} icon={AlertTriangle}>
          错误日志
        </ViewButton>
        <ViewButton active={view === 'audit'} onClick={() => setView('audit')} icon={ShieldCheck}>
          管理审计
        </ViewButton>
      </div>

      {error && (
        <div className="rounded-xl border border-accent-rose/25 bg-accent-rose/7 px-4 py-3 text-sm text-accent-rose">
          {error}
        </div>
      )}

      {view === 'usage' && (
        <UsageView
          report={usage}
          loading={loading}
          page={usagePage}
          setPage={setUsagePage}
          maxDailyTokens={maxDailyTokens}
          onRefresh={refresh}
        />
      )}
      {view === 'activity' && (
        <ActivityView
          report={activity}
          loading={loading}
          page={activityPage}
          setPage={setActivityPage}
          action={activityAction}
          setAction={value => {
            setActivityAction(value);
            setActivityPage(1);
          }}
          userId={activityUserId}
          setUserId={value => {
            setActivityUserId(value);
            setActivityPage(1);
          }}
          onRefresh={refresh}
        />
      )}
      {view === 'errors' && (
        <ErrorView
          report={errorReport}
          loading={loading}
          page={errorPage}
          setPage={setErrorPage}
          source={errorSource}
          setSource={value => {
            setErrorSource(value);
            setErrorPage(1);
          }}
          severity={errorSeverity}
          setSeverity={value => {
            setErrorSeverity(value);
            setErrorPage(1);
          }}
          expandedId={expandedErrorId}
          setExpandedId={setExpandedErrorId}
          onRefresh={refresh}
        />
      )}
      {view === 'audit' && (
        <AuditView
          items={audit}
          total={auditTotal}
          loading={loading}
          page={auditPage}
          setPage={setAuditPage}
          action={auditAction}
          setAction={value => {
            setAuditAction(value);
            setAuditPage(1);
          }}
          expandedId={expandedAuditId}
          setExpandedId={setExpandedAuditId}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

function UsageView({
  report,
  loading,
  page,
  setPage,
  maxDailyTokens,
  onRefresh,
}: {
  report: LlmUsageReport | null;
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  maxDailyTokens: number;
  onRefresh: () => Promise<void>;
}) {
  if (!report && loading) return <LoadingPanel label="正在读取 Token 用量" />;
  const summary = report?.summary || {
    calls: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    active_users: 0,
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="总 Token" value={formatNumber(summary.total_tokens)} helper="模型真实上报" icon={Bot} color="var(--accent-emerald)" />
        <Metric label="输入 Token" value={formatNumber(summary.prompt_tokens)} helper="提示词与上下文" icon={BarChart3} color="var(--accent-indigo)" />
        <Metric label="输出 Token" value={formatNumber(summary.completion_tokens)} helper="回答与结构化结果" icon={Activity} color="var(--accent-amber)" />
        <Metric label="调用次数" value={formatNumber(summary.calls)} helper={`${summary.active_users} 位活跃用户`} icon={Users} color="var(--accent-slate)" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="admin-panel p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Token 趋势</h2>
              <p className="mt-1 text-xs text-foreground-muted">仅统计发布后且提供 usage 的成功调用</p>
            </div>
            <RefreshButton loading={loading} onClick={onRefresh} />
          </div>
          {report?.daily.length ? (
            <div className="mt-5 flex h-40 items-end gap-1.5 overflow-hidden">
              {report.daily.map(item => (
                <div key={item.date} className="group flex min-w-2 flex-1 flex-col items-center justify-end gap-2">
                  <div
                    title={`${item.date} · ${formatNumber(item.total_tokens)} Token · ${item.calls} 次`}
                    className="w-full min-w-2 rounded-t-sm bg-accent-emerald/55 transition-colors group-hover:bg-accent-emerald"
                    style={{ height: `${Math.max(4, Math.round((item.total_tokens / maxDailyTokens) * 124))}px` }}
                  />
                  <span className="hidden text-[10px] text-foreground-muted 2xl:block">
                    {item.date.slice(5)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="还没有 Token 数据" description="新产生的 LLM 调用会从这里开始累计。" />
          )}
        </section>

        <section className="admin-panel overflow-hidden">
          <div className="border-b border-card-border p-5">
            <h2 className="text-sm font-semibold text-foreground">按模型统计</h2>
            <p className="mt-1 text-xs text-foreground-muted">快速识别不同模型的使用占比</p>
          </div>
          <div className="divide-y divide-card-border">
            {report?.by_model.map(item => (
              <div key={`${item.provider}-${item.model}`} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">{item.model}</div>
                  <div className="mt-1 text-xs text-foreground-muted">{item.calls} 次 · {item.provider}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-bold text-foreground">{formatNumber(item.total_tokens)}</div>
                  <div className="text-[11px] text-foreground-muted">Token</div>
                </div>
              </div>
            ))}
            {!report?.by_model.length && (
              <EmptyState title="暂无模型统计" description="连接测试也会计入这里。" compact />
            )}
          </div>
        </section>
      </div>

      <section className="admin-panel overflow-hidden">
        <div className="border-b border-card-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">最近调用</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="admin-table admin-table-wide text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th className="p-3 text-left">时间</th>
                <th className="p-3 text-left">用户</th>
                <th className="p-3 text-left">业务操作</th>
                <th className="p-3 text-left">模型</th>
                <th className="p-3 text-right">输入</th>
                <th className="p-3 text-right">输出</th>
                <th className="p-3 text-right">总计</th>
              </tr>
            </thead>
            <tbody>
              {report?.items.map(item => (
                <tr key={item.id} className="border-b border-card-border/50">
                  <td className="whitespace-nowrap p-3 text-xs text-foreground-muted">{formatDateTime(item.created_at)}</td>
                  <td className="p-3 font-medium text-foreground">{item.username}</td>
                  <td className="p-3 text-foreground-muted">{OPERATION_LABELS[item.operation] || item.operation}</td>
                  <td className="p-3"><code className="text-xs text-foreground">{item.model}</code></td>
                  <td className="p-3 text-right text-foreground-muted">{formatNumber(item.prompt_tokens)}</td>
                  <td className="p-3 text-right text-foreground-muted">{formatNumber(item.completion_tokens)}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatNumber(item.total_tokens)}</td>
                </tr>
              ))}
              {!report?.items.length && <EmptyTable colSpan={7} label="暂无调用记录" />}
            </tbody>
          </table>
        </div>
      </section>
      <Pagination page={page} total={report?.total || 0} perPage={20} setPage={setPage} />
    </div>
  );
}

function ActivityView({
  report,
  loading,
  page,
  setPage,
  action,
  setAction,
  userId,
  setUserId,
  onRefresh,
}: {
  report: UserActivityReport | null;
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  action: string;
  setAction: (action: string) => void;
  userId: string;
  setUserId: (userId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  if (!report && loading) return <LoadingPanel label="正在读取用户操作" />;
  const summary = report?.summary || { total: 0, today: 0, active_users: 0, errors: 0 };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="操作总数" value={formatNumber(summary.total)} helper="当前时间范围" icon={Activity} color="var(--accent-emerald)" />
        <Metric label="今日操作" value={formatNumber(summary.today)} helper="按北京时间统计" icon={Clock3} color="var(--accent-amber)" />
        <Metric label="活跃用户" value={formatNumber(summary.active_users)} helper="产生关键操作" icon={Users} color="var(--accent-indigo)" />
        <Metric label="异常响应" value={formatNumber(summary.errors)} helper="HTTP 400 及以上" icon={ShieldCheck} color="var(--accent-rose)" />
      </div>
      <section className="admin-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">用户操作轨迹</h2>
            <p className="mt-1 text-xs text-foreground-muted">不记录请求正文、文案、问题、密码或密钥</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={userId}
              onChange={event => setUserId(event.target.value)}
              aria-label="按用户筛选操作日志"
              className="min-h-10 min-w-36 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value="">全部用户</option>
              {report?.users?.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={action}
              onChange={event => setAction(event.target.value)}
              aria-label="按操作类型筛选日志"
              className="min-h-10 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value="">全部操作</option>
              {report?.actions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <RefreshButton loading={loading} onClick={onRefresh} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="admin-table admin-table-wider text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th className="p-3 text-left">时间</th>
                <th className="p-3 text-left">用户</th>
                <th className="p-3 text-left">操作</th>
                <th className="p-3 text-left">结果详情</th>
                <th className="p-3 text-left">接口</th>
                <th className="p-3 text-left">状态</th>
                <th className="p-3 text-right">耗时</th>
                <th className="p-3 text-left">IP</th>
              </tr>
            </thead>
            <tbody>
              {report?.items.map(item => (
                <tr key={item.id} className="border-b border-card-border/50">
                  <td className="whitespace-nowrap p-3 text-xs text-foreground-muted">{formatDateTime(item.created_at)}</td>
                  <td className="p-3 font-medium text-foreground">{item.username}</td>
                  <td className="p-3"><span className="rounded-md bg-[var(--admin-surface-2)] px-2 py-1 text-xs text-foreground">{item.action_label}</span></td>
                  <td className="max-w-xs p-3 text-xs text-foreground-secondary">
                    {item.detail_summary || (item.status_code >= 400 ? '失败' : '已完成')}
                  </td>
                  <td className="p-3"><code className="text-xs text-foreground-muted">{item.method} {item.path}</code></td>
                  <td className="p-3">
                    <span className={`text-xs font-semibold ${item.status_code >= 400 ? 'text-accent-rose' : 'text-accent-emerald'}`}>
                      {item.status_code >= 400 ? '失败' : '成功'} · {item.status_code}
                    </span>
                  </td>
                  <td className="p-3 text-right text-xs text-foreground-muted">{item.duration_ms} ms</td>
                  <td className="p-3 text-xs text-foreground-muted">{item.ip || '-'}</td>
                </tr>
              ))}
              {!report?.items.length && <EmptyTable colSpan={8} label="暂无用户操作记录" />}
            </tbody>
          </table>
        </div>
      </section>
      <Pagination page={page} total={report?.total || 0} perPage={20} setPage={setPage} />
    </div>
  );
}

const ERROR_SOURCE_LABELS: Record<string, string> = {
  backend: '后端',
  http: 'HTTP',
  validation: '参数校验',
  llm: 'LLM',
  asr: 'ASR',
  frontend: '客户端',
};

const ERROR_SEVERITY_LABELS: Record<string, string> = {
  warning: '警告',
  error: '错误',
  critical: '严重',
};

function ErrorView({
  report,
  loading,
  page,
  setPage,
  source,
  setSource,
  severity,
  setSeverity,
  expandedId,
  setExpandedId,
  onRefresh,
}: {
  report: ApplicationErrorReport | null;
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  source: string;
  setSource: (source: string) => void;
  severity: string;
  setSeverity: (severity: string) => void;
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  onRefresh: () => Promise<void>;
}) {
  if (!report && loading) return <LoadingPanel label="正在读取错误日志" />;
  const summary = report?.summary || {
    total: 0,
    today: 0,
    critical: 0,
    server_errors: 0,
    affected_users: 0,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="错误总数"
          value={formatNumber(summary.total)}
          helper="当前时间范围"
          icon={AlertTriangle}
          color="var(--accent-rose)"
        />
        <Metric
          label="今日新增"
          value={formatNumber(summary.today)}
          helper="按北京时间统计"
          icon={Clock3}
          color="var(--accent-amber)"
        />
        <Metric
          label="服务端异常"
          value={formatNumber(summary.server_errors)}
          helper="HTTP 500 及以上"
          icon={ServerCrash}
          color="var(--accent-indigo)"
        />
        <Metric
          label="受影响用户"
          value={formatNumber(summary.affected_users)}
          helper={`${summary.critical} 条严重错误`}
          icon={Users}
          color="var(--accent-slate)"
        />
      </div>

      <section className="admin-panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-card-border px-5 py-4">
          <div>
            <h2 className="text-balance text-sm font-semibold text-foreground">应用错误明细</h2>
            <p className="mt-1 max-w-2xl text-pretty text-xs leading-5 text-foreground-muted">
              服务端异常、参数校验、LLM/ASR 与客户端崩溃统一汇总；敏感字段、请求正文和业务内容不会写入日志。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="error-source-filter">错误来源</label>
            <select
              id="error-source-filter"
              value={source}
              onChange={event => setSource(event.target.value)}
              className="min-h-10 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value="">全部来源</option>
              {(report?.sources || []).map(option => (
                <option key={option} value={option}>
                  {ERROR_SOURCE_LABELS[option] || option}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="error-severity-filter">严重程度</label>
            <select
              id="error-severity-filter"
              value={severity}
              onChange={event => setSeverity(event.target.value)}
              className="min-h-10 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value="">全部等级</option>
              {(report?.severities || ['warning', 'error', 'critical']).map(option => (
                <option key={option} value={option}>
                  {ERROR_SEVERITY_LABELS[option] || option}
                </option>
              ))}
            </select>
            <RefreshButton loading={loading} onClick={onRefresh} />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="admin-table admin-table-wider text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th className="w-10 p-3"><span className="sr-only">详情</span></th>
                <th className="p-3 text-left">时间</th>
                <th className="p-3 text-left">来源</th>
                <th className="p-3 text-left">用户</th>
                <th className="p-3 text-left">错误类型</th>
                <th className="p-3 text-left">接口</th>
                <th className="p-3 text-left">状态</th>
                <th className="p-3 text-left">摘要</th>
              </tr>
            </thead>
            <tbody>
              {report?.items.map(item => {
                const expanded = expandedId === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className="border-b border-card-border/50">
                      <td className="p-2 text-center">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : item.id)}
                          aria-label={expanded ? '收起错误详情' : '展开错误详情'}
                          aria-expanded={expanded}
                          className="inline-flex size-9 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-[var(--admin-surface-2)] hover:text-foreground"
                        >
                          <ChevronDown
                            size={15}
                            className={expanded ? 'rotate-180' : ''}
                            aria-hidden="true"
                          />
                        </button>
                      </td>
                      <td className="whitespace-nowrap p-3 text-xs text-foreground-muted">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="p-3">
                        <span className="rounded-md bg-[var(--admin-surface-2)] px-2 py-1 text-xs font-medium text-foreground">
                          {ERROR_SOURCE_LABELS[item.source] || item.source}
                        </span>
                      </td>
                      <td className="p-3 font-medium text-foreground">{item.username}</td>
                      <td className="p-3"><code className="text-xs text-foreground">{item.error_type}</code></td>
                      <td className="p-3">
                        <code className="text-xs text-foreground-muted">
                          {[item.method, item.path].filter(Boolean).join(' ') || '-'}
                        </code>
                      </td>
                      <td className="p-3">
                        <span className={`text-xs font-semibold ${
                          item.severity === 'critical'
                            ? 'text-accent-rose'
                            : item.severity === 'error'
                              ? 'text-accent-amber'
                              : 'text-foreground-muted'
                        }`}>
                          {item.status_code || ERROR_SEVERITY_LABELS[item.severity] || item.severity}
                        </span>
                      </td>
                      <td className="max-w-xs truncate p-3 text-xs text-foreground-muted" title={item.message}>
                        {item.message}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={8} className="bg-[var(--admin-surface-2)] p-4 sm:p-5">
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.65fr)]">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-foreground">完整错误信息</div>
                              <p className="mt-2 break-words text-pretty text-xs leading-5 text-foreground-muted">
                                {item.message}
                              </p>
                              {item.traceback && (
                                <>
                                  <div className="mt-4 text-xs font-semibold text-foreground">脱敏调用栈</div>
                                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-card-border bg-background p-3 text-[11px] leading-5 text-foreground-muted">
                                    {item.traceback}
                                  </pre>
                                </>
                              )}
                            </div>
                            <dl className="grid content-start grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                              <dt className="text-foreground-muted">等级</dt>
                              <dd className="font-medium text-foreground">{ERROR_SEVERITY_LABELS[item.severity] || item.severity}</dd>
                              <dt className="text-foreground-muted">状态码</dt>
                              <dd className="font-medium tabular-nums text-foreground">{item.status_code || '-'}</dd>
                              <dt className="text-foreground-muted">请求</dt>
                              <dd className="break-all font-medium text-foreground">{[item.method, item.path].filter(Boolean).join(' ') || '-'}</dd>
                              <dt className="text-foreground-muted">IP</dt>
                              <dd className="break-all font-medium text-foreground">{item.ip || '-'}</dd>
                              <dt className="text-foreground-muted">上下文</dt>
                              <dd>
                                <pre className="whitespace-pre-wrap break-all text-[11px] leading-5 text-foreground-muted">
                                  {Object.keys(item.metadata).length
                                    ? JSON.stringify(item.metadata, null, 2)
                                    : '无'}
                                </pre>
                              </dd>
                            </dl>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!report?.items.length && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-sm text-foreground-muted">
                    <div>当前筛选范围内没有错误日志</div>
                    <button
                      type="button"
                      onClick={() => void onRefresh()}
                      className="mt-3 min-h-9 rounded-lg border border-card-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-[var(--admin-surface-2)]"
                    >
                      重新检查
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <Pagination page={page} total={report?.total || 0} perPage={20} setPage={setPage} />
    </div>
  );
}

function AuditView({
  items,
  total,
  loading,
  page,
  setPage,
  action,
  setAction,
  expandedId,
  setExpandedId,
  onRefresh,
}: {
  items: AdminAuditLog[];
  total: number;
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  action: string;
  setAction: (action: string) => void;
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <section className="admin-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">管理员安全审计</h2>
            <p className="mt-1 text-xs text-foreground-muted">保留配置变更和破坏性管理操作，共 {total} 条</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={action}
              onChange={event => setAction(event.target.value)}
              className="min-h-10 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/50"
            >
              <option value="">全部动作</option>
              {Object.entries(ADMIN_ACTION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <RefreshButton loading={loading} onClick={onRefresh} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="admin-table admin-table-wide text-sm">
            <thead>
              <tr className="text-xs text-foreground-muted">
                <th className="p-3 text-left">时间</th>
                <th className="p-3 text-left">操作人</th>
                <th className="p-3 text-left">动作</th>
                <th className="p-3 text-left">目标</th>
                <th className="p-3 text-left">IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <Fragment key={item.id}>
                  <tr
                    className="cursor-pointer border-b border-card-border/50"
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  >
                    <td className="whitespace-nowrap p-3 text-xs text-foreground-muted">{formatDateTime(item.created_at)}</td>
                    <td className="p-3 font-medium text-foreground">{item.admin_username || item.admin_user_id.slice(0, 8)}</td>
                    <td className="p-3"><span className="rounded-md bg-[var(--admin-surface-2)] px-2 py-1 text-xs">{ADMIN_ACTION_LABELS[item.action] || item.action}</span></td>
                    <td className="p-3 text-xs text-foreground-muted">{item.target_type ? `${item.target_type}${item.target_id ? `:${item.target_id.slice(0, 8)}` : ''}` : '-'}</td>
                    <td className="p-3 text-xs text-foreground-muted">{item.ip || '-'}</td>
                  </tr>
                  {expandedId === item.id && item.detail && (
                    <tr>
                      <td colSpan={5} className="bg-[var(--admin-surface-2)] p-4">
                        <pre className="whitespace-pre-wrap break-all text-xs leading-5 text-foreground-muted">{JSON.stringify(item.detail, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!items.length && <EmptyTable colSpan={5} label="暂无管理员审计记录" />}
            </tbody>
          </table>
        </div>
      </section>
      <Pagination page={page} total={total} perPage={20} setPage={setPage} />
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Activity;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-foreground-muted hover:text-foreground'
      }`}
    >
      <Icon size={15} aria-hidden="true" />
      {children}
    </button>
  );
}

function Metric({
  label,
  value,
  helper,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  helper: string;
  icon: typeof Activity;
  color: string;
}) {
  return (
    <div className="admin-stat p-4 pl-5" style={{ '--stat-color': color } as CSSProperties}>
      <div className="flex items-center justify-between gap-3">
        <div className="tabular-nums text-xl font-bold text-foreground sm:text-2xl">{value}</div>
        <Icon size={18} className="text-foreground-muted" aria-hidden="true" />
      </div>
      <div className="mt-2 text-xs font-medium text-foreground">{label}</div>
      <div className="mt-1 text-[11px] text-foreground-muted">{helper}</div>
    </div>
  );
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => Promise<void> }) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={loading}
      aria-label="刷新数据"
      title="刷新数据"
      className="inline-flex size-10 items-center justify-center rounded-lg border border-card-border bg-[var(--admin-surface-2)] text-foreground-muted transition-colors hover:text-foreground disabled:opacity-50"
    >
      <RefreshCw size={15} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
    </button>
  );
}

function Pagination({
  page,
  total,
  perPage,
  setPage,
}: {
  page: number;
  total: number;
  perPage: number;
  setPage: (page: number) => void;
}) {
  if (total <= perPage) return null;
  const pages = Math.ceil(total / perPage);
  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
        className="min-h-9 rounded-lg bg-[var(--admin-surface-2)] px-3 text-sm text-foreground disabled:opacity-40"
      >
        上一页
      </button>
      <span className="text-xs text-foreground-muted">第 {page} 页，共 {pages} 页</span>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => setPage(page + 1)}
        className="min-h-9 rounded-lg bg-[var(--admin-surface-2)] px-3 text-sm text-foreground disabled:opacity-40"
      >
        下一页
      </button>
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="admin-panel flex min-h-48 items-center justify-center gap-2 text-sm text-foreground-muted">
      <RefreshCw size={16} className="animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

function EmptyState({
  title,
  description,
  compact = false,
}: {
  title: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'min-h-32 px-5' : 'min-h-40'}`}>
      <BarChart3 size={22} className="text-foreground-muted/50" aria-hidden="true" />
      <div className="mt-3 text-sm font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-xs text-foreground-muted">{description}</div>
    </div>
  );
}

function EmptyTable({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-8 text-center text-sm text-foreground-muted">{label}</td>
    </tr>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatDateTime(value: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
