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
    .replace(guard, "[[ $EUID != 0 ]] || exit 1")
    .replaceAll("/Library/Application Support/SOEDiagnostics", root)
    .replaceAll("/Library/Logs/SOEDiagnostics", `${lab}/logs`)
    .replaceAll("/Library/LaunchDaemons", `${lab}/launchd`)
    .replaceAll("/bin/launchctl", launchctl)
    .replaceAll("/usr/bin/pgrep", pgrep)
    .replaceAll("root:wheel", `${process.getuid()}:${process.getgid()}`);
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
  console.log(
    "Generated installer fixtures passed: fresh extraction, native chmod/chown, status, partial-install recovery, preserved config/credential/ledger/staging/pause. Launchd and process controls were mocked.",
  );
} finally {
  await rm(lab, { recursive: true, force: true });
}
