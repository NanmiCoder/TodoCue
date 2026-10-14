import { useEffect, useRef, useState, useLayoutEffect } from "react";
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
import { dateOf, shiftDate } from "./dates.js";
import { Icon, type IconName } from "./icons.js";
import { draftPayload, newDraft, type TaskDraft } from "./drafts.js";
import { motionTokens } from "./tokens.js";

export function Composer({
  task,
  initial,
  language,
  online,
  onChange,
  onSaved,
}: {
  task?: Task;
  initial: TaskDraft;
  language: string;
  online: boolean;
  onChange: (draft: TaskDraft) => void;
  onSaved: (task: Task, submitted: TaskDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const current = useRef(initial);
  const mounted = useRef(true);
  const [reading, setReading] = useState(0);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const popup = useRef<HTMLDivElement>(null);
  const [popupPosition, setPopupPosition] = useState({ left: 20, top: 200 });
  const [projects, setProjects] = useState<string[]>([]);
  const [popover, setPopover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
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
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
    if (busy || reading || !online) return;
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
        const value = error as { code?: string; message?: string };
        setConflict(value.code === "VERSION_CONFLICT");
        setError(value.message ?? String(error));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const chips: { key: string; icon: IconName; title: string }[] = [
    {
      key: "schedule",
      icon: "calendar",
      title:
        draft.scheduledMode === "none"
          ? label("计划", "Plan")
          : draft.scheduledDate,
    },
    {
      key: "project",
      icon: "folder",
      title: draft.project || label("项目", "Project"),
    },
    { key: "priority", icon: "flag", title: label("优先级", "Priority") },
    {
      key: "estimate",
      icon: "clock",
      title: draft.estimate
        ? `${draft.estimate} ${label("分钟", "min")}`
        : label("耗时", "Estimate"),
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
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          void save();
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
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <textarea
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
              .filter((chip) => !(chip.key === "repeat" && !!task?.seriesId))
              .map((chip) => (
                <button
                  type="button"
                  className={
                    popover === chip.key ||
                    (chip.key === "schedule" &&
                      draft.scheduledMode !== "none") ||
                    (chip.key === "project" && !!draft.project) ||
                    (chip.key === "priority" && draft.priority !== "none") ||
                    (chip.key === "estimate" && !!draft.estimate) ||
                    (chip.key === "repeat" && draft.repeat !== "none")
                      ? "active"
                      : ""
                  }
                  key={chip.key}
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
              ))}
            <button type="button" onClick={() => fileInput.current?.click()}>
              <Icon name="paperclip" size={12} />
              {label("附件", "Attachments")}
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
                  initial={{ opacity: 0, scale: 0.96, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={motionTokens.snap}
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
                          step="1"
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
                        value={draft.project}
                        onChange={(event) =>
                          update({ project: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {popover === "project" && projects.length > 0 && (
                    <div className="project-choices">
                      {projects
                        .filter(
                          (project) =>
                            !draft.project ||
                            project
                              .toLowerCase()
                              .includes(draft.project.toLowerCase()),
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
                        value={draft.estimate}
                        onChange={(event) =>
                          update({ estimate: event.target.value })
                        }
                      />
                      {label("分钟", "minutes")}
                    </label>
                  )}
                  {popover === "estimate" && (
                    <div className="estimate-presets">
                      {[5, 15, 30, 60, 90].map((minutes) => (
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
                              onClick={() => update({ repeat })}
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
                        </>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button popover-done"
                    onClick={() => setPopover(null)}
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
          {task?.attachments.length || draft.uploads.length ? (
            <div className="attachment-drawer">
              {task?.attachments
                .filter((file) => !draft.removed.includes(file.id))
                .map((file) => (
                  <div key={file.id}>
                    <Icon name="paperclip" />
                    <span>{file.name}</span>
                    <button
                      type="button"
                      aria-label={`${label("移除", "Remove")} ${file.name}`}
                      onClick={() =>
                        update({ removed: [...draft.removed, file.id] })
                      }
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
              {draft.uploads.map((file, index) => (
                <div key={index}>
                  {file.mediaType?.startsWith("image/") ? (
                    <img
                      src={`data:${file.mediaType};base64,${file.dataBase64}`}
                      alt={file.name}
                    />
                  ) : (
                    <Icon name="paperclip" />
                  )}
                  <span>{file.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      update({
                        uploads: draft.uploads.filter((_, i) => index !== i),
                      })
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
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
          {navigator.platform.includes("Mac") ? "⌘↵" : "Ctrl ↵"}
        </span>
        <button
          type="submit"
          className="pill"
          disabled={
            !online || busy || reading > 0 || !draft.title.trim() || conflict
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
                step="1"
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
