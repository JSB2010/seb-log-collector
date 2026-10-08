// SEB names contain the Mac's local session start, not the upload timestamp.
export function logDate(
  source: { basename?: string; mtime: string },
  timezone?: string,
) {
  const match = source.basename?.match(
    / (\d{4})-(\d{2})-(\d{2})--(\d{2})-(\d{2})-(\d{2})-(\d{3})\.log$/,
  );
  if (match && timezone) {
    const parts = match.slice(1).map(Number);
    const wall = Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2],
      parts[3],
      parts[4],
      parts[5],
      parts[6],
    );
    const valid =
      new Date(wall).toISOString().slice(0, 23) ===
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}`;
    if (valid)
      try {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        });
        const local = (t: number) => {
          const p = Object.fromEntries(
            fmt.formatToParts(t).map((p) => [p.type, p.value]),
          );
          return Date.UTC(
            +p.year,
            +p.month - 1,
            +p.day,
            +p.hour,
            +p.minute,
            +p.second,
            parts[6],
          );
        };
        // Test offsets on both sides of a DST boundary; ambiguous/nonexistent times
        // use file mtime rather than inventing an unambiguous session timestamp.
        const candidates = [
          ...new Set(
            [-86400000, 0, 86400000].map(
              (delta) => wall - (local(wall + delta) - (wall + delta)),
            ),
          ),
        ].filter((t) => local(t) === wall);
        if (candidates.length === 1)
          return {
            logStartedAt: new Date(candidates[0]).toISOString(),
            logDateBasis: "filename",
          };
      } catch {
        /* Unknown timezone: use the independently recorded file time. */
      }
  }
  return { logStartedAt: source.mtime, logDateBasis: "modified" };
}
