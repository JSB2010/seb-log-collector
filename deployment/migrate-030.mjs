// One atomic, preconditioned migration for an existing pilot catalog.
// Dry run by default; explicit account/project required. Never changes CLI config.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { logDate } from "../src/server/log-date.ts";
const account = process.env.GCP_ACCOUNT,
  project = process.env.GCP_PROJECT;
assert.ok(account && project, "Set GCP_ACCOUNT and GCP_PROJECT explicitly");
const token = execFileSync(
  "gcloud",
  [
    "auth",
    "print-access-token",
    `--account=${account}`,
    `--project=${project}`,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
async function list(collection) {
  const items = [];
  let page = "";
  do {
    const url = new URL(`${base}/${collection}`);
    url.searchParams.set("pageSize", "1000");
    if (page) url.searchParams.set("pageToken", page);
    const r = await fetch(url, { headers });
    assert.ok(r.ok, `${collection}: ${r.status}`);
    const body = await r.json();
    items.push(...(body.documents ?? []));
    page = body.nextPageToken ?? "";
  } while (page);
  return items;
}
const decode = (v) =>
  v?.stringValue ??
  (v?.integerValue !== undefined
    ? Number(v.integerValue)
    : v?.mapValue
      ? Object.fromEntries(
          Object.entries(v.mapValue.fields ?? {}).map(([k, v]) => [
            k,
            decode(v),
          ]),
        )
      : undefined);
const get = (doc, field) => decode(doc.fields?.[field]);
const encode = (v) =>
  v === null
    ? { nullValue: null }
    : typeof v === "number"
      ? { integerValue: String(v) }
      : { stringValue: v };
const [devices, groups, logs, links, tokens] = await Promise.all(
  [
    "devices",
    "enrollmentBatches",
    "logs",
    "sessionLinks",
    "enrollmentTokens",
  ].map(list),
);
const writes = [];
function patch(doc, values) {
  const fields = Object.fromEntries(
    Object.entries(values)
      .filter(
        ([k, v]) =>
          JSON.stringify(doc.fields?.[k]) !== JSON.stringify(encode(v)),
      )
      .map(([k, v]) => [k, encode(v)]),
  );
  if (Object.keys(fields).length)
    writes.push({
      update: { name: doc.name, fields },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: { updateTime: doc.updateTime },
    });
}
for (const d of devices) {
  const group = get(d, "enrollmentGroupId") ?? get(d, "enrollmentBatchId");
  if (group) patch(d, { enrollmentGroupId: group });
}
for (const g of groups) {
  const id = g.name.split("/").at(-1);
  const count = devices.filter(
    (d) =>
      get(d, "activeInstallation") &&
      (get(d, "enrollmentGroupId") ?? get(d, "enrollmentBatchId")) === id,
  ).length;
  patch(g, { count, expiresAt: null, ttlAt: null });
}
for (const t of tokens) patch(t, { ttlAt: null });
const dates = new Map();
for (const l of logs) {
  const source = get(l, "source");
  assert.ok(source?.mtime, "Log file mtime missing");
  const date = logDate(source, get(l, "metadata")?.timezone);
  dates.set(l.name.split("/").at(-1), date.logStartedAt);
  patch(l, date);
}
for (const link of links) {
  const date = dates.get(get(link, "logId"));
  if (date) patch(link, { logStartedAt: date });
}
// A large fleet must migrate in a maintenance window, with a separately reviewed
// staged migration. Refuse to silently split membership counts across commits.
assert.ok(
  writes.length <= 450,
  "More than 450 changed documents: use a staged migration in a maintenance window",
);
if (process.argv.includes("--apply") && writes.length) {
  const r = await fetch(base + ":commit", {
    method: "POST",
    headers,
    body: JSON.stringify({ writes }),
  });
  assert.ok(
    r.ok,
    `Migration changed concurrently or failed (${r.status}); rerun dry-run before retry`,
  );
}
console.log(
  JSON.stringify({
    dryRun: !process.argv.includes("--apply"),
    devices: devices.length,
    groups: groups.length,
    logs: logs.length,
    links: links.length,
    writes: writes.length,
  }),
);
