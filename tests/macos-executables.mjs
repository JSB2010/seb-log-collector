// Resolve absolute native commands in the actual shipped scripts on a real Mac.
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import assert from "node:assert/strict";
assert.equal(process.platform, "darwin", "Run this check on macOS");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const scripts = [
  "collector/soe-diagnostics",
  "collector/read-source",
  ...(await readdir("collector/lib"))
    .filter((f) => f.endsWith(".zsh"))
    .map((f) => `collector/lib/${f}`),
  "jamf/lifecycle.zsh",
  "jamf/uninstall-body.zsh",
  `jamf/releases/install-${version}.zsh`,
  `jamf/releases/update-${version}.zsh`,
  "jamf/releases/uninstall.zsh",
  "public/collector/install.zsh",
];
const commands = new Set();
const missing = [];
for (const script of scripts) {
  const source = await readFile(script, "utf8");
  // Exclude suffixes of project-owned paths such as $ROOT/bin/lib.
  for (const match of source.matchAll(
    /(?<![A-Za-z0-9_$}/])\/(?:usr\/(?:sbin|bin)|sbin|bin)\/[A-Za-z0-9._+-]+/g,
  )) {
    commands.add(match[0]);
    await access(match[0], constants.X_OK).catch(() => {
      missing.push(`${script}: missing executable ${match[0]}`);
    });
  }
}
assert.deepEqual(missing, [], missing.join("\n"));
console.log(
  `Verified ${commands.size} native executable paths in ${scripts.length} shipped scripts.`,
);
