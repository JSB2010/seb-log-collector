import { Management } from "./management";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enrollmentInstaller } from "../components/enrollment";
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
import { object, verifyGzip, download, logText } from "./storage";
import * as schema from "./schema";
const scriptResponse = (source: string, name: string) =>
  new Response(source, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
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
      s = new Service(db),
      management = new Management(db, s);
    if (group === "device") {
      requireThat(version === "v1", 404, "not_found");
      if (resource === "enroll" && req.method === "POST")
        out = json(await s.enroll(bearer(req), await body(req)));
      else {
        const d = await device(
          req,
          db,
          resource === "commands" && action === "ack" && req.method === "POST"
            ? id
            : undefined,
        );
        if (id) validId(id);
        if (resource === "config" && req.method === "GET") {
          if (req.headers.get("x-collector-management") === "1") {
            d.metadata = { ...d.metadata, managementProtocol: 1 };
            await db.transaction(async (tx) => {
              const current = await tx.get(`devices/${d.id}`);
              if (current?.activeInstallation === d.installationId)
                tx.set(`devices/${d.id}`, {
                  ...current,
                  metadata: { ...current!.metadata, managementProtocol: 1 },
                });
            });
          }
          const [settings, commands] = await Promise.all([
            s.deviceConfig(d),
            management.commands(d),
          ]);
          out = json({ ...settings, commands });
        } else if (
          resource === "commands" &&
          action === "ack" &&
          req.method === "POST"
        )
          out = json(await management.acknowledge(d, id, await body(req)));
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
              adminUrl: `${c.PUBLIC_ORIGIN}/logs?selected=${log!.id}`,
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
          "deviceCommands",
          "groupOperations",
        ].includes(resource) &&
        !id &&
        req.method === "GET"
      )
        out = json(await s.list(resource, url));
      else if (resource === "enrollment-groups" && req.method === "GET")
        out = json(await management.groups());
      else if (resource === "deviceCommands" && id && req.method === "DELETE")
        out = json(await management.cancel(a.email, id));
      else if (
        resource === "devices" &&
        action === "commands" &&
        req.method === "POST"
      )
        out = json(await management.queue(a.email, id, await body(req)), 201);
      else if (
        resource === "enrollment-batches" &&
        action === "actions" &&
        req.method === "POST"
      )
        out = json(await management.bulk(a.email, id, await body(req)));
      else if (resource === "devices" && id && req.method === "GET") {
        const d = await db.get(`devices/${id}`);
        requireThat(d, 404, "device_not_found");
        const [collections, logs, requests, commands, group] =
          await Promise.all([
            db.query(
              "collections",
              [["deviceId", "==", id]],
              "receivedAt",
              undefined,
              50,
              "desc",
            ),
            db.query(
              "logs",
              [["deviceId", "==", id]],
              "logStartedAt",
              undefined,
              50,
              "desc",
            ),
            db.query(
              "collectionRequests",
              [["deviceId", "==", id]],
              "createdAt",
              undefined,
              50,
              "desc",
            ),
            db.query(
              "deviceCommands",
              [["deviceId", "==", id]],
              "createdAt",
              undefined,
              50,
              "desc",
            ),
            db.get(
              `enrollmentBatches/${d.enrollmentGroupId ?? d.enrollmentBatchId}`,
            ),
          ]);
        out = json({
          device: {
            ...d,
            groupLabel: group?.label,
            pendingCommand: commands.some(
              (c) =>
                c.id === d.pendingCommand &&
                c.expiresAt > now() &&
                !["completed", "cancelled", "failed"].includes(c.state),
            )
              ? d.pendingCommand
              : null,
          },
          collections: collections.filter(alive),
          logs: logs.filter(alive),
          requests: requests.filter(alive),
          commands,
        });
      } else if (resource === "scripts" && id && req.method === "GET") {
        const names: Record<string, string> = {
          update: "update.zsh",
          uninstall: "uninstall.zsh",
          collect: "collect-now.zsh",
          pause: "pause.zsh",
          resume: "resume.zsh",
        };
        requireThat(names[id], 404, "script_not_found");
        const source = await readFile(
          join(process.cwd(), "public/collector", names[id]),
          "utf8",
        );
        await db.transaction(async (tx) =>
          audit(tx, a.email, "download_management_script", id),
        );
        out = scriptResponse(source, `safe-online-exam-logs-${id}.zsh`);
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
        } else if (req.method === "GET" && action === "open") {
          await verifyGzip(
            object(l.objectKey, l.generation).createReadStream(),
            l,
            0,
          );
          await s.log(id);
          out = new Response(logText(l), {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "content-disposition": `inline; filename="${id}.log"`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy":
                "default-src 'none'; sandbox; frame-ancestors 'none'",
            },
          });
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
        out = json(await management.updateDevice(a.email, id, await body(req)));
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
      } else if (
        resource === "enrollment-batches" &&
        !id &&
        req.method === "POST"
      )
        out = json(await s.createBatch(a, await body(req)), 201);
      else if (
        resource === "enrollment-batches" &&
        id &&
        req.method === "PATCH"
      )
        out = json(await s.updateBatch(a, id, await body(req)));
      else if (
        resource === "enrollment-batches" &&
        id &&
        action === "installer" &&
        req.method === "POST"
      ) {
        const credentials = await s.batchInstaller(a, id);
        const source = await readFile(
          join(process.cwd(), "public/collector/install.zsh"),
          "utf8",
        );
        out = scriptResponse(
          enrollmentInstaller(source, credentials.code, credentials.origin),
          "safe-online-exam-logs-install-and-enroll.zsh",
        );
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
              acceptedAt: l.acceptedAt,
              logStartedAt: l.logStartedAt,
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
              "createdAt",
              undefined,
              50,
              "desc",
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
