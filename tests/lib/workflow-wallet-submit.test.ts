import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRecord } from "@/lib/copilot/workflow/types";
import type { RecordStore } from "@/lib/copilot/workflow/store";
const h = vi.hoisted(() => {
  const rows = new Map<string, { value: WorkflowRecord; version: string }>();
  const store: RecordStore<WorkflowRecord> = {
    read: async (id) => structuredClone(rows.get(id) ?? null),
    write: async (id, version, value) => {
      const prior = rows.get(id); if ((prior?.version ?? null) !== version) return false;
      rows.set(id, { version: String(Number(version ?? -1) + 1), value: structuredClone(value) }); return true;
    },
  };
  return { store, rows, scope: vi.fn() };
});
vi.mock("@/lib/copilot/workflow/store", async (original) => ({ ...await original<typeof import("@/lib/copilot/workflow/store")>(), workflowStore: () => h.store }));
vi.mock("@/lib/copilot/workflow/risk", async (original) => ({ ...await original<typeof import("@/lib/copilot/workflow/risk")>(), validateWorkflowRisk: async () => null }));
vi.mock("@/lib/copilot/investigation/scope", async (original) => ({ ...await original<typeof import("@/lib/copilot/investigation/scope")>(), resolveInvestigationScope: h.scope }));
import { WorkflowJournal } from "@/lib/copilot/workflow/journal";
import { submitWorkflow } from "@/lib/copilot/investigation/execute";
const wallet = Keypair.random();
const scope = { subject: "owner", trader: wallet.publicKey(), smartAccount: "C".padEnd(56, "A"), network: "testnet" };
const identity = { scope, server: "https://mcp.test" };
beforeEach(() => { h.rows.clear(); h.scope.mockResolvedValue(scope); });
async function fixture() {
  const journal = new WorkflowJournal(h.store);
  const created = await journal.create({ ...identity, objective: "Deposit", messages: ["Deposit"], assumptions: [], constraints: [], floor: null,
    steps: [{ id: "one", op: "deposit_collateral", asset: "XLM", amount: "1", label: "Deposit", tool: "vanna_deposit_collateral", args: { amount: "1" } }] });
  const id = created.proposal.id;
  await journal.approve(id, identity, 1, created.proposal.digest, async () => null);
  await journal.claimNext(id, identity, async () => ({ kind: "ready" }));
  const tx = new TransactionBuilder(new Account(wallet.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: wallet.publicKey(), amount: "1", asset: Asset.native() })).setTimeout(30).build();
  await journal.invocationResult(id, identity, "one", { kind: "unsigned", unsignedXdr: tx.toXDR() });
  tx.sign(wallet);
  const hash = tx.hash().toString("hex");
  const sendTx = vi.fn<NonNullable<Parameters<typeof submitWorkflow>[0]["sendTx"]>>();
  const lookupTx = vi.fn(async () => ({ found: false as const }));
  const checkEnvelope = vi.fn(async () => {});
  const run = () => submitWorkflow({ id, signedXdr: tx.toXDR(), subject: scope.subject, secret: "wallet-submit-fixture-secret-of-at-least-32-characters", server: identity.server, network: scope.network,
    mcp: { call: async () => ({}) }, signal: new AbortController().signal, sendTx, lookupTx, checkEnvelope });
  return { journal, id, hash, sendTx, lookupTx, checkEnvelope, run };
}
function response(hash: string, status: rpc.Api.SendTransactionStatus): rpc.Api.SendTransactionResponse {
  return { hash, status, latestLedger: 100, latestLedgerCloseTime: 1000 };
}
describe("wallet submission acknowledgement", () => {
  it("leaves the unsigned step available when chain preconditions changed during wallet signing", async () => {
    const f = await fixture(); f.checkEnvelope.mockRejectedValue(new Error("sequence changed"));
    await expect(f.run()).rejects.toThrow("sequence changed");
    const step = (await f.journal.read(f.id, identity)).value.steps[0];
    expect(step.status).toBe("awaiting_signature"); expect(step.txHash).toBeUndefined();
    expect(f.sendTx).not.toHaveBeenCalled();
  });
  it.each(["ERROR", "TRY_AGAIN_LATER"] as const)("stops on matching RPC %s without a fake settlement ledger or retry", async (status) => {
    const f = await fixture(); f.sendTx.mockResolvedValue(response(f.hash, status));
    const view = await f.run();
    expect(view.status).toBe("blocked"); expect(view.steps[0]).toMatchObject({ status: "failed", txHash: f.hash, message: status });
    expect(view.steps[0].settledLedger).toBeUndefined();
    expect(f.lookupTx).not.toHaveBeenCalled(); expect(f.sendTx).toHaveBeenCalledTimes(1);
    await expect(f.run()).rejects.toThrow(); expect(f.sendTx).toHaveBeenCalledTimes(1);
  });
  it.each(["PENDING", "DUPLICATE"] as const)("keeps %s awaiting actual ledger confirmation", async (status) => {
    const f = await fixture(); f.sendTx.mockResolvedValue(response(f.hash, status));
    expect((await f.run()).steps[0].status).toBe("submitted");
    expect(f.lookupTx).toHaveBeenCalledWith(f.hash); expect(f.sendTx).toHaveBeenCalledTimes(1);
  });
  it("retains the exact signed reference when transport fails, without resending", async () => {
    const f = await fixture(); f.sendTx.mockRejectedValue(new Error("ECONNRESET"));
    expect((await f.run()).steps[0]).toMatchObject({ status: "submitted", txHash: f.hash });
    expect((await f.journal.read(f.id, identity)).value.steps[0].signedXdr).toBeTruthy();
    await expect(f.run()).rejects.toThrow(); expect(f.sendTx).toHaveBeenCalledTimes(1);
  });
  it("does not treat a rejection for a different hash as evidence about the signed transaction", async () => {
    const f = await fixture(); f.sendTx.mockResolvedValue(response("a".repeat(64), "ERROR"));
    expect((await f.run()).steps[0]).toMatchObject({ status: "submitted", txHash: f.hash });
    expect(f.sendTx).toHaveBeenCalledTimes(1);
  });
});
