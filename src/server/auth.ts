import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { store, type Store, type Doc } from "./store";
import { credentialHash, equal, sha, secret } from "./crypto";
import { ApiError, requireThat } from "./errors";
export type Actor = { email: string; sub: string; csrf: string };
const key = () => new TextEncoder().encode(config().SESSION_SECRET);
export function cookies(req: Request) {
  return Object.fromEntries(
    (req.headers.get("cookie") ?? "")
      .split(";")
      .map((s) => s.trim().split(/=(.*)/s).slice(0, 2)),
  );
}
export async function token(
  payload: Record<string, unknown>,
  purpose: string,
  seconds = 3600,
) {
  return new SignJWT({ ...payload, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config().PUBLIC_ORIGIN)
    .setAudience(purpose)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(key());
}
export async function claims(t: string, purpose: string) {
  return (
    await jwtVerify(t, key(), {
      issuer: config().PUBLIC_ORIGIN,
      audience: purpose,
      algorithms: ["HS256"],
    })
  ).payload;
}
export const cookie = (name: string, value: string, maxAge = 3600) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config().PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
export const bearer = (req: Request) =>
  req.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
export async function seedAdmins(db: Store) {
  await db.transaction(async (tx) => {
    const state = await tx.get("settings/admins");
    if (state) return;
    const emails = config().seedAdmins;
    tx.set("settings/admins", {
      count: emails.length,
      seededAt: new Date().toISOString(),
    });
    emails.forEach((email) =>
      tx.set(`admins/${sha(email)}`, {
        id: sha(email),
        email,
        active: true,
        sub: null,
        createdAt: new Date().toISOString(),
      }),
    );
  });
}
export function eligibleGoogle(payload: Doc) {
  const c = config();
  requireThat(
    payload.email_verified === true &&
      typeof payload.email === "string" &&
      c.domains.includes(payload.hd) &&
      c.domains.includes(payload.email.toLowerCase().split("@")[1]),
    403,
    "domain_denied",
  );
}
export async function admin(
  req: Request,
  mutate = false,
  db = store(),
): Promise<Actor> {
  if (config().DEV_AUTH === "true" && req.headers.get("x-dev-admin") === "true")
    return {
      email: config().seedAdmins[0],
      sub: "local-fixture",
      csrf: "development",
    };
  let c;
  try {
    c = await claims(cookies(req)["soe_session"] ?? "", "session");
  } catch {
    throw new ApiError(401, "sign_in_required");
  }
  const email = String(c.email ?? "");
  const entry = await db.get(`admins/${sha(email)}`);
  requireThat(entry?.active && entry.sub === c.sub, 403, "admin_denied");
  if (mutate) {
    requireThat(
      req.headers.get("origin") === config().PUBLIC_ORIGIN &&
        equal(req.headers.get("x-csrf-token") ?? "", String(c.csrf)),
      403,
      "csrf_denied",
    );
  }
  return { email, sub: String(c.sub), csrf: String(c.csrf) };
}
export async function device(req: Request, db = store()): Promise<Doc> {
  const m = bearer(req).match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
  requireThat(m, 401, "invalid_credential");
  const hash = credentialHash(m[2]),
    now = new Date(),
    hour = now.toISOString().slice(0, 13);
  return db.transaction(async (tx) => {
    const i = await tx.get(`installations/${m[1]}`);
    requireThat(i && equal(i.credentialHash, hash), 401, "invalid_credential");
    const d = await tx.get(`devices/${i.deviceId}`);
    requireThat(
      !i.revokedAt && d && d.activeInstallation === m[1],
      403,
      "credential_revoked",
    );
    const qp = `quotaWindows/control-${m[1]}-${hour}`,
      q = await tx.get(qp);
    requireThat((q?.count ?? 0) < 120, 429, "control_rate_limit");
    tx.set(qp, {
      id: qp.split("/")[1],
      count: (q?.count ?? 0) + 1,
      expiresAt: new Date(now.getTime() + 2 * 86400000).toISOString(),
      ttlAt: new Date(now.getTime() + 2 * 86400000),
    });
    tx.set(`devices/${i.deviceId}`, { ...d, lastSeenAt: now.toISOString() });
    return { ...d, installationId: m[1] };
  });
}
export async function scheduler(req: Request) {
  const c = config();
  let p;
  try {
    p = (
      await new OAuth2Client().verifyIdToken({
        idToken: bearer(req),
        audience: c.SCHEDULER_AUDIENCE,
      })
    ).getPayload();
  } catch {
    throw new ApiError(401, "invalid_scheduler");
  }
  requireThat(
    p?.email_verified && p.email === c.SCHEDULER_EMAIL,
    403,
    "scheduler_denied",
  );
}
export async function oauth(req: Request, path: string) {
  const c = config(),
    url = new URL(req.url);
  // Keep the state cookie on the callback's configured host when an operator
  // follows an old Cloud Run URL after moving to a custom domain.
  if (path === "login" && url.hostname !== new URL(c.PUBLIC_ORIGIN).hostname)
    return new Response(null, {
      status: 302,
      headers: { location: `${c.PUBLIC_ORIGIN}/api/auth/login` },
    });
  const client = new OAuth2Client(
    c.GOOGLE_CLIENT_ID,
    c.GOOGLE_CLIENT_SECRET,
    `${c.PUBLIC_ORIGIN}/api/auth/callback`,
  );
  requireThat(
    c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET,
    503,
    "oauth_not_configured",
  );
  if (path === "login") {
    const state = secret(),
      nonce = secret(),
      verifier = secret();
    const flow = await token({ state, nonce, verifier }, "oauth", 600);
    const target = client.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      nonce,
      code_challenge: shaBase64(verifier),
      code_challenge_method: "S256" as any,
      prompt: "select_account",
      hd: c.domains[0],
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: target,
        "set-cookie": cookie("soe_oauth", flow, 600),
      },
    });
  }
  requireThat(path === "callback", 404, "not_found");
  let flow;
  try {
    flow = await claims(cookies(req).soe_oauth ?? "", "oauth");
  } catch {
    throw new ApiError(401, "invalid_oauth_state");
  }
  requireThat(
    equal(url.searchParams.get("state") ?? "", String(flow.state)) &&
      url.searchParams.has("code"),
    401,
    "invalid_oauth_state",
  );
  const { tokens } = await client.getToken({
    code: url.searchParams.get("code")!,
    codeVerifier: String(flow.verifier),
  });
  const p = (
    await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: c.GOOGLE_CLIENT_ID,
    })
  ).getPayload();
  requireThat(p && p.nonce === flow.nonce, 401, "invalid_oidc_nonce");
  eligibleGoogle(p);
  const db = store();
  await seedAdmins(db);
  const email = p.email!.toLowerCase();
  await db.transaction(async (tx) => {
    const a = await tx.get(`admins/${sha(email)}`);
    requireThat(a?.active && (!a.sub || a.sub === p.sub), 403, "admin_denied");
    tx.set(`admins/${sha(email)}`, {
      ...a,
      sub: p.sub,
      lastLoginAt: new Date().toISOString(),
    });
  });
  const csrf = secret(),
    session = await token({ email, sub: p.sub, csrf }, "session");
  const headers = new Headers({ location: c.PUBLIC_ORIGIN });
  headers.append("set-cookie", cookie("soe_session", session));
  headers.append("set-cookie", cookie("soe_oauth", "", 0));
  return new Response(null, { status: 302, headers });
}
import { createHash } from "node:crypto";
const shaBase64 = (s: string) =>
  createHash("sha256").update(s).digest("base64url");
