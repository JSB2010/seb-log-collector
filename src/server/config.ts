import { z } from "zod";
const csv = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
const schema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().min(1),
  LOG_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,221}$/),
  PUBLIC_ORIGIN: z.string().url(),
  UPLOAD_SIGNER_EMAIL: z.string().email(),
  SCHEDULER_EMAIL: z.string().email(),
  SCHEDULER_AUDIENCE: z.string().url(),
  ALLOWED_DOMAINS: z.string().min(1),
  SEED_ADMIN_EMAILS: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  INTEGRATION_SECRET: z.string().default(""),
  SOE_ADMIN_ORIGIN: z.string().default(""),
  DEV_AUTH: z.enum(["true", "false"]).default("false"),
  DEV_MEMORY: z.enum(["true", "false"]).default("false"),
  DEVICE_DAILY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(1024 ** 3)
    .default(50 * 1024 ** 2),
  GLOBAL_DAILY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 ** 3),
  DEVICE_DAILY_OBJECTS: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(90),
});
export function config() {
  const env = schema.parse(process.env);
  if (
    (process.env.NODE_ENV === "production" || process.env.K_SERVICE) &&
    (env.DEV_AUTH === "true" || env.DEV_MEMORY === "true")
  )
    throw new Error("Development bypasses forbidden in production");
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.origin !== env.PUBLIC_ORIGIN ||
    (origin.protocol !== "https:" &&
      !(
        origin.hostname === "127.0.0.1" && process.env.NODE_ENV !== "production"
      ))
  )
    throw new Error("Invalid API origin");
  const domains = csv(env.ALLOWED_DOMAINS),
    seedAdmins = csv(env.SEED_ADMIN_EMAILS);
  if (
    !domains.length ||
    !seedAdmins.length ||
    seedAdmins.some((e) => !domains.includes(e.split("@")[1] ?? ""))
  )
    throw new Error("Unsafe admin seed");
  return { ...env, domains, seedAdmins };
}
