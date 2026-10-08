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
  let source = await readFile(`jamf/releases/install-${version}.zsh`, "utf8");
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
    `jamf/releases/install-${version}.zsh`,
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
output=''; url=''
while (( $# )); do
  if [[ $1 == --output ]]; then output=$2; shift 2
  else url=$1; shift; fi
done
if [[ $url == */collector/manifest.json ]]; then /bin/cp "$SOE_FIXTURE_MANIFEST" "$output"
elif [[ $url == */collector/install.zsh ]]; then /bin/cp "$SOE_FIXTURE_INSTALLER" "$output"
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
  await manifest("1.0.0", fixtureHash, "https://untrusted.example.org/code");
  assert.throws(() => maintenance("update"), /Invalid update manifest/);
  await manifest("1.0.0", "0".repeat(64));
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
