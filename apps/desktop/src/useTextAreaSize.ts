import { useLayoutEffect, type RefObject } from "react";

/** Match SwiftUI's expanding text fields, with a bounded number of visible lines. */
export function useTextAreaSize(ref: RefObject<HTMLTextAreaElement | null>, value: string, minRows = 2, maxRows = 6) {
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let active = true;
    const resize = () => {
      if (!active) return;
      const style = getComputedStyle(input);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      const inset = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const min = line * minRows + inset;
      const max = line * maxRows + inset;
      input.style.minHeight = `${min}px`;
      input.style.maxHeight = `${max}px`;
      input.style.height = "auto";
      input.style.height = `${Math.min(max, Math.max(min, input.scrollHeight))}px`;
      input.style.overflowY = input.scrollHeight > max + 1 ? "auto" : "hidden";
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    void document.fonts.ready.then(resize);
    return () => { active = false; observer.disconnect(); };
  }, [ref, value, minRows, maxRows]);
}
