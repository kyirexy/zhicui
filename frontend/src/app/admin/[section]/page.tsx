'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useParams, useRouter } from 'next/navigation';
import {
  Activity,
  AudioLines,
  Bot,
  Boxes,
  ChartNoAxesCombined,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  HeartPulse,
  LayoutDashboard,
  ListTodo,
  Menu,
  MessageSquareText,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  getAdminStats,
  listAdminUsers,
  patchAdminUser,
  deleteAdminUser,
  getAdminUserDetail,
  resetAdminUserPassword,
  listAdminNotes,
  deleteAdminNote,
  reExtractNote,
  batchDeleteAdminNotes,
  listAdminPlans,
  deleteAdminPlan,
  getLlmConfig,
  getAsrConfig,
  getExtractionConfig,
  getCreatorSyncAdminConfig,
  getAgentV2AdminConfig,
  putAsrConfig,
  putExtractionConfig,
  putCreatorSyncAdminConfig,
  putAgentV2AdminConfig,
  listAdminAuditLogs,
  testAsrConfig,
  testCreatorSyncConnector,
  getSystemInfo,
  getNote,
  getPlan,
  getAdminOps,
  getUserActivity,
  listAdminChatModels,
  type ApiResponse,
  type AdminUser,
  type AdminStats,
  type AdminNoteItem,
  type AdminPlanItem,
  type LlmConfig,
  type AsrConfig,
  type ExtractionConfig,
  type CreatorSyncAdminConfig,
  type AgentV2AdminConfig,
  type AdminAuditLog,
  type ConfigTestResult,
  type SystemInfo,
  type AdminUserDetail,
  type AdminOps,
  type UserActivityItem,
} from '@/lib/api';
import { getPlanProgress, type NoteDetail, type PlanData } from '@/lib/types';
import AdminLlmConfigPanel from '@/components/admin/AdminLlmConfigPanel';
import AdminObservabilityPanel, { ADMIN_ACTION_LABELS } from '@/components/admin/AdminObservabilityPanel';
import AdminFeedbackPanel from '@/components/admin/AdminFeedbackPanel';
import AdminAnalysisAccountCard from '@/components/admin/AdminAnalysisAccountCard';
import AdminVideoAnalysisPanel from '@/components/admin/AdminVideoAnalysisPanel';
import AdminChatModelPanel, { type AdminChatModelPanelHandle } from '@/components/admin/AdminChatModelPanel';
import AdminOmniroutePanel from '@/components/admin/AdminOmniroutePanel';
import styles from '../AdminWorkspace.module.css';

type Tab = 'dashboard' | 'users' | 'feedback' | 'notes' | 'plans' | 'export' | 'ops' | 'models' | 'llm' | 'asr' | 'observability' | 'settings';

interface AdminNavItem {
  key: Tab;
  label: string;
  description: string;
  icon: LucideIcon;
}

const NAV_GROUPS: Array<{ label: string; items: AdminNavItem[] }> = [
  {
    label: '总览',
    items: [
      { key: 'dashboard', label: '运营概览', description: '核心数据与近期动态', icon: LayoutDashboard },
    ],
  },
  {
    label: '内容与用户',
    items: [
      { key: 'users', label: '用户管理', description: '账号、权限与状态', icon: Users },
      { key: 'feedback', label: '用户反馈', description: '问题、建议与回复', icon: MessageSquareText },
      { key: 'notes', label: '笔记管理', description: '内容检查与重新生成', icon: FileText },
      { key: 'plans', label: '计划管理', description: '行动计划与完成状态', icon: ListTodo },
      { key: 'export', label: '数据导出', description: '按当前条件导出 CSV', icon: Download },
    ],
  },
  {
    label: '系统与模型',
    items: [
      { key: 'ops', label: '系统运维', description: '数据库与密钥状态', icon: HeartPulse },
      { key: 'models', label: '聊天模型', description: '发布、定价与用户权限', icon: Boxes },
      { key: 'llm', label: 'AI 模型配置', description: '文字、视觉模型与解析方案', icon: Bot },
      { key: 'asr', label: 'ASR 配置', description: '语音识别与并发设置', icon: AudioLines },
      { key: 'observability', label: '用量与日志', description: '调用、活动与错误追踪', icon: ChartNoAxesCombined },
      { key: 'settings', label: '系统设置', description: '运行环境与安全信息', icon: Settings2 },
    ],
  },
];

const NAV = NAV_GROUPS.flatMap((group) => (
  group.items.map((item) => ({ ...item, group: group.label }))
));

const CARD_TYPE_LABELS: Record<string, string> = {
  recipe: '食谱', insight: '洞察', history: '历史', product: '好物', plan: '计划', general: '通用',
};
const CARD_TYPE_OPTIONS = [
  { value: 'recipe', label: '食谱' },
  { value: 'insight', label: '洞察' },
  { value: 'history', label: '历史' },
  { value: 'product', label: '好物' },
  { value: 'plan', label: '计划' },
  { value: 'general', label: '通用' },
];

