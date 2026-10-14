import { useSyncExternalStore } from "react";

interface MediaPreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** One live OS listener, shared by every component; changing it never remounts drafts. */
export function mediaPreferenceStore(query: () => MediaPreference) {
  let media: MediaPreference | undefined;
  const listeners = new Set<() => void>();
  const getMedia = () => media ??= query();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => getMedia().matches,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) {
      if (listeners.size === 0) getMedia().addEventListener("change", notify);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) getMedia().removeEventListener("change", notify);
      };
    },
  };
}
const preference = mediaPreferenceStore(() => window.matchMedia("(prefers-reduced-motion: reduce)"));
export function useReducedMotion(): boolean {
  return useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getServerSnapshot);
}
