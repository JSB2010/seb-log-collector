import { Firestore } from "@google-cloud/firestore";
import { config } from "./config";
// Values use UTC ISO strings for ordered indexes; ttlAt is a Firestore timestamp.
export type Doc = Record<string, any>;
export interface Tx {
  get(path: string): Promise<Doc | undefined>;
  set(path: string, value: Doc): void;
  delete(path: string): void;
}
export interface Store {
  get(path: string): Promise<Doc | undefined>;
  transaction<T>(f: (tx: Tx) => Promise<T>): Promise<T>;
  query(
    collection: string,
    filters?: [string, string, unknown][],
    order?: string,
    cursor?: string,
    limit?: number,
  ): Promise<Doc[]>;
}
let singleton: Store;
export function store(): Store {
  return (singleton ??=
    config().DEV_MEMORY === "true" ? new MemoryStore() : new CloudStore());
}
export class CloudStore implements Store {
  db = new Firestore({
    projectId: config().GOOGLE_CLOUD_PROJECT,
    ignoreUndefinedProperties: true,
  });
  async get(path: string) {
    const r = await this.db.doc(path).get();
    return r.exists ? { ...r.data(), id: r.id } : undefined;
  }
  async transaction<T>(f: (tx: Tx) => Promise<T>) {
    return this.db.runTransaction(async (t) =>
      f({
        get: async (p) => {
          const s = await t.get(this.db.doc(p));
          return s.exists ? { ...s.data(), id: s.id } : undefined;
        },
        set: (p, v) => t.set(this.db.doc(p), v),
        delete: (p) => t.delete(this.db.doc(p)),
      }),
    );
  }
  async query(
    collection: string,
    filters: [string, string, unknown][] = [],
    order = "id",
    cursor?: string,
    limit = 50,
  ) {
    let q: FirebaseFirestore.Query = this.db.collection(collection);
    for (const [field, op, value] of filters)
      q = q.where(field, op as FirebaseFirestore.WhereFilterOp, value);
    q = q.orderBy(order).orderBy("__name__").limit(limit);
    if (cursor) {
      const c = JSON.parse(Buffer.from(cursor, "base64url").toString());
      q = q.startAfter(c.value, this.db.doc(`${collection}/${c.id}`));
    }
    return (await q.get()).docs.map((d) => ({ ...d.data(), id: d.id }));
  }
}
export class MemoryStore implements Store {
  docs = new Map<string, Doc>();
  private queue: Promise<unknown> = Promise.resolve();
  async get(p: string) {
    return structuredClone(this.docs.get(p));
  }
  async transaction<T>(f: (tx: Tx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const staged = new Map(this.docs);
      const out = await f({
        get: async (p) => structuredClone(staged.get(p)),
        set: (p, v) => {
          staged.set(p, structuredClone(v));
        },
        delete: (p) => {
          staged.delete(p);
        },
      });
      this.docs = staged;
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async query(
    c: string,
    filters: [string, string, unknown][] = [],
    order = "id",
    cursor?: string,
    limit = 50,
  ) {
    const v = cursor
      ? JSON.parse(Buffer.from(cursor, "base64url").toString())
      : undefined;
    return [...this.docs.entries()]
      .filter(
        ([p, d]) =>
          p.split("/").length === 2 &&
          p.startsWith(c + "/") &&
          filters.every(([k, op, value]) => {
            const x: any = value,
              field = k.split(".").reduce((v, key) => v?.[key], d);
            return op === "=="
              ? field === x
              : op === "<"
                ? field < x
                : op === ">"
                  ? field > x
                  : op === ">="
                    ? field >= x
                    : op === "<="
                      ? field <= x
                      : op === "in"
                        ? x.includes(field)
                        : op === "array-contains"
                          ? field?.includes(x)
                          : false;
          }),
      )
      .map(([p, d]): Doc => ({ ...structuredClone(d), id: p.split("/")[1] }))
      .sort(
        (a, b) =>
          String(a[order]).localeCompare(String(b[order])) ||
          a.id.localeCompare(b.id),
      )
      .filter(
        (d) =>
          !v || d[order] > v.value || (d[order] === v.value && d.id > v.id),
      )
      .slice(0, limit);
  }
}
export const pageCursor = (d: Doc | undefined, order: string) =>
  d
    ? Buffer.from(JSON.stringify({ id: d.id, value: d[order] })).toString(
        "base64url",
      )
    : null;
