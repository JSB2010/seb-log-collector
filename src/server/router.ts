import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import {
  admin,
  device,
  scheduler,
  oauth,
  bearer,
  cookie,
  seedAdmins,
} from "./auth";
import { store, type Doc } from "./store";
import { Service, audit, now, expiry, alive, searchTokens } from "./service";
import { ApiError, requireThat } from "./errors";
import { sha, equal } from "./crypto";
import { object, verifyGzip, download } from "./storage";
import * as schema from "./schema";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });
async function body(req: Request) {
  requireThat(
    req.headers.get("content-type")?.split(";")[0] === "application/json",
    415,
    "json_required",
  );
  requireThat(
    Number(req.headers.get("content-length") ?? 0) <= 262144,
    413,
    "body_too_large",
  );
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "body_required");
  let n = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      n += r.value.length;
      requireThat(n <= 262144, 413, "body_too_large");
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
const validId = (s: string) => {
  requireThat(/^[a-zA-Z0-9_-]{1,140}$/.test(s), 400, "invalid_id");
  return s;
};
export async function route(req: Request) {
  const rid = randomUUID(),
    url = new URL(req.url),
    parts = url.pathname.slice(5).split("/"),
    [group, version, resource, id, action] = parts;
  let out: Response;
  try {
    if (group === "health") {
      config();
      return json({ status: "ok", schemaVersion: 1 });
    }
    if (group === "auth") return await oauth(req, version);
    const db = store(),
      s = new Service(db);
    if (group === "device") {
      requireThat(version === "v1", 404, "not_found");
      if (resource === "enroll" && req.method === "POST")
        out = json(await s.enroll(bearer(req), await body(req)));
      else {
        const d = await device(req, db);
        if (id) validId(id);
        if (resource === "config" && req.method === "GET")
          out = json(await s.deviceConfig(d));
        else if (resource === "collections" && req.method === "POST")
          out = json(await s.collection(d, await body(req)));
        else if (
          resource === "uploads" &&
          id === "prepare" &&
          req.method === "POST"
        )
          out = json(await s.prepare(d, await body(req)));
        else if (
          resource === "uploads" &&
          action === "complete" &&
          req.method === "POST"
        )
          out = json(await s.complete(d, id));
        else if (resource === "uploads" && req.method === "GET") {
          const u = await s.upload(d, id);
          out = json({
            uploadId: u.id,
            state: u.state,
            expiresAt: u.policyExpiresAt,
            acknowledgment:
              u.state === "accepted" ? s.ack(await s.log(id)) : undefined,
          });
        } else if (
          resource === "requests" &&
          action === "ack" &&
          req.method === "POST"
        )
          out = json(await s.ackRequest(d, id, await body(req)));
        else if (resource === "deactivate" && req.method === "POST")
          out = json(await s.revoke(d, "device"));
        else throw new ApiError(404, "not_found");
      }
    } else if (
      group === "internal" &&
      resource === "maintenance" &&
      req.method === "POST"
    ) {
      await scheduler(req);
      out = json(await s.maintenance());
    } else if (group === "integration") {
      const c = config();
      requireThat(
        c.INTEGRATION_SECRET &&
          equal(sha(bearer(req)), sha(c.INTEGRATION_SECRET)),
        401,
        "integration_denied",
      );
      requireThat(
        version === "v1" && resource === "logs" && req.method === "GET",
        404,
        "not_found",
      );
      const instance = z
          .string()
          .min(1)
          .max(80)
          .parse(url.searchParams.get("instance")),
        session = z
          .string()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("session"));
      const links = await db.query(
        "sessionLinks",
        [
          ["instance", "==", instance],
          ["session", "==", session],
        ],
        "id",
        undefined,
        50,
      );
      const result = [];
      for (const l of links)
        if (alive(l)) {
          const log = await db.get(`logs/${l.logId}`);
          if (alive(log))
            result.push({
              logId: log!.id,
              deviceId: log!.deviceId,
              uploadedAt: log!.uploadedAt,
              expiresAt: log!.expiresAt,
              method: l.method,
              adminUrl: `${c.PUBLIC_ORIGIN}/?view=logs&log=${log!.id}`,
            });
        }
      await db.transaction(async (tx) =>
        audit(
          tx,
          "integration",
          "session_lookup",
          sha(`${instance}:${session}`),
        ),
      );
      out = json({ items: result });
    } else if (group === "admin") {
      requireThat(version === "v1", 404, "not_found");
      const mutate = !["GET", "HEAD"].includes(req.method),
        a = await admin(req, mutate, db);
      if (id) validId(id);
      if (resource === "me" && req.method === "GET") {
        if (config().DEV_AUTH === "true") await seedAdmins(db);
        out = json({
          email: a.email,
          csrf: a.csrf,
          oauthConfigured: !!config().GOOGLE_CLIENT_ID,
        });
      } else if (resource === "logout" && req.method === "POST")
        out = new Response(null, {
          status: 204,
          headers: { "set-cookie": cookie("soe_session", "", 0) },
        });
      else if (
        [
          "devices",
          "logs",
          "collections",
          "collectionRequests",
          "auditEvents",
          "enrollmentBatches",
          "admins",
        ].includes(resource) &&
        !id &&
        req.method === "GET"
      )
        out = json(await s.list(resource, url));
      else if (resource === "devices" && id && req.method === "GET") {
        const d = await db.get(`devices/${id}`);
        requireThat(d, 404, "device_not_found");
        const [collections, logs, requests] = await Promise.all([
          db.query(
            "collections",
            [["deviceId", "==", id]],
            "receivedAt",
            undefined,
            50,
          ),
          db.query(
            "logs",
            [["deviceId", "==", id]],
            "acceptedAt",
            undefined,
            50,
          ),
          db.query(
            "collectionRequests",
            [["deviceId", "==", id]],
            "id",
            undefined,
            50,
          ),
        ]);
        out = json({
          device: d,
          collections: collections.filter(alive),
          logs: logs.filter(alive),
          requests: requests.filter(alive),
        });
      } else if (resource === "logs" && id) {
        const l = await s.log(id);
        await db.transaction(async (tx) =>
          audit(tx, a.email, action ?? "view_log", id),
        );
        if (req.method === "GET" && action === "preview") {
          const result = await verifyGzip(
            object(l.objectKey, l.generation).createReadStream(),
            l,
          );
          await s.log(id);
          out = json(result);
        } else if (req.method === "GET" && action === "download")
          out = new Response(download(l), {
            headers: {
              "content-type": "application/gzip",
              "content-disposition": `attachment; filename="${id}.log.gz"`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        else if (req.method === "GET" && !action) out = json(l);
        else throw new ApiError(404, "not_found");
      } else if (
        resource === "devices" &&
        action === "requests" &&
        req.method === "POST"
      ) {
        const b = schema.requestSchema.parse(await body(req));
        requireThat(
          new Date(b.from).getTime() >= Date.now() - 90 * 86400000 &&
            new Date(b.to).getTime() <= Date.now() + 300000,
          400,
          "request_range_invalid",
        );
        const requestId = randomUUID(),
          expiresAt = expiry(1);
        await db.transaction(async (tx) => {
          const d = await tx.get(`devices/${id}`);
          requireThat(d?.activeInstallation, 409, "device_inactive");
          tx.set(`collectionRequests/${requestId}`, {
            ...b,
            id: requestId,
            deviceId: id,
            state: "pending",
            creator: a.email,
            createdAt: now(),
            expiresAt,
            ttlAt: new Date(expiry()),
          });
          audit(tx, a.email, "request_collection", id);
        });
        out = json({ id: requestId, state: "pending", expiresAt }, 201);
      } else if (resource === "devices" && id && req.method === "PATCH") {
        const b = z
          .object({
            state: z.enum(["active", "paused"]).optional(),
            assignedLabel: z.string().max(200).optional(),
            schoolEmail: z.union([z.email(), z.literal("")]).optional(),
            jamfId: z.string().max(200).optional(),
          })
          .strict()
          .parse(await body(req));
        await db.transaction(async (tx) => {
          const d = await tx.get(`devices/${id}`);
          requireThat(d, 404, "device_not_found");
          requireThat(d.activeInstallation || !b.state, 409, "device_inactive");
          tx.set(`devices/${id}`, {
            ...d,
            ...b,
            searchTokens: searchTokens(
              d.serial,
              b.assignedLabel ?? d.assignedLabel,
              b.schoolEmail ?? d.schoolEmail,
              d.metadata?.hostName,
            ),
          });
          audit(tx, a.email, b.state ?? "update_assignment", id);
        });
        out = json({ updated: true });
      } else if (
        resource === "devices" &&
        action === "revoke" &&
        req.method === "POST"
      )
        out = json(await s.revoke({ id }, a.email));
      else if (
        resource === "collectionRequests" &&
        id &&
        req.method === "DELETE"
      ) {
        await db.transaction(async (tx) => {
          const r = await tx.get(`collectionRequests/${id}`);
          requireThat(r, 404, "request_not_found");
          if (!["completed", "failed", "expired"].includes(r.state))
            tx.set(`collectionRequests/${id}`, {
              ...r,
              state: "cancelled",
              updatedAt: now(),
            });
          audit(tx, a.email, "cancel_request", id);
        });
        out = json({ cancelled: true });
      } else if (resource === "enrollment-batches" && req.method === "POST")
        out = json(await s.createBatch(a, await body(req)), 201);
      else if (
        resource === "enrollment-batches" &&
        id &&
        req.method === "PATCH"
      ) {
        const b = z
          .object({ state: z.literal("closed") })
          .strict()
          .parse(await body(req));
        await db.transaction(async (tx) => {
          const batch = await tx.get(`enrollmentBatches/${id}`);
          requireThat(batch, 404, "batch_not_found");
          tx.set(`enrollmentBatches/${id}`, { ...batch, ...b });
          audit(tx, a.email, "close_batch", id);
        });
        out = json({ closed: true });
      } else if (
        resource === "enrollment-batches" &&
        action === "reset" &&
        req.method === "POST"
      ) {
        const b = z
          .object({ serial: schema.serial })
          .strict()
          .parse(await body(req));
        const rid = `${id}-${sha(b.serial)}`;
        await db.transaction(async (tx) => {
          const r = await tx.get(`enrollmentRoster/${rid}`);
          requireThat(r, 404, "roster_not_found");
          const d = r.deviceId
            ? await tx.get(`devices/${r.deviceId}`)
            : undefined;
          requireThat(!d?.activeInstallation, 409, "revoke_before_reset");
          const batch = await tx.get(`enrollmentBatches/${id}`);
          requireThat(batch, 404, "batch_not_found");
          tx.set(`enrollmentRoster/${rid}`, {
            ...r,
            installationId: null,
            resetAt: now(),
          });
          tx.set(`enrollmentBatches/${id}`, {
            ...batch,
            count: Math.max(0, batch.count - 1),
          });
          audit(tx, a.email, "reset_roster_serial", rid);
        });
        out = json({ reset: true });
      } else if (resource === "admins" && req.method === "POST") {
        await seedAdmins(db);
        const b = z
            .object({ email: z.email(), active: z.boolean() })
            .strict()
            .parse(await body(req)),
          email = b.email.toLowerCase();
        requireThat(
          config().domains.includes(email.split("@")[1]),
          400,
          "domain_denied",
        );
        await db.transaction(async (tx) => {
          const p = `admins/${sha(email)}`,
            old = await tx.get(p),
            state = await tx.get("settings/admins");
          const delta = Number(b.active) - Number(old?.active ?? false);
          requireThat(state && state.count + delta >= 1, 409, "last_admin");
          tx.set(p, {
            ...old,
            id: sha(email),
            email,
            active: b.active,
            sub: old?.sub ?? null,
            createdAt: old?.createdAt ?? now(),
          });
          tx.set("settings/admins", { ...state, count: state.count + delta });
          audit(
            tx,
            a.email,
            b.active ? "grant_admin" : "remove_admin",
            sha(email),
          );
        });
        out = json({ updated: true });
      } else if (resource === "session-links" && req.method === "POST") {
        const b = z
          .object({
            logId: z.string().max(100),
            instance: z.string().min(1).max(80),
            session: z.string().min(1).max(200),
            remove: z.boolean().default(false),
          })
          .strict()
          .parse(await body(req));
        validId(b.logId);
        const l = await s.log(b.logId),
          lid = sha(`${b.logId}:${b.instance}:${b.session}`);
        await db.transaction(async (tx) => {
          if (b.remove) tx.delete(`sessionLinks/${lid}`);
          else
            tx.set(`sessionLinks/${lid}`, {
              ...b,
              id: lid,
              method: "manual",
              creator: a.email,
              createdAt: now(),
              expiresAt: l.expiresAt,
              ttlAt: new Date(l.expiresAt),
            });
          audit(
            tx,
            a.email,
            b.remove ? "remove_session_link" : "attach_session",
            l.id,
          );
        });
        out = json({ updated: true });
      } else if (resource === "session-links" && req.method === "GET")
        out = json({
          items: (
            await db.query(
              "sessionLinks",
              [["logId", "==", validId(url.searchParams.get("logId") ?? "")]],
              "id",
            )
          ).filter(alive),
        });
      else throw new ApiError(404, "not_found");
    } else throw new ApiError(404, "not_found");
    out.headers.set("x-request-id", rid);
    return out;
  } catch (e) {
    const status =
        e instanceof ApiError ? e.status : e instanceof z.ZodError ? 400 : 500,
      code =
        e instanceof ApiError
          ? e.code
          : e instanceof z.ZodError
            ? "invalid_input"
            : "internal_error";
    if (status === 500)
      console.error(
        JSON.stringify({
          event: "request_failure",
          requestId: rid,
          code,
          errorType: (e as Error).name,
        }),
      );
    return json(
      {
        error: {
          code,
          requestId: rid,
          ...(e instanceof z.ZodError
            ? { fields: e.issues.map((i) => i.path.join(".")) }
            : {}),
        },
      },
      status,
    );
  }
}
