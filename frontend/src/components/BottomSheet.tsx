'use client';

import { useCallback, useEffect, useRef, type ReactNode, type TouchEvent } from 'react';
import { X } from 'lucide-react';
import styles from './BottomSheet.module.css';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 保留旧接口兼容；原生 dialog 本身会稳定挂载。 */
  keepMounted?: boolean;
  desktopDialog?: boolean;
  panelClassName?: string;
}

/**
 * 移动端底部弹层。使用浏览器原生 dialog 顶层，避免 Portal 在 React
 * 卸载期间与 document.body 的真实子节点状态不一致。
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  keepMounted: _keepMounted = false,
  desktopDialog = false,
  panelClassName = '',
}: BottomSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragStartY = useRef<number | null>(null);
  const dragOffsetY = useRef(0);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const close = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      dialog.showModal();
      window.requestAnimationFrame(() => panelRef.current?.focus());
      return;
    }

    if (!open && dialog.open) {
      dialog.close();
      previousFocusRef.current?.focus();
    }
  }, [open]);

  const onTouchStart = useCallback((event: TouchEvent) => {
    dragStartY.current = event.touches[0].clientY;
    dragOffsetY.current = 0;
  }, []);

  const onTouchMove = useCallback((event: TouchEvent) => {
    if (dragStartY.current === null) return;
    const offset = event.touches[0].clientY - dragStartY.current;
    if (offset > 0 && panelRef.current) {
      dragOffsetY.current = offset;
      panelRef.current.style.transform = `translateY(${offset}px)`;
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (panelRef.current) panelRef.current.style.transform = '';
    if (dragOffsetY.current > 80) close();
    dragStartY.current = null;
    dragOffsetY.current = 0;
  }, [close]);

  return (
    <dialog
      ref={dialogRef}
      className={`${styles.dialog} ${desktopDialog ? styles.desktopDialog : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const outside = event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom;
        if (outside) close();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`${styles.panel} ${panelClassName}`}
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          maxHeight: '85dvh',
        }}
      >
        <div
          className="bottom-sheet-drag-handle flex cursor-grab select-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <span className="block h-1.5 w-10 rounded-full bg-foreground-muted/40" />
        </div>

        <div className="flex items-center justify-between px-5 py-2">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="flex h-11 w-11 items-center justify-center rounded-full text-foreground-muted transition-colors duration-150 hover:bg-black/[0.04] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-brand"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 pb-6" style={{ maxHeight: 'calc(85dvh - 64px)' }}>
          {children}
        </div>
      </div>
    </dialog>
  );
}
