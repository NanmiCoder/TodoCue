import type { DesktopSettings } from "./bridge.js";

/** Coalesce edits during a write, then merge them onto the last confirmed settings. */
export function createSettingsWriter({ read, save, saved, busy, failed }: {
  read: () => DesktopSettings;
  save: (settings: DesktopSettings) => Promise<void>;
  saved: (settings: DesktopSettings) => void;
  busy: (value: boolean) => void;
  failed: (error: unknown) => void;
}) {
  let pending: Partial<DesktopSettings> | undefined;
  let writing: Promise<void> | undefined;
  return (patch: Partial<DesktopSettings>): Promise<void> => {
    pending = { ...pending, ...patch };
    if (writing) return writing;
    busy(true);
    writing = (async () => {
      // Publish the shared promise before invoking callbacks (including synchronous failures).
      await Promise.resolve();
      try {
        while (pending) {
          const next = { ...read(), ...pending };
          pending = undefined;
          try {
            await save(next);
            saved(next);
          } catch (error) {
            failed(error);
          }
        }
      } finally {
        writing = undefined;
        busy(false);
      }
    })();
    return writing;
  };
}
