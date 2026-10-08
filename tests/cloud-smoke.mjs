// Operator-only synthetic acceptance check. No browser login is claimed here.
// Required: TEST_ORIGIN, TEST_BUCKET, GCP_PROJECT, GCP_ACCOUNT.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { SignJWT } from "jose";
const env = (name) => {
  assert.ok(process.env[name], `Missing ${name}`);
  return process.env[name];
};
const origin = env("TEST_ORIGIN"),
  project = env("GCP_PROJECT"),
  account = env("GCP_ACCOUNT"),
  bucket = env("TEST_BUCKET");
assert.equal(new URL(origin).protocol, "https:");
const flags = [`--account=${account}`, `--project=${project}`];
const cli = (...args) =>
  execFileSync("gcloud", [...args, ...flags], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const access = cli("auth", "print-access-token");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const headers = {
  authorization: `Bearer ${access}`,
  "content-type": "application/json",
};
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/`;
function encode(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, encode(x)]),
      ),
    },
  };
}
function decode(v) {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  return Object.fromEntries(
    Object.entries(v.mapValue?.fields ?? {}).map(([k, x]) => [k, decode(x)]),
  );
}
async function doc(path, value) {
  const r = await fetch(base + path, {
    method: value ? "PATCH" : "GET",
    headers,
    ...(value
      ? { body: JSON.stringify({ fields: encode(value).mapValue.fields }) }
      : {}),
  });
  if (r.status === 404 && !value) return undefined;
  assert.ok(r.ok, `Firestore ${path}: ${r.status}`);
  return decode({ mapValue: { fields: (await r.json()).fields } });
}
const identityResponse = await fetch(
  "https://www.googleapis.com/oauth2/v3/userinfo",
  { headers },
);
assert.ok(identityResponse.ok, "Operator userinfo failed");
const identity = await identityResponse.json();
assert.equal(identity.email, account);
assert.equal(identity.email_verified, true);
const aid = hash(account),
  entry = await doc(`admins/${aid}`),
  settings = await doc("settings/admins");
if (!settings)
  await doc("settings/admins", {
    count: 1,
    seededAt: new Date().toISOString(),
  });
if (entry) {
  assert.equal(entry.active, true);
  assert.ok(!entry.sub || entry.sub === identity.sub);
}
await doc(`admins/${aid}`, {
  ...entry,
  id: aid,
  email: account,
  active: true,
  sub: identity.sub,
  createdAt: entry?.createdAt ?? new Date().toISOString(),
});
const csrf = randomBytes(32).toString("base64url");
const key = cli(
  "secrets",
  "versions",
  "access",
  "latest",
  "--secret=diagnostics-session",
);
const session = await new SignJWT({
  email: account,
  sub: identity.sub,
  csrf,
  purpose: "session",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer(origin)
  .setAudience("session")
  .setIssuedAt()
  .setExpirationTime("15m")
  .sign(new TextEncoder().encode(key));
const adminHeaders = {
  "content-type": "application/json",
  cookie: `soe_session=${session}`,
  origin,
  "x-csrf-token": csrf,
};
const evidence = {
  startedAt: new Date().toISOString(),
  origin,
  checks: [],
  browserOAuth: false,
};
async function api(
  path,
  method = "GET",
  body,
  auth = adminHeaders,
  status = 200,
) {
  const r = await fetch(origin + path, {
    method,
    headers: auth,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await r.json();
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${JSON.stringify(result)}`,
  );
  return result;
}
const ok = (name) => {
  evidence.checks.push(name);
  console.log(`PASS ${name}`);
};
await api("/api/health", "GET", undefined, {}, 200);
await api("/api/admin/v1/logs", "GET", undefined, {}, 401);
await api(
  "/api/admin/v1/logs",
  "GET",
  undefined,
  { "x-dev-admin": "true" },
  401,
);
await api("/api/internal/v1/maintenance", "POST", {}, {}, 401);
ok(
  "Healthy production configuration; unauthenticated, development-header, and unsigned maintenance access denied",
);
await api(
  "/api/admin/v1/admins",
  "POST",
  { email: account, active: false },
  adminHeaders,
  409,
);
await api(
  "/api/admin/v1/admins",
  "POST",
  { email: account, active: true },
  { ...adminHeaders, "x-csrf-token": "wrong" },
  403,
);
ok("Last-admin and CSRF protections");
const tag = randomBytes(5).toString("hex").toUpperCase();
const serials = [`SYNTHETIC-${tag}-A`, `SYNTHETIC-${tag}-B`];
const batch = await api(
  "/api/admin/v1/enrollment-batches",
  "POST",
  process.env.TEST_JAMF_MODE === "1"
    ? {
        mode: "jamf",
        label: "Synthetic cloud acceptance fixture",
        ceiling: 2,
        days: 1,
      }
    : {
        roster: serials.map((serial) => ({
          serial,
          assignedLabel: "Synthetic cloud acceptance fixture",
        })),
      },
  adminHeaders,
  201,
);
if (process.env.TEST_JAMF_MODE === "1") {
  const response = await fetch(origin + "/collector/install.zsh");
  assert.ok(
    response.ok,
    "Embedded public installer must be available in the deployed container",
  );
  assert.equal(
    hash(Buffer.from(await response.text())),
    hash(await readFile("public/collector/install.zsh")),
  );
  assert.equal(batch.mode, "jamf");
  assert.equal(batch.origin, origin);
  ok(
    "Deployed embedded installer matches the checked release; canonical-origin automatic batch configured",
  );
}
const metadata = {
  collectorVersion: "0.1.0",
  architecture: "arm64",
  macOSVersion: "synthetic",
  macOSBuild: "SYNTHETIC",
  sebVersion: null,
  timezone: "Etc/UTC",
  reportedAt: new Date().toISOString(),
};
const devices = [];
for (const serial of serials) {
  const installationId = randomUUID(),
    rawSecret = randomBytes(32);
  const b = {
    schemaVersion: 1,
    installationId,
    serial,
    credentialHash: hash(rawSecret),
    metadata,
  };
  const d = await api("/api/device/v1/enroll", "POST", b, {
    ...headers,
    authorization: `Bearer ${batch.code}`,
  });
  const auth = {
    "content-type": "application/json",
    authorization: `Bearer ${installationId}.${rawSecret.toString("base64url")}`,
  };
  devices.push({ ...d, installationId, auth });
  await api("/api/device/v1/enroll", "POST", b, {
    ...headers,
    authorization: `Bearer ${batch.code}`,
  });
  await api("/api/admin/v1/logs", "GET", undefined, auth, 401);
}
if (process.env.TEST_JAMF_MODE === "1") {
  await api(
    "/api/device/v1/enroll",
    "POST",
    {
      schemaVersion: 1,
      installationId: randomUUID(),
      serial: `SYNTHETIC-${tag}-C`,
      credentialHash: hash(randomBytes(32)),
      metadata,
    },
    { ...headers, authorization: `Bearer ${batch.code}` },
    429,
  );
  assert.equal((await doc(`enrollmentBatches/${batch.id}`)).count, 2);
  ok(
    "Automatic Jamf enrollment without a serial roster; device ceiling enforced",
  );
}
ok("Roster enrollment, response reconciliation, and device/admin separation");
const d = devices[0],
  collectionId = randomUUID(),
  raw = Buffer.from(
    `Synthetic fixture ${tag}\n<script>never execute</script>\n`,
  ),
  gz = gzipSync(raw);
