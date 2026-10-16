import { useCallback, useEffect, useRef, useState } from "react";
import type { DoctorReport } from "@todocue/shared";
import {
  copyText,
  loadNotificationStatus,
  native,
  openDataFolder,
  openNotificationSettings,
  requestNotificationPermission,
  saveSettings,
  sendTestNotification,
  focusPanel,
  type DesktopSettings,
  type NotificationStatus,
} from "./bridge.js";
import { describeError } from "./errors.js";
import { formatShortcut } from "./platform.js";
import { translate } from "./i18n.js";

/** Preferences, notification health, data location and diagnostics. */
export function SettingsPage({
  settings,
  setSettings,
  online,
  onError,
  onReconnect,
}: {
  settings: DesktopSettings;
  setSettings: (settings: DesktopSettings) => void;
  online: boolean;
  onError: (message: string) => void;
  onReconnect: () => Promise<void>;
}) {
  const language = settings.language;
  const en = language === "en";
  const text = (zh: string, english: string) => (en ? english : zh);
  const t = translate(language);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<(NotificationStatus & { doctor: DoctorReport }) | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const diagnose = useCallback(async () => {
    try {
      const next = await loadNotificationStatus(language);
      if (alive.current) {
        setStatus(next);
        setStatusFailed(false);
      }
    } catch {
      if (alive.current) setStatusFailed(true);
    }
  }, [language]);
  useEffect(() => {
    if (online) void diagnose();
  }, [online, diagnose]);
  // The notification switch can only be flipped in the system settings: re-read it when the
  // person comes back, or the page keeps saying "denied" and the fix looks like it did nothing.
  useEffect(() => {
    const refocus = () => {
      if (online) void diagnose();
    };
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [online, diagnose]);
  async function perform(action: () => Promise<string | void>) {
    if (working) return;
    setWorking(true);
    setMessage(null);
    try {
      const result = await action();
      if (result && alive.current) setMessage(result);
      await diagnose();
    } catch (error) {
      if (alive.current) setMessage(describeError(error, language));
    } finally {
      if (alive.current) setWorking(false);
    }
  }
  function persist(next: DesktopSettings, optimistic: boolean) {
    if (optimistic) setSettings(next);
    void saveSettings(next)
      .then(() => {
        if (!optimistic) setSettings(next);
      })
      .catch((error) => onError(String(error)));
  }
  const doctor = status?.doctor;
  const dataPath = doctor?.home ?? "";
  return (
    <section className="tile frost editor settings-page">
      <label>
        {t("language")}
        <select
          value={language}
          onChange={(event) => persist({ ...settings, language: event.target.value as DesktopSettings["language"] }, true)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        {t("width")}
        <input
          type="range"
          min="300"
          max="600"
          value={settings.width}
          onChange={(event) => persist({ ...settings, width: Number(event.target.value) }, true)}
        />
        <output>{settings.width}</output>
      </label>
      {(["notchEnabled", "quietFullscreen"] as const).map((key) => (
        <label key={key}>
          {t(key === "notchEnabled" ? "notch" : "quiet")}
          <input
            type="checkbox"
            checked={settings[key]}
            onChange={(event) => persist({ ...settings, [key]: event.target.checked }, true)}
          />
        </label>
      ))}
      <label>
        {text("全局快捷键", "Global shortcut")}
        <button
          className="shortcut-recorder pill secondary"
          onClick={(event) => {
            event.currentTarget.focus();
            void focusPanel().catch((error) => onError(String(error)));
            setRecording((value) => !value);
          }}
          onBlur={() => setRecording(false)}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              setRecording(false);
              return;
            }
            if (!["Meta", "Control", "Alt", "Shift"].includes(event.key) && (event.metaKey || event.ctrlKey || event.altKey)) {
              const shortcut = [
                event.metaKey ? "Super" : null,
                event.ctrlKey ? "Control" : null,
                event.altKey ? "Alt" : null,
                event.shiftKey ? "Shift" : null,
                event.code,
              ]
                .filter(Boolean)
                .join("+");
              setRecording(false);
              persist({ ...settings, shortcut }, false);
            }
          }}
        >
          {recording
            ? text("按下快捷键…", "Press a shortcut…")
            : settings.shortcut
              ? formatShortcut(settings.shortcut)
              : text("录制快捷键", "Record shortcut")}
        </button>
        {settings.shortcut && (
          <button className="text-button" onClick={() => persist({ ...settings, shortcut: null }, false)}>
            {text("清除", "Clear")}
          </button>
        )}
      </label>
      <p className="settings-hint">{text("从任何 App 唤出或收起 TodoCue。", "Show or hide TodoCue from any app.")}</p>
      <label>
        {text("登录时启动", "Open at login")}
        <input
          type="checkbox"
          checked={settings.autostart}
          disabled={!native}
          onChange={(event) => persist({ ...settings, autostart: event.target.checked }, false)}
        />
      </label>

      <section className="settings-group" aria-label={text("提醒通知", "Reminder notifications")}>
        <h3>{text("提醒通知", "Reminder notifications")}</h3>
        <p className={`settings-state state-${status?.state ?? "unknown"}`} role="status">
          <strong>
            {status
              ? { granted: text("已允许", "Allowed"), denied: text("被关闭", "Blocked"), unknown: text("未知", "Unknown"), unsupported: text("不可用", "Unavailable") }[status.state]
              : statusFailed
                ? text("读取失败", "Could not read")
                : text("读取中…", "Reading…")}
          </strong>
          {status && <span>{status.reason}</span>}
        </p>
        <div className="settings-actions">
          {status?.actions.request && (
            <button className="pill" disabled={!online || working} onClick={() => void perform(() => requestNotificationPermission(language))}>
              {text("请求授权", "Request permission")}
            </button>
          )}
          {(status?.actions.openSettings ?? true) && (
            <button className="pill secondary" disabled={!online || working} onClick={() => void perform(() => openNotificationSettings(language))}>
              {t("notifySettings")}
            </button>
          )}
          <button className="pill secondary" disabled={!online || working || status?.actions.test === false} onClick={() => void perform(() => sendTestNotification(language))}>
            {t("notify")}
          </button>
        </div>
        {message && (
          <p className="settings-message" role="status">
            {message}
          </p>
        )}
      </section>

      <section className="settings-group" aria-label={text("你的数据", "Your data")}>
        <h3>{text("你的数据", "Your data")}</h3>
        <p className="settings-hint">{text("保存在这台电脑上，卸载或重装 App 后任务仍会保留。", "Stored on this computer. Tasks stay after you remove or reinstall the app.")}</p>
        {dataPath ? (
          <code className="settings-path">{dataPath}</code>
        ) : (
          <p className="settings-hint">{online ? text("读取中…", "Reading…") : text("连接后显示数据位置", "The location shows once connected")}</p>
        )}
        {dataPath && (
          <div className="settings-actions">
            <button
              className="pill secondary"
              disabled={working}
              onClick={() =>
                void perform(async () => {
                  const { opened } = await openDataFolder(dataPath);
                  if (opened) return;
                  return (await copyText(dataPath))
                    ? text("这个版本还不能直接打开文件夹，路径已复制", "Cannot open folders from here yet. The path was copied.")
                    : text("这个版本还不能直接打开文件夹，请手动复制上面的路径", "Cannot open folders from here yet. Copy the path above.");
                })
              }
            >
              {native ? text("打开数据文件夹", "Open data folder") : text("复制路径", "Copy path")}
            </button>
          </div>
        )}
      </section>

      <details className="settings-group settings-diagnostics">
        <summary>{text("连接与诊断", "Connection & diagnostics")}</summary>
        <dl>
          <dt>{text("状态", "Status")}</dt>
          <dd>{online ? text("已连接", "Connected") : text("未连接", "Offline")}</dd>
          <dt>{text("地址", "Address")}</dt>
          <dd>{doctor?.baseUrl ?? "—"}</dd>
          {doctor && (
            <>
              <dt>{text("任务", "Tasks")}</dt>
              <dd>{text(`${doctor.counts.todo} 待办 / ${doctor.counts.tasks} 总计`, `${doctor.counts.todo} to do / ${doctor.counts.tasks} total`)}</dd>
              <dt>{text("提醒", "Reminders")}</dt>
              <dd>{text(`${doctor.counts.pendingReminders} 待发送 / ${doctor.counts.failedReminders} 失败`, `${doctor.counts.pendingReminders} pending / ${doctor.counts.failedReminders} failed`)}</dd>
              <dt>{text("时区", "Timezone")}</dt>
              <dd>{doctor.timezone}</dd>
            </>
          )}
        </dl>
        <div className="settings-actions">
          <button className="pill secondary" onClick={() => void onReconnect().then(diagnose)}>
            {text("重新连接", "Reconnect")}
          </button>
          <button className="pill secondary" disabled={!online} onClick={() => void diagnose()}>
            {text("重新诊断", "Run diagnostics")}
          </button>
        </div>
        {doctor?.checks.map((check) => (
          <p key={check.name} className={`settings-check ${check.ok ? "ok" : "warn"}`}>
            {check.ok ? "✓" : "!"} {check.name}：{check.detail}
          </p>
        ))}
      </details>
      <p className="settings-version">
        TodoCue · {doctor ? `v${doctor.runtimeVersion}` : text("版本读取中", "version unknown")}
      </p>
    </section>
  );
}