const ACTION_LABELS = ADMIN_ACTION_LABELS;

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ section?: string }>();
  const sectionParam = Array.isArray(params?.section) ? params.section[0] : params?.section;
  const tab = (NAV.some((item) => item.key === sectionParam) ? sectionParam : 'dashboard') as Tab;
  const setTab = (next: Tab) => {
    setSidebarOpen(false);
    setErr('');
    setMsg('');
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (next !== tab) router.push(`/admin/${next}`);
  };
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recentActivity, setRecentActivity] = useState<AdminAuditLog[]>([]);

  // 用户管理（后端搜索分页）
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userPage, setUserPage] = useState(1);
  const [userTotal, setUserTotal] = useState(0);
  const [userSearchInput, setUserSearchInput] = useState('');
  const [userQ, setUserQ] = useState('');

  // 笔记管理
  const [notes, setNotes] = useState<AdminNoteItem[]>([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [notePage, setNotePage] = useState(1);
  const [noteSearch, setNoteSearch] = useState('');
  const [noteCardType, setNoteCardType] = useState('');
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());

  // 计划管理
  const [plans, setPlans] = useState<AdminPlanItem[]>([]);
  const [plansTotal, setPlansTotal] = useState(0);
  const [planSearchInput, setPlanSearchInput] = useState('');
  const [planQ, setPlanQ] = useState('');

  // 配置
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [asr, setAsr] = useState<AsrConfig | null>(null);
  const [extractionConfig, setExtractionConfig] = useState<ExtractionConfig | null>(null);
  const [creatorSyncConfig, setCreatorSyncConfig] = useState<CreatorSyncAdminConfig | null>(null);
  const [agentV2Config, setAgentV2Config] = useState<AgentV2AdminConfig | null>(null);

  // 系统
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [ops, setOps] = useState<AdminOps | null>(null);

  // 运营概览增强：模型状态 + 最近用户任务
  const [recentUserTasks, setRecentUserTasks] = useState<UserActivityItem[]>([]);
  const [chatModelCount, setChatModelCount] = useState(0);
  const [observabilityView, setObservabilityView] = useState<'usage' | 'analysis' | 'activity' | 'errors' | 'audit'>('usage');

  // 抽屉
  const [userDetail, setUserDetail] = useState<AdminUserDetail | null>(null);
  const [userDetailLoading, setUserDetailLoading] = useState(false);
  const [noteDetail, setNoteDetail] = useState<NoteDetail | null>(null);
  const [noteDetailLoading, setNoteDetailLoading] = useState(false);
  const [planDetail, setPlanDetail] = useState<PlanData | null>(null);
  const [planDetailLoading, setPlanDetailLoading] = useState(false);

  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [exportingKind, setExportingKind] = useState<'users' | 'notes' | 'plans' | null>(null);
  const chatModelPanelRef = useRef<AdminChatModelPanelHandle>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/login?redirect=/admin'); return; }
    if (!user.is_admin) { router.replace('/'); return; }
    refreshStats();
    refreshUsers(1, '');
  }, [user, loading, router]);

  useEffect(() => {
    if (!user?.is_admin) return;
    if (tab === 'dashboard') {
      refreshRecentActivity();
      refreshOps();
      refreshDashboardExtras();
    }
    if (tab === 'notes') refreshNotes(1);
    if (tab === 'plans' && plans.length === 0) refreshPlans('');
    if (tab === 'llm' && !llm) refreshLlm();
    if (tab === 'asr' && (!asr || !extractionConfig)) refreshAsr();
    if (tab === 'settings') {
      if (!systemInfo) refreshSystemInfo();
      if (!creatorSyncConfig) refreshCreatorSyncConfig();
      if (!agentV2Config) refreshAgentV2Config();
    }
    if (tab === 'ops') refreshOps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function refreshStats() { const r = await getAdminStats(); if (r.success && r.data) setStats(r.data); }
  async function refreshRecentActivity() {
    const r = await listAdminAuditLogs(1, 5);
    if (r.success && r.data) setRecentActivity(r.data.items);
  }
  async function refreshUsers(page = userPage, q = userQ) {
    const r = await listAdminUsers(page, 20, q || undefined);
    if (r.success && r.data) {
      setUsers(r.data.items); setUserTotal(r.data.total); setUserPage(page);
    } else setErr(r.error || '加载失败');
  }
  async function refreshNotes(page = notePage, search = noteSearch, cardType = noteCardType) {
    const r = await listAdminNotes(page, 20, search || undefined, cardType || undefined);
    if (r.success && r.data) { setNotes(r.data.items); setNotesTotal(r.data.total); setNotePage(page); }
    setSelectedNotes(new Set());
  }
  async function refreshPlans(q = planQ) {
    const r = await listAdminPlans(1, 20, q || undefined);
    if (r.success && r.data) { setPlans(r.data.items); setPlansTotal(r.data.total); }
  }
  async function refreshLlm() { const r = await getLlmConfig(); if (r.success && r.data) setLlm(r.data); }
  async function refreshAsr() {
    const [asrResult, extractionResult] = await Promise.all([
      getAsrConfig(),
      getExtractionConfig(),
    ]);
    if (asrResult.success && asrResult.data) setAsr(asrResult.data);
    if (extractionResult.success && extractionResult.data) {
      setExtractionConfig(extractionResult.data);
    }
  }
  async function refreshSystemInfo() { const r = await getSystemInfo(); if (r.success && r.data) setSystemInfo(r.data); }
  async function refreshCreatorSyncConfig() {
    const result = await getCreatorSyncAdminConfig();
    if (result.success && result.data) setCreatorSyncConfig(result.data);
  }
  async function refreshAgentV2Config() {
    const result = await getAgentV2AdminConfig();
    if (result.success && result.data) setAgentV2Config(result.data);
  }
  async function refreshOps() { const r = await getAdminOps(); if (r.success && r.data) setOps(r.data); }
  async function refreshDashboardExtras() {
    const [tasksResult, modelsResult, llmResult, asrResult, extractionResult] = await Promise.all([
      getUserActivity(7, 1, 8),
      listAdminChatModels(),
      getLlmConfig(),
      getAsrConfig(),
      getExtractionConfig(),
    ]);
    if (tasksResult.success && tasksResult.data) setRecentUserTasks(tasksResult.data.items);
    if (modelsResult.success && modelsResult.data) setChatModelCount(modelsResult.data.items.length);
    if (llmResult.success && llmResult.data) setLlm(llmResult.data);
    if (asrResult.success && asrResult.data) setAsr(asrResult.data);
    if (extractionResult.success && extractionResult.data) {
      setExtractionConfig(extractionResult.data);
    }
  }

  function flash(m: string) { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000); }

  const toggleUser = async (u: AdminUser) => {
    setErr(''); setMsg('');
    const r = await patchAdminUser(u.id, { is_active: !u.is_active });
    if (r.success && r.data) { setUsers(us => us.map(x => (x.id === u.id ? r.data! : x))); flash(r.data.is_active ? '已启用' : '已禁用'); }
    else setErr(r.error || '操作失败');
  };
  const removeUser = async (u: AdminUser) => {
    if (!confirm(`删除用户 ${u.username || u.email}?`)) return;
    const r = await deleteAdminUser(u.id);
    if (r.success) { refreshUsers(userPage); refreshStats(); flash('已删除'); }
    else setErr(r.error || '删除失败');
  };
  const resetPassword = async (id: string, newPwd: string): Promise<boolean> => {
    const r = await resetAdminUserPassword(id, newPwd);
    if (r.success) { flash('密码已重置'); return true; }
    setErr(r.error || '重置失败'); return false;
  };
  const editUser = async (id: string, username: string, email: string): Promise<boolean> => {
    const r = await patchAdminUser(id, { username, email });
    if (r.success && r.data) {
      flash('资料已更新');
      refreshUsers(userPage);
      setUserDetail(d => d && d.id === id ? { ...d, username: r.data!.username, email: r.data!.email } : d);
      return true;
    }
    setErr(r.error || '更新失败'); return false;
  };

  async function fetchAllPages<T>(
    fetchPage: (page: number, perPage: number) => Promise<ApiResponse<{ items: T[]; total: number }>>,
  ): Promise<T[]> {
    const perPage = 100;
    const allItems: T[] = [];
    let page = 1;

    while (true) {
      const result = await fetchPage(page, perPage);
      if (!result.success || !result.data) {
        throw new Error(result.error || '导出失败');
      }

      allItems.push(...result.data.items);
      if (allItems.length >= result.data.total || result.data.items.length === 0) {
        return allItems;
      }
      page += 1;
    }
  }

  // 导出 CSV：按后端允许的分页大小拉取全量数据，再转 Blob 下载
  async function exportCsv(kind: 'users' | 'notes' | 'plans') {
    if (exportingKind) return;
    setExportingKind(kind);
    setErr('');
    try {
      let rows: string[][] = [];
      let filename = '';
      if (kind === 'users') {
        const items = await fetchAllPages<AdminUser>((page, perPage) => (
          listAdminUsers(page, perPage, userQ || undefined)
        ));
        filename = `users-${new Date().toISOString().slice(0, 10)}.csv`;
        rows = [['用户名', '邮箱', '角色', '状态', '注册时间'], ...items.map(u => [
          u.username || '', u.email, u.is_admin ? '管理员' : '用户', u.is_active ? '正常' : '禁用',
          u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '',
        ])];
      } else if (kind === 'notes') {
        const items = await fetchAllPages<AdminNoteItem>((page, perPage) => (
          listAdminNotes(page, perPage, noteSearch || undefined, noteCardType || undefined)
        ));
        filename = `notes-${new Date().toISOString().slice(0, 10)}.csv`;
        rows = [['标题', '类型', '作者', '有转录', '创建时间'], ...items.map(n => [
          n.video_title, CARD_TYPE_LABELS[n.card_type] || n.card_type, n.author,
          n.has_transcript ? '是' : '否', n.created_at ? new Date(n.created_at).toLocaleString('zh-CN') : '',
        ])];
      } else {
        const items = await fetchAllPages<AdminPlanItem>((page, perPage) => (
          listAdminPlans(page, perPage, planQ || undefined)
        ));
        filename = `plans-${new Date().toISOString().slice(0, 10)}.csv`;
        rows = [['标题', '作者', '状态', '天数', '创建时间'], ...items.map(p => [
          p.title || '', p.author || '', p.status === 'done' ? '已完成' : '进行中',
          String(p.total_days || 0), p.created_at ? new Date(p.created_at).toLocaleString('zh-CN') : '',
        ])];
      }
      const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      flash(`已导出 ${rows.length - 1} 条`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExportingKind(null);
    }
  }

  const removeNote = async (n: AdminNoteItem) => {
    if (!confirm(`删除笔记「${n.video_title}」?`)) return;
    const r = await deleteAdminNote(n.id);
    if (r.success) { refreshNotes(notePage); refreshStats(); flash('已删除'); }
    else setErr(r.error || '删除失败');
  };
  const batchDeleteNotes = async () => {
    if (selectedNotes.size === 0) return;
    if (!confirm(`批量删除 ${selectedNotes.size} 条笔记?`)) return;
    const r = await batchDeleteAdminNotes([...selectedNotes]);
    if (r.success && r.data) { refreshNotes(notePage); refreshStats(); flash(`已删除 ${r.data.deleted} 条`); }
    else setErr(r.error || '批量删除失败');
  };
  const reExtract = async (n: AdminNoteItem) => {
    if (!n.has_transcript) { setErr('该笔记无转录文本，无法重新抽取'); return; }
    setErr('正在重新抽取，请稍候…'); setMsg('');
    const r = await reExtractNote(n.id);
    if (r.success) { flash('已重新生成卡片'); refreshStats(); }
    else setErr(r.error || '重新抽取失败');
  };
  const removePlan = async (p: AdminPlanItem) => {
    if (!confirm(`删除计划「${p.title}」?`)) return;
    const r = await deleteAdminPlan(p.id);
    if (r.success) { refreshPlans(); refreshStats(); flash('已删除'); }
    else setErr(r.error || '删除失败');
  };

  // 抽屉加载
  async function openUserDetail(u: AdminUser) {
    setUserDetailLoading(true); setUserDetail(null);
    const r = await getAdminUserDetail(u.id);
    setUserDetailLoading(false);
    if (r.success && r.data) setUserDetail(r.data);
    else setErr(r.error || '加载用户详情失败');
  }
  async function openNoteDetail(n: AdminNoteItem) {
    setNoteDetailLoading(true); setNoteDetail(null);
    const r = await getNote(n.id);
    setNoteDetailLoading(false);
    if (r.success && r.data) setNoteDetail(r.data);
    else setErr(r.error || '加载笔记详情失败');
  }
  async function openPlanDetail(p: AdminPlanItem) {
    setPlanDetailLoading(true); setPlanDetail(null);
    const r = await getPlan(p.id);
    setPlanDetailLoading(false);
    if (r.success && r.data) setPlanDetail(r.data);
    else setErr(r.error || '加载计划详情失败');
  }

  if (loading || !user?.is_admin) {
    return <div className="p-8 text-center text-foreground-muted">加载中…</div>;
  }

  const activeAdminCount = users.filter(u => u.is_admin && u.is_active).length;
  const activeNav = NAV.find((item) => item.key === tab) ?? NAV[0];

  return (
    <div className={`${styles.workspace} admin-workspace-root flex h-auto min-h-screen items-stretch`}>
      <aside className={`${styles.sidebar} fixed lg:sticky lg:top-0 z-40 w-64 h-screen shrink-0 self-start flex flex-col transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">知</span>
          <span>
            <strong>知萃管理中心</strong>
          </span>
        </div>
        <nav className={styles.navigation} aria-label="管理端导航">
          {NAV_GROUPS.map((group) => (
            <section key={group.label} className={styles.navGroup}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = tab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    aria-label={`${item.label}：${item.description}`}
                    onClick={() => setTab(item.key)}
                    className={active ? styles.navItemActive : styles.navItem}
                  >
                    <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                    <span>
                      <strong>{item.label}</strong>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        <div className={styles.account}>
          <span className={styles.accountAvatar} aria-hidden="true">
            {(user.username || user.email).slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{user.username || user.email}</strong>
            <small>管理员</small>
          </span>
          <ShieldCheck size={17} aria-label="管理员账号" />
        </div>
      </aside>

      {sidebarOpen && <button type="button" aria-label="关闭管理端导航" className={styles.scrim} onClick={() => setSidebarOpen(false)} />}

      <main className={`${styles.main} flex-1 min-w-0`}>
        <header className={styles.mobileHeader}>
          <button type="button" onClick={() => setSidebarOpen(true)} aria-label="打开管理端导航">
            <Menu size={20} aria-hidden="true" />
          </button>
          <span>
            <strong>{activeNav.label}</strong>
          </span>
          <Link href="/" aria-label="返回产品首页">
            <ExternalLink size={18} aria-hidden="true" />
          </Link>
        </header>

        <div className={styles.contextBar}>
          <span>{activeNav.group}</span>
          <i aria-hidden="true" />
          <strong>{activeNav.label}</strong>
          <Link href="/">
            返回产品端
            <ExternalLink size={14} aria-hidden="true" />
          </Link>
        </div>

        <div className={`${styles.content} mx-auto p-4 sm:p-6`}>
          {(err || msg) && (
            <p role={err ? 'alert' : 'status'} className={`${styles.notice} ${err ? styles.noticeError : styles.noticeSuccess}`}>
              {err || msg}
            </p>
          )}

          {/* 仪表盘 */}
          {tab === 'dashboard' && stats && (
            <div className={`${styles.dashboard} space-y-4`}>
              <header className={styles.dashboardHeading}>
                <div>
                  <h1>运营概览</h1>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void refreshStats();
                    void refreshRecentActivity();
                    void refreshOps();
                    void refreshDashboardExtras();
                  }}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  刷新数据
                </button>
              </header>

              <div className={styles.dashboardOverview}>
                <section className={`${styles.summaryPanel} admin-panel`} aria-label="核心数据">
                  <StatCard label="注册用户" value={stats.users} icon={Users} featured />
                  <StatCard label="知识笔记" value={stats.notes} icon={FileText} />
                  <StatCard label="行动计划" value={stats.plans} icon={ListTodo} />
                  <StatCard label="客户端下载" value={stats.downloads.total} icon={Download} />
                </section>

                <section className={`${styles.healthPanel} admin-panel`} aria-label="系统状态">
                  <header>
                    <span>
                      <Activity size={17} aria-hidden="true" />
                      <strong>运行状态</strong>
                    </span>
                    <button type="button" onClick={() => setTab('ops')}>查看运维</button>
                  </header>
                  {ops ? (
                    <div>
                      <SystemStatusRow icon={Database} label="数据存储" value={ops.db_type} ok />
                      <SystemStatusRow icon={Bot} label="LLM 服务" value={ops.keys.llm_key_set ? '已配置' : '需要配置'} ok={ops.keys.llm_key_set} />
                      <SystemStatusRow icon={AudioLines} label="语音识别" value={ops.keys.asr_key_set ? '已配置' : '需要配置'} ok={ops.keys.asr_key_set} />
                      <SystemStatusRow icon={ShieldCheck} label="安全密钥" value={ops.keys.encryption_key_set && ops.keys.jwt_secret_set ? '完整' : '需要检查'} ok={ops.keys.encryption_key_set && ops.keys.jwt_secret_set} />
                    </div>
                  ) : (
                    <div className={styles.healthLoading}>正在读取系统状态…</div>
                  )}
                </section>
              </div>
              <section className="admin-panel p-4" aria-label="客户端下载统计">
                <div className={styles.panelTitle}>
                  <span><Download size={17} aria-hidden="true" /><strong>客户端下载量</strong></span>
                  <small>统计下载启动次数，不代表唯一用户或安装完成数</small>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-xl bg-[var(--admin-surface-2)] p-3"><div className="text-xs text-foreground-muted">今日</div><strong className="mt-1 block text-xl text-foreground">{stats.downloads.today}</strong></div>
                  <div className="rounded-xl bg-[var(--admin-surface-2)] p-3"><div className="text-xs text-foreground-muted">近 7 日</div><strong className="mt-1 block text-xl text-foreground">{stats.downloads.last_7_days}</strong></div>
                  <div className="rounded-xl bg-[var(--admin-surface-2)] p-3"><div className="text-xs text-foreground-muted">Android</div><strong className="mt-1 block text-xl text-foreground">{stats.downloads.by_platform.android}</strong></div>
                  <div className="rounded-xl bg-[var(--admin-surface-2)] p-3"><div className="text-xs text-foreground-muted">Windows</div><strong className="mt-1 block text-xl text-foreground">{stats.downloads.by_platform.windows}</strong></div>
                </div>
                <div className="mt-4 flex h-24 items-end gap-1" aria-label="最近 14 天下载趋势">
                  {stats.downloads.daily.map((item) => {
                    const peak = Math.max(1, ...stats.downloads.daily.map((day) => day.count));
                    return <div key={item.date} className="group flex min-w-0 flex-1 items-end" title={`${item.date}：${item.count} 次`}><div className="w-full rounded-t bg-accent-brand/65 transition-colors group-hover:bg-accent-brand" style={{ height: `${Math.max(item.count ? 10 : 2, Math.round((item.count / peak) * 100))}%` }} /></div>;
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-foreground-muted"><span>{stats.downloads.daily[0]?.date.slice(5)}</span><span>最近 14 天</span><span>{stats.downloads.daily.at(-1)?.date.slice(5)}</span></div>
              </section>
              <section className="admin-panel overflow-hidden" aria-label="模型服务状态">
                <div className={styles.panelTitle}>
                  <span>
                    <Bot size={17} aria-hidden="true" />
                    <strong>模型服务状态</strong>
                  </span>
                  <small>当前生效的模型与并发配置</small>
                </div>
                <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <button
                    type="button"
                    onClick={() => setTab('llm')}
                    className="rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-4 text-left transition-colors hover:border-accent-brand/35"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-muted">LLM 文本模型</span>
                      <span className={`text-xs font-semibold ${llm?.api_key_masked ? 'text-accent-brand' : 'text-accent-rose'}`}>
                        {llm?.api_key_masked ? '已配置' : '未配置'}
                      </span>
                    </div>
                    <div className="mt-2 truncate text-sm font-bold text-foreground">{llm?.model || '—'}</div>
                    <div className="mt-1 truncate text-xs text-foreground-muted">
                      {llm?.provider === 'deepseek' ? 'DeepSeek 官方' : '自定义接口'}
                      {llm?.api_base ? ` · ${llm.api_base}` : ''}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('asr')}
                    className="rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-4 text-left transition-colors hover:border-accent-brand/35"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-muted">ASR 语音识别</span>
                      <span className={`text-xs font-semibold ${asr?.api_key_masked ? 'text-accent-brand' : 'text-accent-rose'}`}>
                        {asr?.api_key_masked ? '已配置' : '未配置'}
                      </span>
                    </div>
                    <div className="mt-2 truncate text-sm font-bold text-foreground">{asr?.model || '—'}</div>
                    <div className="mt-1 truncate text-xs text-foreground-muted">{asr?.api_base_url || '使用默认接口'}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('asr')}
                    className="rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-4 text-left transition-colors hover:border-accent-brand/35"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-muted">批量提取并发</span>
                      <span className="text-xs font-semibold text-accent-brand">运行中</span>
                    </div>
                    <div className="mt-2 text-sm font-bold text-foreground">
                      ASR {extractionConfig?.asr_concurrency ?? '—'}
                      <span className="mx-1 text-foreground-muted">/</span>
                      LLM {extractionConfig?.llm_concurrency ?? '—'}
                    </div>
                    <div className="mt-1 text-xs text-foreground-muted">
                      上限 ASR {extractionConfig?.max_asr_concurrency ?? '—'} · LLM {extractionConfig?.max_llm_concurrency ?? '—'}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('models')}
                    className="rounded-xl border border-card-border bg-[var(--admin-surface-2)] p-4 text-left transition-colors hover:border-accent-brand/35"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-muted">聊天模型目录</span>
                      <span className="text-xs font-semibold text-accent-brand">可管理</span>
                    </div>
                    <div className="mt-2 text-sm font-bold text-foreground">{chatModelCount} 个模型</div>
                    <div className="mt-1 text-xs text-foreground-muted">发布、定价与用户可见权限</div>
                  </button>
                </div>
              </section>

              <div className={styles.recentGrid}>
                {stats.recent_users && stats.recent_users.length > 0 && (
                  <div className={`${styles.recentPanel} admin-panel p-4`}>
                    <div className={styles.panelTitle}>
                      <span><Users size={17} aria-hidden="true" /><strong>最近注册用户</strong></span>
                      <button type="button" onClick={() => setTab('users')}>查看全部</button>
                    </div>
                    <div className="space-y-2">
                      {stats.recent_users.map((u, i) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span className="font-medium text-foreground truncate">{u.username || u.email}</span>
                          <span className="text-xs text-foreground-muted ml-2 shrink-0">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {recentActivity.length > 0 && (
                  <div className={`${styles.recentPanel} admin-panel p-4`}>
                    <div className={styles.panelTitle}>
                      <span><Clock3 size={17} aria-hidden="true" /><strong>最近管理活动</strong></span>
                      <button type="button" onClick={() => setTab('observability')}>查看日志</button>
                    </div>
                    <div className="space-y-2">
                      {recentActivity.map(a => (
                        <div key={a.id} className="flex items-center justify-between text-sm">
                          <span className="text-foreground">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--admin-surface-2)] mr-1.5">{ACTION_LABELS[a.action] || a.action}</span>
                            <span className="text-foreground-muted text-xs">{a.admin_username || '管理员'}</span>
                          </span>
                          <span className="text-xs text-foreground-muted shrink-0">{a.created_at ? new Date(a.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {recentUserTasks.length > 0 && (
                  <div className={`${styles.recentPanel} admin-panel p-4`}>
                    <div className={styles.panelTitle}>
                      <span><Activity size={17} aria-hidden="true" /><strong>最近用户任务</strong></span>
                      <button type="button" onClick={() => { setObservabilityView('activity'); setTab('observability'); }}>查看全部</button>
                    </div>
                    <div className="space-y-2">
                      {recentUserTasks.map(t => (
                        <div key={t.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={`shrink-0 text-[11px] font-semibold ${t.status_code >= 400 ? 'text-accent-rose' : 'text-accent-brand'}`}>
                              {t.status_code >= 400 ? '失败' : '成功'}
                            </span>
                            <span className="truncate font-medium text-foreground">{t.action_label}</span>
                          </span>
                          <span className="shrink-0 text-xs text-foreground-muted">
                            {t.username} · {t.duration_ms}ms
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 用户管理 */}
          {tab === 'users' && (
            <div className="space-y-4">
              <div className={`${styles.sectionHeader} flex items-center justify-between gap-3 flex-wrap`}>
                <h1 className="text-2xl font-bold text-foreground">用户管理 <span className="text-sm font-normal text-foreground-muted">共 {userTotal} 人</span></h1>
                <div className={`${styles.filters} flex gap-2`}>
                  <input
                    value={userSearchInput}
                    onChange={e => setUserSearchInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { setUserQ(userSearchInput); refreshUsers(1, userSearchInput); } }}
                    placeholder="搜索邮箱/用户名"
                    className="px-3 py-1.5 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50"
                  />
                  <button onClick={() => { setUserQ(userSearchInput); refreshUsers(1, userSearchInput); }} className="px-3 py-1.5 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90">搜索</button>
                </div>
              </div>
              <div className="admin-panel overflow-hidden">
                <table className="admin-table text-sm">
                  <thead>
                    <tr className="text-foreground-muted text-xs">
                      <th className="text-left p-3">用户名</th>
                      <th className="text-left p-3">邮箱</th>
                      <th className="text-left p-3">角色</th>
                      <th className="text-left p-3">状态</th>
                      <th className="text-left p-3">注册</th>
                      <th className="text-right p-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => {
                      const isSelf = u.id === user.id;
                      const isLastAdmin = u.is_admin && u.is_active && activeAdminCount <= 1;
                      const disableToggle = isSelf || isLastAdmin;
                      const reason = isSelf ? '不能操作自己' : isLastAdmin ? '需保留一个启用管理员' : '';
                      return (
                        <tr key={u.id} className="border-b border-card-border/50 cursor-pointer" onClick={() => openUserDetail(u)}>
                          <td className="p-3 font-medium text-foreground">{u.username || '-'}</td>
                          <td className="p-3 text-foreground-muted">{u.email}</td>
                          <td className="p-3">{u.is_admin ? <span className="text-xs px-2 py-0.5 rounded bg-accent-brand/10 text-accent-brand">管理员</span> : <span className="text-xs text-foreground-muted">用户</span>}</td>
                          <td className="p-3">{u.is_active ? <span className="text-accent-brand">正常</span> : <span className="text-accent-rose">禁用</span>}</td>
                          <td className="p-3 text-foreground-muted text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                          <td className="p-3 text-right space-x-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                            <button onClick={() => toggleUser(u)} disabled={disableToggle} title={reason} className="text-xs px-2 py-1 rounded bg-[var(--admin-surface-2)] hover:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed">{u.is_active ? '禁用' : '启用'}</button>
                            <button onClick={() => openUserDetail(u)} className="text-xs px-2 py-1 rounded bg-[var(--admin-surface-2)] hover:brightness-95">重置密码</button>
                            {isSelf ? <span className="text-xs text-foreground-muted/50 ml-1">本人</span> : <button onClick={() => removeUser(u)} className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20">删除</button>}
                          </td>
                        </tr>
                      );
                    })}
                    {users.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-foreground-muted text-sm">暂无用户</td></tr>}
                  </tbody>
                </table>
              </div>
              {userTotal > 20 && (
                <div className="flex justify-center items-center gap-3">
                  <button disabled={userPage <= 1} onClick={() => refreshUsers(userPage - 1)} className="px-3 py-1 rounded bg-[var(--admin-surface-2)] text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95">上一页</button>
                  <span className="text-sm text-foreground-muted">第 {userPage} 页 / {Math.ceil(userTotal / 20)} 页</span>
                  <button disabled={userPage * 20 >= userTotal} onClick={() => refreshUsers(userPage + 1)} className="px-3 py-1 rounded bg-[var(--admin-surface-2)] text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95">下一页</button>
                </div>
              )}
            </div>
          )}

          {/* 用户反馈 */}
          {tab === 'feedback' && <AdminFeedbackPanel />}

          {/* 笔记管理 */}
          {tab === 'notes' && (
            <div className="space-y-4">
              <div className={`${styles.sectionHeader} flex items-center justify-between gap-3 flex-wrap`}>
                <h1 className="text-2xl font-bold text-foreground">笔记管理 <span className="text-sm font-normal text-foreground-muted">共 {notesTotal} 条</span></h1>
                <div className={`${styles.filters} flex gap-2`}>
                  <input
                    value={noteSearch}
                    onChange={e => setNoteSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') refreshNotes(1); }}
                    placeholder="搜索标题"
                    className="px-3 py-1.5 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50"
                  />
                  <select
                    value={noteCardType}
                    onChange={e => { setNoteCardType(e.target.value); refreshNotes(1, noteSearch, e.target.value); }}
                    className="px-3 py-1.5 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground focus:outline-none focus:border-accent-brand/50"
                  >
                    <option value="">全部类型</option>
                    {CARD_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button onClick={() => refreshNotes(1)} className="px-3 py-1.5 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90">搜索</button>
                </div>
              </div>
              {selectedNotes.size > 0 && (
                <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-accent-rose/5 border border-accent-rose/20">
                  <span className="text-sm text-foreground">已选 {selectedNotes.size} 条</span>
                  <button onClick={batchDeleteNotes} className="text-xs px-3 py-1.5 rounded bg-accent-rose text-white font-semibold hover:bg-accent-rose/90">批量删除</button>
                </div>
              )}
              <div className="admin-panel overflow-hidden">
                <table className="admin-table text-sm">
                  <thead>
                    <tr className="text-foreground-muted text-xs">
                      <th className="text-left p-3 w-8">
                        <input
                          type="checkbox"
                          checked={notes.length > 0 && selectedNotes.size === notes.length}
                          onChange={e => setSelectedNotes(new Set(e.target.checked ? notes.map(n => n.id) : []))}
                          className="cursor-pointer"
                        />
                      </th>
                      <th className="text-left p-3">标题</th>
                      <th className="text-left p-3">类型</th>
                      <th className="text-left p-3">作者</th>
                      <th className="text-left p-3">创建</th>
                      <th className="text-right p-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notes.map(n => (
                      <tr key={n.id} className="border-b border-card-border/50">
                        <td className="p-3" onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={selectedNotes.has(n.id)} onChange={e => {
                            const next = new Set(selectedNotes);
                            if (e.target.checked) next.add(n.id); else next.delete(n.id);
                            setSelectedNotes(next);
                          }} className="cursor-pointer" />
                        </td>
                        <td className="p-3 font-medium text-foreground max-w-xs truncate cursor-pointer hover:text-accent-brand" onClick={() => openNoteDetail(n)}>{n.video_title}</td>
                        <td className="p-3 text-foreground-muted">{CARD_TYPE_LABELS[n.card_type] || n.card_type}</td>
                        <td className="p-3 text-foreground-muted">{n.author}</td>
                        <td className="p-3 text-foreground-muted text-xs">{n.created_at ? new Date(n.created_at).toLocaleDateString() : '-'}</td>
                        <td className="p-3 text-right space-x-2 whitespace-nowrap">
                          <button onClick={() => reExtract(n)} disabled={!n.has_transcript} title={n.has_transcript ? '用当前 LLM 重新生成' : '无转录文本'} className="text-xs px-2 py-1 rounded bg-[var(--admin-surface-2)] hover:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed">重新抽取</button>
                          <button onClick={() => removeNote(n)} className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20">删除</button>
                        </td>
                      </tr>
                    ))}
                    {notes.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-foreground-muted text-sm">暂无笔记</td></tr>}
                  </tbody>
                </table>
              </div>
              {notesTotal > 20 && (
                <div className="flex justify-center items-center gap-3">
                  <button disabled={notePage <= 1} onClick={() => refreshNotes(notePage - 1)} className="px-3 py-1 rounded bg-[var(--admin-surface-2)] text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95">上一页</button>
                  <span className="text-sm text-foreground-muted">第 {notePage} 页 / {Math.ceil(notesTotal / 20)} 页</span>
                  <button disabled={notePage * 20 >= notesTotal} onClick={() => refreshNotes(notePage + 1)} className="px-3 py-1 rounded bg-[var(--admin-surface-2)] text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95">下一页</button>
                </div>
              )}
            </div>
          )}

          {/* 计划管理 */}
          {tab === 'plans' && (
            <div className="space-y-4">
              <div className={`${styles.sectionHeader} flex items-center justify-between gap-3 flex-wrap`}>
                <h1 className="text-2xl font-bold text-foreground">计划管理 <span className="text-sm font-normal text-foreground-muted">共 {plansTotal} 个</span></h1>
                <div className={`${styles.filters} flex gap-2`}>
                  <input
                    value={planSearchInput}
                    onChange={e => setPlanSearchInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { setPlanQ(planSearchInput); refreshPlans(planSearchInput); } }}
                    placeholder="搜索标题"
                    className="px-3 py-1.5 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50"
                  />
                  <button onClick={() => { setPlanQ(planSearchInput); refreshPlans(planSearchInput); }} className="px-3 py-1.5 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90">搜索</button>
                </div>
              </div>
              <div className="admin-panel overflow-hidden">
                <table className="admin-table text-sm">
                  <thead>
                    <tr className="text-foreground-muted text-xs">
                      <th className="text-left p-3">标题</th>
                      <th className="text-left p-3">作者</th>
                      <th className="text-left p-3">状态</th>
                      <th className="text-left p-3">天数</th>
                      <th className="text-left p-3">创建</th>
                      <th className="text-right p-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map(p => (
                      <tr key={p.id} className="border-b border-card-border/50">
                        <td className="p-3 font-medium text-foreground max-w-xs truncate cursor-pointer hover:text-accent-brand" onClick={() => openPlanDetail(p)}>{p.title || '-'}</td>
                        <td className="p-3 text-foreground-muted">{p.author || '-'}</td>
                        <td className="p-3">{p.status === 'done' ? <span className="text-accent-brand">已完成</span> : <span className="text-amber-500">进行中</span>}</td>
                        <td className="p-3 text-foreground-muted">{p.total_days || 0} 天</td>
                        <td className="p-3 text-foreground-muted text-xs">{p.created_at ? new Date(p.created_at).toLocaleDateString() : '-'}</td>
                        <td className="p-3 text-right"><button onClick={() => removePlan(p)} className="text-xs px-2 py-1 rounded bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20">删除</button></td>
                      </tr>
                    ))}
                    {plans.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-foreground-muted text-sm">暂无计划</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 数据导出 */}
          {tab === 'export' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-bold text-foreground">数据导出</h1>
              <p className="text-xs text-foreground-muted">导出当前筛选条件下的全量数据为 CSV（含 BOM，Excel 直接可读）。</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <ExportCard title="用户列表" desc="用户名、邮箱、角色、状态、注册时间" icon={Users} onClick={() => exportCsv('users')} loading={exportingKind === 'users'} disabled={exportingKind !== null} />
                <ExportCard title="笔记列表" desc="标题、类型、作者、转录标记、创建时间" icon={FileText} onClick={() => exportCsv('notes')} loading={exportingKind === 'notes'} disabled={exportingKind !== null} />
                <ExportCard title="计划列表" desc="标题、作者、状态、天数、创建时间" icon={ListTodo} onClick={() => exportCsv('plans')} loading={exportingKind === 'plans'} disabled={exportingKind !== null} />
              </div>
            </div>
          )}

          {/* 系统运维 */}
          {tab === 'ops' && ops && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-foreground">系统运维</h1>
                <button onClick={() => refreshOps()} className="text-xs px-3 py-1.5 rounded-lg bg-[var(--admin-surface-2)] hover:brightness-95">刷新</button>
              </div>
              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">数据库表行数</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard label="用户" value={ops.table_counts.users} icon={Users} />
                  <StatCard label="笔记" value={ops.table_counts.notes} icon={FileText} />
                  <StatCard label="计划" value={ops.table_counts.plans} icon={ListTodo} />
                  <StatCard label="审计日志" value={ops.table_counts.audit_logs} icon={Clock3} />
                </div>
                <div className="mt-3"><InfoRow label="数据库类型" value={ops.db_type} /></div>
              </div>
              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">密钥配置状态</h2>
                <div className="grid grid-cols-2 gap-3">
                  <InfoRow label="LLM API Key" value={ops.keys.llm_key_set ? '✓ 已配置' : '✗ 未配置'} ok={ops.keys.llm_key_set} />
                  <InfoRow label="ASR API Key" value={ops.keys.asr_key_set ? '✓ 已配置' : '✗ 未配置'} ok={ops.keys.asr_key_set} />
                  <InfoRow label="Fernet 加密密钥" value={ops.keys.encryption_key_set ? '✓ 已设置' : '✗ 未设置'} ok={ops.keys.encryption_key_set} />
                  <InfoRow label="JWT Secret" value={ops.keys.jwt_secret_set ? '✓ 已设置' : '✗ 未设置'} ok={ops.keys.jwt_secret_set} />
                </div>
              </div>
              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">最近管理活动</h2>
                {ops.recent_audit.length === 0 ? <div className="text-xs text-foreground-muted">暂无活动</div> : (
                  <div className="space-y-2">
                    {ops.recent_audit.map(a => (
                      <div key={a.id} className="flex items-center justify-between text-sm">
                        <span className="text-foreground">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--admin-surface-2)] mr-1.5">{ACTION_LABELS[a.action] || a.action}</span>
                          <span className="text-foreground-muted text-xs">{a.admin_username || '管理员'}</span>
                        </span>
                        <span className="text-xs text-foreground-muted shrink-0">{a.created_at ? new Date(a.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 用户可见模型目录与底层 Provider 配置分开管理。 */}
          {tab === 'models' && (
            <div className="space-y-7">
              <AdminOmniroutePanel onMessage={flash} onError={setErr} onPublished={() => { void chatModelPanelRef.current?.refresh(); }} />
              <AdminChatModelPanel ref={chatModelPanelRef} onMessage={flash} onError={setErr} />
            </div>
          )}

          {tab === 'llm' && (
            <div className="space-y-7">
              <AdminLlmConfigPanel
                config={llm}
                onConfigChange={setLlm}
                onMessage={flash}
                onError={setErr}
              />
              <AdminVideoAnalysisPanel onMessage={flash} onError={setErr} />
            </div>
          )}

          {/* ASR 配置 */}
          {tab === 'asr' && (
            <div className="space-y-4">
              <ConfigForm
                title="ASR 配置"
                desc={`语音转文字服务（SiliconFlow）。API Key 加密存储。当前 Key: ${asr?.api_key_masked || '未设置'}。留空表示不改。`}
                fields={[
                  { key: 'api_key', label: 'API Key', value: '', placeholder: '留空不改', secret: true },
                  { key: 'api_base_url', label: 'API Base URL', value: asr?.api_base_url ?? '', placeholder: 'https://api.siliconflow.cn/v1/audio/transcriptions' },
                  { key: 'model', label: '模型', value: asr?.model ?? '', placeholder: 'FunAudioLLM/SenseVoiceSmall' },
                ]}
                onSave={async (vals) => {
                  const body: Record<string, string> = {};
                  if (vals.api_key) body.api_key = vals.api_key;
                  if (vals.api_base_url) body.api_base_url = vals.api_base_url;
                  if (vals.model) body.model = vals.model;
                  const r = await putAsrConfig(body);
                  if (r.success && r.data) { setAsr(r.data); flash('ASR 配置已保存'); }
                  else setErr(r.error || '保存失败');
                }}
                onTest={async () => testAsrConfig()}
              />
              {extractionConfig && (
                <ExtractionConcurrencyPanel
                  key={`${extractionConfig.asr_concurrency}-${extractionConfig.llm_concurrency}`}
                  config={extractionConfig}
                  onSave={async (asrConcurrency, llmConcurrency) => {
                    const result = await putExtractionConfig({
                      asr_concurrency: asrConcurrency,
                      llm_concurrency: llmConcurrency,
                    });
                    if (result.success && result.data) {
                      setExtractionConfig(result.data);
                      flash('批量并发设置已保存');
                      return true;
                    }
                    setErr(result.error || '并发设置保存失败');
                    return false;
                  }}
                />
              )}
            </div>
          )}

          {/* 用量与日志 */}
          {tab === 'observability' && <AdminObservabilityPanel initialView={observabilityView} />}

          {/* 系统设置 */}
          {tab === 'settings' && systemInfo && (
            <div className="space-y-4">
              <h1 className="text-2xl font-bold text-foreground">系统设置</h1>

              {agentV2Config && (
                <AgentV2ConfigPanel
                  config={agentV2Config}
                  onSave={async (value) => {
                    const result = await putAgentV2AdminConfig(value);
                    if (result.success && result.data) {
                      setAgentV2Config(result.data);
                      flash('知萃 AI 配置已保存');
                      return true;
                    }
                    setErr(result.error || '知萃 AI 配置保存失败');
                    return false;
                  }}
                />
              )}

              {creatorSyncConfig && (
                <CreatorSyncConfigPanel
                  config={creatorSyncConfig}
                  onSave={async (value) => {
                    const result = await putCreatorSyncAdminConfig(value);
                    if (result.success && result.data) {
                      setCreatorSyncConfig(result.data);
                      flash('博主同步配置已保存');
                      return true;
                    }
                    setErr(result.error || '博主同步配置保存失败');
                    return false;
                  }}
                  onTest={async (platform, profileRef) => {
                    const result = await testCreatorSyncConnector(platform, profileRef);
                    await refreshCreatorSyncConfig();
                    return result;
                  }}
                />
              )}

              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">数据库</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <InfoRow label="数据库类型" value={systemInfo.db_type} />
                  <InfoRow label="用户总数" value={String(systemInfo.users)} />
                  <InfoRow label="笔记总数" value={String(systemInfo.notes)} />
                  <InfoRow label="计划总数" value={String(systemInfo.plans)} />
                </div>
              </div>

              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">LLM 配置</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <InfoRow label="模型" value={systemInfo.llm_model} />
                  <InfoRow label="API Base" value={systemInfo.llm_api_base} />
                  <InfoRow label="API Key" value={systemInfo.llm_key_set ? '✓ 已配置' : '✗ 未配置'} ok={systemInfo.llm_key_set} />
                </div>
              </div>

              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">ASR 配置</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <InfoRow label="模型" value={systemInfo.asr_model} />
                  <InfoRow label="API Base URL" value={systemInfo.asr_api_base_url || '-'} />
                  <InfoRow label="API Key" value={systemInfo.asr_key_set ? '✓ 已配置' : '✗ 未配置'} ok={systemInfo.asr_key_set} />
                </div>
              </div>

              <div className="admin-panel p-5">
                <h2 className="text-base font-semibold text-foreground mb-3">安全</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <InfoRow label="加密密钥 (Fernet)" value={systemInfo.encryption_key_set ? '✓ 已设置' : '✗ 未设置'} ok={systemInfo.encryption_key_set} />
                  <InfoRow label="JWT Secret" value={systemInfo.jwt_secret_set ? '✓ 已设置' : '✗ 未设置'} ok={systemInfo.jwt_secret_set} />
                </div>
                <p className="text-xs text-foreground-muted mt-3">
                  动态密钥（LLM/ASR API Key）通过管理端 UI 修改后 Fernet 加密存数据库；静态密钥（JWT_SECRET、ENCRYPTION_KEY）在服务器 .env 配置。
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 用户详情抽屉 */}
      {userDetail !== null || userDetailLoading ? (
        <Drawer title="用户详情" onClose={() => { setUserDetail(null); setUserDetailLoading(false); }}>
          {userDetailLoading ? <div className="text-center text-foreground-muted py-8 text-sm">加载中…</div> :
            userDetail ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-accent-brand/15 flex items-center justify-center text-accent-brand text-lg font-bold">
                    {(userDetail.username || userDetail.email)[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-base font-bold text-foreground">{userDetail.username || '-'}</div>
                    <div className="text-xs text-foreground-muted">{userDetail.email}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InfoRow label="用户 ID" value={userDetail.id.slice(0, 12)} />
                  <InfoRow label="角色" value={userDetail.is_admin ? '管理员' : '用户'} />
                  <InfoRow label="状态" value={userDetail.is_active ? '正常' : '禁用'} ok={userDetail.is_active} />
                  <InfoRow label="注册时间" value={new Date(userDetail.created_at).toLocaleString()} />
                  <InfoRow label="笔记数" value={String(userDetail.notes_count)} />
                  <InfoRow label="计划数" value={String(userDetail.plans_count)} />
                </div>
                <div>
                  <div className="text-xs text-foreground-muted mb-2">最近笔记</div>
                  {userDetail.recent_notes.length === 0 ? <div className="text-xs text-foreground-muted">无</div> : (
                    <div className="space-y-1.5">
                      {userDetail.recent_notes.map(n => (
                        <div key={n.id} className="flex items-center justify-between text-sm">
                          <span className="text-foreground truncate">{n.video_title}</span>
                          <span className="text-xs text-foreground-muted shrink-0 ml-2">{CARD_TYPE_LABELS[n.card_type] || n.card_type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-foreground-muted mb-2">最近计划</div>
                  {userDetail.recent_plans.length === 0 ? <div className="text-xs text-foreground-muted">无</div> : (
                    <div className="space-y-1.5">
                      {userDetail.recent_plans.map(p => (
                        <div key={p.id} className="flex items-center justify-between text-sm">
                          <span className="text-foreground truncate">{p.title || '-'}</span>
                          <span className="text-xs text-foreground-muted shrink-0 ml-2">{p.status === 'done' ? '已完成' : '进行中'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <AdminAnalysisAccountCard userId={userDetail.id} />
                <ResetPasswordForm onSubmit={async (pwd) => resetPassword(userDetail.id, pwd)} />
                <EditUserForm
                  initialUsername={userDetail.username || ''}
                  initialEmail={userDetail.email}
                  onSubmit={async (username, email) => editUser(userDetail.id, username, email)}
                />
              </div>
            ) : null}
        </Drawer>
      ) : null}

      {/* 笔记详情抽屉 */}
      {noteDetail !== null || noteDetailLoading ? (
        <Drawer title="笔记详情" onClose={() => { setNoteDetail(null); setNoteDetailLoading(false); }} wide>
          {noteDetailLoading ? <div className="text-center text-foreground-muted py-8 text-sm">加载中…</div> :
            noteDetail ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs text-foreground-muted mb-1">标题</div>
                  <div className="text-base font-bold text-foreground">{noteDetail.video_title || noteDetail.title}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InfoRow label="类型" value={CARD_TYPE_LABELS[noteDetail.card_type] || noteDetail.card_type} />
                  <InfoRow label="评分" value={`${noteDetail.pitfall_rating} 星`} />
                  <InfoRow label="创建" value={new Date(noteDetail.created_at).toLocaleString()} />
                  <InfoRow label="章节" value={`${noteDetail.sections?.length || 0} 节`} />
                </div>
                {noteDetail.sections && noteDetail.sections.length > 0 && (
                  <div>
                    <div className="text-xs text-foreground-muted mb-2">章节内容</div>
                    <div className="space-y-2">
                      {noteDetail.sections.map((s, i) => (
                        <div key={i} className="rounded-lg bg-[var(--admin-surface-2)] p-3">
                          <div className="text-sm font-semibold text-foreground mb-1">{s.emoji || '▸'} {s.title}</div>
                          <div className="text-xs text-foreground-muted whitespace-pre-wrap leading-relaxed">{s.content}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {noteDetail.conclusion && (
                  <div>
                    <div className="text-xs text-foreground-muted mb-1">结论</div>
                    <div className="text-sm text-foreground rounded-lg bg-accent-brand/5 border border-accent-brand/20 p-3">{noteDetail.conclusion}</div>
                  </div>
                )}
                {noteDetail.transcript_raw && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-foreground-muted">查看转录原文（{noteDetail.transcript_raw.length} 字）</summary>
                    <div className="mt-2 rounded-lg bg-[var(--admin-surface-2)] p-3 max-h-64 overflow-y-auto whitespace-pre-wrap text-foreground-muted leading-relaxed">{noteDetail.transcript_raw}</div>
                  </details>
                )}
              </div>
            ) : null}
        </Drawer>
      ) : null}

      {/* 计划详情抽屉 */}
      {planDetail !== null || planDetailLoading ? (
        <Drawer title="计划详情" onClose={() => { setPlanDetail(null); setPlanDetailLoading(false); }} wide>
          {planDetailLoading ? <div className="text-center text-foreground-muted py-8 text-sm">加载中…</div> :
            planDetail ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs text-foreground-muted mb-1">标题</div>
                  <div className="text-base font-bold text-foreground">{planDetail.title}</div>
                </div>
                {(() => {
                  const { done, total, pct } = getPlanProgress(planDetail);
                  return (
                    <div className="grid grid-cols-3 gap-2">
                      <InfoRow label="总任务" value={String(total)} />
                      <InfoRow label="已完成" value={String(done)} />
                      <InfoRow label="完成率" value={`${pct}%`} ok={pct === 100} />
                    </div>
                  );
                })()}
                {planDetail.days && planDetail.days.length > 0 ? (
                  <div>
                    <div className="text-xs text-foreground-muted mb-2">日程（{planDetail.days.length} 天）</div>
                    <div className="space-y-2">
                      {planDetail.days.map(d => (
                        <div key={d.day} className="rounded-lg bg-[var(--admin-surface-2)] p-3">
                          <div className="text-sm font-semibold text-foreground mb-2">{d.label || `第${d.day}天`}</div>
                          {d.tasks.length === 0 ? <div className="text-xs text-foreground-muted">无任务</div> : (
                            <div className="space-y-1">
                              {d.tasks.map(t => (
                                <div key={t.id} className="flex items-center gap-2 text-xs">
                                  <span className={t.done ? 'text-accent-brand' : 'text-foreground-muted'}>{t.done ? '✓' : '○'}</span>
                                  <span className={t.done ? 'text-foreground-muted line-through' : 'text-foreground'}>{t.title}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : planDetail.tasks && planDetail.tasks.length > 0 ? (
                  <div>
                    <div className="text-xs text-foreground-muted mb-2">任务列表</div>
                    <div className="space-y-1">
                      {planDetail.tasks.map(t => (
                        <div key={t.id} className="flex items-center gap-2 text-xs rounded bg-[var(--admin-surface-2)] p-2">
                          <span className={t.done ? 'text-accent-brand' : 'text-foreground-muted'}>{t.done ? '✓' : '○'}</span>
                          <span className={t.done ? 'text-foreground-muted line-through' : 'text-foreground'}>{t.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  featured = false,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  featured?: boolean;
}) {
  return (
    <article className={`${styles.metric} ${featured ? styles.metricFeatured : ''}`}>
      <span className={styles.metricIcon} aria-hidden="true">
        <Icon size={featured ? 22 : 18} strokeWidth={1.7} />
      </span>
      <span>
        <strong className="tabular-nums">{value.toLocaleString('zh-CN')}</strong>
        <small>{label}</small>
      </span>
    </article>
  );
}

function SystemStatusRow({
  icon: Icon,
  label,
  value,
  ok,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className={styles.statusRow}>
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={ok ? styles.statusOk : styles.statusWarning} aria-label={ok ? '状态正常' : '需要处理'} />
    </div>
  );
}

function ExportCard({
  title,
  desc,
  icon,
  onClick,
  loading,
  disabled,
}: {
  title: string;
  desc: string;
  icon: LucideIcon;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const Icon = icon;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${styles.exportCard} admin-panel p-5 text-left disabled:cursor-wait disabled:opacity-60`}
    >
      <span className={styles.exportIcon}><Icon size={20} aria-hidden="true" /></span>
      <div className="text-base font-bold text-foreground mb-1">{title}</div>
      <div className="text-xs text-foreground-muted">{desc}</div>
      <div className="mt-3 text-xs text-accent-brand font-semibold">
        {loading ? '正在整理数据…' : '下载 CSV →'}
      </div>
    </button>
  );
}

function InfoRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[var(--admin-surface-2)]">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className={`text-sm font-medium truncate ${ok === true ? 'text-accent-brand' : ok === false ? 'text-accent-rose' : 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function Drawer({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative h-full ${wide ? 'max-w-2xl' : 'max-w-md'} w-full admin-sidebar overflow-y-auto p-6 shadow-2xl`}
        style={{ animation: 'adminDrawerIn 220ms cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-foreground">{title}</h2>
          <button type="button" onClick={onClose} aria-label={`关闭${title}`} className={styles.drawerClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ResetPasswordForm({ onSubmit }: { onSubmit: (pwd: string) => Promise<boolean> }) {
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [success, setSuccess] = useState(false);
  return (
    <div className="rounded-lg border border-card-border p-3 space-y-2">
      <div className="text-xs font-semibold text-foreground">重置密码</div>
      <input type="password" value={pwd} onChange={e => setPwd(e.target.value)} placeholder="新密码（至少 6 位）" className="w-full px-3 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50" />
      <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="确认新密码" className="w-full px-3 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50" />
      {localErr && <div className="text-xs text-accent-rose">{localErr}</div>}
      {success && <div className="text-xs text-accent-brand">✓ 密码已重置，用户可用新密码登录</div>}
      <button
        onClick={async () => {
          setLocalErr(''); setSuccess(false);
          if (pwd.length < 6) { setLocalErr('密码至少 6 位'); return; }
          if (pwd !== confirm) { setLocalErr('两次输入不一致'); return; }
          setBusy(true);
          const ok = await onSubmit(pwd);
          setBusy(false);
          if (ok) { setSuccess(true); setPwd(''); setConfirm(''); }
        }}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90 disabled:opacity-50"
      >
        {busy ? '提交中…' : '重置密码'}
      </button>
    </div>
  );
}

function EditUserForm({
  initialUsername,
  initialEmail,
  onSubmit,
}: {
  initialUsername: string;
  initialEmail: string;
  onSubmit: (username: string, email: string) => Promise<boolean>;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [success, setSuccess] = useState(false);
  return (
    <div className="rounded-lg border border-card-border p-3 space-y-2">
      <div className="text-xs font-semibold text-foreground">编辑资料</div>
      <div>
        <label className="text-xs text-foreground-muted block mb-1">用户名</label>
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="用户名（至少 2 字）" className="w-full px-3 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50" />
      </div>
      <div>
        <label className="text-xs text-foreground-muted block mb-1">邮箱</label>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱地址" className="w-full px-3 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-sm text-foreground placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50" />
      </div>
      {localErr && <div className="text-xs text-accent-rose">{localErr}</div>}
      {success && <div className="text-xs text-accent-brand">✓ 资料已更新</div>}
      <button
        onClick={async () => {
          setLocalErr(''); setSuccess(false);
          if (username.trim().length < 2) { setLocalErr('用户名至少 2 个字符'); return; }
          if (!email.includes('@')) { setLocalErr('邮箱格式无效'); return; }
          setBusy(true);
          const ok = await onSubmit(username.trim(), email.trim());
          setBusy(false);
          if (ok) setSuccess(true);
        }}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90 disabled:opacity-50"
      >
        {busy ? '保存中…' : '保存资料'}
      </button>
    </div>
  );
}

interface ConfigField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
}

function AgentV2ConfigPanel({
  config,
  onSave,
}: {
  config: AgentV2AdminConfig;
  onSave: (value: AgentV2AdminConfig) => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [rolloutPercent, setRolloutPercent] = useState(config.rollout_percent);
  const [allowlist, setAllowlist] = useState(config.allowlist.join('\n'));
  const [saving, setSaving] = useState(false);
  const [localMessage, setLocalMessage] = useState('');

  return (
    <section className="admin-panel p-5" aria-labelledby="agent-v2-config-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="agent-v2-config-title" className="text-balance text-base font-semibold text-foreground">
            知萃 AI
          </h2>
          <p className="mt-1 max-w-2xl text-pretty text-xs leading-5 text-foreground-muted">
            开启持久 Turn、断线恢复、自动深度研究、逐条观点校验与兼容模式降级。建议先把自己的用户 ID 加入白名单验证，再逐步提高比例。
          </p>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-card-border px-3 text-sm text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          开启 V2
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
        <label>
          <span className="mb-1 block text-xs text-foreground-muted">稳定放量比例</span>
          <div className="flex min-h-11 items-center gap-2 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3">
            <input
              type="number"
              min={0}
              max={100}
              value={rolloutPercent}
              onChange={(event) => setRolloutPercent(
                Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))),
              )}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground focus:outline-none"
            />
            <span className="text-xs text-foreground-muted">%</span>
          </div>
        </label>
        <label>
          <span className="mb-1 block text-xs text-foreground-muted">白名单用户 ID（每行一个）</span>
          <textarea
            rows={3}
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            placeholder="先填入测试账号的用户 ID，可绕过放量比例"
            className="w-full resize-y rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 py-2 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
          />
        </label>
      </div>

      <p className="mt-3 text-xs leading-5 text-foreground-muted">
        {!enabled
          ? '当前所有用户仍使用兼容链路。'
          : rolloutPercent === 100
            ? '当前向所有用户开放；V2 在答案输出前失败时会自动走兼容模式。'
            : `当前向白名单和稳定命中的 ${rolloutPercent}% 用户开放。`}
      </p>
      {localMessage && <p className="mt-2 text-xs text-foreground-muted" role="status">{localMessage}</p>}
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setLocalMessage('');
          const saved = await onSave({
            enabled,
            rollout_percent: rolloutPercent,
            allowlist: Array.from(new Set(
              allowlist.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
            )),
          });
          setSaving(false);
          setLocalMessage(saved ? '配置已生效，无需重启服务。' : '保存失败，请查看页面提示。');
        }}
        className="mt-4 min-h-11 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white hover:bg-accent-brand/90 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存知萃 AI 设置'}
      </button>
    </section>
  );
}

