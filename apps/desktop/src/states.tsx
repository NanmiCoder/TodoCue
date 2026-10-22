import { motion } from "motion/react";
import { Icon, type IconName } from "./icons.js";
import type { NotificationBanner } from "./notificationBanner.js";
import { motionTokens } from "./tokens.js";

/** Shared empty / offline / missing states, so every page speaks the same way. */
export function OfflineBanner({
  language,
  message,
  retrying,
  onRetry,
}: {
  language: string;
  message?: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const en = language === "en";
  return (
    <div className="offline-banner" role="status" title={message}>
      <div className="offline-banner-text">
        <strong>{en ? "Can’t reach the TodoCue service" : "无法连接 TodoCue 后台服务"}</strong>
        <span>{en ? "Showing the last data. Changes are paused." : "显示上次数据，已暂停写入"}</span>
      </div>
      <button type="button" className="offline-retry" disabled={retrying} onClick={onRetry}>
        {en ? "Retry" : "重试"}
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  actionLabel,
  onAction,
}: {
  title: string;
  hint?: string;
  icon: IconName;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-ring">
        <span className="orange-disc">
          <Icon name={icon} size={22} />
        </span>
      </div>
      <h2>{title}</h2>
      {hint && <p>{hint}</p>}
      {actionLabel && onAction && (
        <button type="button" className="pill" onClick={onAction}>
          <span className="orange-disc">
            <Icon name="plus" />
          </span>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function NotFoundPage({ language, loading, onBack }: { language: string; loading: boolean; onBack: () => void }) {
  const en = language === "en";
  return (
    <section className="tile frost not-found-page">
      {loading && <div className="skeleton" aria-hidden="true" />}
      <p>{en ? "Task not found" : "未找到该任务"}</p>
      <button type="button" className="pill secondary" onClick={onBack}>
        {en ? "Back" : "返回"}
      </button>
    </section>
  );
}

type View = "today" | "upcoming" | "all";
/** Empty-list wording per tab, as the native client words it. */
export function emptyCopy(view: View, searching: boolean, completedToday: number, language: string) {
  const en = language === "en";
  const actionLabel = en ? "Write something down" : "记下一件事";
  if (view === "upcoming")
    return { icon: "calendar" as IconName, title: en ? "Nothing coming up" : "没有即将到来的任务" };
  if (view === "all") {
    if (searching)
      return {
        icon: "search" as IconName,
        title: en ? "No matching tasks" : "没有找到相关任务",
        hint: en ? "Try other keywords." : "试试其他关键词。",
      };
    return {
      icon: "check" as IconName,
      title: en ? "Everything is in order" : "所有事情，都已妥当",
      hint: en ? "Jot down new ideas any time." : "有新想法时，随时记下来。",
      actionLabel,
    };
  }
  return completedToday > 0
    ? {
        icon: "check" as IconName,
        title: en ? "Today is clear" : "今天已清空",
        hint: en ? `You finished ${completedToday}. Take some time for yourself.` : `完成了 ${completedToday} 件事，留点时间给自己。`,
        actionLabel,
      }
    : {
        icon: "plus" as IconName,
        title: en ? "Start with one small thing" : "从一件小事开始",
        hint: en ? "Write it down, and let it go." : "记下来，就不用一直惦记。",
        actionLabel,
      };
}

/**
 * The panel's standing notification strip: one line about why reminders may not reach the person and
 * at most one button. It is not a layer (no Esc handling); the button is an ordinary tab stop.
 */
export function NotificationStrip({ banner, busy, reduced, language, onAction }: {
  banner: NotificationBanner;
  busy: boolean;
  reduced: boolean;
  language: string;
  onAction: (type: NonNullable<NotificationBanner["action"]>["type"]) => void;
}) {
  const en = language === "en";
  const { action } = banner;
  return (
    <motion.section
      key="notification-strip"
      className={`tile graphite notify-strip notify-${banner.severity}`}
      role="status"
      aria-label={en ? "Notification status" : "通知状态"}
      style={{ originY: 0 }}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
      transition={reduced ? { duration: 0.12 } : motionTokens.list}
    >
      <Icon name="bell" size={14} />
      <p className="notify-message" title={banner.detail}>{banner.message}</p>
      {action && (
        <button
          type="button"
          className="notify-action"
          disabled={busy}
          aria-label={`${action.label}: ${banner.message}`}
          onClick={() => onAction(action.type)}
        >
          {action.label}
        </button>
      )}
    </motion.section>
  );
}
