import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/server/store";
import { Service } from "../src/server/service";
import { credentialHash, secret } from "../src/server/crypto";

// Bounded functional cohort check. Memory throughput is not Cloud Run capacity.
it("enrolls, reports, and paginates 1,000 isolated synthetic devices", async () => {
  const db = new MemoryStore(),
    service = new Service(db);
  const actor = { email: "it@example.org", sub: "cohort", csrf: "cohort" };
  const metadata = {
    collectorVersion: "0.1.0",
    architecture: "synthetic",
    macOSVersion: "synthetic",
    macOSBuild: "TEST",
    sebVersion: null,
    timezone: "Etc/UTC",
    reportedAt: new Date().toISOString(),
  };
  const devices: string[] = [];
  const batch = await service.createBatch(actor, {
    mode: "jamf",
    label: "Synthetic cohort",
    ceiling: 1000,
  });
  for (let i = 0; i < 1000; i++) {
    const serial = `COHORT-${String(i).padStart(4, "0")}`;
    const installationId = randomUUID();
    const enrolled = await service.enroll(batch.code, {
      schemaVersion: 1,
      serial,
      installationId,
      credentialHash: credentialHash(secret()),
      metadata,
    });
    devices.push(enrolled.deviceId);
    await service.collection(
      { id: enrolled.deviceId, installationId },
      {
        schemaVersion: 1,
        collectionId: randomUUID(),
        reason: "daily",
        startedAt: new Date().toISOString(),
        outcome: "no_logs",
        metadata,
      },
    );
  }
  expect(new Set(devices).size).toBe(1000);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const url = new URL("https://diagnostics.example.org/api/admin/v1/devices");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await service.list("devices", url);
    for (const device of page.items) {
      if (!device) throw new Error("Missing cohort device in pagination");
      expect(seen.has(device.id)).toBe(false);
      expect(device.lastOutcome).toBe("no_logs");
      seen.add(device.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(1000);
  expect(
    [...db.docs.keys()].filter((x) => x.startsWith("collections/")),
  ).toHaveLength(1000);
}, 30000);
