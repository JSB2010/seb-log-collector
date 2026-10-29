import { describe, it, expect } from "vitest";
import {
  denverInput,
  denverInstant,
  denverDayRange,
  denverDate,
  displayTime,
  shiftDate,
} from "../contracts/display-time";

describe("America/Denver display and input", () => {
  it("shows the actual generation time on the prior local date, with a zone", () => {
    expect(displayTime("2026-10-27T04:39:09.407Z")).toContain("Oct 26, 2026");
    expect(displayTime("2026-10-27T04:39:09.407Z")).toContain(
      "10:39:09 PM MDT",
    );
    expect(denverDate("2026-10-27T04:39:09.407Z")).toBe("2026-10-26");
    expect(displayTime("2026-12-15T17:00:00Z")).toContain("10:00:00 AM MST");
  });
  it("round trips Denver input independently of browser/server timezone", () => {
    expect(denverInput("2026-10-27T04:39:00Z")).toBe("2026-10-26T22:39");
    expect(denverInstant("2026-10-26T22:39")).toBe("2026-10-27T04:39:00.000Z");
    expect(denverInstant("2026-12-15T10:00")).toBe("2026-12-15T17:00:00.000Z");
  });
  it("uses complete Denver days including DST transitions", () => {
    expect(denverDayRange("2026-10-26", "2026-10-26")).toEqual({
      from: "2026-10-26T06:00:00.000Z",
      to: "2026-10-27T05:59:59.999Z",
    });
    for (const [day, hours] of [
      ["2026-03-08", 23],
      ["2026-11-01", 25],
    ] as const) {
      const r = denverDayRange(day, day);
      expect(Date.parse(r.to) - Date.parse(r.from) + 1).toBe(hours * 3600000);
    }
  });
  it("rejects gaps/invalid inputs and includes both fall-back occurrences", () => {
    expect(denverInstant("2026-03-08T02:30")).toBeNull();
    expect(denverInstant("2026-02-30T10:00")).toBeNull();
    expect(denverInstant("bad")).toBeNull();
    expect(denverInstant("2026-11-01T01:30", "start")).toBe(
      "2026-11-01T07:30:00.000Z",
    );
    expect(denverInstant("2026-11-01T01:30", "end")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
    expect(() => denverDayRange("2026-02-30", "2026-03-01")).toThrow();
    expect(() => denverDayRange("2026-10-28", "2026-10-27")).toThrow();
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(displayTime("bad")).toBe("Not observed");
  });
});
