'use client';

import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface MarqueeItemRect {
  id: string;
  rect: MarqueeRect;
}

interface MarqueeCommitDetails {
  selectedIds: Set<string>;
  hitIds: string[];
}

interface UseMarqueeSelectionOptions {
  containerRef: RefObject<HTMLElement | null>;
  selectedIds: ReadonlySet<string>;
  maxSelection: number;
  disabled?: boolean;
  isDisabled?: () => boolean;
  activationDistance?: number;
  alwaysAdditive?: boolean;
  shouldStart?: (target: HTMLElement, container: HTMLElement) => boolean;
  onSelectionChange: (next: Set<string>) => void;
  onCommit?: (details: MarqueeCommitDetails) => void;
  onLimitReached?: () => void;
}

interface ActiveGesture {
  pointerId: number;
  container: HTMLElement;
  start: Point;
  additive: boolean;
  baseSelection: Set<string>;
  active: boolean;
  bounds: MarqueeRect | null;
  items: MarqueeItemRect[];
  candidate: Set<string>;
  hitIds: string[];
  limitReached: boolean;
  previousUserSelect: string;
  previousCursor: string;
  frameId: number | null;
  pendingPoint: Point | null;
  removeListeners: () => void;
}

const ITEM_SELECTOR = '[data-marquee-id]';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectRight(rect: MarqueeRect): number {
  return rect.left + rect.width;
}

function rectBottom(rect: MarqueeRect): number {
  return rect.top + rect.height;
}

