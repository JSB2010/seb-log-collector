import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { store, pageCursor, type Doc, type Store, type Tx } from "./store";
import { sha, equal, secret, sealBootstrap, openBootstrap } from "./crypto";
import { ApiError, requireThat } from "./errors";
import * as schema from "./schema";
import {
  signedPost,
  verifyObject,
  removeObject,
  object,
  verifyGzip,
  download,
} from "./storage";
import type { Actor } from "./auth";
export const now = () => new Date().toISOString();
export const expiry = (days = config().RETENTION_DAYS, base = Date.now()) =>
  new Date(base + days * 86400000).toISOString();
const limits = {
  rawBytes: 64 * 1024 ** 2,
  gzipBytes: 20 * 1024 ** 2,
  stagingBytes: 250 * 1024 ** 2,
  runSeconds: 300,
  stagingDays: 7,
};
const terminal = ["completed", "failed", "cancelled", "expired"];
export function audit(
  tx: Tx,
  actor: string,
  action: string,
  target: string,
  result = "success",
) {
  const id = randomUUID();
  tx.set(`auditEvents/${id}`, {
    id,
    actor,
    action,
    target,
    result,
    createdAt: now(),
    expiresAt: expiry(),
    ttlAt: new Date(expiry()),
  });
}
export const alive = (d: Doc | undefined) => !!d && d.expiresAt > now();
export function searchTokens(...values: unknown[]) {
  return [
    ...new Set(
      values.flatMap((v) =>
        typeof v === "string"
          ? v
              .toLowerCase()
              .split(/\s+/)
              .flatMap((word) =>
                Array.from({ length: Math.min(word.length, 40) - 1 }, (_, i) =>
                  word.slice(0, i + 2),
                ),
              )
          : [],
      ),
    ),
  ].slice(0, 250);
}
const checkCurrent = async (tx: Tx, d: Doc) => {
  const dev = await tx.get(`devices/${d.id}`),
    i = await tx.get(`installations/${d.installationId}`);
  requireThat(
    dev && i && !i.revokedAt && dev.activeInstallation === d.installationId,
    403,
    "credential_revoked",
  );
  return dev;
};
export class Service {
  constructor(
    public db: Store = store(),
    public storage = { signedPost, verifyObject, removeObject },
  ) {}
  async enroll(code: string, input: unknown) {
    const b = schema.enrollment.parse(input),
      codeHash = sha(code),
      deviceId = sha(b.serial).slice(0, 32);
    requireThat(/^[A-Za-z0-9_-]{43}$/.test(code), 401, "invalid_bootstrap");
    return this.db.transaction(async (tx) => {
      const index = await tx.get(`enrollmentTokens/${codeHash}`);
      const batchId = index?.batchId ?? codeHash;
      const batch = await tx.get(`enrollmentBatches/${batchId}`),
        old = await tx.get(`installations/${b.installationId}`),
        d = await tx.get(`devices/${deviceId}`);
      if (old) {
        requireThat(
          old.deviceId === deviceId &&
            equal(old.credentialHash, b.credentialHash) &&
            !old.revokedAt &&
            d?.activeInstallation === b.installationId,
          409,
          "enrollment_conflict",
        );
        return { deviceId, schemaVersion: 1 };
      }
      requireThat(
        batch &&
          batch.bootstrapHash === codeHash &&
          batch.state === "open" &&
          alive(batch),
        403,
        "bootstrap_closed",
      );
      requireThat(batch.count < batch.ceiling, 429, "batch_limit");
      requireThat(!d?.activeInstallation, 409, "enrollment_conflict");
      tx.set(`installations/${b.installationId}`, {
        id: b.installationId,
        deviceId,
        credentialHash: b.credentialHash,
        issuedAt: now(),
        revokedAt: null,
      });
      tx.set(`devices/${deviceId}`, {
        ...d,
        id: deviceId,
        serial: b.serial,
        assignedLabel: batch.label ?? "",
        schoolEmail: d?.schoolEmail ?? "",
        jamfId: d?.jamfId ?? "",
        enrollmentBatchId: batchId,
        activeInstallation: b.installationId,
        state: "active",
        retiredAt: null,
        expiresAt: null,
        ttlAt: null,
        enrolledAt: d?.enrolledAt ?? now(),
        lastSeenAt: now(),
        metadata: b.metadata,
        searchTokens: searchTokens(
          b.serial,
          batch.label ?? "",
          d?.schoolEmail ?? "",
          b.metadata.hostName,
        ),
      });
      tx.set(`enrollmentBatches/${batchId}`, {
        ...batch,
        count: batch.count + 1,
      });
      audit(tx, "device", "enroll", deviceId);
      return { schemaVersion: 1, deviceId };
    });
  }
  async deviceConfig(d: Doc) {
    const rows = await this.db.query(
      "collectionRequests",
      [
        ["deviceId", "==", d.id],
        ["state", "in", ["pending", "received", "deferred", "running"]],
      ],
      "id",
      undefined,
      20,
    );
    return {
      schemaVersion: 1,
      deviceId: d.id,
      serverTime: now(),
      paused: d.state === "paused",
      limits: { ...limits, dailyBytes: config().DEVICE_DAILY_BYTES },
      requests: rows.filter(alive).map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        state: r.state,
        expiresAt: r.expiresAt,
      })),
    };
  }
  async collection(d: Doc, input: unknown) {
    const b = schema.collection.parse(input),
      id = `${d.id}-${b.collectionId}`;
    return this.db.transaction(async (tx) => {
      const dev = await checkCurrent(tx, d);
      const prior = await tx.get(`collections/${id}`);
      let request;
      if (b.requestId) {
        request = await tx.get(`collectionRequests/${b.requestId}`);
        requireThat(request?.deviceId === d.id, 404, "request_not_found");
      }
      requireThat(
        !prior || prior.collectionId === b.collectionId,
        409,
        "collection_conflict",
      );
      const expiresAt = prior?.expiresAt ?? expiry();
      tx.set(`collections/${id}`, {
        ...b,
        id,
        deviceId: d.id,
        receivedAt: now(),
        expiresAt,
        ttlAt: new Date(expiresAt),
      });
      tx.set(`devices/${d.id}`, {
        ...dev,
        metadata: b.metadata,
        lastOutcome: b.outcome,
        lastCounts: b.counts,
        lastErrors: b.errors,
        lastScanAt: ["completed", "no_logs"].includes(b.outcome)
          ? now()
          : dev.lastScanAt,
        searchTokens: searchTokens(
          dev.serial,
          dev.assignedLabel,
          dev.schoolEmail,
          b.metadata.hostName,
          b.metadata.localHostName,
          b.metadata.computerName,
        ),
      });
      return {
        schemaVersion: 1,
        collectionId: b.collectionId,
        receivedAt: now(),
      };
    });
  }
  async prepare(d: Doc, input: unknown) {
    const b = schema.prepare.parse(input),
      dedupId = sha(`${d.id}:${b.rawSha256}`),
      day = now().slice(0, 10),
      id = randomUUID();
    const result = await this.db.transaction(async (tx) => {
      const dev = await checkCurrent(tx, d);
      requireThat(dev.state !== "paused", 403, "device_paused");
      requireThat(!dev.verificationBlocked, 403, "verification_blocked");
      const dedup = await tx.get(`dedup/${dedupId}`),
        existing = dedup
          ? await tx.get(
              `${dedup.accepted ? "logs" : "uploads"}/${dedup.uploadId}`,
            )
          : undefined;
      const collection = await tx.get(`collections/${d.id}-${b.collectionId}`);
      requireThat(collection, 409, "collection_required");
      const request = b.requestId
        ? await tx.get(`collectionRequests/${b.requestId}`)
        : undefined;
      if (b.requestId)
        requireThat(
          request &&
            request.deviceId === d.id &&
            alive(request) &&
            !terminal.includes(request.state),
          409,
          "request_inactive",
        );
      if (existing && dedup?.accepted && alive(existing))
        return { already: existing };
      if (existing && !dedup?.accepted && existing.state !== "abandoned") {
        requireThat(
          existing.rawBytes === b.rawBytes &&
            existing.gzipBytes === b.gzipBytes &&
            existing.gzipSha256 === b.gzipSha256,
          409,
          "reservation_conflict",
        );
        requireThat(
          !existing.retryAfter || existing.retryAfter <= now(),
          409,
          "policy_cooldown",
        );
        return { upload: existing };
      }
      const dp = `quotaWindows/device-${d.id}-${day}`,
        gp = `quotaWindows/global-${day}`,
        dq = await tx.get(dp),
        gq = await tx.get(gp),
        c = config();
      requireThat(
        (dq?.bytes ?? 0) + b.gzipBytes <= c.DEVICE_DAILY_BYTES &&
          (dq?.count ?? 0) < c.DEVICE_DAILY_OBJECTS &&
          (gq?.bytes ?? 0) + b.gzipBytes <= c.GLOBAL_DAILY_BYTES,
        429,
        "daily_quota",
      );
      const qexp = expiry(3);
      for (const [p, q] of [
        [dp, dq],
        [gp, gq],
      ] as const)
        tx.set(p, {
          id: p.split("/")[1],
          bytes: (q?.bytes ?? 0) + b.gzipBytes,
          count: (q?.count ?? 0) + 1,
          expiresAt: qexp,
          ttlAt: new Date(qexp),
        });
      const u: Doc = {
        ...b,
        id,
        deviceId: d.id,
        installationId: d.installationId,
        dedupId,
        objectKey: `logs/${d.id}/${day}/${id}.log.gz`,
        createdAt: now(),
        state: "reserved",
        policyExpiresAt: expiry(600 / 86400),
        cleanupAt: expiry(1),
        chargedDay: day,
        failures: 0,
      };
      tx.set(`uploads/${id}`, u);
      tx.set(`dedup/${dedupId}`, {
        id: dedupId,
        uploadId: id,
        deviceId: d.id,
        accepted: false,
      });
      return { upload: u };
    });
    if (result.already)
      return {
        state: "already_present",
        uploadId: result.already.id,
        acknowledgment: this.ack(result.already),
      };
    if (
      result.upload!.state === "verification_failed" &&
      result.upload!.failedGeneration &&
      result.upload!.policyExpiresAt < now()
    ) {
      await this.storage.removeObject(
        result.upload!.objectKey,
        result.upload!.failedGeneration,
      );
      await this.db.transaction(async (tx) => {
        await checkCurrent(tx, d);
        const u = await tx.get(`uploads/${result.upload!.id}`);
        if (u?.state === "verification_failed")
          tx.set(`uploads/${u.id}`, {
            ...u,
            state: "reserved",
            failedGeneration: null,
          });
      });
    }
    const policy = await this.storage.signedPost(result.upload!);
    await this.db.transaction(async (tx) => {
      const dev = await checkCurrent(tx, d);
      requireThat(dev.state !== "paused", 403, "device_paused");
      requireThat(!dev.verificationBlocked, 403, "verification_blocked");
      const u = await tx.get(`uploads/${result.upload!.id}`);
      requireThat(u, 404, "upload_not_found");
      tx.set(`uploads/${u.id}`, { ...u, policyExpiresAt: policy.expiresAt });
    });
    return { state: "reserved", ...policy };
  }
  ack(l: Doc) {
    return {
      logId: l.id,
      uploadId: l.id,
      generation: l.generation,
      rawSha256: l.rawSha256,
      uploadedAt: l.uploadedAt,
      acceptedAt: l.acceptedAt,
      expiresAt: l.expiresAt,
    };
  }
  async upload(d: Doc, id: string) {
    const u = await this.db.get(`uploads/${id}`);
    requireThat(u && u.deviceId === d.id, 404, "upload_not_found");
    return u;
  }
  async complete(d: Doc, id: string) {
    const u = await this.upload(d, id);
    if (u.state === "accepted") {
      const l = await this.db.get(`logs/${id}`);
      requireThat(alive(l), 410, "log_expired");
      return { state: "accepted", acknowledgment: this.ack(l!) };
    }
    requireThat(u.state !== "abandoned", 410, "upload_abandoned");
    let verified;
    try {
      verified = await this.storage.verifyObject(u);
    } catch (e) {
      if ((e as any).code === 404)
        throw new ApiError(409, "object_not_uploaded");
      if (e instanceof ApiError && e.status === 422) {
        await this.db.transaction(async (tx) => {
          const latest = await tx.get(`uploads/${id}`),
            dev = await tx.get(`devices/${d.id}`);
          if (latest?.state !== "accepted") {
            const failures = (latest?.failures ?? 0) + 1;
            tx.set(`uploads/${id}`, {
              ...latest,
              state: "verification_failed",
              failures,
              failedGeneration: (e.details as any)?.generation,
              retryAfter: latest?.policyExpiresAt,
              lastError: e.code,
            });
            if (failures >= 3 && dev)
              tx.set(`devices/${d.id}`, {
                ...dev,
                verificationBlocked: true,
                lastOutcome: "blocked",
              });
          }
        });
      }
      throw e;
    }
    const uploadedAt = verified.uploadedAt,
      expiresAt = expiry(
        config().RETENTION_DAYS,
        new Date(uploadedAt).getTime(),
      );
    requireThat(expiresAt > now(), 410, "log_expired");
    return this.db.transaction(async (tx) => {
      const dev = await checkCurrent(tx, d),
        latest = await tx.get(`uploads/${id}`),
        prior = await tx.get(`logs/${id}`);
      if (prior) return { state: "accepted", acknowledgment: this.ack(prior) };
      requireThat(latest?.state !== "abandoned", 410, "upload_abandoned");
      const l = {
        ...u,
        ...verified,
        state: "accepted",
        acceptedAt: now(),
        expiresAt,
        serial: dev.serial,
        assignedLabel: dev.assignedLabel,
        schoolEmail: dev.schoolEmail,
        sourceUser: u.source.username,
        searchTokens: searchTokens(
          dev.serial,
          dev.assignedLabel,
          dev.schoolEmail,
          u.source.username,
          u.metadata.hostName,
        ),
      };
      tx.set(`logs/${id}`, l);
      tx.set(`uploads/${id}`, {
        ...latest,
        state: "accepted",
        expiresAt,
        cleanupAt: expiresAt,
      });
      tx.set(`dedup/${u.dedupId}`, {
        id: u.dedupId,
        uploadId: id,
        deviceId: d.id,
        accepted: true,
      });
      tx.set(`devices/${d.id}`, { ...dev, lastUploadAt: now() });
      return { state: "accepted", acknowledgment: this.ack(l) };
    });
  }
  async ackRequest(d: Doc, id: string, input: unknown) {
    const b = z
      .object({
        state: z.enum([
          "received",
          "deferred",
          "running",
          "completed",
          "failed",
        ]),
        outcome: z.string().max(80).optional(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      await checkCurrent(tx, d);
      const r = await tx.get(`collectionRequests/${id}`);
      requireThat(r && r.deviceId === d.id, 404, "request_not_found");
      if (terminal.includes(r.state)) return { state: r.state };
      requireThat(alive(r), 410, "request_expired");
      requireThat(
        r.state !== "running" || b.state !== "received",
        409,
        "request_state_conflict",
      );
      tx.set(`collectionRequests/${id}`, { ...r, ...b, updatedAt: now() });
      return { state: b.state };
    });
  }
  async revoke(d: Doc, actor: string) {
    await this.db.transaction(async (tx) => {
      const dev = await tx.get(`devices/${d.id}`);
      requireThat(dev, 404, "device_not_found");
      const i = dev.activeInstallation
        ? await tx.get(`installations/${dev.activeInstallation}`)
        : undefined;
      tx.set(`devices/${d.id}`, {
        ...dev,
        state: "revoked",
        activeInstallation: null,
        retiredAt: now(),
        expiresAt: expiry(),
        ttlAt: new Date(expiry()),
      });
      if (i) tx.set(`installations/${i.id}`, { ...i, revokedAt: now() });
      audit(tx, actor, "revoke", d.id);
    });
    const rows = await this.db.query(
      "collectionRequests",
      [["deviceId", "==", d.id]],
      "id",
      undefined,
      500,
    );
    await this.db.transaction(async (tx) => {
      for (const r of rows)
        if (!terminal.includes(r.state))
          tx.set(`collectionRequests/${r.id}`, {
            ...r,
            state: "cancelled",
            updatedAt: now(),
          });
    });
    return { state: "revoked" };
  }
  async createBatch(a: Actor, input: unknown) {
    const b = schema.batch.parse(input),
      code = secret(),
      id = sha(code),
      expiresAt = expiry(b.days);
    await this.db.transaction(async (tx) => {
      tx.set(`enrollmentBatches/${id}`, {
        id,
        bootstrapHash: id,
        encryptedBootstrap: sealBootstrap(code),
        expiresAt,
        createdAt: now(),
        creator: a.email,
        mode: "automatic",
        label: b.label,
        ceiling: b.ceiling,
        count: 0,
        state: "open",
        ttlAt: new Date(expiry(90)),
      });
      audit(tx, a.email, "create_batch", id);
    });
    return {
      id,
      code,
      expiresAt,
      ceiling: b.ceiling,
      origin: config().PUBLIC_ORIGIN,
    };
  }
  async updateBatch(a: Actor, id: string, input: unknown) {
    const b = schema.batchUpdate.parse(input);
    return this.db.transaction(async (tx) => {
      const batch = await tx.get(`enrollmentBatches/${id}`);
      requireThat(batch, 404, "batch_not_found");
      requireThat(
        (b.ceiling ?? batch.ceiling) >= batch.count,
        400,
        "limit_below_enrolled_count",
      );
      const reopened = b.state === "open";
      tx.set(`enrollmentBatches/${id}`, {
        ...batch,
        ...(b.label !== undefined ? { label: b.label } : {}),
        ...(b.ceiling !== undefined ? { ceiling: b.ceiling } : {}),
        ...(b.state ? { state: b.state } : {}),
        mode: "automatic",
        ...(reopened || b.days
          ? { expiresAt: expiry(b.days ?? 7), ttlAt: new Date(expiry(90)) }
          : {}),
        updatedAt: now(),
      });
      if ((reopened || b.days) && batch.bootstrapHash !== id)
        tx.set(`enrollmentTokens/${batch.bootstrapHash}`, {
          id: batch.bootstrapHash,
          batchId: id,
          ttlAt: new Date(expiry(90)),
        });
      audit(
        tx,
        a.email,
        reopened
          ? "reopen_batch"
          : b.state === "closed"
            ? "close_batch"
            : "update_batch",
        id,
      );
      return { updated: true };
    });
  }
  async batchInstaller(a: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const batch = await tx.get(`enrollmentBatches/${id}`);
      requireThat(batch, 404, "batch_not_found");
      let code: string;
      if (batch.encryptedBootstrap)
        code = openBootstrap(batch.encryptedBootstrap);
      else {
        // Older releases stored only a hash. Rotate once, preserving the batch,
        // its enrolled devices and its ceiling; old copies then require a download.
        code = secret();
        const hash = sha(code);
        tx.set(`enrollmentTokens/${hash}`, {
          id: hash,
          batchId: id,
          ttlAt: new Date(expiry(90)),
        });
        tx.set(`enrollmentBatches/${id}`, {
          ...batch,
          bootstrapHash: hash,
          encryptedBootstrap: sealBootstrap(code),
          mode: "automatic",
          updatedAt: now(),
        });
        audit(tx, a.email, "refresh_enrollment_script", id);
      }
      audit(tx, a.email, "download_enrollment_script", id);
      return { code, origin: config().PUBLIC_ORIGIN };
    });
  }
  async list(kind: string, url: URL) {
    const f: [string, string, unknown][] = [],
      order =
        (
          {
            logs: "acceptedAt",
            devices: "lastSeenAt",
            collections: "receivedAt",
            collectionRequests: "createdAt",
            auditEvents: "createdAt",
            enrollmentBatches: "createdAt",
            admins: "createdAt",
          } as Record<string, string>
        )[kind] ?? "id";
    if (kind === "devices") {
      const range = url.searchParams.get("lastContact");
      if (range === "recent") f.push(["lastSeenAt", ">=", expiry(-1)]);
      else if (range === "stale") f.push(["lastSeenAt", "<=", expiry(-2)]);
    }
    if (kind === "logs" && url.searchParams.has("session")) {
      const session = z
          .string()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("session")),
        instance = z
          .string()
          .min(1)
          .max(80)
          .parse(url.searchParams.get("instance"));
      const links = await this.db.query(
          "sessionLinks",
          [
            ["instance", "==", instance],
            ["session", "==", session],
          ],
          "acceptedAt",
          url.searchParams.get("cursor") ?? undefined,
          50,
          "desc",
        ),
        items = [];
      for (const link of links) {
        const l = await this.db.get(`logs/${link.logId}`);
        if (alive(link) && l && alive(l)) items.push(l);
      }
      return {
        items,
        nextCursor:
          links.length === 50 ? pageCursor(links.at(-1), "acceptedAt") : null,
      };
    }
    const query = url.searchParams.get("q");
    if (query && ["logs", "devices"].includes(kind)) {
      requireThat(
        query.length >= 2 && query.length <= 80,
        400,
        "search_minimum_two_characters",
      );
      f.push(["searchTokens", "array-contains", query.toLowerCase()]);
    }
    for (const field of ["deviceId", "sourceUser", "state"]) {
      const v = url.searchParams.get(field);
      if (v) {
        requireThat(v.length <= 100, 400, "filter_too_long");
        f.push([field, "==", v]);
      }
    }
    for (const [param, field] of [
      ["macOS", "metadata.macOSVersion"],
      ["seb", "metadata.sebVersion"],
      ["collector", "metadata.collectorVersion"],
    ] as const) {
      const v = url.searchParams.get(param);
      if (v) f.push([field, "==", v]);
    }
    if (kind === "logs") {
      const from = url.searchParams.get("from") ?? expiry(-7),
        to = url.searchParams.get("to") ?? now();
      schema.when.parse(from);
      schema.when.parse(to);
      f.push(["acceptedAt", ">=", from], ["acceptedAt", "<=", to]);
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor) requireThat(cursor.length < 2048, 400, "invalid_cursor");
    const rows = await this.db.query(kind, f, order, cursor, 50, "desc");
    const items = rows
      .filter(
        (r) =>
          ["enrollmentBatches", "collectionRequests"].includes(kind) ||
          !r.expiresAt ||
          alive(r),
      )
      .map(({ credentialHash, bootstrapHash, encryptedBootstrap, ...r }) => r);
    // Resolve only the visible page; memoize shared targets and fetch in parallel.
    const labels = new Map<string, Promise<string | undefined>>();
    const label = (path: string) => {
      if (!labels.has(path))
        labels.set(
          path,
          this.db
            .get(path)
            .then(
              (d) =>
                d?.metadata?.computerName ||
                d?.metadata?.hostName ||
                d?.source?.basename ||
                d?.label ||
                d?.email ||
                d?.serial,
            ),
        );
      return labels.get(path)!;
    };
    if (kind === "collectionRequests")
      await Promise.all(
        items.map(async (r) => {
          r.deviceLabel = await label(`devices/${r.deviceId}`);
          if (
            ["pending", "delivered", "accepted"].includes(r.state) &&
            !alive(r)
          )
            r.state = "expired";
        }),
      );
    if (kind === "auditEvents")
      await Promise.all(
        items.map(async (r) => {
          const collection = /batch|enrollment_script/.test(r.action)
            ? "enrollmentBatches"
            : /log|session_link/.test(r.action) ||
                ["open", "download", "preview", "attach_session"].includes(
                  r.action,
                )
              ? "logs"
              : /admin/.test(r.action)
                ? "admins"
                : r.action === "cancel_request"
                  ? "collectionRequests"
                  : [
                        "enroll",
                        "revoke",
                        "active",
                        "paused",
                        "update_assignment",
                        "request_collection",
                      ].includes(r.action)
                    ? "devices"
                    : undefined;
          if (collection)
            r.targetLabel = await label(`${collection}/${r.target}`);
        }),
      );
    return {
      items,
      nextCursor: rows.length === 50 ? pageCursor(rows.at(-1), order) : null,
    };
  }

  async log(id: string) {
    const l = await this.db.get(`logs/${id}`);
    requireThat(l, 404, "log_not_found");
    requireThat(alive(l), 410, "log_expired");
    return l;
  }
  async maintenance() {
    let deleted = 0,
      errors = 0,
      overdue = 0;
    const logs = await this.db.query(
      "logs",
      [["expiresAt", "<=", now()]],
      "expiresAt",
      undefined,
      50,
    );
    for (const l of logs)
      try {
        await this.storage.removeObject(l.objectKey, l.generation);
        const links = await this.db.query(
          "sessionLinks",
          [["logId", "==", l.id]],
          "id",
          undefined,
          200,
        );
        await this.db.transaction(async (tx) => {
          tx.delete(`logs/${l.id}`);
          tx.delete(`uploads/${l.id}`);
          tx.delete(`dedup/${l.dedupId}`);
          links.forEach((v) => tx.delete(`sessionLinks/${v.id}`));
        });
        deleted++;
      } catch {
        errors++;
        if (l.expiresAt < expiry(-1)) overdue++;
      }
    const uploads = await this.db.query(
      "uploads",
      [["cleanupAt", "<=", now()]],
      "cleanupAt",
      undefined,
      50,
    );
    for (const u of uploads)
      if (u.state !== "accepted")
        try {
          requireThat(u.policyExpiresAt < now(), 409, "policy_active");
          await this.storage.removeObject(u.objectKey);
          await this.db.transaction(async (tx) => {
            const current = await tx.get(`uploads/${u.id}`);
            if (current?.state !== "accepted") {
              const d = await tx.get(`dedup/${u.dedupId}`);
              tx.delete(`uploads/${u.id}`);
              if (d?.uploadId === u.id) tx.delete(`dedup/${u.dedupId}`);
            }
          });
          deleted++;
        } catch {
          errors++;
          if (u.cleanupAt < expiry(-1)) overdue++;
        }
    const requests = await this.db.query(
      "collectionRequests",
      [["expiresAt", "<=", now()]],
      "expiresAt",
      undefined,
      100,
    );
    await this.db.transaction(async (tx) => {
      requests.forEach((r) => tx.delete(`collectionRequests/${r.id}`));
    });
    // Other catalog records expire via TTL; log references deliberately have no TTL.
    console.info(
      JSON.stringify({
        event: "maintenance",
        deleted,
        errors,
        overdue,
        expiredRequests: requests.length,
      }),
    );
    if (overdue)
      console.error(JSON.stringify({ event: "cleanup_overdue", overdue }));
    return { deleted, errors, overdue, expiredRequests: requests.length };
  }
}
