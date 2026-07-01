/**
 * GSAP animation lifecycle hook.
 *
 * Wraps gsap.context() so animations are automatically cleaned up when the
 * component unmounts.  Returns a ``ctx`` ref that you can add animations to.
 *
 * Usage::
 *
 *   const ctx = useGsapAnimation((gsap) => {
 *     // All animations created here are scoped to this component
 *     gsap.from('.card', { opacity: 0, y: 40, stagger: 0.1 });
 *   });
 *
 *   // Later, append more animations to the same context:
 *   ctx.current?.add(() => {
 *     gsap.to('.badge', { scale: 1.1, duration: 0.3 });
 *   });
 */

import { useRef, useLayoutEffect } from 'react';
import gsap from 'gsap';

type GsapCallback = (gsapInstance: typeof gsap) => void;

/**
 * Create a GSAP animation context tied to a React component lifecycle.
 *
 * @param animate - Callback invoked once in a ``useLayoutEffect``.
 *   All animations created inside this callback are automatically
 *   reverted and killed when the component unmounts.
 * @param deps - Dependency array (same semantics as useEffect).
 *   Defaults to ``[]`` so the animation runs once on mount.
 * @returns The ``gsap.Context`` ref — you can call ``ctx.current?.add(fn)``
 *   to schedule additional animations later.
 */
export function useGsapAnimation(
  animate: GsapCallback,
  deps: React.DependencyList = [],
) {
  const ctxRef = useRef<gsap.Context | null>(null);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      animate(gsap);
    });
    ctxRef.current = ctx;

    return () => {
      ctx.revert(); // kill + clean up all animations in this context
      ctxRef.current = null;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return ctxRef;
}

/**
 * Check whether the user prefers reduced motion.  Wrap animation creation
 * in this check when you want to respect the OS-level accessibility setting.
 *
 * Usage::
 *
 *   if (shouldAnimate()) {
 *     gsap.from('.card', { opacity: 0, y: 20 });
 *   }
 */
export function shouldAnimate(): boolean {
  if (typeof window === 'undefined') return true;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
