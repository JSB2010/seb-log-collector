import { DiagnosticTextRedactor } from "../../contracts/redaction";
import { randomUUID, createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { admin, bearer, type Actor } from "./auth";
import { config } from "./config";
import { sha, secret } from "./crypto";
import { ApiError, requireThat } from "./errors";
import { Service, audit, alive, expiry, now } from "./service";
import type { Store, Doc } from "./store";
import { object, verifyGzip, logText, download } from "./storage";
import { analyzeLog, redactDiagnosticText } from "../../contracts/redaction";

const clientsSchema = z.record(
  z.string().regex(/^[a-z0-9_-]{1,80}$/),
  z
    .object({
      origin: z.string().url(),
      webServiceAccount: z.string().email(),
      workerServiceAccount: z.string().email(),
      installations: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).min(1),
    })
    .strict(),
);
export function integrationClients() {
  let value: unknown;
  try {
    value = JSON.parse(config().INTEGRATION_CLIENTS);
  } catch {
    throw new ApiError(503, "integration_configuration_invalid");
  }
  const clients = clientsSchema.parse(value);
  for (const c of Object.values(clients)) {
    const u = new URL(c.origin);
    requireThat(
      u.origin === c.origin &&
        (u.protocol === "https:" ||
          (!process.env.K_SERVICE &&
            process.env.NODE_ENV !== "production" &&
            u.hostname === "127.0.0.1")),
      503,
      "integration_origin_invalid",
    );
  }
  return clients;
}
const google = new OAuth2Client();
export async function integrationService(req: Request) {
  const clients = integrationClients();
  const c = config();
  let email: string | undefined;
  try {
    const t = await google.verifyIdToken({
      idToken: bearer(req),
      audience: c.PUBLIC_ORIGIN + "/api/integration/v2",
    });
    const p = t.getPayload();
    if (p?.email_verified) email = p.email;
  } catch {
    throw new ApiError(401, "integration_denied");
  }
  for (const [id, client] of Object.entries(clients)) {
    if (email === client.webServiceAccount)
      return { id, client, role: "web" as const };
    if (email === client.workerServiceAccount)
      return { id, client, role: "worker" as const };
  }
  throw new ApiError(403, "integration_service_denied");
}
export async function integrationActor(
  req: Request,
  db: Store,
): Promise<Actor> {
  let value: unknown;
  try {
    const h = req.headers.get("x-soe-actor") || "";
    requireThat(h.length < 2048, 400, "actor_invalid");
    value = JSON.parse(Buffer.from(h, "base64url").toString());
  } catch {
    throw new ApiError(401, "actor_required");
  }
  const a = z
    .object({
      email: z.string().email().max(320),
      sub: z.string().min(1).max(200),
    })
    .strict()
    .parse(value);
  const entry = await db.get("admins/" + sha(a.email.toLowerCase()));
  requireThat(
    entry?.active && entry.sub === a.sub && a.email === a.email.toLowerCase(),
    403,
    "admin_denied",
  );
  return { ...a, csrf: "" };
}
async function readBody(req: Request) {
  requireThat(
    req.headers.get("content-type")?.split(";")[0] === "application/json",
    415,
    "json_required",
  );
  const reader = req.body?.getReader();
  requireThat(reader, 400, "body_required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      requireThat(size <= 16384, 413, "body_too_large");
      chunks.push(r.value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}
const json = (v: unknown, status = 200) =>
  Response.json(v, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
export function safeLog(l: Doc) {
  return {
    id: l.id,
    deviceId: l.deviceId,
    acceptedAt: l.acceptedAt,
    uploadedAt: l.uploadedAt,
    logStartedAt: l.logStartedAt,
    logDateBasis: l.logDateBasis,
    expiresAt: l.expiresAt,
    rawBytes: l.rawBytes,
    sourceBasename: l.source?.basename,
    sourceUser: l.sourceUser,
    assignedLabel: l.assignedLabel,
    schoolEmail: l.schoolEmail,
    metadata: {
      collectorVersion: l.metadata?.collectorVersion,
      macOSVersion: l.metadata?.macOSVersion,
      sebVersion: l.metadata?.sebVersion,
      sebBuild: l.metadata?.sebBuild,
      timezone: l.metadata?.timezone,
    },
    analysis: l.analysis || null,
    evidenceSource: "client_reported",
  };
}
let readers = 0;
export async function inspectLog(
  l: Doc,
  options: {
    offset?: number;
    limit?: number;
    search?: string;
    analyze?: boolean;
  } = {},
) {
  requireThat(readers < 1, 429, "log_reader_busy");
  readers++;
  try {
    requireThat(alive(l), 410, "log_expired");
    await verifyGzip(
      object(l.objectKey, l.generation).createReadStream(),
      l,
      0,
    );
    requireThat(alive(l), 410, "log_expired");
    const stream = logText(l).getReader();
    const decoder = new TextDecoder();
    let pending = "",
      number = 0,
      total = 0;
    const lines: { number: number; text: string }[] = [];
    const captured: string[] = [];
    let capped = false;
    const offset = options.offset || 0,
      limit = options.limit || 500;
    const redactor = new DiagnosticTextRedactor();
    const processLine = (line: string) => {
      number++;
      const safe = redactor.line(line.slice(0, 65536));
      if (options.analyze) {
        if (total < 8 * 1024 * 1024) captured.push(line.slice(0, 65536));
        else capped = true;
      } else if (options.search) {
        if (safe.toLowerCase().includes(options.search.toLowerCase())) {
          if (lines.length < 100)
            lines.push({ number, text: safe.slice(0, 8192) });
          else capped = true;
        }
      } else if (number > offset && lines.length < limit)
        lines.push({ number, text: safe.slice(0, 8192) });
    };
    try {
      for (;;) {
        requireThat(alive(l), 410, "log_expired");
        const r = await stream.read();
        if (r.done) break;
        total += r.value.byteLength;
        requireThat(total <= 64 * 1024 * 1024, 422, "log_too_large");
        pending += decoder.decode(r.value, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          processLine(pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 65536) {
          processLine(pending.slice(0, 65536) + " [line truncated]");
          pending = "";
          capped = true;
        }
      }
      pending += decoder.decode();
      if (pending) processLine(pending);
    } finally {
      await stream.cancel().catch(() => {});
    }
    return options.analyze
      ? {
          ...analyzeLog(captured.join("\n")),
          partial: capped,
          lineCount: number,
        }
      : {
          lines,
          lineCount: number,
          nextOffset:
            !options.search && offset + lines.length < number
              ? offset + lines.length
              : null,
          truncated: capped,
        };
  } finally {
    readers--;
  }
}
export async function integrationRoute(req: Request, db: Store) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").slice(4);
  const [resource, id, action] = parts;
  const c = config();
  const s = new Service(db);
  if (resource === "auth" && id === "authorize" && req.method === "GET") {
    const clientId = z
      .string()
      .min(1)
      .max(80)
      .parse(url.searchParams.get("client_id"));
    const client = integrationClients()[clientId];
    requireThat(client, 403, "client_denied");
    const redirect = url.searchParams.get("redirect_uri");
    requireThat(
      redirect === client.origin + "/api/auth/callback",
      400,
      "redirect_denied",
    );
    const state = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{32,128}$/)
      .parse(url.searchParams.get("state"));
    const challenge = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{43}$/)
      .parse(url.searchParams.get("code_challenge"));
    requireThat(
      url.searchParams.get("code_challenge_method") === "S256",
      400,
      "pkce_required",
    );
    let a: Actor;
    try {
      a = await admin(req, false, db);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        return Response.redirect(
          c.PUBLIC_ORIGIN +
            "/api/auth/login?returnTo=" +
            encodeURIComponent(url.pathname + url.search),
          302,
        );
      throw e;
    }
    const code = secret();
    await db.transaction(async (tx) => {
      tx.set("integrationCodes/" + sha(code), {
        clientId,
        email: a.email,
        sub: a.sub,
        challenge,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        ttlAt: new Date(Date.now() + 120000),
      });
      audit(tx, a.email, "integration_sign_in", clientId);
    });
    const target = new URL(redirect!);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    return Response.redirect(target, 302);
  }
  const peer = await integrationService(req);
  if (resource === "auth" && id === "exchange" && req.method === "POST") {
    requireThat(peer.role === "web", 403, "operation_denied");
    const b = z
      .object({
        code: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
        verifier: z.string().regex(/^[a-zA-Z0-9_-]{43,128}$/),
      })
      .strict()
      .parse(await readBody(req));
    const actor = await db.transaction(async (tx) => {
      const path = "integrationCodes/" + sha(b.code);
      const code = await tx.get(path);
      requireThat(
        alive(code) &&
          code!.clientId === peer.id &&
          code!.challenge ===
            createHash("sha256").update(b.verifier).digest("base64url"),
        403,
        "authorization_code_invalid",
      );
      const a = await tx.get("admins/" + sha(code!.email));
      requireThat(a?.active && a.sub === code!.sub, 403, "admin_denied");
      tx.delete(path);
      return { email: code!.email, sub: code!.sub };
    });
    return json({ actor });
  }
  let actor: Actor | undefined;
  if (peer.role === "web") actor = await integrationActor(req, db);
  if (resource === "authorize" && req.method === "POST") {
    requireThat(actor, 403, "operation_denied");
    return json({ actor });
  }
  const instance =
    url.searchParams.get("instance") || peer.client.installations[0];
  requireThat(
    peer.client.installations.includes(instance),
    403,
    "installation_denied",
  );
  if (resource === "logs" && !id && req.method === "GET") {
    const since = z.iso
      .datetime()
      .parse(
        url.searchParams.get("since") ||
          new Date(Date.now() - 90 * 86400000).toISOString(),
      );
    const until = z.iso
      .datetime()
      .parse(url.searchParams.get("until") || now());
    const rows = await db.query(
      "logs",
      [
        ["acceptedAt", ">=", since],
        ["acceptedAt", "<=", until],
      ],
      "acceptedAt",
      url.searchParams.get("cursor") || undefined,
      50,
      "asc",
    );
    const items = rows.filter(alive).map(safeLog);
    const last = rows.at(-1);
    const cursor =
      rows.length === 50 && last
        ? Buffer.from(
            JSON.stringify({ value: last.acceptedAt, id: last.id }),
          ).toString("base64url")
        : null;
    if (actor)
      await db.transaction(async (tx) =>
        audit(tx, actor!.email, "integration_log_catalog", peer.id),
      );
    return json({
      items,
      nextCursor: cursor,
      watermark: until,
      installationId: instance,
    });
  }
  if (resource === "logs" && id === "reindex" && req.method === "POST") {
    requireThat(peer.role === "worker", 403, "operation_denied");
    const b = z
      .object({ cursor: z.string().max(2000).optional() })
      .strict()
      .parse(await readBody(req));
    const rows = await db.query("logs", [], "acceptedAt", b.cursor, 5, "asc");
    let indexed = 0;
    for (const l of rows.filter(alive)) {
      if (
        l.analysis?.parserVersion === 1 &&
        l.analysis?.parsingStatus !== "failed"
      )
        continue;
      if ((l.parserAttempts || 0) >= 3) continue;
      try {
        const analysis = {
          ...(await inspectLog(l, { analyze: true })),
          parsingStatus: "parsed",
        };
        await db.transaction(async (tx) => {
          const current = await tx.get("logs/" + l.id);
          if (alive(current))
            tx.set("logs/" + l.id, {
              ...current,
              analysis,
              catalogUpdatedAt: now(),
            });
        });
        indexed++;
      } catch (error) {
        if (error instanceof ApiError && [429, 503].includes(error.status))
          throw error;
        await db.transaction(async (tx) => {
          const current = await tx.get("logs/" + l.id);
          if (alive(current))
            tx.set("logs/" + l.id, {
              ...current,
              analysis: {
                parserVersion: 1,
                markers: [],
                findings: [],
                lineCount: 0,
                timestampBasis: "client_log_uncertain",
                parsingStatus: "failed",
              },
              parserAttempts: (current!.parserAttempts || 0) + 1,
              catalogUpdatedAt: now(),
            });
        });
      }
    }
    const last = rows.at(-1);
    return json({
      indexed,
      nextCursor:
        rows.length === 5 && last
          ? Buffer.from(
              JSON.stringify({ value: last.acceptedAt, id: last.id }),
            ).toString("base64url")
          : null,
    });
  }
  if (resource === "logs" && id && req.method === "GET" && !action) {
    const l = await s.log(id);
    return json(safeLog(l));
  }
  if (
    resource === "logs" &&
    id &&
    ["content", "download", "search"].includes(action || "")
  ) {
    requireThat(actor, 403, "operation_denied");
    const l = await s.log(id);
    await db.transaction(async (tx) =>
      audit(tx, actor!.email, "integration_log_" + action, id),
    );
    if (action === "download" && req.method === "GET") {
      await verifyGzip(
        object(l.objectKey, l.generation).createReadStream(),
        l,
        0,
      );
      await s.log(id);
      return new Response(download(l), {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": 'attachment; filename="' + id + '.log.gz"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (action === "content" && req.method === "GET") {
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(10000000)
        .parse(url.searchParams.get("offset") || 0);
      return json(await inspectLog(l, { offset, limit: 500 }));
    }
    if (action === "search" && req.method === "POST") {
      const b = z
        .object({ query: z.string().min(1).max(128) })
        .strict()
        .parse(await readBody(req));
      return json(await inspectLog(l, { search: b.query }));
    }
  }
  if (resource === "devices" && !id && req.method === "GET") {
    requireThat(actor, 403, "operation_denied");
    const rows = await db.query(
      "devices",
      [],
      "lastSeenAt",
      url.searchParams.get("cursor") || undefined,
      50,
      "desc",
    );
    const last = rows.at(-1);
    return json({
      items: rows.map((d) => ({
        id: d.id,
        assignedLabel: d.assignedLabel,
        schoolEmail: d.schoolEmail,
        serial: d.serial,
        lastSeenAt: d.lastSeenAt,
        active: !!d.activeInstallation,
        metadata: {
          computerName: d.metadata?.computerName,
          collectorVersion: d.metadata?.collectorVersion,
        },
      })),
      nextCursor:
        rows.length === 50 && last
          ? Buffer.from(
              JSON.stringify({ value: last.lastSeenAt, id: last.id }),
            ).toString("base64url")
          : null,
    });
  }
  if (resource === "requests" && id && req.method === "GET") {
    requireThat(actor, 403, "operation_denied");
    const r = await db.get("collectionRequests/" + id);
    requireThat(
      alive(r) && r!.integrationClient === peer.id,
      404,
      "request_not_found",
    );
    return json({
      id: r!.id,
      state: r!.state,
      from: r!.from,
      to: r!.to,
      expiresAt: r!.expiresAt,
      lastOutcome: r!.lastOutcome,
    });
  }
  if (
    resource === "devices" &&
    id &&
    action === "requests" &&
    req.method === "POST"
  ) {
    requireThat(actor, 403, "operation_denied");
    const b = z
      .object({
        operationId: z.uuid(),
        from: z.iso.datetime(),
        to: z.iso.datetime(),
      })
      .strict()
      .parse(await readBody(req));
    const from = Date.parse(b.from),
      to = Date.parse(b.to);
    requireThat(
      to > from &&
        to - from <= 86400000 &&
        from >= Date.now() - 90 * 86400000 &&
        to <= Date.now() + 300000,
      400,
      "request_range_invalid",
    );
    const out = await db.transaction(async (tx) => {
      const path = "collectionRequests/" + b.operationId;
      const existing = await tx.get(path);
      if (existing) {
        requireThat(
          existing.integrationClient === peer.id &&
            existing.creator === actor!.email &&
            existing.deviceId === id &&
            existing.from === b.from &&
            existing.to === b.to,
          409,
          "operation_conflict",
        );
        return existing;
      }
      const d = await tx.get("devices/" + id);
      requireThat(d?.activeInstallation, 409, "device_inactive");
      const key =
        "integrationBudgets/" +
        sha(peer.id + actor!.email + now().slice(0, 10));
      const budget = await tx.get(key);
      requireThat((budget?.count || 0) < 20, 429, "request_budget_exceeded");
      const out = {
        id: b.operationId,
        deviceId: id,
        state: "pending",
        creator: actor!.email,
        from: b.from,
        to: b.to,
        createdAt: now(),
        expiresAt: expiry(1),
        ttlAt: new Date(expiry()),
        integrationClient: peer.id,
      };
      tx.set(path, out);
      tx.set(key, {
        count: (budget?.count || 0) + 1,
        expiresAt: expiry(1),
        ttlAt: new Date(expiry(1)),
      });
      audit(tx, actor!.email, "integration_request_collection", id);
      return out;
    });
    return json(
      { id: out.id, state: out.state, expiresAt: out.expiresAt },
      201,
    );
  }
  if (resource === "session-links" && req.method === "POST") {
    requireThat(actor, 403, "operation_denied");
    const b = z
      .object({
        logId: z.string().regex(/^[A-Za-z0-9_-]{1,140}$/),
        instance: z.string().max(80),
        session: z.uuid(),
        remove: z.boolean().default(false),
      })
      .strict()
      .parse(await readBody(req));
    requireThat(
      peer.client.installations.includes(b.instance),
      403,
      "installation_denied",
    );
    const l = await s.log(b.logId);
    const lid = sha(b.logId + ":" + b.instance + ":" + b.session);
    await db.transaction(async (tx) => {
      if (b.remove) tx.delete("sessionLinks/" + lid);
      else
        tx.set("sessionLinks/" + lid, {
          id: lid,
          ...b,
          method: "manual",
          creator: actor!.email,
          createdAt: now(),
          acceptedAt: l.acceptedAt,
          logStartedAt: l.logStartedAt,
          expiresAt: l.expiresAt,
          ttlAt: new Date(l.expiresAt),
        });
      audit(
        tx,
        actor!.email,
        b.remove ? "integration_remove_link" : "integration_attach_session",
        l.id,
      );
    });
    return json({ linked: !b.remove });
  }
  throw new ApiError(404, "not_found");
}
