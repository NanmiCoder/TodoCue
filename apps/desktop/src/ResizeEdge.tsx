import { useEffect, useRef, type PointerEvent } from "react";
import { manualPanelResize, resizePanel, resizePanelMac } from "./bridge.js";

export function ResizeEdge({
  direction,
  label,
  onReset,
  onError,
}: {
  direction: "West" | "South";
  label: string;
  onReset: () => void;
  onError: (message: string) => void;
}) {
  const origin = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    active: boolean;
  } | null>(null);
  const pending = useRef<Parameters<typeof resizePanelMac>[0] | null>(null);
  const applying = useRef(false);
  const draining = useRef<Promise<void> | null>(null);
  useEffect(
    () => () => {
      pending.current = null;
    },
    [],
  );
  async function apply() {
    if (applying.current) return;
    applying.current = true;
    let failure: unknown;
    try {
      while (pending.current) {
        const request = pending.current;
        pending.current = null;
        try {
          await resizePanelMac(request);
          failure = undefined;
        } catch (error) {
          // A final pointer-up request is still applied if an earlier frame fails.
          failure = error;
        }
      }
      if (failure !== undefined) onError(String(failure));
    } finally {
      applying.current = false;
    }
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = origin.current;
    if (!start) return;
    const distance =
      direction === "West" ? event.screenX - start.x : event.screenY - start.y;
    if (!start.active && Math.abs(distance) < 3) return;
    start.active = true;
    if (manualPanelResize) {
      pending.current = {
        direction,
        width: start.width,
        height: start.height,
        delta: distance,
      };
      if (!applying.current) draining.current = apply();
    } else {
      origin.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      void resizePanel(direction).catch((error) => onError(String(error)));
    }
  }
  return (
    <button
      className={`resize-edge resize-${direction.toLowerCase()}`}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        origin.current = {
          x: event.screenX,
          y: event.screenY,
          width: innerWidth,
          height: innerHeight,
          active: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        // Starting after movement leaves double-clicks available for resetting the size.
        if (event.buttons & 1) move(event);
      }}
      onPointerUp={(event) => {
        if (manualPanelResize) move(event);
        origin.current = null;
      }}
      onPointerCancel={() => {
        origin.current = null;
      }}
      onDoubleClick={() => {
        pending.current = null;
        // A late drag response must settle before the reset becomes the last size write.
        void (draining.current ?? Promise.resolve()).then(onReset);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pending.current = null;
          void (draining.current ?? Promise.resolve()).then(onReset);
        }
      }}
    />
  );
}
