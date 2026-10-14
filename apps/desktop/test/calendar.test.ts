import { describe, expect, it } from "vitest";
import { calendarDays, calendarFirstWeekday, calendarTitle, weekdayLabels } from "../src/dates.js";

describe("calendar region and civil dates", () => {
  it("keeps Chinese Monday first and follows the English user's region", () => {
    expect(calendarFirstWeekday("zh-CN", "en-US")).toBe(1);
    expect(calendarFirstWeekday("en", "en-US")).toBe(7);
    expect(calendarFirstWeekday("en", "en-GB")).toBe(1);
    expect(weekdayLabels("en", 7)).toEqual(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]);
    expect(weekdayLabels("zh-CN")).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
  });
  it("uses the same region for month padding, week range and collapsed week", () => {
    expect(calendarDays("week", "2026-10-14", 7)).toEqual([
      "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17",
    ]);
    expect(calendarDays("month", "2026-10-14", 7)[0]).toBe("2026-09-27");
    expect(calendarDays("month", "2026-10-14", 1)[0]).toBe("2026-09-28");
  });
  it("preserves full week rows for leap years and four, five, six row months", () => {
    expect(calendarDays("month", "2027-02-01", 1)).toHaveLength(28);
    expect(calendarDays("month", "2026-10-01", 1)).toHaveLength(35);
    expect(calendarDays("month", "2026-03-01", 1)).toHaveLength(42);
    const leap = calendarDays("month", "2028-02-01", 1);
    expect(leap).toContain("2028-02-29");
    expect(leap.at(-1)).toBe("2028-03-05");
  });
  it("crosses the year without a local timezone or DST changing the day", () => {
    expect(calendarDays("week", "2027-01-01", 1)).toEqual([
      "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
    ]);
    expect(calendarTitle("week", "2026-11-01", "en", 1, "2026-10-14")).toBe("Oct 26 – Nov 1");
    expect(calendarTitle("week", "2027-01-01", "en", 1, "2026-10-14")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});
