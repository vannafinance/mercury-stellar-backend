import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchView } from "@/lib/copilot/investigation/view";

/**
 * Conversations, on both backends.
 *
 * The file backend is development; Firestore is what runs on Cloud Run. Testing only the
 * first would leave the durable path — the one that decides whether history survives a
 * redeploy — unexercised, so every case runs against both. The Firestore double speaks the
 * REST dialect the store uses: `updateTime` as the version, `currentDocument.exists=false`
 * to create, `currentDocument.updateTime=…` to compare-and-set, 412 when that fails.
 */

const SECRET = "x".repeat(32);

const view = (message: string, continuation = "r1.token"): ResearchView => ({
  status: "researched", message, originalRequest: message,
  refinements: [], understanding: null, question: null, facts: [], checks: [], warnings: [],
  continuation, executionAllowed: false,
  scope: { wallet: null, smartAccount: null, network: "testnet" },
});

/** A Firestore-over-REST double: documents in a Map, real preconditions, real 404s. */
function firestoreDouble() {
  const documents = new Map<string, { updateTime: string; payload: string }>();
  let clock = 0;
  const fetchDouble = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const existing = documents.get(path);
    if ((init?.method ?? "GET") === "GET") {
      if (!existing) return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      return new Response(JSON.stringify({ updateTime: existing.updateTime, fields: { payload: { stringValue: existing.payload } } }), { status: 200 });
    }
    const expectsAbsent = url.searchParams.get("currentDocument.exists") === "false";
    const expectedTime = url.searchParams.get("currentDocument.updateTime");
    if (expectsAbsent && existing) return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 412 });
    if (expectedTime && existing?.updateTime !== expectedTime) return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 412 });
    const body = JSON.parse(String(init?.body)) as { fields: { payload: { stringValue: string } } };
    documents.set(path, { updateTime: `t${++clock}`, payload: body.fields.payload.stringValue });
    return new Response(JSON.stringify({ updateTime: `t${clock}` }), { status: 200 });
  });
  return { documents, fetchDouble };
}

const BACKENDS = ["file", "firestore"] as const;