function CreatorSyncConfigPanel({
  config,
  onSave,
  onTest,
}: {
  config: CreatorSyncAdminConfig;
  onSave: (value: {
    enabled: boolean;
    xhs_cookie?: string;
    douyin_concurrency: number;
    bilibili_concurrency: number;
    xiaohongshu_concurrency: number;
  }) => Promise<boolean>;
  onTest: (
    platform: 'douyin' | 'bilibili' | 'xiaohongshu',
    profileRef?: string,
  ) => Promise<ApiResponse<{
    healthy: boolean;
    catalog_healthy?: boolean;
    message?: string;
  }>>;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [cookie, setCookie] = useState('');
  const [concurrency, setConcurrency] = useState(config.concurrency);
  const [testPlatform, setTestPlatform] = useState<'douyin' | 'bilibili' | 'xiaohongshu'>('bilibili');
  const [testProfile, setTestProfile] = useState('');
  const [localMessage, setLocalMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const platformLabels = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' } as const;

  return (
    <section className="admin-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-balance text-base font-semibold text-foreground">博主同步连接器</h2>
          <p className="mt-1 max-w-2xl text-pretty text-xs leading-5 text-foreground-muted">
            用户只能手动同步已保存博主；系统仅保留作品资料与普通文稿，不自动生成摘要或画面解析。
          </p>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-card-border px-3 text-sm text-foreground">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          开放功能
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(Object.keys(platformLabels) as Array<keyof typeof platformLabels>).map((platform) => (
          <div key={platform}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-foreground-muted">
              <span>{platformLabels[platform]}并发</span>
              <span>{config.platforms[platform] ? '已通过测试' : '待测试'}</span>
            </div>
            <label>
              <span className="sr-only">{platformLabels[platform]}并发数</span>
              <input
                type="number"
                min={1}
                max={4}
                value={concurrency[platform]}
                onChange={(event) => setConcurrency((current) => ({
                  ...current,
                  [platform]: Math.max(1, Math.min(4, Math.round(Number(event.target.value) || 1))),
                }))}
                className="min-h-11 w-full rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
              />
            </label>
          </div>
        ))}
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-foreground-muted">
          小红书服务 Cookie（当前 {config.xhs_cookie_masked || '未配置'}）
        </span>
        <input
          type="password"
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder="留空表示不修改"
          className="min-h-11 w-full rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
        />
      </label>

      <div className="mt-4 border-t border-card-border pt-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto]">
          <select
            value={testPlatform}
            onChange={(event) => setTestPlatform(event.target.value as typeof testPlatform)}
            className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground"
            aria-label="测试平台"
          >
            <option value="bilibili">B站</option>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
          </select>
          <input
            value={testProfile}
            onChange={(event) => setTestProfile(event.target.value)}
            placeholder="测试博主主页（可选）"
            className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
          />
          <button
            type="button"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const result = await onTest(testPlatform, testProfile);
              setTesting(false);
              setLocalMessage(result.success && result.data?.healthy
                ? result.data.message || '连接测试通过'
                : result.error || result.data?.message || '连接测试未通过');
            }}
            className="min-h-11 rounded-lg border border-card-border px-4 text-sm font-semibold text-foreground disabled:opacity-50"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
      </div>

      {localMessage && <p className="mt-3 text-xs text-foreground-muted" role="status">{localMessage}</p>}
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          const saved = await onSave({
            enabled,
            ...(cookie.trim() ? { xhs_cookie: cookie.trim() } : {}),
            douyin_concurrency: concurrency.douyin,
            bilibili_concurrency: concurrency.bilibili,
            xiaohongshu_concurrency: concurrency.xiaohongshu,
          });
          setSaving(false);
          if (saved) setCookie('');
        }}
        className="mt-4 min-h-11 rounded-lg bg-accent-brand px-4 text-sm font-semibold text-white hover:bg-accent-brand/90 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存连接器设置'}
      </button>
    </section>
  );
}

