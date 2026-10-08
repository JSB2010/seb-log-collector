import { readFile } from "node:fs/promises";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:3000";
const adminHeaders = {
  "x-dev-admin": "true",
  "content-type": "application/json",
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function request(path, method = "GET", data, headers = adminHeaders) {
  const r = await fetch(origin + path, {
    method,
    headers,
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await r.json();
  assert.ok(r.ok, JSON.stringify({ path, status: r.status, result: b }));
  return b;
}
const metadata = {
  collectorVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  managementProtocol: 1,
  architecture: "arm64",
  macOSVersion: "26",
  macOSBuild: "SYNTHETIC",
  sebVersion: "3.7.1",
  timezone: "Etc/UTC",
  reportedAt: new Date().toISOString(),
};
const serials = ["SYNTHETIC001", "SYNTHETIC002", "SYNTHETIC003"];
const batch = await request("/api/admin/v1/enrollment-batches", "POST", {
  label: "Pilot fixture",
  ceiling: serials.length,
  days: 1,
});
for (let i = 0; i < serials.length; i++) {
  const installationId = randomUUID(),
    secret = randomBytes(32),
    headers = {
      authorization: `Bearer ${installationId}.${secret.toString("base64url")}`,
      "content-type": "application/json",
    };
  const enroll = await request(
    "/api/device/v1/enroll",
    "POST",
    {
      schemaVersion: 1,
      installationId,
      serial: serials[i],
      credentialHash: hash(secret),
      metadata: { ...metadata, computerName: `Example Mac 0${i + 1}` },
    },
    { ...adminHeaders, authorization: `Bearer ${batch.code}` },
  );
  if (i === 1)
    await request(`/api/admin/v1/devices/${enroll.deviceId}`, "PATCH", {
      state: "paused",
    });
  else
    await request(
      "/api/device/v1/collections",
      "POST",
      {
        schemaVersion: 1,
        collectionId: randomUUID(),
        reason: "daily",
        startedAt: new Date().toISOString(),
        outcome: i === 2 ? "deferred" : "no_logs",
        metadata: { ...metadata, computerName: `Example Mac 0${i + 1}` },
      },
      headers,
    );
  const denied = await fetch(origin + "/api/admin/v1/logs", { headers });
  assert.equal(denied.status, 401);
}
await request("/api/admin/v1/admins", "POST", {
  email: "it@example.org",
  active: true,
});
await request("/api/admin/v1/admins", "POST", {
  email: "second@example.org",
  active: true,
});
await request("/api/admin/v1/admins", "POST", {
  email: "second@example.org",
  active: false,
});
const last = await fetch(origin + "/api/admin/v1/admins", {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({ email: "it@example.org", active: false }),
});
assert.equal(last.status, 409);
const fleet = await request("/api/admin/v1/devices");
assert.equal(fleet.items.length, 3);
console.log(
  "Local API smoke passed: 3 synthetic devices, enrollment, health reports, pause, denied device retrieval, live admin grants/removal, last-admin protection.",
);
