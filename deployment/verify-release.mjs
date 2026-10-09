import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const tag = process.env.RELEASE_TAG;
if (tag) assert.equal(tag, `v${version}`, "Tag and package version must match");
const dir = `dist/collector/${version}`;
const expected = [
  "install",
  "update",
  "uninstall",
  "collect-now",
  "pause",
  "resume",
].map((action) => `safe-online-exam-logs-${version}-${action}.zsh`);
expected.push("manifest.json", "SHA256SUMS");
assert.deepEqual((await readdir(dir)).sort(), expected.sort());
const sums = (await readFile(`${dir}/SHA256SUMS`, "utf8")).trim().split("\n");
assert.equal(sums.length, expected.length - 1);
const names = new Set();
for (const line of sums) {
  const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/);
  assert.ok(match, "Invalid checksum entry");
  const [, digest, name] = match;
  assert.ok(
    expected.includes(name) && name !== "SHA256SUMS" && !names.has(name),
  );
  names.add(name);
  const bytes = await readFile(`${dir}/${name}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
  if (name.endsWith(".zsh")) {
    const source = bytes.toString();
    assert.ok(source.startsWith("#!/bin/zsh -f\n"));
    assert.ok(source.includes('if [ -z "${ZSH_VERSION:-}" ]'));
    assert.ok(
      !/^# BEGIN ENROLLMENT BOOTSTRAP$/m.test(source),
      "Public artifacts must have no bootstrap",
    );
    assert.ok(
      !source.includes("base64 -D"),
      "Executable payloads must be readable",
    );
  }
}
const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
assert.equal(manifest.version, version);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.installer.path, "/collector/install.zsh");
const installer = await readFile(
  `${dir}/safe-online-exam-logs-${version}-install.zsh`,
);
assert.equal(
  manifest.installer.sha256,
  createHash("sha256").update(installer).digest("hex"),
);
assert.deepEqual(await readFile("public/collector/install.zsh"), installer);
assert.deepEqual(
  await readFile(`public/collector/releases/${version}/install.zsh`),
  installer,
);
console.log(
  `Verified ${tag || version}: all release assets, manifest, runtime and installer checksums match.`,
);
