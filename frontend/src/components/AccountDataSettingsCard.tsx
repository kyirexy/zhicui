'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import NativeModal from '@/components/NativeModal';
import {
  confirmAccountDeletion,
  downloadPersonalDataArchive,
  prepareAccountDeletion,
  type AccountDeletionPreparation,
  type ZhicuiClientType,
} from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import { PUBLIC_INFORMATION_LINKS } from '@/lib/legalDocuments';
import styles from './AccountDataSettingsCard.module.css';

function clientType(): ZhicuiClientType {
  if (typeof window === 'undefined') return 'web';
  if (window.zhicuiDesktop) return 'windows';
  return /Android/i.test(window.navigator.userAgent) ? 'android' : 'web';
}

export default function AccountDataSettingsCard() {
  const router = useRouter();
  const { logout } = useAuth();
  const [exportPassword, setExportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletePreparation, setDeletePreparation] = useState<AccountDeletionPreparation | null>(null);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const handleExport = async () => {
    setExportError('');
    setExportSuccess('');
    if (!exportPassword) {
      setExportError('请输入当前密码以确认是你本人');
      return;
    }
    setExporting(true);
    const response = await downloadPersonalDataArchive({
      password: exportPassword,
      client_type: clientType(),
    });
    setExporting(false);
    if (!response.success || !response.data) {
      setExportError(response.error || '导出失败，请稍后重试');
      return;
    }
    const objectUrl = URL.createObjectURL(response.data.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = response.data.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    setExportPassword('');
    setExportSuccess('个人数据归档已开始下载');
  };

  const closeDelete = () => {
    if (deletePending) return;
    setDeleteOpen(false);
    setDeletePassword('');
    setDeletePhrase('');
    setDeletePreparation(null);
    setDeleteError('');
  };

  const handlePrepareDeletion = async () => {
    setDeleteError('');
    if (!deletePassword) {
      setDeleteError('请输入当前密码');
      return;
    }
    setDeletePending(true);
    const response = await prepareAccountDeletion({
      password: deletePassword,
      client_type: clientType(),
    });
    setDeletePending(false);
    if (!response.success || !response.data) {
      setDeleteError(response.error || '验证失败，请稍后重试');
      return;
    }
    setDeletePassword('');
    setDeletePreparation(response.data);
  };

  const handleConfirmDeletion = async () => {
    if (!deletePreparation) return;
    setDeleteError('');
    if (deletePhrase.trim() !== deletePreparation.confirmation_phrase) {
      setDeleteError(`请输入“${deletePreparation.confirmation_phrase}”完成最终确认`);
      return;
    }
    setDeletePending(true);
    const response = await confirmAccountDeletion({
      confirmation_token: deletePreparation.confirmation_token,
      confirmation_phrase: deletePhrase,
    });
    setDeletePending(false);
    if (!response.success || !response.data?.deleted) {
      setDeleteError(response.error || '注销失败，账号数据未发生变化');
      return;
    }
    logout();
    router.replace('/login?account_deleted=1');
  };

  return (
    <>
      <section className={styles.card} aria-labelledby="account-data-title">
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true"><ShieldCheck size={20} /></span>
          <div>
            <h2 id="account-data-title">账号与个人数据</h2>
            <p>查看法律文件，导出属于你的资料，或永久注销账号。</p>
          </div>
        </header>

        <div className={styles.section}>
          <div className={styles.copy}>
            <strong>法律、平台限制与支持</strong>
            <p>所有客户端使用相同版本的说明，未登录时也可以查看。</p>
          </div>
          <nav className={styles.links} aria-label="法律与支持">
            {PUBLIC_INFORMATION_LINKS.map((item) => (
              <Link key={item.href} href={item.href}>{item.label}</Link>
            ))}
          </nav>
        </div>

        <div className={styles.section}>
          <div className={styles.copy}>
            <strong>下载个人数据</strong>
            <p>生成版本化 ZIP，包含资料、文稿、AI 对话、知识、计划、账号设置和同意记录，不包含密码、Cookie、密钥或临时媒体地址。</p>
          </div>
          <div className={styles.form}>
            <input
              className={styles.input}
              type="password"
              value={exportPassword}
              onChange={(event) => { setExportPassword(event.target.value); setExportError(''); }}
              placeholder="输入当前密码"
              aria-label="导出数据前输入当前密码"
              autoComplete="current-password"
            />
            {exportError && <p className={styles.error} role="alert">{exportError}</p>}
            {exportSuccess && <p className={styles.success} role="status">{exportSuccess}</p>}
            <button className={styles.button} type="button" onClick={handleExport} disabled={exporting}>
              {exporting ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <Download size={16} />}
              {exporting ? '正在生成归档' : '验证并下载'}
            </button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.copy}>
            <strong>永久注销账号</strong>
            <p>删除云端资料和平台绑定并使当前登录失效。该操作需要密码和第二次文字确认，完成后不可恢复。</p>
          </div>
          <button className={`${styles.button} ${styles.danger}`} type="button" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={16} />
            申请注销账号
          </button>
        </div>
      </section>

      <NativeModal open={deleteOpen} title="永久注销账号" onClose={closeDelete}>
        <div className={styles.dialogBody}>
          {!deletePreparation ? (
            <>
              <p>先输入当前密码验证身份。验证完成后，你还需要查看影响范围并进行一次最终确认。</p>
              <input
                className={styles.input}
                type="password"
                value={deletePassword}
                onChange={(event) => { setDeletePassword(event.target.value); setDeleteError(''); }}
                placeholder="输入当前密码"
                aria-label="注销账号前输入当前密码"
                autoComplete="current-password"
              />
            </>
          ) : (
            <>
              <p>请确认以下数据将被永久删除：</p>
              <ul className={styles.impact}>
                {deletePreparation.impact.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <input
                className={styles.input}
                type="text"
                value={deletePhrase}
                onChange={(event) => { setDeletePhrase(event.target.value); setDeleteError(''); }}
                placeholder={`输入“${deletePreparation.confirmation_phrase}”`}
                aria-label="输入永久注销确认文字"
                autoComplete="off"
              />
            </>
          )}
          {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
          <div className={styles.dialogActions}>
            <button className={styles.button} type="button" onClick={closeDelete} disabled={deletePending}>取消</button>
            <button
              className={`${styles.button} ${styles.danger}`}
              type="button"
              onClick={deletePreparation ? handleConfirmDeletion : handlePrepareDeletion}
              disabled={deletePending}
            >
              {deletePending && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />}
              {deletePending ? '正在处理' : deletePreparation ? '永久删除账号和数据' : '验证密码并继续'}
            </button>
          </div>
        </div>
      </NativeModal>
    </>
  );
}
