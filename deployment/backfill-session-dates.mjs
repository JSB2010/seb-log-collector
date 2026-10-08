// Upgrade pre-0.2.0 session associations before using chronological indexes.
// Dry run by default. Uses explicit operator account/project, never global config.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
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
const apply = process.argv.includes("--apply");
let page = "",
  inspected = 0,
  eligible = 0,
  updated = 0,
  missing = 0;
do {
  const url = new URL(`${base}/sessionLinks`);
  url.searchParams.set("pageSize", "200");
  for (const field of ["acceptedAt", "logId", "expiresAt"])
    url.searchParams.append("mask.fieldPaths", field);
  if (page) url.searchParams.set("pageToken", page);
  const response = await fetch(url, { headers });
  assert.ok(response.ok, `Association listing failed (${response.status})`);
  const data = await response.json();
  for (const link of data.documents ?? []) {
    inspected++;
    if (
      link.fields?.acceptedAt ||
      link.fields?.expiresAt?.stringValue <= new Date().toISOString()
    )
      continue;
    const id = link.fields?.logId?.stringValue;
    assert.match(id ?? "", /^[A-Za-z0-9_-]{1,100}$/);
    const log = await fetch(`${base}/logs/${id}?mask.fieldPaths=acceptedAt`, {
      headers,
    });
    if (log.status === 404) {
      missing++;
      continue;
    }
    assert.ok(log.ok, `Log metadata lookup failed (${log.status})`);
    const value = (await log.json()).fields?.acceptedAt;
    assert.ok(
      value?.stringValue && !Number.isNaN(Date.parse(value.stringValue)),
      "Log acceptance time missing",
    );
    eligible++;
    if (apply) {
      const patch = new URL(`https://firestore.googleapis.com/v1/${link.name}`);
      patch.searchParams.set("updateMask.fieldPaths", "acceptedAt");
      patch.searchParams.set("currentDocument.updateTime", link.updateTime);
      const result = await fetch(patch, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fields: { acceptedAt: value } }),
      });
      assert.ok(
        result.ok,
        `Association changed or patch failed (${result.status}); retry safely`,
      );
      updated++;
    }
  }
  page = data.nextPageToken ?? "";
} while (page);
console.log(
  JSON.stringify({ dryRun: !apply, inspected, eligible, updated, missing }),
);
