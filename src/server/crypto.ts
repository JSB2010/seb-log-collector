import {
  createHash,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { config } from "./config";
import { ApiError } from "./errors";
export const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
// Separate key context from session signing. Only authenticated installer retrieval
// decrypts this value; catalog/list responses must never include the ciphertext.
const bootstrapKey = () =>
  createHash("sha256")
    .update("safe-online-exam-logs:bootstrap:v1:")
    .update(config().SESSION_SECRET)
    .digest();
export function sealBootstrap(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", bootstrapKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}
export function openBootstrap(value: string) {
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new ApiError(409, "installer_key_unavailable");
  try {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      bootstrapKey(),
      Buffer.from(iv, "base64url"),
    );
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      cipher.update(Buffer.from(data, "base64url")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ApiError(409, "installer_key_unavailable");
  }
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function credentialHash(encoded: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded))
    throw new ApiError(401, "invalid_credential");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== encoded)
    throw new ApiError(401, "invalid_credential");
  return sha(bytes);
}
