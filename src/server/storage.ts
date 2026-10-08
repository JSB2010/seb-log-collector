import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { createHash } from "node:crypto";
import { createInflateRaw, crc32 } from "node:zlib";
import { Readable } from "node:stream";
import { config } from "./config";
import { ApiError, requireThat } from "./errors";
import type { Doc } from "./store";
const storage = () => new Storage({ projectId: config().GOOGLE_CLOUD_PROJECT });
export const object = (key: string, generation?: string) =>
  storage()
    .bucket(config().LOG_BUCKET)
    .file(key, generation ? { generation } : undefined);
export async function signedPost(u: Doc) {
  const c = config(),
    now = new Date(),
    date = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z"),
    expiresAt = new Date(now.getTime() + 600000).toISOString();
  const fields: Record<string, string> = {
    key: u.objectKey,
    "Content-Type": "application/gzip",
    success_action_status: "201",
    "x-goog-algorithm": "GOOG4-RSA-SHA256",
    "x-goog-credential": `${c.UPLOAD_SIGNER_EMAIL}/${date.slice(0, 8)}/auto/storage/goog4_request`,
    "x-goog-date": date,
    "x-goog-meta-upload-id": u.id,
  };
  const policy = Buffer.from(
    JSON.stringify({
      expiration: expiresAt,
      conditions: [
        { bucket: c.LOG_BUCKET },
        ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
        ["content-length-range", u.gzipBytes, u.gzipBytes],
      ],
    }),
  ).toString("base64");
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const r = await client.request<{ signedBlob: string }>({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${c.UPLOAD_SIGNER_EMAIL}:signBlob`,
    method: "POST",
    data: { payload: Buffer.from(policy).toString("base64") },
  });
  fields.policy = policy;
  fields["x-goog-signature"] = Buffer.from(
    r.data.signedBlob,
    "base64",
  ).toString("hex");
  return {
    uploadId: u.id,
    expiresAt,
    method: "POST",
    url: `https://storage.googleapis.com/${c.LOG_BUCKET}`,
    fields,
  };
}
// A single gzip member only. Node's normal Gunzip accepts concatenated members;
// parsing the wrapper and checking consumed deflate bytes also rejects trailing data.
export async function verifyGzip(
  input: AsyncIterable<Uint8Array>,
  expected: Doc,
  previewBytes = 128 * 1024,
) {
  const chunks: Buffer[] = [],
    gzipHash = createHash("sha256");
  let bytes = 0;
  const deadline = Date.now() + 45000;
  for await (const chunk of input) {
    requireThat(Date.now() < deadline, 503, "verification_timeout");
    bytes += chunk.length;
    requireThat(
      bytes <= expected.gzipBytes && bytes <= 20 * 1024 ** 2,
      422,
      "gzip_size_mismatch",
    );
    gzipHash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  requireThat(
    bytes === expected.gzipBytes &&
      gzipHash.digest("hex") === expected.gzipSha256,
    422,
    "gzip_integrity_mismatch",
  );
  requireThat(
    buf.length >= 18 &&
      buf[0] === 31 &&
      buf[1] === 139 &&
      buf[2] === 8 &&
      (buf[3] & 224) === 0,
    422,
    "invalid_gzip",
  );
  const flags = buf[3];
  let offset = 10;
  if (flags & 4) {
    requireThat(offset + 2 <= buf.length, 422, "invalid_gzip");
    const len = buf.readUInt16LE(offset);
    offset += 2 + len;
  }
  for (const flag of [8, 16])
    if (flags & flag) {
      while (offset < buf.length && buf[offset++] !== 0) {
        requireThat(offset < 65536, 422, "invalid_gzip_header");
      }
    }
  if (flags & 2) {
    requireThat(
      offset + 2 < buf.length &&
        (crc32(buf.subarray(0, offset)) & 65535) === buf.readUInt16LE(offset),
      422,
      "invalid_gzip_header",
    );
    offset += 2;
  }
  requireThat(
    offset + 8 < buf.length && offset <= 65536,
    422,
    "invalid_gzip_header",
  );
  const inflate = createInflateRaw(),
    rawHash = createHash("sha256"),
    preview: Buffer[] = [];
  let rawBytes = 0,
    crc = 0,
    previewSize = 0;
  const timer = setTimeout(
    () => inflate.destroy(new ApiError(503, "verification_timeout")),
    45000,
  );
  timer.unref();
  inflate.end(buf.subarray(offset));
  try {
    for await (const value of inflate) {
      const chunk = Buffer.from(value);
      rawBytes += chunk.length;
      requireThat(
        rawBytes <= expected.rawBytes && rawBytes <= 64 * 1024 ** 2,
        422,
        "raw_size_mismatch",
      );
      rawHash.update(chunk);
      crc = crc32(chunk, crc);
      if (previewSize < previewBytes) {
        const part = chunk.subarray(0, previewBytes - previewSize);
        preview.push(part);
        previewSize += part.length;
      }
    }
  } catch (e) {
    inflate.destroy();
    if (e instanceof ApiError) throw e;
    throw new ApiError(422, "invalid_deflate");
  } finally {
    clearTimeout(timer);
  }
  const trailer = offset + inflate.bytesWritten;
  requireThat(trailer + 8 === buf.length, 422, "trailing_gzip_payload");
  requireThat(
    buf.readUInt32LE(trailer) === crc &&
      buf.readUInt32LE(trailer + 4) === rawBytes >>> 0,
    422,
    "invalid_gzip_trailer",
  );
  requireThat(
    rawBytes === expected.rawBytes &&
      rawHash.digest("hex") === expected.rawSha256,
    422,
    "raw_integrity_mismatch",
  );
  return {
    text: Buffer.concat(preview).toString("utf8"),
    partial: rawBytes > previewSize,
    rawBytes,
  };
}
export async function verifyObject(u: Doc) {
  const [m] = await object(u.objectKey).getMetadata();
  requireThat(
    m.contentType === "application/gzip" && !m.contentEncoding,
    422,
    "invalid_object_metadata",
  );
  const generation = String(m.generation);
  const file = object(u.objectKey, generation);
  const stream = file.createReadStream();
  const timer = setTimeout(
    () => stream.destroy(new ApiError(503, "verification_timeout")),
    45000,
  );
  timer.unref();
  try {
    await verifyGzip(stream, u);
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) e.details = { generation };
    throw e;
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
  return { generation, uploadedAt: m.timeCreated! };
}
export async function removeObject(key: string, generation?: string) {
  try {
    await object(key, generation).delete(
      generation ? { ifGenerationMatch: generation } : undefined,
    );
  } catch (e) {
    if ((e as any).code !== 404) throw e;
  }
}
export function download(u: Doc) {
  return Readable.toWeb(
    object(u.objectKey, u.generation).createReadStream(),
  ) as ReadableStream<Uint8Array>;
}
