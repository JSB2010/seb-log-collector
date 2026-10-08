import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type Doc, type Store } from "./store";
import { Service, audit, now, expiry, alive, searchTokens } from "./service";
import { requireThat } from "./errors";
import { sha } from "./crypto";
const terminal = ["completed", "failed", "cancelled", "expired"];
const actions = z.enum([
  "pause",
  "resume",
  "revoke",
  "collect",
  "update",
  "uninstall",
]);
export class Management {
  constructor(
    readonly db: Store,
    readonly service: Service,
  ) {}
  async groups() {
    const items: Doc[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.db.query(
        "enrollmentBatches",
        [["state", "in", ["open", "closed"]]],
        "id",
        cursor,
        1000,
      );
      items.push(
        ...page.map(({ bootstrapHash, encryptedBootstrap, ...g }) => g),
      );
      if (page.length < 1000) break;
      const last = page.at(-1)!;
      cursor = Buffer.from(
        JSON.stringify({ id: last.id, value: last.id }),
      ).toString("base64url");
    } while (true);
    return { items: items.sort((a, b) => a.label.localeCompare(b.label)) };
  }
  async updateDevice(
    actor: string,
    id: string,
    input: unknown,
    expectedGroup?: string,
  ) {
    const b = z
      .object({
        state: z.enum(["active", "paused"]).optional(),
        enrollmentGroupId: z.string().min(1).max(140).optional(),
        schoolEmail: z.union([z.email(), z.literal("")]).optional(),
        jamfId: z.string().max(200).optional(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const d = await tx.get(`devices/${id}`);
      requireThat(d, 404, "device_not_found");
      const oldId = d.enrollmentGroupId ?? d.enrollmentBatchId;
      requireThat(
        !expectedGroup || oldId === expectedGroup,
        409,
        "group_changed",
      );
      requireThat(!b.state || d.activeInstallation, 409, "device_inactive");
      const targetId = b.enrollmentGroupId ?? oldId;
      const [oldGroup, target] = await Promise.all([
        oldId ? tx.get(`enrollmentBatches/${oldId}`) : undefined,
        targetId ? tx.get(`enrollmentBatches/${targetId}`) : undefined,
      ]);
      if (b.enrollmentGroupId)
        requireThat(
          target && target.state !== "deleted",
          400,
          "group_unavailable",
        );
      if (oldId !== targetId && d.activeInstallation) {
        requireThat(target && target.count < target.ceiling, 409, "group_full");
        if (oldGroup)
          tx.set(`enrollmentBatches/${oldId}`, {
            ...oldGroup,
            count: Math.max(0, oldGroup.count - 1),
          });
        tx.set(`enrollmentBatches/${targetId}`, {
          ...target,
          count: target.count + 1,
        });
      }
      tx.set(`devices/${id}`, {
        ...d,
        ...b,
        enrollmentGroupId: targetId,
        assignedLabel: target?.label ?? "",
        searchTokens: searchTokens(
          d.serial,
          target?.label,
          b.schoolEmail ?? d.schoolEmail,
          d.metadata?.hostName,
          d.metadata?.computerName,
        ),
      });
      audit(tx, actor, b.state ?? "update_assignment", id);
      return { updated: true };
    });
  }
  async queue(
    actor: string,
    id: string,
    input: unknown,
    commandId: string = randomUUID(),
    expectedGroup?: string,
  ) {
    const b = z
      .object({ action: z.enum(["update", "uninstall"]) })
      .strict()
      .parse(input);
    const manifest = JSON.parse(
      await readFile("public/collector/manifest.json", "utf8"),
    );
    return this.db.transaction(async (tx) => {
      const d = await tx.get(`devices/${id}`);
      const existing = await tx.get(`deviceCommands/${commandId}`);
      requireThat(d?.activeInstallation, 409, "device_inactive");
      requireThat(
        !expectedGroup ||
          (d.enrollmentGroupId ?? d.enrollmentBatchId) === expectedGroup,
        409,
        "group_changed",
      );
      if (existing) return existing;
      const pending = d.pendingCommand
        ? await tx.get(`deviceCommands/${d.pendingCommand}`)
        : undefined;
      requireThat(
        !pending || terminal.includes(pending.state) || !alive(pending),
        409,
        "command_already_pending",
      );
      requireThat(
        d.metadata?.managementProtocol === 1,
        409,
        "collector_upgrade_required",
      );
      const command: Doc = {
        id: commandId,
        deviceId: id,
        installationId: d.activeInstallation,
        action: b.action,
        state: "pending",
        creator: actor,
        createdAt: now(),
        updatedAt: now(),
        expiresAt: expiry(7),
        ttlAt: new Date(expiry()),
        ...(b.action === "update"
          ? {
              version: manifest.version,
              sha256: manifest.installer.sha256,
              path: `/collector/releases/${manifest.version}/install.zsh`,
            }
          : {}),
      };
      tx.set(`deviceCommands/${commandId}`, command);
      tx.set(`devices/${id}`, { ...d, pendingCommand: commandId });
      audit(tx, actor, `queue_${b.action}`, id);
      return command;
    });
  }
  async commands(d: Doc) {
    const cmd = d.pendingCommand
      ? await this.db.get(`deviceCommands/${d.pendingCommand}`)
      : undefined;
    if (
      !cmd ||
      cmd.installationId !== d.installationId ||
      terminal.includes(cmd.state) ||
      !alive(cmd)
    )
      return [];
    const { id, action, version, path, sha256, expiresAt, state } = cmd;
    return [{ id, action, version, path, sha256, expiresAt, state }];
  }
  async acknowledge(d: Doc, id: string, input: unknown) {
    const b = z
      .object({
        state: z.enum(["deferred", "running", "completed", "failed"]),
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
        result: z
          .enum([
            "busy",
            "installed",
            "removed",
            "download_failed",
            "checksum_mismatch",
            "install_failed",
            "uninstall_failed",
            "unsupported",
            "cancelled",
          ])
          .optional(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const c = await tx.get(`deviceCommands/${id}`),
        dev = await tx.get(`devices/${d.id}`),
        installation = await tx.get(`installations/${d.installationId}`);
      requireThat(
        c &&
          dev &&
          installation &&
          c.deviceId === d.id &&
          c.installationId === d.installationId,
        404,
        "command_not_found",
      );
      if (terminal.includes(c.state)) {
        requireThat(c.state === b.state, 409, "command_terminal");
        return { state: c.state };
      }
      requireThat(alive(c), 410, "command_expired");
      requireThat(
        c.action === "uninstall" ||
          (!installation.revokedAt &&
            dev.activeInstallation === d.installationId),
        403,
        "credential_revoked",
      );
      requireThat(dev.pendingCommand === id, 409, "command_superseded");
      requireThat(
        c.state === "running" ||
          (!installation.revokedAt &&
            dev.activeInstallation === d.installationId),
        403,
        "credential_revoked",
      );
      requireThat(
        b.state !== "completed" || c.state === "running",
        409,
        "command_not_running",
      );
      requireThat(
        b.state !== "completed" ||
          (c.action === "update"
            ? b.result === "installed" && b.version === c.version
            : b.result === "removed"),
        400,
        "invalid_result",
      );
      requireThat(
        c.state !== "running" ||
          ["running", "completed", "failed"].includes(b.state),
        409,
        "command_running",
      );
      const groupId = dev.enrollmentGroupId ?? dev.enrollmentBatchId;
      const group =
        c.action === "uninstall" &&
        b.state === "running" &&
        !installation.revokedAt &&
        groupId
          ? await tx.get(`enrollmentBatches/${groupId}`)
          : undefined;
      // Teardown grants only a result acknowledgment; data APIs stop at claim time.
      if (
        c.action === "uninstall" &&
        b.state === "running" &&
        !installation.revokedAt
      ) {
        tx.set(`installations/${installation.id}`, {
          ...installation,
          revokedAt: now(),
        });
        if (group)
          tx.set(`enrollmentBatches/${groupId}`, {
            ...group,
            count: Math.max(0, group.count - 1),
          });
        tx.set(`devices/${d.id}`, {
          ...dev,
          state: "revoked",
          activeInstallation: null,
          retiredAt: now(),
          expiresAt: expiry(),
          ttlAt: new Date(expiry()),
        });
      } else if (terminal.includes(b.state))
        tx.set(`devices/${d.id}`, {
          ...dev,
          pendingCommand: null,
          ...(b.state === "completed" && b.version
            ? { metadata: { ...dev.metadata, collectorVersion: b.version } }
            : {}),
        });
      tx.set(`deviceCommands/${id}`, {
        ...c,
        ...b,
        result: b.result ?? null,
        updatedAt: now(),
      });
      audit(tx, "device", `command_${b.state}`, d.id, b.result ?? "success");
      return { state: b.state };
    });
  }
  async cancel(actor: string, id: string) {
    return this.db.transaction(async (tx) => {
      const c = await tx.get(`deviceCommands/${id}`);
      requireThat(c, 404, "command_not_found");
      const d = await tx.get(`devices/${c.deviceId}`);
      requireThat(c.state !== "running", 409, "command_running");
      if (!terminal.includes(c.state))
        tx.set(`deviceCommands/${id}`, {
          ...c,
          state: "cancelled",
          updatedAt: now(),
        });
      if (d?.pendingCommand === id)
        tx.set(`devices/${d.id}`, { ...d, pendingCommand: null });
      audit(tx, actor, "cancel_command", c.deviceId);
      return { cancelled: true };
    });
  }
  async bulk(actor: string, groupId: string, input: unknown): Promise<Doc> {
    const b = z
      .object({ action: actions, operationId: z.string().uuid() })
      .strict()
      .parse(input);
    let op = await this.db.get(`groupOperations/${b.operationId}`);
    if (!op) {
      const group = await this.db.get(`enrollmentBatches/${groupId}`);
      requireThat(group && group.state !== "deleted", 404, "group_not_found");
      const memberRows = (
        await this.db.query(
          "devices",
          [
            ["enrollmentGroupId", "==", groupId],
            ["state", "in", ["active", "paused"]],
          ],
          "id",
          undefined,
          1000,
        )
      ).filter((d) => d.activeInstallation);
      const members = memberRows.map((d) => d.id);
      op = await this.db.transaction(async (tx) => {
        const old = await tx.get(`groupOperations/${b.operationId}`);
        if (old) return old;
        const row = {
          id: b.operationId,
          groupId,
          groupLabel: group.label,
          action: b.action,
          creator: actor,
          members,
          deviceNames: Object.fromEntries(
            memberRows.map((d) => [
              d.id,
              d.metadata?.computerName || d.metadata?.hostName || d.serial,
            ]),
          ),
          results: {},
          state: "running",
          createdAt: now(),
          expiresAt: expiry(),
          ttlAt: new Date(expiry()),
        };
        tx.set(`groupOperations/${b.operationId}`, row);
        audit(tx, actor, "group_operation", groupId);
        return row;
      });
    }
    requireThat(
      op.groupId === groupId && op.action === b.action && op.creator === actor,
      409,
      "operation_conflict",
    );
    // Stable child IDs make browser retries safe after a lost response.
    requireThat(op, 404, "operation_not_found");
    for (let offset = 0; offset < op!.members.length; offset += 8) {
      const results: [string, string][] = await Promise.all(
        op!.members.slice(offset, offset + 8).map(async (id: string) => {
          if (op!.results[id]) return [id, op!.results[id]] as [string, string];
          try {
            const dev = await this.db.get(`devices/${id}`);
            requireThat(
              dev?.activeInstallation && dev.enrollmentGroupId === groupId,
              409,
              "group_changed",
            );
            const h = sha(`${b.operationId}:${id}`),
              child = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
            if (b.action === "update" || b.action === "uninstall")
              await this.queue(actor, id, { action: b.action }, child, groupId);
            else if (b.action === "revoke")
              await this.service.revoke(dev, actor, groupId);
            else if (b.action === "collect")
              await this.db.transaction(async (tx) => {
                const d = await tx.get(`devices/${id}`),
                  r = await tx.get(`collectionRequests/${child}`);
                requireThat(
                  d?.activeInstallation && d.enrollmentGroupId === groupId,
                  409,
                  "group_changed",
                );
                if (!r)
                  tx.set(`collectionRequests/${child}`, {
                    id: child,
                    deviceId: id,
                    from: expiry(-7),
                    to: now(),
                    state: "pending",
                    creator: actor,
                    createdAt: now(),
                    expiresAt: expiry(1),
                    ttlAt: new Date(expiry()),
                  });
              });
            else
              await this.updateDevice(
                actor,
                id,
                { state: b.action === "pause" ? "paused" : "active" },
                groupId,
              );
            return [
              id,
              ["update", "uninstall", "collect"].includes(b.action)
                ? "queued"
                : "completed",
            ] as [string, string];
          } catch (e) {
            return [id, (e as any).code ?? "failed"] as [string, string];
          }
        }),
      );
      op = await this.db.transaction(async (tx) => {
        const latest = await tx.get(`groupOperations/${b.operationId}`);
        const next: Doc = {
          ...latest,
          results: { ...latest!.results, ...Object.fromEntries(results) },
          updatedAt: now(),
        };
        tx.set(`groupOperations/${b.operationId}`, next);
        return next;
      });
    }
    return this.db.transaction(async (tx) => {
      const latest = await tx.get(`groupOperations/${b.operationId}`);
      const next = { ...latest, state: "completed", updatedAt: now() };
      tx.set(`groupOperations/${b.operationId}`, next);
      return next;
    });
  }
}
