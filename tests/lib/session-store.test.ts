import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchView } from "@/lib/copilot/investigation/view";

const view = (message: string, continuation = "r1.token"): ResearchView => ({
  status: "researched", message, originalRequest: message,
  refinements: [], understanding: null, question: null, facts: [], checks: [], warnings: [],
  continuation, executionAllowed: false,
  scope: { wallet: null, smartAccount: null, network: "testnet" },
});

describe("copilot session store — conversations", () => {
  const dirs: string[] = [];
  let previous = process.cwd();
  async function sandbox() {
    const cwd = await mkdtemp(join(tmpdir(), "copilot-session-"));
    dirs.push(cwd);
    previous = process.cwd();
    process.chdir(cwd);
    return import("@/lib/copilot/session-store");
  }
  afterEach(async () => {
    process.chdir(previous);
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("starts a conversation on the first turn, titled by the prompt, and appends later turns to it", async () => {
    const store = await sandbox();
    const first = await store.appendSessionTurn({ subject: "alice", user: "what's my health?", result: view("1.46") });
    const second = await store.appendSessionTurn({ subject: "alice", conversationId: first.id, user: "and my debt?", result: view("$3,312", "r2.token") });
    expect(second.id).toBe(first.id);
    const session = await store.loadSession("alice");
    expect(session?.conversations).toHaveLength(1);
    expect(session?.activeId).toBe(first.id);
    const active = store.activeConversation(session);
    expect(active?.title).toBe("what's my health?");
    expect(active?.turns.map((t) => t.text)).toEqual(["what's my health?", "1.46", "and my debt?", "$3,312"]);
    expect(active?.continuation).toBe("r2.token");
  });

  it("a turn with no conversation id starts a second conversation, newest first; opening switches the active one", async () => {
    const store = await sandbox();
    const a = await store.appendSessionTurn({ subject: "alice", user: "lend 1 XLM", result: view("Lend 1 XLM.") });
    const b = await store.appendSessionTurn({ subject: "alice", user: "repay 25% of my debt", result: view("Repay …") });
    const list = await store.listConversations("alice");
    expect(list.conversations.map((c) => [c.id, c.title])).toEqual([[b.id, "repay 25% of my debt"], [a.id, "lend 1 XLM"]]);
    expect(list.activeId).toBe(b.id);
    const opened = await store.openConversation("alice", a.id);
    expect(opened?.turns[0]?.text).toBe("lend 1 XLM");
    expect((await store.listConversations("alice")).activeId).toBe(a.id);
    expect(await store.openConversation("alice", "nope")).toBeNull();
  });

  it("new chat clears the pointer without creating anything; delete removes one and clears the pointer if it was open", async () => {
    const store = await sandbox();
    const a = await store.appendSessionTurn({ subject: "alice", user: "first", result: view("one") });
    await store.closeActiveConversation("alice");
    expect((await store.listConversations("alice")).activeId).toBeNull();
    expect((await store.listConversations("alice")).conversations).toHaveLength(1);
    await store.openConversation("alice", a.id);
    expect(await store.deleteConversation("alice", a.id)).toBe(true);
    expect(await store.deleteConversation("alice", a.id)).toBe(false);
    expect(await store.listConversations("alice")).toEqual({ conversations: [], activeId: null });
  });

  it("reads a file written before conversations existed as one conversation, losing nothing", async () => {
    const store = await sandbox();
    await mkdir(join(process.cwd(), ".local", "copilot-sessions"), { recursive: true });
    await writeFile(join(process.cwd(), ".local", "copilot-sessions", "alice.json"), JSON.stringify({
      subject: "alice", turns: [{ role: "user", text: "what's my health?" }, { role: "assistant", text: "1.46", question: null }],
      continuation: "r1.token", result: view("1.46"), updatedAt: 1_700_000_000_000,
    }));
    const session = await store.loadSession("alice");
    expect(session?.conversations).toHaveLength(1);
    expect(session?.conversations[0]).toMatchObject({ title: "what's my health?", continuation: "r1.token", updatedAt: 1_700_000_000_000 });
    expect(session?.activeId).toBe(session?.conversations[0].id);
  });

  it("keeps the newest thirty conversations and the last sixteen turns of each, and ignores guests", async () => {
    const store = await sandbox();
    await store.saveSession({ subject: "guest", conversations: [], activeId: null, updatedAt: 1 });
    expect(await store.loadSession("guest")).toBeNull();
    for (let i = 0; i < store.CONVERSATION_LIMIT + 3; i += 1) {
      await store.appendSessionTurn({ subject: "bob", user: `prompt ${i}`, result: view(`reply ${i}`) });
    }
    const list = await store.listConversations("bob");
    expect(list.conversations).toHaveLength(store.CONVERSATION_LIMIT);
    expect(list.conversations[0].title).toBe(`prompt ${store.CONVERSATION_LIMIT + 2}`);
    const { id } = await store.appendSessionTurn({ subject: "carol", user: "t0", result: view("r0") });
    for (let i = 1; i < 12; i += 1) await store.appendSessionTurn({ subject: "carol", conversationId: id, user: `t${i}`, result: view(`r${i}`) });
    expect((await store.openConversation("carol", id))?.turns).toHaveLength(store.TURN_LIMIT);
  });
});
