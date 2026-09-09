import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, open, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { GoogleAuth } from "google-auth-library";

export interface Stored<T> { value: T; version: string }
export interface RecordStore<T> {
  read(id: string): Promise<Stored<T> | null>;
  /** null means create-if-absent. False means another request already won. */
  write(id: string, expected: string | null, value: T): Promise<boolean>;
}
const validId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_record_id"); };

/** Encrypt records independently of the auth cookie and continuation keys. */
function encryption(secret: string) {
  if (secret.length < 32) throw new Error("workflow_secret_required");
  const key = Buffer.from(hkdfSync("sha256", secret, "vanna-workflow", "record-v1", 32));
  return {
    seal(id: string, value: unknown) {
      const plaintext = JSON.stringify(value);
      if (Buffer.byteLength(plaintext) > 400_000) throw new Error("workflow_record_too_large");
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
    },
    open<T>(id: string, sealed: string): T {
      const [iv, tag, data, extra] = sealed.split(".");
      if (!iv || !tag || !data || extra || sealed.length > 600_000) throw new Error("invalid_workflow_record");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as T;
    },
  };
}

/**
 * Local development journal: immutable revisions, fsync before atomic link publication.
 * Concurrent processes contend on the SAME next filename; only one can create it.
 * A crash cannot leave a partly written published revision. Never used on Cloud Run.
 */
export class LocalRecordStore<T> implements RecordStore<T> {
  private readonly directory: string;
  private readonly codec: ReturnType<typeof encryption>;
  constructor(directory: string, secret: string) { this.directory = resolve(directory); this.codec = encryption(secret); }
  async read(id: string): Promise<Stored<T> | null> {
    validId(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const versions = (await readdir(this.directory)).filter((file) => file.startsWith(`${id}.`) && /\.\d+\.json$/.test(file))
      .map((file) => Number(file.split(".")[1])).filter(Number.isSafeInteger);
    if (!versions.length) return null;
    const version = String(Math.max(...versions));
    const sealed = await readFile(join(this.directory, `${id}.${version}.json`), "utf8");
    return { version, value: this.codec.open<T>(`${id}:${version}`, sealed) };
  }
  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    validId(id);
    const current = await this.read(id);
    if ((current?.version ?? null) !== expected) return false;
    const version = expected === null ? 0 : Number(expected) + 1;
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("invalid_record_version");
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(this.codec.seal(`${id}:${version}`, value));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await link(temporary, join(this.directory, `${id}.${version}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally { await unlink(temporary).catch(() => {}); }
  }
}

/** Cloud Run shared durable store. Firestore updateTime/exists preconditions are CAS. */
export class FirestoreRecordStore<T> implements RecordStore<T> {
  private readonly base: string;
  private readonly codec: ReturnType<typeof encryption>;
  constructor(project: string, database: string, secret: string,
    private readonly token: () => Promise<string> = async () => {
      const token = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/datastore"] }).getAccessToken();
      if (!token) throw new Error("workflow_store_auth_unavailable");
      return token;
    }, private readonly request: typeof fetch = fetch) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !/^(\(default\)|[a-z0-9-]+)$/.test(database)) throw new Error("invalid_firestore_configuration");
    this.base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/copilot_workflows`;
    this.codec = encryption(secret);
  }
  async read(id: string): Promise<Stored<T> | null> {
    validId(id);
    const response = await this.request(`${this.base}/${id}`, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`workflow_store_http_${response.status}`);
    const body = await response.json();
    if (typeof body.updateTime !== "string" || typeof body.fields?.payload?.stringValue !== "string") throw new Error("invalid_workflow_record");
    return { version: body.updateTime, value: this.codec.open<T>(id, body.fields.payload.stringValue) };
  }
  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    validId(id);
    const query = expected === null ? "currentDocument.exists=false" : `currentDocument.updateTime=${encodeURIComponent(expected)}`;
    const response = await this.request(`${this.base}/${id}?${query}`, { method: "PATCH",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { payload: { stringValue: this.codec.seal(id, value) } } }), signal: AbortSignal.timeout(15_000) });
    if ([409, 412].includes(response.status)) return false;
    // A failed precondition can be returned as 400 FAILED_PRECONDITION.
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      if (body?.error?.status === "FAILED_PRECONDITION") return false;
    }
    if (!response.ok) throw new Error(`workflow_store_http_${response.status}`);
    return true;
  }
}

export function workflowStore<T>(secret: string): RecordStore<T> {
  const project = process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT;
  if (project) return new FirestoreRecordStore(project, process.env.COPILOT_WORKFLOW_FIRESTORE_DATABASE || "(default)", secret);
  if (process.env.NODE_ENV === "production" || process.env.K_SERVICE) throw new Error("durable_workflow_store_not_configured");
  return new LocalRecordStore(resolve(process.cwd(), ".local/copilot-workflows"), secret);
}