function plainRect(rect: DOMRect): MarqueeRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function clipRect(rect: DOMRect, bounds: MarqueeRect): MarqueeRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, rectRight(bounds));
  const bottom = Math.min(rect.bottom, rectBottom(bounds));
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function marqueeRectFromPoints(
  start: Point,
  current: Point,
  bounds: MarqueeRect,
): MarqueeRect {
  const startX = clamp(start.x, bounds.left, rectRight(bounds));
  const startY = clamp(start.y, bounds.top, rectBottom(bounds));
  const currentX = clamp(current.x, bounds.left, rectRight(bounds));
  const currentY = clamp(current.y, bounds.top, rectBottom(bounds));
  return {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

export function marqueeRectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return a.left <= rectRight(b)
    && rectRight(a) >= b.left
    && a.top <= rectBottom(b)
    && rectBottom(a) >= b.top;
}

function setsEqual(a: ReadonlySet<string> | null, b: ReadonlySet<string>): boolean {
  if (!a || a.size !== b.size) return false;
  return Array.from(a).every((id) => b.has(id));
}

function defaultShouldStart(target: HTMLElement): boolean {
  return !target.closest([
    'a',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
  ].join(','));
}

function nearestHTMLElement(target: EventTarget | null): HTMLElement | null {
  let element = target instanceof Element ? target : null;
  while (element && !(element instanceof HTMLElement)) {
    element = element.parentElement;
  }
  return element;
}

function startsOnNativeScrollbar(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const rect = container.getBoundingClientRect();
  const verticalGutter = container.offsetWidth - container.clientWidth;
  const horizontalGutter = container.offsetHeight - container.clientHeight;
  const direction = window.getComputedStyle(container).direction;
  const onVerticalScrollbar = verticalGutter > 2 && (
    direction === 'rtl'
      ? clientX <= rect.left + verticalGutter
      : clientX >= rect.right - verticalGutter
  );
  const onHorizontalScrollbar = horizontalGutter > 2
    && clientY >= rect.bottom - horizontalGutter;
  return onVerticalScrollbar || onHorizontalScrollbar;
}

export function useMarqueeSelection({
  containerRef,
  selectedIds,
  maxSelection,
  disabled = false,
  isDisabled,
  activationDistance = 6,
  alwaysAdditive = false,
  shouldStart,
  onSelectionChange,
  onCommit,
  onLimitReached,
}: UseMarqueeSelectionOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [previewSelectedIds, setPreviewSelectedIds] = useState<Set<string> | null>(null);
  const [active, setActive] = useState(false);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const suppressClickRef = useRef(false);
  const clickCleanupRef = useRef<(() => void) | null>(null);
  const releaseGuardCleanupRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef({
    containerRef,
    selectedIds,
    maxSelection,
    disabled,
    isDisabled,
    activationDistance,
    alwaysAdditive,
    shouldStart,
    onSelectionChange,
    onCommit,
    onLimitReached,
  });

  optionsRef.current = {
    containerRef,
    selectedIds,
    maxSelection,
    disabled,
    isDisabled,
    activationDistance,
    alwaysAdditive,
    shouldStart,
    onSelectionChange,
    onCommit,
    onLimitReached,
  };

  const clearClickSuppression = useCallback(() => {
    clickCleanupRef.current?.();
    clickCleanupRef.current = null;
    suppressClickRef.current = false;
  }, []);

  const armClickSuppression = useCallback(() => {
    clearClickSuppression();
    suppressClickRef.current = true;
    const swallowClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearClickSuppression();
    };
    window.addEventListener('click', swallowClick, true);
    const timeoutId = window.setTimeout(clearClickSuppression, 0);
    clickCleanupRef.current = () => {
      window.removeEventListener('click', swallowClick, true);
      window.clearTimeout(timeoutId);
    };
  }, [clearClickSuppression]);

  const clearReleaseGuard = useCallback(() => {
    releaseGuardCleanupRef.current?.();
    releaseGuardCleanupRef.current = null;
  }, []);

  const armReleaseGuard = useCallback((pointerId: number) => {
    clearReleaseGuard();
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      clearReleaseGuard();
      armClickSuppression();
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) clearReleaseGuard();
    };
    const handleNextPointerDown = () => clearReleaseGuard();
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    window.addEventListener('pointerdown', handleNextPointerDown, true);
    releaseGuardCleanupRef.current = () => {
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
      window.removeEventListener('pointerdown', handleNextPointerDown, true);
    };
  }, [armClickSuppression, clearReleaseGuard]);

  const finishGesture = useCallback((
    commit: boolean,
    updateVisualState = true,
    guardReleaseClick = false,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
    gesture.frameId = null;
    gesture.pendingPoint = null;
    gesture.removeListeners();
    if (gesture.container.hasPointerCapture(gesture.pointerId)) {
      try {
        gesture.container.releasePointerCapture(gesture.pointerId);
      } catch {
        // 浏览器可能在 pointerup 监听执行前已经释放捕获。
      }
    }
    gesture.container.removeAttribute('data-marquee-active');

    if (gesture.active) {
      document.body.style.userSelect = gesture.previousUserSelect;
      document.body.style.cursor = gesture.previousCursor;
    }

    if (commit && gesture.active) {
      const next = new Set(gesture.candidate);
      const details = {
        selectedIds: next,
        hitIds: [...gesture.hitIds],
      };
      optionsRef.current.onSelectionChange(next);
      optionsRef.current.onCommit?.(details);
      if (gesture.limitReached) optionsRef.current.onLimitReached?.();
      armClickSuppression();
    } else if (gesture.active && guardReleaseClick) {
      armReleaseGuard(gesture.pointerId);
    }

    if (updateVisualState) {
      setMarqueeRect(null);
      setPreviewSelectedIds(null);
      setActive(false);
    }
  }, [armClickSuppression, armReleaseGuard]);

  const isSelectionDisabled = useCallback(() => {
    const options = optionsRef.current;
    return options.disabled || Boolean(options.isDisabled?.());
  }, []);

  const handlePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== 'mouse'
      || event.button !== 0
      || !event.isPrimary
      || isSelectionDisabled()
    ) return;

    const container = optionsRef.current.containerRef.current;
    const target = nearestHTMLElement(event.target);
    if (!container || !target || !container.contains(target)) return;
    if (startsOnNativeScrollbar(container, event.clientX, event.clientY)) return;

    const canStart = optionsRef.current.shouldStart
      ? optionsRef.current.shouldStart(target, container)
      : defaultShouldStart(target);
    if (!canStart) return;

    finishGesture(false);

    const gesture: ActiveGesture = {
      pointerId: event.pointerId,
      container,
      start: { x: event.clientX, y: event.clientY },
      additive: optionsRef.current.alwaysAdditive || event.ctrlKey || event.metaKey,
      baseSelection: new Set(optionsRef.current.selectedIds),
      active: false,
      bounds: null,
      items: [],
      candidate: new Set(optionsRef.current.selectedIds),
      hitIds: [],
      limitReached: false,
      previousUserSelect: '',
      previousCursor: '',
      frameId: null,
      pendingPoint: null,
      removeListeners: () => undefined,
    };

    const updateCandidate = (point: Point) => {
      if (!gesture.bounds) return;
      const nextRect = marqueeRectFromPoints(gesture.start, point, gesture.bounds);
      const hitIds = gesture.items
        .filter((item) => marqueeRectsIntersect(nextRect, item.rect))
        .map((item) => item.id);
      const next = gesture.additive
        ? new Set(gesture.baseSelection)
        : new Set<string>();
      let limited = false;

      hitIds.forEach((id) => {
        if (next.has(id)) return;
        if (next.size >= optionsRef.current.maxSelection) {
          limited = true;
          return;
        }
        next.add(id);
      });

      gesture.limitReached = limited;

      gesture.candidate = next;
      gesture.hitIds = hitIds;
      setMarqueeRect(nextRect);
      setPreviewSelectedIds((current) => (setsEqual(current, next) ? current : new Set(next)));
    };

    const scheduleCandidate = (point: Point) => {
      gesture.pendingPoint = point;
      if (gesture.frameId !== null) return;
      gesture.frameId = window.requestAnimationFrame(() => {
        gesture.frameId = null;
        const pendingPoint = gesture.pendingPoint;
        gesture.pendingPoint = null;
        if (gestureRef.current === gesture && pendingPoint) updateCandidate(pendingPoint);
      });
    };

    const flushCandidate = (point: Point) => {
      if (gesture.frameId !== null) window.cancelAnimationFrame(gesture.frameId);
      gesture.frameId = null;
      gesture.pendingPoint = null;
      updateCandidate(point);
    };

    const activateGesture = (point: Point): boolean => {
      if (!gesture.container.isConnected || isSelectionDisabled()) return false;
      const bounds = plainRect(gesture.container.getBoundingClientRect());
      if (bounds.width <= 0 || bounds.height <= 0) return false;

      const seenIds = new Set<string>();
      gesture.bounds = bounds;
      gesture.items = Array.from(
        gesture.container.querySelectorAll<HTMLElement>(ITEM_SELECTOR),
      ).flatMap((element) => {
        const id = element.getAttribute('data-marquee-id')?.trim();
        if (!id || seenIds.has(id) || element.dataset.marqueeDisabled === 'true') return [];
        const rect = clipRect(element.getBoundingClientRect(), bounds);
        if (!rect) return [];
        seenIds.add(id);
        return [{ id, rect }];
      });
      gesture.active = true;
      gesture.previousUserSelect = document.body.style.userSelect;
      gesture.previousCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'crosshair';
      gesture.container.setAttribute('data-marquee-active', 'true');
      try {
        gesture.container.setPointerCapture(gesture.pointerId);
      } catch {
        // 捕获不可用时仍由 window 级监听兜底。
      }
      window.getSelection()?.removeAllRanges();
      setActive(true);
      updateCandidate(point);
      return true;
    };

    const handlePointerMove = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== gesture.pointerId) return;
      if ((nativeEvent.buttons & 1) === 0) {
        finishGesture(false);
        return;
      }
      if (isSelectionDisabled()) {
        finishGesture(false, true, true);
        return;
      }

      const point = { x: nativeEvent.clientX, y: nativeEvent.clientY };
      if (!gesture.active) {
        const distance = Math.hypot(
          point.x - gesture.start.x,
          point.y - gesture.start.y,
        );
        if (distance < optionsRef.current.activationDistance) return;
        if (!activateGesture(point)) {
          finishGesture(false);
          return;
        }
      } else {
        scheduleCandidate(point);
      }
      nativeEvent.preventDefault();
    };

    const handlePointerUp = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== gesture.pointerId) return;
      if (gesture.active) {
        nativeEvent.preventDefault();
        if (isSelectionDisabled()) {
          finishGesture(false);
          armClickSuppression();
        } else {
          flushCandidate({ x: nativeEvent.clientX, y: nativeEvent.clientY });
          finishGesture(true);
        }
        return;
      }
      finishGesture(false);
    };

    const handlePointerCancel = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId === gesture.pointerId) finishGesture(false);
    };

    const handleWindowBlur = () => finishGesture(false, true, true);
    const handleScroll = () => finishGesture(false, true, true);
    const handleLostPointerCapture = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId === gesture.pointerId) finishGesture(false, true, true);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) finishGesture(false, true, true);
    };
    const handleKeyDown = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key !== 'Escape') return;
      if (gesture.active) {
        nativeEvent.preventDefault();
        nativeEvent.stopImmediatePropagation();
      }
      finishGesture(false, true, true);
    };

    gesture.removeListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      gesture.container.removeEventListener('lostpointercapture', handleLostPointerCapture);
    };
    gestureRef.current = gesture;
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    gesture.container.addEventListener('lostpointercapture', handleLostPointerCapture);
  }, [finishGesture, isSelectionDisabled]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    clearClickSuppression();
  }, [clearClickSuppression]);

  const handleDragStartCapture = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (gestureRef.current) event.preventDefault();
  }, []);

  useEffect(() => {
    if (disabled) finishGesture(false, true, true);
  }, [disabled, finishGesture]);

  useEffect(() => () => {
    finishGesture(false, false);
    clearClickSuppression();
    clearReleaseGuard();
  }, [clearClickSuppression, clearReleaseGuard, finishGesture]);

  return {
    active,
    marqueeRect,
    previewSelectedIds,
    surfaceProps: {
      onPointerDownCapture: handlePointerDownCapture,
      onClickCapture: handleClickCapture,
      onDragStartCapture: handleDragStartCapture,
    },
    cancel: () => finishGesture(false, true, true),
  };
}