await api(
  "/api/device/v1/collections",
  "POST",
  {
    schemaVersion: 1,
    collectionId,
    reason: "initial",
    startedAt: new Date().toISOString(),
    outcome: "running",
    metadata,
  },
  d.auth,
);
const input = {
  schemaVersion: 1,
  collectionId,
  rawSha256: hash(raw),
  gzipSha256: hash(gz),
  rawBytes: raw.length,
  gzipBytes: gz.length,
  metadata,
  source: {
    username: "fixture",
    uid: 502,
    relativePath: "Library/Logs/Safe Exam Browser/fixture.log",
    basename: "fixture.log",
    mtime: new Date().toISOString(),
    bytes: raw.length,
  },
};
const [policy, duplicate] = await Promise.all([
  api("/api/device/v1/uploads/prepare", "POST", input, d.auth),
  api("/api/device/v1/uploads/prepare", "POST", input, d.auth),
]);
assert.equal(policy.uploadId, duplicate.uploadId);
const day = new Date().toISOString().slice(0, 10),
  quotaPath = `quotaWindows/device-${d.deviceId}-${day}`;
const quota = await doc(quotaPath);
assert.equal(quota.count, 1);
assert.equal(quota.bytes, gz.length);
async function post(fields = policy.fields, bytes = gz) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(
    "file",
    new Blob([bytes], { type: "application/gzip" }),
    "fixture.log.gz",
  );
  return fetch(policy.url, { method: "POST", body: form });
}
assert.equal(new URL(policy.url).hostname, "storage.googleapis.com");
assert.equal(new URL(policy.url).pathname, `/${bucket}`);
assert.ok(
  !(await post({ ...policy.fields, key: policy.fields.key + "-wrong" })).ok,
);
assert.ok(
  !(await post(policy.fields, Buffer.concat([gz, Buffer.from("!")]))).ok,
);
if (process.env.TEST_NATIVE_MAC === "1") {
  assert.equal(process.platform, "darwin");
  const root = `${process.cwd()}/.local/collector-test`,
    state = `${root}/state`,
    stage = `${root}/staging/native space`;
  await mkdir(`${root}/credentials`, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(stage, { recursive: true });
  const credential = d.auth.authorization.slice(7).split(".");
  await writeFile(
    `${root}/credentials/native-test-device.json`,
    JSON.stringify({ installationId: d.installationId, secret: credential[1] }),
    { mode: 0o600 },
  );
  await writeFile(`${state}/native-bootstrap`, batch.code, { mode: 0o600 });
  await writeFile(
    `${state}/native-enrollment.json`,
    JSON.stringify({
      schemaVersion: 1,
      installationId: d.installationId,
      serial: serials[0],
      credentialHash: hash(Buffer.from(credential[1], "base64url")),
      metadata,
    }),
    { mode: 0o600 },
  );
  await writeFile(`${state}/native-policy.json`, JSON.stringify(policy), {
    mode: 0o600,
  });
  await writeFile(`${stage}/${hash(raw)}.gz`, gz, { mode: 0o600 });
  const output = execFileSync("/bin/zsh", ["-f", "tests/macos-cloud.zsh"], {
    encoding: "utf8",
    env: { ...process.env, NATIVE_FIXTURE_ROOT: root, TEST_ORIGIN: origin },
  });
  console.log(output.trim());
  ok(
    "Actual native macOS enrollment, authenticated JSON, space-safe GCS upload and completion",
  );
} else {
  const stored = await post();
  assert.equal(stored.status, 201, `GCS upload ${stored.status}`);
}
const objectUrl = `https://storage.googleapis.com/${bucket}/${policy.fields.key}`;
assert.ok(!(await fetch(objectUrl)).ok);
assert.ok(!(await post()).ok);
ok(
  "Real exact-length private POST; wrong key/length rejected; anonymous read and signer overwrite denied",
);
const complete = await api(
  `/api/device/v1/uploads/${policy.uploadId}/complete`,
  "POST",
  {},
  d.auth,
);
assert.equal(complete.state, "accepted");
assert.equal(complete.acknowledgment.rawSha256, hash(raw));
assert.equal(
  new Date(complete.acknowledgment.expiresAt) -
    new Date(complete.acknowledgment.uploadedAt),
  90 * 86400000,
);
assert.deepEqual(
  await api(
    `/api/device/v1/uploads/${policy.uploadId}/complete`,
    "POST",
    {},
    d.auth,
  ),
  complete,
);
const present = await api(
  "/api/device/v1/uploads/prepare",
  "POST",
  input,
  d.auth,
);
assert.equal(present.state, "already_present");
assert.equal(
  present.acknowledgment.expiresAt,
  complete.acknowledgment.expiresAt,
);
assert.deepEqual(await doc(quotaPath), quota);
await api(
  `/api/device/v1/uploads/${policy.uploadId}/complete`,
  "POST",
  {},
  devices[1].auth,
  404,
);
ok(
  "Pinned generation acknowledgment; GCS creation-based 90-day retention; dedup charges once; cross-device access denied",
);
const downloaded = await fetch(
  `${origin}/api/admin/v1/logs/${policy.uploadId}/download`,
  { headers: adminHeaders },
);
assert.equal(downloaded.status, 200);
const received = Buffer.from(await downloaded.arrayBuffer());
assert.deepEqual(received, gz);
assert.deepEqual(gunzipSync(received), raw);
const preview = await api(`/api/admin/v1/logs/${policy.uploadId}/preview`);
assert.ok(preview.text.includes("<script>never execute</script>"));
ok("Byte-identical authorized gzip download and bounded inert text preview");
await api(`/api/admin/v1/devices/${d.deviceId}`, "PATCH", { state: "paused" });
await api("/api/device/v1/uploads/prepare", "POST", input, d.auth, 403);
await api(`/api/admin/v1/devices/${d.deviceId}`, "PATCH", { state: "active" });
await api(`/api/admin/v1/devices/${devices[1].deviceId}/revoke`, "POST", {});
await api("/api/device/v1/config", "GET", undefined, devices[1].auth, 403);
ok("Live central pause/resume and immediate credential revocation");
const log = await doc(`logs/${policy.uploadId}`);
await doc(`logs/${policy.uploadId}`, {
  ...log,
  expiresAt: "2000-01-01T00:00:00.000Z",
});
await api(
  `/api/admin/v1/logs/${policy.uploadId}/download`,
  "GET",
  undefined,
  adminHeaders,
  410,
);
ok("Application expiry denies download before physical deletion");
evidence.synthetic = {
  deviceIds: devices.map((x) => x.deviceId),
  installationIds: devices.map((x) => x.installationId),
  batchId: batch.id,
  logId: policy.uploadId,
  objectKey: policy.fields.key,
  quotaPath,
};
evidence.finishedAt = new Date().toISOString();
await mkdir(".local", { recursive: true });
await writeFile(
  ".local/cloud-smoke.json",
  JSON.stringify(evidence, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  "Cloud smoke completed; synthetic log awaits actual Scheduler cleanup. No credentials were saved.",
);
