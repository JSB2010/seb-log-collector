import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { config } from "../src/server/config";
import { credentialHash, secret, sha } from "../src/server/crypto";
import {
  admin,
  device,
  token,
  eligibleGoogle,
  seedAdmins,
  oauth,
} from "../src/server/auth";
import { MemoryStore } from "../src/server/store";
import { Service } from "../src/server/service";
import { verifyGzip } from "../src/server/storage";
import { parseRoster, csvCell } from "../src/components/csv";
import { enrollmentInstaller } from "../src/components/enrollment";
const metadata = {
  collectorVersion: "0.1.0",
  architecture: "arm64",
  macOSVersion: "26",
  macOSBuild: "TEST",
  sebVersion: "3.7.1",
  timezone: "Etc/UTC",
  reportedAt: new Date().toISOString(),
  hostName: "synthetic",
};
let db: MemoryStore,
  s: Service,
  install: string,
  rawSecret: string,
  d: any,
  batch: any;
const provider = {
  signedPost: async (u: any) => ({
    uploadId: u.id,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    method: "POST",
    url: "https://storage.googleapis.com/synthetic-test-private",
    fields: {},
  }),
  verifyObject: async () => ({
    generation: "1",
    uploadedAt: new Date().toISOString(),
  }),
  removeObject: async () => {},
};
const actor = { email: "it@example.org", sub: "google-sub", csrf: "test" };
beforeEach(async () => {
  db = new MemoryStore();
  s = new Service(db, provider);
  install = randomUUID();
  rawSecret = secret();
  batch = await s.createBatch(actor, { roster: [{ serial: "SYNTHETIC001" }] });
  await s.enroll(batch.code, {
    schemaVersion: 1,
    installationId: install,
    serial: "SYNTHETIC001",
    credentialHash: credentialHash(rawSecret),
    metadata,
  });
  d = {
    ...(await db.get(`devices/${sha("SYNTHETIC001").slice(0, 32)}`)),
    installationId: install,
  };
});
const req = () =>
  new Request("https://diagnostics.example.org/api/device/v1/config", {
    headers: { authorization: `Bearer ${install}.${rawSecret}` },
  });
