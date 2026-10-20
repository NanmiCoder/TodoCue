"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowTopRightIcon, ReloadIcon, TrashIcon } from "@radix-ui/react-icons";
import { focusPanel, loadAppleSync, onAppleSync, sendAppleSync, type AppleSyncKind, type AppleSyncSnapshot } from "./bridge.js";
import { anyEnabled, appleSyncKinds, channelNotice, channelTitle, explanation, hostErrorText, recommendation, removalText, statusLine, unavailableText } from "./appleSync.js";
import { clockTime } from "./dates.js";
import { describeError } from "./errors.js";
import { hintClass, SettingsButton, SettingsIntro, SettingSwitch } from "./SettingsControls.js";

/**
 * The SwiftUI app's "Apple Calendar & Reminders" section, as a settings tab of the shared app
 * (macOS only). Everything it shows comes from the TodoCueAppleSync helper through the host.
 */
export function AppleSyncSettings({ language }: { language: "zh-CN" | "en" }) {
  const text = (zh: string, en: string) => language === "en" ? en : zh;
  const [snapshot, setSnapshot] = useState<AppleSyncSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AppleSyncKind | null>(null);
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  const cancelRemoval = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    alive.current = true;
    let stop: (() => void) | undefined;
    void onAppleSync(next => { if (alive.current) setSnapshot(next); }).then(unlisten => {
      if (alive.current) stop = unlisten; else unlisten();
    });
    void loadAppleSync().then(next => { if (alive.current) setSnapshot(next); }, () => {
      if (alive.current) setSnapshot({ available: false, running: false, status: null });
    });
    return () => { alive.current = false; stop?.(); };
  }, []);

  const running = !!snapshot?.running;
  // The panel rarely activates the app, so a permission granted in System Settings is not noticed
  // on its own. Re-read it while this tab is on screen, as the SwiftUI settings did.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void sendAppleSync({ command: "refreshAccess" }).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running]);

  // A layer in the Esc chain: the removal question closes before the settings page does.
  useEffect(() => {
    if (!pendingRemoval) return;
    cancelRemoval.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPendingRemoval(null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [pendingRemoval]);

  async function run(action: () => Promise<string | null | void>) {
    setWorking(true);
    setMessage(null);
    try {
      const result = await action();
      if (alive.current && result) setMessage(result);
    } catch (error) {
      if (alive.current) setMessage(hostErrorText(describeError(error, language), language));
    } finally {
      if (alive.current) setWorking(false);
    }
  }

  const status = snapshot?.status ?? null;
  const unavailable = unavailableText(snapshot, language);
  const intro = <SettingsIntro title={text("在 iPhone 上也看得到", "On your iPhone too")}>
    {text("经 Apple 日历与提醒事项，把待办带到手机上。", "Carry your tasks to your phone through Apple Calendar and Reminders.")}
  </SettingsIntro>;
  if (unavailable || !status) return <>{intro}<p role="status" className={hintClass}>{unavailable}</p></>;

  const advice = recommendation(status, language);
  const line = statusLine(status, language, instant => clockTime(instant, Intl.DateTimeFormat().resolvedOptions().timeZone, language));
  const removal = removalText(language);
  return <>
    {intro}
    <fieldset aria-busy={working} className="settings-fields tw:grid tw:gap-5">
      <legend className="sr-only">{text("Apple 日历与提醒事项", "Apple Calendar & Reminders")}</legend>
      {appleSyncKinds.map(kind => {
        const channel = status[kind];
        const notice = channelNotice(kind, channel, language);
        return <div key={kind} className="tw:grid tw:gap-2.5">
          <SettingSwitch label={channelTitle(kind, language)} checked={channel.enabled}
            disabled={channel.changing || working}
            onChange={enabled => void run(async () => {
              // A permission prompt behind other windows goes unseen; bring TodoCue forward first.
              if (enabled) await focusPanel().catch(() => {});
              return sendAppleSync({ command: "setEnabled", kind, enabled });
            })} />
          {channel.changing && <p role="status" className={hintClass}>{text("正在处理…", "Working…")}</p>}
          {notice?.kind === "writeOnly" && <p className={`${hintClass} tw:text-(--s-accent)!`}>{notice.text}</p>}
          {notice?.kind === "needsAccess" && <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
            <p className={`${hintClass} tw:text-(--s-accent)!`}>{notice.text}</p>
            <SettingsButton className="tw:shrink-0" disabled={working || channel.changing}
              onClick={() => void run(async () => {
                await focusPanel().catch(() => {});
                // Turning an enabled channel on again asks macOS for full access.
                return sendAppleSync({ command: "setEnabled", kind, enabled: true });
              })}>
              {text("授权访问", "Grant access")}
            </SettingsButton>
          </div>}
          {notice?.kind === "denied" && <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
            <p className={`${hintClass} tw:text-(--s-accent)!`}>{notice.text}</p>
            <SettingsButton className="tw:shrink-0" disabled={working}
              onClick={() => void run(() => sendAppleSync({ command: "openPrivacySettings", kind }))}>
              {text("打开系统设置", "Open System Settings")}<ArrowTopRightIcon />
            </SettingsButton>
          </div>}
          {notice?.kind === "container" && <div className="tw:grid tw:gap-2">
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
              <p className={`${hintClass} tw:min-w-0 tw:break-words`}>{notice.text}</p>
              <SettingsButton className="tw:shrink-0" disabled={working || channel.changing}
                onClick={() => setPendingRemoval(kind)}>
                <TrashIcon />{text("移除同步数据", "Remove synced data")}
              </SettingsButton>
            </div>
            {notice.warning && <p className={`${hintClass} tw:text-(--s-accent)!`}>{notice.warning}</p>}
          </div>}
        </div>;
      })}
      <div className="tw:border-t tw:border-(--s-line)" />
      <p className={hintClass}>{explanation(language)}</p>
      <p className={`${hintClass} ${advice.warning ? "tw:text-(--s-accent)!" : ""}`}>{advice.text}</p>
      {anyEnabled(status) && <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
        <p role="status" className={`${hintClass} tw:min-w-0 tw:break-words ${line.error ? "tw:text-(--s-accent)!" : ""}`}>{line.text}</p>
        <SettingsButton className="tw:shrink-0" disabled={status.syncing || working}
          onClick={() => void run(() => sendAppleSync({ command: "syncNow" }).then(() => null))}>
          <ReloadIcon />{text("立即同步", "Sync now")}
        </SettingsButton>
      </div>}
    </fieldset>
    {message && <p role="alert" className="settings-feedback tw:mt-4">{message}</p>}
    {pendingRemoval && <div role="alertdialog" aria-label={removal.title}
      className="tw:mt-5 tw:grid tw:gap-3 tw:rounded-xl tw:border tw:border-(--s-line) tw:bg-(--s-fill) tw:p-4">
      <h3 className="tw:text-sm tw:font-semibold">{removal.title}</h3>
      <p className={hintClass}>{removal.body}</p>
      <div className="tw:flex tw:justify-end tw:gap-2">
        <SettingsButton ref={cancelRemoval} onClick={() => setPendingRemoval(null)}>{removal.cancel}</SettingsButton>
        <SettingsButton primary disabled={working} onClick={() => {
          const kind = pendingRemoval;
          setPendingRemoval(null);
          void run(() => sendAppleSync({ command: "removeData", kind }));
        }}>{removal.confirm}</SettingsButton>
      </div>
    </div>}
  </>;
}
