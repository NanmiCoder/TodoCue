"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { BellIcon, MixerHorizontalIcon, DesktopIcon, ArchiveIcon, CheckIcon, ArrowTopRightIcon, ReloadIcon, CopyIcon, ChevronRightIcon, ExclamationTriangleIcon, CalendarIcon } from "@radix-ui/react-icons";
import type { DoctorReport } from "@todocue/shared";
import {
  copyText, loadNotificationStatus, native, openDataFolder, openNotificationSettings,
  requestNotificationPermission, saveSettings, sendTestNotification, focusPanel,
  type DesktopSettings, type NotificationStatus,
} from "./bridge.js";
import { NotchPreferences } from "./NotchPreferences.js";
import { AppleSyncSettings } from "./AppleSyncSettings.js";
import { describeError } from "./errors.js";
import { formatShortcut, platform } from "./platform.js";
import { createSettingsWriter } from "./settingsWriter.js";
import { hintClass, SettingField, SettingSelect, SettingSwitch, SettingsButton, SettingsIntro, SettingsTransition, WidthSlider } from "./SettingsControls.js";
import "./settings.css";

type SettingsStatus = NotificationStatus & { doctor: DoctorReport };

export function SettingsPage({ settings, setSettings, online, onError, onReconnect }: {
  settings: DesktopSettings;
  setSettings: (settings: DesktopSettings) => void;
  online: boolean;
  onError: (message: string) => void;
  onReconnect: () => Promise<void>;
}) {
  const language = settings.language;
  const en = language === "en";
  const text = (zh: string, english: string) => en ? english : zh;
  const [tab, setTab] = useState("general");
  const contentRef = useRef<HTMLDivElement>(null);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const workingRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const alive = useRef(true);
  const diagnosis = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; diagnosis.current++; };
  }, []);
  const diagnose = useCallback(async () => {
    const request = ++diagnosis.current;
    try {
      const next = await loadNotificationStatus(language);
      if (alive.current && request === diagnosis.current) { setStatus(next); setStatusFailed(false); }
      return true;
    } catch {
      if (alive.current && request === diagnosis.current) setStatusFailed(true);
      return false;
    }
  }, [language]);
  useEffect(() => { if (online) void diagnose(); }, [online, diagnose]);
  useEffect(() => {
    const refocus = () => { if (online) void diagnose(); };
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [online, diagnose]);

  async function runDiagnostics() {
    if (!(await diagnose())) throw new Error(text("诊断读取失败，请重试。", "Diagnostics failed. Please try again."));
  }

  async function perform(action: () => Promise<string | void>) {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    setMessage(null);
    try {
      const result = await action();
      if (alive.current) setMessage({ text: result || text("已完成", "Done"), error: false });
      await diagnose();
    } catch (error) {
      if (alive.current) setMessage({ text: describeError(error, language), error: true });
    } finally {
      workingRef.current = false;
      if (alive.current) setWorking(false);
    }
  }
  const writer = useRef<ReturnType<typeof createSettingsWriter> | null>(null);
  const saveFailure = useRef((error: unknown) => {});
  saveFailure.current = error => {
    if (alive.current) setSaveError(describeError(error, language));
  };
  if (!writer.current) writer.current = createSettingsWriter({
    read: () => settingsRef.current,
    save: saveSettings,
    saved: next => {
      settingsRef.current = next;
      setSettings(next);
      if (alive.current) setSaveError(null);
    },
    busy: value => { if (alive.current) setSaving(value); },
    failed: error => saveFailure.current(error),
  });
  function persist(patch: Partial<DesktopSettings>) {
    setSaveError(null);
    return writer.current!(patch);
  }
  const doctor = status?.doctor;
  const dataPath = doctor?.home ?? "";
  const sections = [
    { id: "general", label: text("通用", "General"), icon: MixerHorizontalIcon },
    { id: "notch", label: text("刘海", "Notch"), icon: DesktopIcon },
    { id: "notifications", label: text("通知", "Alerts"), icon: BellIcon },
    // Apple Calendar / Reminders sync exists only on macOS (EventKit, via the host's helper).
    ...(platform === "macos" ? [{ id: "sync", label: text("同步", "Sync"), icon: CalendarIcon }] : []),
    { id: "data", label: text("数据", "Data"), icon: ArchiveIcon },
  ];
  return <section className="settings-theme settings-page tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-hidden" aria-label={text("偏好设置", "Preferences")}>
    <Tabs.Root value={tab} onValueChange={value => {
      setTab(value); setRecording(false); setMessage(null);
      if (contentRef.current) contentRef.current.scrollTop = 0;
    }} className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      <Tabs.List aria-label={text("设置分类", "Settings categories")} className={`settings-tabs tw:mx-4 tw:mt-1 tw:grid ${sections.length > 4 ? "tw:grid-cols-5" : "tw:grid-cols-4"} tw:gap-1 tw:border-b tw:border-(--s-line)`}>
        {sections.map(({ id, label, icon: Icon }) => <Tabs.Trigger key={id} value={id} className="settings-tab tw:flex tw:flex-col tw:items-center tw:gap-1.5 tw:px-1 tw:pt-3 tw:pb-3.5 tw:text-[10px] tw:font-medium"><Icon width={17} height={17} /><span>{label}</span></Tabs.Trigger>)}
      </Tabs.List>
      <div ref={contentRef} className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:overscroll-contain tw:px-5 tw:py-6">
        {saveError && <p role="alert" className="settings-feedback tw:mb-4">{saveError}</p>}
        <Tabs.Content value="general" className="settings-tab-content">
          <SettingsTransition>
            <SettingsIntro title={text("让它顺手一点", "Make it yours")}>{text("熟悉的语言，合适的尺寸，随时唤出。", "Your language, your space. Always within reach.")}</SettingsIntro>
            <fieldset aria-busy={saving} className="settings-fields tw:grid tw:gap-6">
              <legend className="sr-only">{text("通用设置", "General settings")}</legend>
              <SettingField label={text("界面语言", "Language")}>
                {id => <SettingSelect id={id} value={language} disabled={saving} options={[{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]} onChange={value => void persist({ language: value as DesktopSettings["language"] })} />}
              </SettingField>
              <WidthSlider value={settings.width} en={en} saving={saving} onCommit={width => void persist({ width })} />
              <div className="tw:border-t tw:border-(--s-line)" />
              <SettingField label={text("全局快捷键", "Global shortcut")} hint={recording ? text("按下组合键，Esc 取消。", "Press a key combination. Esc cancels.") : text("从任何 App 唤出或收起 TodoCue。", "Show or hide TodoCue from any app.")}>
                {id => <div className="tw:flex tw:items-center tw:gap-2">
                  <SettingsButton id={id} aria-describedby={`${id}-hint`} disabled={saving} className={`tw:min-h-10 tw:flex-1 ${recording ? "is-recording" : ""}`}
                    aria-label={recording ? text("正在录制快捷键", "Listening for a shortcut") : settings.shortcut ? `${text("全局快捷键", "Global shortcut")}: ${formatShortcut(settings.shortcut)}` : text("录制快捷键", "Record shortcut")}
                    onClick={event => {
                      event.currentTarget.focus();
                      void focusPanel().catch(error => onError(String(error)));
                      setRecording(value => !value);
                    }} onBlur={() => setRecording(false)} onKeyDown={event => {
                      if (!recording) return;
                      event.preventDefault(); event.stopPropagation();
                      if (event.key === "Escape") { setRecording(false); return; }
                      if (!["Meta", "Control", "Alt", "Shift"].includes(event.key) && (event.metaKey || event.ctrlKey || event.altKey)) {
                        const shortcut = [event.metaKey ? "Super" : null, event.ctrlKey ? "Control" : null, event.altKey ? "Alt" : null, event.shiftKey ? "Shift" : null, event.code].filter(Boolean).join("+");
                        setRecording(false); void persist({ shortcut });
                      }
                    }}>
                    <span className="tw:font-mono tw:break-all">{recording ? text("正在录制…", "Listening…") : settings.shortcut ? formatShortcut(settings.shortcut) : text("录制快捷键", "Record shortcut")}</span>
                  </SettingsButton>
                  {settings.shortcut && <button type="button" disabled={saving} className="tw:shrink-0 tw:px-1 tw:text-[11px] tw:text-(--s-muted)" onClick={() => void persist({ shortcut: null })}>{text("清除", "Clear")}</button>}
                </div>}
              </SettingField>
              <SettingSwitch label={text("登录时启动", "Open at login")} hint={native ? text("登录电脑后，TodoCue 自动就位。", "Ready when you sign in to your computer.") : text("在桌面 App 中设置。", "Available in the desktop app.")} checked={settings.autostart} disabled={!native || saving} onChange={autostart => void persist({ autostart })} />
            </fieldset>
          </SettingsTransition>
        </Tabs.Content>
        <Tabs.Content value="notch" className="settings-tab-content">
          <SettingsTransition><NotchPreferences settings={settings} disabled={saving} onChange={persist} /></SettingsTransition>
        </Tabs.Content>
        <Tabs.Content value="notifications" className="settings-tab-content">
          <SettingsTransition>
            <SettingsIntro title={text("该提醒时，再出现", "A timely nudge")}>{text("用系统通知，把重要的待办送到你眼前。", "Let system notifications bring your tasks to you.")}</SettingsIntro>
            <div className="tw:mb-6 tw:flex tw:items-start tw:gap-3">
              <div className="tw:grid tw:size-10 tw:shrink-0 tw:place-items-center tw:rounded-xl tw:bg-(--s-fill) tw:text-(--s-accent)"><BellIcon width={20} height={20} /></div>
              <div className="tw:min-w-0 tw:flex-1 tw:pt-0.5" role="status">
                <h3 className="tw:mb-1.5 tw:text-sm tw:font-semibold">{!online ? text("等待连接", "Waiting for connection") : statusFailed ? text("暂时无法读取", "Could not read status") : status ? { granted: text("通知已开启", "Notifications are on"), denied: text("通知已关闭", "Notifications are off"), unknown: text("等待授权", "Permission unknown"), unsupported: text("通知暂不可用", "Notifications unavailable") }[status.state] : text("正在检查…", "Checking…")}</h3>
                {!status && !statusFailed && online ? <div className="settings-skeleton tw:h-8 tw:rounded-md" /> : <p className={hintClass}>{!online ? text("重新连接后可以检查通知权限。", "Reconnect to check notification permissions.") : statusFailed ? text("请重试，或打开系统设置检查权限。", "Retry, or check permissions in system settings.") : status?.reason}</p>}
              </div>
            </div>
            <div className="tw:grid tw:gap-2">
              {status?.actions.request && <SettingsButton primary disabled={!online || working} onClick={() => void perform(() => requestNotificationPermission(language))}>{text("允许通知", "Allow notifications")}<ArrowTopRightIcon /></SettingsButton>}
              {(status?.actions.openSettings ?? true) && <SettingsButton disabled={!online || working} onClick={() => void perform(() => openNotificationSettings(language))}>{text("打开系统通知设置", "System notification settings")}<ArrowTopRightIcon /></SettingsButton>}
              <SettingsButton disabled={!online || working || !status || status.actions.test === false} onClick={() => void perform(() => sendTestNotification(language))}><BellIcon />{text("发送测试通知", "Send a test notification")}</SettingsButton>
              {statusFailed && <SettingsButton disabled={!online || working} onClick={() => void perform(runDiagnostics)}><ReloadIcon />{text("重新检查", "Check again")}</SettingsButton>}
            </div>
            <p className={`${hintClass} tw:mt-5`}>{text("专注模式或系统勿扰可能暂时隐藏通知。", "Focus or Do Not Disturb may temporarily silence notifications.")}</p>
          </SettingsTransition>
        </Tabs.Content>
        {platform === "macos" && <Tabs.Content value="sync" className="settings-tab-content">
          <SettingsTransition><AppleSyncSettings language={language} /></SettingsTransition>
        </Tabs.Content>}
        <Tabs.Content value="data" className="settings-tab-content">
          <SettingsTransition>
            <SettingsIntro title={text("你的数据，留在本机", "Yours. On this device.")}>{text("任务在本地保存，卸载或重装 App 后仍会保留。", "Tasks stay on your computer, even after you reinstall the app.")}</SettingsIntro>
            <SettingField label={text("数据位置", "Data location")}>
              {id => <div id={id} className="tw:grid tw:gap-3">
                {dataPath ? <code className="tw:select-text tw:break-all tw:rounded-xl tw:border tw:border-(--s-line) tw:bg-(--s-fill) tw:p-3 tw:font-mono tw:text-[11px] tw:leading-relaxed">{dataPath}</code> : <p className={hintClass}>{!online ? text("连接后显示数据位置", "Reconnect to see the location") : statusFailed ? text("读取失败，请重新诊断。", "Could not read. Run diagnostics again.") : text("正在读取…", "Reading…")}</p>}
                <SettingsButton disabled={!dataPath || working} onClick={() => void perform(async () => {
                  if (native && (await openDataFolder(dataPath)).opened) return;
                  if (!(await copyText(dataPath))) throw new Error(text("无法复制，请手动复制上面的路径。", "Could not copy. Select and copy the path above."));
                  return text("路径已复制", "Path copied");
                })}>{native ? <ArchiveIcon /> : <CopyIcon />}{native ? text("打开数据文件夹", "Open data folder") : text("复制路径", "Copy path")}</SettingsButton>
              </div>}
            </SettingField>
            <details className="settings-diagnostics tw:mt-6 tw:border-t tw:border-(--s-line) tw:pt-4">
              <summary className="tw:flex tw:cursor-pointer tw:items-center tw:justify-between tw:gap-2 tw:py-1 tw:text-xs tw:font-medium">{text("连接与诊断", "Connection & diagnostics")}<ChevronRightIcon /></summary>
              <dl className="tw:my-4 tw:grid tw:grid-cols-[auto_1fr] tw:gap-x-4 tw:gap-y-3 tw:text-[11px]">
                <dt>{text("状态", "Status")}</dt><dd>{online ? text("已连接", "Connected") : text("未连接", "Offline")}</dd>
                <dt>{text("地址", "Address")}</dt><dd>{doctor?.baseUrl ?? "—"}</dd>
                {doctor && <><dt>{text("任务", "Tasks")}</dt><dd>{text(`${doctor.counts.todo} 待办 / ${doctor.counts.tasks} 总计`, `${doctor.counts.todo} to do / ${doctor.counts.tasks} total`)}</dd><dt>{text("提醒", "Reminders")}</dt><dd>{text(`${doctor.counts.pendingReminders} 待发送 / ${doctor.counts.failedReminders} 失败`, `${doctor.counts.pendingReminders} pending / ${doctor.counts.failedReminders} failed`)}</dd><dt>{text("时区", "Timezone")}</dt><dd>{doctor.timezone}</dd></>}
              </dl>
              <div className="tw:flex tw:flex-wrap tw:gap-2">
                <SettingsButton disabled={working} onClick={() => void perform(onReconnect)}><ReloadIcon />{text("重新连接", "Reconnect")}</SettingsButton>
                <SettingsButton disabled={!online || working} onClick={() => void perform(runDiagnostics)}>{text("重新诊断", "Run diagnostics")}</SettingsButton>
              </div>
              {statusFailed && <p className={`${hintClass} tw:mt-3`}>{text("诊断读取失败，请重试。", "Diagnostics failed. Please try again.")}</p>}
              <div className="tw:mt-4 tw:grid tw:gap-3">{doctor?.checks.map(check => <p key={check.name} className={`tw:flex tw:items-start tw:gap-2 ${hintClass}`}>
                {check.ok ? <CheckIcon className="tw:mt-0.5 tw:shrink-0" /> : <ExclamationTriangleIcon className="tw:mt-0.5 tw:shrink-0 tw:text-(--s-accent)" />}<span className="tw:break-all">{check.name} · {check.detail}</span>
              </p>)}</div>
            </details>
          </SettingsTransition>
        </Tabs.Content>
        {working && <p role="status" className={`${hintClass} tw:mt-4`}>{text("正在处理…", "Working…")}</p>}
        {message && <p role={message.error ? "alert" : "status"} className="settings-feedback tw:mt-4">{message.text}</p>}
      </div>
    </Tabs.Root>
    <footer className="tw:mx-5 tw:flex tw:items-center tw:justify-between tw:gap-2 tw:border-t tw:border-(--s-line) tw:py-3 tw:text-[10px] tw:text-(--s-muted)">
      <span>TodoCue{doctor ? ` / ${doctor.runtimeVersion}` : ""}</span>
      <span role="status" className="tw:flex tw:items-center tw:gap-1">{saving ? text("正在保存…", "Saving…") : <><CheckIcon width={12} height={12} />{text("更改自动保存", "Changes save automatically")}</>}</span>
    </footer>
  </section>;
}
