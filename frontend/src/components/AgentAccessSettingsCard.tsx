'use client';

import {
  Bot,
  Check,
  ChevronRight,
  CircleX,
  Clipboard,
  Code2,
  KeyRound,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentInterfaceApiError,
  approveAgentPendingConfirmation,
  approveAgentDeviceAuthorization,
  createAgentPat,
  getAgentPendingConfirmation,
  getAgentDeviceAuthorizationRequest,
  getAgentCapabilities,
  listAgentCredentials,
  listAgentDevices,
  listAgentPendingConfirmations,
  listAgentRecentCalls,
  rejectAgentPendingConfirmation,
  revokeAgentCredential,
  revokeAgentDevice,
  type AgentCapabilities,
  type AgentCredential,
  type AgentDeviceConnection,
  type AgentDeviceAuthorizationPreview,
  type AgentPendingConfirmation,
  type AgentRecentCall,
  type AgentScopeDefinition,
} from '@/lib/agentInterfaceApi';
import {
  agentCredentialPrefix,
  canRunLocalAgentActions,
  canShowAgentInstallGuide,
  isActiveAgentConnection,
  resolveAgentAccessPlatform,
  safeAgentScopes,
} from '@/lib/agentAccessUi';
import {
  supportsDesktopAgentIntegration,
  type DesktopAgentAuthorizationStatus,
  type DesktopAgentClient,
  type DesktopAgentIntegrationOverview,
  type DesktopAgentOperation,
} from '@/lib/desktopRuntime';
import styles from './AgentAccessSettingsCard.module.css';
import AgentQuickConnect from './AgentQuickConnect';

const FALLBACK_SCOPES: AgentScopeDefinition[] = [
  { id: 'library:read', title: '读取资料', description: '查看你已保存的视频资料与文稿。' },
  { id: 'ask:run', title: '发起问答', description: '基于你选择的资料创建和继续问答。' },
  { id: 'knowledge:read', title: '读取知识', description: '查看你保存的知识与卡片。' },
  { id: 'plan:read', title: '读取计划', description: '查看你的计划与任务状态。' },
  { id: 'plan:write', title: '整理计划', description: '创建和更新你的计划与任务。' },
  { id: 'knowledge:write', title: '整理知识', description: '保存和更新你的知识内容。' },
  { id: 'local:invoke', title: '使用本机同步', description: '由桌面客户端执行你发起的视频同步。' },
  { id: 'creator:sync', title: '手动同步博主', description: '只在 Agent 明确调用时启动一次同步。' },
  { id: 'library:write', title: '整理资料', description: '导入链接、提取文稿并修改资料。' },
];

const LOGIN_COMMAND = 'zhicui auth login';
const LOCAL_MCP_SETUP_COMMAND = 'zhicui agent setup --client all';
const REMOTE_MCP_COMMAND = 'codex mcp add zhicui --url https://luxai.cn/mcp --bearer-token-env-var ZHICUI_AGENT_TOKEN';

function formatDate(value: string | null | undefined): string {
  if (!value) return '尚未使用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function callStatusLabel(status: string): string {
  if (status === 'succeeded') return '成功';
  if (status === 'waiting_for_user') return '等待操作';
  if (status === 'canceled') return '已取消';
  if (status === 'running' || status === 'queued') return '进行中';
  return '失败';
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('当前浏览器不支持自动复制，请手动选择文本');
  }
  await navigator.clipboard.writeText(value);
}

interface AgentAccessSettingsCardProps {
  isDesktop: boolean;
  nativeAndroid: boolean;
  nativeIOS?: boolean;
}

type AgentAccessErrorContext = 'global' | 'local' | 'pat' | 'connections' | 'confirmations';

