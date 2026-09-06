'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Eye, Film, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import NativeModal from '@/components/NativeModal';
import {
  createShowcaseCase,
  deleteShowcaseCase,
  listAdminShowcaseCases,
  loadAdminShowcaseCaseMedia,
  updateShowcaseCase,
  uploadShowcaseCaseMedia,
  validateShowcaseMedia,
  validateShowcasePublication,
  type ShowcaseCase,
  type ShowcaseCaseInput,
} from '@/lib/showcaseCases';
import styles from './AdminShowcaseCasesPanel.module.css';

function caseForm(item?: ShowcaseCase | null): ShowcaseCaseInput {
  return {
    title: item?.title ?? '', industry: item?.industry ?? '',
    person_name: item?.person_name ?? '', role: item?.role ?? '',
    summary: item?.summary ?? '', challenge: item?.challenge ?? '',
    workflow: item?.workflow ?? '', outcome: item?.outcome ?? '',
    source_url: item?.source_url ?? '', source_label: item?.source_label ?? '',
    authenticity_confirmed: item?.authenticity_confirmed ?? false,
    published: item?.published ?? false, sort_order: item?.sort_order ?? 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

function formatSize(value: number | null): string {
  return value ? `${(value / 1024 / 1024).toFixed(1)} MB` : '';
}

function validateSourceUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export default function AdminShowcaseCasesPanel() {
  const [cases, setCases] = useState<ShowcaseCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ShowcaseCase | null>(null);
  const [form, setForm] = useState<ShowcaseCaseInput>(() => caseForm());
  const [file, setFile] = useState<File | null>(null);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showSavedMedia, setShowSavedMedia] = useState(false);
  const [preview, setPreview] = useState<ShowcaseCase | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'discard' } | { kind: 'delete'; item: ShowcaseCase } | null>(null);
  const [confirmError, setConfirmError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const uploadController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void listAdminShowcaseCases(controller.signal).then((items) => {
      if (!controller.signal.aborted) setCases(items);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [loadVersion]);

  useEffect(() => () => uploadController.current?.abort(), []);

  const sortedCases = [...cases].sort((a, b) => a.sort_order - b.sort_order || b.updated_at.localeCompare(a.updated_at));
  const publishedCount = cases.filter((item) => item.published).length;
  const dirty = file !== null || JSON.stringify(form) !== JSON.stringify(caseForm(editing));

  function updateField<K extends keyof ShowcaseCaseInput>(key: K, value: ShowcaseCaseInput[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key !== 'authenticity_confirmed' && key !== 'sort_order'
        ? { authenticity_confirmed: false }
        : {}),
    }));
  }

  function upsert(item: ShowcaseCase) {
    setCases((current) => current.some((entry) => entry.id === item.id)
      ? current.map((entry) => entry.id === item.id ? item : entry)
      : [...current, item]);
  }

  function openEditor(item: ShowcaseCase | null) {
    setEditing(item);
    setForm(caseForm(item));
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setShowSavedMedia(false);
    setEditorError('');
    setActionError('');
    setNotice('');
    setEditorOpen(true);
  }

  function closeEditor() {
    if (saving) return;
    if (dirty) {
      setConfirmError('');
      setConfirmation({ kind: 'discard' });
      return;
    }
    setEditorOpen(false);
    setShowSavedMedia(false);
  }

  function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    const error = validateShowcaseMedia(candidate);
    if (error) {
      setEditorError(error);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setFile(candidate);
    setForm((current) => ({ ...current, authenticity_confirmed: false }));
    setEditorError('');
    setShowSavedMedia(false);
  }

  async function save(publish: boolean) {
    if (saving) return;
    setEditorError('');
    if (!validateSourceUrl(form.source_url)) {
      setEditorError('来源链接需为有效的 http 或 https 地址，且不能包含账号密码。');
      return;
    }
    if (!Number.isSafeInteger(form.sort_order) || form.sort_order < -10000 || form.sort_order > 10000) {
      setEditorError('显示顺序必须是 -10000 到 10000 之间的整数。');
      return;
    }
    if (publish) {
      const error = validateShowcasePublication(form, Boolean(file || editing?.media_type));
      if (error) { setEditorError(error); return; }
    }
    let saved: ShowcaseCase | null = null;
    let phase: 'draft' | 'upload' | 'publish' = 'draft';
    setSaving('正在保存草稿…');
    try {
      const input = { ...form, source_url: form.source_url.trim(), published: false };
      saved = editing ? await updateShowcaseCase(editing.id, input) : await createShowcaseCase(input);
      setEditing(saved);
      setForm(caseForm(saved));
      upsert(saved);
      if (file) {
        phase = 'upload';
        setSaving('正在上传素材…');
        setUploadProgress(0);
        const controller = new AbortController();
        uploadController.current = controller;
        saved = await uploadShowcaseCaseMedia(saved.id, file, {
          onProgress: setUploadProgress, signal: controller.signal,
        });
        setEditing(saved);
        setForm(caseForm(saved));
        upsert(saved);
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      }
      if (publish) {
        phase = 'publish';
        setSaving('正在发布案例…');
        saved = await updateShowcaseCase(saved.id, { published: true, authenticity_confirmed: form.authenticity_confirmed });
        setEditing(saved);
        setForm(caseForm(saved));
        upsert(saved);
      }
      setEditorOpen(false);
      setShowSavedMedia(false);
      setNotice(publish ? '案例已发布，将自动显示在官网首页。' : '草稿已保存，仅管理员可见。');
    } catch (error: unknown) {
      const prefix = saved ? (phase === 'upload' ? '草稿已保存，但素材上传失败。' : '内容已保存为草稿，但发布未完成。') : '';
      setEditorError(`${prefix}${errorMessage(error)}`);
    } finally {
      uploadController.current = null;
      setSaving('');
    }
  }

  async function togglePublication(item: ShowcaseCase) {
    if (busyId) return;
    setActionError('');
    setNotice('');
    if (!item.published) {
      const error = validateShowcasePublication(caseForm(item), Boolean(item.media_type));
      if (error) { openEditor(item); setEditorError(error); return; }
    }
    setBusyId(item.id);
    try {
      const updated = await updateShowcaseCase(item.id, { published: !item.published });
      upsert(updated);
      setNotice(updated.published ? '案例已发布，将自动显示在官网首页。' : '案例已下架，文案和素材仍保留在草稿中。');
    } catch (error: unknown) { setActionError(errorMessage(error)); }
    finally { setBusyId(null); }
  }

  async function confirmAction() {
    if (!confirmation || deleting) return;
    if (confirmation.kind === 'discard') {
      setConfirmation(null);
      setEditorOpen(false);
      setShowSavedMedia(false);
      setFile(null);
      return;
    }
    setDeleting(true);
    setConfirmError('');
    try {
      const id = confirmation.item.id;
      await deleteShowcaseCase(id);
      setCases((current) => current.filter((item) => item.id !== id));
      setConfirmation(null);
      setNotice('案例及其素材已删除。');
      setActionError('');
    } catch (error: unknown) { setConfirmError(errorMessage(error)); }
    finally { setDeleting(false); }
  }

  return (
    <section className={styles.panel} aria-labelledby="admin-showcase-title">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>官网内容</p>
          <h1 id="admin-showcase-title">首页案例</h1>
          <p>用真实经历和实际录屏介绍知萃。发布后自动显示在官网，未发布的案例仅管理员可见。</p>
        </div>
        <button type="button" className={styles.primary} onClick={() => openEditor(null)} disabled={loading || Boolean(busyId)}>
          <Plus size={17} aria-hidden="true" />新增案例
        </button>
      </header>

      <div className={styles.toolbar}>
        <span>{loading ? '正在读取案例…' : `${cases.length} 个案例 · ${publishedCount} 个已发布`}</span>
        <div>
          <a className={styles.secondary} href="/#real-case" target="_blank" rel="noreferrer">查看官网<ExternalLink size={15} aria-hidden="true" /></a>
          <button type="button" className={styles.secondary} onClick={() => setLoadVersion((value) => value + 1)} disabled={loading || Boolean(busyId)}>
            <RefreshCw size={15} aria-hidden="true" />刷新
          </button>
        </div>
      </div>
      {notice ? <p role="status" className={styles.success}>{notice}</p> : null}
      {actionError ? <p role="alert" className={styles.error}>{actionError}</p> : null}
      {loadError ? (
        <div className={styles.error} role="alert">
          <p>{loadError}</p>
          <button type="button" className={styles.secondary} onClick={() => setLoadVersion((value) => value + 1)}>重新加载</button>
        </div>
      ) : null}

      {loading ? (
        <div className={styles.skeleton} aria-label="正在加载案例" aria-busy="true"><div /><div /><div /></div>
      ) : cases.length === 0 && !loadError ? (
        <div className={styles.empty}>
          <Film size={30} aria-hidden="true" />
          <h2>发布第一个真实案例</h2>
          <p>写下使用者遇到的问题、实际操作和结果，再上传 MP4 或 GIF。可以先保存草稿，准备好后再公开。</p>
          <button type="button" className={styles.primary} onClick={() => openEditor(null)}>新增案例</button>
        </div>
      ) : (
        <ul className={styles.list}>
          {sortedCases.map((item) => (
            <li className={styles.card} key={item.id}>
              <div className={styles.cardTop}>
                <span className={styles.badge} data-published={item.published}>{item.published ? '已发布' : '草稿'}</span>
                <span>{item.industry || '行业待填写'} · 顺序 {item.sort_order}</span>
              </div>
              <h2>{item.title || '未命名案例'}</h2>
              <p className={styles.summary}>{item.summary || '填写简介，让访客了解这个案例解决了什么问题。'}</p>
              <div className={styles.meta}>
                <span>{[item.person_name, item.role].filter(Boolean).join(' · ') || '使用者信息待补充'}</span>
                <span>{item.media_type ? `${item.media_type === 'video/mp4' ? 'MP4 视频' : 'GIF 动图'} · ${formatSize(item.media_size)}` : '尚未上传素材'}</span>
              </div>
              <div className={styles.cardActions}>
                <button type="button" className={styles.secondary} onClick={() => openEditor(item)} disabled={Boolean(busyId)}>编辑</button>
                <button type="button" className={styles.secondary} onClick={() => setPreview(item)}><Eye size={15} aria-hidden="true" />预览</button>
                <button type="button" className={styles.secondary} onClick={() => void togglePublication(item)} disabled={Boolean(busyId)}>
                  {busyId === item.id ? '处理中…' : item.published ? '下架' : '发布'}
                </button>
                <button type="button" className={styles.deleteButton} onClick={() => { setConfirmError(''); setConfirmation({ kind: 'delete', item }); }} disabled={Boolean(busyId)} aria-label={`删除案例：${item.title || '未命名案例'}`}>
                  <Trash2 size={16} aria-hidden="true" />删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <NativeModal open={editorOpen} title={editing ? '编辑首页案例' : '新增首页案例'} onClose={closeEditor} className={styles.editorDialog}>
        <form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void save(false); }}>
          <p className={styles.hint}>保存草稿不会公开。编辑已发布的案例时，保存会先下架；选择“保存并发布”才会在保存完成后重新上线。</p>
          <fieldset disabled={Boolean(saving)}>
            <div className={styles.fields}>
              <Field label="案例标题" hint="发布必填，用一句话说明实际用途。" wide>
                <input value={form.title} onChange={(event) => updateField('title', event.target.value)} maxLength={160} placeholder="记录一个实际发生的使用案例" />
              </Field>
              <Field label="所属行业" hint="发布必填，可自行填写。">
                <input value={form.industry} onChange={(event) => updateField('industry', event.target.value)} maxLength={80} placeholder="如教育培训、内容创作" />
              </Field>
              <Field label="显示顺序" hint="数字越小，在官网越靠前。">
                <input type="number" step="1" min={-10000} max={10000} value={form.sort_order} onChange={(event) => updateField('sort_order', Number(event.target.value))} />
              </Field>
              <Field label="使用者称呼" hint="可匿名，不填写私人联系方式。">
                <input value={form.person_name} onChange={(event) => updateField('person_name', event.target.value)} maxLength={80} placeholder="如一位课程讲师" />
              </Field>
              <Field label="职业 / 角色">
                <input value={form.role} onChange={(event) => updateField('role', event.target.value)} maxLength={120} placeholder="使用者的实际角色" />
              </Field>
              <Field label="案例简介" hint="发布必填，写清使用场景和获得的结果。" wide>
                <textarea value={form.summary} onChange={(event) => updateField('summary', event.target.value)} rows={3} maxLength={1200} />
              </Field>
              <Field label="遇到的问题" wide>
                <textarea value={form.challenge} onChange={(event) => updateField('challenge', event.target.value)} rows={3} maxLength={6000} placeholder="使用前遇到了什么具体困难？" />
              </Field>
              <Field label="实际使用过程" wide>
                <textarea value={form.workflow} onChange={(event) => updateField('workflow', event.target.value)} rows={4} maxLength={6000} placeholder="记录真实操作；如压缩了等待过程，请说明。" />
              </Field>
              <Field label="实际结果" wide>
                <textarea value={form.outcome} onChange={(event) => updateField('outcome', event.target.value)} rows={3} maxLength={6000} placeholder="只写已发生且可核验的结果，不编造评价、用户数量或节省比例。" />
              </Field>
              <Field label="来源名称">
                <input value={form.source_label} onChange={(event) => updateField('source_label', event.target.value)} maxLength={160} placeholder="如原视频、案例来源" />
              </Field>
              <Field label="公开来源链接（可选）">
                <input type="url" value={form.source_url} onChange={(event) => updateField('source_url', event.target.value)} maxLength={2048} placeholder="https://" />
              </Field>
            </div>

            <div className={styles.mediaUpload}>
              <div><h3>真实演示素材</h3><p>MP4 不超过 100 MB，GIF 不超过 20 MB。新文件会在保存时上传并替换原素材。</p></div>
              <label className={styles.uploadLabel}>
                <Upload size={18} aria-hidden="true" />
                <span>{file ? '重新选择文件' : editing?.media_type ? '选择替换素材' : '选择 MP4 / GIF'}</span>
                <input ref={fileInput} type="file" accept="video/mp4,image/gif,.mp4,.gif" onChange={(event) => chooseFile(event.target.files?.[0])} />
              </label>
              {file ? (
                <div className={styles.fileChoice}>
                  <p>{file.name} · {formatSize(file.size)}<span>尚未上传，保存后生效</span></p>
                  <button type="button" className={styles.secondary} onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>取消选择</button>
                </div>
              ) : editing?.media_type ? (
                <button type="button" className={styles.secondary} onClick={() => setShowSavedMedia((value) => !value)}>
                  <Eye size={16} aria-hidden="true" />{showSavedMedia ? '收起现有素材' : `预览现有素材 · ${formatSize(editing.media_size)}`}
                </button>
              ) : <p className={styles.hint}>可以先保存文字草稿，上传素材后再发布。</p>}
              {editorOpen && (file || (showSavedMedia && editing?.media_type)) ? <CaseMedia item={editing} file={file} /> : null}
            </div>

            <label className={styles.confirmation}>
              <input type="checkbox" checked={form.authenticity_confirmed} onChange={(event) => updateField('authenticity_confirmed', event.target.checked)} />
              <span><strong>我确认这是实际使用案例，素材已获得公开展示授权。</strong><small>人物可匿名；文案与录屏应对应，不使用虚构评价或未经同意的私人资料。</small></span>
            </label>
          </fieldset>
          {saving === '正在上传素材…' ? (
            <div className={styles.progress} role="status">
              <label htmlFor="showcase-upload-progress">{uploadProgress === 100 ? '文件已传输，正在校验素材…' : `正在上传 · ${uploadProgress}%`}</label>
              <progress id="showcase-upload-progress" max={100} value={uploadProgress} />
            </div>
          ) : null}
          {editorError ? <p className={styles.error} role="alert">{editorError}</p> : null}
          <footer className={styles.editorActions}>
            <button type="button" className={styles.secondary} onClick={closeEditor} disabled={Boolean(saving)}>取消</button>
            <button type="submit" className={styles.secondary} disabled={Boolean(saving)}>保存草稿</button>
            <button type="button" className={styles.primary} onClick={() => void save(true)} disabled={Boolean(saving)}>{saving || '保存并发布'}</button>
          </footer>
        </form>
      </NativeModal>

      <NativeModal open={Boolean(preview)} title="案例预览" onClose={() => setPreview(null)} className={styles.editorDialog}>
        {preview ? <CasePreview item={preview} /> : null}
      </NativeModal>

      <ConfirmCaseAction
        open={Boolean(confirmation)}
        title={confirmation?.kind === 'delete' ? '删除这个案例？' : '放弃尚未保存的修改？'}
        description={confirmation?.kind === 'delete'
          ? `“${confirmation.item.title || '未命名案例'}”的文案和素材会一并删除，官网也将停止展示。此操作无法撤销。`
          : '本次修改和尚未上传的文件将被清除。已经保存到服务器的草稿会保留。'}
        label={confirmation?.kind === 'delete' ? '确认删除' : '放弃修改'}
        pending={deleting}
        error={confirmError}
        onClose={() => { if (!deleting) setConfirmation(null); }}
        onConfirm={() => void confirmAction()}
      />
    </section>
  );
}

function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={styles.field} data-wide={wide}><strong>{label}</strong>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function CasePreview({ item }: { item: ShowcaseCase }) {
  return (
    <article className={styles.preview}>
      <p className={styles.hint}>管理员预览 · {item.published ? '此案例已公开' : '草稿，仅管理员可见'}</p>
      <span className={styles.badge}>{item.industry || '行业待填写'}</span>
      <h2>{item.title || '未命名案例'}</h2>
      <p>{[item.person_name, item.role].filter(Boolean).join(' · ')}</p>
      <p>{item.summary || '简介待填写'}</p>
      {item.media_type ? <CaseMedia item={item} /> : <p className={styles.hint}>尚未上传演示素材。</p>}
      {([['遇到的问题', item.challenge], ['实际使用过程', item.workflow], ['实际结果', item.outcome]] as const).map(([label, value]) => value ? (
        <section key={label}><h3>{label}</h3><p className={styles.preserveLines}>{value}</p></section>
      ) : null)}
      {item.source_url && validateSourceUrl(item.source_url) ? <a href={item.source_url} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>{item.source_label || '查看公开来源'}<ExternalLink size={15} aria-hidden="true" /></a> : null}
    </article>
  );
}

function CaseMedia({ item, file = null }: { item: ShowcaseCase | null; file?: File | null }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const id = item?.id;
  const version = item?.updated_at;
  const type = file ? (file.name.toLowerCase().endsWith('.gif') ? 'image/gif' : 'video/mp4') : item?.media_type;

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    setError('');
    if (file) {
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
    } else if (id) {
      void loadAdminShowcaseCaseMedia(id, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, id, version, retry]);

  return (
    <div className={styles.mediaPreview}>
      {error ? <div role="alert"><p>{error}</p><button type="button" className={styles.secondary} onClick={() => setRetry((value) => value + 1)}>重新加载素材</button></div>
        : !url ? <p role="status">正在加载预览…</p>
          : type === 'image/gif' ? <img src={url} alt={`${item?.title || '待上传案例'}的实际操作动图`} onError={() => setError('动图无法显示，请检查素材是否有效。')} />
            : <video key={url} src={url} controls playsInline preload="metadata" aria-label={`${item?.title || '待上传案例'}的实际操作录屏`} onError={() => setError('视频无法播放，请使用浏览器可播放的 MP4 编码（如 H.264）。')} />}
    </div>
  );
}

function ConfirmCaseAction({ open, title, description, label, pending, error, onClose, onConfirm }: {
  open: boolean; title: string; description: string; label: string;
  pending: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  return (
    <dialog ref={dialog} role="alertdialog" className={styles.confirmDialog} aria-labelledby="showcase-confirm-title" aria-describedby="showcase-confirm-description" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <h2 id="showcase-confirm-title">{title}</h2>
      <p id="showcase-confirm-description">{description}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.editorActions}>
        <button type="button" className={styles.secondary} onClick={onClose} disabled={pending} autoFocus>取消</button>
        <button type="button" className={styles.danger} onClick={onConfirm} disabled={pending}>{pending ? '正在删除…' : label}</button>
      </div>
    </dialog>
  );
}
