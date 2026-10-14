import type { CSSProperties } from "react";
export type IconName =
  | "calendar"
  | "pin"
  | "more"
  | "close"
  | "back"
  | "check"
  | "plus"
  | "up"
  | "open"
  | "edit"
  | "search"
  | "clock"
  | "folder"
  | "paperclip"
  | "repeat"
  | "bell"
  | "snooze"
  | "tomorrow"
  | "flag"
  | "priority"
  | "chevron"
  | "settings";
const paths: Record<IconName, string> = {
  calendar:
    "M6 3v4m12-4v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1M8 12h1m3 0h1m3 0h1m-9 4h1m3 0h1m3 0h1",
  pin: "M9 3h6m-5 0v6l-4 5v1h12v-1l-4-5V3M12 15v7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  check: "M5 12l4 4L19 6",
  plus: "M12 5v14M5 12h14",
  up: "M12 20V4M5 11l7-7 7 7",
  open: "M6 18L18 6M6 6h12v12",
  edit: "M14 5l5 5M4 20l5-1L20 8l-4-4L5 15l-1 5M12 4H4v16h16v-8",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  folder: "M3 6h7l2 2h9v12H3V6",
  paperclip:
    "M9 15l7-7a2 2 0 0 1 3 3L9 21a5 5 0 0 1-7-7L14 2a4 4 0 0 1 6 6L8 20",
  repeat: "M4 8h15l-4-4m4 4-4 4M20 16H5l4 4m-4-4 4-4",
  bell: "M6 16V9a6 6 0 0 1 12 0v7l2 2H4l2-2M9 21h6",
  snooze: "M4 5h8l-8 8h8M14 13h6l-6 6h6",
  tomorrow: "M5 5v5a4 4 0 0 0 4 4h10m-5-5 5 5-5 5",
  flag: "M5 22V3h13l-2 5 2 5H5",
  priority: "M12 3v12M12 21h.01",
  chevron: "M9 5l7 7-7 7",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
};
export function Icon({
  name,
  size = 14,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 4 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
