export const DIAGNOSTIC_SCHEMA = "soe.diagnostics";
export const DIAGNOSTIC_VERSION = 1;
export const RETENTION_MS = 90 * 86400000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type EvidenceSource = "server" | "browser" | "seb_log" | "canvas" | "legacy";
export interface IdentityContext {
  canvasUserId: string;
  displayName?: string;
  email?: string;
  roles?: string[];
  courseName?: string;
  sectionIds?: string[];
  sectionNames?: string[];
}
export interface IdentityEnvelope {
  version: 1;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface DiagnosticEvent {
  schema: typeof DIAGNOSTIC_SCHEMA;
  schemaVersion: 1;
  eventId: string;
  installationId: string;
  occurredAt: string;
  flowId: string;
  attemptId?: string;
  subjectKey?: string;
  stage: string;
  outcome: "started" | "succeeded" | "failed" | "observed" | "unknown";
  source: EvidenceSource;
  severity: "INFO" | "WARNING" | "ERROR";
  reasonCode?: string;
  courseId?: string;
  contentId?: string;
  contentType?: "CLASSIC_QUIZ" | "NEW_QUIZ";
  configurationRevision?: string;
  durationMs?: number;
  status?: number;
  traceId?: string;
  spanId?: string;
  revision?: string;
  detectorVersion?: string;
  sebVersion?: string;
  osVersion?: string;
  clientOccurredAt?: string;
  clientSequence?: number;
  identity?: IdentityEnvelope;
  errorFingerprint?: string;
  stackFrames?: string[];
  details?: Record<string, string | number | boolean>;
}
const textFields: Record<string, number> = {
  installationId: 80,
  subjectKey: 100,
  stage: 80,
  reasonCode: 100,
  courseId: 100,
  contentId: 200,
  configurationRevision: 100,
  traceId: 32,
  spanId: 16,
  revision: 100,
  detectorVersion: 100,
  sebVersion: 80,
  osVersion: 80,
  errorFingerprint: 64
};
const allowed = new Set([
  "schema",
  "schemaVersion",
  "eventId",
  "occurredAt",
  "flowId",
  "attemptId",
  "outcome",
  "source",
  "severity",
  "contentType",
  "durationMs",
  "status",
  "clientOccurredAt",
  "clientSequence",
  "identity",
  "stackFrames",
  "details",
  ...Object.keys(textFields)
]);
const detailKeys = new Set([
  "enabled",
  "sebRequired",
  "startPasswordConfigured",
  "quitPasswordConfigured",
  "operation",
  "route",
  "httpMethod",
  "retry",
  "retryAfterMs",
  "requestCost",
  "quotaRemaining",
  "tokenPresent",
  "sessionPresent",
  "originPresent",
  "bindingMatches",
  "tokenAgeMs",
  "rowCount",
  "sourceLine",
  "cache",
  "scopeProfile",
  "decryptionStage",
  "elapsedMs",
  "count",
  "parserVersion",
  "traceSampled",
  "grantType",
  "attempts",
  "queryCategory"
]);
export function validateEvent(value: unknown): DiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_EVENT");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !allowed.has(k)) ||
    v.schema !== DIAGNOSTIC_SCHEMA ||
    v.schemaVersion !== 1 ||
    !UUID.test(String(v.eventId)) ||
    !UUID.test(String(v.flowId)) ||
    (v.attemptId !== undefined && !UUID.test(String(v.attemptId)))
  )
    throw new Error("INVALID_EVENT_CONTRACT");
  if (!v.installationId || !v.stage || !/^[a-z][a-z0-9_.-]{0,79}$/.test(String(v.stage)))
    throw new Error("INVALID_EVENT_STAGE");
  if (
    !["started", "succeeded", "failed", "observed", "unknown"].includes(String(v.outcome)) ||
    !["server", "browser", "seb_log", "canvas", "legacy"].includes(String(v.source)) ||
    !["INFO", "WARNING", "ERROR"].includes(String(v.severity))
  )
    throw new Error("INVALID_EVENT_ENUM");
  if (typeof v.occurredAt !== "string" || !Number.isFinite(Date.parse(v.occurredAt)) || !v.occurredAt.endsWith("Z"))
    throw new Error("INVALID_EVENT_TIME");
  for (const [key, max] of Object.entries(textFields))
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "string" ||
        (v[key] as string).length > max ||
        Array.from(v[key] as string).some((char) => char.charCodeAt(0) < 32))
    )
      throw new Error("INVALID_EVENT_FIELD");
  for (const key of ["durationMs", "status", "clientSequence"])
    if (v[key] !== undefined && (typeof v[key] !== "number" || !Number.isFinite(v[key]) || (v[key] as number) < 0))
      throw new Error("INVALID_EVENT_NUMBER");
  if (v.status !== undefined && (!Number.isInteger(v.status) || Number(v.status) > 599))
    throw new Error("INVALID_EVENT_STATUS");
  if (v.contentType !== undefined && !["CLASSIC_QUIZ", "NEW_QUIZ"].includes(String(v.contentType)))
    throw new Error("INVALID_EVENT_CONTENT");
  if (
    v.clientOccurredAt !== undefined &&
    (typeof v.clientOccurredAt !== "string" || !Number.isFinite(Date.parse(v.clientOccurredAt)))
  )
    throw new Error("INVALID_CLIENT_TIME");
  if (v.traceId !== undefined && !/^[a-f0-9]{32}$/.test(String(v.traceId))) throw new Error("INVALID_TRACE");
  if (v.spanId !== undefined && !/^[a-f0-9]{16}$/.test(String(v.spanId))) throw new Error("INVALID_SPAN");
  if (v.reasonCode !== undefined && !/^[A-Z0-9_]{1,100}$/.test(String(v.reasonCode))) throw new Error("INVALID_REASON");
  if (v.details !== undefined) {
    if (!v.details || typeof v.details !== "object" || Array.isArray(v.details) || Object.keys(v.details).length > 20)
      throw new Error("INVALID_DETAILS");
    for (const [key, item] of Object.entries(v.details))
      if (
        !detailKeys.has(key) ||
        !["string", "number", "boolean"].includes(typeof item) ||
        (typeof item === "string" &&
          (!/^[a-zA-Z0-9_./:{} -]{0,160}$/.test(item) ||
            /(?:bearer|secret|password|access.?code|token=)/i.test(item))) ||
        (typeof item === "number" && !Number.isFinite(item))
      )
        throw new Error("INVALID_DETAILS_FIELD");
  }
  if (v.identity !== undefined) {
    const e = v.identity as IdentityEnvelope;
    if (
      !e ||
      typeof e !== "object" ||
      Object.keys(e).some((k) => !["version", "keyId", "iv", "tag", "ciphertext"].includes(k)) ||
      e.version !== 1 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(e.keyId) ||
      !/^[A-Za-z0-9_-]{16}$/.test(e.iv) ||
      !/^[A-Za-z0-9_-]{22}$/.test(e.tag) ||
      !/^[A-Za-z0-9_-]{1,16384}$/.test(e.ciphertext)
    )
      throw new Error("INVALID_IDENTITY_ENVELOPE");
  }
  if (
    v.stackFrames !== undefined &&
    (!Array.isArray(v.stackFrames) ||
      v.stackFrames.length > 8 ||
      v.stackFrames.some((f) => typeof f !== "string" || !/^at [A-Za-z0-9_.$<> /:@()-]{1,180}$/.test(f)))
  )
    throw new Error("INVALID_STACK");
  return v as unknown as DiagnosticEvent;
}
export function eventOutcome(events: DiagnosticEvent[]) {
  if (events.some((e) => e.source === "canvas" && e.stage === "canvas.submission" && e.outcome === "succeeded"))
    return "Canvas submission confirmed";
  const entry = events.some(
    (e) => e.source === "server" && e.stage === "access_code.released" && e.outcome === "succeeded"
  );
  if (entry) return events.some((e) => e.outcome === "failed") ? "Recovered" : "Entry confirmed";
  if (events.some((e) => e.outcome === "failed")) return "Failure observed";
  return "No further observation";
}
