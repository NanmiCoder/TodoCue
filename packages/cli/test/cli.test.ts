import { describe, expect, it } from "vitest";
import type { ContextInfo } from "@todocue/shared";
import { parseWeekdays, resolveDate, resolveInstant } from "../src/timeargs.js";
import { renderPlist } from "../src/launchagent.js";

const ctx: ContextInfo = {
  now: "2026-09-07T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  today: "2026-09-07",
  localNow: "2026-09-07T09:00:00",
  weekday: 1,
  runtimeVersion: "0.1.0",
};

describe("time arguments", () => {
  it("resolves relative dates", () => {
    expect(resolveDate("today", ctx)).toBe("2026-09-07");
    expect(resolveDate("tomorrow", ctx)).toBe("2026-09-08");
    expect(resolveDate("+3d", ctx)).toBe("2026-09-10");
    expect(resolveDate("2026-10-01", ctx)).toBe("2026-10-01");
    expect(() => resolveDate("next week", ctx)).toThrow();
  });
  it("resolves instants to local ISO or absolute ISO", () => {
    expect(resolveInstant("17:30", ctx)).toBe("2026-09-07T17:30:00");
    expect(resolveInstant("tomorrow 9:05", ctx)).toBe("2026-09-08T09:05:00");
    expect(resolveInstant("2026-09-09 08:00", ctx)).toBe("2026-09-09T08:00:00");
    expect(resolveInstant("+30m", ctx)).toBe("2026-09-07T01:30:00.000Z");
    expect(resolveInstant("+2h", ctx)).toBe("2026-09-07T03:00:00.000Z");
    expect(resolveInstant("2026-09-07T10:00:00+08:00", ctx)).toBe("2026-09-07T10:00:00+08:00");
  });
  it("parses weekdays", () => {
    expect(parseWeekdays("mon,wed,fri")).toEqual([1, 3, 5]);
    expect(parseWeekdays("周一 周日")).toEqual([1, 7]);
    expect(parseWeekdays("1,7")).toEqual([1, 7]);
    expect(() => parseWeekdays("someday")).toThrow();
  });
});

describe("launch agent plist", () => {
  it("renders a valid plist with escaped paths", () => {
    const xml = renderPlist({
      label: "com.todocue.runtime",
      plistPath: "/x/com.todocue.runtime.plist",
      nodePath: "/opt/node/bin/node",
      cliEntry: "/Users/me/TodoCue & co/packages/cli/dist/index.js",
      home: "/Users/me/.todocue",
      logDir: "/Users/me/.todocue/logs",
      port: 47831,
    });
    expect(xml).toContain("<string>/Users/me/TodoCue &amp; co/packages/cli/dist/index.js</string>");
    expect(xml).toContain("<key>TODOCUE_PORT</key><string>47831</string>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });
});
