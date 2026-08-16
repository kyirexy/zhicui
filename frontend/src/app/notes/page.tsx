'use client';

import {
  type FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  CheckCircle,
  FileText,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  Plus,
  Robot,
  Trash,
  VideoCamera,
  X,
} from '@phosphor-icons/react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  getKnowledgeCandidate,
  getKnowledgeEntry,
  listKnowledge,
  saveKnowledgeCandidate,
  updateKnowledgeEntry,
  type KnowledgeCounts,
  type KnowledgeItem,
  type KnowledgeView,
} from '@/lib/api';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import styles from './KnowledgeWorkspace.module.css';

const EMPTY_COUNTS: KnowledgeCounts = { pages: 0, inbox: 0 };

function formatDate(value?: string, includeTime = false) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', includeTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function itemSummary(item: KnowledgeItem) {
  return item.summary?.trim()
    || item.excerpt?.trim()
    || item.content?.trim().slice(0, 180)
    || '还没有摘要，可以打开后继续完善。';
}

function sameReadableText(left?: string | null, right?: string | null) {
  const normalize = (value?: string | null) => (value || '').replace(/\s+/g, ' ').trim();
  const normalizedLeft = normalize(left);
  return Boolean(normalizedLeft && normalizedLeft === normalize(right));
}

function itemSourceNoteId(item: KnowledgeItem) {
  return item.source_note_id || (item.kind === 'candidate' ? item.id : null);
}

function itemHref(item: KnowledgeItem) {
  const kind = item.kind === 'personal' ? 'personal' : item.kind;
  return `/notes?id=${encodeURIComponent(item.id)}&kind=${kind}`;
}

function NotesContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const kind = searchParams.get('kind');

  if (id && (kind === 'page' || kind === 'personal')) {
    return <KnowledgePageDetail id={id} />;
  }
  if (id) {
    return <CandidateDetail id={id} />;
  }
  return <KnowledgeWorkspace initialView={searchParams.get('view') === 'inbox' ? 'inbox' : 'pages'} />;
}

