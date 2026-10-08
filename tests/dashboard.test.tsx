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
  const button = [...container.querySelectorAll("nav button")].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
  await click("synthetic.logfixture");
  await act(async () => {
    pending.get("logs/log-a")!.shift()!.resolve(reply(log));
    pending
      .get("session-links")!
      .shift()!
      .resolve(reply({ items: [] }));
  });
  expect(container.querySelector("h2")?.textContent).toBe("synthetic.log");
  await act(async () => {
    pending
      .get("devices/device-a")!
      .shift()!
      .resolve(reply({ device: fleetDevice, collections: [] }));
  });
  expect(container.querySelector("h2")?.textContent).toBe("synthetic.log");
});
