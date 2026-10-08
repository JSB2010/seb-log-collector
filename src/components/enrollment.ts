// Readable self-contained installer; batch credentials are inserted server-side.
export function enrollmentInstaller(
  source: string,
  code: string,
  origin: string,
) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(code) ||
    !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin)
  )
    throw new Error("invalid_installer_configuration");
  const marker = "API_ORIGIN=${API_ORIGIN:-}";
  if (!source.startsWith("#!/bin/zsh -f") || !source.includes(marker))
    throw new Error("installer_unavailable");
  // The daemon can briefly hold the collector lock immediately after bootstrap.
  // Deliver enrollment before starting it so install-and-enroll is deterministic.
  const start = '/bin/launchctl bootstrap system "$PLIST"';
  if (!source.includes(start)) throw new Error("installer_unavailable");
  return source
    .replace(marker, `API_ORIGIN='${origin}'`)
    .replace(
      start,
      `# BEGIN ENROLLMENT BOOTSTRAP\n# Deliver only to the intended devices. Closing the enrollment disables new registrations.\nif ! print -rn -- '${code}' | /bin/zsh -f "$ROOT/bin/soe-diagnostics" enroll --bootstrap-stdin; then\n  ${start}\n  print -u2 'Enrollment pending; the daemon retries while the enrollment is open.'\n  exit 1\nfi\n# END ENROLLMENT BOOTSTRAP\n${start}`,
    );
}
