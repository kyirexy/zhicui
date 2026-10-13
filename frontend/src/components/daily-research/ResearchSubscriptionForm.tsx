'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle, EnvelopeSimple, FloppyDisk, X } from '@phosphor-icons/react';
import { confirmResearchVerification, saveResearchSubscription, sendResearchVerification, type ResearchStatus, type ResearchSubscription, type ResearchSubscriptionInput } from '@/lib/dailyResearchApi';
import { defaultResearchSubscription, normalizeResearchTopics, validateResearchSubscription } from '@/lib/dailyResearchUi';
import styles from './dailyResearch.module.css';

interface Props {
  subscription?: ResearchSubscription;
  accountEmail: string;
  status: ResearchStatus | null;
  onSaved: (subscription: ResearchSubscription) => void;
  onCancel: () => void;
  onVerified: () => void;
}

export default function ResearchSubscriptionForm({ subscription, accountEmail, status, onSaved, onCancel, onVerified }: Props) {
  const [value, setValue] = useState<ResearchSubscriptionInput>(() => subscription ? {
    name: subscription.name, enabled: subscription.enabled, schedule_time: subscription.schedule_time,
    timezone: subscription.timezone, platforms: subscription.platforms, source_modes: subscription.source_modes,
    window_days: subscription.window_days, sync_limit: subscription.sync_limit, focus_topics: subscription.focus_topics,
    recipient_email: subscription.recipient_email, instruction: subscription.instruction,
  } : defaultResearchSubscription());
  const [topics, setTopics] = useState(subscription?.focus_topics.join('，') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [code, setCode] = useState('');
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [sentEmail, setSentEmail] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const saveRequest = useRef<AbortController | null>(null);
  const verificationRequest = useRef<AbortController | null>(null);
  const recipient = value.recipient_email.trim().toLowerCase();
  const verified = Boolean(recipient && (verifiedEmail === recipient || status?.recipients.some((item) => item.verified && item.email.toLowerCase() === recipient)));
  const maxSyncLimit = status?.limits.max_sync_limit || 500;

  useEffect(() => () => { saveRequest.current?.abort(); verificationRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((previous) => Math.max(0, previous - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function change<K extends keyof ResearchSubscriptionInput>(key: K, next: ResearchSubscriptionInput[K]) {
    setValue((previous) => ({ ...previous, [key]: next }));
    setError('');
    if (key === 'recipient_email') {
      verificationRequest.current?.abort();
      verificationRequest.current = null;
      setVerifyBusy(false); setVerifyMessage(''); setVerifyError(''); setCode(''); setSentEmail('');
    }
  }

  async function verify(confirm: boolean) {
    if (verificationRequest.current || !recipient) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) { setVerifyError('请先填写有效邮箱'); return; }
    const controller = new AbortController();
    verificationRequest.current = controller;
    setVerifyBusy(true); setVerifyMessage(''); setVerifyError('');
    try {
      const result = confirm ? await confirmResearchVerification(recipient, code.trim(), controller.signal) : await sendResearchVerification(recipient, controller.signal);
      if (controller.signal.aborted) return;
      if (result.verified) { setVerifiedEmail(recipient); setVerifyMessage('收件邮箱已验证'); onVerified(); }
      else if (result.status === 'sent') { setSentEmail(recipient); setCooldown(60); setVerifyMessage(result.message || '验证码已发出，请查看收件箱'); }
      else { setVerifyMessage(result.message || '邮件服务尚未配置，可先保存订阅并查看站内报告'); }
    } catch (reason) {
      if (!controller.signal.aborted) setVerifyError(reason instanceof Error ? reason.message : '邮箱验证未完成，请重试');
    } finally {
      if (verificationRequest.current === controller) { verificationRequest.current = null; setVerifyBusy(false); }
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saveRequest.current) return;
    const input = { ...value, name: value.name.trim(), focus_topics: normalizeResearchTopics(topics), recipient_email: recipient, instruction: value.instruction.trim() };
    const validation = validateResearchSubscription(input, maxSyncLimit);
    if (validation) { setError(validation); return; }
    const controller = new AbortController();
    saveRequest.current = controller; setBusy(true); setError('');
    try {
      const saved = await saveResearchSubscription(input, subscription?.id, controller.signal);
      if (!controller.signal.aborted) onSaved(saved);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '订阅未保存，请重试');
    } finally {
      if (saveRequest.current === controller) { saveRequest.current = null; setBusy(false); }
    }
  }

  return <section className={styles.panel} aria-labelledby="research-form-title">
    <div className={styles.panelHeading}><div><h2 id="research-form-title">{subscription ? '编辑研究订阅' : '创建研究订阅'}</h2><p>按你的时间和关注方向，持续整理视频里的创作线索。</p></div><button type="button" className={styles.iconButton} onClick={onCancel} disabled={busy} aria-label="关闭订阅编辑"><X size={18} /></button></div>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className={styles.formFields} disabled={busy}>
        <label className={styles.field}>订阅名称<input maxLength={100} value={value.name} onChange={(event) => change('name', event.target.value)} required /></label>
        <div className={styles.formRow}>
          <label className={styles.field}>每日执行时间<input type="time" value={value.schedule_time} onChange={(event) => change('schedule_time', event.target.value)} required /></label>
          <label className={styles.field}>时区<select value={value.timezone} onChange={(event) => change('timezone', event.target.value)}><option value="Asia/Shanghai">北京时间 · Asia/Shanghai</option><option value="Asia/Tokyo">东京 · Asia/Tokyo</option><option value="America/Los_Angeles">洛杉矶 · America/Los_Angeles</option><option value="America/New_York">纽约 · America/New_York</option><option value="Europe/London">伦敦 · Europe/London</option><option value="UTC">协调世界时 · UTC</option>{!['Asia/Shanghai', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'UTC'].includes(value.timezone) && <option value={value.timezone}>{value.timezone}</option>}</select></label>
        </div>
        <fieldset className={styles.choiceField}><legend>视频来源</legend><div className={styles.choices}><label><input type="checkbox" checked readOnly />抖音</label></div><p className={styles.hint}>当前每日研究支持抖音；其他平台尚未开放定时研究。</p></fieldset>
        <fieldset className={styles.choiceField}><legend>同步内容</legend><div className={styles.choices}>{(['like', 'collect'] as const).map((mode) => <label key={mode}><input type="checkbox" checked={value.source_modes.includes(mode)} onChange={(event) => change('source_modes', event.target.checked ? [...value.source_modes, mode] : value.source_modes.filter((item) => item !== mode))} />{mode === 'like' ? '喜欢' : '收藏'}</label>)}</div></fieldset>
        <div className={styles.formRow}>
          <label className={styles.field}>研究范围<input value="昨天零点至本次同步完成" readOnly /></label>
          <label className={styles.field}>每个来源的同步上限<input type="number" min={1} max={maxSyncLimit} value={value.sync_limit} onChange={(event) => change('sync_limit', Number(event.target.value))} required /></label>
        </div>
        <p className={styles.hint}>时间按知萃首次发现计算，不等于真实点赞或收藏时间。首次导入的历史视频会注明；达到条数上限会标明覆盖不完整。</p>
        <label className={styles.field}>关注主题 <span>选填，用逗号分隔</span><input value={topics} onChange={(event) => setTopics(event.target.value)} placeholder="例如：旅行拍摄、知识科普、产品测评" maxLength={600} /></label>
        <label className={styles.field}>研究偏好 <span>选填</span><textarea rows={3} maxLength={2000} value={value.instruction} onChange={(event) => change('instruction', event.target.value)} placeholder="写下你的受众、现有设备或创作目标，让选题和制作建议更适合你。" /></label>
        <section className={styles.emailSection} aria-labelledby="recipient-heading">
          <h3 id="recipient-heading"><EnvelopeSimple size={18} aria-hidden="true" />邮件投递</h3>
          <label className={styles.field}>收件邮箱 <span>留空则仅保存站内报告</span><input type="email" autoComplete="email" maxLength={254} value={value.recipient_email} onChange={(event) => change('recipient_email', event.target.value)} placeholder="你的收件邮箱" /></label>
          {!recipient && accountEmail && <button type="button" className={styles.textButton} onClick={() => change('recipient_email', accountEmail)}>使用账号邮箱 {accountEmail}</button>}
          {verified ? <p className={styles.verified}><CheckCircle size={16} aria-hidden="true" />收件邮箱已验证</p> : recipient ? <div className={styles.verification}>
            <button type="button" className={styles.secondaryButton} disabled={verifyBusy || cooldown > 0 || !status?.email.configured} onClick={() => void verify(false)}>{verifyBusy ? '处理中…' : cooldown > 0 ? `${cooldown} 秒后重发` : '发送验证码'}</button>
            {sentEmail === recipient && <div className={styles.codeRow}><label className={styles.field}>邮箱验证码<input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={12} onChange={(event) => setCode(event.target.value)} /></label><button type="button" className={styles.secondaryButton} disabled={verifyBusy || !code.trim()} onClick={() => void verify(true)}>验证邮箱</button></div>}
          </div> : null}
          {!status?.email.configured ? <p className={styles.hint}>{status ? '邮件服务尚未配置。可以先保存订阅，研究结果仍可在站内查看。' : '正在确认邮件服务状态；站内报告不依赖邮箱。'}</p> : recipient && !verified ? <p className={styles.hint}>验证邮箱后才会投递报告。未验证时仍可保存订阅并查看站内报告。</p> : <p className={styles.hint}>报告会保存在这里；填写并验证邮箱后，也会尝试邮件投递。</p>}
          {verifyMessage && <p className={styles.hint} role="status">{verifyMessage}</p>}
          {verifyError && <p className={styles.error} role="alert">{verifyError}</p>}
        </section>
        <label className={styles.checkLabel}><input type="checkbox" checked={value.enabled} onChange={(event) => change('enabled', event.target.checked)} />启用每日自动研究</label>
        <p className={styles.hint}>研究使用当前模型及账号额度；没有新资料时不调用模型。</p>
        <p className={styles.hint}>自动同步需要已登录对应平台的知萃电脑客户端保持在线。离线或出现验证码时，会显示等待状态。</p>
      </fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formFooter}><button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>取消</button><button type="submit" className={styles.primaryButton} disabled={busy || verifyBusy}><FloppyDisk size={17} aria-hidden="true" />{busy ? '正在保存…' : '保存订阅'}</button></div>
    </form>
  </section>;
}
