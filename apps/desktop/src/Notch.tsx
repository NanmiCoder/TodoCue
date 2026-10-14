import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { PeriodicReminder, RuntimeEvent } from "@todocue/shared";
import { listen } from "@tauri-apps/api/event";
import {
  client,
  defaults,
  loadSettings,
  loadNotchMetrics,
  type NotchMetrics,
  native,
  openPanel,
  openTaskComposer,
  canShowNotch,
  presentNotch,
  revealTask,
  type DesktopSettings,
} from "./bridge.js";
import {
  CueStack,
  taskCue,
  canPresentPeriodic,
  periodicActive,
  shouldCollapseQuickLook,
  type Cue,
} from "./model.js";
import { Gauge, Mark, TaskRow } from "./components.js";
import { Icon } from "./icons.js";
import { TaskMetadata } from "./metadata.js";
import { reschedule, shiftDate } from "./dates.js";
import { translate } from "./i18n.js";
import { useRuntime } from "./useRuntime.js";
import { dial, motionTokens } from "./tokens.js";

export function Notch() {
  const stack = useRef(new CueStack());
  const [cues, setCues] = useState<Cue[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [folded, setFolded] = useState(false);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [saving, setSaving] = useState(false);
  const quickInput = useRef<HTMLInputElement>(null);
  const quickOperation = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const busyCues = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [featured, setFeatured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(defaults);
  const [bandHeight, setBandHeight] = useState(24);
  const inFlight = useRef(new Set<string>());
  const content = useRef<HTMLDivElement>(null);
  const hovering = useRef(false),
    deferred = useRef<Cue[]>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const reduced = useReducedMotion();
  const displayState = useRef({
    enabled: settings.notchEnabled,
    expanded,
    hovered: false,
    foreground: true,
  });
  const interaction = useRef({ expanded, pinned });
  interaction.current = { expanded, pinned };
  displayState.current = {
    enabled: settings.notchEnabled,
    expanded,
    hovered: hovering.current,
    foreground: document.visibilityState === "visible",
  };
  const t = translate(settings.language);
  function collapseOutside() {
    if (!shouldCollapseQuickLook("outside", { ...interaction.current, editing: false })) return;
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    hovering.current = false;
    quickInput.current?.blur();
    setExpanded(false);
    setPinned(false);
    if (deferred.current.length) {
      setFeaturedKey(deferred.current.at(-1)!.key);
      setFeatured(true);
      deferred.current = [];
      setCues(stack.current.shown().map(cue => ({ ...cue })));
    }
  }
  const outside = useRef(collapseOutside);
  outside.current = collapseOutside;
  useEffect(() => {
    if (native) return;
    const blur = () => outside.current();
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);
  useEffect(() => {
    let ended = false;
    let stop: (() => void) | undefined;
    const update = (metrics: NotchMetrics) => {
      if (!ended && Number.isFinite(metrics.bandHeight)) setBandHeight(metrics.bandHeight);
    };
    void (async () => {
      if (native) {
        const listener = await listen<NotchMetrics>("notch:metrics", event => update(event.payload));
        if (ended) { listener(); return; }
        stop = listener;
      }
      update(await loadNotchMetrics());
    })().catch(error => { if (!ended) setError(String(error)); });
    return () => { ended = true; stop?.(); };
  }, []);
  function arrival(cue: Omit<Cue, "repeats">) {
    if (!stack.current.receive(cue)) return;
    setFolded(false);
    if (hovering.current)
      deferred.current.push(
        stack.current.entries.find((item) => item.key === cue.key)!,
      );
    else {
      setFeaturedKey(cue.key);
      setFeatured(true);
      setCues((current) => {
        const next = stack.current.shown().map((cue) => ({ ...cue }));
        return JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next;
      });
    }
  }
  const active = periodicActive;
  const eventHandler = useRef<(event: RuntimeEvent) => void>(() => {});
  const runtime = useRuntime((event) => eventHandler.current(event));
  eventHandler.current = (event) => {
    if (event.type === "reminder.fired" && event.related?.taskId) {
      void client
        .getTask(event.related.taskId)
        .then(({ task }) => {
          const cue = taskCue(event, task);
          if (cue) arrival(cue);
        })
        .catch((error) => setError(String(error)));
    }
    if (event.type === "periodic.fired" && event.id) void claim(event.id);
  };
  async function claim(id: string) {
    if (
      !canPresentPeriodic({
        ...displayState.current,
        hovered: hovering.current,
      }) ||
      inFlight.current.has(id)
    )
      return;
    const key = `periodic:${id}`;
    if (!stack.current.reserve(key)) return;
    inFlight.current.add(id);
    try {
      const { reminder: rule } = await client.getPeriodicReminder(id);
      const occurrence = rule.currentOccurrence;
      if (
        !occurrence ||
        occurrence.delivery !== "offered" ||
        !occurrence.offeredAt ||
        Date.now() - Date.parse(occurrence.offeredAt) >= 3000 ||
        !active(rule)
      )
        return;
      const possible = await canShowNotch();
      if (!possible || !canPresentPeriodic({ ...displayState.current, hovered: hovering.current })) return;
      const claim = {
        occurrenceId: occurrence.id,
        round: occurrence.round,
        token: crypto.randomUUID(),
      };
      const { reminder } = await client.claimPeriodic(id, claim);
      if (
        !canPresentPeriodic({
          ...displayState.current,
          hovered: hovering.current,
        })
      ) {
        await client.receiptPeriodic(id, { ...claim, displayed: false });
        return;
      }
      arrival({
        key: `periodic:${id}`,
        id: `${occurrence.id}:${occurrence.round}`,
        title: rule.title,
        periodic: reminder,
        receivedAt: Date.now(),
      });
      // The DOM has painted before acknowledging successful display to the runtime.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const rendered = !!content.current?.querySelector(
        `[data-cue-id="${occurrence.id}:${occurrence.round}"]`,
      );
      const displayed =
        rendered &&
        canPresentPeriodic({
          ...displayState.current,
          hovered: hovering.current,
        }) &&
        (await presentNotch({
          width: 460,
          height: Math.min(content.current?.scrollHeight ?? 190, 560),
          expanded: false,
          pinned: false,
          stack: true,
        }));
      await client.receiptPeriodic(id, { ...claim, displayed });
      if (!displayed) {
        stack.current.entries = stack.current.entries.filter(
          (cue) => cue.id !== `${occurrence.id}:${occurrence.round}`,
        );
        setCues((current) => {
          const next = stack.current.shown().map((cue) => ({ ...cue }));
          return JSON.stringify(current) === JSON.stringify(next)
            ? current
            : next;
        });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current.delete(id);
      stack.current.release(key);
    }
  }
  useEffect(() => {
    void loadSettings().then(setSettings);
    let stop: (() => void) | undefined;
    let ended = false;
    if (native)
      void Promise.all([
        listen<DesktopSettings>("settings:changed", (event) =>
          setSettings(event.payload),
        ),
        listen("notch:collapse", () => {
          setExpanded(false);
          setPinned(false);
          setFolded(true);
        }),
        listen("notch:outside", () => outside.current()),
      ]).then((stops) => {
        const dispose = () => stops.forEach((stop) => stop());
        if (ended) dispose();
        else stop = dispose;
      });
    return () => {
      ended = true;
      stop?.();
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!runtime.board) return;
    stack.current.sync(runtime.board.all, runtime.rules);
    for (const rule of runtime.rules) {
      const occurrence = rule.currentOccurrence;
      if (
        occurrence?.delivery === "displayed" &&
        occurrence.result === "pending" &&
        rule.enabled &&
        active(rule) &&
        !rule.state.startsWith("paused")
      ) {
        stack.current.receive({
          key: `periodic:${rule.id}`,
          id: `${occurrence.id}:${occurrence.round}`,
          title: rule.title,
          periodic: rule,
          receivedAt: Date.now(),
        });
      }
    }
    if (!hovering.current)
      setCues((current) => {
        const next = stack.current.shown().map((cue) => ({ ...cue }));
        return JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next;
      });
  }, [runtime.board, runtime.rules]);
  useEffect(() => {
    const timer = setInterval(() => {
      stack.current.sync(runtime.board?.all ?? [], runtime.rules);
      if (!hovering.current)
        setCues((current) => {
          const next = stack.current.shown().map((cue) => ({ ...cue }));
          return JSON.stringify(current) === JSON.stringify(next)
            ? current
            : next;
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [runtime.board, runtime.rules]);
  useEffect(() => {
    if (!featured) return;
    const timer = setTimeout(() => setFeatured(false), dial.featureDuration);
    return () => clearTimeout(timer);
  }, [featured, featuredKey, cues.find((cue) => cue.key === featuredKey)?.id]);
  const stackShown = cues.length > 0 && !folded && !expanded;
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const resize = () => {
      const width = expanded ? 560 : stackShown ? 460 : 273;
      const height =
        expanded || stackShown ? Math.min(node.scrollHeight, 560) : bandHeight;
      void presentNotch({
        width,
        height,
        expanded,
        pinned,
        stack: stackShown,
      }).catch((error) => setError(String(error)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, pinned, stackShown, featured, cues, settings, bandHeight]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (quick) setQuick("");
        else {
          setExpanded(false);
          setPinned(false);
          setFolded(true);
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [quick]);
  async function answer(
    cue: Cue,
    action: "complete" | "snooze" | "pause_today",
  ) {
    if (!runtime.connection.online || busyCues.current.has(cue.key)) return;
    busyCues.current.add(cue.key);
    setBusyKeys(new Set(busyCues.current));
    try {
      if (action === "complete")
        await new Promise((resolve) =>
          setTimeout(resolve, reduced ? 120 : 420),
        );
      if (cue.task) {
        if (action === "complete")
          await client.completeTask(cue.task.id, {
            expectedVersion: cue.task.version,
          });
        else
          await client.snoozeTask(cue.task.id, {
            expectedVersion: cue.task.version,
            minutes: 10,
          });
      } else if (cue.periodic)
        await client.periodicAction(cue.periodic.id, {
          action,
          expectedVersion: cue.periodic.version,
          occurrenceId: cue.periodic.currentOccurrenceId ?? undefined,
          round: cue.periodic.currentOccurrence?.round,
          minutes: action === "snooze" ? 10 : undefined,
        });
      stack.current.entries = stack.current.entries.filter(
        (item) => item.key !== cue.key,
      );
      setCues((current) => {
        const next = stack.current.shown().map((cue) => ({ ...cue }));
        return JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next;
      });
      await runtime.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      busyCues.current.delete(cue.key);
      setBusyKeys(new Set(busyCues.current));
    }
  }
  const next = runtime.board?.next.next?.task;
  const rows =
    runtime.board?.today.items
      .filter((item) => item.task.id !== next?.id)
      .slice(0, 5) ?? [];
  async function taskAction(action: () => Promise<unknown>) {
    if (!runtime.connection.online || saving) return;
    setSaving(true);
    setError(null);
    try {
      await action();
      await runtime.refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <motion.main
      className={`notch ${expanded || stackShown ? "notch-open" : ""}`}
      animate={{
        borderBottomLeftRadius: expanded || stackShown ? 24 : 10,
        borderBottomRightRadius: expanded || stackShown ? 24 : 10,
      }}
      transition={motionTokens.expand}
      onMouseEnter={() => {
        hovering.current = true;
        clearTimeout(leaveTimer.current);
        if (!expanded && !stackShown)
          hoverTimer.current = setTimeout(
            () => setExpanded(true),
            dial.hoverDelay,
          );
      }}
      onMouseLeave={() => {
        hovering.current = false;
        clearTimeout(hoverTimer.current);
        if (deferred.current.length) {
          setFeaturedKey(deferred.current.at(-1)!.key);
          setFeatured(true);
          deferred.current = [];
          setCues((current) => {
            const next = stack.current.shown().map((cue) => ({ ...cue }));
            return JSON.stringify(current) === JSON.stringify(next)
              ? current
              : next;
          });
        }
        leaveTimer.current = setTimeout(() => {
          if (shouldCollapseQuickLook("leave", { ...interaction.current, editing: document.activeElement === quickInput.current })) setExpanded(false);
        }, dial.leaveDelay);
      }}
    >
      <div
        ref={content}
        style={{ width: expanded ? 560 : stackShown ? 460 : 273 }}
      >
        <button
          className="notch-band"
          style={{ height: bandHeight }}
          onClick={() => {
            setExpanded(true);
            setPinned(true);
            requestAnimationFrame(() => quickInput.current?.focus());
          }}
          aria-label={t("showPanel")}
        >
          <span className="notch-wing">
            <Mark />
            {folded && cues.length > 0 && <span>{cues.length}</span>}
          </span>
          <span className="notch-housing" style={{ height: bandHeight }} />
          <span className="notch-wing notch-count">
            {runtime.board?.today.remaining ?? "—"}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {(expanded || stackShown) && (
            <motion.section
              className="notch-content"
              key={expanded ? "quick" : "stack"}
              initial={{
                opacity: 0,
                scale: reduced ? 1 : 0.97,
                y: reduced ? 0 : -8,
              }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ ...motionTokens.settle, delay: reduced ? 0 : 0.06 }}
            >
              {expanded ? (
                <>
                  <div className="notch-quick-header">
                    <Mark />
                    <div>
                      <strong>
                        {settings.language === "en" ? "Today" : "今天"}
                      </strong>
                      <span>
                        {runtime.board &&
                          new Intl.DateTimeFormat(settings.language, {
                            month: "short",
                            day: "numeric",
                            weekday: "short",
                            timeZone: runtime.board.context.timezone,
                          }).format(new Date(runtime.board.context.now))}
                      </span>
                    </div>
                    <Gauge
                      completed={runtime.board?.today.completed.length ?? 0}
                      total={
                        (runtime.board?.today.remaining ?? 0) +
                        (runtime.board?.today.completed.length ?? 0)
                      }
                    />
                    <button
                      className="icon-button"
                      onClick={() => void openTaskComposer()}
                      aria-label={t("newTask")}
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      className={`icon-button ${pinned ? "accent" : ""}`}
                      onClick={() => setPinned((value) => !value)}
                      aria-label={
                        settings.language === "en"
                          ? "Pin quick look"
                          : "固定快览"
                      }
                    >
                      <Icon name="pin" />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => {
                        setExpanded(false);
                        setPinned(false);
                        setFolded(true);
                      }}
                      aria-label={t("hide")}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                  {!runtime.connection.online && (
                    <p className="notch-notice">
                      {t("offline")}
                      <button onClick={() => void runtime.refresh()}>
                        {settings.language === "en" ? "Reconnect" : "重连"}
                      </button>
                    </p>
                  )}
                  {cues.slice(0, 3).map((cue) => (
                    <CueCard
                      key={cue.key}
                      cue={cue}
                      featured={false}
                      language={settings.language}
                      disabled={
                        !runtime.connection.online || busyKeys.has(cue.key)
                      }
                      completing={busyKeys.has(cue.key)}
                      onOpen={() =>
                        cue.task
                          ? void revealTask(cue.task.id)
                          : void openPanel()
                      }
                      onAnswer={(action) => void answer(cue, action)}
                    />
                  ))}
                  {next && (
                    <section className="notch-next">
                      <div className="next-heading">
                        <span className="eyebrow">NEXT</span>
                        <span>{t("next")}</span>
                      </div>
                      <button
                        className="next-title"
                        onClick={() => void revealTask(next.id)}
                      >
                        {next.title}
                      </button>
                      <TaskMetadata
                        task={next}
                        language={settings.language}
                        today={runtime.board?.context.today}
                      />
                      <div className="notch-next-actions">
                        <button
                          className="pill"
                          disabled={!runtime.connection.online || saving}
                          onClick={() =>
                            void taskAction(async () => {
                              await new Promise((resolve) =>
                                setTimeout(resolve, reduced ? 120 : 420),
                              );
                              await client.completeTask(next.id, {
                                expectedVersion: next.version,
                              });
                            })
                          }
                        >
                          <span className="orange-disc">
                            <Icon name="check" />
                          </span>
                          {t("complete")}
                        </button>
                        <button
                          className="pill secondary"
                          disabled={!runtime.connection.online || saving}
                          onClick={() =>
                            void taskAction(() =>
                              client.snoozeTask(next.id, {
                                expectedVersion: next.version,
                                minutes: 10,
                              }),
                            )
                          }
                        >
                          <Icon name="bell" />
                          {t("snooze")}
                        </button>
                        <button
                          className="pill secondary"
                          disabled={!runtime.connection.online || saving}
                          onClick={() =>
                            void taskAction(() =>
                              client.updateTask(
                                next.id,
                                reschedule(
                                  next,
                                  shiftDate(runtime.board!.context.today, 1),
                                ),
                              ),
                            )
                          }
                        >
                          {settings.language === "en" ? "Tomorrow" : "明天"}
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => void revealTask(next.id)}
                          aria-label={t("details")}
                        >
                          <Icon name="chevron" />
                        </button>
                      </div>
                    </section>
                  )}
                  <div className="notch-today-rows">
                    {["overdue", "must", "scheduled"].map((section) => {
                      const group = rows.filter(
                        (item) => item.section === section,
                      );
                      return (
                        group.length > 0 && (
                          <section key={section}>
                            <h3>
                              {t(section as "overdue" | "must" | "scheduled")}{" "}
                              <span>{group.length}</span>
                            </h3>
                            {group.map(({ task }) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                today={runtime.board?.context.today}
                                disabled={!runtime.connection.online || saving}
                                onComplete={async (task) => {
                                  try {
                                    await client.completeTask(task.id, {
                                      expectedVersion: task.version,
                                    });
                                    await runtime.refresh();
                                  } catch (error) {
                                    setError(String(error));
                                    return false;
                                  }
                                }}
                                onOpen={(task) => void revealTask(task.id)}
                              />
                            ))}
                          </section>
                        )
                      );
                    })}
                  </div>
                  {!next && rows.length === 0 && (
                    <p className="notch-empty">
                      {settings.language === "en"
                        ? "Nothing left to carry today."
                        : "今天的事情，都已妥当。"}
                    </p>
                  )}
                  {(runtime.board?.today.items.length ?? 0) >
                    rows.length + (next ? 1 : 0) && (
                    <button
                      className="text-button"
                      onClick={() => void openPanel()}
                    >
                      {settings.language === "en"
                        ? "See all tasks"
                        : `还有 ${(runtime.board?.today.items.length ?? 0) - rows.length - (next ? 1 : 0)} 项，查看全部`}
                    </button>
                  )}
                  <form
                    className="notch-quick-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!quick.trim() || saving || !runtime.connection.online)
                        return;
                      const title = quick,
                        payload = {
                          title,
                          scheduledDate: runtime.board?.context.today,
                        },
                        signature = JSON.stringify(payload);
                      if (quickOperation.current?.signature !== signature)
                        quickOperation.current = {
                          signature,
                          key: crypto.randomUUID(),
                        };
                      const operation = quickOperation.current!;
                      void taskAction(async () => {
                        await client.createTask(payload, {
                          idempotencyKey: operation.key,
                        });
                        if (quickOperation.current?.key === operation.key)
                          quickOperation.current = null;
                        setQuick((current) =>
                          current === title ? "" : current,
                        );
                        quickInput.current?.focus();
                      });
                    }}
                  >
                    <div className={`notch-quick-field ${quick.trim() ? "has-text" : ""}`}>
                    <button
                      className="orange-disc"
                      type="button"
                      disabled={!runtime.connection.online || saving}
                      onClick={() => {
                        setPinned(true);
                        quickInput.current?.focus();
                      }}
                      aria-label={settings.language === "en" ? "Focus quick add" : "输入任务"}
                    >
                      <Icon name="plus" />
                    </button>
                    <input
                      ref={quickInput}
                      value={quick}
                      onChange={(event) => setQuick(event.target.value)}
                      onFocus={() => setPinned(true)}
                      onKeyDown={(event) => {
                        if (
                          event.nativeEvent.isComposing &&
                          event.key === "Enter"
                        )
                          event.preventDefault();
                      }}
                      placeholder={
                        settings.language === "en"
                          ? "Add to today, Enter to create"
                          : "添加到今天，回车创建"
                      }
                      aria-label={
                        settings.language === "en"
                          ? "Quick add to today"
                          : "快速添加到今天"
                      }
                      disabled={!runtime.connection.online}
                    />
                    {quick.trim() && <button type="submit" className="notch-quick-submit" disabled={!runtime.connection.online || saving} aria-label={settings.language === "en" ? "Create task" : "创建任务"}><Icon name="up" size={12} /></button>}
                    </div>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void openPanel()}
                    >
                      {t("showPanel")} <Icon name="open" size={11} />
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <div className="notch-heading">
                    <span>{t("reminder")}</span>
                    <button
                      className="icon-button"
                      onClick={() => {
                        setExpanded(false);
                        setPinned(false);
                        setFolded(true);
                      }}
                      aria-label={t("hide")}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                  {cues.slice(0, 3).map((cue) => (
                    <CueCard
                      key={cue.key}
                      cue={cue}
                      featured={featured && cue.key === featuredKey}
                      language={settings.language}
                      disabled={
                        !runtime.connection.online || busyKeys.has(cue.key)
                      }
                      completing={busyKeys.has(cue.key)}
                      onOpen={() =>
                        cue.task
                          ? void revealTask(cue.task.id)
                          : void openPanel()
                      }
                      onAnswer={(action) => void answer(cue, action)}
                    />
                  ))}
                </>
              )}
              {cues.length > 3 && !expanded && (
                <span className="muted">+{cues.length - 3}</span>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </motion.main>
  );
}

function CueCard({
  cue,
  featured,
  language,
  disabled,
  completing,
  onOpen,
  onAnswer,
}: {
  cue: Cue;
  featured: boolean;
  language: string;
  disabled: boolean;
  completing: boolean;
  onOpen: () => void;
  onAnswer: (action: "complete" | "snooze" | "pause_today") => void;
}) {
  const t = translate(language);
  return (
    <motion.article
      layout
      className={`cue ${featured ? "cue-featured" : ""} ${completing ? "completing" : ""}`}
      data-cue-id={cue.id}
    >
      <button className="cue-title" onClick={onOpen}>
        {cue.title}
        {cue.repeats > 1 && <span> ×{cue.repeats}</span>}
      </button>
      {featured && cue.task && (
        <TaskMetadata task={cue.task} language={language} />
      )}
      {featured && cue.periodic && (
        <p className="muted">
          {language === "en"
            ? `Every ${cue.periodic.intervalMinutes} minutes`
            : cue.periodic.summary}
        </p>
      )}
      <div className="cue-actions">
        <button
          className="orange-disc"
          onClick={() => onAnswer("complete")}
          aria-label={t("complete")}
          disabled={disabled}
        >
          <Icon name="check" />
        </button>
        <button
          className="pill secondary"
          onClick={() => onAnswer("snooze")}
          disabled={disabled}
        >
          {t("snooze")}
        </button>
        {cue.periodic && (
          <button
            className="text-button"
            onClick={() => onAnswer("pause_today")}
            disabled={disabled}
          >
            {t("pause")}
          </button>
        )}
      </div>
    </motion.article>
  );
}