function ExtractionConcurrencyPanel({
  config,
  onSave,
}: {
  config: ExtractionConfig;
  onSave: (asrConcurrency: number, llmConcurrency: number) => Promise<boolean>;
}) {
  const [asrConcurrency, setAsrConcurrency] = useState(config.asr_concurrency);
  const [llmConcurrency, setLlmConcurrency] = useState(config.llm_concurrency);
  const [saving, setSaving] = useState(false);
  const clamp = (value: number, maximum: number) => (
    Math.max(1, Math.min(maximum, Math.round(value || 1)))
  );

  return (
    <section className="admin-panel p-5">
      <h2 className="text-base font-semibold text-foreground">批量文案并发</h2>
      <p className="mt-1 text-xs leading-6 text-foreground-muted">
        自动转写单批最多 {config.max_batch_items} 条，系统可同时承载最多 {config.max_asr_concurrency} 个 ASR 执行任务，适合多个用户并行使用。AI 初始化单批最多 {config.max_ai_batch_items} 条并独立限流；数据库不保存视频文件。
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs text-foreground-muted">
            ASR 同时执行（1–{config.max_asr_concurrency}）
          </span>
          <input
            type="number"
            min={1}
            max={config.max_asr_concurrency}
            value={asrConcurrency}
            onChange={(event) => setAsrConcurrency(
              clamp(Number(event.target.value), config.max_asr_concurrency),
            )}
            className="w-full rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 py-2 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs text-foreground-muted">
            AI 同时执行（1–{config.max_llm_concurrency}）
          </span>
          <input
            type="number"
            min={1}
            max={config.max_llm_concurrency}
            value={llmConcurrency}
            onChange={(event) => setLlmConcurrency(
              clamp(Number(event.target.value), config.max_llm_concurrency),
            )}
            className="w-full rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 py-2 text-sm text-foreground focus:border-accent-brand/50 focus:outline-none"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          await onSave(
            clamp(asrConcurrency, config.max_asr_concurrency),
            clamp(llmConcurrency, config.max_llm_concurrency),
          );
          setSaving(false);
        }}
        className="mt-4 rounded-lg bg-accent-brand px-4 py-2 text-sm font-semibold text-white hover:bg-accent-brand/90 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存并发设置'}
      </button>
    </section>
  );
}