async function uploadBody() {
  const collectionId = randomUUID();
  await s.collection(d, {
    schemaVersion: 1,
    collectionId,
    reason: "daily",
    startedAt: new Date().toISOString(),
    outcome: "running",
    metadata,
  });
  const raw = Buffer.from("synthetic log\n"),
    gz = gzipSync(raw);
  return {
    schemaVersion: 1,
    collectionId,
    rawSha256: sha(raw),
    gzipSha256: sha(gz),
    rawBytes: raw.length,
    gzipBytes: gz.length,
    source: {
      username: "fixture",
      uid: 502,
      relativePath: "Library/Logs/Safe Exam Browser/test.log",
      basename: "test.log",
      mtime: new Date().toISOString(),
      bytes: raw.length,
    },
    metadata,
  };
}
describe("Enrollment and permissions", () => {
  it("automatically accepts Jamf-scoped serials while enforcing an atomic batch ceiling", async () => {
    const managed = await s.createBatch(actor, {
      mode: "jamf",
      label: "Synthetic Jamf group",
      ceiling: 2,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, n) =>
        s.enroll(managed.code, {
          schemaVersion: 1,
          installationId: randomUUID(),
          serial: `JAMF-SYNTHETIC-${n}`,
          credentialHash: credentialHash(secret()),
          metadata,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => r.reason.code === "batch_limit"),
    ).toBe(true);
    expect((await db.get(`enrollmentBatches/${managed.id}`))?.count).toBe(2);
    expect(
      await db.query(
        "enrollmentRoster",
        [["batchId", "==", managed.id]],
        "id",
        undefined,
        10,
      ),
    ).toHaveLength(0);
    const devices = await db.query(
      "devices",
      [["assignedLabel", "==", "Synthetic Jamf group"]],
      "id",
      undefined,
      10,
    );
    expect(devices).toHaveLength(2);
    expect(devices.every((x) => x.enrollmentBatchId === managed.id)).toBe(true);
    await db.transaction(async (tx) => {
      const b = await tx.get(`enrollmentBatches/${managed.id}`);
      tx.set(`enrollmentBatches/${managed.id}`, { ...b, state: "closed" });
    });
    await expect(
      s.enroll(managed.code, {
        schemaVersion: 1,
        installationId: randomUUID(),
        serial: "JAMF-SYNTHETIC-CLOSED",
        credentialHash: credentialHash(secret()),
        metadata,
      }),
    ).rejects.toMatchObject({ code: "bootstrap_closed" });
  });
  it("builds a self-contained scoped installer with enrollment before daemon startup and rejects shell injection", () => {
    const source =
      '#!/bin/zsh -f\nAPI_ORIGIN=${API_ORIGIN:-}\n/bin/launchctl bootstrap system "$PLIST"\n';
    const code = secret(),
      output = enrollmentInstaller(
        source,
        code,
        "https://diagnostics.example.org",
      );
    expect(output).toContain("API_ORIGIN='https://diagnostics.example.org'");
    expect(output.indexOf("enroll --bootstrap-stdin")).toBeLessThan(
      output.indexOf("launchctl bootstrap"),
    );
    expect(output).toContain("Enrollment pending");
    expect(() =>
      enrollmentInstaller(
        source,
        code,
        "https://example.org'; touch /tmp/owned",
      ),
    ).toThrow();
    expect(() =>
      enrollmentInstaller(source, "bad'code", "https://example.org"),
    ).toThrow();
    expect(() =>
      enrollmentInstaller("not an installer", code, "https://example.org"),
    ).toThrow();
  });
  it("uses canonical 32-byte secret decoding and fixed hash vector", () => {
    expect(credentialHash(Buffer.alloc(32).toString("base64url"))).toBe(
      "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
    );
    expect(() => credentialHash("x".repeat(44))).toThrow();
  });
  it("reconciles the same enrollment, denies a conflicting install and unknown serial", async () => {
    const b = {
      schemaVersion: 1,
      installationId: install,
      serial: "SYNTHETIC001",
      credentialHash: credentialHash(rawSecret),
      metadata,
    };
    expect((await s.enroll(batch.code, b)).deviceId).toBe(d.id);
    await expect(
      s.enroll(batch.code, { ...b, installationId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.enroll(batch.code, {
        ...b,
        installationId: randomUUID(),
        serial: "UNKNOWN001",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("allows saved credentials after batch expiry but rejects new enrollment", async () => {
    await db.transaction(async (t) => {
      const b = await t.get(`enrollmentBatches/${batch.id}`);
      t.set(`enrollmentBatches/${batch.id}`, {
        ...b,
        expiresAt: "2000-01-01T00:00:00Z",
      });
    });
    expect((await device(req(), db)).id).toBe(d.id);
    const next = await s.createBatch(actor, {
      roster: [{ serial: "SYNTHETIC002" }],
    });
    await db.transaction(async (t) => {
      const b = await t.get(`enrollmentBatches/${next.id}`);
      t.set(`enrollmentBatches/${next.id}`, {
        ...b,
        expiresAt: "2000-01-01T00:00:00Z",
      });
    });
    await expect(
      s.enroll(next.code, {
        schemaVersion: 1,
        installationId: randomUUID(),
        serial: "SYNTHETIC002",
        credentialHash: credentialHash(secret()),
        metadata,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("immediately denies revoked credentials", async () => {
    await s.revoke(d, actor.email);
    await expect(device(req(), db)).rejects.toMatchObject({ status: 403 });
    const retired = await db.get(`devices/${d.id}`);
    expect(new Date(retired!.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      89 * 86400000,
    );
    expect(retired!.ttlAt).toBeInstanceOf(Date);
    expect((await db.get(`installations/${install}`))!.revokedAt).toBeTruthy();
  });
  it("denies device tokens at the admin boundary", async () => {
    await expect(admin(req(), false, db)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("requires allowed Google domain and verified email", () => {
    expect(() =>
      eligibleGoogle({
        email: "student@example.org",
        email_verified: false,
        hd: "example.org",
      }),
    ).toThrow();
    expect(() =>
      eligibleGoogle({
        email: "it@example.org",
        email_verified: true,
        hd: "evil.org",
      }),
    ).toThrow();
  });
  it("rechecks admin permission and CSRF on every request", async () => {
    await seedAdmins(db);
    await db.transaction(async (t) => {
      const a = await t.get(`admins/${sha(actor.email)}`);
      t.set(`admins/${sha(actor.email)}`, { ...a, sub: actor.sub });
    });
    const session = await token(actor, "session");
    const r = (extra: any = {}) =>
      new Request("https://diagnostics.example.org/api/admin/v1/devices", {
        headers: { cookie: `soe_session=${session}`, ...extra },
      });
    expect((await admin(r(), false, db)).email).toBe(actor.email);
    await expect(admin(r(), true, db)).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await admin(
          r({
            origin: "https://diagnostics.example.org",
            "x-csrf-token": "test",
          }),
          true,
          db,
        )
      ).email,
    ).toBe(actor.email);
    await db.transaction(async (t) => {
      t.set(`admins/${sha(actor.email)}`, { active: false, sub: actor.sub });
    });
    await expect(admin(r(), false, db)).rejects.toMatchObject({ status: 403 });
  });
  it("forbids development auth and memory backends in production", () => {
    const original = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "production" });
    expect(() => config()).toThrow();
    Object.assign(process.env, { NODE_ENV: original });
  });
  it("moves OAuth login to the configured host before issuing a state cookie", async () => {
    const response = await oauth(
      new Request("https://old-cloud-run.example.net/api/auth/login"),
      "login",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://diagnostics.example.org/api/auth/login",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(
      oauth(
        new Request("http://0.0.0.0:8080/api/auth/login", {
          headers: { host: "diagnostics.example.org" },
        }),
        "login",
      ),
    ).rejects.toMatchObject({ code: "oauth_not_configured" });
    await expect(
      oauth(
        new Request("http://0.0.0.0:8080/api/auth/login", {
          headers: {
            host: "internal.run.app",
            "x-forwarded-host": "diagnostics.example.org",
          },
        }),
        "login",
      ),
    ).rejects.toMatchObject({ code: "oauth_not_configured" });
  });
});
describe("Reservations and retention", () => {
  it("concurrent prepares charge one reservation; completion and duplicate retain original expiration", async () => {
    const b = await uploadBody();
    const [a, c] = await Promise.all([s.prepare(d, b), s.prepare(d, b)]);
    expect(a.uploadId).toBe(c.uploadId);
    expect(
      [...db.docs.keys()].filter((k) => k.startsWith("uploads/")),
    ).toHaveLength(1);
    expect(
      [...db.docs.values()].filter((q) => q.bytes === b.gzipBytes),
    ).toHaveLength(2);
    const first = await s.complete(d, a.uploadId!);
    expect(await s.complete(d, a.uploadId!)).toEqual(first);
    const duplicate = await s.prepare(d, b);
    expect(duplicate.state).toBe("already_present");
    expect(duplicate.acknowledgment?.expiresAt).toBe(
      first.acknowledgment.expiresAt,
    );
  });
  it("rechecks central pause after policy signing", async () => {
    const b = await uploadBody();
    const raced = new Service(db, {
      ...provider,
      signedPost: async (u: any) => {
        await db.transaction(async (tx) => {
          const current = await tx.get(`devices/${d.id}`);
          tx.set(`devices/${d.id}`, { ...current, state: "paused" });
        });
        return provider.signedPost(u);
      },
    });
    await expect(raced.prepare(d, b)).rejects.toMatchObject({
      status: 403,
      code: "device_paused",
    });
  });
  it("rejects changed immutable bytes, paused prepare, and other-device upload access", async () => {
    const b = await uploadBody();
    const p = await s.prepare(d, b);
    await expect(
      s.prepare(d, { ...b, gzipSha256: "f".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.upload({ ...d, id: "another" }, p.uploadId!),
    ).rejects.toMatchObject({ status: 404 });
    await db.transaction(async (t) => {
      const dev = await t.get(`devices/${d.id}`);
      t.set(`devices/${d.id}`, { ...dev, state: "paused" });
    });
    await expect(s.prepare(d, b)).rejects.toMatchObject({ status: 403 });
  });
  it("never acknowledges corrupt verification", async () => {
    const b = await uploadBody(),
      p = await s.prepare(d, b);
    const broken = new Service(db, {
      ...provider,
      verifyObject: async () => {
        throw new Error("transport");
      },
    });
    await expect(broken.complete(d, p.uploadId!)).rejects.toThrow();
    expect(await db.get(`logs/${p.uploadId}`)).toBeUndefined();
  });
  it("denies expired access before physical cleanup and retains cleanup references on failure", async () => {
    const b = await uploadBody(),
      p = await s.prepare(d, b);
    await s.complete(d, p.uploadId!);
    await db.transaction(async (t) => {
      const l = await t.get(`logs/${p.uploadId}`);
      t.set(`logs/${p.uploadId}`, { ...l, expiresAt: "2000-01-01T00:00:00Z" });
    });
    await expect(s.log(p.uploadId!)).rejects.toMatchObject({ status: 410 });
    const failing = new Service(db, {
      ...provider,
      removeObject: async () => {
        throw new Error("permission");
      },
    });
    expect((await failing.maintenance()).errors).toBe(1);
    expect(await db.get(`logs/${p.uploadId}`)).toBeDefined();
    expect((await s.maintenance()).deleted).toBe(1);
    expect(await db.get(`logs/${p.uploadId}`)).toBeUndefined();
  });
});
describe("Untrusted gzip and CSV", () => {
  async function verify(bytes: Buffer, raw: Buffer) {
    return verifyGzip(Readable.from([bytes]), {
      gzipBytes: bytes.length,
      gzipSha256: sha(bytes),
      rawBytes: raw.length,
      rawSha256: sha(raw),
    });
  }
  it("verifies all bytes and renders HTML as inert text", async () => {
    const raw = Buffer.from("<script>fixture</script>\n");
    expect((await verify(gzipSync(raw), raw)).text).toBe(raw.toString());
  });
  it("rejects trailing payload, concatenation, malformed gzip, CRC changes, size and expansion mismatch", async () => {
    const raw = Buffer.from("fixture"),
      gz = gzipSync(raw);
    for (const b of [
      Buffer.concat([gz, Buffer.from("hidden")]),
      Buffer.concat([gz, gz]),
      Buffer.from("not gzip"),
    ])
      await expect(verify(b, raw)).rejects.toThrow();
    const bad = Buffer.from(gz);
    bad[bad.length - 8] ^= 1;
    await expect(verify(bad, raw)).rejects.toThrow();
    await expect(verify(gz, Buffer.from("x"))).rejects.toThrow();
  });
  it("parses quoted CSV and prevents spreadsheet formula injection", () => {
    expect(
      parseRoster('serial,assignedLabel\r\nSYNTHETIC001,"Example, Mac"\r\n')[0]
        .assignedLabel,
    ).toBe("Example, Mac");
    expect(csvCell("=CMD()")).toBe('"\'=CMD()"');
  });
});
