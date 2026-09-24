'use client';

import { useState } from 'react';
import { Check, Clipboard, Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DesktopAgentClient, DesktopAgentIntegrationOverview, DesktopAgentOperation } from '@/lib/desktopRuntime';
import { AGENT_CORE_HANDOFF_PROMPT, AGENT_HANDOFF_PROMPT, agentConnectionStep } from '@/lib/agentQuickConnect';
import styles from './AgentQuickConnect.module.css';

interface Props {
  desktop: boolean;
  bridgeAvailable: boolean;
  overview: DesktopAgentIntegrationOverview | null;
  interfaceDisabled: boolean;
  releaseProfile?: 'core' | 'full';
  loginCommand: string;
  pending: string;
  copied: boolean;
  commandCopied: boolean;
  onAction: (client: DesktopAgentClient, operation: DesktopAgentOperation) => void;
  onCopy: (text: string) => void;
  onCopyCommand: () => void;
  onManualAuthorization: () => void;
}

export default function AgentQuickConnect({ desktop, bridgeAvailable, overview, interfaceDisabled, releaseProfile, loginCommand, pending, copied, commandCopied, onAction, onCopy, onCopyCommand, onManualAuthorization }: Props) {
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
  const coreAccess = releaseProfile === 'core';
  const handoffPrompt = coreAccess ? AGENT_CORE_HANDOFF_PROMPT : overview?.setup_prompt || AGENT_HANDOFF_PROMPT;

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
          {interfaceDisabled && !status?.configured && <p>可以先安装连接；服务启用后，再确认授权。</p>}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || !canInstall}
            onClick={() => onAction(client, step.action)}>
            {busy ? <Loader2 size={17} className={styles.spinner} /> : step.ready ? <RefreshCw size={17} /> : <Download size={17} />}
            {busy ? waiting ? '等待确认' : '正在处理…' : step.action === 'setup' ? `安装到 ${client === 'codex' ? 'Codex' : 'Claude Code'}` : step.action === 'authorize' ? '授权连接' : '重新检查'}
          </button>
          {waiting && <button type="button" onClick={() => onAction(client, 'cancel_authorization')}>取消授权</button>}
          <button type="button" onClick={() => onCopy(handoffPrompt)}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? '已复制提示词' : '复制给 Agent 的提示词'}
          </button>
        </div>
        {needsUpdate ? <p className={styles.hint}>请在客户端的更新提示中安装新版，即可使用页内授权和自动维护连接。</p>
          : <p className={styles.hint}>连接组件和 Skill 随知萃更新。更新完成后，在 Agent 中重新连接一次即可。</p>}
      </> : <>
        <ol className={styles.browserSteps}>
          <li><span>1</span><div><strong>在终端发起连接</strong><p>已有知萃 CLI，运行下面的命令。</p></div></li>
          <li><span>2</span><div><strong>在浏览器确认权限</strong><p>登录当前账号，核对请求方后允许连接。</p></div></li>
          <li><span>3</span><div><strong>{coreAccess ? '选择资料问答，或指定公开链接提取' : '把内容交给 Agent'}</strong><p>{coreAccess ? '默认先读取资料；导入链接、提取文稿和下载视频前，按需追加 library:write 授权。' : '凭证保存在本机，以后可直接调用已授权的能力。'}</p></div></li>
        </ol>
        <div className={styles.command}>
          <code>{loginCommand}</code>
          <button type="button" onClick={onCopyCommand} aria-label="复制 CLI 授权命令">{commandCopied ? <Check size={16} /> : <Clipboard size={16} />}{commandCopied ? '已复制' : '复制命令'}</button>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={interfaceDisabled} onClick={onManualAuthorization}><ShieldCheck size={17} />输入设备授权码</button>
          <button type="button" onClick={() => onCopy(handoffPrompt)}>{copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? '已复制提示词' : '复制接入提示词'}</button>
        </div>
        <p className={styles.hint}>还没有 CLI？<a href="/download">下载知萃电脑客户端</a>，在侧边栏「Agent 接入」中安装连接。</p>
      </>}
    </section>
  );
}
