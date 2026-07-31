'use client';

import { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** When true, render even if not open (for SSR-stable mount); default false. */
  keepMounted?: boolean;
  /** Keeps the mobile sheet behavior while presenting as a centered dialog on desktop. */
  desktopDialog?: boolean;
  panelClassName?: string;
}

/**
 * Mobile-first bottom sheet. Renders into document.body via portal so it
 * escapes parent stacking contexts. Auto-locks body scroll while open.
 *
 * Close interactions: tap backdrop, tap X button, press Escape, drag handle
 * downward by ≥ 80px.
 *
 * Visual: rounded-top glass panel that slides up from the bottom. Designed
 * for mobile (`< md`) — desktop callers should usually prefer popovers or
 * inline UI instead.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  keepMounted = false,
  desktopDialog = false,
  panelClassName = '',
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragStartY = useRef<number | null>(null);
  const dragOffsetY = useRef<number>(0);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const close = useCallback(() => {
    onCloseRef.current();
  }, []);

  // Keyboard containment, focus restoration, and body scroll lock.
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => {
      const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      );
      (firstFocusable ?? panelRef.current)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open, close]);

  // Drag-to-dismiss: track touch on the handle area
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    dragOffsetY.current = 0;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    if (dy > 0 && panelRef.current) {
      dragOffsetY.current = dy;
      panelRef.current.style.transform = `translateY(${dy}px)`;
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.style.transform = '';
    }
    if (dragOffsetY.current > 80) {
      close();
    }
    dragStartY.current = null;
    dragOffsetY.current = 0;
  }, [close]);

  if (!keepMounted && !open) return null;
  if (typeof window === 'undefined') return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex items-end justify-center transition-opacity duration-[180ms] ${
        desktopDialog ? 'md:items-center md:px-5' : ''
      } ${
        open ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-modal={open || undefined}
      aria-hidden={!open}
      inert={!open}
      role="dialog"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={close}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative w-full max-w-2xl rounded-t-3xl glass-card border-t border-x border-card-border/60 shadow-[0_-12px_40px_rgba(0,0,0,0.2)] transition-transform duration-[180ms] ease-out ${
          desktopDialog ? 'md:max-w-xl md:rounded-2xl md:border md:shadow-2xl' : ''
        } ${panelClassName} ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          maxHeight: '85dvh',
        }}
      >
        {/* Drag handle */}
        <div
          className="bottom-sheet-drag-handle flex justify-center pt-2.5 pb-1 cursor-grab active:cursor-grabbing select-none"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <span className="block w-10 h-1.5 rounded-full bg-foreground-muted/40" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-2">
          <h2 className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="w-11 h-11 flex items-center justify-center rounded-full text-foreground-muted hover:text-foreground hover:bg-black/[0.04] focus-visible:outline-2 focus-visible:outline-[#237957] focus-visible:outline-offset-2 transition-colors duration-150"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content (scrollable) */}
        <div
          className="overflow-y-auto px-5 pb-6"
          style={{ maxHeight: 'calc(85dvh - 64px)' }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
