"use client";

import { useEffect, useState } from "react";
import { RadioGroup } from "radix-ui";
import { motion } from "motion/react";
import { CursorArrowIcon, DesktopIcon } from "@radix-ui/react-icons";
import { loadNotchDisplays, native, type DesktopSettings, type NotchDisplay } from "./bridge.js";
import { hintClass, SettingField, SettingSelect, SettingSwitch, SettingsIntro } from "./SettingsControls.js";
import { useReducedMotion } from "./useReducedMotion.js";

function DisplayPreview({ placement, enabled, hasNotch, en }: {
  placement: DesktopSettings["notchPlacement"]; enabled: boolean; hasNotch: boolean; en: boolean;
}) {
  const reduced = useReducedMotion();
  return <div className="settings-display-preview tw:relative tw:mb-4 tw:aspect-[1.8] tw:overflow-hidden tw:rounded-xl tw:border tw:border-(--s-line)" aria-hidden="true">
    <div className="tw:absolute tw:inset-x-0 tw:top-0 tw:flex tw:h-5 tw:items-center tw:justify-between tw:border-b tw:border-(--s-line) tw:bg-(--s-surface) tw:px-2.5 tw:text-[7px] tw:text-(--s-muted)"><span>{en ? "Menu bar" : "系统菜单栏"}</span><span className="tw:flex tw:gap-1"><i className="tw:size-1 tw:rounded-full tw:bg-(--s-muted)" /><i className="tw:size-1 tw:rounded-full tw:bg-(--s-muted)" /></span></div>
    {hasNotch && <div className="tw:absolute tw:top-0 tw:left-1/2 tw:h-3 tw:w-11 tw:-translate-x-1/2 tw:rounded-b-md tw:bg-[#252526]" />}
    <div className="tw:absolute tw:top-[38%] tw:left-[23%] tw:h-[48%] tw:w-[55%] tw:rounded-md tw:border tw:border-(--s-line) tw:bg-(--s-surface) tw:p-2.5">
      <div className="tw:mb-2 tw:h-1 tw:w-9 tw:rounded-full tw:bg-(--s-line)" />
      <div className="tw:mb-1.5 tw:h-1 tw:w-full tw:rounded-full tw:bg-(--s-line) tw:opacity-60" />
      <div className="tw:h-1 tw:w-2/3 tw:rounded-full tw:bg-(--s-line) tw:opacity-60" />
    </div>
    <motion.div layout={!reduced} transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className={`settings-preview-notch preview-${placement} ${hasNotch ? "has-camera" : ""} ${enabled ? "" : "is-off"}`}>
      <span className="tw:size-1 tw:rounded-full tw:bg-[#d49b80]" /><span className="tw:h-0.5 tw:w-3 tw:rounded-full tw:bg-white/70" />
    </motion.div>
  </div>;
}

