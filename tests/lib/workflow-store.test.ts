import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FirestoreRecordStore, LocalRecordStore } from "@/lib/copilot/workflow/store";

const secret = "workflow-test-secret-with-at-least-32-characters";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function local() {
  const path = await mkdtemp(join(tmpdir(), "vanna-workflow-test-"));
  directories.push(path);
  return { path, store: new LocalRecordStore<{ state: string }>(path, secret) };
}

describe("durable workflow records", () => {
  it("survives reopening and never stores the wallet or payload in plaintext", async () => {
    const { path, store } = await local();
    const id = randomUUID();
    expect(await store.write(id, null, { state: "private-wallet-approved" })).toBe(true);
    const reopened = new LocalRecordStore<{ state: string }>(path, secret);
    expect((await reopened.read(id))?.value.state).toBe("private-wallet-approved");
    expect(await readFile(join(path, (await readdir(path))[0]), "utf8")).not.toContain("private-wallet-approved");
  });
  it("allows only one concurrent approval across independent store instances", async () => {
    const { path, store } = await local();
    const id = randomUUID();
    await store.write(id, null, { state: "proposed" });
    const attempts = await Promise.all(Array.from({ length: 12 }, () =>
      new LocalRecordStore<{ state: string }>(path, secret).write(id, "0", { state: "approved" })));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.write(id, "0", { state: "replayed" })).toBe(false);
    expect((await store.read(id))?.value.state).toBe("approved");
  });
  it("rejects decryption with another key and path traversal", async () => {
    const { path, store } = await local();
    const id = randomUUID();
    await store.write(id, null, { state: "approved" });
    await expect(new LocalRecordStore(path, secret + "wrong").read(id)).rejects.toThrow();
    await expect(store.read("../wallet")).rejects.toThrow("invalid_record_id");
  });
  it("uses Firestore preconditions for creation and updates, preserving conflicts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: requests.length === 2 ? 409 : 200 });
    }) as typeof fetch;
    const store = new FirestoreRecordStore("vanna-mcp", "(default)", secret, async () => "test-token", request);
    const id = randomUUID();
    expect(await store.write(id, null, { state: "private" })).toBe(true);
    expect(await store.write(id, "2026-09-09T01:02:03Z", { state: "approved" })).toBe(false);
    expect(requests[0].url).toContain("currentDocument.exists=false");
    expect(requests[1].url).toContain("currentDocument.updateTime=2026-09-09T01%3A02%3A03Z");
    expect(requests[0].init?.body).not.toContain("private");
  });
});
