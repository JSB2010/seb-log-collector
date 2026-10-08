import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  "soe-diagnostics",
  "read-source",
  ...(await readdir("collector/lib"))
    .filter((n) => n.endsWith(".zsh"))
    .map((n) => "lib/" + n),
];
const payloads = await Promise.all(
  files.map(async (name) => ({
    name,
    dest: "bin/" + name,
    source: await readFile("collector/" + name, "utf8"),
  })),
);
payloads.push({
  name: "support/manage.zsh",
  dest: "support/manage.zsh",
  source: await readFile("collector/manage.zsh", "utf8"),
});
payloads.push({
  name: "support/management-worker.zsh",
  dest: "support/management-worker.zsh",
  source: await readFile("collector/management-worker.zsh", "utf8"),
});
const header = await readFile("jamf/lifecycle.zsh", "utf8");
const uninstall =
  header + "\n" + (await readFile("jamf/uninstall-body.zsh", "utf8"));
payloads.push({
  name: "support/uninstall.zsh",
  dest: "support/uninstall.zsh",
  source: uninstall,
});
const actions = {
  "Collect Now": "collect",
  Status: "status",
  Update: "update",
  Reinstall: "reinstall",
  Uninstall: "uninstall",
  Pause: "pause",
  Resume: "resume",
};
for (const [title, action] of Object.entries(actions)) {
  const source = `#!/bin/zsh -f\nemulate -LR zsh\nexport PATH=/usr/bin:/bin:/usr/sbin:/sbin\nprint 'Safe Online Exam Logs — ${title}'\nresult=0\nif (( EUID != 0 )); then\n  /usr/bin/sudo -- /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' ${action} || result=$?\nelse\n  /bin/zsh -f '/Library/Application Support/SOEDiagnostics/support/manage.zsh' ${action} || result=$?\nfi\nif (( result != 0 )); then print -u2 'The command did not complete. Review the message above.'; fi\nif [[ -t 0 && -t 1 ]]; then read -r '?Press Return to close this window.'; fi\nexit $result\n`;
  payloads.push({ name: title + ".command", dest: title + ".command", source });
}
const readme = `Safe Online Exam Logs\n\nDouble-click a command to open it in Terminal. Administrator authentication is requested by sudo. Touch ID is available if your Mac already enables it for sudo. No authentication settings are changed by this installer.\n\nCollect Now.command — run a bounded collection immediately; Safe Exam Browser must be closed and collection must not be paused.\nStatus.command — show local version, enrollment, collection status and last contact.\nUpdate.command — install a newer checksum-verified release from this Mac's configured HTTPS service.\nReinstall.command — repair the current release offline, preserving enrollment and queued logs.\nUninstall.command — remove the collector; attempt server revocation when online.\nPause.command / Resume.command — control local collection.\n\nbin: internal collector code\nsupport: private recovery scripts\ncredentials, state, staging: private runtime data\n\nThe dashboard queues remote collection for the next check-in (normally every 30 minutes while awake). Update and removal can be queued in the dashboard for the next check-in. Macs running Safe Exam Browser defer these actions. Jamf lifecycle scripts are in Enrollment → Device management. No PATH command is installed.\n`;
payloads.push({ name: "Read Me.txt", dest: "Read Me.txt", source: readme });
function writeLiteral(dest, source, checkShell = false) {
  const marker = "SOE_FILE_" + hash(source).slice(0, 24);
  if (source.split("\n").includes(marker))
    throw new Error("Delimiter collision");
  return `\n# ${dest}\n/bin/cat > "$incoming/${dest}" <<'${marker}'\n${source.endsWith("\n") ? source : source + "\n"}${marker}\n[[ $(/usr/bin/shasum -a 256 < "$incoming/${dest}" | /usr/bin/awk '{print $1}') == '${hash(source.endsWith("\n") ? source : source + "\n")}' ]] || { print -u2 'Payload checksum mismatch'; exit 1; }\n${checkShell ? `/bin/zsh -n "$incoming/${dest}"\n` : ""}`;
}
let install =
  header +
  `
# Set API_ORIGIN in your IT-controlled copy. Updates preserve existing configuration.
API_ORIGIN=\${API_ORIGIN:-}
if [[ ! -f "$ROOT/config.json" ]]; then
  [[ $API_ORIGIN == https://* && $API_ORIGIN != *[$'\\n\\r\\t \\\"\\\\']* && \${API_ORIGIN#https://} != */* && \${API_ORIGIN#https://} != *[@?#]* ]] || { print -u2 'Set a valid HTTPS API_ORIGIN before first install'; exit 1; }
fi
/bin/mkdir -p "$ROOT" "$LOGS" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"
for p in "$ROOT/bin" "$ROOT/support" "$ROOT/previous" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"; do safe_path "$p"; done
incoming=$(/usr/bin/mktemp -d "$ROOT/.incoming.XXXXXXXX")
trap '/bin/rm -rf "$incoming"' EXIT
/bin/mkdir -p "$incoming/bin/lib" "$incoming/support"
`;
for (const p of payloads)
  install += writeLiteral(
    p.dest,
    p.source,
    p.dest.endsWith(".zsh") ||
      p.dest.endsWith(".command") ||
      ["soe-diagnostics", "read-source"].includes(p.name),
  );