export function NotchPreferences({ settings, disabled, onChange }: {
  settings: DesktopSettings; disabled: boolean; onChange: (patch: Partial<DesktopSettings>) => Promise<void>;
}) {
  const en = settings.language === "en";
  const t = (zh: string, english: string) => en ? english : zh;
  const [displays, setDisplays] = useState<NotchDisplay[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let ended = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const connected = await loadNotchDisplays();
        if (!ended) { setDisplays(connected); setStatus("ready"); }
      } catch { if (!ended) setStatus("error"); }
      finally { reading = false; }
    };
    void refresh();
    const timer = native ? setInterval(() => void refresh(), 2000) : undefined;
    window.addEventListener("focus", refresh);
    return () => { ended = true; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const selected = displays.find(d => d.id === settings.notchDisplay?.id);
  const missing = settings.notchDisplay && status === "ready" && !selected;
  const options = [
    { value: "follow", label: t("跟随鼠标所在屏幕", "Follow pointer"), detail: t("自动在屏幕之间切换", "Move between displays automatically") },
    ...(settings.notchDisplay && !selected ? [{ value: settings.notchDisplay.id, label: settings.notchDisplay.name, detail: missing ? t("未连接 · 暂用主屏", "Disconnected · using main display") : t("正在检测…", "Detecting…") }] : []),
    ...displays.map((d, i) => ({ value: d.id, label: `${i + 1}. ${d.name}`, detail: `${d.width} × ${d.height}${d.primary ? t(" · 主屏", " · Main") : ""}${d.hasNotch ? t(" · 内置刘海", " · Camera notch") : ""}` })),
  ];
  const locked = disabled || !settings.notchEnabled;
  return <>
    <SettingsIntro title={t("轻巧地，留在视线里", "A little presence")}>{t("悬停看今天，提醒时展开。选择最适合你的屏幕和位置。", "Hover for today. Open for a reminder. Find its place on your screen.")}</SettingsIntro>
    <div className="tw:mb-5"><SettingSwitch label={t("显示刘海", "Show notch")} checked={settings.notchEnabled} disabled={disabled} onChange={notchEnabled => void onChange({ notchEnabled })} /></div>
    <DisplayPreview placement={settings.notchPlacement} enabled={settings.notchEnabled} hasNotch={(selected ?? displays.find(d => d.primary))?.hasNotch ?? false} en={en} />
    <fieldset disabled={locked} className="settings-fields tw:grid tw:gap-5">
      <legend className="sr-only">{t("刘海位置与屏幕", "Notch position and screen")}</legend>
      <SettingField label={t("停靠位置", "Dock position")} hint={settings.notchPlacement === "top"
        ? t("贴住摄像头两侧，每侧仅留 22 点显示图标和数量，尽量给菜单栏留空间。", "Just 22 pt on each side of the camera for the icon and count, leaving more room for the menu bar.")
        : t("贴边向内展开，把顶部空间留给其他 App。", "Opens inward from the edge, leaving the top clear.")}>
        {id => <RadioGroup.Root id={id} aria-labelledby={`${id}-label`} value={settings.notchPlacement} disabled={locked}
          onValueChange={value => void onChange({ notchPlacement: value as DesktopSettings["notchPlacement"] })}
          className="tw:flex tw:gap-1 tw:rounded-xl tw:bg-(--s-fill) tw:p-1">
          {([["left", t("左侧", "Left")], ["top", t("顶部", "Top")], ["right", t("右侧", "Right")]] as const).map(([value, label]) => <RadioGroup.Item key={value} value={value} className="settings-segment tw:flex-1 tw:rounded-lg tw:px-2 tw:py-2 tw:text-[11px] tw:font-medium">{label}</RadioGroup.Item>)}
        </RadioGroup.Root>}
      </SettingField>
      <SettingField label={t("显示屏幕", "Display")}>
        {id => <SettingSelect id={id} value={settings.notchDisplay?.id ?? "follow"} options={options} disabled={locked || !native || status !== "ready"} onChange={value => {
          const display = displays.find(d => d.id === value);
          void onChange({ notchDisplay: display ? { id: display.id, name: display.name } : null });
        }} />}
      </SettingField>
      <div className={`tw:-mt-3 tw:flex tw:items-start tw:gap-2 ${hintClass}`} role="status">
        {settings.notchDisplay ? <DesktopIcon className="tw:mt-0.5 tw:shrink-0" /> : <CursorArrowIcon className="tw:mt-0.5 tw:shrink-0" />}
        <p>{!native ? t("在桌面 App 中自动检测已连接的屏幕。", "Connected displays are detected in the desktop app.")
          : status === "error" ? t("暂时无法读取屏幕，正在重试…", "Could not read displays. Retrying…")
          : status === "loading" ? t("正在检测连接的屏幕…", "Detecting connected displays…")
          : missing ? t("这块屏幕已断开，暂用主屏；重新连接后自动恢复。", "Using the main display until this screen reconnects.")
          : settings.notchDisplay ? t("固定在此屏幕。断开时暂用主屏，重连后恢复。", "Pinned here. Falls back to the main display until reconnected.")
          : t("跟随鼠标换屏，快览展开时保持原位。", "Follows your pointer; stays put while the quick look is open.")}</p>
      </div>
      <div className="tw:border-t tw:border-(--s-line)" />
      <SettingSwitch label={t("全屏时安静", "Quiet in fullscreen")} hint={t("当前屏幕有全屏 App 时，暂时隐藏刘海。", "Hide the notch while an app is fullscreen on its display.")} checked={settings.quietFullscreen} disabled={locked} onChange={quietFullscreen => void onChange({ quietFullscreen })} />
    </fieldset>
  </>;
}
