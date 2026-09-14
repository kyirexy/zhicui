'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  AgentInterfaceApiError,
  approveAgentDeviceAuthorization,
  getAgentDeviceAuthorizationRequest,
  type AgentDeviceAuthorizationPreview,
} from '@/lib/agentInterfaceApi';
import { useAuth } from '@/lib/hooks/AuthContext';
import styles from './AgentDeviceAuthorizationCard.module.css';

const SCOPE_LABELS: Record<string, string> = {
  'account:read': '读取账号', 'account:manage': '管理账号',
  'library:read': '读取资料库', 'library:write': '整理资料库',
  'creator:read': '读取博主', 'creator:sync': '同步博主',
  'ask:read': '读取对话', 'ask:run': '运行问答',
  'knowledge:read': '读取知识', 'knowledge:write': '整理知识',
  'plan:read': '读取计划', 'plan:write': '修改计划',
  'automation:read': '读取自动摘要', 'automation:write': '管理自动摘要',
  'analysis:read': '读取详细解析', 'analysis:run': '运行详细解析',
  'models:read': '读取模型设置', 'models:write': '修改模型设置',
  'feedback:read': '读取反馈', 'feedback:write': '提交反馈',
  'local:invoke': '调用本机能力',
};

function authorizationError(error: unknown): string {
  if (error instanceof AgentInterfaceApiError) {
    if (error.code === 'INTERFACE_DISABLED') return 'Agent 接入暂未开放，请稍后从客户端重新连接。';
    if (error.code === 'DEVICE_CODE_EXPIRED') return '授权码已过期，请从客户端重新发起连接。';
    if (error.code === 'DEVICE_CODE_USED') return '这个授权请求已处理，请返回客户端查看连接状态。';
    if (error.code === 'ROLLOUT_RESTRICTED') return '当前账号暂未开放 Agent 接入。';
    if (error.code === 'DEVICE_CODE_INVALID') return '没有找到这个授权请求，请核对授权码。';
  }
  return '暂时无法处理授权，请重试。';
}

interface CheckedRequest {
  code: string;
  userId: string;
  details: AgentDeviceAuthorizationPreview;
}

export default function AgentDeviceAuthorizationCard({ initialCode }: { initialCode: string }) {
  const { user } = useAuth();
  const userId = user?.id;
  const titleId = useId();
  const generation = useRef(0);
  const decisionLock = useRef(false);
  const [code, setCode] = useState(initialCode.trim().toUpperCase().slice(0, 16));
  const [request, setRequest] = useState<CheckedRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<'approve' | 'deny' | ''>('');
  const [result, setResult] = useState<'approved' | 'denied' | ''>('');
  const [error, setError] = useState('');
  const cleanCode = code.trim().toUpperCase();
  const checked = request?.code === cleanCode && request.userId === user?.id;

  const preview = useCallback(async (value: string) => {
    const normalized = value.trim().toUpperCase();
    const current = ++generation.current;
    setRequest(null);
    setError('');
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
      setLoading(false);
      setError('请输入客户端显示的完整授权码，例如 ABCD-EFGH。');
      return;
    }
    if (!userId) return;
    setLoading(true);
    try {
      const details = await getAgentDeviceAuthorizationRequest(normalized);
      if (current !== generation.current) return;
      if (details.status !== 'pending' || !details.client_name || !Array.isArray(details.scopes)
        || details.scopes.length === 0 || !Number.isFinite(Date.parse(details.expires_at))) {
        setError('授权请求不完整，请从客户端重新发起连接。');
      } else if (Date.parse(details.expires_at) <= Date.now()) {
        setError('授权码已过期，请从客户端重新发起连接。');
      } else {
        setRequest({ code: normalized, userId, details });
      }
    } catch (previewError) {
      if (current === generation.current) setError(authorizationError(previewError));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setRequest(null);
    setResult('');
    setLoading(false);
    setError('');
    decisionLock.current = false;
    setDecision('');
    if (initialCode) void preview(initialCode);
    return () => { generation.current += 1; };
  }, [initialCode, preview]);

  const decide = async (approve: boolean) => {
    if (!checked || !request || decisionLock.current || result) return;
    decisionLock.current = true;
    const current = ++generation.current;
    setDecision(approve ? 'approve' : 'deny');
    setError('');
    try {
      const response = await approveAgentDeviceAuthorization(request.code, approve);
      if (current !== generation.current) return;
      const expected = approve ? 'approved' : 'denied';
      if (response.status !== expected) throw new Error('Unexpected authorization status');
      setResult(expected);
      setRequest(null);
    } catch (decisionError) {
      if (current === generation.current) setError(authorizationError(decisionError));
    } finally {
      if (current === generation.current) {
        decisionLock.current = false;
        setDecision('');
      }
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.card} aria-labelledby={titleId}>
        <div className={styles.icon} aria-hidden="true"><ShieldCheck size={24} /></div>
        <h1 id={titleId}>{result === 'approved' ? '已允许连接' : result === 'denied' ? '已拒绝连接' : '允许这个 Agent 连接知萃？'}</h1>
        {result ? (
          <div role="status">
            <p>{result === 'approved' ? '返回刚才的客户端或 Agent，等待它完成连接检查。' : '这次请求未获得访问权限，可以关闭此页面。'}</p>
            <Link className={styles.link} href="/">返回知萃</Link>
          </div>
        ) : (
          <>
            <p>确认是你刚发起的连接，再允许访问。</p>
            <p className={styles.account}>当前账号：<strong>{user?.username || user?.email}</strong></p>
            <form onSubmit={(event) => { event.preventDefault(); void preview(code); }} className={styles.form}>
              <label htmlFor={`${titleId}-code`}>授权码</label>
              <div className={styles.codeRow}>
                <input id={`${titleId}-code`} value={code} maxLength={16} autoComplete="one-time-code" spellCheck={false}
                  placeholder="ABCD-EFGH" disabled={Boolean(decision)}
                  onChange={(event) => { generation.current += 1; setLoading(false); setCode(event.target.value.toUpperCase()); setRequest(null); setError(''); }} />
                <button type="submit" disabled={loading || Boolean(decision) || !cleanCode}>{loading ? '正在核对…' : '核对授权码'}</button>
              </div>
            </form>
            {checked && request && (
              <div className={styles.preview} aria-label="请求的访问权限">
                <h2>{request.details.client_name}</h2>
                <p>希望获得以下权限：</p>
                <ul>{request.details.scopes.map((scope) => <li key={scope}>{SCOPE_LABELS[scope] || scope}</li>)}</ul>
                <p className={styles.expiry}>有效至 {new Date(request.details.expires_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            )}
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <button type="button" disabled={!checked || Boolean(decision) || loading} onClick={() => void decide(false)}>{decision === 'deny' ? '正在拒绝…' : '拒绝'}</button>
              <button type="button" className={styles.primary} disabled={!checked || Boolean(decision) || loading} onClick={() => void decide(true)}>{decision === 'approve' ? '正在授权…' : '允许连接'}</button>
            </div>
            <p className={styles.hint}>只批准你主动发起的请求。之后可在客户端的 Agent 接入中解除授权。</p>
          </>
        )}
      </section>
    </div>
  );
}
