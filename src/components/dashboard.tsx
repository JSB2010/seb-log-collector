"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { BrandMark } from "./brand";
import { csvCell } from "./csv";
import { views, viewFromPath, type View } from "./navigation";
import { humanize, collectionSummary, enrollmentState } from "./activity";
type Row = Record<string, any>;
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
async function copyScript(text: string) {
  const unavailable =
    "Copy is unavailable in this browser. Download the script instead.";
  if (!navigator.clipboard?.writeText) throw new Error(unavailable);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(unavailable)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function Dashboard({ initialView = "fleet" }: { initialView?: View }) {
  const currentView = useRef<string>(initialView),
    navigation = useRef(0),
    listRequest = useRef(0),
    detailRequest = useRef(0);
  const [me, setMe] = useState<Row | null | undefined>(undefined),
    [view, setView] = useState<string>(initialView),
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
    [deviceId, setDeviceId] = useState(""),
    [deviceLabel, setDeviceLabel] = useState(""),
    [restoredSelection, setRestoredSelection] = useState(""),
    [urlReady, setUrlReady] = useState(false),
    [batch, setBatch] = useState(false),
    [confirmation, setConfirmation] = useState<{
      title: string;
      body: string;
      run: () => void;
    } | null>(null),
    [editingBatch, setEditingBatch] = useState<Row | null>(null),
    [sort, setSort] = useState("session-newest"),
    [requestKind, setRequestKind] = useState("collection"),
    [groups, setGroups] = useState<Row[]>([]),
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
        if (r.status === 401) setMe(null);
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
  useEffect(() => {
    if (me)
      api("enrollment-groups")
        .then((r) => setGroups(r.items))
        .catch((e) => setError(e.message));
  }, [api, me?.email]);
  const load = useCallback(
    async (append = false, next?: string) => {
      if (!me || currentView.current !== view) return;
      const request = ++listRequest.current;
      setBusy(true);
      setError("");
      try {
        const p = new URLSearchParams();
        if (deviceId && ["logs", "requests"].includes(view))
          p.set("deviceId", deviceId);
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
          p.set("sort", sort);
          p.set("from", new Date(from + "T00:00:00Z").toISOString());
          p.set("to", new Date(to + "T23:59:59Z").toISOString());
        }
        if (next) p.set("cursor", next);
        const target =
          view === "requests" && requestKind !== "collection"
            ? requestKind === "management"
              ? "deviceCommands"
              : "groupOperations"
            : resource[view];
        const r = await api(`${target}?${p}`);
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
      deviceId,
      sort,
      requestKind,
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
      void api("enrollment-groups")
        .then((r) => setGroups(r.items))
        .catch((e) => setError(e.message));
      await load();
      if (selected && selection === detailRequest.current) await open(selected);
    } catch (e) {
      if (page === navigation.current) setError((e as Error).message);
    } finally {
      if (page === navigation.current) setBusy(false);
    }
  }
  function changeView(v: string, params = "", push = true) {
    currentView.current = v;
    navigation.current++;
    listRequest.current++;
    detailRequest.current++;
    setRows([]);
    setCursor(null);
    setBusy(true);
    setError("");
    setView(v);
    const p = new URLSearchParams(params);
    setQuery(p.get("q") ?? "");
    setSearch(p.get("q") ?? "");
    setState(p.get("state") ?? "");
    setSort(p.get("sort") ?? "session-newest");
    setRequestKind(p.get("kind") ?? "collection");
    setLastContact(p.get("lastContact") ?? "");
    setSession(p.get("session") ?? "");
    setInstance(p.get("instance") ?? "");
    setMac(p.get("macOS") ?? "");
    setSeb(p.get("seb") ?? "");
    const validDay = (value: string | null, fallback: string) =>
      value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
    setFrom(validDay(p.get("from"), day(-7)));
    setTo(validDay(p.get("to"), day(0)));
    setDeviceId(p.get("deviceId") ?? "");
    setDeviceLabel(p.get("device") ?? "");
    setSelected(null);
    setDetail(null);
    setNotice("");
    setConfirmation(null);
    setBatch(false);
    setRestoredSelection(p.get("selected") ?? "");
    if (push) history.pushState(null, "", `/${v}${p.size ? `?${p}` : ""}`);
  }
  useEffect(() => {
    const restore = () =>
      changeView(viewFromPath(location.pathname), location.search, false);
    restore();
    setUrlReady(true);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries({
      q: query.trim(),
      state,
      lastContact,
      session,
      instance,
      macOS: mac,
      seb,
      deviceId,
      device: deviceLabel,
      ...(view === "logs" ? { sort } : {}),
      ...(view === "requests" ? { kind: requestKind } : {}),
    }))
      if (value) p.set(key, value);
    if (view === "logs") {
      p.set("from", from);
      p.set("to", to);
    }
    if (selected) p.set("selected", selected.id);
    else if (restoredSelection) p.set("selected", restoredSelection);
    const href = `/${view}${p.size ? `?${p}` : ""}`;
    if (location.pathname + location.search !== href)
      history.replaceState(null, "", href);
  }, [
    urlReady,
    view,
    query,
    state,
    lastContact,
    session,
    instance,
    mac,
    seb,
    from,
    to,
    deviceId,
    deviceLabel,
    selected,
    restoredSelection,
    sort,
    requestKind,
  ]);
  useEffect(() => {
    if (me && restoredSelection && ["fleet", "logs"].includes(view)) {
      void open({ id: restoredSelection });
      setRestoredSelection("");
    }
  }, [me?.email, view, restoredSelection]);
  useEffect(() => {
    if (!batch && !confirmation) return;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const previous = document.activeElement as HTMLElement | null;
    dialog?.querySelector<HTMLElement>("input, button")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setBatch(false);
        setConfirmation(null);
      }
      if (e.key !== "Tab") return;
      const controls = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
        ) ?? [],
      );
      const first = controls[0],
        last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [batch, confirmation]);
  const follow = (
    e: React.MouseEvent<HTMLAnchorElement>,
    v: string,
    params = "",
  ) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    changeView(v, params);
  };
  function editEnrollment(r?: Row) {
    setEditingBatch(r ?? null);
    setEnrollmentLabel(r?.label ?? "");
    setEnrollmentCeiling(r?.ceiling ?? 1000);
    setBatch(true);
  }
  async function groupAction(group: Row, action: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `enrollment-batches/${group.id}/actions`,
        "POST",
        { action, operationId: crypto.randomUUID() },
      );
      const outcomes = Object.values(result.results) as string[];
      const accepted = outcomes.filter((v) =>
        ["queued", "completed"].includes(v),
      ).length;
      setNotice(
        `${humanize(action)}: ${accepted} of ${outcomes.length} Macs ${["update", "uninstall", "collect"].includes(action) ? "queued" : "changed"}${accepted < outcomes.length ? ". View Requests → Group actions for skipped Macs." : "."}`,
      );
      await load();
      setGroups((await api("enrollment-groups")).items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function script(
    path: string,
    name: string,
    copy = false,
    method = "GET",
  ) {
    const page = navigation.current;
    setBusy(true);
    setError("");
    try {
      const headers: Record<string, string> = {};
      if (me?.csrf) headers["x-csrf-token"] = me.csrf;
      if (
        process.env.NODE_ENV === "development" &&
        location.hostname === "127.0.0.1"
      )
        headers["x-dev-admin"] = "true";
      const r = await fetch(`/api/admin/v1/${path}`, { method, headers });
      if (!r.ok) {
        if (r.status === 401) setMe(null);
        throw new Error((await r.json()).error?.code ?? "script_unavailable");
      }
      const text = await r.text();
      if (copy) {
        await copyScript(text);
        if (page === navigation.current) setNotice("Script copied");
      } else {
        save(name, text, "text/plain");
        if (page === navigation.current) setNotice("Script downloaded");
      }
    } catch (e) {
      if (page === navigation.current) setError((e as Error).message);
    } finally {
      if (page === navigation.current) setBusy(false);
    }
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
        <a
          className="button primary"
          href={`/api/auth/login?returnTo=${encodeURIComponent(`/${view}${typeof window === "undefined" ? "" : location.search}`)}`}
        >
          Sign in with Google
        </a>
        <p className="muted">Access is limited to approved administrators.</p>
      </main>
    );
  return (
    <div className={`shell ${selected ? "has-detail" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="/fleet" aria-label="Safe Online Exam Logs">
          <BrandMark />
          <span className="brand-name">
            <span>Safe Online Exam</span>
            <span className="brand-product">Logs</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {views.map(([v, label]) => (
            <a
              key={v}
              className={view === v ? "active" : ""}
              aria-current={view === v ? "page" : undefined}
              href={`/${v}`}
              onClick={(e) => follow(e, v)}
            >
              <Icon name={v} />
              {label}
            </a>
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
            {view === "requests" && <p>Runs at the next device check-in.</p>}
          </div>
          {view === "fleet" || view === "enrollment" ? (
            <button className="primary" onClick={() => editEnrollment()}>
              Create enrollment
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
        {deviceId && (
          <div className="filter-context">
            <strong>{deviceLabel || "Selected device"}</strong>
            <button
              onClick={() => {
                setDeviceId("");
                setDeviceLabel("");
              }}
            >
              Clear device filter
            </button>
          </div>
        )}
        {["fleet", "logs"].includes(view) && (
          <>
            <div className="search">
              <Icon name="search" />
              <input
                aria-label="Search serial, hostname, or group"
                placeholder="Search serial, hostname, or group"
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
                    Sort
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="session-newest">
                        Session date · newest first
                      </option>
                      <option value="session-oldest">
                        Session date · oldest first
                      </option>
                      <option value="received-newest">
                        Received · newest first
                      </option>
                      <option value="received-oldest">
                        Received · oldest first
                      </option>
                    </select>
                  </label>
                  <label>
                    {sort.startsWith("session-")
                      ? "Session from"
                      : "Received from"}
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
          <details className="advanced-filters">
            <summary>Session filters</summary>
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
          </details>
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
        {view === "enrollment" && (
          <div className="filters">
            <label>
              Groups
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">Open and closed</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="deleted">Deleted</option>
              </select>
            </label>
          </div>
        )}
        {view === "requests" && (
          <div className="filters">
            <label>
              Requests
              <select
                value={requestKind}
                onChange={(e) => {
                  listRequest.current++;
                  setRows([]);
                  setCursor(null);
                  setBusy(true);
                  setRequestKind(e.target.value);
                }}
              >
                <option value="collection">Collections</option>
                <option value="management">Updates and uninstall</option>
                <option value="groups">Group actions</option>
              </select>
            </label>
          </div>
        )}
        <div className="table-wrap">
          <table className={view === "enrollment" ? "groups-table" : undefined}>
            <thead>
              <tr>
                {(view === "fleet"
                  ? [
                      "Device",
                      "Enrollment group",
                      "Versions",
                      "Last contact",
                      "Collection",
                      "State",
                    ]
                  : view === "logs"
                    ? ["Session date", "Device", "User", "Size", "Expires", ""]
                    : view === "enrollment"
                      ? ["Group", "Devices / limit", "State", ""]
                      : view === "requests"
                        ? requestKind === "management"
                          ? [
                              "Device",
                              "Action",
                              "Created",
                              "State",
                              "Result",
                              "",
                            ]
                          : requestKind === "groups"
                            ? [
                                "Group",
                                "Action",
                                "Created",
                                "State",
                                "Results",
                                "",
                              ]
                            : [
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
                        {r.groupLabel || "No group"}
                        <small>{r.schoolEmail}</small>
                      </td>
                      <td>
                        macOS {r.metadata?.macOSVersion ?? "—"} · SEB{" "}
                        {r.metadata?.sebVersion ?? "—"}
                      </td>
                      <td>{date(r.lastSeenAt)}</td>
                      <td>
                        {humanize(r.lastOutcome) === "—"
                          ? "No logs"
                          : humanize(r.lastOutcome)}
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
                          {date(r.logStartedAt || r.source.mtime)}
                          {r.logDateBasis === "modified" && (
                            <small>File date</small>
                          )}
                        </button>
                      </td>
                      <td>{r.deviceName || r.serial}</td>
                      <td>{r.source.username}</td>
                      <td>{(r.gzipBytes / 1024).toFixed(1)} KiB</td>
                      <td>{date(r.expiresAt)}</td>
                      <td>
                        <a
                          href={`/api/admin/v1/logs/${r.id}/open`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      </td>
                    </>
                  ) : view === "enrollment" ? (
                    <>
                      <td>
                        <strong>{r.label || "Enrollment"}</strong>
                      </td>
                      <td>
                        {r.count} / {r.ceiling}
                      </td>
                      <td>{enrollmentState(r)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            disabled={busy || r.state === "deleted"}
                            onClick={() =>
                              void script(
                                `enrollment-batches/${r.id}/installer`,
                                "safe-online-exam-logs-install-and-enroll.zsh",
                                false,
                                "POST",
                              )
                            }
                          >
                            Download script
                          </button>
                          <button onClick={() => editEnrollment(r)}>
                            Edit
                          </button>
                          {r.count > 0 && r.state !== "deleted" && (
                            <select
                              aria-label={`Manage ${r.label}`}
                              value=""
                              disabled={busy}
                              onChange={(e) => {
                                const action = e.target.value;
                                setConfirmation({
                                  title: `${humanize(e.target.value)} group`,
                                  body: `Apply ${humanize(e.target.value).toLowerCase()} to ${r.count} enrolled Macs in “${r.label}”?${["revoke", "uninstall"].includes(e.target.value) ? " These Macs will need enrollment again." : ""}`,
                                  run: () => void groupAction(r, action),
                                });
                              }}
                            >
                              <option value="">Manage Macs…</option>
                              <option value="collect">Queue collection</option>
                              <option value="pause">Pause</option>
                              <option value="resume">Resume</option>
                              <option value="update">Queue update</option>
                              <option value="uninstall">Queue uninstall</option>
                              <option value="revoke">Revoke</option>
                            </select>
                          )}
                          {r.count === 0 && r.state !== "deleted" && (
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  `enrollment-batches/${r.id}`,
                                  "PATCH",
                                  { state: "deleted" },
                                  "Group deleted. You can restore it from Deleted groups.",
                                )
                              }
                            >
                              Delete
                            </button>
                          )}
                          {enrollmentState(r) === "Open" && r.count > 0 ? (
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
                          ) : r.state !== "open" ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  `enrollment-batches/${r.id}`,
                                  "PATCH",
                                  { state: "open" },
                                  "Enrollment opened",
                                )
                              }
                            >
                              {r.state === "deleted" ? "Restore" : "Reopen"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </>
                  ) : view === "requests" && requestKind === "management" ? (
                    <>
                      <td>
                        <a
                          href={`/fleet?selected=${r.deviceId}`}
                          onClick={(e) =>
                            follow(e, "fleet", `selected=${r.deviceId}`)
                          }
                        >
                          {r.deviceLabel || r.deviceId}
                        </a>
                      </td>
                      <td>
                        {r.action === "update"
                          ? `Update to ${r.version}`
                          : "Uninstall"}
                      </td>
                      <td>{date(r.createdAt)}</td>
                      <td>{humanize(r.state)}</td>
                      <td>{humanize(r.result)}</td>
                      <td>
                        {["pending", "deferred"].includes(r.state) && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(
                                `deviceCommands/${r.id}`,
                                "DELETE",
                                undefined,
                                "Command cancelled",
                              )
                            }
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </>
                  ) : view === "requests" && requestKind === "groups" ? (
                    <>
                      <td>{r.groupLabel}</td>
                      <td>{humanize(r.action)}</td>
                      <td>{date(r.createdAt)}</td>
                      <td>{humanize(r.state)}</td>
                      <td>
                        <details>
                          <summary>
                            {Object.keys(r.results ?? {}).length} /{" "}
                            {r.members?.length ?? 0} Macs processed
                          </summary>
                          {Object.entries(r.results ?? {}).map(
                            ([id, result]) => (
                              <div key={id}>
                                <a
                                  href={`/fleet?selected=${id}`}
                                  onClick={(e) =>
                                    follow(e, "fleet", `selected=${id}`)
                                  }
                                >
                                  {r.deviceNames?.[id] || id.slice(0, 12)}
                                </a>{" "}
                                · {humanize(String(result))}
                              </div>
                            ),
                          )}
                        </details>
                      </td>
                      <td>
                        {r.state === "running" && (
                          <button
                            onClick={() =>
                              void api(
                                `enrollment-batches/${r.groupId}/actions`,
                                "POST",
                                { action: r.action, operationId: r.id },
                              )
                                .then(() => load())
                                .catch((e) => setError(e.message))
                            }
                          >
                            Continue
                          </button>
                        )}
                      </td>
                    </>
                  ) : view === "requests" ? (
                    <>
                      <td>
                        <a
                          href={`/fleet?selected=${r.deviceId}`}
                          onClick={(e) =>
                            follow(e, "fleet", `selected=${r.deviceId}`)
                          }
                        >
                          {r.deviceLabel || r.deviceId.slice(0, 12)}
                        </a>
                      </td>
                      <td>
                        {date(r.from)}
                        <small>to {date(r.to)}</small>
                      </td>
                      <td>{date(r.createdAt)}</td>
                      <td>{humanize(r.state)}</td>
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
                      <td>{humanize(r.action)}</td>
                      <td>
                        {r.targetLabel || <code>{r.target.slice(0, 16)}</code>}
                      </td>
                      <td>{humanize(r.result)}</td>
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
                  ? "Create an enrollment to add your first Mac."
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
        {view === "logs" && (
          <div className="exports">
            <button
              onClick={() => {
                const cols = [
                  "id",
                  "serial",
                  "deviceName",
                  "logStartedAt",
                  "logDateBasis",
                  "sourceUser",
                  "uploadedAt",
                  "acceptedAt",
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
            <span className="muted">Loaded results only</span>
          </div>
        )}
        {view === "enrollment" && (
          <section className="scripts-panel">
            <h2>Device management</h2>
            <p>
              Run as root in Jamf. These scripts use the Mac’s existing
              enrollment.
            </p>
            <div className="script-grid">
              {[
                ["update", "Update", "Preserves credentials and queued logs."],
                [
                  "uninstall",
                  "Uninstall",
                  "Removes the collector; works offline.",
                ],
                [
                  "collect",
                  "Collect now",
                  "Starts a bounded run when Safe Exam Browser is closed.",
                ],
                ["pause", "Pause", "Stops local collection."],
                ["resume", "Resume", "Restores local collection."],
              ].map(([action, title, description]) => (
                <article key={action}>
                  <h3>{title}</h3>
                  <p>{description}</p>
                  <div className="row-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void script(
                          `scripts/${action}`,
                          `safe-online-exam-logs-${action}.zsh`,
                        )
                      }
                    >
                      Download
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void script(
                          `scripts/${action}`,
                          `safe-online-exam-logs-${action}.zsh`,
                          true,
                        )
                      }
                    >
                      Copy script
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
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
                  ["Enrollment group", detail.device.assignedLabel],
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
              <a
                className="button primary"
                href={`/logs?deviceId=${selected.id}&device=${encodeURIComponent(detail.device.metadata?.computerName || detail.device.serial)}&from=${day(-90)}&to=${day(0)}`}
                onClick={(e) =>
                  follow(
                    e,
                    "logs",
                    new URLSearchParams({
                      deviceId: selected.id,
                      device:
                        detail.device.metadata?.computerName ||
                        detail.device.serial,
                      from: day(-90),
                      to: day(0),
                    }).toString(),
                  )
                }
              >
                View device logs
              </a>
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
                      "Queued for the next check-in",
                    )
                  }
                >
                  Queue collection
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
                  onClick={() =>
                    setConfirmation({
                      title: "Revoke device",
                      body: "Revoke this device credential and cancel its pending requests? It will need enrollment again.",
                      run: () =>
                        void act(
                          `devices/${selected.id}/revoke`,
                          "POST",
                          {},
                          "Device revoked",
                        ),
                    })
                  }
                >
                  Revoke
                </button>
              </div>
              <div className="detail-actions">
                <button
                  disabled={
                    busy ||
                    !detail.device.activeInstallation ||
                    detail.device.metadata?.managementProtocol !== 1 ||
                    !!detail.device.pendingCommand
                  }
                  onClick={() =>
                    void act(
                      `devices/${selected.id}/commands`,
                      "POST",
                      { action: "update" },
                      "Update queued for check-in",
                    )
                  }
                >
                  Queue update
                </button>
                <button
                  className="danger"
                  disabled={
                    busy ||
                    !detail.device.activeInstallation ||
                    detail.device.metadata?.managementProtocol !== 1 ||
                    !!detail.device.pendingCommand
                  }
                  onClick={() =>
                    setConfirmation({
                      title: "Uninstall from Mac",
                      body: "Remove Safe Online Exam Logs at the next check-in? Access is revoked when removal starts. The Mac will need enrollment again.",
                      run: () =>
                        void act(
                          `devices/${selected.id}/commands`,
                          "POST",
                          { action: "uninstall" },
                          "Uninstall queued for check-in",
                        ),
                    })
                  }
                >
                  Queue uninstall
                </button>
              </div>
              {detail.device.activeInstallation &&
                detail.device.metadata?.managementProtocol !== 1 && (
                  <p className="muted">
                    Install version 0.3.0 or newer once to enable remote updates
                    and removal.
                  </p>
                )}
              <p className="muted request-timing">
                Collection runs at the next check-in, usually within 30 minutes
                while awake.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  void act(`devices/${selected.id}`, "PATCH", {
                    enrollmentGroupId: fd.get("group"),
                    schoolEmail: fd.get("email"),
                  });
                }}
              >
                <label>
                  Enrollment group
                  <select
                    name="group"
                    required
                    defaultValue={
                      detail.device.enrollmentGroupId ??
                      detail.device.enrollmentBatchId ??
                      ""
                    }
                    key={`${detail.device.id}:${detail.device.enrollmentGroupId}`}
                  >
                    <option value="" disabled>
                      Select a group
                    </option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                        {g.state === "closed" ? " (closed)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  School email
                  <input
                    name="email"
                    type="email"
                    defaultValue={detail.device.schoolEmail}
                  />
                </label>
                <button disabled={busy}>Save device</button>
              </form>
              {detail.commands?.length > 0 && (
                <>
                  <h3>Device commands</h3>
                  {detail.commands.map((c: Row) => (
                    <div className="history" key={c.id}>
                      <strong>
                        {c.action === "update"
                          ? `Update to ${c.version}`
                          : "Uninstall"}{" "}
                        · {humanize(c.state)}
                      </strong>
                      <small>{date(c.createdAt)}</small>
                      {c.result && <span>{humanize(c.result)}</span>}
                      {["pending", "deferred"].includes(c.state) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `deviceCommands/${c.id}`,
                              "DELETE",
                              undefined,
                              "Command cancelled",
                            )
                          }
                        >
                          Cancel command
                        </button>
                      )}
                    </div>
                  ))}
                </>
              )}
              <h3>Collection history</h3>
              {detail.collections.length ? (
                detail.collections.map((c: Row) => (
                  <div className="history" key={c.id}>
                    <strong>{humanize(c.outcome)}</strong>
                    <small>{date(c.receivedAt)}</small>
                    {Object.values(c.counts ?? {}).some(
                      (n) => Number(n) > 0,
                    ) && <span>{collectionSummary(c.counts)}</span>}
                    <small>{humanize(c.reason)}</small>
                    {c.errors?.length > 0 && (
                      <span className="activity-error">
                        {c.errors.map(humanize).join(" · ")}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div className="empty bordered">
                  <Icon name="logs" />
                  <strong>No collection activity</strong>
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
                <a
                  className="button primary"
                  href={`/api/admin/v1/logs/${selected.id}/open`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open log
                </a>
                <a
                  className="button primary"
                  href={`/api/admin/v1/logs/${selected.id}/download`}
                >
                  Download gzip
                </a>
              </div>
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
      {confirmation && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h2 id="confirm-title">{confirmation.title}</h2>
            <p>{confirmation.body}</p>
            <div className="row-actions">
              <button onClick={() => setConfirmation(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const run = confirmation.run;
                  setConfirmation(null);
                  run();
                }}
              >
                Confirm action
              </button>
            </div>
          </section>
        </div>
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
            <h2 id="batch-title">
              {editingBatch ? "Edit enrollment" : "Create enrollment"}
            </h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const values = {
                    label: enrollmentLabel.trim(),
                    ceiling: enrollmentCeiling,
                  };
                  if (editingBatch)
                    await api(
                      `enrollment-batches/${editingBatch.id}`,
                      "PATCH",
                      values,
                    );
                  else await api("enrollment-batches", "POST", values);
                  setBatch(false);
                  setNotice(
                    editingBatch ? "Enrollment updated" : "Enrollment created",
                  );
                  if (view !== "enrollment") changeView("enrollment");
                  else await load();
                  void api("enrollment-groups")
                    .then((r) => setGroups(r.items))
                    .catch((e) => setError(e.message));
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Enrollment name
                <input
                  value={enrollmentLabel}
                  maxLength={200}
                  required
                  onChange={(e) => setEnrollmentLabel(e.target.value)}
                  placeholder="Device group or rollout name"
                />
              </label>
              <label>
                Maximum devices
                <input
                  type="number"
                  min={editingBatch?.count || 1}
                  max={1000}
                  required
                  value={enrollmentCeiling}
                  onChange={(e) => setEnrollmentCeiling(Number(e.target.value))}
                />
              </label>
              <p className="muted">
                The same script enrolls every Mac you deploy it to. You can
                download it again or reopen this enrollment later.
              </p>
              <button
                className="primary"
                disabled={busy || !enrollmentLabel.trim()}
              >
                {editingBatch ? "Save enrollment" : "Create enrollment"}
              </button>
            </form>
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
