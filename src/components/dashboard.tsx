"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { BrandMark } from "./brand";
import { csvCell, parseRoster } from "./csv";
import { enrollmentInstaller } from "./enrollment";
type Row = Record<string, any>;
const views = [
  ["fleet", "Fleet"],
  ["logs", "Log catalog"],
  ["enrollment", "Enrollment"],
  ["requests", "Requests"],
  ["audit", "Audit"],
  ["admins", "Admins"],
] as const;
const resource: Record<string, string> = {
  fleet: "devices",
  logs: "logs",
  enrollment: "enrollmentBatches",
  requests: "collectionRequests",
  audit: "auditEvents",
  admins: "admins",
};
const date = (d?: string) => (d ? new Date(d).toLocaleString() : "—");
const day = (n: number) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
function health(d: Row) {
  if (d.state === "revoked") return "Revoked";
  if (d.state === "paused") return "Paused";
  if (d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) > 48 * 3600000)
    return "Offline";
  return (
    (
      {
        failed: "Collection failed",
        blocked: "Blocked",
        deferred: "Deferred",
        no_logs: "Idle",
        directory_missing: "No log directory",
        unreadable: "Read blocked",
        seb_absent: "SEB absent",
      } as Row
    )[d.lastOutcome] ?? "Idle"
  );
}
function save(name: string, data: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
export function Dashboard() {
  const currentView = useRef("fleet"),
    navigation = useRef(0),
    listRequest = useRef(0),
    detailRequest = useRef(0);
  const [me, setMe] = useState<Row | null | undefined>(undefined),
    [view, setView] = useState("fleet"),
    [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [state, setState] = useState(""),
    [lastContact, setLastContact] = useState(""),
    [session, setSession] = useState(""),
    [instance, setInstance] = useState(""),
    [mac, setMac] = useState(""),
    [seb, setSeb] = useState(""),
    [from, setFrom] = useState(day(-7)),
    [to, setTo] = useState(day(0)),
    [selected, setSelected] = useState<Row | null>(null),
    [detail, setDetail] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [batch, setBatch] = useState(false),
    [code, setCode] = useState<Row | null>(null),
    [enrollmentMode, setEnrollmentMode] = useState("jamf"),
    [enrollmentLabel, setEnrollmentLabel] = useState(""),
    [enrollmentCeiling, setEnrollmentCeiling] = useState(1000),
    [adminEmail, setAdminEmail] = useState("");
  const api = useCallback(
    async (path: string, method = "GET", data?: unknown) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (me?.csrf) headers["x-csrf-token"] = me.csrf;
      if (
        process.env.NODE_ENV === "development" &&
        location.hostname === "127.0.0.1"
      )
        headers["x-dev-admin"] = "true";
      const r = await fetch("/api/admin/v1/" + path, {
        method,
        headers,
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      });
      if (!r.ok) {
        const b = await r.json();
        throw new Error(b.error?.code ?? "request_failed");
      }
      return r.status === 204 ? {} : r.json();
    },
    [me?.csrf],
  );
  useEffect(() => {
    api("me")
      .then(setMe)
      .catch(() => setMe(null));
  }, [api]);
  const load = useCallback(
    async (append = false, next?: string) => {
      if (!me || currentView.current !== view) return;
      const request = ++listRequest.current;
      setBusy(true);
      setError("");
      try {
        const p = new URLSearchParams();
        if (search) p.set("q", search);
        if (lastContact) p.set("lastContact", lastContact);
        if (session && instance) {
          p.set("session", session);
          p.set("instance", instance);
        }
        if (state) p.set("state", state);
        if (mac) p.set("macOS", mac);
        if (seb) p.set("seb", seb);
        if (view === "logs") {
          p.set("from", new Date(from + "T00:00:00Z").toISOString());
          p.set("to", new Date(to + "T23:59:59Z").toISOString());
        }
        if (next) p.set("cursor", next);
        const r = await api(`${resource[view]}?${p}`);
        if (request !== listRequest.current) return;
        setRows((old) => (append ? [...old, ...r.items] : r.items));
        setCursor(r.nextCursor);
      } catch (e) {
        if (request === listRequest.current) setError((e as Error).message);
      } finally {
        if (request === listRequest.current) setBusy(false);
      }
    },
    [
      api,
      me,
      search,
      state,
      mac,
      seb,
      view,
      from,
      to,
      lastContact,
      session,
      instance,
    ],
  );
  useEffect(() => {
    void load();
    return () => {
      listRequest.current++;
    };
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  async function open(r: Row) {
    if (currentView.current !== view) return;
    const request = ++detailRequest.current;
    setSelected(r);
    setPreview(null);
    setDetail(null);
    try {
      let result: Row | null = null;
      if (view === "fleet") result = await api(`devices/${r.id}`);
      else if (view === "logs") {
        const [log, links] = await Promise.all([
          api(`logs/${r.id}`),
          api(`session-links?logId=${r.id}`),
        ]);
        result = { log, links: links.items };
      }
      if (request === detailRequest.current) setDetail(result);
    } catch (e) {
      if (request === detailRequest.current) setError((e as Error).message);
    }
  }
  async function act(
    path: string,
    method: string,
    data?: unknown,
    message = "Saved",
  ) {
    const page = navigation.current,
      selection = detailRequest.current;
    setBusy(true);
    setError("");
    try {
      await api(path, method, data);
      if (page !== navigation.current) return;
      setNotice(message);
      await load();
      if (selected && selection === detailRequest.current) await open(selected);
    } catch (e) {
      if (page === navigation.current) setError((e as Error).message);
    } finally {
      if (page === navigation.current) setBusy(false);
    }
  }
  function changeView(v: string) {
    if (v === currentView.current) return;
    currentView.current = v;
    navigation.current++;
    listRequest.current++;
    detailRequest.current++;
    // Clear records in the same update as the view; each table has a distinct shape.
    setRows([]);
    setCursor(null);
    setBusy(true);
    setError("");
    setView(v);
    setQuery("");
    setSearch("");
    setState("");
    setLastContact("");
    setSession("");
    setInstance("");
    setMac("");
    setSeb("");
    setSelected(null);
    setDetail(null);
    setPreview(null);
    setNotice("");
  }
  if (me === undefined)
    return (
      <main className="signin" id="main-content" tabIndex={-1}>
        <BrandMark className="signin-logo" />
        <h1>Safe Online Exam Logs</h1>
        <p role="status">Checking your session…</p>
      </main>
    );
  if (!me)
    return (
      <main className="signin" id="main-content" tabIndex={-1}>
        <BrandMark className="signin-logo" />
        <h1>Safe Online Exam Logs</h1>
        <p>Safe Exam Browser logs for school IT.</p>
        <a className="button primary" href="/api/auth/login">
          Sign in with Google
        </a>
        <p className="muted">Access is limited to approved administrators.</p>
      </main>
    );
  return (
    <div className={`shell ${selected ? "has-detail" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Safe Online Exam Logs">
          <BrandMark />
          <span className="brand-name">
            <span>Safe Online Exam</span>
            <span className="brand-product">Logs</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {views.map(([v, label]) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              aria-current={view === v ? "page" : undefined}
              onClick={() => changeView(v)}
            >
              <Icon name={v} />
              {label}
            </button>
          ))}
        </nav>
        <footer>
          <span>{me.email}</span>
          <button
            onClick={() =>
              act("logout", "POST", {}, "Signed out").then(() =>
                location.reload(),
              )
            }
          >
            Sign out
          </button>
        </footer>
      </aside>
      <main className="workspace" id="main-content" tabIndex={-1}>
        <header>
          <div>
            <h1>{views.find(([v]) => v === view)?.[1]}</h1>
            <p>
              {
                (
                  {
                    fleet: "Device health and collection activity",
                    logs: "Verified logs available for 90 days",
                    enrollment:
                      "Enroll devices through a scoped Jamf installer",
                    requests: "Pending delivery and collection results",
                    audit: "Administrator and service activity",
                    admins: "Manage dashboard access live",
                  } as Row
                )[view]
              }
            </p>
          </div>
          {view === "fleet" || view === "enrollment" ? (
            <button
              className="primary"
              onClick={() => {
                setBatch(true);
                setCode(null);
              }}
            >
              Create enrollment batch
            </button>
          ) : view === "logs" ? (
            <button
              onClick={() =>
                save(
                  "safe-online-exam-logs-metadata.json",
                  JSON.stringify(rows, null, 2),
                )
              }
            >
              Export JSON
            </button>
          ) : null}
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error.replaceAll("_", " ")}
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
          </div>
        )}
        {["fleet", "logs"].includes(view) && (
          <>
            <div className="search">
              <Icon name="search" />
              <input
                aria-label="Search serial, hostname, or assignment"
                placeholder="Search serial, hostname, or assignment"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="filters">
              <label>
                Status
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">All states</option>
                  {(view === "fleet"
                    ? ["active", "paused", "revoked"]
                    : ["accepted"]
                  ).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                macOS
                <input
                  placeholder="All versions"
                  value={mac}
                  onChange={(e) => setMac(e.target.value)}
                />
              </label>
              <label>
                SEB version
                <input
                  placeholder="All versions"
                  value={seb}
                  onChange={(e) => setSeb(e.target.value)}
                />
              </label>
              {view === "logs" ? (
                <>
                  <label>
                    From
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label>
                  Last contact
                  <select
                    value={lastContact}
                    onChange={(e) => setLastContact(e.target.value)}
                  >
                    <option value="">Any time</option>
                    <option value="recent">Past 24 hours</option>
                    <option value="stale">No contact for 48 hours</option>
                  </select>
                </label>
              )}
            </div>
          </>
        )}
        {view === "logs" && (
          <div className="session-filters">
            <label>
              Safe Online Exam instance
              <input
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
                placeholder="Optional instance"
              />
            </label>
            <label>
              Safe Online Exam session
              <input
                value={session}
                onChange={(e) => setSession(e.target.value)}
                placeholder="Optional session ID"
              />
            </label>
          </div>
        )}
        {view === "admins" && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                "admins",
                "POST",
                { email: adminEmail, active: true },
                "Administrator added",
              );
              setAdminEmail("");
            }}
          >
            <label>
              Administrator email
              <input
                type="email"
                required
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="it-admin@example.org"
              />
            </label>
            <button className="primary" disabled={busy}>
              Add administrator
            </button>
          </form>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {(view === "fleet"
                  ? [
                      "Device",
                      "Assignment",
                      "Versions",
                      "Last contact",
                      "Collection",
                      "State",
                    ]
                  : view === "logs"
                    ? ["Source", "Device", "Uploaded", "Size", "Expires", ""]
                    : view === "enrollment"
                      ? ["Batch", "Created", "Enrolled", "Expires", "State", ""]
                      : view === "requests"
                        ? [
                            "Device",
                            "Requested range",
                            "Created",
                            "State",
                            "Expires",
                            "",
                          ]
                        : view === "audit"
                          ? ["Time", "Actor", "Action", "Target", "Result"]
                          : ["Email", "Access", "Last sign-in", ""]
                ).map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={selected?.id === r.id ? "selected" : ""}
                >
                  {view === "fleet" ? (
                    <>
                      <td>
                        <button
                          className="row-link"
                          onClick={() => void open(r)}
                        >
                          {r.metadata?.computerName ??
                            r.metadata?.hostName ??
                            r.serial}
                          <small>{r.serial}</small>
                        </button>
                      </td>
                      <td>
                        {r.assignedLabel || "Unassigned"}
                        <small>{r.schoolEmail}</small>
                      </td>
                      <td>
                        macOS {r.metadata?.macOSVersion ?? "—"} · SEB{" "}
                        {r.metadata?.sebVersion ?? "—"}
                      </td>
                      <td>{date(r.lastSeenAt)}</td>
                      <td>
                        {r.lastOutcome?.replaceAll("_", " ") ?? "No logs"}
                      </td>
                      <td>
                        <span
                          className={`state ${health(r).toLowerCase().replaceAll(" ", "-")}`}
                        >
                          {health(r)}
                        </span>
                      </td>
                    </>
                  ) : view === "logs" ? (
                    <>
                      <td>
                        <button
                          className="row-link"
                          onClick={() => void open(r)}
                        >
                          {r.source.basename}
                          <small>{r.source.username}</small>
                        </button>
                      </td>
                      <td>{r.assignedLabel || r.serial}</td>
                      <td>{date(r.uploadedAt)}</td>
                      <td>{(r.gzipBytes / 1024).toFixed(1)} KiB</td>
                      <td>{date(r.expiresAt)}</td>
                      <td>
                        <a href={`/api/admin/v1/logs/${r.id}/download`}>
                          Download
                        </a>
                      </td>
                    </>
                  ) : view === "enrollment" ? (
                    <>
                      <td>
                        <strong>{r.label || "Serial roster"}</strong>
                        <br />
                        <code>{r.id.slice(0, 12)}</code>
                      </td>
                      <td>{date(r.createdAt)}</td>
                      <td>
                        {r.count} / {r.ceiling}
                      </td>
                      <td>{date(r.expiresAt)}</td>
                      <td>{r.state}</td>
                      <td>
                        {r.state === "open" && (
                          <button
                            onClick={() =>
                              void act(
                                `enrollment-batches/${r.id}`,
                                "PATCH",
                                { state: "closed" },
                                "Enrollment closed",
                              )
                            }
                          >
                            Close
                          </button>
                        )}
                      </td>
                    </>
                  ) : view === "requests" ? (
                    <>
                      <td>
                        <code>{r.deviceId.slice(0, 12)}</code>
                      </td>
                      <td>
                        {date(r.from)}
                        <small>to {date(r.to)}</small>
                      </td>
                      <td>{date(r.createdAt)}</td>
                      <td>{r.state}</td>
                      <td>{date(r.expiresAt)}</td>
                      <td>
                        {![
                          "completed",
                          "cancelled",
                          "expired",
                          "failed",
                        ].includes(r.state) && (
                          <button
                            onClick={() =>
                              void act(
                                `collectionRequests/${r.id}`,
                                "DELETE",
                                undefined,
                                "Request cancelled",
                              )
                            }
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </>
                  ) : view === "audit" ? (
                    <>
                      <td>{date(r.createdAt)}</td>
                      <td>{r.actor}</td>
                      <td>{r.action.replaceAll("_", " ")}</td>
                      <td>
                        <code>{r.target.slice(0, 16)}</code>
                      </td>
                      <td>{r.result}</td>
                    </>
                  ) : (
                    <>
                      <td>{r.email}</td>
                      <td>{r.active ? "Allowed" : "Removed"}</td>
                      <td>{date(r.lastLoginAt)}</td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act("admins", "POST", {
                              email: r.email,
                              active: !r.active,
                            })
                          }
                        >
                          {r.active ? "Remove access" : "Restore access"}
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">
              <Icon name={view} />
              <strong>{busy ? "Loading…" : "No results"}</strong>
              <p>
                {view === "fleet"
                  ? "Create an enrollment batch to add your first managed Mac."
                  : "Try another filter or check back after devices report."}
              </p>
            </div>
          )}
        </div>
        {cursor && (
          <button
            className="load-more"
            disabled={busy}
            onClick={() => void load(true, cursor)}
          >
            Load more
          </button>
        )}
        {view === "fleet" && (
          <p className="footnote">
            Collection requests run at the next successful device check-in.
          </p>
        )}
        {view === "logs" && (
          <div className="exports">
            <button
              onClick={() => {
                const cols = [
                  "id",
                  "serial",
                  "assignedLabel",
                  "sourceUser",
                  "uploadedAt",
                  "expiresAt",
                  "rawBytes",
                  "gzipBytes",
                ];
                save(
                  "safe-online-exam-logs-metadata.csv",
                  [
                    cols.join(","),
                    ...rows.map((r) =>
                      cols.map((k) => csvCell(r[k])).join(","),
                    ),
                  ].join("\n"),
                  "text/csv",
                );
              }}
            >
              Export CSV
            </button>
            <span className="muted">
              Exports include this loaded page. Downloads are separately held
              copies.
            </span>
          </div>
        )}
      </main>
      {selected && (
        <aside className="detail">
          <button
            className="close"
            aria-label="Close details"
            onClick={() => {
              detailRequest.current++;
              setSelected(null);
              setDetail(null);
              setPreview(null);
            }}
          >
            <Icon name="close" />
          </button>
          {view === "fleet" && detail ? (
            <>
              <h2>
                {detail.device.metadata?.computerName ?? detail.device.serial}
              </h2>
              <p>{detail.device.serial}</p>
              <span
                className={`state ${health(detail.device).toLowerCase().replaceAll(" ", "-")}`}
              >
                {health(detail.device)}
              </span>
              <dl>
                {[
                  ["Serial", detail.device.serial],
                  ["Assignment", detail.device.assignedLabel],
                  ["macOS version", detail.device.metadata?.macOSVersion],
                  ["SEB version", detail.device.metadata?.sebVersion],
                  ["Last contact", date(detail.device.lastSeenAt)],
                  ["Last scan", date(detail.device.lastScanAt)],
                  ["Last accepted upload", date(detail.device.lastUploadAt)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v || "—"}</dd>
                  </div>
                ))}
              </dl>
              <div className="detail-actions">
                <button
                  className="primary"
                  disabled={busy || !detail.device.activeInstallation}
                  onClick={() =>
                    void act(
                      `devices/${selected.id}/requests`,
                      "POST",
                      {
                        from: new Date(Date.now() - 7 * 86400000).toISOString(),
                        to: new Date().toISOString(),
                      },
                      "Collection pending delivery",
                    )
                  }
                >
                  Request collection
                </button>
                <button
                  disabled={busy || !detail.device.activeInstallation}
                  onClick={() =>
                    void act(`devices/${selected.id}`, "PATCH", {
                      state:
                        detail.device.state === "paused" ? "active" : "paused",
                    })
                  }
                >
                  {detail.device.state === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  className="danger"
                  disabled={busy || !detail.device.activeInstallation}
                  onClick={() => {
                    if (
                      confirm(
                        "Revoke this device credential and cancel its pending requests?",
                      )
                    )
                      void act(
                        `devices/${selected.id}/revoke`,
                        "POST",
                        {},
                        "Device revoked",
                      );
                  }}
                >
                  Revoke
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  void act(`devices/${selected.id}`, "PATCH", {
                    assignedLabel: fd.get("label"),
                    schoolEmail: fd.get("email"),
                  });
                }}
              >
                <label>
                  Assignment
                  <input
                    name="label"
                    defaultValue={detail.device.assignedLabel}
                  />
                </label>
                <label>
                  School email
                  <input
                    name="email"
                    type="email"
                    defaultValue={detail.device.schoolEmail}
                  />
                </label>
                <button disabled={busy}>Save assignment</button>
              </form>
              <h3>Collection history</h3>
              {detail.collections.length ? (
                detail.collections.map((c: Row) => (
                  <div className="history" key={c.id}>
                    <strong>{c.outcome.replaceAll("_", " ")}</strong>
                    <small>{date(c.receivedAt)}</small>
                    <span>{JSON.stringify(c.counts)}</span>
                  </div>
                ))
              ) : (
                <div className="empty bordered">
                  <Icon name="logs" />
                  <strong>No collection activity</strong>
                  <p>
                    Collection requests and completed uploads will appear here.
                  </p>
                </div>
              )}
            </>
          ) : view === "logs" && detail ? (
            <>
              <h2>{detail.log.source.basename}</h2>
              <p>{detail.log.source.username}</p>
              <dl>
                {[
                  ["Device", detail.log.serial],
                  ["Uploaded", date(detail.log.uploadedAt)],
                  ["Accepted", date(detail.log.acceptedAt)],
                  ["Expires", date(detail.log.expiresAt)],
                  ["Raw SHA-256", detail.log.rawSha256],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="detail-actions">
                <button
                  onClick={() => {
                    const request = detailRequest.current;
                    void api(`logs/${selected.id}/preview`)
                      .then((result) => {
                        if (request === detailRequest.current)
                          setPreview(result);
                      })
                      .catch((e) => {
                        if (request === detailRequest.current)
                          setError(e.message);
                      });
                  }}
                >
                  Preview text
                </button>
                <a
                  className="button primary"
                  href={`/api/admin/v1/logs/${selected.id}/download`}
                >
                  Download gzip
                </a>
              </div>
              {preview && (
                <>
                  <small>
                    {preview.partial
                      ? "Partial preview: first 128 KiB"
                      : "Complete preview"}
                  </small>
                  <pre>{preview.text}</pre>
                </>
              )}
              <h3>Safe Online Exam session association</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act("session-links", "POST", {
                    logId: selected.id,
                    instance: f.get("instance"),
                    session: f.get("session"),
                  });
                }}
              >
                <label>
                  Safe Online Exam instance
                  <input name="instance" required maxLength={80} />
                </label>
                <label>
                  Opaque session ID
                  <input name="session" required maxLength={200} />
                </label>
                <button>Attach session</button>
              </form>
              {detail.links.map((l: Row) => (
                <div className="history" key={l.id}>
                  {l.instance} · {l.session}
                  <small>Manual association</small>
                  <button
                    onClick={() =>
                      void act("session-links", "POST", {
                        logId: selected.id,
                        instance: l.instance,
                        session: l.session,
                        remove: true,
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </>
          ) : (
            <p>Loading details…</p>
          )}
        </aside>
      )}
      {batch && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-title"
          >
            <button
              className="close"
              aria-label="Close enrollment"
              onClick={() => setBatch(false)}
            >
              <Icon name="close" />
            </button>
            <h2 id="batch-title">Create enrollment batch</h2>
            {code ? (
              <>
                <p>
                  Download the installer and scope it to your Jamf group. Each
                  Mac registers automatically. Close the batch after enrollment.
                </p>
                <textarea
                  aria-label="Bootstrap code"
                  readOnly
                  value={code.code}
                />
                <p>
                  Expires {date(code.expiresAt)} · Up to {code.ceiling} devices
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const response = await fetch("/collector/install.zsh", {
                        cache: "no-store",
                      });
                      if (!response.ok)
                        throw new Error("installer_unavailable");
                      const script = enrollmentInstaller(
                        await response.text(),
                        code.code,
                        code.origin,
                      );
                      save(
                        "safe-online-exam-logs-install-and-enroll.zsh",
                        script,
                        "text/plain",
                      );
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Download install and enroll script
                </button>
              </>
            ) : (
              <>
                <label>
                  Enrollment method
                  <select
                    value={enrollmentMode}
                    onChange={(e) => setEnrollmentMode(e.target.value)}
                  >
                    <option value="jamf">
                      Jamf group — automatic acceptance
                    </option>
                    <option value="roster">Approved serial roster</option>
                  </select>
                </label>
                {enrollmentMode === "jamf" ? (
                  <>
                    <p>
                      Scope the downloaded installer to the intended Jamf group.
                      No serial list is required. Anyone with this temporary
                      installer can enroll within the window and device limit.
                    </p>
                    <label>
                      Jamf group name
                      <input
                        value={enrollmentLabel}
                        maxLength={200}
                        onChange={(e) => setEnrollmentLabel(e.target.value)}
                        placeholder="Your managed Mac group"
                      />
                    </label>
                    <label>
                      Maximum devices
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={enrollmentCeiling}
                        onChange={(e) =>
                          setEnrollmentCeiling(Number(e.target.value))
                        }
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !enrollmentLabel.trim() ||
                        enrollmentCeiling < 1 ||
                        enrollmentCeiling > 1000
                      }
                      onClick={async () => {
                        setBusy(true);
                        try {
                          setCode(
                            await api("enrollment-batches", "POST", {
                              mode: "jamf",
                              label: enrollmentLabel.trim(),
                              ceiling: enrollmentCeiling,
                              days: 7,
                            }),
                          );
                          await load();
                        } catch (err) {
                          setError((err as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Create Jamf enrollment
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      Upload a CSV with <code>serial</code>. Optional columns:{" "}
                      <code>assignedLabel</code>, <code>schoolEmail</code>,{" "}
                      <code>jamfId</code>. At most 400 devices per batch.
                    </p>
                    <label>
                      Approved serial roster
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          setBusy(true);
                          try {
                            const roster = parseRoster(await f.text());
                            setCode(
                              await api("enrollment-batches", "POST", {
                                roster,
                                days: 7,
                              }),
                            );
                            await load();
                          } catch (err) {
                            setError((err as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      />
                    </label>
                    <button
                      onClick={() =>
                        save(
                          "enrollment-roster-template.csv",
                          "serial,assignedLabel,schoolEmail,jamfId\nSYNTHETIC001,Pilot fixture,,\n",
                          "text/csv",
                        )
                      }
                    >
                      Download CSV template
                    </button>
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="error-text">
                {error.replaceAll("_", " ")}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
