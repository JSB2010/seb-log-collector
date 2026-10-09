import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const generate = () =>
  execFileSync(process.execPath, ["deployment/package-collector.mjs"], {
    stdio: "pipe",
  });
generate();
const sums = await readFile(`dist/collector/${version}/SHA256SUMS`, "utf8");
generate();
assert.equal(
  await readFile(`dist/collector/${version}/SHA256SUMS`, "utf8"),
  sums,
  "Packaging must be reproducible",
);
execFileSync(process.execPath, ["deployment/verify-release.mjs"], {
  stdio: "inherit",
  env: { ...process.env, RELEASE_TAG: `v${version}` },
});
assert.throws(
  () =>
    execFileSync(process.execPath, ["deployment/verify-release.mjs"], {
      stdio: "pipe",
      env: { ...process.env, RELEASE_TAG: "v9.9.9" },
    }),
  /Tag and package version must match/,
);
const tracked = execFileSync(
  "git",
  ["ls-files", "public/collector", "jamf/releases", "dist"],
  { encoding: "utf8" },
);
assert.equal(
  tracked.trim(),
  "",
  "Generated release artifacts must stay out of source control",
);
console.log(
  "Release checks passed: deterministic generation, tag validation, complete checksums and source-only tracking.",
);
