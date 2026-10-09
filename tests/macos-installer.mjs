// Exercise the generated payload in a workspace sandbox. Never register launchd
// or change /Library: privileged paths, ownership and process controls are isolated.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
assert.equal(process.platform, "darwin");
assert.notEqual(process.getuid(), 0, "Run fixture as an ordinary user");
await mkdir(".local", { recursive: true });
const lab = await mkdtemp(resolve(".local/installer-fixture-"));
const root = `${lab}/.local/collector-test`;
const { version } = JSON.parse(await readFile("package.json", "utf8"));
try {
  const launchctl = `${lab}/launchctl`,
    pgrep = `${lab}/pgrep`;
  await writeFile(
    launchctl,
    '#!/bin/zsh -f\nprint -r -- "$1" >> "$SOE_FIXTURE_CALLS"\n[[ $1 != print ]]\n',
    { mode: 0o755 },
  );
  await writeFile(pgrep, "#!/bin/zsh -f\nexit 1\n", { mode: 0o755 });
  let source = await readFile(
    `dist/collector/${version}/safe-online-exam-logs-${version}-install.zsh`,
    "utf8",
  );
  const guard = "[[ $EUID == 0 ]] || { print -u2 'Root required'; exit 1; }";
  assert.ok(source.includes(guard));
  source = source
    .replaceAll(guard, "[[ $EUID != 0 ]] || exit 1")
    .replaceAll("/Library/Application Support/SOEDiagnostics", root)
    .replaceAll("/Library/Logs/SOEDiagnostics", `${lab}/logs`)
    .replaceAll("/Library/LaunchDaemons", `${lab}/launchd`)
    .replaceAll("/bin/launchctl", launchctl)
    .replaceAll("/usr/bin/pgrep", pgrep)
    .replaceAll("root:wheel", `${process.getuid()}:${process.getgid()}`);
  // Plain-source payloads now contain fixture paths. Verify each release hash,
  // then re-hash only the isolated, path-rewritten fixture payload.
  const original = await readFile(
    `dist/collector/${version}/safe-online-exam-logs-${version}-install.zsh`,
    "utf8",
  );
  const literal =
    /<<'(SOE_FILE_[a-f0-9]+)'\n([\s\S]*?)\n\1\n(\[\[ .*?== ')([a-f0-9]{64})(' \]\])/g;
  let verified = 0;
  original.replace(literal, (_, marker, body, prefix, digest) => {
    assert.equal(
      createHash("sha256")
        .update(body + "\n")
        .digest("hex"),
      digest,
    );
    verified++;
  });
  assert.ok(verified >= 15, "Every readable payload has a verified checksum");
  source = source.replace(
    literal,
    (_, marker, body, prefix, digest, suffix) =>
      `<<'${marker}'\n${body}\n${marker}\n${prefix}${createHash("sha256")
        .update(body + "\n")
        .digest("hex")}${suffix}`,
  );
  assert.ok(!source.includes("base64 -D"));
  const script = `${lab}/install.zsh`;
  await writeFile(script, source);
  const env = {
    ...process.env,
    API_ORIGIN: "https://diagnostics.example.org",
    SOE_TEST_MODE: "1",
    SOE_TEST_ROOT: root,
    SOE_FIXTURE_CALLS: `${lab}/calls`,
  };
  function install() {
    return execFileSync("/bin/zsh", ["-f", script], { env, encoding: "utf8" });
  }
  for (const shell of ["/bin/sh", "/bin/bash"]) {
    assert.throws(
      () => execFileSync(shell, [script], { env, encoding: "utf8" }),
      /requires zsh/,
    );
    await assert.rejects(stat(root), { code: "ENOENT" });
    await assert.rejects(stat(`${lab}/calls`), { code: "ENOENT" });
  }
  assert.match(
    install(),
    new RegExp(
      `"collectorVersion"\\s*:\\s*"${version.replaceAll(".", "\\.")}"`,
    ),
  );
  const config = await readFile(`${root}/config.json`, "utf8");
  assert.equal(JSON.parse(config).apiOrigin, env.API_ORIGIN);
  assert.equal((await stat(`${root}/config.json`)).mode & 0o777, 0o600);
  // Recreate the on-disk state left by an earlier/partially completed install.
  const credentials = JSON.stringify({
    deviceId: "fixture-device",
    token: "synthetic-only",
  });
  await writeFile(`${root}/credentials/device.json`, credentials);
  await writeFile(`${root}/state/installed-version`, "0.1.1\n");
  await writeFile(`${root}/state/paused`, "");
  await writeFile(`${root}/staging/fixture.gz`, "synthetic-staging");
  await writeFile(`${root}/bin/old-release-marker`, "prior-binary");
  execFileSync("/usr/bin/sqlite3", [
    `${root}/state/ledger.sqlite`,
    "PRAGMA user_version=1; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('preserved');",
  ]);
  env.API_ORIGIN = "https://other.example.org";
  assert.match(install(), /"enrolled"\s*:\s*true/);
  assert.equal(await readFile(`${root}/config.json`, "utf8"), config);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(
    await readFile(`${root}/state/installed-version`, "utf8"),
    `${version}\n`,
  );
  assert.equal(
    await readFile(`${root}/previous/bin/old-release-marker`, "utf8"),
    "prior-binary",
  );
  assert.equal(
    await readFile(`${root}/staging/fixture.gz`, "utf8"),
    "synthetic-staging",
  );
  await stat(`${root}/state/paused`);
  assert.equal(
    execFileSync(
      "/usr/bin/sqlite3",
      [`${root}/state/ledger.sqlite`, "SELECT value FROM fixture;"],
      { encoding: "utf8" },
    ).trim(),
    "preserved",
  );
  assert.equal(
    (await readFile(`${lab}/calls`, "utf8"))
      .split("\n")
      .filter((line) => line === "bootstrap").length,
    2,
  );
  for (const name of [
    "Collect Now",
    "Status",
    "Update",
    "Reinstall",
    "Uninstall",
    "Pause",
    "Resume",
  ]) {
    assert.equal((await stat(`${root}/${name}.command`)).mode & 0o777, 0o755);
    assert.match(
      await readFile(`${root}/${name}.command`, "utf8"),
      /\/usr\/bin\/sudo -- \/bin\/zsh -f/,
    );
  }
  assert.equal((await stat(`${root}/support`)).mode & 0o777, 0o700);
  // Exactly the stale Jamf scenario: 1.0.0 must not replace an installed 1.0.1.
  const currentBinary = await readFile(`${root}/bin/soe-diagnostics`, "utf8");
  const [major, minor, patch] = version.split(".").map(Number);
  const newerVersion = `${major}.${minor}.${patch + 1}`;
  const newerBinary = currentBinary.replace(
    `typeset -r VERSION=${version}`,
    `typeset -r VERSION=${newerVersion}`,
  );
  await writeFile(`${root}/bin/soe-diagnostics`, newerBinary);
  await writeFile(`${root}/state/installed-version`, `${newerVersion}\n`);
  const beforeCalls = await readFile(`${lab}/calls`, "utf8");
  const recovery = await readFile(`${root}/support/installer.zsh`, "utf8");
  const previous = await readFile(
    `${root}/previous/bin/old-release-marker`,
    "utf8",
  );
  assert.match(
    install(),
    new RegExp(
      `Keeping newer Safe Online Exam Logs ${newerVersion.replaceAll(".", "\\.")}`,
    ),
  );
  assert.equal(
    await readFile(`${root}/bin/soe-diagnostics`, "utf8"),
    newerBinary,
  );
  assert.equal(
    await readFile(`${root}/state/installed-version`, "utf8"),
    `${newerVersion}\n`,
  );
  assert.equal(
    await readFile(`${root}/support/installer.zsh`, "utf8"),
    recovery,
  );
  assert.equal(
    await readFile(`${root}/previous/bin/old-release-marker`, "utf8"),
    previous,
  );
  assert.equal(await readFile(`${lab}/calls`, "utf8"), beforeCalls);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(await readFile(`${root}/config.json`, "utf8"), config);
  assert.equal(
    await readFile(`${root}/staging/fixture.gz`, "utf8"),
    "synthetic-staging",
  );
  await stat(`${root}/state/paused`);
  // A missing/truncated marker falls back to the binary version, still without a downgrade.
  await writeFile(`${root}/state/installed-version`, "");
  assert.match(
    install(),
    new RegExp(
      `Keeping newer Safe Online Exam Logs ${newerVersion.replaceAll(".", "\\.")}`,
    ),
  );
  assert.equal(
    await readFile(`${root}/bin/soe-diagnostics`, "utf8"),
    newerBinary,
  );
  assert.equal(await readFile(`${lab}/calls`, "utf8"), beforeCalls);
  // Scoped stale enrollment still invokes enrollment on the preserved newer code.
  const { enrollmentInstaller } =
    await import("../src/components/enrollment.ts");
  const stub =
    'if [[ $CMD == enroll ]]; then /bin/cat > "$ROOT/state/fixture-bootstrap"; exit 0; fi\n';
  await writeFile(
    `${root}/bin/soe-diagnostics`,
    newerBinary.replace("case $CMD in", stub + "case $CMD in"),
  );
  const scoped = `${lab}/enroll.zsh`;
  const code = "a".repeat(43);
  await writeFile(
    scoped,
    enrollmentInstaller(
      source.replaceAll(launchctl, "/bin/launchctl"),
      code,
      "https://diagnostics.example.org",
    ).replaceAll("/bin/launchctl", launchctl),
  );
  assert.match(
    execFileSync("/bin/zsh", ["-f", scoped], { env, encoding: "utf8" }),
    /Keeping newer/,
  );
  assert.equal(await readFile(`${root}/state/fixture-bootstrap`, "utf8"), code);
  assert.equal(await readFile(`${lab}/calls`, "utf8"), beforeCalls);
  // Conflicting records choose the newer value; unreadable versions fail closed.
  await writeFile(`${root}/bin/soe-diagnostics`, currentBinary);
  await writeFile(`${root}/state/installed-version`, `${newerVersion}\n`);
  assert.match(install(), /Keeping newer/);
  await writeFile(`${root}/state/installed-version`, "invalid\n");
  await writeFile(
    `${root}/bin/soe-diagnostics`,
    "#!/bin/zsh\n# unknown release\n",
  );
  assert.throws(install, /Installed version cannot be determined/);
  assert.equal(await readFile(`${lab}/calls`, "utf8"), beforeCalls);
  // Repair the legacy truncated marker using the known binary version.
  await writeFile(`${root}/bin/soe-diagnostics`, currentBinary);
  await writeFile(`${root}/state/installed-version`, "");
  assert.match(install(), /Safe Online Exam Logs installed/);
  assert.equal(
    await readFile(`${root}/state/installed-version`, "utf8"),
    `${version}\n`,
  );
  const manage = `${root}/support/manage.zsh`;
  function maintenance(action) {
    return execFileSync("/bin/zsh", ["-f", manage, action], {
      env,
      encoding: "utf8",
    });
  }
  assert.match(maintenance("status"), new RegExp(`Version: ${version}`));
  assert.match(maintenance("reinstall"), /Safe Online Exam Logs installed/);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(await readFile(`${root}/config.json`, "utf8"), config);
  // Exercise update transport and checksum gates without network or privilege.
  const curl = `${lab}/curl`;
  await writeFile(
    curl,
    `#!/bin/zsh -f
emulate -LR zsh
set -eu
print -r -- "$*" >> "$SOE_FIXTURE_CURL_CALLS"
if [[ $* == *ack.curl* ]]; then
  /bin/cp "$SOE_FIXTURE_REMOTE_WORK/ack.json" "$SOE_FIXTURE_REMOTE_ACK"
  print -rn 200; exit 0
fi
output=''; url=''
while (( $# )); do
  if [[ $1 == --output ]]; then output=$2; shift 2
  else url=$1; shift; fi
done
if [[ $url == */collector/manifest.json ]]; then /bin/cp "$SOE_FIXTURE_MANIFEST" "$output"
elif [[ $url == */collector/install.zsh || $url == */collector/releases/*/install.zsh ]]; then /bin/cp "$SOE_FIXTURE_INSTALLER" "$output"
else exit 22; fi
`,
    { mode: 0o755 },
  );
  env.SOE_FIXTURE_CURL_CALLS = `${lab}/curl-calls`;
  env.SOE_FIXTURE_MANIFEST = `${lab}/manifest.json`;
  env.SOE_FIXTURE_INSTALLER = script;
  const fixtureHash = createHash("sha256").update(source).digest("hex");
  async function manifest(
    release,
    digest = fixtureHash,
    path = "/collector/install.zsh",
  ) {
    await writeFile(
      env.SOE_FIXTURE_MANIFEST,
      JSON.stringify({ version: release, installer: { path, sha256: digest } }),
    );
    const dispatcher = await readFile(manage, "utf8");
    await writeFile(manage, dispatcher.replaceAll("/usr/bin/curl", curl));
  }
  await manifest(version);
  assert.match(maintenance("update"), /Already up to date/);
  await manifest("0.0.1");
  assert.throws(() => maintenance("update"), /refusing downgrade/);
  await manifest(
    newerVersion,
    fixtureHash,
    "https://untrusted.example.org/code",
  );
  assert.throws(() => maintenance("update"), /Invalid update manifest/);
  await manifest(newerVersion, "0".repeat(64));
  assert.throws(() => maintenance("update"), /checksum mismatch/);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(
    await readFile(`${root}/state/installed-version`, "utf8"),
    `${version}\n`,
  );
  await writeFile(`${root}/state/installed-version`, "0.1.3\n");
  await manifest(version);
  assert.match(maintenance("update"), /Safe Online Exam Logs installed/);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(await readFile(`${root}/config.json`, "utf8"), config);
  assert.equal(
    await readFile(`${root}/staging/fixture.gz`, "utf8"),
    "synthetic-staging",
  );
  const calls = await readFile(env.SOE_FIXTURE_CURL_CALLS, "utf8");
  assert.ok(calls.includes("--proto =https --tlsv1.2"));
  assert.ok(!calls.includes("--insecure") && !calls.includes("--location"));
  // The remote worker executes the full generated updater, including code swap,
  // recovery cache and permissions; transport and daemon control remain isolated.
  const remoteWork = `${lab}/remote-work`;
  await mkdir(remoteWork, { mode: 0o700 });
  env.SOE_FIXTURE_REMOTE_WORK = remoteWork;
  env.SOE_FIXTURE_REMOTE_ACK = `${lab}/remote-ack.json`;
  const remoteId = "11111111-1111-4111-a111-111111111111";
  await writeFile(
    `${remoteWork}/device.json`,
    JSON.stringify({ installationId: remoteId, secret: "a".repeat(43) }),
  );
  await writeFile(
    `${remoteWork}/command.json`,
    JSON.stringify({
      id: remoteId,
      action: "update",
      origin: "https://diagnostics.example.org",
      version,
      sha256: fixtureHash,
      path: `/collector/releases/${version}/install.zsh`,
    }),
  );
  await writeFile(`${root}/state/installed-version`, "0.2.1\n");
  let remote = await readFile("collector/management-worker.zsh", "utf8");
  remote = remote
    .replace("[[ $EUID == 0 ]] || exit 1", "[[ $EUID != 0 ]] || exit 1")
    .replaceAll("/Library/Application Support/SOEDiagnostics", root)
    .replace(
      /^\[\[ \$work == .*\]\] \|\| exit 1$/m,
      `[[ $work == '${remoteWork}' && -d $work && ! -L $work ]] || exit 1`,
    )
    .replaceAll("/usr/bin/curl", curl)
    .replaceAll("/usr/bin/pgrep", pgrep)
    .replaceAll("/bin/launchctl", launchctl);
  const remoteScript = `${lab}/remote-worker.zsh`;
  await writeFile(remoteScript, remote);
  execFileSync("/bin/zsh", ["-f", remoteScript, remoteWork], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.deepEqual(
    JSON.parse(await readFile(env.SOE_FIXTURE_REMOTE_ACK, "utf8")),
    { state: "completed", result: "installed", version },
  );
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.equal(await readFile(`${root}/config.json`, "utf8"), config);
  assert.equal(
    await readFile(`${root}/staging/fixture.gz`, "utf8"),
    "synthetic-staging",
  );
  assert.equal(
    await readFile(`${root}/state/installed-version`, "utf8"),
    `${version}\n`,
  );
  await assert.rejects(stat(remoteWork), { code: "ENOENT" });
  // A broken recovery cache must fail before replacing the installation.
  await writeFile(`${root}/support/installer.zsh`, "#!/bin/zsh\nexit 0\n");
  assert.throws(() => maintenance("reinstall"), /checksum mismatch/);
  assert.equal(
    await readFile(`${root}/credentials/device.json`, "utf8"),
    credentials,
  );
  assert.match(maintenance("uninstall"), /removed locally/);
  await assert.rejects(stat(root), { code: "ENOENT" });
  console.log(
    "Generated lifecycle fixtures passed: readable extraction, native tools/permissions, status, repair and update preservation, equal/older/invalid/checksum-rejected updates, and removal. Network, launchd and process controls were mocked.",
  );
} finally {
  await rm(lab, { recursive: true, force: true });
}
