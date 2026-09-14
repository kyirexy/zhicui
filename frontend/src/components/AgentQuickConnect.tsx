'use client';

import { useState } from 'react';
import { Check, Clipboard, Download, Loader2, RefreshCw } from 'lucide-react';
import type { DesktopAgentClient, DesktopAgentIntegrationOverview, DesktopAgentOperation } from '@/lib/desktopRuntime';
import { AGENT_HANDOFF_PROMPT, agentConnectionStep } from '@/lib/agentQuickConnect';
import styles from './AgentQuickConnect.module.css';

interface Props {
  desktop: boolean;
  bridgeAvailable: boolean;
  overview: DesktopAgentIntegrationOverview | null;
  interfaceDisabled: boolean;
  pending: string;
  copied: boolean;
  onAction: (client: DesktopAgentClient, operation: DesktopAgentOperation) => void;
  onCopy: (text: string) => void;
}

export default function AgentQuickConnect({ desktop, bridgeAvailable, overview, interfaceDisabled, pending, copied, onAction, onCopy }: Props) {
  const [selectedClient, setClient] = useState<DesktopAgentClient>('codex');
  const pendingClient = pending.split(':')[0];
  const client = pendingClient === 'codex' || pendingClient === 'claude' ? pendingClient : selectedClient;
  const status = overview?.clients.find((item) => item.client === client);
  const supportsAuthorization = overview?.capabilities?.supports_authorization === true;
  const step = agentConnectionStep({ status, loading: desktop && !overview, interfaceDisabled, supportsAuthorization });
  const busy = Boolean(pending);
  const waiting = pending.endsWith(':authorize');
  const canInstall = bridgeAvailable && overview?.cli_available === true;
  const needsUpdate = desktop && (!bridgeAvailable || (overview !== null && !supportsAuthorization));

  return (
    <section className={styles.panel} aria-labelledby="quick-agent-title">
      <div className={styles.heading}>
        <h3 id="quick-agent-title">连接你的 AI Agent</h3>
        <p>让它直接查找视频、分析文稿、整理知识和计划。</p>
      </div>
      {desktop ? <>
        <div className={styles.choices} role="group" aria-label="选择要连接的 Agent">
          {(['codex', 'claude'] as const).map((item) => <button
            key={item} type="button" aria-pressed={client === item} disabled={busy}
            onClick={() => setClient(item)}
          >{item === 'codex' ? 'Codex' : 'Claude Code'}</button>)}
        </div>
        <ol className={styles.steps} aria-label="接入进度">
          <li data-done={Boolean(status?.configured && status.managed !== false)}><span>{status?.configured && status.managed !== false ? <Check size={15} /> : '1'}</span>安装连接</li>
          <li data-done={!interfaceDisabled && status?.authenticated === true}><span>{!interfaceDisabled && status?.authenticated === true ? <Check size={15} /> : '2'}</span>确认授权</li>
          <li data-done={step.ready}><span>{step.ready ? <Check size={15} /> : '3'}</span>交给 Agent 使用</li>
        </ol>
        <div className={styles.state} role="status" aria-live="polite">
          <strong>{waiting ? '请在下方确认授权' : step.label}</strong>
          <p>{waiting ? '核对请求方和权限，确认后会自动完成连接。' : step.description}</p>
          {interfaceDisabled && !status?.configured && <p>可以先安装连接；云端接入开放后，再完成授权。</p>}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || !canInstall}
            onClick={() => onAction(client, step.action)}>
            {busy ? <Loader2 size={17} className={styles.spinner} /> : step.ready ? <RefreshCw size={17} /> : <Download size={17} />}
            {busy ? waiting ? '等待确认' : '正在处理…' : step.action === 'setup' ? `安装到 ${client === 'codex' ? 'Codex' : 'Claude Code'}` : step.action === 'authorize' ? '授权连接' : '重新检查'}
          </button>
          {waiting && <button type="button" onClick={() => onAction(client, 'cancel_authorization')}>取消授权</button>}
          <button type="button" onClick={() => onCopy(overview?.setup_prompt || AGENT_HANDOFF_PROMPT)}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? '已复制提示词' : '复制给 Agent 的提示词'}
          </button>
        </div>
        {needsUpdate ? <p className={styles.hint}>请在客户端的更新提示中安装新版，即可使用页内授权和自动维护连接。</p>
          : <p className={styles.hint}>连接组件和 Skill 随知萃更新。更新完成后，在 Agent 中重新连接一次即可。</p>}
      </> : <>
        <p className={styles.webHint}>在知萃电脑客户端中选择 Agent，即可安装连接并确认授权。手机上可以查看和管理已授权的连接。</p>
        <div className={styles.actions}>
          <a className={styles.primary} href="/download"><Download size={17} />下载电脑客户端</a>
          <button type="button" onClick={() => onCopy(AGENT_HANDOFF_PROMPT)}><Clipboard size={17} />{copied ? '已复制提示词' : '复制给 Agent 的提示词'}</button>
        </div>
        {interfaceDisabled && <p className={styles.hint}>云端接入尚未开放。你可以先准备客户端，开放后再授权。</p>}
      </>}
    </section>
  );
}
