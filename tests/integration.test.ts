import { DiagnosticTextRedactor } from "../contracts/redaction";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { MemoryStore } from "../src/server/store";
import { token } from "../src/server/auth";
import { sha } from "../src/server/crypto";
import {
  integrationRoute,
  inspectLog,
  safeLog,
} from "../src/server/integration";
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = verify;
  },
}));
const raw = Buffer.from(
  "Startup\nUnable to decrypt settings password=secret\nhttps://school.example/quiz?session_token=secret\n",
);
vi.mock("../src/server/storage", async (original) => ({
  ...(await original<typeof import("../src/server/storage")>()),
  object: () => ({ createReadStream: () => Readable.from([gzipSync(raw)]) }),
  logText: () => Readable.toWeb(Readable.from([raw])),
}));
let db: MemoryStore;
const origin = "https://diagnostics.example.org",
  web = "web@synthetic-test.iam.gserviceaccount.com",
  worker = "worker@synthetic-test.iam.gserviceaccount.com";
const actor = { email: "it@example.org", sub: "verified-google-sub" };
const req = (path: string, method = "GET", body?: unknown, identity = "web") =>
  new Request(origin + "/api/integration/v2/" + path, {
    method,
    headers: {
      authorization: "Bearer " + identity,
      "x-soe-actor": Buffer.from(JSON.stringify(actor)).toString("base64url"),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(async () => {
  db = new MemoryStore();
  vi.stubEnv(
    "INTEGRATION_CLIENTS",
    JSON.stringify({
      diagnostics: {
        origin: "https://dashboard.example.org",
        webServiceAccount: web,
        workerServiceAccount: worker,
        installations: ["pilot"],
      },
    }),
  );
  verify.mockImplementation(async ({ idToken, audience }) => {
    expect(audience).toBe(origin + "/api/integration/v2");
    if (!["web", "worker"].includes(idToken)) throw Error("signature rejected");
    return {
      getPayload: () => ({
        email: idToken === "web" ? web : worker,
        email_verified: true,
      }),
    };
  });
  await db.transaction(async (tx) => {
    tx.set("admins/" + sha(actor.email), { ...actor, active: true });
    tx.set("devices/device-fixture", {
      id: "device-fixture",
      activeInstallation: "fixture-installation",
      lastSeenAt: new Date().toISOString(),
    });
  });
});
afterEach(() => vi.unstubAllEnvs());
it("normalizes legacy filename timestamps as UTC without changing stored evidence", () => {
  const source = {
    basename:
      "org.safeexambrowser.SafeExamBrowser 2026-09-17--20-07-09-635.log",
    mtime: "2026-09-18T04:00:00.000Z",
  };
  const old = {
    source,
    logStartedAt: "2026-09-18T02:07:09.635Z",
    logDateBasis: "filename",
  };
  expect(safeLog(old).logStartedAt).toBe("2026-09-17T20:07:09.635Z");
  expect(old.logStartedAt).toBe("2026-09-18T02:07:09.635Z");
});
it("requires the registered Google service identity and rechecks current administrator authorization", async () => {
  await expect(
    integrationRoute(req("authorize", "POST", {}, "invalid"), db),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (await integrationRoute(req("authorize", "POST", {}), db)).status,
  ).toBe(200);
  await db.transaction(async (tx) =>
    tx.set("admins/" + sha(actor.email), { ...actor, active: false }),
  );
  await expect(
    integrationRoute(req("authorize", "POST", {}), db),
  ).rejects.toMatchObject({ status: 403 });
});
it("binds single-use authorization codes to PKCE, registered client and exact callback", async () => {
  const verifier = "a".repeat(43),
    state = "s".repeat(43),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: "diagnostics",
    redirect_uri: "https://dashboard.example.org/api/auth/callback",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorize = async () => {
    const request = new Request(
      origin + "/api/integration/v2/auth/authorize?" + q,
      {
        headers: {
          cookie:
            "soe_session=" +
            (await token({ ...actor, csrf: "fixture" }, "session")),
        },
      },
    );
    return integrationRoute(request, db);
  };
  q.set("redirect_uri", "https://dashboard.example.org/api/auth/callback/evil");
  await expect(authorize()).rejects.toMatchObject({ status: 400 });
  q.set("redirect_uri", "https://dashboard.example.org/api/auth/callback");
  const response = await authorize();
  const target = new URL(response.headers.get("location")!);
  expect(target.searchParams.get("state")).toBe(state);
  const code = target.searchParams.get("code");
  await expect(
    integrationRoute(
      req("auth/exchange", "POST", { code, verifier: "b".repeat(43) }),
      db,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await (
        await integrationRoute(
          req("auth/exchange", "POST", { code, verifier }),
          db,
        )
      ).json()
    ).actor,
  ).toEqual(actor);
  await expect(
    integrationRoute(req("auth/exchange", "POST", { code, verifier }), db),
  ).rejects.toMatchObject({ status: 403 });
});
it("does not expose fleet administration, identities from device credentials, or cross-installation operations", async () => {
  await expect(
    integrationRoute(req("admins", "POST", {}), db),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    integrationRoute(req("logs?instance=other"), db),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    integrationRoute(req("devices", "GET", undefined, "device-token"), db),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    integrationRoute(req("devices", "GET", undefined, "worker"), db),
  ).rejects.toMatchObject({ status: 403 });
});
it("queues collection once under concurrent retry and preserves the existing native protocol", async () => {
  const operationId = randomUUID(),
    input = {
      operationId,
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
    };
  const a = await Promise.all([
    integrationRoute(req("devices/device-fixture/requests", "POST", input), db),
    integrationRoute(req("devices/device-fixture/requests", "POST", input), db),
  ]);
  expect(a.every((v) => v.status === 201)).toBe(true);
  const stored = await db.get("collectionRequests/" + operationId);
  expect(stored?.state).toBe("pending");
  expect(stored?.integrationClient).toBe("diagnostics");
  expect(
    [...db.docs.keys()].filter((k) => k.startsWith("collectionRequests/")),
  ).toHaveLength(1);
  await expect(
    integrationRoute(
      req("devices/device-fixture/requests", "POST", {
        ...input,
        from: new Date(Date.now() - 2 * 86400000).toISOString(),
      }),
      db,
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it("checks immutable bytes, sanitizes viewing/search, rejects expiry and audits original downloads", async () => {
  const log = {
    id: "verified-log",
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    objectKey: "private-object",
    generation: "1",
    rawBytes: raw.length,
    gzipBytes: gzipSync(raw).length,
    rawSha256: sha(raw),
    gzipSha256: sha(gzipSync(raw)),
  };
  await db.transaction(async (tx) => tx.set("logs/" + log.id, log));
  const viewed = await (
    await integrationRoute(req("logs/verified-log/content"), db)
  ).json();
  expect(JSON.stringify(viewed)).not.toContain("=secret");
  const search = await (
    await integrationRoute(
      req("logs/verified-log/search", "POST", { query: "decrypt" }),
      db,
    )
  ).json();
  expect(search.lines[0].number).toBe(2);
  expect(
    (await integrationRoute(req("logs/verified-log/download"), db)).status,
  ).toBe(200);
  expect(
    [...db.docs.values()].some((v) => v.action === "integration_log_download"),
  ).toBe(true);
  await expect(
    inspectLog({ ...log, rawSha256: "0".repeat(64) }),
  ).rejects.toBeTruthy();
  await expect(
    inspectLog({ ...log, expiresAt: new Date(Date.now() - 1).toISOString() }),
  ).rejects.toMatchObject({ status: 410 });
});

it("redacts JSON and multiline credentials in native text", () => {
  const redactor = new DiagnosticTextRedactor();
  const safe = [
    '"password":"synthetic-secret"',
    "<key>accessCode</key>",
    "<string>synthetic-code</string>",
    "-----BEGIN PRIVATE KEY-----",
    "synthetic-key",
    "-----END PRIVATE KEY-----",
    "ordinary",
  ]
    .map((v) => redactor.line(v))
    .join("\n");
  expect(safe).not.toMatch(/synthetic-secret|synthetic-code|synthetic-key/);
  expect(safe).toContain("ordinary");
});

it("returns refreshed bounded parser metadata for incremental dashboard persistence", async () => {
  const log = {
    id: "backfill-log",
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    objectKey: "private-object",
    generation: "1",
    rawBytes: raw.length,
    gzipBytes: gzipSync(raw).length,
    rawSha256: sha(raw),
    gzipSha256: sha(gzipSync(raw)),
  };
  await db.transaction(async (tx) => tx.set("logs/" + log.id, log));
  const result = await (
    await integrationRoute(req("logs/reindex", "POST", {}, "worker"), db)
  ).json();
  expect(result.indexed).toBe(1);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].analysis.parsingStatus).toBe("parsed");
  expect(result.items[0].analysis.findings.length).toBeGreaterThan(0);
  expect(result.items[0].objectKey).toBeUndefined();
  expect(result.items[0].generation).toBeUndefined();
  expect(result.nextCursor).toBeNull();
});