function KnowledgeEditorDialog({
  open,
  initial,
  onSaved,
  onCancel,
}: {
  open: boolean;
  initial?: KnowledgeItem | null;
  onSaved: (item: KnowledgeItem) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title || '');
    setSummary(initial?.summary || '');
    setContent(initial?.content || '');
    setSourceLabel(initial?.source_label || '');
    setError('');
  }, [initial, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      titleInputRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !content.trim()) {
      setError('请填写标题和正文。');
      return;
    }
    setSaving(true);
    setError('');
    const payload = {
      title: title.trim(),
      summary: summary.trim(),
      content: content.trim(),
      source_label: sourceLabel.trim(),
    };
    const response = initial
      ? await updateKnowledgeEntry(initial.id, payload)
      : await createKnowledgeEntry(payload);
    setSaving(false);
    if (response.success && response.data) {
      onSaved(response.data);
      return;
    }
    setError(response.error || '保存失败，请稍后重试。');
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="knowledge-editor-title"
      aria-describedby="knowledge-editor-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <form className={styles.editor} onSubmit={save}>
        <header>
          <div>
            <span>{initial ? '编辑知识页' : '新建知识页'}</span>
            <h2 id="knowledge-editor-title">{initial ? '继续完善这份理解' : '写下值得长期保留的理解'}</h2>
            <p id="knowledge-editor-description">知识页只会在你主动写下或保存后出现。</p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onCancel} disabled={saving} aria-label="关闭编辑器">
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        </header>
        <label>
          <span>标题</span>
          <input
            ref={titleInputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value.slice(0, 256))}
            placeholder="这份知识解决什么问题"
            autoFocus
          />
        </label>
        <label>
          <span>一句话摘要（可选）</span>
          <textarea
            className={styles.summaryInput}
            value={summary}
            onChange={(event) => setSummary(event.target.value.slice(0, 1000))}
            placeholder="先写下最重要的结论"
            rows={3}
          />
        </label>
        <label>
          <span>正文</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value.slice(0, 100000))}
            placeholder="补充依据、限制、自己的判断和待解决问题……"
            rows={12}
          />
        </label>
        <label>
          <span>来源说明（可选）</span>
          <input
            value={sourceLabel}
            onChange={(event) => setSourceLabel(event.target.value.slice(0, 256))}
            placeholder="例如：工作复盘、读书笔记、自己的观察"
          />
        </label>
        {error ? <p className={styles.formError} role="alert">{error}</p> : null}
        <footer>
          <button type="button" className={styles.textButton} onClick={onCancel} disabled={saving}>取消</button>
          <button type="submit" className={styles.primaryButton} disabled={saving}>
            {saving ? '正在保存' : '保存知识页'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function KnowledgeDeleteDialog({
  item,
  pending,
  onCancel,
  onConfirm,
}: {
  item: KnowledgeItem | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (item && !dialog.open) dialog.showModal();
    if (!item && dialog.open) dialog.close();
  }, [item]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-labelledby="delete-knowledge-title"
      aria-describedby="delete-knowledge-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className={styles.dialogSurface}>
        <h2 id="delete-knowledge-title">删除这份知识页？</h2>
        <p id="delete-knowledge-description">删除后无法恢复，关联的来源视频不会受到影响。</p>
        <strong>{item?.title}</strong>
        <footer>
          <button type="button" onClick={onCancel} disabled={pending} autoFocus>取消</button>
          <button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={pending}>
            {pending ? '正在删除' : '确认删除'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function SourceThumbnail({ item }: { item: KnowledgeItem }) {
  if (item.cover_url && (item.origin === 'video' || item.kind === 'candidate')) {
    return (
      <span className={styles.sourceThumbnail}>
        <LibraryCoverImage
          src={item.cover_url}
          fallbackClassName={styles.coverFallback}
          alt={`${item.title}的来源视频封面`}
          retryable={false}
        />
      </span>
    );
  }
  return (
    <span className={styles.pageMark} aria-hidden="true">
      {item.kind === 'candidate'
        ? <VideoCamera size={20} weight="duotone" />
        : <FileText size={20} weight="duotone" />}
    </span>
  );
}

function KnowledgeReader({
  item,
  savingCandidate,
  statusMessage,
  onEdit,
  onDelete,
  onSaveCandidate,
}: {
  item: KnowledgeItem | null;
  savingCandidate: boolean;
  statusMessage: string;
  onEdit: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
  onSaveCandidate: (item: KnowledgeItem) => void;
}) {
  const readerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (readerRef.current) readerRef.current.scrollTop = 0;
  }, [item?.id, item?.kind]);

  if (!item) {
    return (
      <aside ref={readerRef} className={styles.reader} aria-label="知识阅读区">
        <div className={styles.readerEmpty}>
          <BookOpenText size={28} weight="duotone" aria-hidden="true" />
          <h2>选择一条内容开始阅读</h2>
        </div>
      </aside>
    );
  }

  const sourceNoteId = itemSourceNoteId(item);
  const isCandidate = item.kind === 'candidate';
  const sections = item.sections?.filter((section) => section.title?.trim() || section.content?.trim()) || [];
  const body = item.content?.trim() || '';
  const lead = item.summary?.trim() || (isCandidate ? itemSummary(item) : '');
  const showLead = Boolean(lead && ![body, ...sections.map((section) => section.content)]
    .some((candidate) => sameReadableText(lead, candidate)));
  const sourceLabel = item.author_name?.trim() || item.source_label?.trim() || '';

  return (
    <aside ref={readerRef} className={styles.reader} aria-label={`${item.title}阅读区`}>
      <article className={styles.readerDocument}>
        <header>
          <div className={styles.readerHeading}>
            <div className={styles.readerHeadingCopy}>
              <span className={styles.readerEyebrow}>
                {isCandidate ? '待整理草稿' : item.origin === 'video' ? '视频知识页' : '知识页'}
              </span>
              <h2>{item.title}</h2>
              <p className={styles.readerTimestamp}>更新于 {formatDate(item.updated_at, true)}</p>
            </div>
            <div className={styles.readerActions}>
              {isCandidate ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => onSaveCandidate(item)}
                  disabled={savingCandidate}
                >
                  <CheckCircle size={18} weight="bold" aria-hidden="true" />
                  {savingCandidate ? '正在保存' : '保存为知识页'}
                </button>
              ) : (
                <>
                  <button type="button" className={styles.secondaryButton} onClick={() => onEdit(item)}>
                    <PencilSimple size={17} aria-hidden="true" />编辑
                  </button>
                  <button type="button" className={styles.dangerTextButton} onClick={() => onDelete(item)}>
                    <Trash size={17} aria-hidden="true" />删除
                  </button>
                </>
              )}
              {sourceNoteId ? (
                <Link href={`/library/detail?note=${encodeURIComponent(sourceNoteId)}`} className={styles.secondaryButton}>
                  <VideoCamera size={17} aria-hidden="true" />查看来源视频
                </Link>
              ) : null}
            </div>
          </div>
          {statusMessage ? <p className={styles.statusMessage} role="status" aria-live="polite">{statusMessage}</p> : null}
        </header>

        <div className={styles.readerContent}>
          {showLead ? (
            <section className={styles.readerLead} aria-labelledby={`summary-${item.id}`}>
              <small id={`summary-${item.id}`}>{isCandidate ? '摘要' : '核心结论'}</small>
              <p>{lead}</p>
            </section>
          ) : null}

          {isCandidate && sections.length > 0 ? (
            <div className={styles.readerSections}>
              {sections.map((section, index) => (
                <section key={`${section.title}-${index}`}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{section.title || '未命名要点'}</h3>
                    <p>{section.content}</p>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <section className={styles.readerBody} aria-labelledby={`body-${item.id}`}>
              <small id={`body-${item.id}`} className={styles.readerSectionLabel}>
                {isCandidate ? '摘要正文' : '正文'}
              </small>
              {body ? (
                <div className={styles.readerProse}>{body}</div>
              ) : (
                <div className={styles.readerMissingBody}>
                  <p>这页还没有正文。</p>
                  {!isCandidate ? (
                    <button type="button" className={styles.textButton} onClick={() => onEdit(item)}>
                      编辑并补充
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          )}
        </div>

        {sourceLabel ? (
          <footer className={styles.readerFooter}>
            <span>来源：{sourceLabel}</span>
          </footer>
        ) : null}
      </article>
    </aside>
  );
}

function KnowledgeWorkspace({ initialView }: { initialView: KnowledgeView }) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const requestId = useRef(0);
  const [view, setView] = useState<KnowledgeView>(initialView);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [counts, setCounts] = useState<KnowledgeCounts>(EMPTY_COUNTS);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorItem, setEditorItem] = useState<KnowledgeItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<KnowledgeItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savingCandidateId, setSavingCandidateId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const load = useCallback(async () => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError('');
    const response = await listKnowledge({ view, page, perPage: 20, query });
    if (activeRequest !== requestId.current) return;

    if (response.success && response.data) {
      const data = response.data;
      const nextTotalPages = Math.max(1, data.total_pages);
      setItems(data.items);
      setTotal(data.total);
      setTotalPages(nextTotalPages);
      setCounts((current) => data.counts || {
        pages: view === 'pages' ? data.total : current.pages,
        inbox: view === 'inbox' ? data.total : current.inbox,
      });
      if (page > nextTotalPages) {
        setItems([]);
        setSelected(null);
        setPage(nextTotalPages);
        setLoading(false);
        return;
      }
      setSelected((current) => {
        const matched = current
          ? data.items.find((item) => item.id === current.id && item.kind === current.kind)
          : null;
        return matched || data.items[0] || null;
      });
    } else {
      setItems([]);
      setTotal(0);
      setTotalPages(1);
      setSelected(null);
      setError(response.error || '知识工作区暂时无法加载，请稍后重试。');
    }
    setLoading(false);
  }, [page, query, refreshToken, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view === initialView) return;
    setView(initialView);
    setPage(1);
    setSelected(null);
    setStatusMessage('');
  }, [initialView]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(searchInput.trim());
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const switchView = (nextView: KnowledgeView) => {
    if (nextView === view) return;
    setView(nextView);
    setPage(1);
    setSelected(null);
    setStatusMessage('');
    router.replace(nextView === 'pages' ? '/notes' : '/notes?view=inbox', { scroll: false });
  };

  const openEditor = (item?: KnowledgeItem) => {
    setEditorItem(item || null);
    setEditorOpen(true);
  };

  const handleSaved = (item: KnowledgeItem) => {
    setEditorOpen(false);
    setEditorItem(null);
    setView('pages');
    setPage(1);
    setSearchInput('');
    setQuery('');
    setSelected(item);
    setStatusMessage(editorItem ? '知识页已更新。' : '知识页已创建。');
    setRefreshToken((value) => value + 1);
    router.replace('/notes', { scroll: false });
  };

  const saveCandidate = async (item: KnowledgeItem) => {
    const noteId = itemSourceNoteId(item);
    if (!noteId || savingCandidateId) return;
    setSavingCandidateId(noteId);
    setStatusMessage('');
    const response = await saveKnowledgeCandidate(noteId);
    setSavingCandidateId('');
    if (!response.success || !response.data) {
      setStatusMessage(response.error || '保存失败，请稍后重试。');
      return;
    }
    setView('pages');
    setPage(1);
    setSearchInput('');
    setQuery('');
    setSelected(response.data);
    setStatusMessage('已保存为知识页。');
    setRefreshToken((value) => value + 1);
    router.replace('/notes', { scroll: false });
  };

  const remove = async () => {
    if (!deletingItem) return;
    setDeleting(true);
    const response = await deleteKnowledgeEntry(deletingItem.id);
    setDeleting(false);
    if (!response.success) {
      setStatusMessage(response.error || '删除失败，请稍后重试。');
      setDeletingItem(null);
      return;
    }
    setDeletingItem(null);
    setSelected(null);
    setStatusMessage('知识页已删除。');
    setRefreshToken((value) => value + 1);
  };

  const chooseItem = (item: KnowledgeItem) => {
    if (isMobile) {
      router.push(itemHref(item));
      return;
    }
    setSelected(item);
    setStatusMessage('');
  };

  const hasSearch = Boolean(query);

  return (
    <main className={`${styles.page} knowledge-page-canvas`}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <h1>我的知识</h1>
        </div>
        <div className={styles.headerActions}>
          <Link href="/agent" className={styles.agentLink}>
            <Robot size={18} aria-hidden="true" />去提问
          </Link>
          <button type="button" className={styles.primaryButton} onClick={() => openEditor()}>
            <Plus size={18} weight="bold" aria-hidden="true" />新建知识页
          </button>
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.listPane} aria-label={view === 'pages' ? '知识页列表' : '待整理列表'}>
          <div className={styles.listControls}>
            <div className={styles.viewTabs} role="group" aria-label="知识视图">
              <button
                type="button"
                aria-pressed={view === 'pages'}
                className={view === 'pages' ? styles.activeTab : ''}
                onClick={() => switchView('pages')}
              >
                <span>知识页</span>
                <strong>{counts.pages.toLocaleString('zh-CN')}</strong>
              </button>
              <button
                type="button"
                aria-pressed={view === 'inbox'}
                className={view === 'inbox' ? styles.activeTab : ''}
                onClick={() => switchView('inbox')}
              >
                <span>待整理</span>
                <strong>{counts.inbox.toLocaleString('zh-CN')}</strong>
              </button>
            </div>
            <label className={styles.search}>
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value.slice(0, 120))}
                placeholder={view === 'pages' ? '搜索知识页' : '搜索待整理'}
                aria-label={view === 'pages' ? '搜索知识页' : '搜索待整理内容'}
              />
              {searchInput ? (
                <button type="button" onClick={() => setSearchInput('')} aria-label="清空搜索">
                  <X size={16} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <header className={styles.listHeader}>
              <span>{hasSearch ? '搜索结果' : view === 'pages' ? '全部知识页' : '全部待整理'}</span>
              <small>{loading ? '读取中' : `${total.toLocaleString('zh-CN')} 条`}</small>
            </header>
          </div>

          <div className={styles.listBody}>
            {error ? (
            <section className={styles.listState} role="alert">
              <h2>没有读到当前内容</h2>
              <p>{error}</p>
              <button type="button" onClick={() => void load()}>重新加载</button>
            </section>
          ) : loading ? (
            <div className={styles.listSkeletons} aria-busy="true" aria-label="正在加载知识">
              {Array.from({ length: 6 }).map((_, index) => <div key={index} className={styles.rowSkeleton} />)}
            </div>
          ) : items.length === 0 ? (
            <section className={styles.listState}>
              {view === 'pages' ? <NotePencil size={28} weight="duotone" aria-hidden="true" /> : <VideoCamera size={28} weight="duotone" aria-hidden="true" />}
              <h2>
                {hasSearch
                  ? '没有匹配的内容'
                  : view === 'pages'
                    ? '还没有知识页'
                    : '当前没有待整理成果'}
              </h2>
              <p>
                  {hasSearch
                  ? '换个关键词试试。'
                  : view === 'pages'
                    ? '新建一页，保存值得长期使用的内容。'
                    : '视频摘要会出现在这里。'}
              </p>
              {hasSearch ? (
                <button type="button" onClick={() => setSearchInput('')}>清空搜索</button>
              ) : view === 'pages' ? (
                <button type="button" onClick={() => openEditor()}>新建知识页</button>
              ) : (
                <Link href="/agent">去提问</Link>
              )}
            </section>
          ) : (
            <div className={styles.knowledgeList} role="list">
              {items.map((item) => {
                const active = !isMobile && selected?.id === item.id && selected.kind === item.kind;
                const typeLabel = item.kind === 'candidate'
                  ? '待整理'
                  : item.origin === 'video'
                    ? '视频知识页'
                    : '知识页';
                return (
                  <div key={`${item.kind}-${item.id}`} role="listitem" className={styles.knowledgeRow}>
                    <button
                      type="button"
                      className={active ? styles.selectedRow : ''}
                      aria-pressed={active}
                      onClick={() => chooseItem(item)}
                    >
                      <SourceThumbnail item={item} />
                      <span className={styles.rowBody}>
                        <strong>{item.title}</strong>
                        <span className={styles.rowSummary}>{itemSummary(item)}</span>
                        <span className={styles.rowFacts}>
                          <span>{typeLabel}</span>
                          {item.author_name ? <span>{item.author_name}</span> : null}
                          <time dateTime={item.updated_at || undefined}>{formatDate(item.updated_at)}</time>
                        </span>
                      </span>
                      <ArrowRight className={styles.rowArrow} size={17} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
            )}
          </div>

          {totalPages > 1 ? (
            <nav className={styles.pagination} aria-label="知识分页">
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1}>上一页</button>
              <span>第 {page} / {totalPages} 页</span>
              <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages}>下一页</button>
            </nav>
          ) : null}
        </section>

        {loading && !selected ? (
          <aside className={styles.reader} aria-label="正在加载阅读区"><div className={styles.readerSkeleton} /></aside>
        ) : (
          <KnowledgeReader
            item={selected}
            savingCandidate={Boolean(savingCandidateId)}
            statusMessage={statusMessage}
            onEdit={openEditor}
            onDelete={setDeletingItem}
            onSaveCandidate={(item) => void saveCandidate(item)}
          />
        )}
      </div>

      <KnowledgeEditorDialog
        open={editorOpen}
        initial={editorItem}
        onCancel={() => setEditorOpen(false)}
        onSaved={handleSaved}
      />
      <KnowledgeDeleteDialog
        item={deletingItem}
        pending={deleting}
        onCancel={() => setDeletingItem(null)}
        onConfirm={() => void remove()}
      />
    </main>
  );
}

function KnowledgePageDetail({ id }: { id: string }) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestId = useRef(0);
  const [item, setItem] = useState<KnowledgeItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError('');
    setItem(null);
    const response = await getKnowledgeEntry(id);
    if (activeRequest !== requestId.current) return;
    if (response.success && response.data) setItem(response.data);
    else setError(response.error || '这份知识页不存在，或你没有访问权限。');
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (item) headingRef.current?.focus();
  }, [item]);

  const remove = async () => {
    if (!item) return;
    setDeleting(true);
    const response = await deleteKnowledgeEntry(item.id);
    if (response.success) {
      router.replace('/notes');
      return;
    }
    setError(response.error || '删除失败，请稍后重试。');
    setDeleting(false);
    setConfirming(false);
  };

  if (loading) {
    return <main className={styles.detailPage}><div className={styles.detailSkeleton} aria-busy="true" aria-label="正在加载知识页" /></main>;
  }
  if (!item) {
    return (
      <main className={styles.detailPage}>
        <section className={styles.detailState} role="alert">
          <h1>无法打开这份知识页</h1>
          <p>{error}</p>
          <div><button type="button" onClick={() => void load()}>重新加载</button><Link href="/notes">返回我的知识</Link></div>
        </section>
      </main>
    );
  }

  const sourceNoteId = itemSourceNoteId(item);
  const body = item.content?.trim() || '';
  const showSummary = Boolean(item.summary?.trim() && !sameReadableText(item.summary, body));

  return (
    <main className={styles.detailPage}>
      <Link href="/notes" className={styles.back}><ArrowLeft size={17} weight="bold" aria-hidden="true" />返回我的知识</Link>
      <article className={styles.document}>
        <header>
          <span>{item.origin === 'video' ? '视频整理' : '知识页'}{item.source_label ? ` · ${item.source_label}` : ''}</span>
          <h1 ref={headingRef} tabIndex={-1}>{item.title}</h1>
          <p>更新于 {formatDate(item.updated_at, true)}</p>
          <div>
            <button type="button" onClick={() => setEditorOpen(true)}><PencilSimple size={17} aria-hidden="true" />编辑</button>
            <button type="button" className={styles.dangerTextButton} onClick={() => setConfirming(true)}><Trash size={17} aria-hidden="true" />删除</button>
            {sourceNoteId ? (
              <Link href={`/library/detail?note=${encodeURIComponent(sourceNoteId)}`}><VideoCamera size={17} aria-hidden="true" />查看来源视频</Link>
            ) : null}
          </div>
          {error ? <p className={styles.actionError} role="alert">{error}</p> : null}
        </header>
        {showSummary ? <section className={styles.documentLead}><small>一句话摘要</small><p>{item.summary}</p></section> : null}
        <div className={styles.documentProse}>{body}</div>
        {item.source_label ? (
          <footer className={styles.documentFooter}>
            <span>来源说明</span>
            <p>{item.source_label}</p>
          </footer>
        ) : null}
      </article>

      <KnowledgeEditorDialog
        open={editorOpen}
        initial={item}
        onCancel={() => setEditorOpen(false)}
        onSaved={(updated) => {
          setItem(updated);
          setEditorOpen(false);
        }}
      />
      <KnowledgeDeleteDialog
        item={confirming ? item : null}
        pending={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </main>
  );
}

function CandidateDetail({ id }: { id: string }) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestId = useRef(0);
  const [item, setItem] = useState<KnowledgeItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError('');
    setItem(null);
    const response = await getKnowledgeCandidate(id);
    if (activeRequest !== requestId.current) return;
    if (response.success && response.data) setItem(response.data);
    else setError(response.error || '这条待整理内容不存在，或你没有访问权限。');
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (item) headingRef.current?.focus();
  }, [item]);

  const save = async () => {
    if (!item) return;
    setSaving(true);
    setError('');
    const response = await saveKnowledgeCandidate(itemSourceNoteId(item) || id);
    setSaving(false);
    if (response.success && response.data) {
      router.replace(`/notes?id=${encodeURIComponent(response.data.id)}&kind=page`);
      return;
    }
    setError(response.error || '保存失败，请稍后重试。');
  };

  if (loading) {
    return <main className={styles.detailPage}><div className={styles.detailSkeleton} aria-busy="true" aria-label="正在加载待整理内容" /></main>;
  }
  if (!item) {
    return (
      <main className={styles.detailPage}>
        <section className={styles.detailState} role="alert">
          <h1>无法打开这条待整理内容</h1>
          <p>{error}</p>
          <div><button type="button" onClick={() => void load()}>重新加载</button><Link href="/notes?view=inbox">返回待整理</Link></div>
        </section>
      </main>
    );
  }

  const sections = item.sections || [];
  const canSave = item.status === 'inbox';
  const body = item.content?.trim() || '';
  const lead = itemSummary(item);
  const showLead = ![body, ...sections.map((section) => section.content)]
    .some((candidate) => sameReadableText(lead, candidate));

  return (
    <main className={styles.detailPage}>
      <Link href={canSave ? '/notes?view=inbox' : '/notes'} className={styles.back}>
        <ArrowLeft size={17} weight="bold" aria-hidden="true" />{canSave ? '返回待整理' : '返回我的知识'}
      </Link>
      <article className={styles.document}>
        <header>
          <span>{canSave ? '待整理' : '视频来源'} · {item.platform || item.source_label || '视频摘要'}</span>
          <h1 ref={headingRef} tabIndex={-1}>{item.title}</h1>
          <p>{[item.author_name, formatDate(item.updated_at)].filter(Boolean).join(' · ')}</p>
          <div>
            {canSave ? (
              <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={saving}>
                <CheckCircle size={18} weight="bold" aria-hidden="true" />{saving ? '正在保存' : '保存为知识页'}
              </button>
            ) : null}
            <Link href={`/library/detail?note=${encodeURIComponent(itemSourceNoteId(item) || id)}`}><VideoCamera size={17} aria-hidden="true" />查看来源视频</Link>
          </div>
          {error ? <p className={styles.actionError} role="alert">{error}</p> : null}
        </header>
        {showLead ? (
          <section className={styles.documentLead}><small>{canSave ? '一句话摘要' : '摘要状态'}</small><p>{lead}</p></section>
        ) : null}
        {sections.length > 0 ? (
          <div className={styles.documentSections}>
            {sections.map((section, index) => (
              <section key={`${section.title}-${index}`}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><h2>{section.title || '未命名要点'}</h2><p>{section.content}</p></div>
              </section>
            ))}
          </div>
        ) : <div className={styles.documentProse}>{body || '这条摘要暂时没有更多分段内容。'}</div>}
        <p className={styles.candidateNotice}>
          {canSave
            ? '这是一份由视频摘要生成的草稿，请在保存后继续核对和完善。'
            : '这条历史视频暂时没有可整理摘要，完整内容仍保留在来源视频工作区。'}
        </p>
      </article>
    </main>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={<main className={`${styles.page} knowledge-page-canvas`}><div className={styles.pageSkeleton} aria-busy="true" /></main>}>
      <NotesContent />
    </Suspense>
  );
}
