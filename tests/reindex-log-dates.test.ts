import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(args: string[], scenario = "single") {
  const dir = mkdtempSync(join(tmpdir(), "seb-date-reindex-"));
  const callsPath = join(dir, "calls.jsonl");
  const argsPath = join(dir, "gcloud-args");
  try {
    writeFileSync(
      join(dir, "gcloud"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$REINDEX_ARGS"\nprintf "test-token\\n"\n',
      { mode: 0o700 },
    );
    const mock = join(dir, "fetch.mjs");
    writeFileSync(
      mock,
      `
      import { appendFileSync } from "node:fs";
      globalThis.fetch = async (url, init) => {
        appendFileSync(process.env.REINDEX_CALLS, JSON.stringify({ url, method: init.method, body: JSON.parse(init.body) }) + "\\n");
        if (init.method === "PATCH") return new Response("{}", { status: process.env.REINDEX_SCENARIO === "conflict" ? 412 : 200 });
        const query = JSON.parse(init.body).structuredQuery;
        const count = process.env.REINDEX_SCENARIO === "pages" && !query.startAt ? 500 : 1;
        return Response.json(Array.from({ length: count }, (_, i) => ({ document: {
          name: "projects/test-project/databases/(default)/documents/logs/" + (query.startAt ? "last" : i),
          updateTime: "2026-10-21T20:00:00.000Z",
          fields: {
            logStartedAt: { stringValue: "2026-10-21T21:21:30.994Z" },
            source: { mapValue: { fields: {
              basename: { stringValue: "SEB 2026-10-21--15-21-30-994.log" },
              mtime: { stringValue: "2026-10-21T15:27:47.000Z" }
            } } }
          }
        } })));
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      [resolve("deployment/reindex-log-dates.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          NODE_OPTIONS: "--import=" + mock,
          REINDEX_ARGS: argsPath,
          REINDEX_CALLS: callsPath,
          REINDEX_SCENARIO: scenario,
        },
      },
    );
    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    return {
      ...result,
      args: read(argsPath),
      calls: read(callsPath)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const scoped = ["--project", "test-project", "--account", "appdev@example.org"];
it("requires explicit scoped credentials before calling gcloud or Firestore", () => {
  const result = run(["--project", "test-project"]);
  expect(result.status).not.toBe(0);
  expect(result.args).toBe("");
  expect(result.calls).toEqual([]);
});
it("previews all catalog pages without writing and leaves the active account alone", () => {
  const result = run(scoped, "pages");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    mode: "dry-run",
    scanned: 501,
    changed: 501,
  });
  expect(result.args.trim().split("\n")).toEqual([
    "--account=appdev@example.org",
    "--project=test-project",
    "auth",
    "print-access-token",
  ]);
  expect(result.calls).toHaveLength(2);
  expect(result.calls[1].body.structuredQuery.startAt).toEqual({
    values: [
      {
        referenceValue:
          "projects/test-project/databases/(default)/documents/logs/499",
      },
    ],
    before: false,
  });
  expect(result.calls.every((call) => call.method === "POST")).toBe(true);
});
it("updates only date fields with a concurrency precondition and stops on conflicts", () => {
  const result = run([...scoped, "--apply"]);
  expect(result.status, result.stderr).toBe(0);
  const patch = result.calls[1];
  const query = new URL(patch.url).searchParams;
  expect(patch.method).toBe("PATCH");
  expect(query.getAll("updateMask.fieldPaths")).toEqual([
    "logStartedAt",
    "logDateBasis",
  ]);
  expect(query.get("currentDocument.updateTime")).toBe(
    "2026-10-21T20:00:00.000Z",
  );
  expect(patch.body).toEqual({
    fields: {
      logStartedAt: { stringValue: "2026-10-21T15:21:30.994Z" },
      logDateBasis: { stringValue: "filename" },
    },
  });
  const conflict = run([...scoped, "--apply"], "conflict");
  expect(conflict.status).not.toBe(0);
  expect(conflict.stderr).toContain("HTTP 412");
  expect(conflict.calls).toHaveLength(2);
});
