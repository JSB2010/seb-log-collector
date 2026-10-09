// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dashboard } from "../src/components/dashboard";

type Pending = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};
let container: HTMLDivElement, root: Root;
let pending: Map<string, Pending[]>;
const enrollment = {
  id: "batch-123456789",
  label: "Pilot batch",
  count: 0,
  ceiling: 10,
  state: "open",
};
const audit = {
  id: "audit-123",
  actor: "it@example.org",
  action: "batch_created",
  target: "batch-123456789",
  result: "allowed",
};
const reply = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const fleetDevice = { id: "device-a", serial: "SYNTHETIC-A", state: "active" };

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/fleet");
  pending = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = url.replace("/api/admin/v1/", "").split("?")[0];
      if (path === "me")
        return Promise.resolve(
          reply({ email: "it@example.org", csrf: "test" }),
        );
      if (path === "devices")
        return Promise.resolve(reply({ items: [fleetDevice] }));
      return new Promise<Response>((resolve, reject) => {
        pending.set(path, [...(pending.get(path) ?? []), { resolve, reject }]);
      });
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Dashboard));
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});
async function navigate(label: string) {
  const button = [...container.querySelectorAll("nav a")].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  expect(container.querySelector("h1")?.textContent).toBe(label);
}
async function finish(path: string, items: unknown[], nextCursor?: string) {
  const request = pending.get(path)?.shift();
  expect(request).toBeDefined();
  await act(async () => {
    request!.resolve(reply({ items, nextCursor }));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

it("switches populated Enrollment to Requests and Audit without rendering the previous record shape", async () => {
  await navigate("Enrollment");
  await finish("enrollmentBatches", [enrollment], "old-page");
  expect(container.textContent).toContain("Pilot batch");
  await navigate("Requests");
  expect(container.textContent).not.toContain("Pilot batch");
  expect(container.textContent).not.toContain("Load more");
  await finish("collectionRequests", [
    { id: "request-1", deviceId: "device-123456789", state: "pending" },
  ]);
  expect(container.textContent).toContain("device-12345");
  await navigate("Audit");
  await finish("auditEvents", [audit]);
  expect(container.textContent).toContain("batch created");
});

it("ignores an earlier tab response even when it finishes after the active tab", async () => {
  await navigate("Enrollment");
  await navigate("Audit");
  await finish("auditEvents", [audit]);
  await finish("enrollmentBatches", [enrollment], "stale-cursor");
  expect(container.querySelector("h1")?.textContent).toBe("Audit");
  expect(container.textContent).toContain("batch created");
  expect(container.textContent).not.toContain("Load more");
});

it("ignores a superseded error and loading state while the active tab is still pending", async () => {
  await navigate("Enrollment");
  await navigate("Requests");
  await act(async () => {
    pending
      .get("enrollmentBatches")!
      .shift()!
      .reject(new Error("old-tab-failed"));
  });
  expect(container.textContent).toContain("Loading…");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await finish("collectionRequests", []);
  expect(container.textContent).toContain("No results");
});

it("keeps the newest response when navigating away and back to the same tab", async () => {
  await navigate("Enrollment");
  await navigate("Requests");
  await navigate("Enrollment");
  await act(async () => {
    pending
      .get("enrollmentBatches")!
      .pop()!
      .resolve(reply({ items: [{ ...enrollment, label: "Newest batch" }] }));
  });
  await finish("enrollmentBatches", [enrollment]);
  expect(container.textContent).toContain("Newest batch");
  expect(container.textContent).not.toContain("Pilot batch");
});

it("discards a pending pagination response after changing tabs", async () => {
  await navigate("Enrollment");
  await finish("enrollmentBatches", [enrollment], "page-2");
  await click("Load more");
  await navigate("Requests");
  await finish("collectionRequests", []);
  await finish(
    "enrollmentBatches",
    [{ ...enrollment, id: "batch-2" }],
    "page-3",
  );
  expect(container.querySelector("h1")?.textContent).toBe("Requests");
  expect(container.textContent).not.toContain("Load more");
  expect(container.textContent).toContain("No results");
});

it("discards a late device detail response after selecting a log", async () => {
  await click("SYNTHETIC-ASYNTHETIC-A");
  await navigate("Log catalog");
  const log = {
    id: "log-a",
    source: { basename: "synthetic.log", username: "fixture" },
    serial: "SYNTHETIC-A",
    gzipBytes: 100,
  };
  await finish("logs", [log]);
  await click("—");
  await act(async () => {
    pending.get("logs/log-a")!.shift()!.resolve(reply(log));
    pending
      .get("session-links")!
      .shift()!
      .resolve(reply({ items: [] }));
  });
  expect(container.querySelector(".log-filename")?.textContent).toBe(
    "synthetic.log",
  );
  await act(async () => {
    pending
      .get("devices/device-a")!
      .shift()!
      .resolve(reply({ device: fleetDevice, collections: [] }));
  });
  expect(container.querySelector(".log-filename")?.textContent).toBe(
    "synthetic.log",
  );
});

it("persists real tab URLs and restores filters and selection after remount", async () => {
  await navigate("Requests");
  expect(location.pathname).toBe("/requests");
  await navigate("Audit");
  expect(location.pathname).toBe("/audit");
  await act(async () => root.unmount());
  window.history.replaceState(
    null,
    "",
    "/logs?deviceId=device-a&device=Example+Mac&from=2026-01-01&to=2026-01-07&selected=log-a",
  );
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(Dashboard, { initialView: "logs" })),
  );
  expect(container.querySelector("h1")?.textContent).toBe("Log catalog");
  expect(container.textContent).toContain("Example Mac");
  expect(location.search).toContain("deviceId=device-a");
  expect(location.search).toContain("selected=log-a");
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) =>
        String(url).includes("logs?deviceId=device-a"),
      ),
  ).toBe(true);
  await act(async () => {
    window.history.replaceState(null, "", "/requests");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(container.querySelector("h1")?.textContent).toBe("Requests");
});
it("renders readable device activity and provides an exact device log link", async () => {
  await click("SYNTHETIC-ASYNTHETIC-A");
  await act(async () =>
    pending
      .get("devices/device-a")!
      .shift()!
      .resolve(
        reply({
          device: fleetDevice,
          collections: [
            {
              id: "activity-a",
              reason: "on_demand",
              outcome: "completed",
              counts: { found: 3, confirmed: 2, skipped: 1 },
              errors: ["transport"],
            },
          ],
        }),
      ),
  );
  expect(container.textContent).toContain("Requested collection");
  expect(container.textContent).toContain(
    "3 found · 2 uploaded · 1 already uploaded",
  );
  expect(container.textContent).not.toContain('"found":');
  const link = [...container.querySelectorAll("a")].find(
    (a) => a.textContent === "View device logs",
  )!;
  expect(link.href).toContain("/logs?deviceId=device-a");
  await act(async () =>
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
  expect(location.pathname).toBe("/logs");
  expect(location.search).toContain("deviceId=device-a");
});

it("opens scoped group actions, restores focus on Escape, and requires confirmation before submitting", async () => {
  await navigate("Enrollment");
  await finish("enrollmentBatches", [{ ...enrollment, count: 2 }]);
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Manage Macs in Pilot batch"]',
  )!;
  trigger.focus();
  await act(async () => {
    trigger.click();
  });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    "2 enrolled Macs",
  );
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(pending.has(`enrollment-batches/${enrollment.id}/actions`)).toBe(
    false,
  );
  await click("Manage Macs…");
  const remove = [...container.querySelectorAll(".group-action")].find((b) =>
    b.textContent?.startsWith("Queue uninstall"),
  )!;
  await act(async () =>
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    "need enrollment again",
  );
  expect(pending.has(`enrollment-batches/${enrollment.id}/actions`)).toBe(
    false,
  );
  await click("Confirm action");
  const request = vi
    .mocked(fetch)
    .mock.calls.find(([url]) =>
      String(url).includes(`enrollment-batches/${enrollment.id}/actions`),
    );
  expect(JSON.parse((request?.[1] as RequestInit).body as string).action).toBe(
    "uninstall",
  );
});

it("clears collection rows immediately when switching to lifecycle requests", async () => {
  await navigate("Requests");
  await finish(
    "collectionRequests",
    [{ id: "request-old", deviceId: "device-old", state: "completed" }],
    "collection-page-2",
  );
  expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  const selector = container.querySelector(
    ".filters select",
  ) as HTMLSelectElement;
  await act(async () => {
    selector.value = "management";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(container.textContent).not.toContain("Uninstall");
  expect(container.textContent).not.toContain("Load more");
  expect(container.textContent).toContain("Loading…");
  await finish("deviceCommands", [
    {
      id: "command-new",
      deviceId: "device-new",
      action: "update",
      version: "0.3.1",
      state: "completed",
      result: "installed",
    },
  ]);
  expect(container.textContent).toContain("Update to 0.3.1");
  expect(container.textContent).not.toContain("device-old");
});
