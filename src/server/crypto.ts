import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors";
export const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
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
