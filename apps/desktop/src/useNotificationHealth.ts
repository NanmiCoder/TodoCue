import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DoctorReport, RuntimeEvent } from "@todocue/shared";
import { client, native, platform } from "./bridge.js";
import { describeError } from "./errors.js";
import { openSettingsFailureLabel, requestResultLabel } from "./notification.js";
import {
  autoRequestRecorded, isReminderEvent, notificationBanner, recordAutoRequest, retryResultLabel, shouldAutoRequest,
  type BannerActionType,
} from "./notificationBanner.js";
import type { NotifyInput } from "./toast.js";

/** Re-read the doctor report this often while the panel is on screen. */
export const POLL_MS = 60_000;
/** Reminder events arrive in bursts (a fire, then its status update); read once after they settle. */
const EVENT_DEBOUNCE_MS = 800;

/**
 * Keeps the panel's view of "will reminders actually reach me" fresh and runs the strip's actions.
 * Refreshes on connect, on window focus (coming back from System Settings), when the page becomes
 * visible, on reminder events and every minute while visible. The first time a never-asked
 * notifier is seen in the desktop app it asks for permission once.
 *
 * Everything reads through refs, so the long-lived listeners never act on a stale render.
 */
export function useNotificationHealth({ online, language, notify }: {
  online: boolean;
  language: string;
  notify: (input: NotifyInput) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledgedFailed, setAcknowledgedFailed] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const sessionRequested = useRef(false);
  const languageRef = useRef(language);
  languageRef.current = language;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const failedRef = useRef(0);
  failedRef.current = doctor?.reminders?.failed ?? 0;

  const refresh = useCallback(async (): Promise<DoctorReport | null> => {
    if (!onlineRef.current) return null;
    const request = ++generation.current;
    try {
      const next = await client.doctor();
      if (alive.current && request === generation.current) setDoctor(next);
      return next;
    } catch {
      // The strip is a hint; when the report cannot be read the last one stays and Settings reports it.
      return null;
    }
  }, []);

  const askOnce = useCallback(async (report: DoctorReport) => {
    if (!native || !onlineRef.current) return;
    const home = report.home;
    if (!shouldAutoRequest(report, { alreadyRequested: autoRequestRecorded(home), sessionRequested: sessionRequested.current })) return;
    // Mark first: if the request throws or the app quits mid-prompt, it must not prompt again.
    sessionRequested.current = true;
    recordAutoRequest(home);
    try {
      const result = await client.requestNotificationAuthorization();
      if (result.requeued > 0) notifyRef.current({ message: requestResultLabel(result, platform, languageRef.current) });
    } catch {
      // The strip offers "允许通知" if this did not take.
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; };
  }, []);

  useEffect(() => {
    if (!online) return;
    void refresh().then(report => { if (report && alive.current) void askOnce(report); });
  }, [online, refresh, askOnce]);

  useEffect(() => {
    const update = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(update, POLL_MS);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      clearInterval(timer);
    };
  }, [refresh]);

  const eventTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(eventTimer.current), []);
  const onEvent = useCallback((event: RuntimeEvent) => {
    if (!isReminderEvent(event) || eventTimer.current) return;
    eventTimer.current = setTimeout(() => {
      eventTimer.current = undefined;
      void refresh();
    }, EVENT_DEBOUNCE_MS);
  }, [refresh]);

  const banner = useMemo(
    () => (online ? notificationBanner(doctor, { platform, language, acknowledgedFailed }) : null),
    [online, doctor, language, acknowledgedFailed],
  );

  const run = useCallback(async (type: BannerActionType) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const lang = languageRef.current;
    try {
      if (type === "request") {
        const result = await client.requestNotificationAuthorization();
        const denied = result.authorization === "denied" || result.needsSystemSettings;
        notifyRef.current({ message: requestResultLabel(result, platform, lang), kind: denied ? "error" : "info" });
      } else if (type === "openSettings") {
        // Opening the system window is its own feedback; only a failure needs words.
        const { ok } = await client.openNotificationSettings();
        if (!ok) notifyRef.current({ message: openSettingsFailureLabel(platform, lang), kind: "error" });
      } else {
        const { requeued } = await client.retryFailedReminders();
        // The runtime only re-sends the last 24 hours; older failures would otherwise nag forever.
        if (requeued === 0) setAcknowledgedFailed(failedRef.current);
        notifyRef.current({ message: retryResultLabel(requeued, lang) });
      }
    } catch (error) {
      notifyRef.current({ message: describeError(error, lang), kind: "error" });
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
      void refresh();
    }
  }, [refresh]);

  return { banner, busy, run, onEvent, refresh };
}