install += writeLiteral(
  "collector.plist",
  await readFile("collector/org.soe.diagnostics.collector.plist", "utf8"),
);
install += `
/usr/bin/plutil -lint "$incoming/collector.plist" >/dev/null
if [[ -f "$ROOT/state/ledger.sqlite" ]]; then
  schema=$(/usr/bin/sqlite3 "$ROOT/state/ledger.sqlite" 'PRAGMA user_version;')
  [[ $schema -le 1 ]] || { print -u2 'Database newer than collector; refusing downgrade'; exit 1; }
fi
# Keep a readable, bootstrap-free recovery copy. Its private directory is root-only.
[[ -f $0 && ! -L $0 ]] || { print -u2 'Run the installer from a saved file'; exit 1; }
/usr/bin/sed '/^# BEGIN ENROLLMENT BOOTSTRAP$/,/^# END ENROLLMENT BOOTSTRAP$/d' "$0" > "$incoming/support/installer.zsh"
/usr/bin/shasum -a 256 < "$incoming/support/installer.zsh" | /usr/bin/awk '{print $1}' > "$incoming/support/installer.zsh.sha256"
/usr/bin/shasum -a 256 < "$incoming/support/management-worker.zsh" | /usr/bin/awk '{print $1}' > "$incoming/support/management-worker.zsh.sha256"
/usr/bin/shasum -a 256 < "$incoming/support/uninstall.zsh" | /usr/bin/awk '{print $1}' > "$incoming/support/uninstall.zsh.sha256"
stop_job
if [[ -d "$ROOT/bin" ]]; then
  /bin/rm -rf "$ROOT/previous"; /bin/mkdir "$ROOT/previous"; /bin/mv "$ROOT/bin" "$ROOT/previous/bin"
fi
/bin/mv "$incoming/bin" "$ROOT/bin"
/bin/rm -rf "$ROOT/support"; /bin/mv "$incoming/support" "$ROOT/support"
/bin/chmod -R 755 "$ROOT/bin"
/bin/chmod -R 700 "$ROOT/support"
/bin/chmod 755 "$ROOT"
/bin/chmod 700 "$ROOT/credentials" "$ROOT/state" "$ROOT/staging" "$LOGS"
`;
for (const p of payloads.filter((p) => !p.dest.includes("/")))
  install += `safe_path "$ROOT/${p.dest}"; /bin/mv "$incoming/${p.dest}" "$ROOT/${p.dest}"; /bin/chmod ${p.dest.endsWith(".command") ? "755" : "644"} "$ROOT/${p.dest}"\n`;
