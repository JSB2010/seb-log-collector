import { afterEach, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { sha } from "../src/server/crypto";
import { store } from "../src/server/store";
import { route } from "../src/server/router";
const raw = Buffer.from('<script>alert("synthetic")</script>\nSynthetic log\n');
vi.mock("../src/server/storage", async (original) => {
  const actual = await original<typeof import("../src/server/storage")>();
  return {
    ...actual,
    object: () => ({ createReadStream: () => Readable.from([gzipSync(raw)]) }),
    logText: () => Readable.toWeb(Readable.from([raw])),
  };
});
afterEach(() => vi.unstubAllEnvs());
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  authenticated = true,
) =>
  new Request(`https://diagnostics.example.org/api/admin/v1/${path}`, {
    method,
    headers: authenticated
      ? { "x-dev-admin": "true", "content-type": "application/json" }
      : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
it("routes repeat installer downloads separately from enrollment creation and rejects unauthenticated retrieval", async () => {
  vi.stubEnv("DEV_AUTH", "true");
  const response = await route(
    request("enrollment-batches", "POST", {
      label: "Route fixture",
      ceiling: 3,
      days: 1,
    }),
  );
  expect(response.status).toBe(201);
  const batch = await response.json();
  const first = await route(
    request(`enrollment-batches/${batch.id}/installer`, "POST"),
  );
  const second = await route(
    request(`enrollment-batches/${batch.id}/installer`, "POST"),
  );
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const source = await first.text();
  expect(await second.text()).toBe(source);
  expect(source).toContain(batch.code);
  expect(source).toContain("# BEGIN ENROLLMENT BOOTSTRAP");
  expect(source).not.toContain("base64 -D");
  expect(
    (
      await route(
        request(
          `enrollment-batches/${batch.id}/installer`,
          "POST",
          undefined,
          false,
        ),
      )
    ).status,
  ).toBe(401);
  expect((await route(request("scripts/update"))).status).toBe(200);
  expect((await route(request("scripts/arbitrary"))).status).toBe(404);
});
it("opens verified immutable bytes as inline plain text with authentication and no HTML execution", async () => {
  vi.stubEnv("DEV_AUTH", "true");
  const gz = gzipSync(raw),
    expiresAt = new Date(Date.now() + 86400000).toISOString();
  await store().transaction(async (tx) =>
    tx.set("logs/inline-fixture", {
      id: "inline-fixture",
      acceptedAt: new Date().toISOString(),
      expiresAt,
      objectKey: "synthetic",
      generation: "1",
      rawBytes: raw.length,
      gzipBytes: gz.length,
      rawSha256: sha(raw),
      gzipSha256: sha(gz),
    }),
  );
  expect(
    (await route(request("logs/inline-fixture/open", "GET", undefined, false)))
      .status,
  ).toBe(401);
  const response = await route(request("logs/inline-fixture/open"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe(raw.toString());
});
