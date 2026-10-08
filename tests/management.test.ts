import { beforeEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/server/store";
import { Service } from "../src/server/service";
import { Management } from "../src/server/management";
import { device } from "../src/server/auth";
import { secret, credentialHash, sha } from "../src/server/crypto";
import { logDate } from "../src/server/log-date";
const actor = { email: "it@example.org", sub: "test", csrf: "test" };
const metadata = {
  collectorVersion: "0.3.0",
  managementProtocol: 1,
  architecture: "arm64",
  macOSVersion: "26",
  macOSBuild: "test",
  sebVersion: null,
  timezone: "America/Denver",
  reportedAt: new Date().toISOString(),
};
let db: MemoryStore,
  s: Service,
  m: Management,
  d: any,
  g: any,
  raw: string,
  installation: string;
beforeEach(async () => {
  db = new MemoryStore();
  s = new Service(db);
  m = new Management(db, s);
  raw = secret();
  installation = randomUUID();
  g = await s.createBatch(actor, { label: "Fixture group" });
  const enrolled = await s.enroll(g.code, {
    schemaVersion: 1,
    installationId: installation,
    serial: "MANAGEMENT001",
    credentialHash: credentialHash(raw),
    metadata,
  });
  d = {
    ...(await db.get(`devices/${enrolled.deviceId}`)),
    installationId: installation,
  };
});
const req = () =>
  new Request("https://diagnostics.example.org/api/device/v1/config", {
    headers: { authorization: `Bearer ${installation}.${raw}` },
  });
it("keeps groups permanent, reusable, and closed only by an explicit action", async () => {
  expect(g.expiresAt).toBeNull();
  await db.transaction(async (t) => {
    const old = await t.get(`enrollmentBatches/${g.id}`);
    t.set(`enrollmentBatches/${g.id}`, {
      ...old,
      expiresAt: "2000-01-01T00:00:00Z",
    });
  });
  await expect(
    s.enroll(g.code, {
      schemaVersion: 1,
      installationId: randomUUID(),
      serial: "MANAGEMENT002",
      credentialHash: credentialHash(secret()),
      metadata,
    }),
  ).resolves.toHaveProperty("deviceId");
  expect((await s.batchInstaller(actor, g.id)).code).toBe(g.code);
  await s.updateBatch(actor, g.id, { state: "closed" });
  await expect(
    s.enroll(g.code, {
      schemaVersion: 1,
      installationId: randomUUID(),
      serial: "MANAGEMENT003",
      credentialHash: credentialHash(secret()),
      metadata,
    }),
  ).rejects.toMatchObject({ code: "bootstrap_closed" });
});
it("moves current membership atomically, protects full/deleted groups, and counts revocation once", async () => {
  const next = await s.createBatch(actor, { label: "Destination", ceiling: 1 });
  await expect(
    s.updateBatch(actor, g.id, { state: "deleted" }),
  ).rejects.toMatchObject({ code: "group_has_devices" });
  await m.updateDevice(actor.email, d.id, { enrollmentGroupId: next.id });
  expect((await db.get(`enrollmentBatches/${g.id}`))?.count).toBe(0);
  expect((await db.get(`enrollmentBatches/${next.id}`))?.count).toBe(1);
  await s.updateBatch(actor, g.id, { state: "deleted" });
  await expect(
    m.updateDevice(actor.email, d.id, { enrollmentGroupId: g.id }),
  ).rejects.toMatchObject({ code: "group_unavailable" });
  await s.revoke(d, actor.email);
  await s.revoke(d, actor.email);
  expect((await db.get(`enrollmentBatches/${next.id}`))?.count).toBe(0);
  await s.updateBatch(actor, g.id, { state: "open" });
  expect((await s.batchInstaller(actor, g.id)).code).toBe(g.code);
});
it("pins update artifacts, prevents duplicate/conflicting commands, and requires a matching installed result", async () => {
  const c = await m.queue(actor.email, d.id, { action: "update" });
  expect(c.path).toBe(`/collector/releases/${c.version}/install.zsh`);
  expect(c.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    m.queue(actor.email, d.id, { action: "uninstall" }),
  ).rejects.toMatchObject({ code: "command_already_pending" });
  await expect(
    m.acknowledge(d, c.id, {
      state: "completed",
      version: c.version,
      result: "installed",
    }),
  ).rejects.toMatchObject({ code: "command_not_running" });
  await m.acknowledge(d, c.id, { state: "deferred", result: "busy" });
  await m.acknowledge(d, c.id, { state: "running" });
  expect((await db.get(`deviceCommands/${c.id}`))?.result).toBeNull();
  await expect(m.cancel(actor.email, c.id)).rejects.toMatchObject({
    code: "command_running",
  });
  await expect(
    m.acknowledge(d, c.id, {
      state: "completed",
      version: "0.0.1",
      result: "installed",
    }),
  ).rejects.toMatchObject({ code: "invalid_result" });
  await m.acknowledge(d, c.id, {
    state: "completed",
    version: c.version,
    result: "installed",
  });
  expect((await db.get(`devices/${d.id}`))?.pendingCommand).toBeNull();
  expect((await device(req(), db)).id).toBe(d.id);
});
it("revokes data access before remote removal and permits only its exact final acknowledgment", async () => {
  const c = await m.queue(actor.email, d.id, { action: "uninstall" });
  await m.acknowledge(d, c.id, { state: "running" });
  await expect(device(req(), db)).rejects.toMatchObject({
    code: "credential_revoked",
  });
  await expect(device(req(), db, randomUUID())).rejects.toMatchObject({
    code: "credential_revoked",
  });
  const grant = await device(req(), db, c.id);
  await m.acknowledge(grant, c.id, { state: "completed", result: "removed" });
  await expect(
    m.acknowledge({ ...d, installationId: randomUUID() }, c.id, {
      state: "completed",
      result: "removed",
    }),
  ).rejects.toMatchObject({ code: "command_not_found" });
  expect((await db.get(`enrollmentBatches/${g.id}`))?.count).toBe(0);
});
it("does not grant result access for revoked update credentials or a replacement installation", async () => {
  const c = await m.queue(actor.email, d.id, { action: "update" });
  await m.acknowledge(d, c.id, { state: "running" });
  await s.revoke(d, actor.email);
  await expect(device(req(), db, c.id)).rejects.toMatchObject({
    code: "credential_revoked",
  });
});
it("bulk actions are replay safe and report unsupported collectors individually", async () => {
  const operationId = randomUUID();
  const a = await m.bulk(actor.email, g.id, { action: "update", operationId });
  const b = await m.bulk(actor.email, g.id, { action: "update", operationId });
  expect(b.results).toEqual(a.results);
  expect((await db.query("deviceCommands")).length).toBe(1);
  await m.cancel(actor.email, (await db.query("deviceCommands"))[0].id);
  await db.transaction(async (tx) => {
    const old = await tx.get(`devices/${d.id}`);
    tx.set(`devices/${d.id}`, {
      ...old,
      metadata: { ...metadata, managementProtocol: undefined },
    });
  });
  const result = await m.bulk(actor.email, g.id, {
    action: "update",
    operationId: randomUUID(),
  });
  expect(result.results[d.id]).toBe("collector_upgrade_required");
});
it("resolves filename dates in the Mac timezone and falls back for invalid or ambiguous times", () => {
  const source = {
    basename:
      "org.safeexambrowser.SafeExamBrowser 2026-10-06--03-20-54-455.log",
    mtime: "2026-10-06T18:00:00.000Z",
  };
  expect(logDate(source, "America/Denver")).toEqual({
    logStartedAt: "2026-10-06T09:20:54.455Z",
    logDateBasis: "filename",
  });
  expect(
    logDate(
      { ...source, basename: "x 2026-02-30--03-20-54-455.log" },
      "America/Denver",
    ).logDateBasis,
  ).toBe("modified");
  expect(
    logDate(
      { ...source, basename: "x 2026-11-01--01-30-00-000.log" },
      "America/Denver",
    ).logDateBasis,
  ).toBe("modified");
});
it("sorts session and received dates independently before pagination in both directions", async () => {
  for (let i = 0; i < 111; i++)
    db.docs.set(`logs/${i}`, {
      id: String(i),
      logStartedAt: new Date(Date.now() - i * 60000).toISOString(),
      acceptedAt: new Date(Date.now() - (110 - i) * 60000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      serial: "FIXTURE",
    });
  for (const sort of [
    "session-newest",
    "session-oldest",
    "received-newest",
    "received-oldest",
  ]) {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const url = new URL("https://example.org");
      url.searchParams.set("sort", sort);
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await s.list("logs", url);
      ids.push(...page.items.map((v) => v.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.length).toBe(111);
    expect(new Set(ids).size).toBe(111);
    expect(ids[0]).toBe(
      ["session-newest", "received-oldest"].includes(sort) ? "0" : "110",
    );
  }
});
it("keeps session lookup scoped to the selected device and catalog filters", async () => {
  const time = new Date().toISOString();
  for (const [id, deviceId, sourceUser] of [
    ["match", d.id, "fixture"],
    ["other-device", "other", "fixture"],
    ["other-user", d.id, "someone"],
  ]) {
    db.docs.set(`logs/${id}`, {
      id,
      deviceId,
      sourceUser,
      searchTokens: ["safe"],
      metadata: {
        macOSVersion: "26",
        sebVersion: "3",
        collectorVersion: "0.3.0",
      },
      logStartedAt: time,
      acceptedAt: time,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    db.docs.set(`sessionLinks/${id}`, {
      id,
      logId: id,
      instance: "fixture",
      session: "session",
      logStartedAt: time,
      acceptedAt: time,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
  }
  const url = new URL(
    `https://example.org?instance=fixture&session=session&deviceId=${d.id}&sourceUser=fixture&q=safe&macOS=26&seb=3&collector=0.3.0`,
  );
  expect((await s.list("logs", url)).items.map((v) => v.id)).toEqual(["match"]);
  url.searchParams.set("q", "missing");
  expect((await s.list("logs", url)).items).toEqual([]);
});
