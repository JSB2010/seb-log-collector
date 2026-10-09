import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Only immutable, checksum-pinned installers are restored. Never follow "latest".
export async function restoreHistory(currentVersion) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const repository =
    process.env.COLLECTOR_RELEASE_REPOSITORY ||
    pkg.repository.url.replace("https://github.com/", "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid collector release repository");
  const history = JSON.parse(
    await readFile("deployment/collector-history.json", "utf8"),
  );
  if (history.schemaVersion !== 1)
    throw new Error("Invalid collector history schema");
  for (const release of history.installers) {
    if (
      !/^\d+\.\d+\.\d+$/.test(release.version) ||
      !/^[A-Za-z0-9.-]+\.zsh$/.test(release.asset) ||
      !/^[a-f0-9]{64}$/.test(release.sha256) ||
      release.version === currentVersion
    )
      throw new Error("Invalid pinned collector history");
    const path = `public/collector/releases/${release.version}/install.zsh`;
    let bytes = await readFile(path).catch(() => null);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    if (!bytes || digest(bytes) !== release.sha256) {
      const response = await fetch(
        `https://github.com/${repository}/releases/download/v${release.version}/${release.asset}`,
        {
          signal: AbortSignal.timeout(90000),
        },
      );
      if (!response.ok)
        throw new Error(
          `Historical installer ${release.version}: HTTP ${response.status}`,
        );
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length > 2097152 || digest(bytes) !== release.sha256)
      throw new Error(
        `Historical installer ${release.version}: checksum mismatch`,
      );
    await mkdir(`public/collector/releases/${release.version}`, {
      recursive: true,
    });
    await writeFile(path, bytes);
    console.log(`Verified historical installer ${release.version}`);
  }
}