describe.each(BACKENDS)("copilot conversation store (%s backend)", (backend) => {
  const dirs: string[] = [];
  let previousCwd = process.cwd();
  let store: typeof import("@/lib/copilot/session-store");

  beforeEach(async () => {
    vi.resetModules();
    process.env.COPILOT_RESEARCH_SECRET = SECRET;
    previousCwd = process.cwd();
    if (backend === "firestore") {
      const { fetchDouble } = firestoreDouble();
      vi.stubGlobal("fetch", fetchDouble);
      process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT = "vanna-copilot-test";
      // GoogleAuth must not be reached: the double answers before any token is needed.
      vi.doMock("google-auth-library", () => ({
        GoogleAuth: class { async getAccessToken() { return "test-token"; } },
      }));
    } else {
      delete process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT;
      const cwd = await mkdtemp(join(tmpdir(), "copilot-session-"));
      dirs.push(cwd);
      process.chdir(cwd);
    }
    store = await import("@/lib/copilot/session-store");
    store.resetConversationStores();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    vi.unstubAllGlobals();
    vi.doUnmock("google-auth-library");
    delete process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("starts a conversation on the first turn, titled by the prompt, and appends later turns to it", async () => {
    const first = await store.appendSessionTurn({ subject: "alice", user: "what's my health?", result: view("1.46") });
    const second = await store.appendSessionTurn({ subject: "alice", conversationId: first.id, user: "and my debt?", result: view("$3,312", "r2.token") });
    expect(second.id).toBe(first.id);
    const list = await store.listConversations("alice");
    expect(list.conversations).toHaveLength(1);
    expect(list.activeId).toBe(first.id);
    const active = await store.readConversation("alice", first.id);
    expect(active?.title).toBe("what's my health?");
    expect(active?.turns.map((turn) => turn.text)).toEqual(["what's my health?", "1.46", "and my debt?", "$3,312"]);
    expect(active?.continuation).toBe("r2.token");
  });

  it("a turn with no conversation id starts a second conversation, newest first; opening switches the active one", async () => {
    const a = await store.appendSessionTurn({ subject: "alice", user: "lend 1 XLM", result: view("Lend 1 XLM.") });
    const b = await store.appendSessionTurn({ subject: "alice", user: "repay 25% of my debt", result: view("Repay …") });
    const list = await store.listConversations("alice");
    expect(list.conversations.map((entry) => entry.title)).toEqual(["repay 25% of my debt", "lend 1 XLM"]);
    expect(list.activeId).toBe(b.id);
    expect((await store.openConversation("alice", a.id))?.turns[0]?.text).toBe("lend 1 XLM");
    expect((await store.listConversations("alice")).activeId).toBe(a.id);
    expect(await store.openConversation("alice", "11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("new chat clears the pointer without creating anything; delete removes it from the list and erases the transcript", async () => {
    const a = await store.appendSessionTurn({ subject: "alice", user: "first", result: view("one") });
    await store.closeActiveConversation("alice");
    expect((await store.listConversations("alice")).activeId).toBeNull();
    expect((await store.listConversations("alice")).conversations).toHaveLength(1);
    await store.openConversation("alice", a.id);
    expect(await store.deleteConversation("alice", a.id)).toBe(true);
    expect(await store.deleteConversation("alice", a.id)).toBe(false);
    expect(await store.listConversations("alice")).toEqual({ conversations: [], activeId: null });
    // The document is a tombstone: reading it back yields nothing, not the old transcript.
    expect(await store.readConversation("alice", a.id)).toBeNull();
  });

  it("one subject cannot read, open or delete another's conversation, even with its id", async () => {
    const mine = await store.appendSessionTurn({ subject: "alice", user: "my private strategy", result: view("…") });
    expect(await store.readConversation("bob", mine.id)).toBeNull();
    expect(await store.openConversation("bob", mine.id)).toBeNull();
    expect(await store.deleteConversation("bob", mine.id)).toBe(false);
    expect((await store.listConversations("bob")).conversations).toEqual([]);
    expect((await store.readConversation("alice", mine.id))?.turns[0]?.text).toBe("my private strategy");
  });

  it("keeps the newest thirty conversations and the last sixteen turns of each, and ignores guests", async () => {
    await store.appendSessionTurn({ subject: "guest", user: "hi", result: view("hello") });
    expect(await store.listConversations("guest")).toEqual({ conversations: [], activeId: null });
    for (let i = 0; i < store.CONVERSATION_LIMIT + 3; i += 1) {
      await store.appendSessionTurn({ subject: "bob", user: `prompt ${i}`, result: view(`reply ${i}`) });
    }
    const list = await store.listConversations("bob");
    expect(list.conversations).toHaveLength(store.CONVERSATION_LIMIT);
    expect(list.conversations[0].title).toBe(`prompt ${store.CONVERSATION_LIMIT + 2}`);
    const { id } = await store.appendSessionTurn({ subject: "carol", user: "t0", result: view("r0") });
    for (let i = 1; i < 12; i += 1) await store.appendSessionTurn({ subject: "carol", conversationId: id, user: `t${i}`, result: view(`r${i}`) });
    expect((await store.readConversation("carol", id))?.turns).toHaveLength(store.TURN_LIMIT);
  });
});

describe("production safety", () => {
  it("refuses to fall back to the container filesystem when no durable store is configured", async () => {
    vi.resetModules();
    process.env.COPILOT_RESEARCH_SECRET = SECRET;
    delete process.env.COPILOT_WORKFLOW_FIRESTORE_PROJECT;
    const previous = process.env.K_SERVICE;
    process.env.K_SERVICE = "copilot";
    try {
      const store = await import("@/lib/copilot/session-store");
      store.resetConversationStores();
      await expect(store.listConversations("alice")).rejects.toThrow(/durable_workflow_store_not_configured/);
    } finally {
      if (previous === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = previous;
      vi.resetModules();
    }
  });
});
