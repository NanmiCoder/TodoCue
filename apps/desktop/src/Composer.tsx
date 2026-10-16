import { useReducedMotion } from "./useReducedMotion.js";
import { useEffect, useRef, useState, useLayoutEffect, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TASK_ATTACHMENT_BYTES,
  type AttachmentUpload,
  type CreateTaskInput,
  type UpdateTaskInput,
  type Task,
} from "@todocue/shared";
import { client } from "./bridge.js";
import { DatePicker } from "./DatePicker.js";
import { dateOf, dayLabel, shiftDate, weekdayLabels } from "./dates.js";
import { Icon, type IconName } from "./icons.js";
import { draftPayload, newDraft, startRepeat, validateDraft, type TaskDraft } from "./drafts.js";
import { describeError } from "./errors.js";
import { chord, isSubmitChord } from "./platform.js";
import { motionTokens } from "./tokens.js";
import { isCompositionKey } from "./quickAdd.js";
import { useTextAreaSize } from "./useTextAreaSize.js";
import { AttachmentGallery, AttachmentPreview, type FilePreview } from "./Attachments.js";

export function Composer({
  task,
  initial,
  language,
  today,
  online,
  onChange,
  onSaved,
}: {
  task?: Task;
  initial: TaskDraft;
  language: string;
  today: string;
  online: boolean;
  onChange: (draft: TaskDraft) => void;
  onSaved: (task: Task, submitted: TaskDraft) => void;
}) {
  const reduced = useReducedMotion();
  const [draft, setDraft] = useState(initial);
  const current = useRef(initial);
  const mounted = useRef(true);
  const [reading, setReading] = useState(0);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const popup = useRef<HTMLDivElement>(null);
  const [popupPosition, setPopupPosition] = useState({ left: 20, top: 200 });
  const [projects, setProjects] = useState<string[]>([]);
  const [popover, setPopover] = useState<string | null>(null);
  const [propertyText, setPropertyText] = useState("");
  const [viewing, setViewing] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const savePending = useRef(false);
  const [dragged, setDragged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const notesInput = useRef<HTMLTextAreaElement>(null);
  useTextAreaSize(titleInput, draft.title, 2, 4);
  useTextAreaSize(notesInput, draft.notes);
  useEffect(() => {
    titleInput.current?.focus();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    current.current = initial;
    setDraft(initial);
  }, [initial]);
  useEffect(() => {
    void client
      .projects()
      .then((result) => setProjects(result.projects))
      .catch(() => {});
  }, [online]);
  useEffect(() => {
    if (!popover) return;
    setPropertyText(popover === "project" ? current.current.project : popover === "estimate" ? current.current.estimate : "");
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isCompositionKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        setPopover(null);
      }
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [popover]);
  useLayoutEffect(() => {
    if (!popover) return;
    const rect = anchors.current.get(popover)?.getBoundingClientRect();
    if (!rect) return;
    const height = Math.min(
      popup.current?.scrollHeight ?? 260,
      innerHeight - 100,
    );
    setPopupPosition({
      left: Math.max(20, Math.min(rect.left, innerWidth - 280)),
      top:
        rect.bottom + height + 16 < innerHeight
          ? rect.bottom + 8
          : Math.max(80, rect.top - height - 8),
    });
  }, [popover]);
  const zh = language !== "en";
  const label = (zhText: string, enText: string) => (zh ? zhText : enText);
  function update(patch: Partial<TaskDraft>) {
    const next = { ...current.current, ...patch, key: crypto.randomUUID() };
    current.current = next;
    if (mounted.current) setDraft(next);
    onChange(next);
    if (!conflict && mounted.current) setError(null);
  }
  function confirmProperty() {
    if (popover === "project") {
      if (!propertyText.trim()) return;
      update({ project: propertyText.trim() });
    } else if (popover === "estimate") {
      if (!propertyText.trim()) return;
      if (!Number.isInteger(Number(propertyText)) || Number(propertyText) < 0) {
        setError(label("预计耗时需要是非负整数分钟", "Estimate must be a whole number of minutes"));
        return;
      }
      update({ estimate: propertyText });
    }
    setPopover(null);
  }
  async function files(files: FileList | File[]) {
    setReading((count) => count + 1);
    try {
      const list = Array.from(files);
      if (list.some((file) => file.size > MAX_ATTACHMENT_BYTES))
        throw new Error(
          label("单个附件不能超过 10 MB", "Each file must be under 10 MB"),
        );
      const uploads = await Promise.all(
        list.map(
          (file) =>
            new Promise<AttachmentUpload>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error("Could not read file"));
              reader.onload = () =>
                resolve({
                  name: file.name,
                  mediaType: file.type || "application/octet-stream",
                  dataBase64: String(reader.result).split(",")[1]!,
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      if (!mounted.current) return;
      const latest = current.current;
      const kept =
        (latest.original ?? task)?.attachments.filter(
          (file) => !latest.removed.includes(file.id),
        ) ?? [];
      if (kept.length + latest.uploads.length + list.length > MAX_ATTACHMENTS)
        throw new Error(
          label("每个任务最多 20 个附件", "At most 20 attachments"),
        );
      const existing =
        kept.reduce((sum, file) => sum + file.size, 0) +
        latest.uploads.reduce(
          (sum, file) => sum + Math.floor((file.dataBase64.length * 3) / 4),
          0,
        );
      if (
        existing + list.reduce((sum, file) => sum + file.size, 0) >
        MAX_TASK_ATTACHMENT_BYTES
      )
        throw new Error(
          label(
            "附件总大小不能超过 30 MB",
            "Attachments must total under 30 MB",
          ),
        );
      update({ uploads: [...latest.uploads, ...uploads] });
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setReading((count) => count - 1);
    }
  }
  async function save() {
    if (savePending.current || reading || !online) return;
    const invalid = validateDraft(current.current, language);
    if (invalid) {
      setError(invalid);
      if (!current.current.title.trim()) titleInput.current?.focus();
      return;
    }
    savePending.current = true;
    setBusy(true);
    setError(null);
    const submitted = current.current;
    try {
      const payload = draftPayload(submitted);
      const { task: saved } = submitted.original
        ? await client.updateTask(
            submitted.original.id,
            payload as UpdateTaskInput,
            { idempotencyKey: submitted.key },
          )
        : await client.createTask(payload as CreateTaskInput, {
            idempotencyKey: submitted.key,
          });
      onSaved(saved, submitted);
    } catch (error) {
      if (mounted.current) {
        setConflict((error as { code?: string }).code === "VERSION_CONFLICT");
        setError(describeError(error, language));
      }
    } finally {
      savePending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const chips: { key: string; icon: IconName; title: string }[] = [
    {
      key: "schedule",
      icon: "calendar",
      title:
        draft.scheduledMode === "none"
          ? draft.dueMode !== "none" ? `${label("截止", "Due")} ${dayLabel(draft.dueDate, language, today)}` : draft.reminder ? `${label("提醒", "Reminder")} ${draft.reminder.slice(11, 16)}` : label("日期", "Date")
          : `${dayLabel(draft.scheduledDate, language, today)}${draft.scheduledMode === "time" ? ` ${draft.scheduledTime.slice(0, 5)}` : ""}`,
    },
    {
      key: "project",
      icon: "folder",
      title: draft.project || label("项目", "Project"),
    },
    { key: "priority", icon: draft.priority === "none" ? "flag" : "priority", title: draft.priority === "none" ? label("优先级", "Priority") : label({high:"高",medium:"中",low:"低"}[draft.priority], {high:"High",medium:"Medium",low:"Low"}[draft.priority]) },
    {
      key: "estimate",
      icon: "clock",
      title: draft.estimate
        ? `${draft.estimate}m`
        : label("预估", "Estimate"),
    },
    {
      key: "repeat",
      icon: "repeat",
      title:
        draft.repeat === "none"
          ? label("重复", "Repeat")
          : draft.repeat === "daily"
            ? label("每天", "Daily")
            : label("每周", "Weekly"),
    },
  ];
  const keptAttachments = task?.attachments.filter(file => !draft.removed.includes(file.id)) ?? [];
  const attachmentCount = keptAttachments.length + draft.uploads.length;
  const activeChip = (key: string) => key === "schedule" ? draft.scheduledMode !== "none" || draft.dueMode !== "none" || !!draft.reminder
    : key === "project" ? !!draft.project : key === "priority" ? draft.priority !== "none" : key === "estimate" ? !!draft.estimate : draft.repeat !== "none";
  const clearChip: Record<string, Partial<TaskDraft>> = {
    schedule: { scheduledMode: "none", dueMode: "none", reminder: "" },
    project: { project: "" }, priority: { priority: "none" }, estimate: { estimate: "" }, repeat: { repeat: "none" },
  };
  return (
    <form
      className="tile frost composer-page"
      onPaste={(event) => {
        const images = [...event.clipboardData.items]
          .filter(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file);
        if (images.length) {
          event.preventDefault();
          void files(images);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          isSubmitChord(event) &&
          !isCompositionKey(event.nativeEvent)
        ) {
          event.preventDefault();
          void save();
        } else if (!event.defaultPrevented && event.key === "Enter" &&
          !isCompositionKey(event.nativeEvent) && (event.target as Element).closest(".composer-popover input")) {
          // A property input must never implicitly submit the task form.
          event.preventDefault();
          confirmProperty();
        }
      }}
    >
      <div className="page-scroll">
        <section
          className={`surface-card composer-canvas ${dragged ? "dragged" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragged(true);
          }}
          onDragLeave={() => setDragged(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragged(false);
            void files(event.dataTransfer.files);
          }}
        >
          <textarea
            ref={titleInput}
            className="title-input"
            rows={2}
            placeholder={label("准备做什么？", "What’s next?")}
            aria-label={label("标题", "Title")}
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.altKey && !event.metaKey && !event.ctrlKey &&
                !isCompositionKey(event.nativeEvent)
              ) {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <textarea
            ref={notesInput}
            rows={2}
            placeholder={label(
              "添加备注、链接或详细想法...",
              "Notes, links or ideas…",
            )}
            aria-label={label("备注", "Notes")}
            value={draft.notes}
            onChange={(event) => update({ notes: event.target.value })}
          />
          <div className="composer-divider" />
          <div className="attribute-chips">
            {chips
              .filter((chip) => !(chip.key === "schedule" && draft.repeat !== "none"))
              .map((chip) => (
                <div key={chip.key} className={`attribute-chip ${activeChip(chip.key) ? "active" : ""}`}
                  style={chip.key === "priority" ? { "--chip-tint": draft.priority === "high" ? "#f36a6a" : draft.priority === "low" ? "#5792d7" : "var(--orange)" } as CSSProperties : undefined}>
                <button
                  type="button"
                  data-attribute={chip.key}
                  aria-expanded={popover === chip.key}
                  disabled={chip.key === "repeat" && !!task}
                  ref={(node) => {
                    if (node) anchors.current.set(chip.key, node);
                    else anchors.current.delete(chip.key);
                  }}
                  onClick={() =>
                    setPopover(popover === chip.key ? null : chip.key)
                  }
                >
                  <Icon name={chip.icon} size={12} />
                  {chip.title}
                </button>
                {activeChip(chip.key) && <button type="button" className="attribute-clear" disabled={chip.key === "repeat" && !!task}
                  aria-label={label(`清除${{schedule:"日期",project:"项目",priority:"优先级",estimate:"预估",repeat:"重复"}[chip.key]}`, `Clear ${chip.key}`)}
                  onClick={() => { setPopover(null); update(clearChip[chip.key]!); }}><Icon name="close" size={9} /></button>}
                </div>
              ))}
            <button type="button" className={attachmentCount ? "active" : ""} aria-label={label("添加附件", "Add attachments")} disabled={reading > 0} onClick={() => fileInput.current?.click()}>
              <Icon name="paperclip" size={12} />
              {attachmentCount || label("附件", "Attachments")}
            </button>
          </div>
          <AnimatePresence>
            {popover && (
              <>
                <button
                  type="button"
                  className="popover-dismiss"
                  aria-label={label("关闭弹层", "Dismiss popover")}
                  onClick={() => setPopover(null)}
                />
                <motion.div
                  ref={popup}
                  role="dialog"
                  aria-label={label("任务属性", "Task attributes")}
                  className="composer-popover frost"
                  style={popupPosition}
                  key={popover}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={reduced ? { duration: 0.12 } : motionTokens.snap}
                >
                  {popover === "schedule" && (
                    <>
                      <div className="schedule-presets">
                        {[0, 1].map((offset) => (
                          <button
                            type="button"
                            className="pill secondary"
                            key={offset}
                            onClick={() => {
                              update({
                                scheduledMode: "date",
                                scheduledDate: shiftDate(
                                  dateOf(
                                    new Date().toISOString(),
                                    draft.timezone,
                                  ),
                                  offset,
                                ),
                              });
                              setPopover(null);
                            }}
                          >
                            {offset === 0
                              ? label("今天", "Today")
                              : label("明天", "Tomorrow")}
                          </button>
                        ))}
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => update({ scheduledMode: "none" })}
                        >
                          {label("清除", "Clear")}
                        </button>
                      </div>
                      <h3>{label("安排时间", "Schedule")}</h3>
                      <TimeField
                        graphical
                        title={label("计划", "Plan")}
                        mode={draft.scheduledMode}
                        date={draft.scheduledDate}
                        time={draft.scheduledTime}
                        language={language}
                        onMode={(value) => update({ scheduledMode: value })}
                        onDate={(value) => update({ scheduledDate: value })}
                        onTime={(value) => update({ scheduledTime: value })}
                      />
                      <TimeField
                        title={label("截止", "Deadline")}
                        mode={draft.dueMode}
                        date={draft.dueDate}
                        time={draft.dueTime}
                        language={language}
                        onMode={(value) => update({ dueMode: value })}
                        onDate={(value) => update({ dueDate: value })}
                        onTime={(value) => update({ dueTime: value })}
                      />
                      <label className="field-row">
                        {label("提醒", "Reminder")}
                        <input
                          type="datetime-local"
                          value={draft.reminder}
                          onChange={(event) =>
                            update({ reminder: event.target.value })
                          }
                        />
                      </label>
                    </>
                  )}
                  {popover === "project" && (
                    <label className="field-row">
                      {label("项目", "Project")}
                      <input
                        value={propertyText}
                        onChange={(event) =>
                          setPropertyText(event.target.value)
                        }
                      />
                    </label>
                  )}
                  {popover === "project" && projects.length > 0 && (
                    <div className="project-choices">
                      {projects
                        .filter(
                          (project) =>
                            !propertyText ||
                            project
                              .toLowerCase()
                              .includes(propertyText.toLowerCase()),
                        )
                        .map((project) => (
                          <button
                            type="button"
                            key={project}
                            onClick={() => {
                              update({ project });
                              setPopover(null);
                            }}
                          >
                            <Icon name="folder" />
                            {project}
                          </button>
                        ))}
                    </div>
                  )}
                  {popover === "estimate" && (
                    <label className="field-row">
                      {label("预计耗时", "Estimate")}
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={propertyText}
                        onChange={(event) =>
                          setPropertyText(event.target.value)
                        }
                      />
                      {label("分钟", "minutes")}
                    </label>
                  )}
                  {popover === "estimate" && (
                    <div className="estimate-presets">
                      {[15, 25, 45, 60].map((minutes) => (
                        <button
                          className="pill secondary"
                          type="button"
                          key={minutes}
                          onClick={() => {
                            update({ estimate: String(minutes) });
                            setPopover(null);
                          }}
                        >
                          {minutes}m
                        </button>
                      ))}
                    </div>
                  )}
                  {popover === "priority" && (
                    <div className="segment">
                      {(["none", "low", "medium", "high"] as const).map(
                        (priority, index) => (
                          <button
                            type="button"
                            key={priority}
                            className={
                              draft.priority === priority ? "selected" : ""
                            }
                            onClick={() => {
                              update({ priority });
                              setPopover(null);
                            }}
                          >
                            {zh ? ["无", "低", "中", "高"][index] : priority}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                  {popover === "repeat" && (
                    <>
                      <div className="segment">
                        {(["none", "daily", "weekly"] as const).map(
                          (repeat, index) => (
                            <button
                              type="button"
                              key={repeat}
                              className={
                                draft.repeat === repeat ? "selected" : ""
                              }
                              disabled={!!task}
                              onClick={() =>
                                update({
                                  repeat,
                                  ...(draft.repeat === "none" && repeat !== "none" ? startRepeat(draft) : {}),
                                })
                              }
                            >
                              {zh ? ["不重复", "每天", "每周"][index] : repeat}
                            </button>
                          ),
                        )}
                      </div>
                      {draft.repeat === "weekly" && (
                        <div className="weekday-picker">
                          {["一", "二", "三", "四", "五", "六", "日"].map(
                            (day, index) => (
                              <button
                                type="button"
                                key={index}
                                aria-label={weekdayLabels(language, 1, true)[index]}
                                aria-pressed={draft.weekdays.includes(index + 1)}
                                className={
                                  draft.weekdays.includes(index + 1)
                                    ? "selected"
                                    : ""
                                }
                                onClick={() =>
                                  update({
                                    weekdays: draft.weekdays.includes(index + 1)
                                      ? draft.weekdays.filter(
                                          (day) => day !== index + 1,
                                        )
                                      : [...draft.weekdays, index + 1],
                                  })
                                }
                              >
                                {zh
                                  ? day
                                  : ["M", "T", "W", "T", "F", "S", "S"][index]}
                              </button>
                            ),
                          )}
                        </div>
                      )}
                      {draft.repeat !== "none" && (
                        <>
                          <label className="field-row">
                            {label("开始日期", "Starts")}
                            <input
                              type="date"
                              value={draft.start}
                              onChange={(event) =>
                                update({ start: event.target.value })
                              }
                            />
                          </label>
                          <label className="field-row">
                            {label("结束日期", "Ends")}
                            <input
                              type="date"
                              value={draft.end}
                              onChange={(event) =>
                                update({ end: event.target.value })
                              }
                            />
                          </label>
                          <div className="field-row repeat-time">
                            <label>
                              <input
                                type="checkbox"
                                checked={draft.repeatTimeOn}
                                onChange={(event) => update({ repeatTimeOn: event.target.checked })}
                              />
                              {label("固定时间", "At a fixed time")}
                            </label>
                            {draft.repeatTimeOn && (
                              <input
                                type="time"
                                aria-label={label("固定时间", "Fixed time")}
                                value={draft.repeatTime.slice(0, 5)}
                                onChange={(event) => update({ repeatTime: event.target.value })}
                              />
                            )}
                          </div>
                          <div className="field-row repeat-time">
                            <label>
                              <input
                                type="checkbox"
                                checked={draft.repeatReminderOn}
                                onChange={(event) => update({ repeatReminderOn: event.target.checked })}
                              />
                              {label("每次提醒", "Remind each time")}
                            </label>
                            {draft.repeatReminderOn && (
                              <input
                                type="time"
                                aria-label={label("提醒时间", "Reminder time")}
                                value={draft.repeatReminderTime.slice(0, 5)}
                                onChange={(event) => update({ repeatReminderTime: event.target.value })}
                              />
                            )}
                          </div>
                          <p className="settings-hint">
                            {label("按所选日期自动重复，每次可单独编辑或跳过。", "Repeats on the chosen days; each one can be edited or skipped.")}
                          </p>
                        </>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button popover-done"
                    onClick={confirmProperty}
                  >
                    {label("完成", "Done")}
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
          <input
            ref={fileInput}
            hidden
            type="file"
            multiple
            onChange={(event) => {
              if (event.target.files) void files(event.target.files);
              event.target.value = "";
            }}
          />
          {attachmentCount > 0 ? (
            <div className="attachment-drawer">
              <h3><Icon name="paperclip" />{label("图片与附件", "Images & files")}<span>{attachmentCount} / 20</span></h3>
              {task && <AttachmentGallery taskId={task.id} files={keptAttachments} online={online} language={language}
                onOpen={setViewing} onError={setError} onRemove={file => update({ removed: [...draft.removed, file.id] })} />}
              <div className="pending-attachments">
              {draft.uploads.map((file, index) => (
                <div className="pending-attachment" key={index}>
                  <button type="button" className="pending-preview" aria-label={label(`预览待上传附件 ${file.name}`, `Preview pending attachment ${file.name}`)}
                    onClick={() => setViewing({ file: { name: file.name, mediaType: file.mediaType ?? "application/octet-stream" }, data: file.dataBase64 })}>
                  {file.mediaType?.startsWith("image/") ? (
                    <img
                      src={`data:${file.mediaType};base64,${file.dataBase64}`}
                      alt={file.name}
                    />
                  ) : (
                    <Icon name="paperclip" />
                  )}
                  </button>
                  <div>
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={label(`移除 ${file.name}`, `Remove ${file.name}`)}
                    onClick={() =>
                      update({
                        uploads: draft.uploads.filter((_, i) => index !== i),
                      })
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                  </div>
                </div>
              ))}
              </div>
            </div>
          ) : null}
          {draft.repeat !== "none" && (
            <p className="muted">
              {label(
                "附件仅保存到首次任务。",
                "Attachments are saved to the first instance only.",
              )}
            </p>
          )}
        </section>
        <details className="advanced-settings">
          <summary>{label("更多设置", "More settings")}</summary>
          <label className="field-row">
            {label("时区", "Timezone")}
            <input
              value={draft.timezone}
              onChange={(event) => update({ timezone: event.target.value })}
            />
          </label>
        </details>
        {conflict && (
          <div className="conflict-banner" role="alert">
            <p>
              {label(
                "任务已在别处修改。你的输入已保留。",
                "The task changed elsewhere. Your draft is kept.",
              )}
            </p>
            <button
              type="button"
              onClick={() =>
                void client
                  .getTask(draft.original!.id)
                  .then(({ task }) => {
                    update(newDraft(task));
                    setConflict(false);
                    setError(null);
                  })
                  .catch((error) => setError(String(error)))
              }
            >
              {label("重新载入最新任务", "Reload latest task")}
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="form-footer">
        <span className="muted">
          {online
            ? label("返回会保留草稿", "Back keeps your draft")
            : label("离线，草稿已保留", "Offline. Draft kept")}
        </span>
        <span className="save-hint">
          {chord("↵")}
        </span>
        <button
          type="submit"
          className="pill"
          disabled={
            !online || busy || reading > 0 || conflict
          }
        >
          {busy
            ? label("保存中…", "Saving…")
            : reading
              ? label("读取附件…", "Reading files…")
              : draft.original
                ? label("保存更改", "Save changes")
                : label("添加任务", "Add task")}
        </button>
      </footer>
      {viewing && <AttachmentPreview preview={viewing} language={language} onClose={() => setViewing(null)} onError={setError} />}
    </form>
  );
}
function TimeField({
  graphical = false,
  title,
  mode,
  date,
  time,
  language,
  onMode,
  onDate,
  onTime,
}: {
  graphical?: boolean;
  title: string;
  mode: TaskDraft["scheduledMode"];
  date: string;
  time: string;
  language: string;
  onMode: (value: TaskDraft["scheduledMode"]) => void;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
}) {
  return (
    <div className="time-field">
      <label>
        {title}
        <select
          value={mode}
          onChange={(event) =>
            onMode(event.target.value as TaskDraft["scheduledMode"])
          }
        >
          <option value="none">{language === "en" ? "None" : "不设置"}</option>
          <option value="date">{language === "en" ? "Date" : "全天"}</option>
          <option value="time">
            {language === "en" ? "Date and time" : "具体时间"}
          </option>
        </select>
      </label>
      {mode !== "none" && (
        <>
          {graphical && (
            <DatePicker value={date} language={language} onChange={onDate} />
          )}
          <div className="field-row">
            {!graphical && (
              <input
                type="date"
                value={date}
                onChange={(event) => onDate(event.target.value)}
              />
            )}
            {mode === "time" && (
              <input
                type="time"
                value={time}
                onChange={(event) => onTime(event.target.value)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
