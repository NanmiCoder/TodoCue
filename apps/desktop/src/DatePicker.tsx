import { useState } from "react";
import { Icon } from "./icons.js";
import { calendarDays, calendarFirstWeekday, weekdayLabels } from "./dates.js";

export function DatePicker({
  value,
  language,
  onChange,
}: {
  value: string;
  language: string;
  onChange: (date: string) => void;
}) {
  const [month, setMonth] = useState(value.slice(0, 7));
  const start = `${month}-01`;
  const firstDay = calendarFirstWeekday(language, navigator.language);
  const dates = calendarDays("month", start, firstDay);
  function page(direction: number) {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + direction);
    setMonth(date.toISOString().slice(0, 7));
  }
  const zh = language !== "en";
  return (
    <div className="date-picker">
      <div className="date-picker-nav">
        <strong>
          {new Intl.DateTimeFormat(language, {
            year: "numeric",
            month: "long",
            timeZone: "UTC",
          }).format(new Date(`${start}T12:00:00Z`))}
        </strong>
        <button
          type="button"
          className="icon-button"
          aria-label={zh ? "上个月" : "Previous month"}
          onClick={() => page(-1)}
        >
          <Icon name="back" size={10} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={zh ? "下个月" : "Next month"}
          onClick={() => page(1)}
        >
          <Icon name="chevron" size={10} />
        </button>
      </div>
      <div className="weekday-labels">
        {weekdayLabels(language, firstDay).map((day, i) => (
          <span key={i}>{day}</span>
        ))}
      </div>
      <div className="month-days">
        {dates.map((date) => (
          <button
            type="button"
            key={date}
            aria-label={date}
            aria-pressed={date === value}
            className={`${date === value ? "selected" : ""} ${date.slice(0, 7) === month ? "" : "other-month"}`}
            onClick={() => {
              onChange(date);
              if (date.slice(0, 7) !== month) setMonth(date.slice(0, 7));
            }}
          >
            <span>{Number(date.slice(-2))}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
