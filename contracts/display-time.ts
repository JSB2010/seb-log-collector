/** Display and wall-clock input policy shared by the two investigation apps.
 * Evidence/API timestamps stay UTC. Never parse an offset-free native log line
 * as an instant: its device timezone (and repeated DST hour) may be unknown.
 */
export const DISPLAY_TIME_ZONE = "America/Denver";
export const DISPLAY_TIME_LABEL = "America/Denver (MST/MDT)";

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});
function parts(at: number) {
  return Object.fromEntries(partsFormatter.formatToParts(at).map((p) => [p.type, p.value]));
}
export function denverInput(value?: string | number | null) {
  const at = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(at)) return "";
  const p = parts(at);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function denverDate(value: string | number = Date.now()) {
  return denverInput(value).slice(0, 10);
}
/** DST gaps are invalid. A repeated hour includes both occurrences in ranges:
 * start uses the earlier instant, end the later instant, independent of host TZ.
 */
export function denverInstant(value: string, edge: "start" | "end" = "start"): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const wall = Date.parse(value + ":00.000Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) return null;
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const at = wall + delta,
      p = parts(at);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - at);
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => denverInput(at) === value)
    .sort((a, b) => a - b);
  const at = edge === "start" ? candidates[0] : candidates.at(-1);
  return at === undefined ? null : new Date(at).toISOString();
}
export function shiftDate(day: string, days: number) {
  const at = Date.parse(day + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day)
    throw new Error("Select a valid America/Denver date");
  return new Date(at + days * 86400000).toISOString().slice(0, 10);
}
export function denverDayRange(from: string, to: string) {
  const first = denverInstant(shiftDate(from, 0) + "T00:00");
  const next = denverInstant(shiftDate(to, 1) + "T00:00");
  if (!first || !next || first >= next) throw new Error("Select a valid America/Denver date range");
  return { from: first, to: new Date(Date.parse(next) - 1).toISOString() };
}
export function displayTime(value?: string | null, full = true, missing = "Not observed") {
  if (!value || !Number.isFinite(Date.parse(value))) return missing;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    ...(full ? ({ month: "short", day: "numeric", year: "numeric" } as const) : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    hour12: full
  }).format(new Date(value));
}
