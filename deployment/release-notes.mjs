import { readFile } from "node:fs/promises";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const start = `## ${version}\n`;
if (!changelog.includes(start))
  throw new Error("Release requires a matching changelog entry");
const notes = changelog.split(start)[1].split("\n## ")[0].trim();
console.log(
  notes +
    '\n\nGeneric scripts contain no deployment origin or enrollment token. For new devices, use the scoped installer from your dashboard’s Enrollment page. For manual execution use `sudo /bin/zsh -f "path/to/script.zsh"`. Verify downloads against `SHA256SUMS`.',
);
