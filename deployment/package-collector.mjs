import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const files = [
  "soe-diagnostics",
  "read-source",
  ...(await readdir("collector/lib"))
    .filter((n) => n.endsWith(".zsh"))
    .map((n) => "lib/" + n),
];
const payloads = await Promise.all(
  files.map(async (name) => {
    const bytes = await readFile("collector/" + name);
    return {
      name,
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const header = await readFile("jamf/lifecycle.zsh", "utf8");
let install =
  header +
  `\n# Set API_ORIGIN in your IT-controlled Jamf copy. Updates preserve config.\nAPI_ORIGIN=\${API_ORIGIN:-}\nif [[ ! -f "$ROOT/config.json" ]]; then\n  [[ $API_ORIGIN == https://* && $API_ORIGIN != *[$'\\n\\r\\t \\\"\\\\']* && \${API_ORIGIN#https://} != */* ]] || { print -u2 'Set a valid HTTPS API_ORIGIN before first install'; exit 1; }\nfi\n/bin/mkdir -p "$ROOT" "$LOGS" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"\nfor p in "$ROOT/bin" "$ROOT/credentials" "$ROOT/state" "$ROOT/staging"; do safe_path "$p"; done\nstop_job\nincoming=$(/usr/bin/mktemp -d "$ROOT/.incoming.XXXXXXXX")\ntrap '/bin/rm -rf "$incoming"' EXIT\n/bin/mkdir -p "$incoming/bin/lib"\n`;
for (const p of payloads)
  install += `print -rn -- '${p.base64}' | /usr/bin/base64 -D > "$incoming/bin/${p.name}"\n[[ $(/usr/bin/shasum -a 256 "$incoming/bin/${p.name}" | /usr/bin/awk '{print $1}') == '${p.sha256}' ]] || exit 1\n/bin/zsh -n "$incoming/bin/${p.name}"\n`;
const plist = await readFile("collector/org.soe.diagnostics.collector.plist");
install += `print -rn -- '${plist.toString("base64")}' | /usr/bin/base64 -D > "$incoming/collector.plist"\n/usr/bin/plutil -lint "$incoming/collector.plist" >/dev/null\nif [[ -f "$ROOT/state/ledger.sqlite" ]]; then\n  schema=$(/usr/bin/sqlite3 "$ROOT/state/ledger.sqlite" 'PRAGMA user_version;')\n  [[ $schema -le 1 ]] || { print -u2 'Database newer than collector; refusing downgrade'; exit 1; }\nfi\nif [[ -d "$ROOT/bin" ]]; then\n  safe_path "$ROOT/previous"; /bin/rm -rf "$ROOT/previous"; /bin/mkdir "$ROOT/previous"; /bin/mv "$ROOT/bin" "$ROOT/previous/bin"\nfi\n/bin/mv "$incoming/bin" "$ROOT/bin"\n/bin/chmod -R 755 "$ROOT/bin"\n/bin/chmod 755 "$ROOT"\n/bin/chmod 700 "$ROOT/credentials" "$ROOT/state" "$ROOT/staging" "$LOGS"\nif [[ ! -f "$ROOT/config.json" ]]; then\n  print -r -- '{"_soe_init":true}' > "$incoming/config.json"\n  /usr/bin/plutil -insert schemaVersion -integer 1 "$incoming/config.json"\n  /usr/bin/plutil -remove _soe_init "$incoming/config.json"\n  /usr/bin/plutil -insert apiOrigin -string "$API_ORIGIN" "$incoming/config.json"\n  /usr/bin/plutil -convert json "$incoming/config.json"\n  /bin/mv "$incoming/config.json" "$ROOT/config.json"\nfi\n/bin/chmod 600 "$ROOT/config.json"\n/bin/mkdir -p /Library/LaunchDaemons\n/bin/mv "$incoming/collector.plist" "$PLIST"\n/bin/chmod 644 "$PLIST"\n/bin/chown -R root:wheel "$ROOT" "$LOGS"\n/bin/chown root:wheel "$PLIST"\nprint -r -- '${version}' > "$ROOT/state/installed-version"\n/bin/launchctl bootstrap system "$PLIST"\n/bin/zsh -f "$ROOT/bin/soe-diagnostics" status --json\nprint 'SOE Diagnostics installed. Enrollment is a separately scoped Jamf step.'\n`;
await mkdir("jamf/releases", { recursive: true });
await writeFile(`jamf/releases/install-${version}.zsh`, install, {
  mode: 0o755,
});
await writeFile(`jamf/releases/update-${version}.zsh`, install, {
  mode: 0o755,
});
await mkdir("public/collector", { recursive: true });
await writeFile("public/collector/install.zsh", install);
await writeFile(
  "jamf/releases/uninstall.zsh",
  header + "\n" + (await readFile("jamf/uninstall-body.zsh", "utf8")),
  { mode: 0o755 },
);
const manifest = {
  version,
  schemaVersion: 1,
  files: payloads.map(({ name, sha256 }) => ({ name, sha256 })),
};
await writeFile(
  "jamf/releases/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
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
          createHash("sha256")
            .update(await readFile("jamf/releases/" + name))
            .digest("hex") +
          "  " +
          name,
      ),
    )
  ).join("\n") + "\n",
);
console.log(
  `Built ${version}: embedded installer, updater, offline uninstaller, manifest, checksums.`,
);
