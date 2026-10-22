// Dry-run by default. No global gcloud account/configuration changes.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { logDate } from "../src/server/log-date.ts";
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    account: { type: "string" },
    apply: { type: "boolean", default: false },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node deployment/reindex-log-dates.mjs --project PROJECT --account ACCOUNT [--apply]",
  );
  process.exit(0);
}
if (!values.project || !values.account)
  throw new Error(
    "Explicit --project and --account are required. Omit --apply to preview.",
  );
const token = execFileSync(
  "gcloud",
  [
    "--account=" + values.account,
    "--project=" + values.project,
    "auth",
    "print-access-token",
  ],
  { encoding: "utf8" },
).trim();
const root = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(values.project)}/databases/(default)/documents`;
async function request(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok)
    throw new Error(
      `Firestore returned HTTP ${response.status}; stopped without continuing.`,
    );
  return response.json();
}
let cursor,
  scanned = 0,
  changed = 0;
do {
  const structuredQuery = {
    from: [{ collectionId: "logs" }],
    orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    limit: 500,
    ...(cursor
      ? { startAt: { values: [{ referenceValue: cursor }], before: false } }
      : {}),
  };
  const result = await request(root + ":runQuery", {
    method: "POST",
    body: JSON.stringify({ structuredQuery }),
  });
  const documents = result.flatMap((item) =>
    item.document ? [item.document] : [],
  );
  for (const document of documents) {
    scanned++;
    const fields = document.fields,
      source = fields.source?.mapValue?.fields;
    if (!source?.basename?.stringValue || !source.mtime?.stringValue) continue;
    const corrected = logDate({
      basename: source.basename.stringValue,
      mtime: source.mtime.stringValue,
    });
    if (
      corrected.logDateBasis !== "filename" ||
      fields.logStartedAt?.stringValue === corrected.logStartedAt
    )
      continue;
    changed++;
    if (values.apply) {
      const path = document.name
        .split("/documents/")[1]
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const query = new URLSearchParams([
        ["updateMask.fieldPaths", "logStartedAt"],
        ["updateMask.fieldPaths", "logDateBasis"],
        ["currentDocument.updateTime", document.updateTime],
      ]);
      await request(root + "/" + path + "?" + query, {
        method: "PATCH",
        body: JSON.stringify({
          fields: {
            logStartedAt: { stringValue: corrected.logStartedAt },
            logDateBasis: { stringValue: corrected.logDateBasis },
          },
        }),
      });
    }
  }
  cursor = documents.length === 500 ? documents.at(-1).name : undefined;
} while (cursor);
console.log(
  JSON.stringify({
    mode: values.apply ? "applied" : "dry-run",
    scanned,
    changed,
  }),
);
