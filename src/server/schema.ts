import { z } from "zod";
export const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  when = z.iso.datetime({ offset: false });
export const serial = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{4,80}$/);
const text = z
  .string()
  .max(200)
  .refine((s) => !/[\x00-\x1f]/.test(s));
export const metadata = z
  .object({
    collectorVersion: text,
    architecture: text,
    macOSVersion: text,
    macOSBuild: text,
    sebVersion: text.nullable(),
    sebBuild: text.nullable().optional(),
    sebPath: text.nullable().optional(),
    timezone: text,
    reportedAt: when,
    consoleUser: text.nullable().optional(),
    hostName: text.nullable().optional(),
    localHostName: text.nullable().optional(),
    computerName: text.nullable().optional(),
  })
  .strict();
export const source = z
  .object({
    username: text,
    uid: z.number().int().min(501),
    relativePath: text.refine(
      (s) => !s.startsWith("/") && !s.split("/").includes(".."),
    ),
    basename: text,
    mtime: when,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 ** 2),
  })
  .strict();
export const enrollment = z
  .object({
    schemaVersion: z.literal(1),
    installationId: uuid,
    serial,
    credentialHash: hash,
    metadata,
  })
  .strict();
export const prepare = z
  .object({
    schemaVersion: z.literal(1),
    collectionId: uuid,
    requestId: uuid.optional(),
    rawSha256: hash,
    rawBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 ** 2),
    gzipSha256: hash,
    gzipBytes: z
      .number()
      .int()
      .min(18)
      .max(20 * 1024 ** 2),
    source,
    metadata,
  })
  .strict();
export const collection = z
  .object({
    schemaVersion: z.literal(1),
    collectionId: uuid,
    reason: z.enum(["daily", "initial", "on_demand", "retry"]),
    requestId: uuid.optional(),
    startedAt: when,
    endedAt: when.optional(),
    outcome: z.enum([
      "running",
      "completed",
      "no_logs",
      "directory_missing",
      "unreadable",
      "seb_absent",
      "logging_disabled",
      "deferred",
      "paused",
      "blocked",
      "failed",
    ]),
    counts: z
      .record(z.string().max(40), z.number().int().min(0).max(100000))
      .default({}),
    errors: z
      .array(
        z.enum([
          "read_denied",
          "unstable",
          "oversize",
          "quota",
          "transport",
          "disk_pressure",
          "staging_evicted",
          "auth",
          "missing_tool",
        ]),
      )
      .max(20)
      .default([]),
    metadata,
  })
  .strict();
export const rosterEntry = z
  .object({
    serial,
    assignedLabel: text.default(""),
    schoolEmail: z.union([z.email().max(254), z.literal("")]).default(""),
    jamfId: text.default(""),
  })
  .strict();
export const batch = z.union([
  z
    .object({
      mode: z.literal("jamf"),
      label: text.min(1),
      ceiling: z.number().int().min(1).max(1000).default(1000),
      days: z.number().int().min(1).max(7).default(7),
    })
    .strict(),
  z
    .object({
      mode: z.literal("roster").default("roster"),
      roster: z.array(rosterEntry).min(1).max(400),
      days: z.number().int().min(1).max(7).default(7),
    })
    .strict(),
]);
export const requestSchema = z
  .object({ from: when, to: when })
  .strict()
  .refine((v) => new Date(v.to) > new Date(v.from), "Invalid time range");
