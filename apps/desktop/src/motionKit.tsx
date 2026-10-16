import { forwardRef, useEffect, type ReactNode } from "react";
import { animate, motion, useIsPresent, useMotionValue } from "motion/react";
import { spring } from "./tokens.js";

/**
 * Motion rules ported from the SwiftUI panel (docs/design/dial.md). Pure numbers live here so the
 * timings can be unit-tested; the components below only apply them. Everything animates transform
 * and opacity, which composite on the GPU in both WKWebView and WebView2.
 */

export type ListTab = "today" | "upcoming" | "all";
export const tabOrder: readonly ListTab[] = ["today", "upcoming", "all"];

/** +1 when the lit dot moves forward (or stays), -1 when it moves back, as ListRootView.tabTransition. */
export function tabDirection(previous: ListTab, next: ListTab): 1 | -1 {
  return tabOrder.indexOf(next) >= tabOrder.indexOf(previous) ? 1 : -1;
}

/** Calendar paging direction; equal anchors count as forward, as CalendarView.pageTurn. */
export function pageDirection(previous: string, next: string): 1 | -1 {
  return next >= previous ? 1 : -1;
}

/** Task check: press in, overshoot, settle (TaskRowView keyframeAnimator: 0.08 + 0.16 + 0.30). */
export const checkPress = (() => {
  const segments = [0.08, 0.16, 0.3];
  const duration = segments.reduce((sum, value) => sum + value, 0);
  const times = [0, ...segments.map((_, i) => segments.slice(0, i + 1).reduce((a, b) => a + b, 0) / duration)];
  return { values: [1, 0.82, 1.16, 1], times, duration };
})();

/** Panel arrival: every tile slides 18pt in from the right edge, 45ms apart (DialRevealModifier). */
export const reveal = { offset: 18, stagger: 0.045, response: 0.4, damping: 0.9 } as const;
export function revealDelay(order: number) {
  return order * reveal.stagger;
}

/** Row list content following the lit dot: 16pt, spring 0.34/0.9 after 0.04s; old rows clear in 0.1s. */
export const tabSwap = { distance: 16, delay: 0.04, outDuration: 0.1 } as const;

/** Linear 0.7s ring from the gauge tip (GaugePulse). */
export const pulse = { from: 3, to: 12, opacity: 0.7, duration: 0.7 } as const;

const fadeSpring = spring(0.34, 0.9);

/**
 * Replaces list rows in place when the view changes. The old rows leave first (ease-out 0.1s) while
 * the new ones slide in from the side the selection moved towards; the graphite tile never fades.
 */
export const TabSwap = forwardRef<HTMLDivElement, {
  children: ReactNode;
  direction: number;
  reduced: boolean;
}>(function TabSwap({ children, direction, reduced }, ref) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      className="tab-swap"
      inert={!present}
      aria-hidden={!present}
      custom={direction}
      variants={{
        enter: (side: number) => ({ x: reduced ? 0 : side * tabSwap.distance, opacity: 0 }),
        center: { x: 0, opacity: 1 },
        exit: { opacity: 0, transition: { duration: reduced ? 0.12 : tabSwap.outDuration, ease: "easeOut" } },
      }}
      initial="enter"
      animate="center"
      exit="exit"
      transition={reduced ? { duration: 0.12 } : { ...fadeSpring, delay: tabSwap.delay }}
    >
      {children}
    </motion.div>
  );
});

/**
 * Root dial and page title trade places in the same spot: the new one fades in (ease-out 0.16s),
 * the old one waits 0.04s and leaves in 0.08s (ease-in), so the pair is never half transparent.
 */
export const HeaderSwap = forwardRef<HTMLDivElement, { children: ReactNode; reduced: boolean }>(
  function HeaderSwap({ children, reduced }, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        ref={ref}
        className="header-swap"
        inert={!present}
        aria-hidden={!present}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: reduced ? 0.12 : 0.16, ease: "easeOut" } }}
        exit={{ opacity: 0, transition: { duration: reduced ? 0.12 : 0.08, delay: reduced ? 0 : 0.04, ease: "easeIn" } }}
      >
        {children}
      </motion.div>
    );
  },
);

/**
 * Tile arrival each time the panel is revealed: hidden at once, then spring in from the right after
 * `order * 45ms`. Skipped for reduced motion and for the first mount.
 */
export function useReveal(order: number, tick: number, reduced: boolean) {
  const x = useMotionValue(0);
  const opacity = useMotionValue(1);
  useEffect(() => {
    if (tick === 0 || reduced) return;
    x.set(reveal.offset);
    opacity.set(0);
    const transition = { ...spring(reveal.response, reveal.damping), delay: revealDelay(order) };
    const playback = [animate(x, 0, transition), animate(opacity, 1, transition)];
    return () => {
      playback.forEach((item) => item.stop());
      x.set(0);
      opacity.set(1);
    };
  }, [tick, reduced, order, x, opacity]);
  return { x, opacity };
}

/**
 * Calls `onReveal` whenever the panel goes from hidden to shown. The native host emits
 * `panel:revealed`; without it, a hidden -> visible transition (or a focus that follows one) stands in.
 * Focus alone never counts, so clicking back into a visible panel does not replay the arrival.
 */
export function watchReveal(onReveal: () => void, hosted?: (handler: () => void) => Promise<() => void>) {
  let hiddenSince = false;
  let last = 0;
  const fire = () => {
    hiddenSince = false;
    const now = performance.now();
    if (now - last < 300) return;
    last = now;
    onReveal();
  };
  const visibility = () => {
    if (document.hidden) hiddenSince = true;
    else if (hiddenSince) fire();
  };
  const focus = () => { if (hiddenSince) fire(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", focus);
  let stopHosted: (() => void) | undefined, stopped = false;
  void hosted?.(fire).then((stop) => { if (stopped) stop(); else stopHosted = stop; }).catch(() => undefined);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("focus", focus);
    stopHosted?.();
  };
}

/**
 * The "next" task replaces itself in place: the old one leaves upwards while the new one rises from
 * below (NextCard), clipped to the card so nothing spills over the heading.
 */
export const VerticalSwap = forwardRef<HTMLDivElement, { children: ReactNode; reduced: boolean }>(
  function VerticalSwap({ children, reduced }, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        ref={ref}
        className="next-swap-item"
        inert={!present}
        aria-hidden={!present}
        initial={{ y: reduced ? 0 : "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: reduced ? 0 : "-100%", opacity: 0 }}
        transition={reduced ? { duration: 0.12 } : spring(0.42, 0.84)}
      >
        {children}
      </motion.div>
    );
  },
);
