'use client';

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { BookBookmark, DotsThree, EyeSlash, X } from '@phosphor-icons/react';
import { homeVideoKey, type HomeVideoTarget } from '@/lib/homeVideoActions';
import type { HomeVideoActions } from '@/lib/hooks/useHomeVideoActions';
import styles from './HomeVideoActions.module.css';

interface MenuState { video: HomeVideoTarget; userId: string; x: number; y: number; trigger: HTMLElement }

export function useHomeVideoInteractions(actions: HomeVideoActions) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragged, setDragged] = useState<{ video: HomeVideoTarget; userId: string } | null>(null);
  const dragRef = useRef<typeof dragged>(null);
  const [over, setOver] = useState(false);
  useEffect(() => { setMenu(null); setDragged(null); dragRef.current = null; setOver(false); }, [actions.userId]);
  const open = (video: HomeVideoTarget, trigger: HTMLElement, x: number, y: number) => {
    if (!actions.userId || !actions.visible(video)) return;
    setMenu({ video, trigger, userId: actions.userId,
      x: Math.max(12, Math.min(x, window.innerWidth - 252)), y: Math.max(12, Math.min(y, window.innerHeight - 190)) });
  };
  const close = () => {
    const target = menu?.trigger;
    setMenu(null);
    if (target?.isConnected) target.focus({ preventScroll: true });
  };
  const endDrag = () => { dragRef.current = null; setDragged(null); setOver(false); };
  const startDrag = (video: HomeVideoTarget, event: DragEvent) => {
    if (!actions.userId || !actions.visible(video) || actions.busy.has(homeVideoKey(video))) { event.preventDefault(); return; }
    const next = { video, userId: actions.userId }; dragRef.current = next; setDragged(next); setMenu(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-zhicui-home-video', homeVideoKey(video));
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const source = dragRef.current;
    endDrag();
    if (source?.userId !== actions.userId || !source || !actions.visible(source.video)) return;
    void actions.run(source.video, 'hide');
  };
  return { menu: menu?.userId === actions.userId ? menu : null, open, close, dragged, over, setOver, startDrag, endDrag, drop };
}
export type HomeVideoInteractions = ReturnType<typeof useHomeVideoInteractions>;

/** 卡片的链接和更多按钮是兄弟节点，拖放不移动任何 React DOM。 */
export function HomeVideoActionCard({ video, actions, interactions, children, variant = 'cover' }: {
  video: HomeVideoTarget; actions: HomeVideoActions; interactions: HomeVideoInteractions; children: ReactNode; variant?: 'cover' | 'recap';
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const suppressClickUntil = useRef(0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const cancelLongPress = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => cancelLongPress, []);
  const busy = actions.busy.has(homeVideoKey(video));
  return (
    <div className={`${styles.card} ${variant === 'recap' ? styles.recapCard : ''}`} draggable={!busy}
      data-home-video={homeVideoKey(video)} aria-busy={busy}
      onDragStart={(event) => { cancelLongPress(); interactions.startDrag(video, event); }} onDragEnd={interactions.endDrag}
      onContextMenu={(event) => { event.preventDefault(); cancelLongPress(); if (moreRef.current) interactions.open(video, moreRef.current, event.clientX, event.clientY); }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || (event.target as HTMLElement).closest('button')) return;
        origin.current = { x: event.clientX, y: event.clientY }; cancelLongPress();
        timer.current = setTimeout(() => {
          suppressClickUntil.current = Date.now() + 900;
          if (moreRef.current) interactions.open(video, moreRef.current, origin.current.x, origin.current.y);
        }, 500);
      }}
      onPointerMove={(event) => { if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancelLongPress(); }}
      onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress}
      onClickCapture={(event) => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } }}>
      {children}
      <button ref={moreRef} type="button" draggable={false} className={styles.more} aria-label={`管理视频：${video.title}`}
        aria-haspopup="menu" disabled={busy} onClick={(event) => {
          event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect();
          interactions.open(video, event.currentTarget, rect.right - 240, rect.bottom + 6);
        }}><DotsThree size={22} weight="bold" aria-hidden="true" /></button>
    </div>
  );
}

export function HomeVideoActionsLayer({ actions, interactions }: { actions: HomeVideoActions; interactions: HomeVideoInteractions }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { menu } = interactions;
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) interactions.close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); interactions.close(); } };
    const resize = () => interactions.close();
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize); };
  }, [menu]);
  const video = menu?.video;
  const saved = video ? actions.preferences.get(homeVideoKey(video))?.knowledge_entry_id : null;
  const run = (action: 'hide' | 'save') => { if (video) { interactions.close(); void actions.run(video, action); } };
  return (
    <>
      {!actions.ready && <div className={styles.preferenceStatus} role={actions.error ? 'alert' : 'status'}>
        <span>{actions.error || '正在读取首页视频设置…'}</span>
        {actions.error && <button type="button" onClick={() => void actions.reload()}>重试</button>}
      </div>}
      {actions.ready && <div className={`${styles.dropZone} ${interactions.dragged ? styles.dragging : ''} ${interactions.over ? styles.over : ''}`}
        aria-label="从首页隐藏视频" onDragOver={(event) => { if (interactions.dragged) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; interactions.setOver(true); } }}
        onDragLeave={() => interactions.setOver(false)} onDrop={interactions.drop}>
        <EyeSlash size={22} aria-hidden="true" /><span><strong>{interactions.dragged ? '松开，从首页隐藏' : '拖动视频到这里，从首页隐藏'}</strong><small>原视频和同步记录会保留</small></span>
      </div>}
      <div ref={menuRef} className={styles.menu} role="menu" aria-label="视频操作" hidden={!menu}
        style={{ '--menu-x': `${menu?.x || 0}px`, '--menu-y': `${menu?.y || 0}px` } as CSSProperties}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
          if (!buttons.length) return; event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus();
        }}>
        <p>{video?.title}</p>
        <button type="button" role="menuitem" onClick={() => run('save')}><BookBookmark size={19} aria-hidden="true" />{saved ? '已加入知萃知识库' : '加入知萃知识库'}</button>
        <button type="button" role="menuitem" onClick={() => run('hide')}><EyeSlash size={19} aria-hidden="true" />从首页隐藏</button>
      </div>
      {actions.notice && !interactions.dragged && <div className={styles.notice} role="status">
        <span>{actions.notice.message}</span>
        {actions.notice.undo && <button type="button" disabled={actions.busy.has(homeVideoKey(actions.notice.undo))} onClick={() => void actions.run(actions.notice!.undo!, 'restore')}>撤销</button>}
        {actions.notice.knowledgeId && <Link href={`/notes?id=${encodeURIComponent(actions.notice.knowledgeId)}`}>查看知识库</Link>}
        <button type="button" className={styles.closeNotice} aria-label="关闭提示" onClick={actions.dismiss}><X size={17} aria-hidden="true" /></button>
      </div>}
    </>
  );
}
