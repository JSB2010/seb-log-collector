// Execute the real management worker against disposable paths and fake transport.
// Production paths, launchd and ownership guards are rewritten only in this test.
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
assert.equal(process.platform, "darwin");
assert.notEqual(process.getuid(), 0);
const lab = await mkdtemp(join(tmpdir(), "soe-remote-fixture-"));
const worker = await readFile("collector/management-worker.zsh", "utf8");
try {
  for (const test of [
    "same",
    "newer",
    "bad-hash",
    "older",
    "download-failed",
    "installer-failed",
    "uninstall",
    "uninstall-failed",
    "busy",
    "ack-offline",
  ]) {
    const dir = join(lab, test),
      root = join(dir, "root"),
      work = join(dir, "work");
    await mkdir(join(root, "state"), { recursive: true });
    await mkdir(work, { mode: 0o700 });
    const id = "11111111-1111-4111-a111-111111111111";
    const target = "0.3.0";
    await writeFile(join(root, "state/management-active"), id);
    await writeFile(join(root, "state/outcome"), "management_running");
    await writeFile(
      join(root, "state/installed-version"),
      test === "same" ? "0.3.0" : test === "older" ? "1.0.0" : "0.2.1",
    );
    await writeFile(join(root, "config.json"), "preserve-config");
    await writeFile(join(root, "state/ledger.fixture"), "preserve-ledger");
    await writeFile(
      join(work, "device.json"),
      JSON.stringify({ installationId: id, secret: "a".repeat(43) }),
    );
    const installer = `#!/bin/zsh -f\n${test === "installer-failed" ? "exit 1" : `print '0.3.0' > '${root}/state/installed-version'`}\n`;
    await writeFile(join(dir, "installer.zsh"), installer);
    const digest = createHash("sha256").update(installer).digest("hex");
    await writeFile(
      join(work, "command.json"),
      JSON.stringify({
        id,
        action: test.startsWith("uninstall") ? "uninstall" : "update",
        origin: "https://diagnostics.example.org",
        version: target,
        sha256: test === "bad-hash" ? "0".repeat(64) : digest,
        path: `/collector/releases/${target}/install.zsh`,
      }),
    );
    await writeFile(
      join(work, "uninstall.zsh"),
      `#!/bin/zsh -f\n[[ $SOE_MANAGED_UNINSTALL == 1 ]] || exit 1\n${test === "uninstall-failed" ? "exit 1" : `/bin/rm -rf '${root}'`}\n`,
    );
    const curl = join(dir, "curl");
    await writeFile(
      curl,
      `#!/bin/zsh -f\nif [[ $* == *ack.curl* ]]; then\n /bin/cat '${work}/ack.json' >> '${dir}/acks'; print >> '${dir}/acks'\n ${test === "ack-offline" ? "print 000; exit 1" : `/bin/cp '${work}/ack.json' '${dir}/last-ack'; print -rn 200; exit 0`}\nfi\n${test === "download-failed" ? "exit 1" : `/bin/cp '${dir}/installer.zsh' '${work}/install.zsh'`}\n`,
      { mode: 0o755 },
    );
    const sleep = join(dir, "sleep");
    await writeFile(
      sleep,
      "#!/bin/zsh -f\n[[ $1 != 300 ]] || exec /bin/sleep 60\nexit 0\n",
      { mode: 0o755 },
    );
    const pgrep = join(dir, "pgrep");
    await writeFile(pgrep, `#!/bin/zsh -f\nexit ${test === "busy" ? 0 : 1}\n`, {
      mode: 0o755,
    });
    const launchctl = join(dir, "launchctl");
    await writeFile(launchctl, "#!/bin/zsh -f\nexit 0\n", { mode: 0o755 });
    let source = worker
      .replace("[[ $EUID == 0 ]] || exit 1", "[[ $EUID != 0 ]] || exit 1")
      .replaceAll("/Library/Application Support/SOEDiagnostics", root)
      .replace(
        "[[ $work == /private/var/tmp/SafeOnlineExamLogs-management.[A-Za-z0-9]## && -d $work && ! -L $work && $(/usr/bin/stat -f '%u:%Lp' \"$work\") == 0:700 ]] || exit 1",
        `[[ $work == '${work}' && -d $work && ! -L $work ]] || exit 1`,
      )
      .replaceAll("/usr/bin/curl", curl)
      .replaceAll("/bin/sleep", sleep)
      .replaceAll("/usr/bin/pgrep", pgrep)
      .replaceAll("/bin/launchctl", launchctl);
    const script = join(dir, "worker.zsh");
    await writeFile(script, source);
    let code = 0;
    try {
      execFileSync("/bin/zsh", ["-f", script, work], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status ?? 1;
    }
    if (test === "uninstall") {
      assert.equal(code, 0);
      await assert.rejects(readFile(join(root, "config.json")));
      assert.deepEqual(
        JSON.parse(await readFile(join(dir, "last-ack"), "utf8")),
        { state: "completed", result: "removed" },
      );
    } else {
      assert.equal(
        await readFile(join(root, "config.json"), "utf8"),
        "preserve-config",
      );
      assert.equal(
        await readFile(join(root, "state/ledger.fixture"), "utf8"),
        "preserve-ledger",
      );
      if (test === "ack-offline") {
        assert.notEqual(code, 0);
        assert.ok(
          await readFile(join(root, "state/management-result.json"), "utf8"),
        );
      } else {
        const result = JSON.parse(
          await readFile(join(dir, "last-ack"), "utf8"),
        );
        assert.equal(
          result.state,
          ["same", "newer"].includes(test)
            ? "completed"
            : test === "busy"
              ? "deferred"
              : "failed",
        );
        if (["same", "newer"].includes(test))
          assert.equal(result.version, target);
        if (test === "bad-hash")
          assert.equal(result.result, "checksum_mismatch");
      }
    }
    if (test !== "uninstall") {
      assert.equal(
        await readFile(join(root, "state/outcome"), "utf8"),
        "idle\n",
      );
      await assert.rejects(readFile(join(root, "state/management-active")));
    }
    await assert.rejects(
      readFile(join(work, "device.json")),
      "Temporary credentials must always be removed",
    );
  }
  console.log(
    "Native remote-management worker passed: same/newer update, downgrade/hash/download/install rejection, busy deferral, offline result persistence, successful/failed removal, credential cleanup. Transport and launchd were isolated.",
  );
} finally {
  await rm(lab, { recursive: true, force: true });
}
