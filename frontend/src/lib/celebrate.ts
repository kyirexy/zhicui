/**
 * Completion celebrations via canvas-confetti.
 *
 * Both helpers respect `prefers-reduced-motion` — they no-op when the user has
 * requested reduced motion, so we never impose animation on those who opted out.
 */

import confetti from 'canvas-confetti';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Small, quick burst — use when a single day's tasks are all checked off. */
export function celebrateDayDone(): void {
  if (prefersReducedMotion()) return;
  confetti({
    particleCount: 45,
    spread: 60,
    startVelocity: 28,
    gravity: 0.9,
    scalar: 0.8,
    ticks: 120,
    origin: { y: 0.7 },
    colors: ['#2563eb', '#60a5fa', '#4f5bd5', '#fbbf24'],
  });
}

/** Bigger sustained celebration — use when the entire plan reaches 100%. */
export function celebrateCompletion(): void {
  if (prefersReducedMotion()) return;
  const end = Date.now() + 900;
  const colors = ['#2563eb', '#60a5fa', '#22d3ee', '#4f5bd5', '#fbbf24', '#fb7185'];

  // Initial center burst.
  confetti({
    particleCount: 120,
    spread: 100,
    startVelocity: 45,
    origin: { y: 0.6 },
    colors,
  });

  // Side cannons for a short follow-up.
  const frame = () => {
    if (Date.now() > end) return;
    confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.65 }, colors });
    confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.65 }, colors });
    requestAnimationFrame(frame);
  };
  frame();
}
