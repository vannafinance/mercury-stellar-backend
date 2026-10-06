import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordStore } from "@/lib/copilot/workflow/store";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";
const h = vi.hoisted(() => {
  const rows = new Map<string, { value: WorkflowRecord; version: string }>();
  const store: RecordStore<WorkflowRecord> = {
    read: async id => structuredClone(rows.get(id) ?? null),
    write: async (id, version, value) => {
      if ((rows.get(id)?.version ?? null) !== version) return false;
      rows.set(id, { version: String(Number(version ?? -1) + 1), value: structuredClone(value) }); return true;
    },
  };
  return { store, rows, scope: vi.fn(), risk: vi.fn() };
});
vi.mock("@/lib/copilot/workflow/store", async original => ({ ...await original<typeof import("@/lib/copilot/workflow/store")>(), workflowStore: () => h.store }));
vi.mock("@/lib/copilot/workflow/risk", () => ({ validateWorkflowRisk: h.risk }));
vi.mock("@/lib/copilot/investigation/scope", async original => ({ ...await original<typeof import("@/lib/copilot/investigation/scope")>(), resolveInvestigationScope: h.scope }));
import { WorkflowJournal, PROPOSAL_TTL_MS } from "@/lib/copilot/workflow/journal";
import { prepareWorkflowSigning } from "@/lib/copilot/investigation/execute";
import { assertSigningTime, checkSigningPreconditions, refreshSigningEnvelope } from "@/lib/copilot/workflow/signing-envelope";
import { PLAN_TTL_MS } from "@/lib/copilot/plan-ttl";
const wallet = Keypair.random();
const scope = { subject: "owner", trader: wallet.publicKey(), smartAccount: StrKey.encodeContract(Buffer.alloc(32, 2)), network: "testnet" };
const identity = { scope, server: "https://mcp.test" };
function envelope(expired = false, fn = "deposit") {
  const builder = new TransactionBuilder(new Account(wallet.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: scope.smartAccount, function: fn, args: [] }));
  return (expired ? builder.setTimebounds(0, 1) : builder.setTimeout(300)).build();
}
beforeEach(() => { h.rows.clear(); h.scope.mockResolvedValue(scope); h.risk.mockResolvedValue(null); });
async function fixture(twoSteps = false) {
  const journal = new WorkflowJournal(h.store);
  const record = await journal.create({ ...identity, objective: "Deposit", messages: [], assumptions: [], constraints: [], floor: null,
    steps: (twoSteps ? ["one", "two"] : ["one"]).map(id => ({ id, op: "deposit_collateral" as const, asset: "XLM", amount: "5", label: "Deposit", tool: "vanna_deposit_collateral", args: {} })) });
  const id = record.proposal.id;
  await journal.approve(id, identity, 1, record.proposal.digest, async () => null);
  await journal.claimNext(id, identity);
  const old = envelope(true).toXDR();
  await journal.invocationResult(id, identity, "one", { kind: "unsigned", unsignedXdr: old });
  const refreshEnvelope = vi.fn(async () => envelope().toXDR());
  const mcp = { call: vi.fn(async () => ({})) };
  const lookupTx = vi.fn(async () => ({ found: false as const }));
  const run = () => prepareWorkflowSigning({ id, ...identity, subject: scope.subject, network: scope.network,
    secret: "signing-refresh-test-secret-of-at-least-32-characters", mcp, signal: new AbortController().signal, refreshEnvelope, lookupTx });
  return { journal, id, old, refreshEnvelope, mcp, lookupTx, run };
}
describe("safe signing recovery", () => {
  it("shares the hours-long approval policy", () => { expect(PROPOSAL_TTL_MS).toBe(PLAN_TTL_MS); expect(PROPOSAL_TTL_MS).toBeGreaterThan(60 * 60_000); });
  it("refreshes an expired unsigned step without calling a write or changing its approval", async () => {
    const f = await fixture();
    const before = (await f.journal.read(f.id, identity)).value.proposal;
    expect((await f.run()).steps[0].unsignedXdr).not.toBe(f.old);
    expect(f.mcp.call).not.toHaveBeenCalled();
    expect((await f.journal.read(f.id, identity)).value.proposal).toEqual(before);
    const stale = envelope(true); stale.sign(wallet);
    await expect(f.journal.acceptSignedEnvelope(f.id, identity, "one", stale.toXDR())).rejects.toThrow("transaction_mismatch");
  });
  it("keeps the saved envelope recoverable when fresh risk checks refuse", async () => {
    const f = await fixture(); h.risk.mockResolvedValue("Insufficient funds");
    await expect(f.run()).rejects.toThrow("Insufficient funds");
    expect(f.refreshEnvelope).not.toHaveBeenCalled();
    expect((await f.journal.read(f.id, identity)).value.steps[0].unsignedXdr).toBe(f.old);
  });
  it("does not discard the pending step on an RPC failure", async () => {
    const f = await fixture(); f.refreshEnvelope.mockRejectedValue(new TypeError("network"));
    await expect(f.run()).rejects.toThrow("network");
    expect((await f.journal.read(f.id, identity)).value.status).toBe("awaiting_signature");
  });
  it("reconciles a submitted hash instead of rebuilding or resending", async () => {
    const f = await fixture();
    const tx = envelope(true); tx.sign(wallet);
    await f.journal.acceptSignedEnvelope(f.id, identity, "one", tx.toXDR());
    expect((await f.run()).steps[0].status).toBe("submitted");
    expect(f.lookupTx).toHaveBeenCalledWith(tx.hash().toString("hex"));
    expect(f.refreshEnvelope).not.toHaveBeenCalled(); expect(f.mcp.call).not.toHaveBeenCalled();
  });
  it("rejects a refresh that raced with another replacement", async () => {
    const f = await fixture(); const fresh = envelope().toXDR();
    await f.journal.replaceUnsignedEnvelope(f.id, identity, "one", f.old, fresh);
    await expect(f.journal.replaceUnsignedEnvelope(f.id, identity, "one", f.old, envelope(false, "other").toXDR())).rejects.toThrow("step_changed");
  });
  it("returns a completed run without opening a new signing attempt", async () => {
    const f = await fixture(); const tx = envelope(true); tx.sign(wallet);
    await f.journal.acceptSignedEnvelope(f.id, identity, "one", tx.toXDR());
    await f.journal.settled(f.id, identity, "one", tx.hash().toString("hex"), 100, true);
    expect((await f.run()).status).toBe("completed");
    expect(f.refreshEnvelope).not.toHaveBeenCalled(); expect(f.mcp.call).not.toHaveBeenCalled();
  });
  it("refreshes only the remaining leg and preserves the prior leg's settlement", async () => {
    const f = await fixture(true); const tx = envelope(true); tx.sign(wallet);
    await f.journal.acceptSignedEnvelope(f.id, identity, "one", tx.toXDR());
    await f.journal.settled(f.id, identity, "one", tx.hash().toString("hex"), 100, true);
    await f.journal.claimNext(f.id, identity);
    await f.journal.invocationResult(f.id, identity, "two", { kind: "unsigned", unsignedXdr: f.old });
    const view = await f.run();
    expect(view.steps[0]).toMatchObject({ status: "settled", txHash: tx.hash().toString("hex"), settledLedger: 100 });
    expect(view.steps[1].unsignedXdr).not.toBe(f.old); expect(f.refreshEnvelope).toHaveBeenCalledTimes(1);
    expect(f.mcp.call).not.toHaveBeenCalled();
  });
  it("rebuilds the source sequence and clears old auth before simulation while preserving the operation", async () => {
    const old = envelope(true);
    const prepareTransaction = vi.fn(async (tx: ReturnType<typeof envelope>) => tx);
    const xdr = await refreshSigningEnvelope(old.toXDR(), wallet.publicKey(), { getAccount: async () => new Account(wallet.publicKey(), "9"), prepareTransaction });
    const fresh = assertSigningTime(xdr);
    expect(fresh.sequence).toBe("10"); expect(fresh.signatures).toHaveLength(0);
    expect(fresh.toEnvelope().v1().tx().operations()[0].toXDR("base64")).toBe(old.toEnvelope().v1().tx().operations()[0].toXDR("base64"));
    expect(prepareTransaction).toHaveBeenCalledTimes(1);
  });
  it("refuses preparation that changes a contract argument/function", async () => {
    await expect(refreshSigningEnvelope(envelope(true).toXDR(), wallet.publicKey(), {
      getAccount: async () => new Account(wallet.publicKey(), "9"), prepareTransaction: async () => envelope(false, "other"),
    })).rejects.toThrow("changed the approved operation");
  });
  it("refuses an expired signature before it is eligible for submission", () => {
    expect(() => assertSigningTime(envelope(true).toXDR())).toThrow("expired before submission");
  });
  it("rejects a sequence consumed by another transaction while the wallet popup was open", async () => {
    await expect(checkSigningPreconditions(envelope().toXDR(), {
      getAccount: async () => new Account(wallet.publicKey(), "2"),
      getLatestLedger: async () => ({ id: "ledger", sequence: 42, protocolVersion: "25" }),
    })).rejects.toThrow("account or ledger changed");
  });
});
