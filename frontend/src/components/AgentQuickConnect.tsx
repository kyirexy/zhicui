'use client';

import { useState } from 'react';
import { Check, Clipboard, Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DesktopAgentClient, DesktopAgentIntegrationOverview, DesktopAgentOperation } from '@/lib/desktopRuntime';
import { AGENT_CORE_HANDOFF_PROMPT, AGENT_HANDOFF_PROMPT, VIDEO_AGENT_HANDOFF_PROMPT, agentConnectionStep, agentPromptForCommand, type AgentScopePreset } from '@/lib/agentQuickConnect';
import styles from './AgentQuickConnect.module.css';

interface Props {
  desktop: boolean;
  bridgeAvailable: boolean;
  overview: DesktopAgentIntegrationOverview | null;
  interfaceDisabled: boolean;
  releaseProfile?: 'core' | 'full';
  loginCommand: string;
  scopePreset: AgentScopePreset;
  onScopePresetChange: (preset: AgentScopePreset) => void;
  pending: string;
  copied: boolean;
  commandCopied: boolean;
  onAction: (client: DesktopAgentClient, operation: DesktopAgentOperation) => void;
  onCopy: (text: string) => void;
  onCopyCommand: (command: string) => void;
  onManualAuthorization: () => void;
}

export default function AgentQuickConnect({ desktop, bridgeAvailable, overview, interfaceDisabled, releaseProfile, loginCommand, scopePreset, onScopePresetChange, pending, copied, commandCopied, onAction, onCopy, onCopyCommand, onManualAuthorization }: Props) {
  const [selectedClient, setClient] = useState<DesktopAgentClient>('codex');
  const [purpose, setPurpose] = useState<'daily' | 'video'>('daily');
  const videoPurpose = !desktop && purpose === 'video';
  const displayedCommand = loginCommand;
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
  const handoffPrompt = agentPromptForCommand(videoPurpose ? VIDEO_AGENT_HANDOFF_PROMPT : coreAccess ? AGENT_CORE_HANDOFF_PROMPT : overview?.setup_prompt || AGENT_HANDOFF_PROMPT, loginCommand, scopePreset);

  return (
    <section className={styles.panel} aria-labelledby="quick-agent-title">
      <div className={styles.heading}>
        <h3 id="quick-agent-title">连接你的 AI Agent</h3>
        <p>连接后复用已授权权限，导入视频、提取文稿、下载与问答无需每次重新连接。</p>
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
          <button type="button" disabled={interfaceDisabled || !displayedCommand} onClick={() => onCopy(handoffPrompt)}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? '已复制提示词' : '复制给 Agent 的提示词'}
          </button>
        </div>
        {needsUpdate ? <p className={styles.hint}>请在客户端的更新提示中安装新版，即可使用页内授权和自动维护连接。</p>
          : <p className={styles.hint}>连接组件和 Skill 随知萃更新。更新完成后，在 Agent 中重新连接一次即可。</p>}
      </> : <>
        <div className={styles.choices} role="group" aria-label="选择使用方式">
          <button type="button" aria-pressed={purpose === 'daily'} onClick={() => setPurpose('daily')}>日常使用（推荐）</button>
          <button type="button" aria-pressed={purpose === 'video'} onClick={() => setPurpose('video')}>提取视频 · 交给 Hypit</button>
        </div>
        <p className={styles.hint}>{videoPurpose
          ? '把下方提示词交给 Agent，再发视频链接。它会发起连接，授权后继续提取和下载。无需复制令牌。'
          : '一次核对日常使用权限，之后复用连接完成导入、文稿提取、下载、问答及服务支持的本机按需同步。'}</p>
        <label className={styles.permissionPreset}>
          <span>新连接的权限</span>
          <select value={scopePreset} disabled={interfaceDisabled || busy} onChange={(event) => onScopePresetChange(event.target.value as AgentScopePreset)}>
            <option value="daily">日常使用（推荐）</option>
            <option value="read-only">只读访问</option>
            <option value="custom">自定义权限</option>
          </select>
        </label>
        {scopePreset === 'custom' && <p className={styles.hint}><a href="#agent-permissions">调整具体权限</a>，下方命令与个人访问令牌使用相同选择。</p>}
        {scopePreset === 'read-only' && <p className={styles.hint}>本次只读取已有资料。提取新文稿、写入或运行问答需要另行确认相应权限。</p>}
        <ol className={styles.browserSteps}>
          <li><span>1</span><div><strong>{videoPurpose ? '把视频链接交给 Agent' : '在终端发起连接'}</strong><p>{videoPurpose ? '抖音、B站链接或整段分享文字都可以。知萃 CLI 1.0.5 起支持自动接续授权。' : '已有知萃 CLI，运行下面的命令。'}</p></div></li>
          <li><span>2</span><div><strong>在知萃确认权限</strong><p>优先在已登录的桌面客户端核对请求方和权限；无法打开时再转到网页。需要登录时，登录后会回到同一个授权请求。</p></div></li>
          <li><span>3</span><div><strong>{videoPurpose ? '继续准备视频素材' : '复用连接，开始使用'}</strong><p>{videoPurpose ? '按已授权能力继续提取和下载，进度持续显示；中断后保留已完成步骤。' : '凭证保存在本机，已授权且有效时直接继续任务；已有连接不会被自动扩权。'}</p></div></li>
        </ol>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={interfaceDisabled || !displayedCommand} onClick={() => onCopy(handoffPrompt)}>{copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? '已复制提示词' : '复制给 Agent，开始连接'}</button>
          <button type="button" disabled={interfaceDisabled} onClick={onManualAuthorization}><ShieldCheck size={17} />已有授权码</button>
        </div>
        <details className={styles.manual}>
          <summary>手动使用 CLI</summary>
          <p className={styles.hint}>命令只申请上方预设中当前服务支持的权限。已有有效连接可直接继续任务，无需再次运行。</p>
          <div className={styles.command}>
            <code>{displayedCommand || '请先选择至少一项当前可用权限'}</code>
            <button type="button" disabled={interfaceDisabled || !displayedCommand} onClick={() => onCopyCommand(displayedCommand)} aria-label="复制 CLI 授权命令">{commandCopied ? <Check size={16} /> : <Clipboard size={16} />}{commandCopied ? '已复制' : '复制命令'}</button>
          </div>
        </details>
        <p className={styles.hint}>还没有 CLI？<a href="/download">下载知萃电脑客户端</a>，在侧边栏「Agent 接入」中安装连接。</p>
      </>}
    </section>
  );
}