install += `
if [[ ! -f "$ROOT/config.json" ]]; then
  print -r -- '{"_soe_init":true}' > "$incoming/config.json"
  /usr/bin/plutil -insert schemaVersion -integer 1 "$incoming/config.json"
  /usr/bin/plutil -remove _soe_init "$incoming/config.json"
  /usr/bin/plutil -insert apiOrigin -string "$API_ORIGIN" "$incoming/config.json"
  /usr/bin/plutil -convert json "$incoming/config.json"
  /bin/mv "$incoming/config.json" "$ROOT/config.json"
fi
/bin/chmod 600 "$ROOT/config.json"
/bin/mkdir -p /Library/LaunchDaemons
/bin/mv "$incoming/collector.plist" "$PLIST"
/bin/chmod 644 "$PLIST"
/usr/sbin/chown -R root:wheel "$ROOT" "$LOGS"
/usr/sbin/chown root:wheel "$PLIST"
print -r -- '${version}' > "$ROOT/state/installed-version"
/bin/launchctl bootstrap system "$PLIST"
/bin/zsh -f "$ROOT/bin/soe-diagnostics" status --json
print 'Safe Online Exam Logs installed. Commands are in the Application Support folder.'
`;
const nativeSources = [install, uninstall, ...payloads.map((p) => p.source)];
const nativeTools = [
  ...new Set(
    nativeSources.flatMap((source) =>
      [
        ...source.matchAll(
          /(?<![A-Za-z0-9_$}/])\/(?:usr\/(?:sbin|bin)|sbin|bin)\/[A-Za-z0-9._+-]+/g,
        ),
      ].map((m) => m[0]),
    ),
  ),
].sort();
const preflight = `\n# Validate native prerequisites before replacing an installed collector.\nfor native_tool in ${nativeTools.join(" ")}; do\n  [[ -x $native_tool ]] || { print -u2 "Missing required native tool: $native_tool"; exit 1; }\ndone\n`;
install = header + preflight + install.slice(header.length);
const update = install.replace(
  "# Set API_ORIGIN",
  `[[ -f "$ROOT/config.json" ]] || { print 'No installed collector to update'; exit 0; }\n# Set API_ORIGIN`,
);
await mkdir("jamf/releases", { recursive: true });
await mkdir("public/collector", { recursive: true });
for (const [name, source] of [
  [`install-${version}.zsh`, install],
  [`update-${version}.zsh`, update],
  ["uninstall.zsh", uninstall],
])
  await writeFile("jamf/releases/" + name, source, { mode: 0o755 });
for (const [name, source] of [
  ["install.zsh", install],
  ["update.zsh", update],
  ["uninstall.zsh", uninstall],
])
  await writeFile("public/collector/" + name, source);
for (const name of ["collect-now", "pause", "resume"])
  await writeFile(
    `public/collector/${name}.zsh`,
    await readFile(`jamf/${name}.zsh`),
  );
await mkdir(`public/collector/releases/${version}`, { recursive: true });
await writeFile(`public/collector/releases/${version}/install.zsh`, install);
const manifest = {
  version,
  schemaVersion: 1,
  installer: { path: "/collector/install.zsh", sha256: hash(install) },
  files: payloads.map(({ name, source }) => ({ name, sha256: hash(source) })),
};
for (const path of [
  "jamf/releases/manifest.json",
  "public/collector/manifest.json",
])
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
const releaseNames = [
  `install-${version}.zsh`,
  `update-${version}.zsh`,
  "uninstall.zsh",
  "manifest.json",
];
await writeFile(
  "jamf/releases/SHA256SUMS",
  (
    await Promise.all(
      releaseNames.map(
        async (name) =>
          hash(await readFile("jamf/releases/" + name)) + "  " + name,
      ),
    )
  ).join("\n") + "\n",
);
console.log(
  `Built ${version}: readable installer/updater, offline recovery and removal, Finder commands, manifest and checksums.`,
);