export default function AgentAccessSettingsCard({
  isDesktop,
  nativeAndroid,
  nativeIOS = false,
}: AgentAccessSettingsCardProps) {
  const mountedRef = useRef(true);
  const platform = resolveAgentAccessPlatform({ desktop: isDesktop, android: nativeAndroid, ios: nativeIOS });
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [credentials, setCredentials] = useState<AgentCredential[]>([]);
  const [devices, setDevices] = useState<AgentDeviceConnection[]>([]);
  const [recentCalls, setRecentCalls] = useState<AgentRecentCall[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<AgentPendingConfirmation[]>([]);
  const [selectedConfirmation, setSelectedConfirmation] = useState<AgentPendingConfirmation | null>(null);
  const [confirmationLoadingId, setConfirmationLoadingId] = useState('');
  const [confirmationDecision, setConfirmationDecision] = useState<'approve' | 'reject' | ''>('');
  const [loading, setLoading] = useState(true);
  const [interfaceDisabled, setInterfaceDisabled] = useState(false);
  const [error, setError] = useState('');
  const [errorContext, setErrorContext] = useState<AgentAccessErrorContext>('global');
  const [notice, setNotice] = useState('');
  const [deviceUserCode, setDeviceUserCode] = useState('');
  const [deviceRequestPreview, setDeviceRequestPreview] = useState<AgentDeviceAuthorizationPreview | null>(null);
  const [previewedDeviceCode, setPreviewedDeviceCode] = useState('');
  const [devicePreviewPending, setDevicePreviewPending] = useState(false);
  const [deviceApprovalPending, setDeviceApprovalPending] = useState<'approve' | 'deny' | ''>('');
  const [deviceApprovalComplete, setDeviceApprovalComplete] = useState(false);
  const [copied, setCopied] = useState('');
  const [patName, setPatName] = useState('我的 Agent');
  const [expiryDays, setExpiryDays] = useState(90);
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['library:read']);
  const [creating, setCreating] = useState(false);
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState('');
  const [pendingRevokeId, setPendingRevokeId] = useState('');
  const [desktopOverview, setDesktopOverview] = useState<DesktopAgentIntegrationOverview | null>(null);
  const [localPending, setLocalPending] = useState('');
  const [pendingLocalRemoval, setPendingLocalRemoval] = useState<DesktopAgentClient | null>(null);
  const [automaticAuthorization, setAutomaticAuthorization] = useState(false);
  const [manualAuthorizationOpen, setManualAuthorizationOpen] = useState(false);
  const localPendingRef = useRef('');
  const authorizationRevision = useRef(0);
  const authorizationCodeRef = useRef('');
  const localActionRevision = useRef(0);
  const runningLocalAction = useRef<number | null>(null);
  const activeAuthorizationRef = useRef<{ client: DesktopAgentClient; id: string } | null>(null);
  const desktopBridge = typeof window === 'undefined' ? undefined : window.zhicuiDesktop;

  const loadAccessData = useCallback(async () => {
    setLoading(true);
    setInterfaceDisabled(false);
    setErrorContext('global');
    setError('');
    const results = await Promise.allSettled([
      getAgentCapabilities(),
      listAgentCredentials(),
      listAgentDevices(),
      listAgentRecentCalls(20),
      listAgentPendingConfirmations(20),
    ]);
    const [capabilityResult, credentialResult, deviceResult, callResult, confirmationResult] = results;
    if (!mountedRef.current) return;
    if (capabilityResult.status === 'fulfilled') setCapabilities(capabilityResult.value);
    if (credentialResult.status === 'fulfilled') setCredentials(credentialResult.value);
    if (deviceResult.status === 'fulfilled') setDevices(deviceResult.value);
    if (callResult.status === 'fulfilled') setRecentCalls(callResult.value);
    if (confirmationResult.status === 'fulfilled') setPendingConfirmations(confirmationResult.value);
    const failures = results
      .filter((result) => result.status === 'rejected');
    const disabled = failures.some((result) => (
      result.status === 'rejected'
      && result.reason instanceof AgentInterfaceApiError
      && result.reason.code === 'INTERFACE_DISABLED'
    ));
    setInterfaceDisabled(disabled);
    if (disabled) {
      setError('Agent 接入正在分阶段开放，当前环境尚未启用授权和调用。');
    } else if (failures.length === results.length) {
      const first = failures[0] as PromiseRejectedResult;
      setError(first.reason instanceof Error ? first.reason.message : 'Agent 接入服务暂时不可用');
    } else if (failures.length > 0) {
      setNotice('部分连接信息暂时未能更新，你仍可使用已加载的设置。');
    }
    setLoading(false);
  }, []);

  const handleDesktopAuthorization = useCallback((event: DesktopAgentAuthorizationStatus) => {
      if (!mountedRef.current) return;
      if (activeAuthorizationRef.current && activeAuthorizationRef.current.id !== event.authorization_id) return;
      if (event.status === 'waiting' && event.user_code) {
        if (!event.authorization_id) return;
        activeAuthorizationRef.current = { client: event.client, id: event.authorization_id };
        localPendingRef.current = `${event.client}:authorize`;
        setLocalPending(localPendingRef.current);
        if (authorizationCodeRef.current === event.user_code) return;
        authorizationCodeRef.current = event.user_code;
        const revision = ++authorizationRevision.current;
        setAutomaticAuthorization(true);
        setDeviceApprovalComplete(false);
        setDeviceApprovalPending('');
        setDeviceRequestPreview(null);
        setPreviewedDeviceCode('');
        setDeviceUserCode(event.user_code);
        setDevicePreviewPending(true);
        void getAgentDeviceAuthorizationRequest(event.user_code).then((preview) => {
          if (!mountedRef.current || authorizationRevision.current !== revision) return;
          setDeviceRequestPreview(preview);
          setPreviewedDeviceCode(event.user_code!);
        }).catch(() => {
          if (mountedRef.current && authorizationRevision.current === revision) {
            setErrorContext('local');
            setError('暂时无法读取授权信息，请取消后重新连接。');
          }
        }).finally(() => {
          if (mountedRef.current && authorizationRevision.current === revision) setDevicePreviewPending(false);
        });
      } else if (event.status === 'success' || event.status === 'cancelled' || event.status === 'error') {
        if (!activeAuthorizationRef.current) return;
        authorizationRevision.current += 1;
        authorizationCodeRef.current = '';
        activeAuthorizationRef.current = null;
        if (runningLocalAction.current === null) {
          localPendingRef.current = '';
          setLocalPending('');
        }
        setDevicePreviewPending(false);
        setAutomaticAuthorization(false);
        setDeviceUserCode('');
        setDeviceRequestPreview(null);
        setPreviewedDeviceCode('');
        if (event.status === 'success') {
          void loadAccessData();
          void window.zhicuiDesktop?.getAgentIntegrationStatus?.().then((overview) => {
            if (mountedRef.current) setDesktopOverview(overview);
          }).catch(() => undefined);
        }
      }
  }, [loadAccessData]);

  const loadDesktopStatus = useCallback(async () => {
    if (!canRunLocalAgentActions(platform)) return;
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopAgentIntegration(bridge)) return;
    const revision = authorizationRevision.current;
    try {
      const overview = await bridge.getAgentIntegrationStatus();
      if (mountedRef.current && authorizationRevision.current === revision) {
        setDesktopOverview(overview);
        if (overview.authorization) handleDesktopAuthorization(overview.authorization);
      }
    } catch (statusError) {
      if (mountedRef.current) {
        setDesktopOverview({
          available: false,
          cli_available: false,
          clients: [],
          code: 'DESKTOP_AGENT_STATUS_FAILED',
          message: statusError instanceof Error ? statusError.message : '本机诊断失败',
        });
      }
    }
  }, [platform, handleDesktopAuthorization]);

  useEffect(() => {
    mountedRef.current = true;
    const searchCode = new URLSearchParams(window.location.search).get('user_code');
    if (searchCode) setDeviceUserCode(searchCode.trim().toUpperCase().slice(0, 16));
    void loadAccessData();
    void loadDesktopStatus();
    return () => {
      mountedRef.current = false;
    };
  }, [loadAccessData, loadDesktopStatus]);

  useEffect(() => {
    const bridge = window.zhicuiDesktop;
    if (!bridge?.onAgentAuthorizationStatus) return;
    const unsubscribe = bridge.onAgentAuthorizationStatus(handleDesktopAuthorization);
    return () => {
      unsubscribe();
      authorizationRevision.current += 1;
      authorizationCodeRef.current = '';
      const active = activeAuthorizationRef.current;
      if (active) {
        void bridge.runAgentIntegrationAction?.({ client: active.client, operation: 'cancel_authorization', authorization_id: active.id }).catch(() => undefined);
      }
    };
  }, [handleDesktopAuthorization]);

  const previewDeviceRequest = async () => {
    const code = deviceUserCode.trim().toUpperCase();
    const revision = authorizationRevision.current;
    if (code.length < 8) {
      setErrorContext('global');
      setError('请输入 CLI 中显示的完整授权码');
      return;
    }
    setDevicePreviewPending(true);
    setErrorContext('global');
    setError('');
    setNotice('');
    try {
      const preview = await getAgentDeviceAuthorizationRequest(code);
      if (!mountedRef.current || authorizationRevision.current !== revision) return;
      setDeviceRequestPreview(preview);
      setPreviewedDeviceCode(code);
    } catch (previewError) {
      if (!mountedRef.current || authorizationRevision.current !== revision) return;
      setDeviceRequestPreview(null);
      setPreviewedDeviceCode('');
      setError(previewError instanceof Error ? previewError.message : '读取 Agent 授权请求失败');
    } finally {
      if (mountedRef.current && authorizationRevision.current === revision) setDevicePreviewPending(false);
    }
  };

  const submitDeviceApproval = async (approve: boolean) => {
    const code = deviceUserCode.trim().toUpperCase();
    const revision = authorizationRevision.current;
    if (code.length < 8) {
      setErrorContext('global');
      setError('请输入 CLI 中显示的完整授权码');
      return;
    }
    if (!deviceRequestPreview || previewedDeviceCode !== code) {
      setErrorContext('global');
      setError('请先核对请求方和权限，再决定是否允许连接');
      return;
    }
    setDeviceApprovalPending(approve ? 'approve' : 'deny');
    setErrorContext('global');
    setError('');
    setNotice('');
    try {
      const result = await approveAgentDeviceAuthorization(code, approve);
      if (!mountedRef.current || authorizationRevision.current !== revision) return;
      setDeviceApprovalComplete(true);
      setDeviceRequestPreview(null);
      setPreviewedDeviceCode('');
      setNotice(
        approve
          ? `已允许 ${result.client_name || '本地 Agent'} 连接。CLI 将自动完成登录。`
          : '已拒绝本次连接请求。CLI 不会获得访问权限。',
      );
      if (approve) await loadAccessData();
      if (!mountedRef.current || authorizationRevision.current !== revision) return;
      const url = new URL(window.location.href);
      url.searchParams.delete('user_code');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (approvalError) {
      if (mountedRef.current && authorizationRevision.current === revision) setError(approvalError instanceof Error ? approvalError.message : '处理 Agent 授权失败');
    } finally {
      if (mountedRef.current && authorizationRevision.current === revision) setDeviceApprovalPending('');
    }
  };

  const openConfirmationDetail = async (id: string) => {
    setConfirmationLoadingId(id);
    setErrorContext('confirmations');
    setError('');
    try {
      const detail = await getAgentPendingConfirmation(id);
      setSelectedConfirmation(detail);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : '读取确认请求失败');
    } finally {
      setConfirmationLoadingId('');
    }
  };

  const decideConfirmation = async (approve: boolean) => {
    if (!selectedConfirmation) return;
    setConfirmationDecision(approve ? 'approve' : 'reject');
    setErrorContext('confirmations');
    setError('');
    try {
      const updated = approve
        ? await approveAgentPendingConfirmation(selectedConfirmation.id)
        : await rejectAgentPendingConfirmation(selectedConfirmation.id);
      setPendingConfirmations((current) => (
        current.filter((item) => item.id !== updated.id)
      ));
      setSelectedConfirmation(null);
      setNotice(
        approve
          ? '已批准一次。Agent 必须使用同一个确认编号和原请求重新调用，不能自行重复批准。'
          : '已拒绝本次操作，Agent 无法使用这条确认请求。',
      );
      const calls = await listAgentRecentCalls(20).catch(() => null);
      if (calls) setRecentCalls(calls);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : '处理确认请求失败');
    } finally {
      setConfirmationDecision('');
    }
  };

  const availableScopes = useMemo(() => {
    const supplied = capabilities?.scopes?.length ? capabilities.scopes : FALLBACK_SCOPES;
    const safe = new Set(safeAgentScopes(supplied.map((scope) => scope.id)));
    return supplied.filter((scope) => safe.has(scope.id));
  }, [capabilities]);

  useEffect(() => {
    const safe = new Set(availableScopes.map((scope) => scope.id));
    setSelectedScopes((current) => {
      const retained = current.filter((scope) => safe.has(scope));
      if (retained.length > 0) return retained;
      return safe.has('library:read') ? ['library:read'] : availableScopes.slice(0, 1).map((scope) => scope.id);
    });
  }, [availableScopes]);

  const scopeMap = useMemo(
    () => new Map(availableScopes.map((scope) => [scope.id, scope])),
    [availableScopes],
  );

  const runCopy = async (key: string, value: string) => {
    setErrorContext(key === 'token' ? 'pat' : 'global');
    setError('');
    try {
      await copyText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? '' : current), 1800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : '复制失败');
    }
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) => (
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope]
    ));
  };

  const submitPat = async () => {
    const scopes = safeAgentScopes(selectedScopes);
    if (!patName.trim()) {
      setErrorContext('pat');
      setError('请填写一个便于识别的连接名称');
      return;
    }
    if (scopes.length === 0) {
      setErrorContext('pat');
      setError('请至少选择一项权限');
      return;
    }
    setCreating(true);
    setErrorContext('pat');
    setError('');
    setNotice('');
    try {
      const result = await createAgentPat({
        name: patName.trim().slice(0, 80),
        scopes,
        expires_in_days: expiryDays,
      });
      setOneTimeToken(result.token);
      setCredentials((current) => [
        result.credential,
        ...current.filter((item) => item.id !== result.credential.id),
      ]);
      setNotice('访问令牌已创建。请现在复制，关闭后不会再次显示。');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建访问令牌失败');
    } finally {
      setCreating(false);
    }
  };

  const revokeConnection = async (kind: 'credential' | 'device', id: string) => {
    setRevokingId(id);
    setErrorContext('connections');
    setError('');
    try {
      if (kind === 'credential') {
        const updated = await revokeAgentCredential(id);
        setCredentials((current) => current.map((item) => item.id === id ? updated : item));
      } else {
        const updated = await revokeAgentDevice(id);
        setDevices((current) => current.map((item) => item.id === id ? updated : item));
      }
      setNotice('连接已吊销，新请求会立即失效。');
      setPendingRevokeId('');
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : '吊销连接失败');
    } finally {
      setRevokingId('');
    }
  };

  const runDesktopAction = async (
    client: DesktopAgentClient,
    operation: DesktopAgentOperation,
  ) => {
    const bridge = window.zhicuiDesktop;
    if (!supportsDesktopAgentIntegration(bridge)) {
      setErrorContext('local');
      setError('当前 Windows 客户端版本不支持 Agent 接入，请先更新客户端');
      return;
    }
    if (operation === 'cancel_authorization') {
      const active = activeAuthorizationRef.current;
      if (!active) return;
      await bridge.runAgentIntegrationAction({ client: active.client, operation, authorization_id: active.id }).catch(() => {
        if (mountedRef.current) { setErrorContext('local'); setError('取消未完成，请稍后重试。'); }
      });
      return;
    }
    if (localPendingRef.current) return;
    const actionRevision = ++localActionRevision.current;
    runningLocalAction.current = actionRevision;
    const ownsAction = () => mountedRef.current && localActionRevision.current === actionRevision;
    const authorizationId = operation === 'authorize' ? crypto.randomUUID() : undefined;
    if (authorizationId) activeAuthorizationRef.current = { client, id: authorizationId };
    const key = `${client}:${operation}`;
    localPendingRef.current = key;
    setLocalPending(key);
    setErrorContext('local');
    setError('');
    setNotice('');
    try {
      const result = await bridge.runAgentIntegrationAction({ client, operation, ...(authorizationId ? { authorization_id: authorizationId } : {}) });
      if (!ownsAction()) return;
      if (result.code === 'AUTHORIZATION_CANCELLED') { setNotice('已取消授权'); return; }
      if (!result.success) throw new Error(result.message || '本机操作没有完成');
      setNotice(result.message || '本机 Agent 配置已更新');
      if (operation === 'uninstall') setPendingLocalRemoval(null);
      if (operation === 'setup' && desktopOverview?.capabilities?.supports_authorization && !interfaceDisabled) {
        const checked = await bridge.getAgentIntegrationStatus();
        if (!ownsAction()) return;
        setDesktopOverview(checked);
        const clientStatus = checked.clients.find((item) => item.client === client);
        if (clientStatus?.configured && clientStatus.authenticated === false && !['INTERFACE_DISABLED', 'ROLLOUT_RESTRICTED'].includes(clientStatus.code || '')) {
          localPendingRef.current = `${client}:authorize`;
          setLocalPending(localPendingRef.current);
          const id = crypto.randomUUID();
          activeAuthorizationRef.current = { client, id };
          const authorization = await bridge.runAgentIntegrationAction({ client, operation: 'authorize', authorization_id: id });
          if (!ownsAction()) return;
          if (authorization.code === 'AUTHORIZATION_CANCELLED') { setNotice('已取消授权'); return; }
          if (!authorization.success) throw new Error(authorization.message || '授权尚未完成');
          setNotice(authorization.message);
        }
      }
      await loadDesktopStatus();
    } catch (actionError) {
      if (ownsAction()) setError(actionError instanceof Error ? actionError.message : '本机 Agent 操作失败');
    } finally {
      if (localActionRevision.current === actionRevision) {
        runningLocalAction.current = null;
        activeAuthorizationRef.current = null;
        localPendingRef.current = '';
        if (mountedRef.current) setLocalPending('');
      }
    }
  };

  const activeCredentials = credentials.filter((item) => isActiveAgentConnection(item));
  const activeDevices = devices.filter((item) => isActiveAgentConnection(item));
  const pendingCredential = activeCredentials.find((item) => item.id === pendingRevokeId);
  const pendingDevice = activeDevices.find((item) => item.id === pendingRevokeId);
  const riskySyncSelected = selectedScopes.some((scope) => (
    scope === 'creator:sync' || scope.endsWith(':write')
  ));

  return (
    <div className={styles.stack}>
      <section className={styles.hero} aria-labelledby="agent-access-title">
        <div className={styles.heroIcon} aria-hidden="true"><Bot size={22} /></div>
        <div className={styles.heroCopy}>
          <h2 id="agent-access-title">Agent 接入</h2>
          <p>
            把知萃连接到你常用的 AI 工具，直接使用已保存的视频和知识。
          </p>
        </div>
        <span className={styles.platformBadge}>
          {platform === 'windows' ? 'Windows 本机 + 云端' : platform === 'android' || platform === 'ios' ? '仅管理授权' : '云端接入'}
        </span>
      </section>

      <AgentQuickConnect
        desktop={canRunLocalAgentActions(platform)}
        bridgeAvailable={supportsDesktopAgentIntegration(desktopBridge)}
        overview={desktopOverview}
        interfaceDisabled={interfaceDisabled}
        pending={localPending}
        copied={copied === 'agent-prompt'}
        onAction={(client, operation) => void runDesktopAction(client, operation)}
        onCopy={(text) => void runCopy('agent-prompt', text)}
      />

      {notice && <div className={styles.noticeBanner} role="status">{notice}</div>}
      {error && errorContext === 'global' && !interfaceDisabled && (
        <div className={styles.errorBanner} role="alert">{error}</div>
      )}

      {error && errorContext === 'local' && (
        <div className={styles.errorBanner} role="alert">{error}</div>
      )}

      {!interfaceDisabled && (deviceUserCode || manualAuthorizationOpen) && <section className={`${styles.card} ${styles.authorizationCard}`} aria-labelledby="device-authorization-title">
        <header className={styles.cardHeader}>
          <span className={styles.cardIcon}><ShieldCheck size={19} /></span>
          <div>
            <h3 id="device-authorization-title">确认连接权限</h3>
            <p>{automaticAuthorization ? '请核对下面的请求方和权限，再决定是否允许连接。' : '输入 Agent 提供的授权码，核对后允许连接。'}</p>
          </div>
        </header>
        <div className={styles.authorizationForm}>
          {!automaticAuthorization && <label>
            <span>授权码</span>
            <input
              value={deviceUserCode}
              disabled={deviceApprovalComplete || Boolean(deviceApprovalPending)}
              maxLength={16}
              inputMode="text"
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="例如 ZHC-8K4M"
              onChange={(event) => {
                authorizationRevision.current += 1;
                setDevicePreviewPending(false);
                setDeviceApprovalComplete(false);
                setDeviceRequestPreview(null);
                setPreviewedDeviceCode('');
                setDeviceUserCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
              }}
            />
          </label>}
          <div className={styles.authorizationActions}>
            <button
              type="button"
              disabled={deviceApprovalComplete || Boolean(deviceApprovalPending) || devicePreviewPending || deviceUserCode.trim().length < 8}
              onClick={() => void previewDeviceRequest()}
            >
              {devicePreviewPending ? <Loader2 size={16} /> : <ShieldCheck size={16} />}
              {devicePreviewPending ? '正在读取权限…' : '核对权限'}
            </button>
            <button
              type="button"
              disabled={deviceApprovalComplete || Boolean(deviceApprovalPending) || previewedDeviceCode !== deviceUserCode.trim().toUpperCase()}
              onClick={() => void submitDeviceApproval(false)}
            >
              {deviceApprovalPending === 'deny' ? <Loader2 size={16} /> : <CircleX size={16} />}
              拒绝
            </button>
            <button
              type="button"
              className={styles.primaryAuthorizationAction}
              disabled={deviceApprovalComplete || Boolean(deviceApprovalPending) || previewedDeviceCode !== deviceUserCode.trim().toUpperCase()}
              onClick={() => void submitDeviceApproval(true)}
            >
              {deviceApprovalPending === 'approve' ? <Loader2 size={16} /> : <Check size={16} />}
              {deviceApprovalComplete ? '已处理' : '允许连接'}
            </button>
          </div>
        </div>
        {deviceRequestPreview && (
          <div className={styles.authorizationPreview} role="status">
            <div>
              <strong>{deviceRequestPreview.client_name}</strong>
              <small>{deviceRequestPreview.client_type} · 授权请求将在 {formatDate(deviceRequestPreview.expires_at)} 失效</small>
            </div>
            <div className={styles.authorizationScopes} aria-label="请求权限">
              {deviceRequestPreview.scopes.map((scope) => (
                <span key={scope}>{scopeMap.get(scope)?.title || scope}</span>
              ))}
            </div>
          </div>
        )}
        <p className={styles.authorizationHint}>
          知萃不会把密码、JWT、Cookie 或 API Key 交给 Agent；已连接设备可随时在下方吊销。
        </p>
      </section>}

      {!interfaceDisabled && (
        <section className={styles.card} aria-labelledby="agent-confirmations-title">
          <header className={styles.cardHeader}>
            <span className={styles.cardIcon}><ShieldCheck size={19} /></span>
            <div>
              <h3 id="agent-confirmations-title">待确认的敏感操作</h3>
              <p>删除、注销、更新安装或密钥修改必须由你在这里确认一次。Agent 不能替你批准。</p>
            </div>
            <span className={styles.pendingCount}>{pendingConfirmations.length}</span>
          </header>
          {error && errorContext === 'confirmations' && (
            <p className={styles.inlineError} role="alert">{error}</p>
          )}
          {pendingConfirmations.length === 0 ? (
            <p className={styles.emptyState}>{loading ? '正在读取确认请求…' : '当前没有等待确认的操作。'}</p>
          ) : (
            <div className={styles.confirmationList}>
              {pendingConfirmations.map((confirmation) => (
                <article key={confirmation.id}>
                  <div>
                    <strong>{confirmation.action_title || confirmation.action_id}</strong>
                    <small>
                      {confirmation.credential_name || '本地 Agent'} · {formatDate(confirmation.created_at)} 发起
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(confirmationLoadingId)}
                    onClick={() => void openConfirmationDetail(confirmation.id)}
                  >
                    {confirmationLoadingId === confirmation.id ? <Loader2 size={15} /> : <ChevronRight size={15} />}
                    查看并处理
                  </button>
                </article>
              ))}
            </div>
          )}
          <dialog
            open={selectedConfirmation !== null}
            className={`${styles.confirmDialog} ${styles.actionConfirmationDialog}`}
            aria-labelledby="action-confirmation-title"
            aria-describedby="action-confirmation-description"
          >
            <strong id="action-confirmation-title">
              {selectedConfirmation?.action_title || '确认这次敏感操作？'}
            </strong>
            <p id="action-confirmation-description">
              {selectedConfirmation?.action_description || '此操作只会批准一次；批准后仍须由原 Agent 使用原请求继续。'}
            </p>
            {selectedConfirmation && (
              <dl className={styles.confirmationDetails}>
                <div>
                  <dt>请求方</dt>
                  <dd>{selectedConfirmation.credential_name} · {selectedConfirmation.credential_prefix}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{selectedConfirmation.action_id}</dd>
                </div>
                <div>
                  <dt>失效时间</dt>
                  <dd>{formatDate(selectedConfirmation.expires_at)}</dd>
                </div>
                <div>
                  <dt>当前状态</dt>
                  <dd>{selectedConfirmation.status === 'pending' ? '等待你处理' : selectedConfirmation.status}</dd>
                </div>
                {selectedConfirmation.confirmation_summary?.targets?.map((target, index) => (
                  <div key={`${target.label}-${index}`}>
                    <dt>{target.label}</dt>
                    <dd>{target.reference}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className={styles.confirmationPrivacyNote}>
              为保护隐私，这里不会返回或展示原始输入、文稿、路径、Cookie、密钥或临时媒体地址。
            </p>
            <div className={styles.confirmDialogActions}>
              <button
                type="button"
                disabled={Boolean(confirmationDecision)}
                onClick={() => setSelectedConfirmation(null)}
              >
                暂不处理
              </button>
              <button
                type="button"
                disabled={Boolean(confirmationDecision) || selectedConfirmation?.status !== 'pending'}
                onClick={() => void decideConfirmation(false)}
              >
                {confirmationDecision === 'reject' ? <Loader2 size={15} /> : <CircleX size={15} />}
                拒绝
              </button>
              <button
                type="button"
                className={styles.dangerAction}
                disabled={Boolean(confirmationDecision) || selectedConfirmation?.status !== 'pending'}
                onClick={() => void decideConfirmation(true)}
              >
                {confirmationDecision === 'approve' ? <Loader2 size={15} /> : <Check size={15} />}
                确认一次
              </button>
            </div>
          </dialog>
        </section>
      )}

      {!interfaceDisabled && canShowAgentInstallGuide(platform) && (
        <details className={styles.advanced}>
        <summary>高级接入：已有 CLI 或远程 MCP</summary>
        <section className={styles.card} aria-labelledby="agent-install-title">
          <header className={styles.cardHeader}>
            <span className={styles.cardIcon}><Code2 size={19} /></span>
            <div>
              <h3 id="agent-install-title">已有 CLI 的连接方式</h3>
              <p>推荐使用上方的客户端安装连接。以下命令适用于已自行安装 CLI 的用户。</p>
            </div>
          </header>
          <div className={styles.commandGrid}>
            <CommandRow
              label="浏览器授权"
              value={LOGIN_COMMAND}
              copied={copied === 'login'}
              onCopy={() => void runCopy('login', LOGIN_COMMAND)}
            />
            <CommandRow
              label="Codex 远程 MCP"
              value={REMOTE_MCP_COMMAND}
              copied={copied === 'remote-mcp'}
              onCopy={() => void runCopy('remote-mcp', REMOTE_MCP_COMMAND)}
            />
          </div>
          <div className={styles.mcpPanel}>
            <div>
              <Code2 size={18} aria-hidden="true" />
              <span>
                <strong>本地 stdio MCP</strong>
                <small>由 CLI 使用系统凭据库连接知萃，并合并 Windows 本机能力</small>
              </span>
            </div>
            <button type="button" onClick={() => void runCopy('mcp', LOCAL_MCP_SETUP_COMMAND)}>
              {copied === 'mcp' ? <Check size={15} /> : <Clipboard size={15} />}
              {copied === 'mcp' ? '已复制' : '复制连接命令'}
            </button>
          </div>
          <p className={styles.authorizationHint}>
            远程 MCP 使用 <code>https://luxai.cn/mcp</code>。请把一次性 PAT 放入
            {' '}<code>ZHICUI_AGENT_TOKEN</code> 环境变量；Codex 配置只保存变量名，不保存令牌明文。
            Claude Code 首版使用上面的本地 stdio MCP，避免把 PAT 写入其配置文件。
          </p>
          <button type="button" className={styles.primaryAction} onClick={() => setManualAuthorizationOpen(true)}>输入其他设备的授权码</button>
        </section>
        </details>
      )}

      {canRunLocalAgentActions(platform) && (
        <details className={styles.advanced}>
        <summary>连接管理与诊断</summary>
        <section className={styles.card} aria-labelledby="desktop-agent-title">
          <header className={styles.cardHeader}>
            <span className={styles.cardIcon}><Laptop size={19} /></span>
            <div>
              <h3 id="desktop-agent-title">管理本机连接</h3>
              <p>重新检查、更新或解除已安装的连接。</p>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="刷新本机 Agent 状态"
              disabled={Boolean(localPending)}
              onClick={() => void loadDesktopStatus()}
            >
              <RefreshCw size={16} />
            </button>
          </header>
          {!supportsDesktopAgentIntegration(desktopBridge) ? (
            <p className={styles.emptyState}>请先更新 Windows 客户端，再连接本机 Agent。</p>
          ) : (
            <div className={styles.localClients}>
              {(['codex', 'claude'] as const).map((client) => {
                const status = desktopOverview?.clients.find((item) => item.client === client);
                const configured = Boolean(status?.configured);
                const title = client === 'codex' ? 'Codex' : 'Claude Code';
                return (
                  <article key={client} className={styles.localClient}>
                    <div className={styles.localClientTop}>
                      <span className={styles.agentMark}>{client === 'codex' ? 'C' : 'A'}</span>
                      <span>
                        <strong>{title}</strong>
                        <small>{status?.message || (configured ? '连接已安装，尚未检查' : '尚未安装连接')}</small>
                      </span>
                      <b className={status?.ready ? styles.statusActive : styles.statusQuiet}>
                        {status?.ready ? '检查通过' : configured ? '已安装' : status?.installed ? '可安装' : '未检测到'}
                      </b>
                    </div>
                    <div className={styles.localActions}>
                      <button
                        type="button"
                        className={styles.primaryAction}
                        disabled={Boolean(localPending)}
                        onClick={() => void runDesktopAction(client, 'setup')}
                      >
                        {localPending === `${client}:setup` ? <Loader2 size={15} /> : <ChevronRight size={15} />}
                        {configured ? '重新检查连接' : `连接 ${title}`}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(localPending)}
                        onClick={() => void runDesktopAction(client, 'doctor')}
                      >
                        <Wrench size={14} />诊断
                      </button>
                      <details className={styles.localMore}>
                        <summary aria-label={`${title} 更多操作`}>•••</summary>
                        <div>
                          <button type="button" onClick={() => void runDesktopAction(client, 'update')}>更新配置</button>
                          <button
                            type="button"
                            onClick={() => setPendingLocalRemoval(client)}
                          >
                            解除连接
                          </button>
                        </div>
                      </details>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {desktopOverview && !desktopOverview.cli_available && (
            <p className={styles.warningText}>{desktopOverview.message || '内置 CLI 尚未就绪，请更新客户端。'}</p>
          )}
          <dialog
            open={pendingLocalRemoval !== null}
            className={styles.confirmDialog}
            role="alertdialog"
            aria-labelledby="local-agent-removal-title"
            aria-describedby="local-agent-removal-description"
          >
            <strong id="local-agent-removal-title">解除本机 Agent 连接？</strong>
            <p id="local-agent-removal-description">
              只会移除知萃拥有的配置区块，不会删除 {pendingLocalRemoval === 'codex' ? 'Codex' : 'Claude Code'} 的其他设置。
            </p>
            <div className={styles.confirmDialogActions}>
              <button type="button" disabled={Boolean(localPending)} onClick={() => setPendingLocalRemoval(null)}>取消</button>
              <button
                type="button"
                className={styles.dangerAction}
                disabled={Boolean(localPending) || pendingLocalRemoval === null}
                onClick={() => pendingLocalRemoval && void runDesktopAction(pendingLocalRemoval, 'uninstall')}
              >
                {localPending.endsWith(':uninstall') ? <Loader2 size={15} /> : <Unplug size={15} />}
                确认解除
              </button>
            </div>
          </dialog>
        </section>
        </details>
      )}

      {!interfaceDisabled && <details className={styles.advanced}>
      <summary>高级接入：个人访问令牌</summary>
      <section className={styles.card} aria-labelledby="pat-title">
        <header className={styles.cardHeader}>
          <span className={styles.cardIcon}><KeyRound size={19} /></span>
          <div>
            <h3 id="pat-title">创建个人访问令牌（PAT）</h3>
            <p>适合 CI 或不能打开浏览器的本地工具。默认 90 天，可随时吊销。</p>
          </div>
        </header>
        {error && errorContext === 'pat' && (
          <p className={styles.inlineError} role="alert">{error}</p>
        )}

        {oneTimeToken && (
          <div className={styles.secretPanel} role="alert">
            <div>
              <ShieldCheck size={18} aria-hidden="true" />
              <span>
                <strong>请现在复制令牌</strong>
                <small>完整令牌只显示这一次。关闭后知萃无法再次找回。</small>
              </span>
            </div>
            <code>{oneTimeToken}</code>
            <div className={styles.secretActions}>
              <button type="button" onClick={() => void runCopy('token', oneTimeToken)}>
                {copied === 'token' ? <Check size={15} /> : <Clipboard size={15} />}
                {copied === 'token' ? '已复制' : '复制令牌'}
              </button>
              <button type="button" onClick={() => setOneTimeToken(null)}>我已保存，关闭</button>
            </div>
          </div>
        )}

        <div className={styles.formRow}>
          <label>
            <span>连接名称</span>
            <input value={patName} maxLength={80} onChange={(event) => setPatName(event.target.value)} />
          </label>
          <label>
            <span>有效期</span>
            <select value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
              <option value={30}>30 天</option>
              <option value={60}>60 天</option>
              <option value={90}>90 天</option>
            </select>
          </label>
        </div>

        <fieldset className={styles.scopeFieldset}>
          <legend>选择权限</legend>
          <p>从最小权限开始；以后需要更多能力时可新建令牌。</p>
          <div className={styles.scopeGrid}>
            {availableScopes.map((scope) => {
              const selected = selectedScopes.includes(scope.id);
              return (
                <label key={scope.id} className={selected ? styles.scopeSelected : ''}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleScope(scope.id)}
                  />
                  <span>
                    <strong>{scope.title}</strong>
                    <small>{scope.description}</small>
                    <code>{scope.id}</code>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {riskySyncSelected && (
          <p className={styles.warningText}>
            同步和写入仍只会在你或 Agent 明确调用时发生，不会自动同步、离线排队或连续风控重试。
          </p>
        )}
        <div className={styles.formActions}>
          <button type="button" disabled={creating || loading} onClick={() => void submitPat()}>
            {creating ? <Loader2 size={16} /> : <KeyRound size={16} />}
            创建 PAT
          </button>
        </div>
      </section></details>}

      {!interfaceDisabled && <section className={styles.card} aria-labelledby="connections-title">
        <header className={styles.cardHeader}>
          <span className={styles.cardIcon}><ShieldCheck size={19} /></span>
          <div>
            <h3 id="connections-title">已授权连接</h3>
            <p>只显示令牌前缀、权限和使用时间；完整令牌不会从服务端返回。</p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="刷新连接"
            disabled={loading}
            onClick={() => void loadAccessData()}
          >
            {loading ? <Loader2 size={16} /> : <RefreshCw size={16} />}
          </button>
        </header>
        {error && errorContext === 'connections' && (
          <p className={styles.inlineError} role="alert">{error}</p>
        )}

        {activeCredentials.length === 0 && activeDevices.length === 0 ? (
          <p className={styles.emptyState}>{loading ? '正在读取连接…' : '还没有已授权的 Agent 连接。'}</p>
        ) : (
          <div className={styles.connectionList}>
            {activeCredentials.map((credential) => (
              <ConnectionRow
                key={credential.id}
                title={credential.name}
                subtitle={`PAT · ${agentCredentialPrefix(credential)} · ${formatDate(credential.last_used_at)}`}
                scopes={credential.scopes}
                scopeMap={scopeMap}
                disabled={revokingId === credential.id}
                onRevoke={() => setPendingRevokeId(credential.id)}
              />
            ))}
            {activeDevices.map((device) => (
              <ConnectionRow
                key={device.id}
                title={device.name}
                subtitle={`${device.client_type || '本地设备'} · ${formatDate(device.last_used_at)}`}
                scopes={device.scopes}
                scopeMap={scopeMap}
                disabled={revokingId === device.id}
                onRevoke={() => setPendingRevokeId(device.id)}
              />
            ))}
          </div>
        )}
        <dialog
          open={Boolean(pendingRevokeId)}
          className={styles.confirmDialog}
          role="alertdialog"
          aria-labelledby="agent-revoke-title"
          aria-describedby="agent-revoke-description"
        >
          <strong id="agent-revoke-title">吊销这个 Agent 连接？</strong>
          <p id="agent-revoke-description">
            {pendingCredential?.name || pendingDevice?.name || '该连接'} 的新请求会立即失效，其他连接不受影响。
          </p>
          <div className={styles.confirmDialogActions}>
            <button type="button" disabled={Boolean(revokingId)} onClick={() => setPendingRevokeId('')}>取消</button>
            <button
              type="button"
              className={styles.dangerAction}
              disabled={Boolean(revokingId) || (!pendingCredential && !pendingDevice)}
              onClick={() => {
                if (pendingCredential) void revokeConnection('credential', pendingCredential.id);
                else if (pendingDevice) void revokeConnection('device', pendingDevice.id);
              }}
            >
              {revokingId ? <Loader2 size={15} /> : <Unplug size={15} />}
              确认吊销
            </button>
          </div>
        </dialog>
      </section>}

      {!interfaceDisabled && <section className={styles.card} aria-labelledby="calls-title">
        <header className={styles.cardHeader}>
          <span className={styles.cardIcon}><RefreshCw size={19} /></span>
          <div>
            <h3 id="calls-title">最近调用</h3>
            <p>记录 Action、状态和请求编号，不显示完整输入、文稿、密钥或本机路径。</p>
          </div>
        </header>
        {recentCalls.length === 0 ? (
          <p className={styles.emptyState}>{loading ? '正在读取调用记录…' : '还没有 Agent 调用记录。'}</p>
        ) : (
          <div className={styles.callList}>
            {recentCalls.slice(0, 12).map((call) => (
              <article key={call.id}>
                <span className={`${styles.callDot} ${call.status === 'failed' ? styles.callDotFailed : ''}`} />
                <div>
                  <strong>{call.action_id}</strong>
                  <small>
                    {formatDate(call.created_at)} · {callStatusLabel(call.status)}
                    {call.credential_prefix ? ` · ${call.credential_prefix}` : ''}
                    {call.duration_ms !== null ? ` · ${call.duration_ms} ms` : ''}
                  </small>
                </div>
                <code>{call.error_code || call.run_id || call.request_id || call.id}</code>
              </article>
            ))}
          </div>
        )}
      </section>}
    </div>
  );
}

function CommandRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={styles.commandRow}>
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" onClick={onCopy}>
        {copied ? <Check size={15} /> : <Clipboard size={15} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

function ConnectionRow({
  title,
  subtitle,
  scopes,
  scopeMap,
  disabled,
  onRevoke,
}: {
  title: string;
  subtitle: string;
  scopes: string[];
  scopeMap: Map<string, AgentScopeDefinition>;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <article className={styles.connectionRow}>
      <span className={styles.connectionIcon}><KeyRound size={17} /></span>
      <div className={styles.connectionCopy}>
        <strong>{title}</strong>
        <small>{subtitle}</small>
        <div>
          {safeAgentScopes(scopes).map((scope) => (
            <span key={scope}>{scopeMap.get(scope)?.title || scope}</span>
          ))}
        </div>
      </div>
      <button type="button" disabled={disabled} onClick={onRevoke}>
        {disabled ? <Loader2 size={15} /> : <Unplug size={15} />}
        吊销
      </button>
    </article>
  );
}
