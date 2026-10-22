// SEB macOS log filenames use UTC even when the log lines use local time.
// File mtime is only a fallback: an exam log may be modified hours after start.
export function logDate(
  source: { basename?: string; mtime: string },
  _timezone?: string,
) {
  const match = source.basename?.match(
    / (\d{4})-(\d{2})-(\d{2})--(\d{2})-(\d{2})-(\d{2})-(\d{3})\.log$/,
  );
  if (match) {
    const [, year, month, day, hour, minute, second, millis] = match;
    const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
    const parsed = new Date(stamp);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === stamp)
      return { logStartedAt: stamp, logDateBasis: "filename" };
  }
  return { logStartedAt: source.mtime, logDateBasis: "modified" };
}
