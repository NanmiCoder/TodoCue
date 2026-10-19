"use client";

import { useId, useState, useEffect, type ReactNode, type ButtonHTMLAttributes } from "react";
import { Select, Switch, Slider } from "radix-ui";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "@radix-ui/react-icons";
import { motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion.js";

export const hintClass = "tw:text-[11px] tw:leading-relaxed tw:text-(--s-muted)";

export function SettingField({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="tw:grid tw:gap-2">
    <label id={`${id}-label`} htmlFor={id} className="tw:text-xs tw:font-medium">{label}</label>
    {children(id)}
    {hint && <p id={`${id}-hint`} className={hintClass}>{hint}</p>}
  </div>;
}

export function SettingSwitch({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return <div className="tw:flex tw:items-start tw:justify-between tw:gap-4">
    <div className="tw:grid tw:gap-1.5">
      <label htmlFor={id} className="tw:text-xs tw:font-medium tw:cursor-pointer">{label}</label>
      {hint && <p id={`${id}-hint`} className={hintClass}>{hint}</p>}
    </div>
    <Switch.Root id={id} checked={checked} disabled={disabled} onCheckedChange={onChange}
      aria-describedby={hint ? `${id}-hint` : undefined} className="settings-switch tw:shrink-0">
      <Switch.Thumb className="settings-switch-thumb" />
    </Switch.Root>
  </div>;
}

export function SettingSelect({ id, value, options, disabled, onChange }: {
  id: string; value: string; options: { value: string; label: string; detail?: string }[];
  disabled?: boolean; onChange: (value: string) => void;
}) {
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
    <Select.Trigger id={id} aria-labelledby={`${id}-label`} className="settings-select tw:flex tw:w-full tw:items-center tw:justify-between tw:gap-3 tw:px-3 tw:py-2.5 tw:text-xs tw:text-left">
      <span className="tw:truncate"><Select.Value /></span>
      <Select.Icon><ChevronDownIcon /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content position="popper" sideOffset={5} collisionPadding={18} className="settings-theme settings-select-menu"
        onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <Select.ScrollUpButton className="tw:grid tw:place-items-center tw:py-1"><ChevronUpIcon /></Select.ScrollUpButton>
        <Select.Viewport className="tw:p-1">
          {options.map(option => <Select.Item key={option.value} value={option.value}
            className="settings-select-item tw:relative tw:rounded-lg tw:py-2.5 tw:pr-7 tw:pl-2.5 tw:text-xs">
            <Select.ItemText>{option.label}</Select.ItemText>
            {option.detail && <span className="tw:mt-1 tw:block tw:text-[10px] tw:text-(--s-muted)">{option.detail}</span>}
            <Select.ItemIndicator className="tw:absolute tw:right-2 tw:top-3"><CheckIcon /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="tw:grid tw:place-items-center tw:py-1"><ChevronDownIcon /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

export function WidthSlider({ value, saving, en, onCommit }: { value: number; saving: boolean; en: boolean; onCommit: (width: number) => void }) {
  const [draft, setDraft] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { if (!saving && !dragging) setDraft(value); }, [value, saving, dragging]);
  return <SettingField label={en ? "Panel width" : "面板宽度"}>
    {id => <div className="tw:grid tw:gap-3">
      <div className="tw:flex tw:items-center tw:gap-4">
        <Slider.Root min={300} max={600} step={10} value={[draft]} aria-busy={saving}
          onPointerDownCapture={() => setDragging(true)} onLostPointerCapture={() => setDragging(false)}
          onValueChange={values => setDraft(values[0]!)} onValueCommit={values => onCommit(values[0]!)}
          className="tw:relative tw:flex tw:h-7 tw:flex-1 tw:touch-none tw:items-center tw:select-none">
          <Slider.Track className="tw:relative tw:h-1 tw:flex-1 tw:rounded-full tw:bg-(--s-line)">
            <Slider.Range className="tw:absolute tw:h-full tw:rounded-full tw:bg-(--s-accent)" />
          </Slider.Track>
          <Slider.Thumb id={id} aria-labelledby={`${id}-label`} aria-valuetext={`${draft} ${en ? "points" : "点"}`} className="settings-slider-thumb" />
        </Slider.Root>
        <output className="tw:min-w-13 tw:rounded-md tw:bg-(--s-fill) tw:px-2 tw:py-1.5 tw:text-center tw:font-mono tw:text-[11px] tw:tabular-nums">{draft}<span className="tw:ml-1 tw:text-(--s-muted)">pt</span></output>
      </div>
      <div className="tw:flex tw:justify-between tw:text-[10px] tw:text-(--s-muted)"><span>{en ? "Compact" : "紧凑"}</span><span>{en ? "Spacious" : "宽松"}</span></div>
    </div>}
  </SettingField>;
}

export function SettingsButton({ children, primary, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...props} className={`settings-button ${primary ? "is-primary" : ""} tw:inline-flex tw:items-center tw:justify-center tw:gap-2 tw:rounded-xl tw:px-3 tw:py-2.5 tw:text-xs tw:font-medium ${className}`}>{children}</button>;
}

export function SettingsIntro({ title, children }: { title: string; children: ReactNode }) {
  return <div className="tw:mb-6 tw:grid tw:gap-2"><h2 className="tw:text-[19px] tw:font-semibold tw:tracking-tight">{title}</h2><p className={hintClass}>{children}</p></div>;
}

export function SettingsTransition({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  return <motion.div initial={reduced ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
    transition={{ type: "spring", stiffness: 320, damping: 30 }}>
    {children}
  </motion.div>;
}