function ConfigForm({
  title,
  desc,
  fields,
  onSave,
  onTest,
}: {
  title: string;
  desc: string;
  fields: ConfigField[];
  onSave: (vals: Record<string, string>) => Promise<void>;
  onTest?: () => Promise<ApiResponse<ConfigTestResult>>;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConfigTestResult | null>(null);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">{title}</h1>
      <div className="admin-panel p-5">
        <p className="text-xs text-foreground-muted mb-4">{desc}</p>
        <div className="space-y-3">
          {fields.map(f => (
            <div key={f.key}>
              <label className="text-xs text-foreground-muted block mb-1">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                value={vals[f.key] ?? ''}
                onChange={e => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full px-3 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-foreground text-sm placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-brand/50"
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2 items-center">
          <button
            onClick={async () => { setSaving(true); await onSave(vals); setSaving(false); }}
            disabled={saving || testing}
            className="px-4 py-2 rounded-lg bg-accent-brand text-white text-sm font-semibold hover:bg-accent-brand/90 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {onTest && (
            <button
              onClick={async () => {
                setTesting(true); setTestResult(null);
                const r = await onTest();
                setTesting(false);
                if (r.success && r.data) setTestResult(r.data);
                else setTestResult({ ok: false, error: r.error || '请求失败' });
              }}
              disabled={saving || testing}
              className="px-4 py-2 rounded-lg bg-[var(--admin-surface-2)] border border-card-border text-foreground text-sm font-semibold hover:brightness-95 disabled:opacity-50"
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
          )}
        </div>
        {testResult && (
          <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${testResult.ok ? 'text-accent-brand bg-accent-brand/5' : 'text-accent-rose bg-accent-rose/5'}`}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.error || testResult.note || testResult.reply || ''}
            {testResult.model ? ` (${testResult.model})` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
